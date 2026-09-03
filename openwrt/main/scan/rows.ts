/**
 * One `rules` reply, turned into the rows the Monitor page renders.
 *
 * Nothing here decides who owns a rule and nothing here writes the sentence
 * beside it. The daemon does both, because it is the half holding the sections,
 * the bands and the kernel's own two dumps at once - and the module used to
 * infer ownership from a preference alone, which cannot tell an instance's
 * client rule from a hand-written one at the same number. This file renders:
 * numbers to labels, a reply's table facts to the line a person reads, verdicts
 * to chips.
 *
 * The one judgement left on this side is `outranksModule`, and it is not a
 * verdict about who wrote a rule - it is arithmetic about which rule the kernel
 * reaches first, done over the daemon's own bands and the daemon's own
 * classifications. See `couldReachManaged` for why it is not the preference
 * alone.
 */
import type { ValueBadge } from '@shared/module-ui'
import type { WanbindRulesReply } from '../agent'
import { BADGE, badge } from '../badges'
import { parseCidr, subnetContains } from '../util'
import {
  MANAGED_OWNERS,
  OWNER_LABEL,
  ROUTER_OWNERS,
  type ScanOwnerKind,
  type ScanRow,
  type ScanSummary
} from './types'

/**
 * The reply's own row shapes, named through the reply that carries them - the
 * same thing the sibling builder next door does, and for the same reason: an
 * alias is the contract by definition, so it cannot drift from the daemon the
 * way a hand-copied interface would.
 */
type RuleRow = WanbindRulesReply['rules'][number]
type TableRow = WanbindRulesReply['tables'][number]

/** The three tables `ip` prints by name, and the names it prints. */
const WELL_KNOWN_TABLES: ReadonlyMap<number, string> = new Map([
  [255, 'local'],
  [254, 'main'],
  [253, 'default']
])

/**
 * FR_ACT_*, the three actions that answer a packet instead of looking anything
 * up. Spelled out rather than derived, and only these three: an action this
 * side does not recognise is left off the rebuilt line entirely rather than
 * guessed at, because that line is what somebody holds up against a console.
 */
const ACT_BLACKHOLE = 6
const ACT_UNREACHABLE = 7
const ACT_PROHIBIT = 8

/** The daemon's word for a rule that selects on nothing at all. */
const EVERYTHING = 'everything'

/** One route line per line in the evidence panel; a `keyValue` cannot join. */
const NEWLINE = '\n'

/**
 * A bound on the one field here built out of router-supplied text.
 *
 * `selector` is assembled by the daemon out of a CIDR, an interface name and a
 * mark, so it is short by construction - but an interface name is whatever an
 * administrator typed, and text that arrives over a connection is data rather
 * than a promise.
 */
const MAX_RULE_TEXT = 240

/** `main (254)`, `42`, `no table` - what a table is called in front of a user. */
export function tableLabel(table: number): string {
  if (table <= 0) return 'no table'
  const name = WELL_KNOWN_TABLES.get(table)
  return name ? `${name} (${table})` : String(table)
}

/** `main`, `42` - what `ip rule show` itself would print in a lookup clause. */
function tableToken(table: number): string {
  return WELL_KNOWN_TABLES.get(table) ?? String(table)
}

/**
 * The address a source selector names, with a `/32` dropped.
 *
 * The prefix goes only where it is the kernel's way of writing a single host;
 * nobody reads their own address as `192.168.1.50/32`. A `/24` keeps its
 * prefix, because there the prefix is the fact - "everything in this block" and
 * "this one machine" are different rows.
 */
function hostAddress(cidr: string): string {
  return cidr.replace(/\/32$/, '')
}

/** What `ip -4 rule show` puts after the priority, for this rule's action. */
function actionClause(rule: RuleRow): string {
  if (rule.action === ACT_BLACKHOLE) return 'blackhole'
  if (rule.action === ACT_UNREACHABLE) return 'unreachable'
  if (rule.action === ACT_PROHIBIT) return 'prohibit'
  return rule.table > 0 ? `lookup ${tableToken(rule.table)}` : ''
}

