/**
 * The vocabulary of Binding 1-1: what the pure pass is asked, what it answers,
 * and the shapes the engine keeps between passes.
 *
 * Type declarations only, so every other file in this folder can name a
 * structure without pulling in the code that builds it - the same arrangement
 * the instance half next door uses, and for the same reason: `check.ts` and
 * `view.ts` both describe a row, and only one of them may own it.
 */
import type { CheckSession } from '@shared/check'
import type { ValueBadge } from '@shared/module-ui'
import type { ModuleContext } from '@shared/modules'
import type { WanbindBand } from '../agent'
import type {
  BindingJobRunner,
  BindingPlannerWan,
  BindingRuleDiff,
  TablePreparation,
  WanTableSource
} from '../binding'
import type { OwrtRules } from '../config'
import type { AgentCapability } from '../probe'
import type { DirectBindingRecord, HostStore } from '../store'
import type { IfaceState, IpRule, Lease, RouterModel } from '../types'

/**
 * What one binding is doing right now, in the seven words a row may say.
 *
 * `held` and `fallback` are the two halves of `whenDown` seen from the other
 * side, and they are deliberately different words: held means the address is
 * parked on the unreachable table and has no way out, while fallback means the
 * rule points at the main table and the address is on the router's default
 * connection. Reading one as the other is the mistake the whole feature exists
 * to prevent.
 *
 * `stranded` is neither, and it is not a WAN fault at all: the device has taken
 * a lease outside the LAN this binding was stamped with - a guest SSID, a
 * second VLAN - and the scoped firewall forwarding was written once, from that
 * LAN's zone, and is never rewritten. The rule would still policy-route it into
 * the bound WAN's table while fw4 has no forwarding from the zone it is now in,
 * so the traffic is dropped. It gets its own word because a row that said
 * "bound" through that was the whole of the fault: nothing anywhere admitted
 * the device had moved.
 *
 * `shadowed` is the one word that is about another binding rather than about
 * the network. The create gate refuses an address some other binding already
 * claims, but a MAC target created while its device is offline has no address
 * to compare at that moment, so a lease taken later can land on one an IP
 * binding already holds. Two records then both believe they steer it and only
 * one can, because the two rules sit at different preferences and the lower one
 * wins outright. The higher-preference record is marked `shadowed`, writes no
 * rule of its own, and says which binding holds the address instead - two rows
 * both reporting "bound" for one address being the whole of that fault.
 *
 * `refused` is the only one of the eight this module cannot reach on its own.
 * It belongs to a binding the ROUTER holds, in a `config direct` section the
 * daemon's own configuration reader will not accept - a priority that collides
 * with an instance's range, a WAN that is not an interface name. Such a section
 * installs no rule and is invisible everywhere else, so a table that quietly
 * dropped it would be a binding the operator created, cannot see and cannot
 * delete. The row carries the daemon's own sentence in `reason`.
 */
export type DirectState =
  | 'bound'
  | 'held'
  | 'fallback'
  | 'stranded'
  | 'shadowed'
  | 'waiting'
  | 'disabled'
  | 'refused'

/**
 * The settings the pure pass reads, copied rather than passed as `OwrtRules`.
 *
 * Only these five decide anything here, and naming them one by one is what
 * keeps a test's fixture honest: a planner handed the whole rules document
 * could quietly start reading a sixth without a single call site changing.
 */
export interface DirectPolicy {
  directPrefBase: number
  /** The blackhole table a held binding is re-pointed at. */
  catchAllTable: number
  ruleChunkLines: number
  /** How long a MAC target keeps its rule at the last address it was seen at. */
  releaseGraceSec: number
  wanWarnUptimeSec: number
}

/**
 * What the engine remembers about one binding between passes, and nothing that
 * belongs on disk.
 *
 * The last address a MAC target answered to is RAM on purpose. It is a fact
 * about the network at this instant rather than about the binding, so a module
 * that restarts should go and look again instead of writing a rule for an
 * address a device left hours ago.
 */
export interface DirectMemoryEntry {
  id: string
  /** Last address this binding resolved to; empty once the grace has expired. */
  ip: string
  /** When that lease first went missing, or 0 while it is present. */
  missingSince: number
  state: DirectState
  /** App-clock time the state above began, for the row's duration. */
  since: number
  /**
   * The name of the binding holding this address, on a `shadowed` entry only.
   *
   * Remembered rather than recomputed where the row is built, because the plain
   * read between passes has one record at a time and no way to look the holder
   * up - and a chip that said only "not in force" would leave the reader
   * hunting through the table for the binding that is.
   */
  shadowedBy?: string
}

export interface DirectDesiredRule {
  id: string
  pref: number
  ip: string
  table: number
  /**
   * `hold` points at the blackhole table rather than at the WAN's own, and
   * `fallback` at the main table. Fallback is a rule rather than the absence of
   * one because "no rule falls through to main" is only true on a router where
   * nothing else matches the address: a binding instance's catch-all does, and
   * it sends it to the unreachable table instead.
   */
  mode: 'wan' | 'hold' | 'fallback'
}

