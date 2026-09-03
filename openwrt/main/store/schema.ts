/**
 * What a per-router document contains, and how to read one back safely.
 *
 * Everything here is about the file on disk: its shape, the compact form it is
 * written in, and the strict reader that turns whatever is actually there back
 * into that shape. Nothing in this file decides what to keep when the document
 * grows too large - that is `trim.ts` - and nothing here talks to the host.
 */
import { finite, ipv4ToInt, isRecord } from '../util'
import {
  MAX_FINISHED_JOBS,
  MAX_FINISHED_JOB_ITEMS,
  MAX_STORED_BINDINGS,
  type FinishedJob,
  type ManagedLayout,
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
  /**
   * Which addresses on the LAN this instance is allowed to hand a WAN to.
   * Absent means the whole LAN, which is what every instance written before
   * ranges existed meant and still means, so no migration is needed. A range
   * changes two things and only two: which leases enter the planner, and which
   * CIDRs the fail-closed catch-all is written for.
   */
  source?: { kind: 'lan' } | { kind: 'range'; from: string; to: string }
}

/**
 * One address bound to one WAN port by hand.
 *
 * The numbers are stamped at creation and read back afterwards, for the reason
 * `ManagedLayout` is stamped onto an instance: `pref` and `table` are what the
 * reconcile looks for on the router, so re-deriving them from settings that
 * have since been edited would send it hunting in the wrong band and leave the
 * real rule behind, unowned and still steering traffic.
 */
export interface DirectBindingRecord {
  id: string
  name: string
  target: { kind: 'ip'; ip: string } | { kind: 'mac'; mac: string }
  /** UCI network section of the WAN port. */
  wan: string
  enabled: boolean
  /** What happens when the WAN goes down; `hold` is fail-closed. */
  whenDown: 'hold' | 'fallback'
  /** Stamped from the direct band at creation. */
  pref: number
  /** Stamped; the WAN's `ip4table`. */
  table: number
  /** The logical LAN the address sits in, which is its firewall source zone. */
  lan: string
  /** Numbers the `bmd<slot>_` firewall sections; allocated from the live set. */
  slot: number
  createdAt: number
}

/**
 * Version 3: one-to-one bindings have a record of their own.
 *
 * A version-2 document loads unchanged, exactly as a version-1 one does: it
 * carries no `direct` array, that normalises to `[]`, and every instance in it
 * keeps behaving as a whole-LAN instance because an absent `source` means the
 * whole LAN. Writing the document back at version 3 is the entire migration.
 *
 * Version 2 was where the PPPoE batch records and their sequence counter went
 * away. Pools live on the router - `/etc/config/bm_pppoe` is the record, the
 * daemon owns it - so a per-router document that also described them would only
 * ever drift from the truth.
 */
