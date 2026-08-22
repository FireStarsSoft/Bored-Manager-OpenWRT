import type { ModuleContext } from '@shared/modules'
import type { OwrtRules } from './config'

export interface PppoeBatchRecord {
  id: string
  name: string
  prefix: string
  carrier: string
  vlan?: number
  createdAt: number
  count: number
  seqFrom: number
  seqTo: number
}

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
}

export type StoredJobState = 'done' | 'failed' | 'partial' | 'cancelled'
export type StoredJobItemState = 'ok' | 'error' | 'skipped' | 'cancelled'

export interface StoredJobItem {
  idx: number
  name: string
  status: StoredJobItemState
  message?: string
  ms?: number
}

export interface FinishedJob {
  id: string
  kind: string
  label: string
  state: StoredJobState
  startedAt: number
  finishedAt: number
  total: number
  done: number
  failed: number
  progressPct: number
  items: StoredJobItem[]
}

export interface OwrtHostData {
  version: 1
  nextSeq: number
  batches: PppoeBatchRecord[]
  instances: BindingInstanceRecord[]
  extraTables: Array<[wanName: string, tableId: number]>
  stickyMap: Array<[
    instanceId: string,
    mac: string,
    wanName: string,
    lastSeenTs: number
  ]>
  events: Array<[instanceId: string, t: number, kind: string, text: string]>
  jobs: FinishedJob[]
}

const PERSIST_DEBOUNCE_MS = 10_000
const PERSIST_TARGET_BYTES = 500 * 1024
export const MAX_FINISHED_JOBS = 10
export const MAX_FINISHED_JOB_ITEMS = 30

type PersistedHostData = Omit<OwrtHostData, 'stickyMap'> & {
  /** Compact `instance|mac-without-colons|wan|base36-time` entries. */
  stickyPacked: string[]
}

function emptyData(): OwrtHostData {
  return {
    version: 1,
    nextSeq: 1,
    batches: [],
    instances: [],
    extraTables: [],
    stickyMap: [],
    events: [],
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
    jobs: data.jobs
  }
}