export interface DirectPlannerEvent {
  t: number
  kind: string
  text: string
}

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
  state: DirectState
  stateBadges: ValueBadge[]
  /** App-clock time this state began; the renderer's `duration` counts from it. */
  since: number
  sinceLabel: string
  /** The rule this binding should hold on the router, or empty when it holds none. */
  rule: string
  /**
   * Why this binding is in the state it is in, in one sentence, when something
   * said one.
   *
   * Only the router-owned half fills it, and only because that half has an
   * author for it: the daemon decided the state and wrote the sentence, and
   * re-deriving a second one on this side is how two surfaces come to describe
   * one binding differently. On the SSH half the chips are the whole account
   * and this stays empty, which is not a gap - the reason there is the state
   * name and this module is the thing that chose it.
   *
   * Prose, for a person. Nothing branches on it; `state` and `enabled` are what
   * a surface reads.
   */
  reason: string
  /**
   * Whether the router keeps this binding rather than this module. Set on every
   * row of a router-owned answer, absent on the SSH half.
   *
   * The page needs it for one reason: on a router that owns bindings, the
   * fields this module used to be free to change are the router's, and a form
   * that offered them anyway would be collecting an edit nothing carries out.
   */
  routerOwned?: boolean
}

export interface DirectTotals {
  /** Bindings whose rule points at the WAN they name. */
  ok: number
  /**
   * Bindings whose rule points at the blackhole and which therefore have no way
   * out at all: `held`, because the WAN they name is unusable, and `stranded`
   * with `whenDown: hold`, because the device left the LAN its forwarding was
   * written from and its owner chose to park it. Both are the same detention
   * and the tile counts both; counting only the first hid the roaming device,
   * which is the case nothing else on the page reports either.
   */
  held: number
}

export interface DirectPlannerResult {
  desired: DirectDesiredRule[]
  diff: BindingRuleDiff
  /**
   * The blackhole route to (re)establish, written before any rule is pointed
   * at it. Empty when this pass holds nothing.
   */
  routeLines: string[]
  memory: DirectMemoryEntry[]
  events: DirectPlannerEvent[]
  rows: DirectRow[]
  totals: DirectTotals
}

export interface DirectReconcileInput {
  now: number
  records: readonly DirectBindingRecord[]
  leases: readonly Lease[]
  /** The router's whole rule table; only the direct band is read back from it. */
  rules: readonly IpRule[]
  wans: readonly BindingPlannerWan[]
  /**
   * The subnet each stamped LAN carries on this tick, by interface name, so the
   * pass can tell an address that has left the LAN its firewall forwarding was
   * written from. A LAN missing from the map is read as "not sampled this tick"
   * rather than as "the device has moved", the way every other absent sample in
   * this module is read: one interface dump that came back short must not
   * strand every binding on the router.
   */
  lanCidrs?: ReadonlyMap<string, string>
  memory?: readonly DirectMemoryEntry[]
  policy: DirectPolicy
}

export interface DirectSnapshot {
  /**
   * When these rows were last computed from a pass that reached the router. A
   * failed pass leaves it where it was, for the reason `BindingSnapshot`
   * documents: rows stamped with the time of a failure report fresh data about
   * a router that has moved on.
   */
  t: number
  hookOk: boolean
  /** Empty while `hookOk`. Never carries router output. */
  lastError: string
  rows: DirectRow[]
  totals: DirectTotals & { total: number }
  /**
   * Whether these rows came from the router's own binding list rather than from
   * this module's records.
   *
   * Published rather than inferred from the rows, because an empty table means
   * two different things on the two halves and only this can tell them apart:
   * no bindings created here, or no bindings on a router that is the one
   * keeping them.
   */
  routerOwned: boolean
  /**
   * Something the operator has to be told that is not a failed pass.
   *
   * The whole reason it is separate from `lastError`: a handover still in
   * progress, or a binding the router refused, is not a pass that did not work
   * - the pass worked and reported exactly this. Folding it into `lastError`
   * would make the page's own error panel claim the router is unreachable when
   * it is answering perfectly and disagreeing.
   */
  notice?: string
}

/**
 * Which side of the router one interface faces, as its configuration states it.
 *
 * `unclear` is an answer rather than a failure. A router can be wired so that
 * nothing in /etc/config settles which side an interface is on, and the gate
 * reading this has to be able to say so - guessing is precisely what produced
 * the fault this vocabulary exists to end.
 */
export type IfaceRole = 'lan' | 'uplink' | 'unclear'

/**
 * One interface weighed up, carrying the sentences that say why.
 *
 * The evidence is text because every reader of it is a check finding: a verdict
 * whose reasoning a person cannot see is exactly as unactionable as the bare
 * refusal that started this.
 */