/**
 * The line the router would have printed for this rule.
 *
 * Rebuilt rather than carried, because the daemon reads the rules off netlink
 * and there is no printed line to carry - and this row is the one somebody
 * compares against what `ip -4 rule show` says on their own console. So it is
 * written the way `ip` writes it, down to spelling "no selector" as `from all`:
 * a line that said `everything` would not be found by an operator searching
 * their own terminal for it.
 */
function ruleText(rule: RuleRow): string {
  const match = rule.selector === EVERYTHING ? 'from all' : rule.selector
  const clause = actionClause(rule)
  const body = clause ? `${match} ${clause}` : match
  return `${rule.pref}:\t${body}`.slice(0, MAX_RULE_TEXT)
}

/**
 * What the daemon says about the table this rule points at.
 *
 * Three different facts, kept apart because they call for three different
 * things from a reader. A table that answers `unreachable` is an address parked
 * on purpose - the whole mechanism a held binding rests on - and reporting it
 * as a broken table sends somebody to fix the thing that is working. A table
 * with no default route at all is the opposite: the rule matches, the lookup
 * finds nothing, and the packet carries on down the rule list as though it had
 * never matched.
 */
function tableLines(facts: ReadonlyMap<number, TableRow>, table: number): string[] {
  if (table <= 0) {
    return ['this rule looks up no routing table at all - it answers the packet itself']
  }
  const row = facts.get(table)
  // The daemon describes every table a listed rule names, so a miss means the
  // rule fell outside the cap's company rather than that the table is empty.
  if (!row) return [`this reply carries nothing about table ${table}`]
  if (row.unreachable) {
    return [
      `table ${table} answers unreachable for its default route, so traffic sent there is parked with no way out`
    ]
  }
  if (row.hasDefault && row.device && row.gateway) {
    return [`table ${table} leaves through ${row.device} via ${row.gateway}`]
  }
  if (row.hasDefault && row.device) return [`table ${table} leaves through ${row.device}`]
  if (row.hasDefault) {
    return [`table ${table} has a default route, though the route dump names no device for it`]
  }
  return [
    `table ${table} has no default route, so a lookup there finds nothing and the packet carries on down the rule list`
  ]
}

/** The main table's own way out, written the way `ip route` writes it. */
function mainDefaultText(main: WanbindRulesReply['main']): string {
  if (!main) return 'this router has no default route in its main table'
  if (main.device && main.gateway) return `default via ${main.gateway} dev ${main.device}`
  if (main.device) return `default dev ${main.device}`
  // A load-balanced default: the head route names no single device, which is
  // not the same as the router having no way out.
  return 'the main table has a default route that names no single interface'
}

/**
 * Which interface a rule's table leaves through, in the words the column wants.
 *
 * The daemon names a WAN only where a binding or a seated client told it which
 * connection owns that table; every other table still has the device its
 * default route goes out of. A blank "Leaves through" beside a known netdev is
 * less true than the netdev, so the device answers when the name cannot.
 */
function exitName(row: TableRow | undefined): string {
  if (!row) return ''
  return row.wan || row.device
}

/**
 * Selectors that pin a rule to traffic a bound client's packet is never in.
 *
 * `iif` and `oif` name the wire a packet arrived on or leaves by. The packets
 * the daemon's rules steer arrive on a LAN and are still unrouted when the rule
 * table is walked, so a rule keyed on either has nothing of the daemon's
 * underneath it however low its preference.
 *
 * `fwmark` is deliberately not here: a marked packet from a LAN client is
 * exactly the case the accusation is right about.
 */
const NARROWING_SELECTOR = /\b(?:iif|oif)\b/

/**
 * Whether a rule numbered below the daemon's bands could actually take traffic
 * from one of the rules the daemon wrote.
 *
 * "A binding shown as applied is not where the traffic actually goes" is a
 * heavy sentence, and it was once said of any rule with a low enough preference
 * - a `from 10.0.0.0/8 lookup vpn` on a router whose bindings all live in
 * 192.168.1.0/24, an `iif wg0` rule no LAN address will ever match. A
 * preference only outranks something if there is something underneath it, so
 * the question is asked of the selector: a rule with a source has to cover an
 * address the daemon actually placed, and a rule without one is asked what else
 * it narrows on.
 */
function couldReachManaged(rule: RuleRow, managed: readonly string[]): boolean {
  if (!rule.cidr) return !NARROWING_SELECTOR.test(rule.selector)
  const subnet = parseCidr(rule.cidr)
  const host = hostAddress(rule.cidr)
  if (subnet) return managed.some((address) => subnetContains(subnet, address))
  return managed.includes(host)
}

