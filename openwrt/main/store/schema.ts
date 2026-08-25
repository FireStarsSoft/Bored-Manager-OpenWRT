/**
 * What a per-router document contains, and how to read one back safely.
 *
 * Everything here is about the file on disk: its shape, the compact form it is
 * written in, and the strict reader that turns whatever is actually there back
 * into that shape. Nothing in this file decides what to keep when the document
 * grows too large - that is `trim.ts` - and nothing here talks to the host.
 */
import { finite, isRecord } from '../util'
import {
  MAX_FINISHED_JOBS,
  MAX_FINISHED_JOB_ITEMS,
  type FinishedJob,
  type ManagedLayout,
  type PppoeBatchRecord,
  type StoredJobItem,
  type StoredJobItemState,
  type StoredJobState
} from '../records'

export interface BindingInstanceRecord {
  id: string
  name: string
  lan: string
  carrier: string
  running: boolean
  sticky: boolean
  remap: boolean
  createdAt: number
  slot: number
  /** Absent on records written before this was stamped; see `recordLayout`. */
  layout?: ManagedLayout
}

export interface OwrtHostData {
  version: 1
  nextSeq: number
  batches: PppoeBatchRecord[]
  instances: BindingInstanceRecord[]
  /**
   * WAN-to-table assignments a binding preparation wrote to the router, with
   * the instance that claimed them. The owner is what lets `trim` drop an
   * assignment once its instance is deleted; entries written before this third
   * element existed name nobody, and are dropped only when no instance is left
   * at all.
   */
  extraTables: Array<[wanName: string, tableId: number, instanceId?: string]>
  stickyMap: Array<[
    instanceId: string,
    mac: string,
    wanName: string,
    lastSeenTs: number
  ]>
  events: Array<[instanceId: string, t: number, kind: string, text: string]>
  /**
   * Module-level events - PPPoE lifecycle and router notices - kept apart from
   * the per-instance binding ring above. Binding churns an entry per device per
   * reconcile, so sharing one ring would evict the rare PPPoE events that are
   * the only record a create or delete ever leaves. A build that predates this
   * field simply drops it on read.
   */
  moduleEvents: Array<[scope: ModuleEventScope, t: number, kind: string, text: string]>
  jobs: FinishedJob[]
}

export const MAX_MODULE_EVENTS = 100
export const MODULE_EVENT_SCOPES = ['pppoe', 'router'] as const
export type ModuleEventScope = (typeof MODULE_EVENT_SCOPES)[number]

export type PersistedHostData = Omit<OwrtHostData, 'stickyMap'> & {
  /** Compact `instance|mac-without-colons|wan|base36-time` entries. */
  stickyPacked: string[]
}

export function emptyData(): OwrtHostData {
  return {
    version: 1,
    nextSeq: 1,
    batches: [],
    instances: [],
    extraTables: [],
    stickyMap: [],
    events: [],
    moduleEvents: [],
    jobs: []
  }
}

function packSticky(entry: OwrtHostData['stickyMap'][number]): string {
  return `${entry[0]}|${entry[1].replace(/:/g, '')}|${entry[2]}|${Math.max(
    0,
    Math.trunc(entry[3])
  ).toString(36)}`
}

function unpackSticky(value: unknown): OwrtHostData['stickyMap'][number] | null {
  if (typeof value !== 'string') return null
  const [instanceId = '', compactMac = '', wanName = '', time = ''] = value.split('|')
  if (
    !instanceId ||
    !/^[0-9a-f]{12}$/i.test(compactMac) ||
    !wanName ||
    !/^[0-9a-z]+$/i.test(time)
  ) {
    return null
  }
  const mac = compactMac
    .toLowerCase()
    .match(/.{2}/g)
    ?.join(':')
  const lastSeen = Number.parseInt(time, 36)
  if (!mac || !Number.isSafeInteger(lastSeen) || lastSeen < 0) return null
  return [instanceId, mac, wanName, lastSeen]
}

export function serializeHostData(data: OwrtHostData): PersistedHostData {
  return {
    version: 1,
    nextSeq: data.nextSeq,
    batches: data.batches,
    instances: data.instances,
    extraTables: data.extraTables,
    stickyPacked: data.stickyMap.map(packSticky),
    events: data.events,
    moduleEvents: data.moduleEvents,
    jobs: data.jobs
  }
}

