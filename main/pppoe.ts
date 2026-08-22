/**
 * PPPoE automation orchestration.
 *
 * Passwords exist only in a one-use check-session payload and in the closures
 * of the running create job. Batch records, job labels/messages, streams and
 * renderer rows never contain them.
 */
import {
  createCheckSession,
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { parsePppoeList, uciQuote } from './parse'
import type { IfaceState, PppoeInputRow, RouterModel } from './types'
import type { FinishedJob, JobSpec, OpenWrtJob } from './jobs'
import {
  UciCancelledError,
  applyFirewallPlan,
  applyInterfaceWave,
  applyPppoeChunk,
  buildDeletePppoeLines,
  buildDeleteVlanLines,
  buildFirewallPlan,
  chunkValues,
  effectivePppoeChunkSize,
  isManagedSectionName,
  isPppoePrefix,
  isSafeDeviceName,
  planPppoeChunks,
  pppoeSectionName,
  pppoeTableId,
  reloadFirewall,
  reloadNetwork,
  runUciBatch,
  vlanSectionName,
  waitCancelable,
  type InterfaceAction
} from './uci'

/** Only the rules consumed here; ConfigStore.effectiveRules() may return more. */
export interface PppoeRules {
  ifacePrefix: string
  tableBase: number
  catchAllTable: number
  uciChunkSize: number
  chunkDelayMs: number
  execTimeoutSec: number
  maxBatchRows: number
  zoneName: string
  zoneMode: 'wildcard' | 'networks'
  autoRedialAfterMin: number
}

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

/** The part of ConfigStore used by this manager. */
export interface PppoeConfigStore {
  effectiveRules(): PppoeRules
}

/** The part of OwrtHostData used here. Binding/event fields remain untouched. */
export interface PppoeStoreData {
  nextSeq: number
  batches: PppoeBatchRecord[]
}

export interface PppoeHostStore<TData extends PppoeStoreData = PppoeStoreData> {
  read(): TData
  update<TResult>(mutate: (data: TData) => TResult): TResult
  withFirewall?<TResult>(run: () => Promise<TResult>): Promise<TResult>
}

export interface PppoeJobs {
  start(spec: JobSpec): OpenWrtJob
  list(): OpenWrtJob[]
}

/**
 * Adapter over FastSweep/model cache. `model` must not perform SSH; rows and
 * summaries are deliberately cache-only. `refreshNow`, when supplied, should
 * run one forced fast sample after forceDump().
 */
export interface PppoeService {
  model(): RouterModel | null
  forceDump(): void
  refreshNow?(): Promise<void>
  pppoeUsers?(): Readonly<Record<string, string>>
  pppoeErrors?(): Readonly<Record<string, string>>
  lanFirewallZone?(): string
  event?(kind: string, text: string): void
}

export type PppoeStatus = 'up' | 'dialing' | 'error' | 'stopped'

export interface PppoeRow {
  id: string
  name: string
  batchId: string
  batch: string
  username: string
  status: PppoeStatus
  error: string
  /** Renderer-friendly alias used by the attention/detail tables. */
  errorCode: string
  ip: string
  uptime: number
  uptimeLabel: string
}

export interface PppoeBatchSummary {
  id: string
  name: string
  carrier: string
  prefix: string
  vlan?: number
  count: number
  up: number
  dialing: number
  error: number
  stopped: number
  createdAt: number
}

export interface PppoeDisplayRow {
  name: string
  batch: string
  username: string
  status: PppoeStatus
  errorCode: string
  ip: string
  uptimeLabel: string
}

export interface PppoeSnapshot {
  t: number
  batchCount: number
  total: number
  up: number
  dialing: number
  error: number
  stopped: number
}

interface FrozenBatchPlan {
  name: string
  carrier: string
  prefix: string
  vlan?: number
  rows: readonly Readonly<PppoeInputRow>[]
  seqFrom: number
  seqTo: number
  rules: Readonly<PppoeRules>
}

export interface RouterInventory {
  carrierExists: boolean
  sections: Set<string>
  tables: Set<number>
  vlanDevices: Map<string, { ifname?: string; vid?: number; name?: string }>
}

interface NetworkDeviceInventory {
  interfaceDevices: Map<string, string>
  deviceNames: Map<string, string>
}

const HARD_MAX_BATCH_ROWS = 5_000
const PPP_BYTES_PER_SESSION = 2 * 1024 * 1024
const RAM_WARNING_SHARE = 0.6
const BATCH_NAME_MAX = 80
const CHECK_ERROR_SAMPLE = 20

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(values: Record<string, unknown>, key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

function tokenValues(values: Record<string, unknown>): Record<string, unknown> {
  return { ...values, listFile: '', listText: '' }
}

function timeoutMs(rules: PppoeRules): number {
  return Math.max(5_000, Math.trunc(rules.execTimeoutSec) * 1_000)
}

function parseOptionalVlan(values: Record<string, unknown>): { value?: number; error?: string } {
  const raw = text(values, 'vlan')
  if (!raw || raw === '0') return {}
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 4094) {
    return { error: 'Batch VLAN must be a whole number between 1 and 4094' }
  }
  return { value }
}

function makeBatchId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    if (!taken.has(id)) return id
  }
  return `batch_${Date.now().toString(36)}_${taken.size.toString(36)}`
}

function batchSequences(batch: PppoeBatchRecord): number[] {
  const from = Math.max(1, Math.trunc(batch.seqFrom))
  const available = Math.max(0, Math.trunc(batch.seqTo) - from + 1)
  const declared = Math.max(0, Math.trunc(batch.count))
  const count = Math.min(HARD_MAX_BATCH_ROWS, available, declared || available)
  return Array.from({ length: count }, (_, index) => from + index).filter(
    (seq) => seq <= 99_999
  )
}