export interface IfaceVerdict {
  name: string
  role: IfaceRole
  /** The IPv4 subnet it carries on this sample, or '' when it carries none. */
  cidr: string
  /** The firewall zone it belongs to, or '' when it is in none. */
  zone: string
  zoneMasquerades: boolean
  /** Clauses, each of which reads after "because"; empty when nothing was said. */
  lanEvidence: string[]
  uplinkEvidence: string[]
}

/**
 * Every interface in one sample, weighed against one reading of /etc/config.
 *
 * `stated` is false when the configuration could not be read at all, which is
 * the difference between "the router says nothing about this interface" and
 * "nobody asked the router" - two situations a finding has to word differently,
 * because only one of them is something the operator can go and fix.
 */
export interface RouterLayout {
  byName: ReadonlyMap<string, IfaceVerdict>
  stated: boolean
}

/**
 * The interfaces an address could be behind, split by how firmly the router's
 * configuration places them.
 *
 * `unclear` is kept apart from `lans` rather than folded into it so the search
 * can prefer a stated LAN and then admit, in a finding, when it had to fall
 * back to one that is merely not denied. `uplinks` is kept at all so a refusal
 * can name the subnets it deliberately did not search - the previous refusal
 * named nothing, which is why nobody could tell it was wrong.
 */
export interface LanSearch {
  lans: IfaceState[]
  unclear: IfaceState[]
  uplinks: IfaceState[]
}

/** What the check resolved and the apply job must not resolve again. */
export interface DirectPlan {
  record: DirectBindingRecord
  /** The LAN subnet the address was found in, as the check saw it. */
  lanCidr: string
  lanZone: string
  destinationZones: string[]
  /** Present only when the WAN section still needs `option ip4table`. */
  tableAdd?: TablePreparation
  /**
   * Whether the router is the one that will hold this binding.
   *
   * Set by the check and read by the apply, rather than asked again there, for
   * the reason every other decision travels in this object: the gate that
   * approved these values approved them for one of the two halves, and a
   * package installed in the seconds between must not turn a plan checked
   * against the module's own band into a call to a daemon - or the other way
   * round, which would write a rule at a priority the daemon has since claimed.
   * The job revalidates it and refuses if the verdict has moved.
   */
  routerOwned?: boolean
}

export interface DirectEngineOptions {
  ctx: ModuleContext
  store: HostStore
  rules: () => OwrtRules
  jobs?: BindingJobRunner
  /**
   * The router-side capability verdict, read per call and never captured. It
   * changes nothing about what this engine writes - the two preference bands
   * are disjoint by construction - but it changes what the create gate has to
   * warn about, because `bm-wanbind` has no reserved-address list.
   */
  agent?: () => AgentCapability
  /** Latest slow-tick UCI section -> table mapping. */
  wanTables?: () => WanTableSource
  /** The sample the fast sweep last produced; null before the first one. */
  latestModel: () => RouterModel | null
  requestDump?: () => void
  /** Module-scope event trail, for the notices that belong to no instance. */
  event?: (kind: string, text: string) => void
}

/**
 * Everything the engine mutates between passes, in one object the free
 * functions in this folder take as their first argument.
 *
 * It satisfies `ExecDeps` structurally, which is what lets the writers the
 * binding barrel publishes take it: `ctx`, a live `disposed` and an `options`
 * carrying `rules()` are the whole of that contract.
 */
export interface DirectRuntime {
  ctx: ModuleContext
  store: HostStore
  options: DirectEngineOptions
  checkSession: CheckSession<DirectPlan>
  latestPayload: DirectSnapshot
  memory: Map<string, DirectMemoryEntry>
  /** Ids with an apply job in flight, so two creates cannot claim one number. */
  preparations: Map<string, DirectPlan>
  /**
   * The rows the router last reported, or null on a router this module binds
   * itself.
   *
   * It stands where `memory` stands on the other half: the cache every read
   * between passes is answered from. Null rather than an empty array, and the
   * difference is the whole of the changeover - an empty array is a router that
   * owns bindings and has none, while null is a router where the records are
   * still the truth.
   */
  routerRows: DirectRow[] | null
  /**
   * Whether the last tick found that the router keeps the bindings.
   *
   * Kept apart from `routerRows` because the two answer different questions and
   * the first tick after a changeover is where that shows: the router owns them
   * and has not answered yet, so the rows are still the records while the
   * statement the page must make about them is already the router's.
   */
  routerOwned: boolean
  /**
   * The daemon's own priority band, as of the last router-owned pass. Null
   * before one. The create gate refuses outright while it is unusable, because
   * the daemon will not allocate a preference from it.
   */
  routerBand: WanbindBand | null
  /**
   * What the changeover still has left to do, in the sentence the page shows.
   * Empty when there is nothing outstanding, which is every router that never
   * had a module-written binding on it.
   */
  handoverNotice: string
  serial: Promise<void>
  workGeneration: number
  disposed: boolean
}