/**
 * Every address the daemon currently has a rule standing for.
 *
 * Read out of the reply's own verdicts rather than out of anything this module
 * remembers, which is the arrangement the whole release turns on: the module
 * keeps no record of a binding any more, so the only honest answer to "what has
 * this router placed" is the rows the router just described as its own.
 */
function managedAddresses(rules: readonly RuleRow[]): string[] {
  const out: string[] = []
  for (const rule of rules) {
    // The catch-all is not among them on purpose. It fences a whole LAN rather
    // than placing an address, and counting its block would make every low rule
    // touching that LAN an accusation about bindings that may not exist.
    if (rule.owner !== 'manual' && rule.owner !== 'client') continue
    if (rule.cidr) out.push(hostAddress(rule.cidr))
  }
  return out
}

/**
 * The lowest priority the daemon numbers anything at, or 0 when it numbers
 * nothing on this router.
 *
 * Off the reply's `bands` rather than out of this module's settings. They are
 * the daemon's numbers now: a reader holding the shipped defaults against a
 * router whose bands had been moved would call the daemon's own rules the
 * competing ones.
 */
function lowestManaged(bands: WanbindRulesReply['bands']): number {
  let low = bands.direct.base >= 1 ? bands.direct.base : 0
  for (const instance of bands.instances) {
    if (instance.base < 1) continue
    low = low === 0 ? instance.base : Math.min(low, instance.base)
  }
  return low
}

/**
 * The colour of the owner chip.
 *
 * `netifd` and `kernel` get no colour at all, and that is the point of them
 * having a tone of their own: those rules are the router routing itself. Green
 * would claim them for this feature and red would accuse somebody of writing
 * them, and on a router dialling thirty-two PPPoE sessions there are
 * ninety-six of the first kind - a page of alarm about plumbing, hiding the one
 * row that matters.
 */
function ownerTone(kind: ScanOwnerKind): string | undefined {
  if (ROUTER_OWNERS.has(kind)) return undefined
  if (kind === 'manual' || kind === 'client') return BADGE.good
  // Amber is also where an owner this build has never met lands. A reply is
  // data rather than a promise: `hasBindingDaemon` accepts any daemon speaking
  // this contract or a later one, so a seventh owner can arrive here, and an
  // unrecognised rule is worth a second look rather than a green tick.
  // The catch-all is amber beside the two green ones on purpose: it is the
  // daemon's own rule and it is also the one that means a client did not get a
  // WAN of its own, which is worth a second look rather than a tick.
  return BADGE.warn
}

interface RowFlags {
  /** The table answers unreachable: an address parked, not a fault. */
  parked: boolean
  /** The table offers no way out at all, which is a fault. */
  unreachable: boolean
  outranks: boolean
  sourceRouted: boolean
}

/**
 * What the owner column says, falling back to the daemon's own word: a label
 * read straight out of the table is `undefined` for an owner this build has
 * never met - an empty chip, counted under an empty key, impossible to tell
 * from a rule with no owner at all. The raw word is less and true.
 */
function ownerLabel(kind: ScanOwnerKind): string {
  return OWNER_LABEL[kind] ?? String(kind)
}

function ownerBadges(kind: ScanOwnerKind, flags: RowFlags): ValueBadge[] {
  const chips = [badge(ownerLabel(kind), ownerTone(kind))]
  if (flags.parked) chips.push(badge('parked', BADGE.warn))
  else if (flags.unreachable) chips.push(badge('no way out', BADGE.bad))
  if (flags.outranks) chips.push(badge('outranks the daemon', BADGE.bad))
  if (!flags.sourceRouted) chips.push(badge('selector'))
  return chips
}

/**
 * The counts start at zero and the cap comes in from the reply, because `total`
 * is only honest next to it: the rows are what the reply carried, and whether
 * that is the router's rule table or the first two thousand of it is not
 * something the loop can work out afterwards.
 *
 * Every owner that can produce a row is seeded, so a pie bound to this renders
 * a slice at zero rather than a missing category. `kernel` is not seeded and
 * never counted - see the loop.
 */
