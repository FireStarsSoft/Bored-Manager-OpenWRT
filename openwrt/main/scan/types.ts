/**
 * The vocabulary of the binding monitor: what one round trip read back, what
 * one policy rule turns into, and what the `monitor` stream carries.
 *
 * Everything below the parse is plain JSON on purpose. A row travels through
 * `ctx.emit` to a renderer that has no imports, so a `Map` or a class instance
 * here would arrive on the other side as `{}` and the detail panel would render
 * an empty table with nothing anywhere saying why.
 */
import type { ValueBadge } from '@shared/module-ui'
import type { ModuleContext } from '@shared/modules'
import type { OwrtRules } from '../config'
import type { OpenWrtCapabilities } from '../probe'
import type { BindingInstanceRecord, DirectBindingRecord } from '../store'
import type { RouterModel } from '../types'

/** One line of `ip -4 rule show`, kept whole rather than filtered to a band. */
export interface ScanRuleLine {
  pref: number
  /**
   * The lookup token exactly as `ip` printed it - `42`, `main`, `vpn`. A
   * string because `/etc/iproute2/rt_tables` lets a table have a name, and a
   * parser that insisted on digits is precisely how a named-table rule became
   * invisible to this module.
   */
  table: string
  /**
   * The rule names a table whose token this reader would not accept, so `table`
   * is empty for a rule that plainly has one.
   *
   * The two cases have to stay apart because the sentence for them is
   * different and only one of them is true of each rule: a rule with no table
   * is one the kernel acts on directly, and saying that about a rule pointing
   * at a table nobody here could read is inventing a fact about the router.
   */
  tableUnread: boolean
  /** The `from` selector as printed: an address, a CIDR, or `all`. */
  from: string
  /** The source address with a `/32` dropped; empty for `from all` and no `from`. */
  ip: string
  /** What this rule selects on besides the table, for a rule with no source. */
  selector: string
  /** The line as the router printed it, trimmed and capped. */
  text: string
}

/**
 * One bounded read of the router's whole policy-routing state.
 *
 * `ok` is the fail-closed sentinel. False means the router could not read its
 * own rule table, which must never be reported as "this router has no rules" -
 * that is the one answer that would make the monitor say the opposite of the
 * truth.
 */
export interface ScanReadout {
  ok: boolean
  rules: ScanRuleLine[]
  /**
   * The rule table came back at the command's cap, so `rules` holds the start
   * of it and not the whole of it.
   *
   * `ip -4 rule show` prints in ascending preference, so the rules that went
   * missing are the ones *above* the cut - this module's own catch-alls among
   * them, and any foreign rule numbered above the band. This module writes one
   * rule per bound client, which makes a router past the cap ordinary rather
   * than exotic, and a count of what survived stated as the size of the table
   * is the one error a monitor cannot be allowed to make quietly.
   */
  rulesTruncated: boolean
  /** Default routes in the main table, as printed. */
  mainDefaults: string[]
  /** Routes captured per lookup token, at most a handful each. */
  routes: Record<string, string[]>
  /**
   * The lookup tokens the routes pass actually ran `ip route show table` over,
   * as the router itself listed them.
   *
   * The router states this rather than the parser inferring it, because the
   * two answers are allowed to disagree: the token list is harvested with awk
   * over the *whole* rule file and cut with `sort -u | head` in lexicographic
   * order, so once the rule table is capped the router can spend every slot on
   * tokens that only the unprinted rules named. Inferring the list from the
   * parsed rules is precisely how a table nobody had ever queried came to be
   * reported as having no way out, red badge and all, while its default route
   * sat there working.
   */
  queried: string[]
}

/** Who put a rule on the router, decided by evidence rather than by trust. */
export type ScanOwnerKind =
  | 'direct'
  | 'instance'
  | 'catchAll'
  | 'agent'
  | 'mwan3'
  | 'foreign'

/** What each verdict is called in front of a user. */
export const OWNER_LABEL: Readonly<Record<ScanOwnerKind, string>> = {
  direct: 'one-to-one binding',
  instance: 'binding instance',
  catchAll: 'safety catch-all',
  agent: 'router agent',
  mwan3: 'mwan3',
  foreign: 'outside this module'
}

/** The verdicts this module is responsible for, for the "bound here" tile. */
export const MANAGED_OWNERS: ReadonlySet<ScanOwnerKind> = new Set<ScanOwnerKind>([
  'direct',
  'instance',
  'catchAll',
  'agent'
])