export interface OwrtHostData {
  version: 3
  instances: BindingInstanceRecord[]
  /** The one-to-one bindings; each owns one `ip rule` in the direct band. */
  direct: DirectBindingRecord[]
  /**
   * WAN-to-table assignments a preparation wrote to the router, with the record
   * that claimed them - a binding instance or, since version 3, a one-to-one
   * binding. The owner is what lets `trim` drop an assignment once that record
   * is deleted; entries written before this third element existed name nobody,
   * and are dropped only when no owner of either kind is left at all.
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
    version: 3,
    instances: [],
    direct: [],
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
    version: 3,
    instances: data.instances,
    direct: data.direct,
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
  if (!zoneName) return undefined
  // Older records also carried a `zoneMode`; it described the PPPoE zone the
  // module no longer writes, so it is simply not read back.
  return {
    tableBase: values.tableBase!,
    rulePrefBase: values.rulePrefBase!,
    catchAllPrefBase: values.catchAllPrefBase!,
    catchAllTable: values.catchAllTable!,
    zoneName
  }
}

/**
 * An instance's address scope, or nothing.
 *
 * Whole field or nothing, and "nothing" is deliberately the safe reading: a
 * range whose endpoints no longer parse would otherwise have been kept as a
 * scope nothing can evaluate, and the catch-all built from it would have
 * covered no address at all - which on a fail-closed rule set means the LAN
 * routes normally and the instance silently stops being fail-closed. Falling
 * back to the whole LAN is the behaviour every pre-range instance already has.
 */
function instanceSource(raw: unknown): BindingInstanceRecord['source'] {
  if (!isRecord(raw)) return undefined
  if (raw.kind === 'lan') return { kind: 'lan' }
  if (raw.kind !== 'range') return undefined
  const from = string(raw.from)
  const to = string(raw.to)
  const low = ipv4ToInt(from)
  const high = ipv4ToInt(to)
  if (low == null || high == null || low > high) return undefined
  return { kind: 'range', from, to }
}

/**
 * A one-to-one binding's target, or nothing.
 *
 * All of it or none of it, the way `layout` is: a target this cannot read is a
 * binding the reconcile can neither install nor explain, and keeping the record
 * without one would put a row on the page that never resolves to an address.
 */
function directTarget(raw: unknown): DirectBindingRecord['target'] | null {
  if (!isRecord(raw)) return null
  if (raw.kind === 'ip') {
    const ip = string(raw.ip)
    return ipv4ToInt(ip) == null ? null : { kind: 'ip', ip }
  }
  if (raw.kind === 'mac') {
    // Lower-cased colon form because that is the spelling `model.leases`
    // carries, and the reconcile matches a MAC target against it by string.
    const mac = string(raw.mac).toLowerCase()
    return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac) ? { kind: 'mac', mac } : null
  }
  return null
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

/**
 * Load only bounded, valid records from the per-router JSON document.
 *
 * A version-1 document's `batches` and `nextSeq` are deliberately not read:
 * the pools they described live on the router now, and the daemon lists them
 * itself. Dropping the fields on the next write is the whole migration.
 */
export function normalize(raw: unknown): OwrtHostData {
  if (!isRecord(raw)) return emptyData()
  const data = emptyData()

  const instanceIds = new Set<string>()
  for (const value of Array.isArray(raw.instances) ? raw.instances : []) {
    if (!isRecord(value)) continue
    const id = string(value.id)
    const lan = string(value.lan)
    const carrier = string(value.carrier)
    if (!id || instanceIds.has(id) || !lan || !carrier) continue
    instanceIds.add(id)
    const stamped = layout(value.layout)
    const source = instanceSource(value.source)
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
      ...(stamped ? { layout: stamped } : {}),
      ...(source ? { source } : {})
    })
    // Both topology arrays stop at the same ceiling, and both create gates -
    // `binding/check` for instances, `direct/check` for one-to-one bindings -
    // refuse there rather than leaving it to this loop: a record silently
    // dropped on read is a rule left standing on the router with nothing left
    // that could remove it. See `MAX_STORED_BINDINGS`.
    if (data.instances.length >= MAX_STORED_BINDINGS) break
  }

  const directIds = new Set<string>()
  for (const value of Array.isArray(raw.direct) ? raw.direct : []) {
    if (!isRecord(value)) continue
    const id = string(value.id)
    const target = directTarget(value.target)
    const wan = string(value.wan)
    const pref = integer(value.pref)
    const table = integer(value.table)
    // Whole record or none of it. Every field below is something a write to the
    // router is built out of, so a half-read binding would name a rule at
    // preference 0 in table 0 - which is not the rule on the router, and
    // deleting the binding would leave the real one behind with no record left
    // to say it exists.
    if (!id || directIds.has(id) || !target || !wan || pref <= 0 || table <= 0) continue
    directIds.add(id)
    data.direct.push({
      id,
      name: string(value.name) || id,
      target,
      wan,
      enabled: value.enabled !== false,
      // Hold is the default in the reader as well as in the form: a record
      // whose flag was lost has to fail closed rather than quietly start
      // letting the address out over the default connection.
      whenDown: value.whenDown === 'fallback' ? 'fallback' : 'hold',
      pref,
      table,
      lan: string(value.lan),
      slot: Math.max(0, integer(value.slot)),
      createdAt: finite(value.createdAt)
    })
    if (data.direct.length >= MAX_STORED_BINDINGS) break
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

  // Not gated on `instanceIds`, unlike the sticky map above, and the reason is
  // the whole of what this document is for now: the instances live on the
  // router, so `data.instances` is empty on every machine running 3.4.0 - and a
  // gate on it would drop every line of history the moment it was read back.
  // The sticky map is different: an entry keyed on an instance nobody has is a
  // choice nothing will ever consult again.
  for (const value of Array.isArray(raw.events) ? raw.events : []) {
    if (!Array.isArray(value) || value.length < 4) continue
    const instanceId = string(value[0])
    const kind = string(value[2])
    const text = string(value[3])
    if (!instanceId || !kind || !text) continue
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

  // A table assignment belongs to the record whose preparation wrote it.
  // Entries from a build that predates that field name nobody, so the only safe
  // statement about them is "nothing is left that could own any of these" - and
  // load time is the one moment no preparation can be in flight writing more.
  // Left alone they kept overriding the WAN-to-table map for every instance
  // created afterwards, for the life of the router.
  //
  // A one-to-one binding claims a table the same way an instance does, so an
  // ownerless entry is only unowned when both arrays are empty. Testing the
  // instances alone would have wiped the claims of a router whose only bindings
  // are direct ones, on the first read after a restart.
  if (data.instances.length === 0 && data.direct.length === 0) {
    data.extraTables = data.extraTables.filter((entry) => entry[2] != null)
  }
  return data
}
