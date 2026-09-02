/**
 * The vocabulary of this domain: the narrow slices it needs from the rest of
 * the module, and the shapes every surface renders.
 *
 * WAN Binding of record lives on the router. `bm-wanbind` owns the instances,
 * the one-to-one bindings, the routing tables, the firewall paths, the
 * fail-closed catch-all and every ip rule, and it answers for all of it over
 * ubus. What stays on this side is a cache of the daemon's answers, the
 * check-token sessions, and the rows the page specs bind to. Nothing here
 * describes UCI or a priority: this half writes neither.
 *
 * Until 3.4.0 both halves wrote the one-to-one band. The daemon removes every
 * rule in it no section asks for, and this module wrote rules there without
 * ever writing a section - so on a real router that was 34 rules deleted every
 * thirty seconds and written back a second later, for ever, with every surface
 * green because each half was doing exactly what it had been told. That is why
 * there is no record of an instance or a binding anywhere in this folder for
 * the router's to disagree with, and why the shapes below that are really the
 * daemon's are the daemon's own types, unaltered.
 */
import type { CheckSession } from '@shared/check'
import type { ValueBadge } from '@shared/module-ui'
import type { ModuleContext } from '@shared/modules'
import type {
  WanbindAssignment,
  WanbindBindSpec,
  WanbindBindingState,
  WanbindBindingsReply,
  WanbindInfo,
  WanbindInstanceSpec,
  WanbindSettings,
  WanbindWaiting
} from '../agent'
import type { JobSpec, OpenWrtJob } from '../jobs'
import type { AgentCapability } from '../probe'
import type { HostStore } from '../store'
import type { RouterModel } from '../types'

/**
 * Only the rules consumed here; ConfigStore.effectiveRules() returns more.
 *
 * One field, and its shortness is the point. Every priority band, grace and
 * pass interval this folder used to read is the daemon's own settings section
 * now, edited through `settings_set` and answered for by `info`. A number kept
 * on both sides is a number the two halves can quietly come to disagree about,
 * and the rules standing in the kernel were written against exactly one of
 * them. This one decides nothing about the router: it is how long a job waits
 * on a shell that has stopped answering.
 */
export interface BindingRules {
  execTimeoutSec: number
}

/** The part of ConfigStore used by this folder. */
export interface BindingConfigStore {
  effectiveRules(): BindingRules
}

/** The part of the job runner used here: one small job per mutation. */
export interface BindingJobs {
  start(spec: JobSpec): OpenWrtJob
}

/**
 * Adapter over the module's shared services.
 *
 * `forceDump` pokes the fast sweep so the next sample reflects what a mutation
 * just changed. `latestModel` is that sample, and it is here because the daemon
 * answers for its own rules rather than for the router: a WAN's live address,
 * and the lease behind a MAC nothing has seated yet, are read off the sweep.
 * `event` writes the module-wide half of the event trail; the per-instance ring
 * is written straight to the store, which is the only thing the store is for.
 */
export interface BindingService {
  forceDump(): void
  latestModel(): RouterModel | null
  event?(kind: string, text: string): void
}

/** The capability verdict, read per operation and never captured. */
export type BindingAgentReader = () => AgentCapability

// ----------------------------------------------------------------- row shapes

/** One instance's WAN pool, counted the way the tiles and the donut read it. */
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

/**
 * Every instance's pool added together, plus how much of it is spoken for.
 *
 * Summed here rather than where it is drawn because a page spec cannot add
 * anything up: a `pie` reads its slices off one object and a `meter` reads one
 * value. `boundPct` is a whole percent for the same reason - a spec cannot
 * divide either.
 */
export interface BindingWanAggregate extends BindingWanSummary {
  /** Bound WANs as a percentage of the pool, 0 when there is no pool at all. */
  boundPct: number
}

/**
 * One instance as the Instances table renders it.
 *
 * The nested `wan` and `devices` objects and the flat `wanTotal`-style copies
 * of them are both here on purpose: the table's columns read the flat keys and
 * the row drawer's two keyValue blocks read `$row.wan` and `$row.devices`, and
 * a spec can neither reach into an object for a column nor spread one for a
 * block.
 */