export interface ScanRow {
  key: string
  /** The source address, or the selector text when the rule has no source. */
  ip: string
  /** False when `ip` describes a selector rather than naming an address. */
  sourceRouted: boolean
  pref: number
  /** The lookup token as printed, which is what the detail panel must show. */
  table: string
  /** `main (254)`, `42`, `vpn` - the token with its well-known name resolved. */
  tableLabel: string
  /** The WAN interface the table's default route actually leaves through. */
  wan: string
  wanIp: string
  ownerKind: ScanOwnerKind
  owner: string
  ownerBadges: ValueBadge[]
  /** One plain-English sentence built from the evidence beside it. */
  reason: string
  /** The rule exactly as `ip -4 rule show` printed it. */
  rule: string
  /** Every route captured for this rule's table, for the detail panel. */
  routes: string[]
  /**
   * The same routes as one block of text.
   *
   * A `keyValue` row prints whatever it is given through `String()`, so the
   * array arrived as a comma-run with no spaces and an empty one arrived as
   * nothing at all - on the one panel whose entire job is to show the evidence.
   * A spec cannot join or default a list, so it is done here.
   */
  routesText: string
  /** The main table's default, so a reader has something to compare against. */
  mainDefault: string
  /** The table this rule points at offers no way out. */
  unreachable: boolean
  /**
   * This rule is consulted before every rule this module writes, *and* it could
   * take traffic from one of them.
   *
   * Both halves, because the badge this flag raises is an accusation: a low
   * preference on a router where this module writes no rules at all outranks
   * nothing, and neither does one whose source selector cannot cover a single
   * address this module has placed. Flagged on the preference alone it put a red
   * chip on rules that were doing nothing to anybody.
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
   * Rules this module did not write - mwan3's included. `byOwner` still keeps
   * mwan3 apart, because "another manager owns it" and "nobody knows who owns
   * it" call for different things from the person reading the page.
   */
  foreign: number
  /** Rules pointing at a table with no way out. */
  unreachable: number
  /** Rules that select on something other than a source address. */
  selectors: number
  /**
   * `total` counts the rules below the command's cap, not the rules on the
   * router. It rides in the summary rather than staying in the readout because
   * the summary is what the page states as fact - "Rules seen: 500" beside a
   * table that was cut at 500 is a sentence nobody would question, and the
   * rules it hides are the high-preference ones this module writes itself.
   */
  rulesTruncated: boolean
  /**
   * The cap that did the cutting, carried beside the flag so a surface can say
   * how far the scan got without hard-coding a number that would drift the day
   * `SCAN_MAX_RULES` moves.
   */
  rulesCap: number
}

export interface ScanSnapshot {
  /**
   * When the rows were last built from a scan the module could act on. A
   * failed sweep leaves it where it was, for the reason `BindingSnapshot`
   * does: rows stamped with the time of a failure report fresh data about a
   * router the module has in fact lost sight of.
   */
  t: number
  /** False when the last sweep failed; `lastError` then says what failed. */
  ok: boolean
  /** Empty while `ok`. Never carries router output. */
  lastError: string
  rows: ScanRow[]
  summary: ScanSummary
}

/** One address this module believes it has placed, and where. */
export interface ScanAssignment {
  ip: string
  wan: string
  instance: string
}

/**
 * The address one stored one-to-one binding currently has a rule standing for.
 *
 * Kept apart from the record because the record cannot answer it. A binding
 * that names a MAC is written for whatever that MAC answers to, and the leases
 * stop answering the instant the device drops off - while the one-to-one pass
 * deliberately keeps the rule installed at the last address it saw for the whole
 * of Lease release grace (s), so that a laptop closed for thirty seconds does not
 * lose and regain its WAN. Only the pass's own memory knows that address, and
 * without it the monitor reads a rule this module wrote, and is about to remove
 * itself, as one written outside this module.
 */
export interface ScanInstalledAddress {
  /** The `DirectBindingRecord` id this rule belongs to. */
  id: string
  /** The address the last pass wrote a rule for; empty when it wrote none. */
  ip: string
}

export interface ScanEngineOptions {
  ctx: ModuleContext
  rules: () => OwrtRules
  latestModel: () => RouterModel | null
  /** Records this module holds, read lazily so the engine never captures a stale copy. */
  direct: () => readonly DirectBindingRecord[]
  instances: () => readonly BindingInstanceRecord[]
  /** Every address the binding half currently believes it has placed, and where. */
  assignments: () => ReadonlyArray<ScanAssignment>
  /**
   * What the one-to-one pass last wrote a rule for, per record; see
   * `ScanInstalledAddress`. Optional so that a container which has not wired it
   * yet still compiles - an absent memory only costs the grace window its
   * attribution, which is exactly the state this option was added to end, and
   * never makes the classifier claim a rule it did not write.
   */
  installed?: () => ReadonlyArray<ScanInstalledAddress>
  capabilities: () => OpenWrtCapabilities
}

/** Everything the classifier needs, gathered once so it stays a pure function. */
export interface ScanClassifyInput {
  readout: ScanReadout
  rules: OwrtRules
  model: RouterModel | null
  direct: readonly DirectBindingRecord[]
  instances: readonly BindingInstanceRecord[]
  assignments: readonly ScanAssignment[]
  /** The rule each one-to-one binding actually has standing; see `ScanInstalledAddress`. */
  installed?: readonly ScanInstalledAddress[]
  capabilities: OpenWrtCapabilities
}

export interface ScanClassifyResult {
  rows: ScanRow[]
  summary: ScanSummary
}