function allBatchNames(batch: PppoeBatchRecord): string[] {
  return batchSequences(batch).map((seq) => pppoeSectionName(batch.prefix, seq))
}

function parseQuotedValue(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).split("'\\''").join("'")
  }
  return value
}

function requestedVlans(
  rows: readonly Readonly<PppoeInputRow>[],
  batchVlan?: number
): number[] {
  const vlans = new Set<number>()
  if (batchVlan !== undefined && rows.some((row) => row.vlan === undefined)) {
    vlans.add(batchVlan)
  }
  for (const row of rows) {
    if (row.vlan !== undefined) vlans.add(row.vlan)
  }
  return [...vlans]
}

function vlanConflict(
  inventory: RouterInventory,
  carrier: string,
  vlan: number
): string | null {
  const section = vlanSectionName(vlan)
  const existing = inventory.vlanDevices.get(section)
  if (!existing) return null
  const expectedName = `${carrier}.${vlan}`
  if (
    existing.ifname === carrier &&
    existing.vid === vlan &&
    existing.name === expectedName
  ) {
    return null
  }
  return `${section} already describes ${existing.name || existing.ifname || 'another VLAN device'}`
}

function allocationLimit(rules: PppoeRules): number {
  return Math.min(99_999, Math.trunc(rules.catchAllTable) - Math.trunc(rules.tableBase) - 1)
}

function applyRulesFingerprint(rules: PppoeRules): string {
  return JSON.stringify([
    rules.tableBase,
    rules.catchAllTable,
    rules.uciChunkSize,
    rules.chunkDelayMs,
    rules.execTimeoutSec,
    rules.maxBatchRows,
    rules.zoneName,
    rules.zoneMode
  ])
}

function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom <= bTo && bFrom <= aTo
}

export function findSequenceRange(
  count: number,
  prefix: string,
  rules: PppoeRules,
  data: PppoeStoreData,
  inventory: RouterInventory
): { from: number; to: number } | null {
  const limit = allocationLimit(rules)
  const start = Math.max(1, Math.trunc(data.nextSeq) || 1)
  return (
    scanSequenceRange(count, prefix, rules, data, inventory, start, limit) ??
    (start > 1 ? scanSequenceRange(count, prefix, rules, data, inventory, 1, start - 1) : null)
  )
}

function scanSequenceRange(
  count: number,
  prefix: string,
  rules: PppoeRules,
  data: PppoeStoreData,
  inventory: RouterInventory,
  startFrom: number,
  maxFrom: number
): { from: number; to: number } | null {
  const limit = allocationLimit(rules)
  let from = Math.max(1, startFrom)
  while (from <= maxFrom && from + count - 1 <= limit) {
    const to = from + count - 1
    let movedTo = from
    for (const batch of data.batches) {
      if (overlaps(from, to, batch.seqFrom, batch.seqTo)) {
        movedTo = Math.max(movedTo, batch.seqTo + 1)
      }
    }
    if (movedTo !== from) {
      from = movedTo
      continue
    }

    let collision = 0
    for (let seq = from; seq <= to; seq++) {
      if (
        inventory.sections.has(pppoeSectionName(prefix, seq)) ||
        inventory.tables.has(pppoeTableId(rules.tableBase, seq))
      ) {
        collision = seq
        break
      }
    }
    if (collision) {
      from = collision + 1
      continue
    }
    return { from, to }
  }
  return null
}

function rangeStillFree(
  plan: FrozenBatchPlan,
  rules: PppoeRules,
  data: PppoeStoreData,
  inventory: RouterInventory
): boolean {
  if (
    data.batches.some((batch) =>
      overlaps(plan.seqFrom, plan.seqTo, batch.seqFrom, batch.seqTo)
    )
  ) {
    return false
  }
  for (let seq = plan.seqFrom; seq <= plan.seqTo; seq++) {
    if (
      inventory.sections.has(pppoeSectionName(plan.prefix, seq)) ||
      inventory.tables.has(pppoeTableId(rules.tableBase, seq))
    ) {
      return false
    }
  }
  return true
}