export interface BindingListRow {
  id: string
  name: string
  lan: string
  carrier: string
  /** Enabled, and the daemon has a pass behind it. Not "the section exists". */
  running: boolean
  runningLabel: string
  /** The two editable flags, carried so the row's edit form can open on them. */
  sticky: boolean
  remap: boolean
  /**
   * Which addresses this instance serves: `whole LAN`, or the window it was
   * stamped with, as `192.168.1.100 - 192.168.1.199`.
   *
   * A row for an instance no pass has reached yet still has to say what it
   * covers, so it is built from the section rather than from the last pass.
   */
  scope: string
  /** 1 = a WAN each, N = that many share one, 0 = no limit. */
  clientsPerWan: number
  /**
   * That number as a sentence, because none of its three readings are obvious
   * from the digit alone - and 0 read as "none" rather than as "no limit" is
   * the reading that would make a working instance look broken.
   */
  capacityLabel: string
  /**
   * The daemon's own sentence about this instance, when it said one.
   *
   * Prose for a person; nothing branches on it. It is the only account a
   * refused section has - such an instance installs no rule, seats nobody and
   * appears in no other table, so a row showing nothing but zeroes would be an
   * instance the operator created, cannot explain and cannot fix.
   */
  reason: string
  /** What this instance is doing, as chips: the counts that are not zero. */
  stateBadges: ValueBadge[]
  wan: BindingWanSummary
  devices: BindingDeviceSummary
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

/** One seated client, as both Assignments tables render it. */
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
  /** App-clock ms this device was put on this WAN; `duration` counts from it. */
  assignedAt: number
  sinceLabel: string
}

/** One client that is not seated, and its place in the queue. */
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

/**
 * One binding as the One-to-one bindings table renders it.
 *
 * `state` is the daemon's own union rather than a word chosen here, its empty
 * value included: empty means no pass has reached the section yet, which is a
 * real state on one written a moment ago and not a failure. Deriving a second
 * vocabulary on this side is how two surfaces come to describe one binding
 * differently.
 */
export interface DirectRow {
  id: string
  name: string
  /** `ip` or `mac`; the two are never mixed after creation. */
  targetKind: string
  /** The target as it was typed - an address or a MAC. */
  target: string
  /** The address the rule is written for now; empty while a MAC is unresolved. */
  address: string
  wan: string
  table: number
  pref: number
  /**
   * The stored choice, `hold` or `fallback`. It stays the stored word because
   * the row's own `When that WAN is down` select opens on it, and a select
   * whose initial value is one of its labels matches no option at all.
   */
  whenDown: string
  /** That choice as the two selects word it; this is what the column renders. */
  whenDownLabel: string
  enabled: boolean
  /**
   * Whether the router has a firewall path for this binding, in the daemon's
   * own words: `ok`, `missing`, `wrong`, `no-lan`, `no-zone`, or empty when it
   * said nothing.
   *
   * Carried because dropping it hid the one failure this release exists to
   * abolish. A rule is written over netlink and needs no firewall at all, so a
   * binding on a router with no zones gets its rule, comes back `bound`, and
   * carries traffic nowhere: the daemon only prepares a forwarding for
   * `missing` and `wrong`, and answers `no-zone` by declining to try. The row
   * used to render that as plain green with an empty Why column.
   */
  forwarding: WanbindBindingsReply['bindings'][number]['forwarding']
  state: WanbindBindingState
  stateBadges: ValueBadge[]
  /** App-clock ms this state began; the renderer's `duration` counts from it. */
  since: number
  sinceLabel: string
  /** The rule the router holds for this binding, or empty when it holds none. */
  rule: string
  /**
   * Who placed it: `manual` for a section somebody wrote, an instance id for a
   * seat that instance handed out.
   *
   * The daemon's own field, kept rather than worked out from the priority the
   * rule sits at. A surface that inferred ownership from a band would mislabel
   * every binding the moment either band moved.
   */
  source: string
  /**
   * False when the kernel is not holding the rule this row describes.
   *
   * Reported apart from `state` because the two really are different questions:
   * a binding can be perfectly configured, accepted by the daemon and still
   * have no rule standing, and a row that said `bound` through that is the most
   * misleading thing this table could say.
   */
  verified: boolean
  /** The daemon's sentence about this binding. Prose; nothing branches on it. */
  reason: string
}

// ------------------------------------------------------------------ snapshots

/**
 * The `binding` stream payload: the instance half at a glance.
 *
 * `t` is when these rows last came from a call that reached the router. A
 * failed call leaves it where it was, because stamping them with the time of
 * the failure makes the staleness indicator report fresh data about a router
 * that has moved on.
 */