export function emptyScanSummary(rulesTruncated = false, cap = 0): ScanSummary {
  const byOwner: Record<string, number> = {}
  for (const [kind, label] of Object.entries(OWNER_LABEL)) {
    if (kind === 'kernel') continue
    byOwner[label] = 0
  }
  return { total: 0, onRouter: 0, byOwner, foreign: 0, unreachable: 0, selectors: 0, rulesTruncated, cap }
}

export interface ScanRowsResult {
  rows: ScanRow[]
  summary: ScanSummary
}

/**
 * One row per policy rule on the router, and the counts behind the tiles.
 *
 * Pure: everything it needs arrived in the reply, so the whole rendering is
 * testable against a fixture without a router anywhere near it.
 */
export function buildScanRows(reply: WanbindRulesReply): ScanRowsResult {
  const facts = new Map<number, TableRow>()
  for (const row of reply.tables) facts.set(row.table, row)

  const mainDefault = mainDefaultText(reply.main)
  const managed = managedAddresses(reply.rules)
  const low = lowestManaged(reply.bands)
  // Whether there is anything for a low rule to outrank at all. A router the
  // daemon has written no rule on has no binding to be wrong about, and the
  // accusation would be about nothing.
  const daemonWrites = low > 0 && reply.rules.some((rule) => MANAGED_OWNERS.has(rule.owner))

  const summary = emptyScanSummary(reply.capped, reply.limit)
  // What the router holds, from the daemon rather than from this loop: the
  // rows below are collapsed and may be one page of several.
  summary.onRouter = typeof reply.raw === 'number' ? reply.raw : 0
  const rows: ScanRow[] = []
  const seen = new Map<string, number>()

  for (const rule of reply.rules) {
    // The kernel's own three. They are on every Linux machine ever booted and
    // steer nothing away from the default connection; listing them would put
    // three permanent rows at the top of a table whose entire value is that a
    // row in it means something.
    if (rule.owner === 'kernel') continue

    const table = facts.get(rule.table)
    const parked = rule.table > 0 && !!table?.unreachable
    const unreachable = rule.table > 0 && !!table && !table.hasDefault && !table.unreachable
    const sourceRouted = rule.cidr !== ''
    const outranksModule = daemonWrites && rule.pref < low && couldReachManaged(rule, managed)
    const lines = tableLines(facts, rule.table)

    const base = `${rule.pref}|${rule.cidr || rule.selector}|${rule.table}`
    const repeat = seen.get(base) ?? 0
    seen.set(base, repeat + 1)

    const stands = typeof rule.count === 'number' && rule.count > 0 ? rule.count : 1

    rows.push({
      key: repeat === 0 ? base : `${base}|${repeat}`,
      ip: sourceRouted ? hostAddress(rule.cidr) : rule.selector,
      cidr: rule.cidr,
      dst: rule.dst ?? '',
      count: stands,
      sourceRouted,
      pref: rule.pref,
      table: rule.table,
      tableLabel: tableLabel(rule.table),
      wan: exitName(table),
      wanIp: table?.gateway ?? '',
      ownerKind: rule.owner,
      owner: ownerLabel(rule.owner),
      ownerBadges: ownerBadges(rule.owner, {
        parked,
        unreachable,
        outranks: outranksModule,
        sourceRouted
      }),
      reason: rule.reason ?? '',
      rule: ruleText(rule),
      routes: lines,
      routesText: lines.join(NEWLINE),
      mainDefault,
      unreachable,
      outranksModule
    })

    summary.total += stands
    const label = ownerLabel(rule.owner)
    // Seeded keys start at zero, and an owner this build has never met has no
    // seed at all - so the count is opened rather than incremented, which is
    // the difference between a new slice and a slice reading NaN.
    summary.byOwner[label] = (summary.byOwner[label] ?? 0) + stands
    // netifd is not foreign, and this is the line that says so: those rules are
    // the router routing itself, three per interface with a table of its own,
    // and the tile this feeds is the one that says how many rules somebody
    // should go and look at.
    if (!MANAGED_OWNERS.has(rule.owner) && !ROUTER_OWNERS.has(rule.owner)) summary.foreign += 1
    if (unreachable) summary.unreachable += 1
    if (!sourceRouted) summary.selectors += 1
  }

  return { rows, summary }
}
