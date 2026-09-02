/**
 * The vocabulary of the binding monitor: what one rule on the router turns
 * into, and what the `monitor` stream carries.
 *
 * Everything below is plain JSON on purpose. A row travels through `ctx.emit`
 * to a renderer that has no imports, so a `Map` or a class instance here would
 * arrive on the other side as `{}` and the detail panel would render an empty
 * table with nothing anywhere saying why.
 *
 * There is no readout, no rule line and no classifier here any more. From
 * packages 2.4.0 the daemon owns the sections, the bands and every rule, so it
 * is the only half that can say who wrote one and be right - and a second
 * classifier on this side would be two halves able to reach different verdicts
 * about the same rule, which is the failure this release exists to end. This
 * file is now the shape of a reply after it has been turned into rows, and
 * nothing else.
 */
import type { ValueBadge } from '@shared/module-ui'
import type { ModuleContext } from '@shared/modules'
import type { WanbindRulesReply } from '../agent'
import type { AgentCapability, OpenWrtCapabilities } from '../probe'

/**
 * Who put a rule on the router, in the daemon's own spelling.
 *
 * Read off the reply rather than restated, and that is deliberate: a union
 * hand-copied from the contract still compiles the day the daemon learns a
 * seventh owner, and every rule carrying the new one would silently land in
 * whichever branch this side happens to fall through to. Spelled the daemon's
 * way - `catch-all`, not `catchAll` - for the same reason the reply's own field
 * names are: one spelling for one thing, so nothing has to be translated on the
 * way past.
 */
export type ScanOwnerKind = WanbindRulesReply['rules'][number]['owner']

/**
 * What each verdict is called in front of a user.
 *
 * `netifd` gets a phrase rather than the daemon's word because the word is
 * jargon and the fact is not: every interface carrying `option ip4table` gets
 * three rules from netifd without anybody asking, so a router dialling
 * thirty-two PPPoE sessions carries ninety-six of them. They are the most
 * numerous rows on any multi-WAN router, and a column calling them a stranger's
 * work would bury the handful actually worth looking at under a page of alarm
 * about the router doing its job.
 *
 * `hold` is worded as a variant of `foreign` because that is what the daemon
 * means by it: nothing on the router claims the rule, and the table it names is
 * one this daemon parks addresses in - so whatever wrote it has parked that
 * traffic rather than routed it.
 */
export const OWNER_LABEL: Readonly<Record<ScanOwnerKind, string>> = {
  manual: 'one-to-one binding',
  client: 'binding instance',
  'catch-all': 'safety catch-all',
  hold: 'outside this module, parked',
  netifd: 'the router routing itself',
  kernel: 'kernel baseline',
  foreign: 'outside this module'
}

/** The rules this module's own feature is responsible for. */
export const MANAGED_OWNERS: ReadonlySet<ScanOwnerKind> = new Set<ScanOwnerKind>([
  'manual',
  'client',
  'catch-all'
])

/**
 * The rules the router writes for itself, which belong to neither side.
 *
 * `netifd` is in here rather than in the foreign count, and that is the whole
 * point of the set existing. Those rules are the router routing itself - the
 * plumbing that makes `option ip4table` work at all - so counting them as
 * "written outside this module" would put ninety-six on the tile whose entire
 * job is to say how many rules somebody should go and look at. `kernel` is here
 * for the same reason and never reaches a row at all; see `ScanSummary.total`.
 */
export const ROUTER_OWNERS: ReadonlySet<ScanOwnerKind> = new Set<ScanOwnerKind>([
  'netifd',
  'kernel'
])