export interface BindingSnapshot {
  t: number
  /** False when the last call failed; `lastError` then says what failed. */
  hookOk: boolean
  /** Empty while `hookOk`. Never carries router output. */
  lastError: string
  rows: BindingListRow[]
  /** Every instance's pool as one set of counts, for the donut and the meter. */
  wans: BindingWanAggregate
  /**
   * Whether this router keeps its own WAN Binding at all, and the sentence for
   * when it does not.
   *
   * Published rather than left to each surface, because an empty table means
   * two entirely different things and nothing else in this payload tells them
   * apart: a router with no instances, or a router with no daemon to have any.
   * The sentence is `bindingDaemonProblem`'s own, never a second wording of it.
   */
  daemon: { ready: boolean; problem: string }
  /**
   * Something the operator has to be told that is not a failed call.
   *
   * Kept apart from `lastError` because the two read differently: a refused
   * section, or a pass that ran and found nothing it could do, is not the
   * router being unreachable - and folding it into `lastError` would have the
   * page's error panel report silence from a router that is answering
   * perfectly and disagreeing.
   */
  notice?: string
}

export interface DirectTotals {
  total: number
  /** Bindings whose rule points at the WAN they name. */
  ok: number
  /**
   * Bindings parked with no way out: held, because the WAN they name is
   * unusable, and every other state whose rule points at the blackhole. Both
   * are the same detention, and counting only the first hid the roaming device
   * - the case nothing else on the page reports either.
   */
  held: number
}

/** The `direct` stream payload: the one-to-one half at a glance. */
export interface DirectSnapshot {
  t: number
  hookOk: boolean
  lastError: string
  rows: DirectRow[]
  totals: DirectTotals
  /** As on `BindingSnapshot`: a fact to state, not a call that did not work. */
  notice?: string
}

// ----------------------------------------------------------------- the state

/**
 * Everything one tick reads off the router, and everything every surface
 * renders from.
 *
 * A failed call keeps the slice already here and sets `stale` rather than
 * emptying it. Rows that are one tick old are worth far more than an empty
 * table: the table is what somebody is looking at to work out why the router
 * has gone quiet, and blanking it answers that with "there is nothing on this
 * router" - the one thing this module must never say by accident. `stale` and
 * `error` are what the page shows instead.
 */
/**
 * One line of an instance's own history.
 *
 * The ring these come from is the one thing about binding this module still
 * keeps for itself. The daemon reconciles; it does not remember, so nothing on
 * the router can answer what happened to an instance while nobody was looking.
 */
export interface BindingEventRow {
  id: string
  when: string
  t: number
  kind: string
  text: string
}

export interface BindingCache {
  info: WanbindInfo | null
  assignments: WanbindAssignment[]
  waiting: WanbindWaiting[]
  /** The whole reply: `filtered`, the counts, the band and the instance bands. */
  bindings: WanbindBindingsReply | null
  /** App-clock ms of the last successful fetch; 0 before the first. */
  fetchedAt: number
  /** The last fetch failed, so everything above is the previous answer. */
  stale: boolean
  /** Why, in a sentence, when `stale` is true. */
  error: string
}

/**
 * The mutable state the free functions in this folder take as their first
 * argument.
 *
 * The cache is the whole trick of this domain, exactly as it is next door in
 * `pppoe/`: every surface reads it synchronously, and one fetch per fast tick
 * refreshes it over the connection the module already has.
 */
export interface BindingRuntime {
  ctx: ModuleContext
  config: BindingConfigStore
  jobs: BindingJobs
  service: BindingService
  agent?: BindingAgentReader
  /**
   * The per-router document, held for the per-instance event ring and nothing
   * else. There is no record of an instance or a binding in it any more - the
   * router keeps those - so a write here is only ever a line of history.
   */
  store: HostStore
  /**
   * Three sessions rather than one, the way `pppoe/` holds its pair: a token
   * issued for an instance is not a token for a binding, and neither is a token
   * for the daemon's settings. One shared session would let a check on one form
   * be spent by an apply on another, which is the single thing the token
   * protocol exists to make impossible.
   */
  instanceSession: CheckSession<WanbindInstanceSpec>
  bindSession: CheckSession<WanbindBindSpec>
  settingsSession: CheckSession<Partial<WanbindSettings>>
  cache: BindingCache
  /** The in-flight refresh, so two ticks never race two fetches. */
  fetching: Promise<void> | null
  /**
   * Instance and binding ids with a job running. A second mutation on one of
   * them is refused rather than queued: both are create-and-edit calls against
   * one section, and the loser would silently undo the winner.
   */
  busy: Set<string>
  latestBinding: BindingSnapshot
  latestDirect: DirectSnapshot
  /**
   * Bumped by a reset or a dispose, so work already in flight lands nowhere.
   *
   * A mutation takes seconds against the router and the machine can be switched
   * or the module reset inside that window; a callback that wrote its result
   * into the cache afterwards would be describing a router nobody is looking at
   * any more.
   */
  generation: number
}
