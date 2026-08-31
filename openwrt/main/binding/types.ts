/**
 * The vocabulary of one-to-one binding: what the planner is asked, what it
 * answers, and the shapes the engine keeps between passes.
 *
 * Type declarations only, so every other file in this folder can name a
 * structure without pulling in the code that builds it.
 */
import type { CheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { ValueBadge } from '@shared/module-ui'
import type { OwrtRules } from '../config'
import type { AgentCapability } from '../probe'
import type { JobSpec } from '../jobs'
import type { BindingInstanceRecord, HostStore } from '../store'
import type { IpRule, Lease, RouterModel } from '../types'

// ---------------------------------------------------------------------------
// Pure planner contract

export interface BindingPlannerInstance {
  id: string
  running: boolean
  sticky: boolean
  remap: boolean
}

export interface BindingPlannerWan {
  name: string
  table: number | null
  up: boolean
  pending: boolean
  ipv4?: string
  uptimeSec: number
  errorCode?: string
}

/**
 * Deliberately carries no `stickyByMac` / `remapOnWanError`. Both are module
 * settings, and both are only the *initial* value the create form offers for
 * one instance's own `sticky` / `remap`; the planner reads the instance record
 * and nothing else. A live copy on the policy would let a settings toggle
 * change what a running instance does with no record of it on the instance -
 * which is why the planner already ignores them.
 */
export interface BindingPlannerPolicy {
  rulePrefBase: number
  catchAllPrefBase: number
  ruleChunkLines: number
  wanErrorGraceSec: number
  wanWarnUptimeSec: number
  releaseGraceSec: number
  maxEvents: number
}

export interface BindingStickyChoice {
  mac: string
  wan: string
  lastSeenAt: number
}

export interface BindingDeviceMemory {
  mac: string
  ip: string
  host: string
  lastSeenAt: number
  assignedAt: number
  wan?: string
}

export interface BindingWaitingMemory {
  mac: string
  enqueuedAt: number
  order: number
}

export interface BindingWanErrorMemory {
  wan: string
  since: number
}

export interface BindingOrphanMemory {
  key: string
  ip: string
  table: number
  pref: number
  firstMissingAt: number
}

export interface BindingForcedReassign {
  mac: string
  avoidWan?: string
  /**
   * The WAN this device was pinned to by hand. A forced request deliberately
   * skips the sticky preference - that is what makes Reassign move a device -
   * so without a field of its own there was no way to say "that WAN" rather
   * than "not this one", and every route into the planner from a handler went
   * through the forced path.
   */
  preferWan?: string
}

export interface BindingPlannerMemory {
  devices: BindingDeviceMemory[]
  waiting: BindingWaitingMemory[]
  wanErrors: BindingWanErrorMemory[]
  orphans: BindingOrphanMemory[]
  /** Manual Unassign holds are deliberately RAM-only. */
  heldMacs: string[]
  /** Consumed by one reconciliation. */
  forceReassign: BindingForcedReassign[]
  nextOrder: number
  /**
   * Whether the last pass ran out of ip rule preferences. Optional so a memory
   * written before this existed still loads; it only gates an event, and the
   * cost of a missing value is one extra notice on the first pass after it.
   */
  prefsExhausted?: boolean
}

export interface BindingActualAssignment {
  pref: number
  ip: string
  table: number
  wan: string | null
  mac: string | null
}

export interface BindingDesiredAssignment {
  pref: number
  ip: string
  table: number
  wan: string
  mac: string | null
  assignedAt: number
}

export interface BindingRuleChange {
  pref: number
  ip: string
  table: number
}

export interface BindingRuleDiff {
  delete: BindingRuleChange[]
  add: BindingRuleChange[]
  deleteLines: string[]
  addLines: string[]
  lines: string[]
  chunks: string[][]
}

export interface BindingPlannerEvent {
  t: number
  kind: string
  text: string
}

export interface BindingWanSummary {
  total: number
  available: number
  bound: number
  error: number
  warning: number
  dialing: number
}

export interface BindingDeviceSummary {
  total: number
  bound: number
  waiting: number
}

export interface BindingAssignmentRow {
  key: string
  instanceId: string
  host: string
  mac: string
  ip: string
  wan: string
  wanIp: string
  wanStatus: string
  wanStatusBadges: ValueBadge[]
  /** App-clock time this device was put on this WAN; `duration` counts from it. */
  assignedAt: number
  sinceLabel: string
}

export interface BindingWaitingRow {
  key: string
  instanceId: string
  mac: string
  host: string
  ip: string
  position: number
  waitingSince: number
  waitingFor: string
  /** Why this device is not bound. The queue is not always the answer. */
  reason: string
  held: boolean
  heldLabel: string
  holdBadges: ValueBadge[]
}

export interface BindingPlannerResult {
  actual: BindingActualAssignment[]
  desired: BindingDesiredAssignment[]
  ruleDiff: BindingRuleDiff
  memory: BindingPlannerMemory
  stickyUpdates: BindingStickyChoice[]
  events: BindingPlannerEvent[]
  assignments: BindingAssignmentRow[]
  waiting: BindingWaitingRow[]
  wan: BindingWanSummary
  devices: BindingDeviceSummary
}

export type BindingTableToWan =
  | ReadonlyMap<number, string>
  | Readonly<Record<string, string>>
  | ReadonlyArray<readonly [number, string]>

export interface BindingReconcileInput {
  now: number
  instance: BindingPlannerInstance
  lanCidr: string
  leases: readonly Lease[]
  rules: readonly IpRule[]
  wans: readonly BindingPlannerWan[]
  tableToWan: BindingTableToWan
  sticky: readonly BindingStickyChoice[]
  memory?: BindingPlannerMemory
  policy: BindingPlannerPolicy
  /**
   * The addresses a one-to-one binding has taken over, which this instance must
   * leave alone entirely. Passed in rather than read from the store, because
   * the planner is pure and because the reservation is a fact about the router
   * as a whole rather than about this instance.
   */
  reservedIps?: readonly string[]
  /**
   * The address window this instance is scoped to, absent for an instance that
   * serves its whole LAN. It decides one thing only: which leases enter the
   * pass. It is handed over as text rather than read off the record so the
   * planner keeps knowing nothing about records.
   */
  range?: { from: string; to: string }
  /** A local deterministic PRNG is seeded from this value. */
  randomSeed?: number
  rebooted?: boolean
}

/** One `ip rule` the router already carries, resolved back to a device. */
export interface WorkingActual extends BindingActualAssignment {
  source: IpRule
  key: string
  exactLease: boolean
}

export interface WorkingAssignment {
  mac: string | null
  ip: string
  wan: string
  table: number
  pref: number | null
  assignedAt: number
  previousWan?: string
  reason: 'actual' | 'sticky' | 'random' | 'remap' | 'forced' | 'orphan'
}

export interface CurrentLease {
  lease: Lease
  index: number
}

// ---------------------------------------------------------------------------
// Engine integration

export interface BindingSummaryInstance {
  id: string
  name: string
  lan: string
  carrier: string
  running: boolean
  wan: BindingWanSummary
  devices: BindingDeviceSummary
}

/**
 * The WAN pool of every instance added together, plus how much of it is spoken
 * for.
 *
 * Summed here rather than where it is drawn because a page spec cannot add
 * anything up: a `pie` reads its slices off one object and a `meter` reads one
 * value, so a wall of per-instance rows is not something either can render.
 * `boundPct` is a whole percent for the same reason - a spec cannot divide.
 */
export interface BindingWanAggregate extends BindingWanSummary {
  /** Bound WANs as a percentage of the pool, 0 when there is no pool at all. */
  boundPct: number
}

export interface BindingSnapshot {
  /**
   * When the rows below were last computed from a router sample the engine
   * could act on. A failed reconcile leaves it where it was: the rows describe
   * a router that has moved on, and stamping them with the time of the failure
   * made the staleness indicator report fresh data while devices shown as
   * bound had already lost their ip rules.
   */
  t: number
  /** False when the last reconcile failed; `lastError` then says what failed. */
  hookOk: boolean
  /** Empty while `hookOk`. Never carries router output; see `uci/batch.ts`. */
  lastError: string
  instances: BindingSummaryInstance[]
  /** Flattened renderer rows; kept small because there is one per automation instance. */
  rows: BindingListRow[]
  /** Every instance's pool as one set of counts, for the overview donut and meter. */
  wans: BindingWanAggregate
}

export interface BindingListRow extends BindingSummaryInstance {
  runningLabel: string
  /** The two editable flags, carried so the row's edit form can open on them. */
  sticky: boolean
  remap: boolean
  /** What this instance is doing, as chips: the counts that are not zero. */
  stateBadges: ValueBadge[]
  wanTotal: number
  wanAvailable: number
  wanBound: number
  wanError: number
  wanWarning: number
  wanDialing: number
  deviceTotal: number
  deviceBound: number
  deviceWaiting: number
}

export interface BindingEventRow {
  id: string
  when: string
  t: number
  kind: string
  text: string
}

export interface BindingJobRunner {
  start(spec: JobSpec): { id: string }
}

export type WanTableSource =
  | Readonly<Record<string, number>>
  | ReadonlyArray<readonly [string, number]>

export interface BindingEngineOptions {
  rules: () => OwrtRules
  jobs?: BindingJobRunner
  /**
   * The router-side capability verdict, read on every pass and never captured.
   *
   * When it says this router provides `binding`, `bm-wanbind` owns the ip rule
   * range and this engine must not plan or write a thing - it reads the rows
   * instead. An `apk del` lands between one readiness cycle and the next, so
   * asking per pass is what makes the changeover a tick rather than a restart.
   */
  agent?: () => AgentCapability
  /** Latest slow-tick UCI section -> table mapping. */
  wanTables?: () => WanTableSource
  /**
   * The addresses one-to-one bindings currently own, asked once per pass.
   *
   * A closure rather than a value for the same reason `agent` is one: a 1-1
   * binding can be created between two fast samples, and this engine has to
   * stop seating that address on the very next tick rather than at the next
   * restart. Absent means nothing is reserved, which is what every router
   * without the sibling automation looks like.
   */
  reservedIps?: () => readonly string[]
  /** FastSweep uses this to force a fresh interface dump after mutations. */
  requestDump?: () => void
  /**
   * Module-wide notice, recorded under the `router` scope. Per-instance binding
   * events go through the planner's own ring; this carries the ones that belong
   * to no instance, such as the routing-table ownership audit.
   */
  event?: (kind: string, text: string) => void
}

export interface InstanceCache {
  summary: BindingSummaryInstance
  assignments: BindingAssignmentRow[]
  waiting: BindingWaitingRow[]
}

export interface WanTableIndex {
  byWan: Map<string, number>
  byTable: Map<number, string>
  conflicts: Array<{ table: number; first: string; second: string }>
}

export interface UciDocument {
  values: Map<string, string>
  sectionTypes: Map<string, string>
  /** Retains repeated UCI list options; `values` deliberately keeps only the last. */
  entries: Array<[key: string, value: string]>
}

export interface RouterPreparationProbe {
  dhcp: UciDocument
  network: UciDocument
  firewall: UciDocument
  sysctl: Map<string, number>
}

export interface TablePreparation {
  wan: string
  table: number
}

export interface DhcpPreparation {
  section: string
  dnsmasqSection: string
  lanLimit: number
  globalLimit: number
}

export interface BindingCreatePlan {
  instance: BindingInstanceRecord
  lanCidr: string
  lanZone: string
  destinationZones: string[]
  tableAdds: TablePreparation[]
  dhcp?: DhcpPreparation
}

export interface ReconcileOutcome {
  instance: BindingInstanceRecord
  result: BindingPlannerResult
}

/**
 * What a command runner needs, and nothing more, so a sibling automation with
 * its own runtime can use the same writers.
 *
 * `BindingRuntime` satisfies this structurally, which is the whole point: the
 * writers below it stayed exactly as they were for every call site in this
 * folder while becoming callable from a runtime of a different shape.
 */
export interface ExecDeps {
  ctx: ModuleContext
  /** Read again after every await, so it has to be the live object, not a copy. */
  disposed: boolean
  options: { rules: () => OwrtRules }
}

/**
 * Everything the engine mutates between passes, in one object the free
 * functions in this folder take as their first argument. `BindingEngine` owns
 * exactly one of these and does nothing else.
 */
export interface BindingRuntime {
  ctx: ModuleContext
  store: HostStore
  options: BindingEngineOptions
  checkSession: CheckSession<BindingCreatePlan>
  latestModel: RouterModel | null
  lastUptime: number | null
  memory: Map<string, BindingPlannerMemory>
  cache: Map<string, InstanceCache>
  latestPayload: BindingSnapshot
  serial: Promise<void>
  workGeneration: number
  disposed: boolean
  manualWanTables: WanTableSource | undefined
  preparations: Map<string, BindingCreatePlan>
  lastTableAuditWarning: string
  lastTableRepairNotice: string
  /**
   * Writes already spent on `lastTableRepairNotice`. The audit latches on this
   * rather than on having said something, so a router that keeps losing the
   * same `option ip4table` gets a bounded number of `uci set` + `commit` +
   * `network reload` rounds instead of one on every slow tick, forever.
   */
  tableRepairAttempts: number
}