export interface ScanRow {
  key: string
  /** The source address, or the selector text when the rule has no source. */
  ip: string
  /** False when `ip` describes a selector rather than naming an address. */
  sourceRouted: boolean
  pref: number
  /**
   * The table the rule looks up, as the number the kernel holds. 0 is a rule
   * that looks nothing up: it answers the packet itself, which is a different
   * fact from a rule pointing at a table nobody can read.
   */
  table: number
  /** `main (254)`, `42`, `no table` - the number with its well-known name. */
  tableLabel: string
  /** The WAN interface the table's default route actually leaves through. */
  wan: string
  /**
   * The gateway that default route leaves via, not the interface's own address.
   *
   * The daemon reports a table by what its default route says - a device and a
   * next hop - and nothing in the rules reply carries the WAN's own IPv4. The
   * next hop is the evidence that exists, and it answers the question the row is
   * really asked ("where does this actually go"), so it travels under the key
   * the page already binds. The label beside it on the Monitor page still reads
   * "That WAN's address" and wants changing to say gateway.
   */
  wanIp: string
  ownerKind: ScanOwnerKind
  owner: string
  ownerBadges: ValueBadge[]
  /**
   * The daemon's own sentence about this rule, passed through untouched.
   *
   * This is the whole feature. Anybody can list `ip rule show`; what somebody
   * standing in front of a router needs is a sentence saying why *this* address
   * is not on the default connection, built from the sections and the route
   * dumps by the half that holds both.
   */
  reason: string
  /** The rule as `ip -4 rule show` would have printed it. */
  rule: string
  /** What the daemon says about the table this rule points at. */
  routes: string[]
  /**
   * The same lines as one block of text.
   *
   * A `keyValue` row prints whatever it is given through `String()`, so the
   * array arrived as a comma-run with no spaces and an empty one arrived as
   * nothing at all - on the one panel whose entire job is to show the evidence.
   * A spec cannot join or default a list, so it is done here.
   */
  routesText: string
  /** The main table's default, so a reader has something to compare against. */
  mainDefault: string
  /**
   * The table this rule points at offers no way out.
   *
   * Both false on the daemon's table row: it has no default route at all. A
   * table answering `unreachable` is not this - that one is an address parked on
   * purpose, and calling it a fault sends somebody to fix the thing that is
   * working.
   */
  unreachable: boolean
  /**
   * This rule is consulted before every rule the daemon writes, *and* it could
   * take traffic from one of them.
   *
   * Both halves, because the badge this flag raises is an accusation: a low
   * preference on a router where the daemon has written no rule at all outranks
   * nothing, and neither does one whose selector cannot cover a single address
   * the daemon has placed. Flagged on the preference alone it put a red chip on
   * rules that were doing nothing to anybody.
   */
  outranksModule: boolean
}

export interface ScanSummary {
  /**
   * Policy rules seen. The kernel's own `local`/`main`/`default` baseline is
   * not among them: those three are on every Linux box that ever booted, they
   * steer nothing away from the default connection, and counting them here
   * would bury the one rule somebody actually needs to find.
   */
  total: number
  byOwner: Record<string, number>
  /**
   * Rules nothing on this router claims. The daemon's own three owners are not
   * in it, and neither is netifd: those are the router routing itself, and the
   * tile this feeds is the one that says how many rules somebody should go and
   * look at. `byOwner` still keeps every owner apart, because "the router wrote
   * it", "something else parked this address" and "nobody knows who owns it"
   * call for different things from the person reading the page.
   */
  foreign: number
  /** Rules pointing at a table with no way out. */
  unreachable: number
  /** Rules that select on something other than a source address. */
  selectors: number
  /**
   * `total` counts the rules the reply carried, not the rules on the router.
   * It rides in the summary rather than staying in the reply because the
   * summary is what the page states as fact - "Rules seen: 2000" beside a table
   * that was cut at 2000 is a sentence nobody would question, and the rules it
   * hides are the high-preference ones the daemon writes itself.
   */
  rulesTruncated: boolean
  /**
   * The cap that did the cutting, as the daemon echoed it back.
   *
   * Its number, not this side's: the ceiling on one ubus reply is the daemon's
   * to move, and a constant here would be a second answer that goes wrong
   * silently the day the two releases differ.
   */
  cap: number
}

export interface ScanSnapshot {
  /**
   * When the rows were last built from a pass the module could act on. A failed
   * sweep leaves it where it was: rows stamped with the time of a failure
   * report fresh data about a router the module has in fact lost sight of.
   */
  t: number
  /** False when the last sweep failed; `lastError` then says what failed. */
  ok: boolean
  /** Empty while `ok`. Never carries router output. */
  lastError: string
  rows: ScanRow[]
  summary: ScanSummary
}

/**
 * The one setting the monitor has of its own.
 *
 * Narrowed to the field it reads rather than taking the whole rules record,
 * because everything else in that record is about writing to a router this
 * folder never writes to - and a monitor that could see the binding settings is
 * a monitor somebody will eventually make decisions with.
 */
export interface ScanRules {
  scanIntervalSec: number
}

export interface ScanEngineOptions {
  ctx: ModuleContext
  rules: () => ScanRules
  /**
   * The router-side agent verdict, read per pass and never captured: an `apk
   * del` on the router lands between two readiness cycles, and a call built on
   * a verdict that was true a moment ago fails as a shell error rather than as
   * a sentence somebody can act on.
   */
  agent: () => AgentCapability
  /** The readiness latch, which decides whether the poller runs at all. */
  capabilities: () => OpenWrtCapabilities
}