export function serializedBytes(data: OwrtHostData): number {
  return new TextEncoder().encode(JSON.stringify(serializeHostData(data), null, 2)).length
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Strict on purpose: this reads back JSON this module wrote itself, so a string
 * where a number belongs is corruption to fall back from rather than something
 * to parse. `parse.ts` reads router output and needs the opposite.
 */
function integer(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

/**
 * The stamped layout, or nothing.
 *
 * All six or none: a half-read layout would send one command to the recorded
 * table range and the next to the configured one, which is worse than falling
 * back to the live rules the way a pre-stamp record does.
 */
function layout(raw: unknown): ManagedLayout | undefined {
  if (!isRecord(raw)) return undefined
  const numbers = ['tableBase', 'rulePrefBase', 'catchAllPrefBase', 'catchAllTable'] as const
  const values: Record<string, number> = {}
  for (const key of numbers) {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined
    values[key] = value
  }
  const zoneName = string(raw.zoneName)
  const zoneMode = raw.zoneMode
  if (!zoneName || (zoneMode !== 'wildcard' && zoneMode !== 'networks')) return undefined
  return {
    tableBase: values.tableBase!,
    rulePrefBase: values.rulePrefBase!,
    catchAllPrefBase: values.catchAllPrefBase!,
    catchAllTable: values.catchAllTable!,
    zoneName,
    zoneMode
  }
}

export function isModuleEventScope(value: string): value is ModuleEventScope {
  return (MODULE_EVENT_SCOPES as readonly string[]).includes(value)
}

function normalizeJob(raw: unknown): FinishedJob | null {
  if (!isRecord(raw)) return null
  const id = string(raw.id)
  if (!id) return null
  const state: StoredJobState =
    raw.state === 'failed' ||
    raw.state === 'partial' ||
    raw.state === 'cancelled'
      ? raw.state
      : 'done'
  const items: StoredJobItem[] = []
  for (const [position, value] of (Array.isArray(raw.items) ? raw.items : []).entries()) {
    if (!isRecord(value)) continue
    const status: StoredJobItemState =
      value.status === 'error' ||
      value.status === 'warning' ||
      value.status === 'skipped' ||
      value.status === 'cancelled'
        ? value.status
        : 'ok'
    const message = string(value.message)
    const startedAt = finite(value.startedAt)
    items.push({
      idx: integer(value.idx, position),
      name: string(value.name) || `Step ${position + 1}`,
      status,
      message: message || undefined,
      startedAt: startedAt > 0 ? startedAt : undefined,
      ms: typeof value.ms === 'number' && Number.isFinite(value.ms) ? value.ms : undefined
    })
    if (items.length >= MAX_FINISHED_JOB_ITEMS) break
  }
  const total = Math.max(0, integer(raw.total))
  const done = Math.max(0, integer(raw.done))
  const failed = Math.max(0, integer(raw.failed))
  return {
    id,
    kind: string(raw.kind) || 'openwrt',
    label: string(raw.label) || id,
    state,
    startedAt: finite(raw.startedAt),
    finishedAt: finite(raw.finishedAt),
    total,
    done: Math.min(done, total || done),
    failed: Math.min(failed, total || failed),
    progressPct: Math.max(0, Math.min(100, finite(raw.progressPct, 100))),
    items
  }
}

/** Load only bounded, valid records from the per-router JSON document. */
export function normalize(raw: unknown): OwrtHostData {
  if (!isRecord(raw)) return emptyData()
  const data = emptyData()
  data.nextSeq = Math.max(1, integer(raw.nextSeq, 1))

  const batchIds = new Set<string>()
  for (const value of Array.isArray(raw.batches) ? raw.batches : []) {
    if (!isRecord(value)) continue
    const id = string(value.id)
    const prefix = string(value.prefix)
    const carrier = string(value.carrier)
    const seqFrom = Math.max(1, integer(value.seqFrom))
    const seqTo = Math.max(seqFrom, integer(value.seqTo, seqFrom))
    if (!id || batchIds.has(id) || !/^[a-z][a-z0-9]{0,3}$/.test(prefix) || !carrier) {
      continue
    }
    batchIds.add(id)
    const vlan = integer(value.vlan)
    const stamped = layout(value.layout)
    data.batches.push({
      id,
      name: string(value.name) || id,
      prefix,
      carrier,
      vlan: vlan >= 1 && vlan <= 4094 ? vlan : undefined,
      createdAt: finite(value.createdAt),
      count: Math.max(0, integer(value.count, seqTo - seqFrom + 1)),
      seqFrom,
      seqTo,
      ...(stamped ? { layout: stamped } : {})
    })
    if (data.batches.length >= 1_000) break
  }

  const instanceIds = new Set<string>()
  for (const value of Array.isArray(raw.instances) ? raw.instances : []) {
    if (!isRecord(value)) continue
    const id = string(value.id)
    const lan = string(value.lan)
    const carrier = string(value.carrier)
    if (!id || instanceIds.has(id) || !lan || !carrier) continue
    instanceIds.add(id)
    const stamped = layout(value.layout)
    data.instances.push({
      id,
      name: string(value.name) || id,
      lan,
      carrier,
      running: value.running === true,
      sticky: value.sticky !== false,
      remap: value.remap !== false,
      createdAt: finite(value.createdAt),
      slot: Math.max(0, integer(value.slot)),
      ...(stamped ? { layout: stamped } : {})
    })
    if (data.instances.length >= 512) break
  }

  const tableNames = new Set<string>()
  const tableIds = new Set<number>()
  for (const value of Array.isArray(raw.extraTables) ? raw.extraTables : []) {
    if (!Array.isArray(value) || value.length < 2) continue
    const name = string(value[0])
    const table = integer(value[1])
    if (!name || table <= 0 || tableNames.has(name) || tableIds.has(table)) continue
    tableNames.add(name)
    tableIds.add(table)
    const owner = string(value[2])
    data.extraTables.push(owner ? [name, table, owner] : [name, table])
    if (data.extraTables.length >= 8_000) break
  }

  // Sticky entries are written in the compact `stickyPacked` form (see
  // serializeHostData and flush); `stickyMap` is the shape older builds wrote
  // and is still read, so an existing file still loads.
  for (const value of Array.isArray(raw.stickyPacked) ? raw.stickyPacked : []) {
    const entry = unpackSticky(value)
    if (!entry || !instanceIds.has(entry[0])) continue
    data.stickyMap.push(entry)
    if (data.stickyMap.length >= 20_000) break
  }
  for (const value of Array.isArray(raw.stickyMap) ? raw.stickyMap : []) {
    if (data.stickyMap.length >= 20_000) break
    if (!Array.isArray(value) || value.length < 4) continue
    const instanceId = string(value[0])
    const mac = string(value[1]).toLowerCase()
    const wanName = string(value[2])
    if (!instanceIds.has(instanceId) || !mac || !wanName) continue
    data.stickyMap.push([instanceId, mac, wanName, finite(value[3])])
  }

  for (const value of Array.isArray(raw.events) ? raw.events : []) {
    if (!Array.isArray(value) || value.length < 4) continue
    const instanceId = string(value[0])
    const kind = string(value[2])
    const text = string(value[3])
    if (!instanceIds.has(instanceId) || !kind || !text) continue
    data.events.push([instanceId, finite(value[1]), kind, text.slice(0, 500)])
    if (data.events.length >= 2_000) break
  }

  for (const value of Array.isArray(raw.moduleEvents) ? raw.moduleEvents : []) {
    if (!Array.isArray(value) || value.length < 4) continue
    const scope = string(value[0])
    const kind = string(value[2])
    const text = string(value[3])
    if (!isModuleEventScope(scope) || !kind || !text) continue
    data.moduleEvents.push([scope, finite(value[1]), kind, text.slice(0, 500)])
    if (data.moduleEvents.length >= MAX_MODULE_EVENTS) break
  }

  for (const value of Array.isArray(raw.jobs) ? raw.jobs : []) {
    const job = normalizeJob(value)
    if (job) data.jobs.push(job)
    if (data.jobs.length >= MAX_FINISHED_JOBS) break
  }

  // A table assignment belongs to the binding instance whose preparation wrote
  // it. Entries from a build that predates that field name nobody, so the only
  // safe statement about them is "no instance is left to own any of these" -
  // and load time is the one moment no preparation can be in flight writing
  // more. Left alone they kept overriding the WAN-to-table map for every
  // instance created afterwards, for the life of the router.
  if (data.instances.length === 0) {
    data.extraTables = data.extraTables.filter((entry) => entry[2] != null)
  }
  return data
}