function serializedBytes(data: OwrtHostData): number {
  return new TextEncoder().encode(JSON.stringify(serializeHostData(data), null, 2)).length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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
      value.status === 'skipped' ||
      value.status === 'cancelled'
        ? value.status
        : 'ok'
    const message = string(value.message)
    items.push({
      idx: integer(value.idx, position),
      name: string(value.name) || `Step ${position + 1}`,
      status,
      message: message || undefined,
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
function normalize(raw: unknown): OwrtHostData {
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
    data.batches.push({
      id,
      name: string(value.name) || id,
      prefix,
      carrier,
      vlan: vlan >= 1 && vlan <= 4094 ? vlan : undefined,
      createdAt: finite(value.createdAt),
      count: Math.max(0, integer(value.count, seqTo - seqFrom + 1)),
      seqFrom,
      seqTo
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
    data.instances.push({
      id,
      name: string(value.name) || id,
      lan,
      carrier,
      running: value.running === true,
      sticky: value.sticky !== false,
      remap: value.remap !== false,
      createdAt: finite(value.createdAt),
      slot: Math.max(0, integer(value.slot))
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
    data.extraTables.push([name, table])
    if (data.extraTables.length >= 8_000) break
  }

  for (const value of Array.isArray(raw.stickyMap) ? raw.stickyMap : []) {
    if (!Array.isArray(value) || value.length < 4) continue
    const instanceId = string(value[0])
    const mac = string(value[1]).toLowerCase()
    const wanName = string(value[2])
    if (!instanceIds.has(instanceId) || !mac || !wanName) continue
    data.stickyMap.push([instanceId, mac, wanName, finite(value[3])])
    if (data.stickyMap.length >= 20_000) break
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

  for (const value of Array.isArray(raw.jobs) ? raw.jobs : []) {
    const job = normalizeJob(value)
    if (job) data.jobs.push(job)
    if (data.jobs.length >= MAX_FINISHED_JOBS) break
  }
  return data
}

function newestSticky(data: OwrtHostData): OwrtHostData['stickyMap'] {
  const unique = new Map<string, OwrtHostData['stickyMap'][number]>()
  for (const entry of [...data.stickyMap].sort((a, b) => b[3] - a[3])) {
    const key = `${entry[0]}\0${entry[1]}`
    if (!unique.has(key)) unique.set(key, entry)
  }
  return [...unique.values()]
}

function trim(data: OwrtHostData, rules: OwrtRules, aggressive = false): void {
  const stickyCap = Math.max(100, rules.stickyCap)
  data.stickyMap = newestSticky(data).slice(0, stickyCap)

  const eventCap = aggressive ? Math.min(20, rules.maxEvents) : Math.max(10, rules.maxEvents)
  if (data.events.length > eventCap) data.events = data.events.slice(-eventCap)

  const jobCap = aggressive ? 3 : MAX_FINISHED_JOBS
  const itemCap = aggressive ? 8 : MAX_FINISHED_JOB_ITEMS
  data.jobs = data.jobs.slice(0, jobCap).map((job) => ({
    ...job,
    items: job.items.slice(0, itemCap)
  }))
}

/** Drop expendable rings first, then shrink sticky newest-first until it fits. */
function fitHostData(data: OwrtHostData, rules: OwrtRules): void {
  trim(data, rules, true)
  if (serializedBytes(data) <= PERSIST_TARGET_BYTES) return
  const ranked = newestSticky(data)
  let keep = ranked.length
  while (keep > 100) {
    data.stickyMap = ranked.slice(0, keep)
    if (serializedBytes(data) <= PERSIST_TARGET_BYTES) return
    keep = Math.max(100, Math.floor(keep * 0.85))
  }
  data.stickyMap = ranked.slice(0, 100)
}

/**
 * Cached per-router data with delayed writes. Reconcile may touch sticky
 * timestamps every fast tick; this store writes at most once per ten seconds.
 */
export class HostStore {
  private cache: OwrtHostData | null = null
  private cachedFor: string | null = null
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private firewallChain: Promise<void> = Promise.resolve()

  constructor(
    private ctx: ModuleContext,
    private rules: () => OwrtRules
  ) {}

  read(): OwrtHostData {
    const host = this.ctx.hostKey
    if (this.cache && this.cachedFor === host) return this.cache
    this.cancelTimer()
    this.cache = normalize(this.ctx.hostDataGet())
    trim(this.cache, this.rules())
    this.cachedFor = host
    this.dirty = false
    return this.cache
  }

  update<T>(mutate: (data: OwrtHostData) => T): T {
    const data = this.read()
    const result = mutate(data)
    trim(data, this.rules())
    this.dirty = true
    this.schedule()
    return result
  }

  /** Serialize shared firewall rebuilds across PPPoE and binding jobs. */
  async withFirewall<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.firewallChain.then(run, run)
    this.firewallChain = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  /**
   * Flush now, retrying with the expendable rings cut down if the 512 KB cap
   * was reached. Core topology records are never dropped to make a write fit.
   */
  flush(): void {
    this.cancelTimer()
    if (!this.cache || !this.dirty || this.cachedFor !== this.ctx.hostKey) return
    const data = this.cache
    trim(data, this.rules())
    try {
      this.ctx.hostDataSet(data)
      this.dirty = false
      return
    } catch (error) {
      this.ctx.log(
        `openwrt: host data did not fit; trimming history (${error instanceof Error ? error.message : String(error)})`
      )
    }

    fitHostData(data, this.rules())
    try {
      this.ctx.hostDataSet(data)
      this.dirty = false
    } catch (error) {
      // Keep the in-memory state. A later mutation schedules another attempt.
      this.ctx.log(
        `openwrt: host data could not be saved (${error instanceof Error ? error.message : String(error)})`
      )
    }
  }

  reset(): void {
    this.flush()
    this.cancelTimer()
    this.cache = null
    this.cachedFor = null
    this.dirty = false
  }

  dispose(): void {
    this.flush()
    this.cancelTimer()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, PERSIST_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