function mib(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`
}

function elapsedLabel(secondsRaw: number): string {
  const seconds = Math.max(0, Math.trunc(secondsRaw))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function statusFor(
  name: string,
  iface: IfaceState | undefined,
  externalError: string | undefined,
  manuallyStopped: ReadonlySet<string>
): { status: PppoeStatus; error: string } {
  if (manuallyStopped.has(name)) return { status: 'stopped', error: '' }
  if (iface?.up && iface.ipv4?.addr) return { status: 'up', error: '' }
  const error = externalError || iface?.errorCode || ''
  if (error) return { status: 'error', error }
  if (iface?.pending) return { status: 'dialing', error: '' }
  if (!iface || iface.autostart === false) return { status: 'stopped', error: '' }
  if (!iface.up) return { status: 'dialing', error: '' }
  return { status: 'dialing', error: '' }
}

export class PppoeManager<TData extends PppoeStoreData = PppoeStoreData> {
  private session = createCheckSession<FrozenBatchPlan>()
  private sample: RouterModel | null = null
  /** Renderer-visible username cache only; never written to HostStore. */
  private usernames = new Map<string, string>()
  private manuallyStopped = new Set<string>()
  private deleting = new Set<string>()
  private errorSince = new Map<string, number>()
  private watchdogJobId: string | null = null
  private latestPayload: PppoeSnapshot = {
    t: 0,
    batchCount: 0,
    total: 0,
    up: 0,
    dialing: 0,
    error: 0,
    stopped: 0
  }
  private generation = 0

  constructor(
    private ctx: ModuleContext,
    private config: PppoeConfigStore,
    private store: PppoeHostStore<TData>,
    private jobs: PppoeJobs,
    private service: PppoeService
  ) {}

  /**
   * Parse and freeze the exact credentials/range behind a one-use ten-minute
   * token. The report contains counts and usernames-at-most, never passwords.
   */
  async check(raw: unknown): Promise<ModuleCheckReport> {
    if (!this.ctx.connected) return failedCheck('No router is connected')
    const values = asRecord(raw)
    const rules = this.config.effectiveRules()
    const findings: ModuleCheckFinding[] = []
    const name = text(values, 'name')
    const carrier = text(values, 'carrier')
    const prefix = text(values, 'prefix') || rules.ifacePrefix
    const vlanResult = parseOptionalVlan(values)
    const file = typeof values.listFile === 'string' ? values.listFile : ''
    const pasted = typeof values.listText === 'string' ? values.listText : ''
    const source = file.trim() ? file : pasted
    const parsed = parsePppoeList(source)
    const maxRows = Math.min(HARD_MAX_BATCH_ROWS, Math.max(1, Math.trunc(rules.maxBatchRows)))

    if (!name || name.length > BATCH_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
      findings.push({
        level: 'error',
        label: `Batch name must be 1-${BATCH_NAME_MAX} characters on one line`
      })
    } else if (this.store.read().batches.some((batch) => batch.name.toLowerCase() === name.toLowerCase())) {
      findings.push({ level: 'error', label: `A PPPoE batch called "${name}" already exists` })
    }
    if (!isSafeDeviceName(carrier)) {
      findings.push({ level: 'error', label: 'Choose a valid carrier interface' })
    }
    if (!isPppoePrefix(prefix)) {
      findings.push({
        level: 'error',
        label: 'Prefix must be 1-4 lowercase letters or digits and start with a letter'
      })
    }
    if (vlanResult.error) findings.push({ level: 'error', label: vlanResult.error })

    if (parsed.rows.length < 1 || parsed.rows.length > maxRows) {
      findings.push({
        level: 'error',
        label: `Account list must contain between 1 and ${maxRows} valid rows`,
        detail: parsed.rows.length ? `${parsed.rows.length} valid rows were parsed.` : 'No valid account row was found.'
      })
    }
    if (parsed.errors.length) {
      findings.push({
        level: 'error',
        label: `${parsed.errors.length} account line(s) are invalid`,
        detail: parsed.errors
          .slice(0, CHECK_ERROR_SAMPLE)
          .map((entry) => `line ${entry.line}: ${entry.reason}`)
          .join('; ')
          .concat(parsed.errors.length > CHECK_ERROR_SAMPLE ? `; and ${parsed.errors.length - CHECK_ERROR_SAMPLE} more` : '')
      })
    }
    if (parsed.duplicates.length) {
      findings.push({
        level: 'warning',
        label: `${parsed.duplicates.length} username(s) occur more than once`,
        detail:
          parsed.duplicates.slice(0, CHECK_ERROR_SAMPLE).join(', ') +
          (parsed.duplicates.length > CHECK_ERROR_SAMPLE ? ', …' : '') +
          '. Many access concentrators reject concurrent use of one account.'
      })
    }

    if (hasBlockingFinding(findings)) return { ok: false, findings }

    let inventory: RouterInventory
    try {
      inventory = await this.inspectRouter(carrier, timeoutMs(rules))
    } catch (error) {
      return {
        ok: false,
        findings: [
          ...findings,
          {
            level: 'error',
            label: 'Could not inspect the router network configuration',
            detail: error instanceof Error ? error.message : String(error)
          }
        ]
      }
    }
    if (!inventory.carrierExists) {
      findings.push({
        level: 'error',
        label: `Carrier ${carrier} does not exist on the connected router`
      })
    }
    for (const vlan of requestedVlans(parsed.rows, vlanResult.value)) {
      if (`${carrier}.${vlan}`.length > 15) {
        findings.push({
          level: 'error',
          label: `VLAN device ${carrier}.${vlan} is longer than Linux IFNAMSIZ`
        })
        continue
      }
      const conflict = vlanConflict(inventory, carrier, vlan)
      if (conflict) {
        findings.push({
          level: 'error',
          label: `VLAN ${vlan} conflicts with existing UCI configuration`,
          detail: conflict
        })
      }
    }

    const range = findSequenceRange(
      parsed.rows.length,
      prefix,
      rules,
      this.store.read(),
      inventory
    )
    if (!range) {
      findings.push({
        level: 'error',
        label: 'No free PPPoE sequence/table range is available',
        detail: `The configured table range ends at sequence ${Math.max(0, allocationLimit(rules))}.`
      })
    }

    const model = this.currentModel()
    const wantedRam = parsed.rows.length * PPP_BYTES_PER_SESSION
    const memFree = model?.sys.memFree ?? 0
    if (memFree > 0 && wantedRam > memFree * RAM_WARNING_SHARE) {
      findings.push({
        level: 'warning',
        label: `${parsed.rows.length} pppd processes may use about ${mib(wantedRam)}`,
        detail: `The latest router sample reports ${mib(memFree)} free; this exceeds 60% of it.`
      })
    } else if (memFree > 0) {
      findings.push({
        level: 'pass',
        label: `Estimated PPP memory ${mib(wantedRam)} of ${mib(memFree)} currently free`
      })
    } else {
      findings.push({
        level: 'info',
        label: `Allow about ${mib(wantedRam)} of router RAM for these pppd processes`,
        detail: 'No usable free-memory sample is cached yet.'
      })
    }

    if (range) {
      const chunkSize = effectivePppoeChunkSize(parsed.rows.length, rules.uciChunkSize)
      const chunks = Math.ceil(parsed.rows.length / chunkSize)
      findings.push({
        level: 'pass',
        label: `Will create ${parsed.rows.length} interfaces ${pppoeSectionName(prefix, range.from)}…${pppoeSectionName(prefix, range.to)} on ${carrier}`,
        detail: `${chunks} UCI chunk${chunks === 1 ? '' : 's'} of up to ${chunkSize}, with ${rules.chunkDelayMs} ms between chunks.`
      })
      findings.push({
        level: 'info',
        label: `Routing tables ${pppoeTableId(rules.tableBase, range.from)}…${pppoeTableId(rules.tableBase, range.to)} are free`
      })
    }

    const ok = !hasBlockingFinding(findings) && range !== null
    if (!ok || !range) return { ok: false, findings }
    const rows = Object.freeze(
      parsed.rows.map((row) =>
        Object.freeze({
          user: row.user,
          pass: row.pass,
          ...(row.vlan === undefined ? {} : { vlan: row.vlan })
        })
      )
    )
    const plan: FrozenBatchPlan = Object.freeze({
      name,
      carrier,
      prefix,
      ...(vlanResult.value === undefined ? {} : { vlan: vlanResult.value }),
      rows,
      seqFrom: range.from,
      seqTo: range.to,
      rules: Object.freeze({ ...rules })
    })
    return {
      ok: true,
      token: this.session.issue(tokenValues(values), plan),
      findings
    }
  }

  async apply(raw: unknown): Promise<OkResult> {
    const payload = asRecord(raw)
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) return { ok: false, error: 'that check expired or the form changed - check again' }
    if (!this.ctx.connected) return { ok: false, error: 'the router disconnected after the check' }

    const plan = taken.payload
    const currentRules = this.config.effectiveRules()
    if (applyRulesFingerprint(currentRules) !== applyRulesFingerprint(plan.rules)) {
      return { ok: false, error: 'OpenWRT rules changed after the check - check again' }
    }
    const rules = plan.rules
    let inventory: RouterInventory
    try {
      inventory = await this.inspectRouter(plan.carrier, timeoutMs(rules))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!inventory.carrierExists) return { ok: false, error: `carrier ${plan.carrier} no longer exists` }
    for (const vlan of requestedVlans(plan.rows, plan.vlan)) {
      const conflict = vlanConflict(inventory, plan.carrier, vlan)
      if (conflict) return { ok: false, error: `${conflict} - check again` }
    }
    const data = this.store.read()
    if (data.batches.some((batch) => batch.name.toLowerCase() === plan.name.toLowerCase())) {
      return { ok: false, error: 'that batch name was taken after the check - check again' }
    }
    if (!rangeStillFree(plan, rules, data, inventory)) {
      return { ok: false, error: 'the checked interface/table range is no longer free - check again' }
    }

    const chunks = planPppoeChunks(plan.rows, {
      prefix: plan.prefix,
      carrier: plan.carrier,
      seqFrom: plan.seqFrom,
      tableBase: rules.tableBase,
      ...(plan.vlan === undefined ? {} : { vlan: plan.vlan })
    }, rules.uciChunkSize)
    const names = chunks.flatMap((chunk) => chunk.sections)
    const id = makeBatchId(new Set(data.batches.map((batch) => batch.id)))
    const batch: PppoeBatchRecord = {
      id,
      name: plan.name,
      prefix: plan.prefix,
      carrier: plan.carrier,
      ...(plan.vlan === undefined ? {} : { vlan: plan.vlan }),
      createdAt: Date.now(),
      count: plan.rows.length,
      seqFrom: plan.seqFrom,
      seqTo: plan.seqTo
    }
    this.store.update((host) => {
      host.batches.push(batch)
      host.nextSeq = Math.max(host.nextSeq, plan.seqTo + 1)
    })
    const managerGeneration = this.generation

    const jobItems: JobSpec['items'] = chunks.map((chunk, index) => ({
      name: `Apply PPPoE chunk ${chunk.index}/${chunk.total} (${chunk.seqFrom}-${chunk.seqTo})`,
      run: async (cancelled) => {
        try {
          await applyPppoeChunk(this.ctx, chunk, timeoutMs(rules))
        } finally {
          this.forceDump()
        }
        if (index + 1 < chunks.length && rules.chunkDelayMs > 0 && !cancelled()) {
          try {
            await waitCancelable(rules.chunkDelayMs, cancelled)
          } catch (error) {
            // The chunk is already committed/reloaded. Count it as successful;
            // the runner will mark later chunks cancelled.
            if (!(error instanceof UciCancelledError)) throw error
          }
        }
      }
    }))
    jobItems.push({
      name: `Configure firewall zone ${rules.zoneName}`,
      run: async () => {
        let result: { warning?: string }
        try {
          result = await this.runFirewall(async () => {
            const live = this.store.read()
            const planNow = buildFirewallPlan({
              zoneName: rules.zoneName,
              prefix: plan.prefix,
              prefixes: [...new Set(live.batches.map((batch) => batch.prefix))],
              mode: rules.zoneMode,
              networkSections: live.batches.flatMap(allBatchNames),
              chunkSize: rules.uciChunkSize,
              lanZone: this.service.lanFirewallZone?.() || 'lan'
            })
            return applyFirewallPlan(this.ctx, planNow, {
              timeoutMs: timeoutMs(rules),
              // A job cancels between items. Rebuilding shared membership is one
              // item and finishes after a user cancel so earlier batches are not
              // left half-removed. A host reset still stops it.
              cancelled: () => managerGeneration !== this.generation,
              onMutated: () => this.forceDump()
            })
          })
        } finally {
          this.forceDump()
        }
        if (result.warning) {
          this.recordEvent('pppoe-firewall-warning', result.warning)
          return result.warning
        }
      }
    })
    jobItems.push({
      name: `Verify ${names.length} PPPoE interfaces`,
      run: async () => {
        this.forceDump()
        await this.service.refreshNow?.()
        const visible = await this.visibleInterfaceCount(names, timeoutMs(rules))
        if (visible !== names.length) {
          throw new Error(`only ${visible}/${names.length} PPPoE interfaces appeared after reload`)
        }
      }
    })

    let job: OpenWrtJob
    try {
      job = this.jobs.start({
        kind: 'pppoe-create',
        label: `Create batch ${batch.name} (${batch.count} connections)`,
        items: jobItems,
        onError: 'abort',
        onFinished: (finished) => {
          this.forceDump()
          this.emitSummary()
          this.recordEvent(
            'pppoe-create',
            `Batch ${batch.name} create job ${finished.state} (${batch.count} connections)`
          )
        }
      })
    } catch (error) {
      this.store.update((host) => {
        host.batches = host.batches.filter((entry) => entry.id !== id)
      })
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    for (let index = 0; index < names.length; index++) {
      const user = plan.rows[index]?.user
      if (user !== undefined) this.usernames.set(names[index], user)
    }
    this.emitSummary()
    return { ok: true, data: job.id }
  }

  batches(): PppoeBatchSummary[] {
    const rows = this.rowsByBatch()
    return this.store.read().batches.map((batch) => {
      const counts = { up: 0, dialing: 0, error: 0, stopped: 0 }
      for (const row of rows.get(batch.id) ?? []) counts[row.status] += 1
      return {
        id: batch.id,
        name: batch.name,
        carrier: batch.carrier,
        prefix: batch.prefix,
        ...(batch.vlan === undefined ? {} : { vlan: batch.vlan }),
        count: batch.count,
        ...counts,
        createdAt: batch.createdAt
      }
    })
  }

  rows(batchIdRaw: unknown): PppoeDisplayRow[] {
    const id = typeof batchIdRaw === 'string' ? batchIdRaw : ''
    const byBatch = this.rowsByBatch()
    const rows =
      id === 'errors'
        ? [...byBatch.values()].flat().filter((row) => row.status === 'error')
        : byBatch.get(id) ?? []
    return rows.map((row) => ({
      name: row.name,
      batch: row.batch,
      username: row.username,
      status: row.status,
      errorCode: row.errorCode,
      ip: row.ip,
      uptimeLabel: row.uptimeLabel
    }))
  }

  snapshot(): PppoeSnapshot {
    const batches = this.batches()
    this.latestPayload = {
      t: Date.now(),
      batchCount: batches.length,
      total: batches.reduce((sum, batch) => sum + batch.count, 0),
      up: batches.reduce((sum, batch) => sum + batch.up, 0),
      dialing: batches.reduce((sum, batch) => sum + batch.dialing, 0),
      error: batches.reduce((sum, batch) => sum + batch.error, 0),
      stopped: batches.reduce((sum, batch) => sum + batch.stopped, 0)
    }
    return this.latestPayload
  }

  get latest(): PppoeSnapshot {
    return this.latestPayload.t ? this.latestPayload : this.snapshot()
  }

  /** Called after FastSweep has replaced its model cache. */
  onSample(model?: RouterModel): void {
    if (model) this.sample = model
    this.pruneManualStops()
    this.emitSummary()
  }

  batchAction(idRaw: unknown, actionRaw: unknown): OkResult {
    const id = typeof idRaw === 'string' ? idRaw : ''
    const batch = this.store.read().batches.find((entry) => entry.id === id)
    if (!batch) return { ok: false, error: 'no such PPPoE batch' }
    if (this.deleting.has(id)) return { ok: false, error: 'that batch is being deleted' }
    if (!this.isAction(actionRaw)) return { ok: false, error: `"${String(actionRaw)}" is not a PPPoE action` }
    const job = this.startActionJob(
      actionRaw,
      allBatchNames(batch),
      `${this.actionTitle(actionRaw)} batch ${batch.name}`,
      `pppoe-batch-${actionRaw}`
    )
    return { ok: true, data: job.id }
  }

  connAction(namesRaw: unknown, actionRaw: unknown): OkResult {
    if (!this.isAction(actionRaw)) return { ok: false, error: `"${String(actionRaw)}" is not a PPPoE action` }
    const selected = Array.isArray(namesRaw) ? namesRaw.map(String) : []
    if (!selected.length) return { ok: false, error: 'nothing was selected' }
    const data = this.store.read()
    const deletingNames = new Set(
      data.batches.filter((batch) => this.deleting.has(batch.id)).flatMap(allBatchNames)
    )
    if (selected.some((name) => deletingNames.has(name))) {
      return { ok: false, error: 'one or more selected interfaces is being deleted' }
    }
    const managed = new Set(data.batches.flatMap(allBatchNames))
    const names = [...new Set(selected)].filter((name) => managed.has(name) && isManagedSectionName(name))
    if (!names.length) return { ok: false, error: 'none of the selected interfaces belongs to a managed batch' }
    const job = this.startActionJob(
      actionRaw,
      names,
      `${this.actionTitle(actionRaw)} ${names.length} PPPoE connection${names.length === 1 ? '' : 's'}`,
      `pppoe-connection-${actionRaw}`
    )
    return { ok: true, data: job.id }
  }

  batchDelete(idRaw: unknown): OkResult {
    const id = typeof idRaw === 'string' ? idRaw : ''
    const batch = this.store.read().batches.find((entry) => entry.id === id)
    if (!batch) return { ok: false, error: 'no such PPPoE batch' }
    if (this.deleting.has(id)) return { ok: false, error: 'that batch is already being deleted' }
    this.deleting.add(id)

    const rules = this.config.effectiveRules()
    const names = allBatchNames(batch)
    const size = effectivePppoeChunkSize(names.length, rules.uciChunkSize)
    const waves = chunkValues(names, size)
    const candidateVlans = new Set<number>()
    if (batch.vlan !== undefined) candidateVlans.add(batch.vlan)
    let networkMutated = false
    let firewallMutated = false
    let finalReloadDone = false

    const items: JobSpec['items'] = [{
      name: 'Inspect batch VLAN devices',
      run: async () => {
        const inventory = await this.inspectNetworkDevices(timeoutMs(rules))
        for (const name of names) {
          const device = inventory.interfaceDevices.get(name) ?? ''
          const prefix = `${batch.carrier}.`
          if (!device.startsWith(prefix)) continue
          const vlan = Number(device.slice(prefix.length))
          if (Number.isInteger(vlan) && vlan >= 1 && vlan <= 4094) candidateVlans.add(vlan)
        }
      }
    }]
    for (const [index, wave] of waves.entries()) {
      items.push({
        name: `Stop batch wave ${index + 1}/${waves.length}`,
        run: async (cancelled) => {
          try {
            // A cancelled/failed create may have produced only part of the
            // recorded range; missing interfaces must not block cleanup.
            await applyInterfaceWave(this.ctx, wave, 'stop', timeoutMs(rules), {
              bestEffort: true
            })
            for (const name of wave) this.manuallyStopped.add(name)
          } finally {
            this.forceDump()
          }
          if (index + 1 < waves.length && rules.chunkDelayMs > 0 && !cancelled()) {
            try {
              await waitCancelable(rules.chunkDelayMs, cancelled)
            } catch (error) {
              if (!(error instanceof UciCancelledError)) throw error
            }
          }
        }
      })
    }
    for (const [index, chunk] of waves.entries()) {
      items.push({
        name: `Delete UCI chunk ${index + 1}/${waves.length}`,
        run: async () => {
          const lines = buildDeletePppoeLines(chunk, {
            zoneName: rules.zoneName,
            mode: rules.zoneMode
          })
          networkMutated = true
          if (rules.zoneMode === 'networks') firewallMutated = true
          try {
            await runUciBatch(
              this.ctx,
              lines,
              rules.zoneMode === 'networks' ? ['network', 'firewall'] : ['network'],
              timeoutMs(rules)
            )
          } finally {
            this.forceDump()
          }
        }
      })
    }
    items.push({
      name: 'Clean unused VLAN devices and reload',
      run: async () => {
        const inventory = await this.inspectNetworkDevices(timeoutMs(rules))
        const used = new Set(inventory.interfaceDevices.values())
        const removable = [...candidateVlans].filter((vlan) => {
          const device = `${batch.carrier}.${vlan}`
          return !used.has(device) && inventory.deviceNames.get(vlanSectionName(vlan)) === device
        })
        const cleanup = buildDeleteVlanLines(removable)
        if (cleanup.length) {
          networkMutated = true
          try {
            await runUciBatch(this.ctx, cleanup, ['network'], timeoutMs(rules))
          } finally {
            this.forceDump()
          }
        }
        const remaining = this.store.read().batches.filter((entry) => entry.id !== id)
        firewallMutated = true
        await this.runFirewall(async () => {
          const rebuiltFirewall = buildFirewallPlan({
            zoneName: rules.zoneName,
            prefix: remaining[0]?.prefix ?? batch.prefix,
            prefixes: [...new Set(remaining.map((entry) => entry.prefix))],
            mode: rules.zoneMode,
            networkSections: remaining.flatMap(allBatchNames),
            chunkSize: rules.uciChunkSize,
            lanZone: this.service.lanFirewallZone?.() || 'lan'
          })
          await runUciBatch(this.ctx, rebuiltFirewall.setupLines, ['firewall'], timeoutMs(rules))
          for (const membership of rebuiltFirewall.membershipChunks) {
            await runUciBatch(this.ctx, membership, ['firewall'], timeoutMs(rules))
          }
        })
        await reloadNetwork(this.ctx, timeoutMs(rules))
        await reloadFirewall(this.ctx, timeoutMs(rules))
        finalReloadDone = true
        this.forceDump()
      }
    })

    let job: OpenWrtJob
    try {
      job = this.jobs.start({
        kind: 'pppoe-delete',
        label: `Delete batch ${batch.name} (${batch.count} connections)`,
        items,
        onError: 'abort',
        onFinished: async (finished) => {
          this.deleting.delete(id)
          // Cancellation between delete chunks must not leave committed UCI and
          // the running netifd/firewall configuration out of sync.
          if (networkMutated && !finalReloadDone) {
            try {
              await reloadNetwork(this.ctx, timeoutMs(rules))
              if (firewallMutated) await reloadFirewall(this.ctx, timeoutMs(rules))
            } catch (error) {
              this.ctx.log(
                `openwrt: reload after interrupted delete failed: ${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
          if (finished.state === 'done') {
            this.store.update((host) => {
              host.batches = host.batches.filter((entry) => entry.id !== id)
            })
            for (const name of names) {
              this.manuallyStopped.delete(name)
              this.usernames.delete(name)
            }
          }
          this.forceDump()
          this.emitSummary()
          this.recordEvent('pppoe-delete', `Batch ${batch.name} delete job ${finished.state}`)
        }
      })
    } catch (error) {
      this.deleting.delete(id)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, data: job.id }
  }

  /**
   * Optional slow-tick rescue. netifd already retries by itself, so the default
   * rule is zero/off and no timer exists in this class.
   */
  watchdog(now = Date.now()): string | null {
    const rules = this.config.effectiveRules()
    const minutes = Math.max(0, Math.trunc(rules.autoRedialAfterMin))
    if (minutes <= 0) {
      this.errorSince.clear()
      return null
    }
    if (this.watchdogJobId && this.jobs.list().some((job) => job.id === this.watchdogJobId && job.state === 'running')) {
      return null
    }
    this.watchdogJobId = null

    const errors = this.rows('errors').filter((row) => !this.manuallyStopped.has(row.name))
    const current = new Set(errors.map((row) => row.name))
    for (const name of this.errorSince.keys()) {
      if (!current.has(name)) this.errorSince.delete(name)
    }
    const threshold = minutes * 60_000
    const due: string[] = []
    for (const row of errors) {
      const since = this.errorSince.get(row.name)
      if (since === undefined) {
        this.errorSince.set(row.name, now)
      } else if (now - since >= threshold) {
        due.push(row.name)
      }
    }
    if (!due.length) return null

    const job = this.startActionJob(
      'redial',
      due,
      `Watchdog redial ${due.length} stuck PPPoE connection${due.length === 1 ? '' : 's'}`,
      'pppoe-watchdog',
      (finished) => {
        this.watchdogJobId = null
        const resetAt = Date.now()
        for (const name of due) this.errorSince.set(name, resetAt)
        this.recordEvent(
          'pppoe-watchdog',
          `Watchdog redial job ${finished.state} for ${due.length} connection${due.length === 1 ? '' : 's'}`
        )
      }
    )
    this.watchdogJobId = job.id
    this.recordEvent(
      'pppoe-watchdog',
      `Started watchdog redial for ${due.length} connection${due.length === 1 ? '' : 's'}`
    )
    return job.id
  }

  slowTick(now = Date.now()): string | null {
    return this.watchdog(now)
  }

  reset(): void {
    this.generation += 1
    this.session.clear()
    this.sample = null
    this.usernames.clear()
    this.manuallyStopped.clear()
    this.deleting.clear()
    this.errorSince.clear()
    this.watchdogJobId = null
    this.latestPayload = {
      t: 0,
      batchCount: 0,
      total: 0,
      up: 0,
      dialing: 0,
      error: 0,
      stopped: 0
    }
  }

  dispose(): void {
    this.reset()
  }

  // UI-handler-friendly aliases.
  batchCheck(raw: unknown): Promise<ModuleCheckReport> {
    return this.check(raw)
  }

  batchApply(raw: unknown): Promise<OkResult> {
    return this.apply(raw)
  }

  private startActionJob(
    action: InterfaceAction,
    names: readonly string[],
    label: string,
    kind: string,
    after?: (job: FinishedJob) => void | Promise<void>
  ): OpenWrtJob {
    const rules = this.config.effectiveRules()
    const size = effectivePppoeChunkSize(names.length, rules.uciChunkSize)
    const waves = chunkValues(names, size)
    return this.jobs.start({
      kind,
      label,
      onError: 'continue',
      items: waves.map((wave, index) => ({
        name: `${this.actionTitle(action)} wave ${index + 1}/${waves.length}`,
        run: async (cancelled) => {
          try {
            await applyInterfaceWave(this.ctx, wave, action, timeoutMs(rules))
            for (const name of wave) {
              if (action === 'stop') this.manuallyStopped.add(name)
              else this.manuallyStopped.delete(name)
            }
          } finally {
            this.forceDump()
          }
          if (index + 1 < waves.length && rules.chunkDelayMs > 0 && !cancelled()) {
            try {
              await waitCancelable(rules.chunkDelayMs, cancelled)
            } catch (error) {
              if (!(error instanceof UciCancelledError)) throw error
            }
          }
        }
      })),
      onFinished: async (finished) => {
        this.forceDump()
        this.emitSummary()
        await after?.(finished)
      }
    })
  }

  private isAction(value: unknown): value is InterfaceAction {
    return value === 'start' || value === 'stop' || value === 'redial'
  }

  private actionTitle(action: InterfaceAction): string {
    return action === 'start' ? 'Start' : action === 'stop' ? 'Stop' : 'Redial'
  }

  private currentModel(): RouterModel | null {
    return this.service.model() ?? this.sample
  }

  private rowsByBatch(): Map<string, PppoeRow[]> {
    const model = this.currentModel()
    const ifaces = new Map((model?.ifaces ?? []).map((iface) => [iface.name, iface]))
    const externalErrors = this.service.pppoeErrors?.() ?? {}
    const externalUsers = this.service.pppoeUsers?.() ?? {}
    const out = new Map<string, PppoeRow[]>()

    for (const batch of this.store.read().batches) {
      const rows: PppoeRow[] = []
      for (const seq of batchSequences(batch)) {
        const name = pppoeSectionName(batch.prefix, seq)
        const iface = ifaces.get(name)
        const state = statusFor(name, iface, externalErrors[name], this.manuallyStopped)
        const extended = iface as (IfaceState & { username?: unknown; user?: unknown }) | undefined
        const cachedUser =
          typeof extended?.username === 'string'
            ? extended.username
            : typeof extended?.user === 'string'
              ? extended.user
              : externalUsers[name] ?? this.usernames.get(name) ?? ''
        rows.push({
          id: name,
          name,
          batchId: batch.id,
          batch: batch.name,
          username: cachedUser,
          status: state.status,
          error: state.error,
          errorCode: state.error,
          ip: iface?.ipv4?.addr ?? '',
          uptime: iface?.uptimeSec ?? 0,
          uptimeLabel: elapsedLabel(iface?.uptimeSec ?? 0)
        })
      }
      out.set(batch.id, rows)
    }
    return out
  }

  private pruneManualStops(): void {
    const ifaces = new Map((this.currentModel()?.ifaces ?? []).map((iface) => [iface.name, iface]))
    for (const name of this.manuallyStopped) {
      if (ifaces.get(name)?.up) this.manuallyStopped.delete(name)
    }
  }

  private emitSummary(): void {
    const payload = this.snapshot()
    this.ctx.emit('pppoe', payload)
  }

  private runFirewall<T>(run: () => Promise<T>): Promise<T> {
    return this.store.withFirewall ? this.store.withFirewall(run) : run()
  }

  private forceDump(): void {
    this.service.forceDump()
  }

  private recordEvent(kind: string, message: string): void {
    const safe = message.replace(/[\r\n]+/g, ' ').slice(0, 500)
    this.ctx.log(`openwrt: ${safe}`)
    this.service.event?.(kind, safe)
  }

  private async inspectRouter(carrier: string, timeout: number): Promise<RouterInventory> {
    if (!isSafeDeviceName(carrier)) throw new Error('carrier is not a safe interface name')
    const script = [
      `if ip link show dev ${uciQuote(carrier)} >/dev/null 2>&1; then`,
      "  echo '===CARRIER===1'",
      'else',
      "  echo '===CARRIER===0'",
      'fi',
      "echo '===NETWORK==='",
      "uci -q show network 2>/dev/null | grep -E '=interface$|\\.ip4table=|^network\\.bmv[0-9]+(=device|\\.(ifname|vid|name)=)' || true"
    ].join('\n')
    const result = await this.ctx.exec('sh -s', {
      stdin: `${script}\n`,
      timeoutMs: timeout
    })
    if (result.code !== 0) throw new Error(`router inventory failed (exit ${result.code})`)

    const sections = new Set<string>()
    const tables = new Set<number>()
    const vlanDevices = new Map<string, { ifname?: string; vid?: number; name?: string }>()
    for (const line of result.stdout.split(/\r?\n/)) {
      const section = /^network\.([^.=]+)=interface$/.exec(line.trim())
      if (section?.[1]) sections.add(section[1])
      const table = /^network\.[^.=]+\.ip4table=(.+)$/.exec(line.trim())
      if (table?.[1]) {
        const value = Number(parseQuotedValue(table[1]))
        if (Number.isInteger(value) && value > 0) tables.add(value)
      }
      const declaration = /^network\.(bmv\d+)=device$/.exec(line.trim())
      if (declaration?.[1] && !vlanDevices.has(declaration[1])) {
        vlanDevices.set(declaration[1], {})
      }
      const property = /^network\.(bmv\d+)\.(ifname|vid|name)=(.+)$/.exec(line.trim())
      if (property?.[1] && property[2] && property[3]) {
        const current = vlanDevices.get(property[1]) ?? {}
        const value = parseQuotedValue(property[3])
        if (property[2] === 'ifname') current.ifname = value
        else if (property[2] === 'name') current.name = value
        else {
          const vid = Number(value)
          if (Number.isInteger(vid)) current.vid = vid
        }
        vlanDevices.set(property[1], current)
      }
    }
    return {
      carrierExists: result.stdout.includes('===CARRIER===1'),
      sections,
      tables,
      vlanDevices
    }
  }

  private async visibleInterfaceCount(names: readonly string[], timeout: number): Promise<number> {
    const wanted = new Set(names)
    const cached = new Set((this.currentModel()?.ifaces ?? []).map((iface) => iface.name))
    let count = names.reduce((sum, name) => sum + (cached.has(name) ? 1 : 0), 0)
    if (count === names.length) return count

    const result = await this.ctx.exec('ubus -S call network.interface dump', {
      timeoutMs: timeout
    })
    if (result.code !== 0) throw new Error(`interface verification failed (exit ${result.code})`)
    try {
      const decoded = JSON.parse(result.stdout) as { interface?: Array<{ interface?: unknown }> }
      count = 0
      for (const iface of Array.isArray(decoded.interface) ? decoded.interface : []) {
        if (typeof iface.interface === 'string' && wanted.has(iface.interface)) count += 1
      }
      return count
    } catch {
      throw new Error('interface verification returned invalid JSON')
    }
  }

  private async inspectNetworkDevices(timeout: number): Promise<NetworkDeviceInventory> {
    const result = await this.ctx.exec('sh -s', {
      stdin:
        "uci -q show network 2>/dev/null | grep -E '=device$|\\.device=|\\.name=' || true\n",
      timeoutMs: timeout
    })
    if (result.code !== 0) throw new Error(`network device inventory failed (exit ${result.code})`)
    const interfaceDevices = new Map<string, string>()
    const deviceNames = new Map<string, string>()
    const deviceSections = new Set<string>()
    for (const line of result.stdout.split(/\r?\n/)) {
      const declaration = /^network\.([^.=]+)=device$/.exec(line.trim())
      if (declaration?.[1]) deviceSections.add(declaration[1])
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      const device = /^network\.([^.=]+)\.device=(.+)$/.exec(line.trim())
      if (device?.[1] && device[2]) interfaceDevices.set(device[1], parseQuotedValue(device[2]))
      const name = /^network\.([^.=]+)\.name=(.+)$/.exec(line.trim())
      if (name?.[1] && name[2] && deviceSections.has(name[1])) {
        deviceNames.set(name[1], parseQuotedValue(name[2]))
      }
    }
    return { interfaceDevices, deviceNames }
  }
}
