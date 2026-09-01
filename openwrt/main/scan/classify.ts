/**
 * Who wrote each rule, decided by evidence rather than by trust.
 *
 * The module cannot ask a rule where it came from. What it can do is compare
 * the rule against the things it knows it did: the preference band it stamps
 * one-to-one bindings from, the band each instance's assignments live in, the
 * catch-all preference each instance owns, and the addresses the binding half
 * says it has placed. A rule that matches one of those is this module's own
 * work. Everything else is somebody else's, and is shown and never touched -
 * the monitor's single hard rule, because the rules it is best at finding are
 * exactly the ones whose purpose nobody here can know.
 *
 * The order of the tests is the order of the evidence, strongest first. A rule
 * in the direct band with a record standing behind it is ours beyond argument;
 * "mwan3 is installed and this is not in any of our bands" is a good guess and
 * sits last but one. `foreign` is what is left, and being left over is not a
 * failure of the classifier - it is the answer the whole feature was built to
 * produce.
 */
import type { ValueBadge } from '@shared/module-ui'
import { BADGE, badge } from '../badges'
import { hasFeature } from '../agent'
import { lanCidr } from '../binding'
import type { OwrtRules } from '../config'
import { leaseAddresses, resolveTarget } from '../direct'
import { MANAGED_PREF_CEILING, recordLayout } from '../records'
import type { BindingInstanceRecord } from '../store'
import { ifaceIndex, intToIpv4, parseCidr, subnetContains, type ParsedSubnet } from '../util'
import { SCAN_MAX_RULES } from './command'
import { NO_EXIT, buildReason, resolveExit, routesFor, type ScanExit } from './evidence'
import { isKernelBaseline, tableLabel, tableNumber } from './parse'
import {
  MANAGED_OWNERS,
  OWNER_LABEL,
  type ScanAssignment,
  type ScanClassifyInput,
  type ScanClassifyResult,
  type ScanOwnerKind,
  type ScanRow,
  type ScanRuleLine
} from './types'

interface PrefBand {
  from: number
  to: number
}

/** One stored one-to-one binding, with every address a rule for it may name. */
interface DirectClaim {
  name: string
  wan: string
  /**
   * The record's target resolved against the leases, so a MAC-targeted binding
   * can be compared with a rule at all. Empty when the device is not on the
   * network, which is emphatically not the same statement as "no rule for it
   * stands on this router" - see `installed`.
   */
  ip: string
  /**
   * The address the one-to-one pass last actually wrote a rule for.
   *
   * The two answers are allowed to disagree, and during the disagreement it is
   * this one that describes the router. `resolveTarget` returns '' the instant a
   * MAC's lease disappears, while the pass keeps that binding's rule installed at
   * the last address it saw for the whole of Lease release grace (s) - five
   * minutes by default. Judged on the live address alone, the monitor published a
   * rule this module wrote, at a preference in this module's own band, as
   * "written outside this module" for that entire window - and the page's own
   * advice about a foreign rule sitting in the module's band is to go and remove
   * it, so a person following it deleted a rule the module owned and would have
   * withdrawn by itself. `reservedIps` unions the same two answers for the same
   * reason: an address belongs to a binding for exactly as long as a rule for it
   * stands.
   */
  installed: string
}

/** One instance's catch-all preference, with what the rule there should say. */
interface CatchAllClaim {
  record: BindingInstanceRecord
  /**
   * The table that instance's catch-all was stamped to point at. Held beside
   * the record because the record may have been written under an older layout,
   * and re-deriving it from the rules in force is how this module comes to call
   * its own work foreign the moment somebody moves a base.
   */
  table: number
  /**
   * The subnet of that instance's LAN as the router states it now, or null when
   * the router does not state it - a LAN with no IPv4 address, a LAN that is
   * not in this sample, or no sample at all. Null means the fact is unavailable
   * rather than false, and an unavailable fact contradicts nothing.
   */
  lan: ParsedSubnet | null
}

/** Everything derived once from the records, so the per-rule pass stays cheap. */
interface Bands {
  /** The assignment bands: the live one plus every stamped instance layout. */
  instance: PrefBand[]
  /** Catch-all preference -> the instance that owns it. */
  catchAll: Map<number, CatchAllClaim>
  /** The lowest preference this module writes anywhere on this router. */
  lowestManaged: number
  instanceById: Map<string, BindingInstanceRecord>
  assignmentByIp: Map<string, ScanAssignment>
  directByPref: Map<number, DirectClaim>
  /** Whether this module writes any rule at all on this router. */
  writesRules: boolean
  /** Every address this module has a rule for, one-to-one bindings included. */
  managedIps: string[]
}

function buildBands(input: ScanClassifyInput): Bands {
  const rules: OwrtRules = input.rules
  const instance: PrefBand[] = [
    { from: rules.rulePrefBase, to: rules.catchAllPrefBase }
  ]
  const catchAll = new Map<number, CatchAllClaim>()
  const instanceById = new Map<string, BindingInstanceRecord>()
  let lowestManaged = Math.min(rules.directPrefBase, rules.rulePrefBase)
  // The same index the fast surfaces share, so classifying five hundred rules
  // against a router with five thousand interfaces does not walk the array once
  // per instance to find one LAN.
  const ifaces = ifaceIndex(input.model)

  for (const record of input.instances) {
    instanceById.set(record.id, record)
    // The layout the instance was created under, not the one in force now.
    // A record written before the Rules editor was touched still has its rules
    // sitting at the old numbers, and re-deriving the band from the current
    // settings is how the module would come to call its own assignments
    // foreign the moment somebody moved a base.
    const layout = recordLayout(record, rules)
    instance.push({ from: layout.rulePrefBase, to: layout.catchAllPrefBase })
    const pref = layout.catchAllPrefBase + record.slot
    if (pref >= layout.catchAllPrefBase && pref < MANAGED_PREF_CEILING) {
      catchAll.set(pref, {
        record,
        table: layout.catchAllTable,
        lan: parseCidr(lanCidr(ifaces.get(record.lan)) ?? '')
      })
    }
    lowestManaged = Math.min(lowestManaged, layout.rulePrefBase)
  }

  // Keyed by the preference stamped on the record, and deliberately not
  // checked against the live one-to-one band afterwards. `directPrefBase` can
  // be edited while bindings exist, and the rules on the router keep the
  // numbers they were written with; a band derived from the current setting is
  // how this module came to say "this module did not write this rule" about a
  // rule it wrote, on every one-to-one binding at once, the moment somebody
  // saved a new base. The instance verdict above refuses the same trap by
  // using each record's stamped layout, and this is the same refusal.
  //
  // The address each record answers to is resolved here, through the same
  // leases the one-to-one half resolves against, because the preference alone
  // is not evidence of anything: see `decide`.
  const leaseByMac = leaseAddresses(input.model?.leases ?? [])
  const installedById = new Map<string, string>()
  for (const entry of input.installed ?? []) {
    if (entry.ip) installedById.set(entry.id, entry.ip)
  }
  const directByPref = new Map<number, DirectClaim>()
  for (const record of input.direct) {
    directByPref.set(record.pref, {
      name: record.name,
      wan: record.wan,
      ip: resolveTarget(record.target, leaseByMac),
      installed: installedById.get(record.id) ?? ''
    })
    lowestManaged = Math.min(lowestManaged, record.pref)
  }

  const assignmentByIp = new Map<string, ScanAssignment>()
  for (const entry of input.assignments) {
    if (entry.ip) assignmentByIp.set(entry.ip, entry)
  }

  return {
    instance,
    catchAll,
    lowestManaged,
    instanceById,
    assignmentByIp,
    directByPref,
    writesRules: input.direct.length > 0 || input.instances.length > 0,
    // Both answers again, and for the reason the union exists at all: the
    // "outranks module" accusation asks whether a low rule could take traffic
    // from one this module wrote, and a rule standing through the release grace
    // is a rule this module wrote. Counting only the live address made the
    // warning go quiet for exactly the five minutes in which the address it
    // covers is hardest to account for.
    managedIps: [
      ...assignmentByIp.keys(),
      ...[...directByPref.values()].flatMap((claim) => [claim.ip, claim.installed]).filter(Boolean)
    ]
  }
}

function inBand(pref: number, band: PrefBand): boolean {
  return pref >= band.from && pref < band.to
}

/**
 * Whether a rule's source is a block the catch-all for that LAN could have been
 * written from.
 *
 * Containment rather than overlap, and the prefix as well as the address.
 * Every block this module writes there is either the LAN itself or one of the
 * covering blocks of a range that `binding/check.ts` already refused to create
 * unless it sat inside the LAN - so a selector wider than the LAN is one this
 * module could not have produced, however much of the LAN it happens to cover.
 */
function insideLan(source: string, lan: ParsedSubnet): boolean {
  const block = parseCidr(source)
  if (block) {
    return block.prefix >= lan.prefix && subnetContains(lan, intToIpv4(block.network))
  }
  return subnetContains(lan, source)
}

/**
 * Which fact stops this rule from being the catch-all whose preference it
 * shares, or an empty string when nothing does.
 *
 * Each of the three is checked only where the router actually states it. A LAN
 * with no address states no subnet, and a table named in `/etc/iproute2/rt_tables`
 * states no number - and a verdict that read an unavailable fact as a failed one
 * would call this module's own catch-all foreign on exactly the routers whose
 * layout it cannot see, which is the trap this whole exercise is about.
 */
function catchAllMismatch(rule: ScanRuleLine, claim: CatchAllClaim): string {
  if (!rule.ip) {
    return 'that catch-all is written for a block of LAN addresses and this rule selects on no source address at all'
  }
  if (claim.lan && !insideLan(rule.ip, claim.lan)) {
    return `that catch-all covers ${claim.lan.cidr} and this rule selects on addresses outside it`
  }
  const table = tableNumber(rule.table)
  if (table !== null && table !== claim.table) {
    return `that catch-all parks its LAN in table ${claim.table} and this rule points at a different one`
  }
  return ''
}

/** The verdict, plus the one clause that says how it was reached. */
interface Verdict {
  kind: ScanOwnerKind
  ownership: string
}

/**
 * Which addresses the binding at this preference could legitimately have a rule
 * for, said in the order a reader would want them.
 *
 * Both, and not one - the point of the whole exercise. The live answer is what
 * the binding will be written for on the next pass, the installed one is what it
 * is written for now, and they part company for the length of the release grace.
 * A refusal that named only one of them would be telling somebody a fact about
 * their router that the router itself would contradict a line further down the
 * same table.
 */
function claimedAddresses(claim: DirectClaim): string[] {
  return [...new Set([claim.ip, claim.installed])].filter(Boolean)
}

/**
 * The verdict for a rule sitting at a preference a stored one-to-one binding
 * was stamped with.
 *
 * The preference gets the binding as far as being asked about; the address is
 * what answers. Nothing stops somebody else's rule from being numbered where
 * this module numbers its own, and crediting that rule to a binding is the exact
 * mistake this feature exists to prevent, made in the module's own voice.
 *
 * The address rather than the record's stamped table, because a held binding is
 * re-pointed at the blackhole table while keeping its address and its
 * preference, and matching on the table would have called every held one-to-one
 * binding on the router foreign.
 */
function directVerdict(rule: ScanRuleLine, claim: DirectClaim): Verdict {
  const target = claim.wan ? ` to send that address out ${claim.wan}` : ''
  const wrote = `This is the one-to-one binding "${claim.name}", which this module wrote${target}.`
  if (rule.ip && rule.ip === claim.ip) return { kind: 'direct', ownership: wrote }
  // Owned on the pass's own memory rather than on the leases, and said out
  // loud: a rule for an address nothing currently answers to is a strange thing
  // to find in a table, and a reader who is told whose it is and when it goes
  // has no reason to reach for it.
  if (rule.ip && rule.ip === claim.installed) {
    const grace = claim.ip
      ? `That binding answers to ${claim.ip} now, and this is the rule it was written for before; this module replaces it on its next pass.`
      : 'Nothing on this router answers to the device that binding names at the moment, so its rule stands at the address the device was last seen at until Lease release grace (s) runs out - after which this module withdraws it itself.'
    return { kind: 'direct', ownership: `${wrote} ${grace}` }
  }
  const addresses = claimedAddresses(claim)
  const written =
    addresses.length === 0
      ? 'that binding names a device this module cannot resolve an address for right now, and holds no rule of its own'
      : addresses.length === 1
        ? `that binding is written for ${addresses[0]} and this rule is not`
        : `that binding is written for ${addresses[0]}, its own rule still stands for ${addresses[1]}, and this rule names neither`
  return {
    kind: 'foreign',
    ownership:
      `This module did not write this rule. It does sit at preference ${rule.pref}, ` +
      `which is where this module writes the one-to-one binding "${claim.name}" - but ` +
      `${written}, so the shared preference is a coincidence rather than evidence of who wrote it.`
  }
}

function decide(
  rule: ScanRuleLine,
  bands: Bands,
  input: ScanClassifyInput
): Verdict {
  // A stored record sitting at exactly this preference, written for an address
  // it actually has a rule for, is the evidence; `directVerdict` weighs it. A
  // rule inside the live one-to-one band with no record behind it is still
  // unattributed and falls through, which is the only thing that band was ever
  // able to tell us that the record does not - and it is deliberately not asked
  // here, because `directPrefBase` can be edited while bindings exist and the
  // rules on the router keep the numbers they were written with.
  const claim = bands.directByPref.get(rule.pref)
  if (claim) return directVerdict(rule, claim)

  const assignment = rule.ip ? bands.assignmentByIp.get(rule.ip) : undefined
  if (assignment && bands.instance.some((band) => inBand(rule.pref, band))) {
    const named = bands.instanceById.get(assignment.instance)?.name ?? assignment.instance
    return {
      kind: 'instance',
      ownership: `This module wrote it - binding instance "${named}" has that address assigned to ${assignment.wan}.`
    }
  }

  // The catch-all preference, held to the same standard as the one-to-one
  // preference above: where this module writes is not evidence that it wrote.
  // On the preference alone a stranger's rule at 29900 came back described as
  // this module's own fail-closed catch-all - the mistake the monitor exists to
  // prevent, made in the module's own voice, about the one rule whose job is to
  // take a LAN off the internet.
  //
  // Three more facts, in `catchAllMismatch`, and none of them is the
  // preference. What this module writes there is `from <a block of that LAN>
  // lookup <that instance's catch-all table>`, so a rule selecting on no source
  // at all, or on addresses the LAN does not contain, or on another table, is
  // not that rule however exactly the number lines up.
  const owner = bands.catchAll.get(rule.pref)
  if (owner) {
    const mismatch = catchAllMismatch(rule, owner)
    if (!mismatch) {
      return {
        kind: 'catchAll',
        ownership: `This is the fail-closed catch-all for binding instance "${owner.record.name}": an address on that LAN with no WAN of its own is parked here rather than let out through the router's default connection.`
      }
    }
    return {
      kind: 'foreign',
      ownership:
        `This module did not write this rule. It does sit at preference ${rule.pref}, ` +
        `which is where this module writes the catch-all for binding instance ` +
        `"${owner.record.name}" - but ${mismatch}, so the shared preference is a ` +
        `coincidence rather than evidence of who wrote it.`
    }
  }

  // The daemon writes its rules at its own base, which this module does not
  // set and cannot read back per-rule. A cached assignment for the same
  // address is the only evidence available, and one fast tick of staleness is
  // something a monitor can live with where a reconcile could not.
  if (assignment && hasFeature(input.capabilities.agent, 'binding')) {
    return {
      kind: 'agent',
      ownership: `The bm-wanbind daemon on this router wrote it - this module's cached view has that address assigned to ${assignment.wan}.`
    }
  }

  // The last verdict before "nobody here knows", and the only one reached
  // without a fact about the rule itself - which is why the sentence now says
  // how far the evidence goes. "mwan3 is what put it there" was stated as
  // certainty about a router where mwan3 is merely installed, and the rule a
  // person opens this page to find is exactly the hand-written one that would
  // have been filed under somebody else's name and skipped.
  //
  // A firewall mark is the fact worth naming when it is there: mwan3 steers on
  // one for every interface it manages. Its absence is not proof of anything -
  // mwan3's own `pref 1 lookup main` carries no mark either - so it downgrades
  // the sentence rather than the verdict.
  if (input.capabilities.mwan3.config) {
    const marked = /\bfwmark\b/.test(rule.selector)
    return {
      kind: 'mwan3',
      ownership: marked
        ? 'mwan3 is configured on this router, this rule sits outside every band this module writes, and it steers on a firewall mark the way mwan3 does. This module will not touch it.'
        : 'mwan3 is configured on this router and this rule sits outside every band this module writes, so mwan3 is the likeliest thing to have written it - though it carries no firewall mark of the kind mwan3 steers with, so nothing here can be sure of that. This module will not touch it.'
    }
  }

  return { kind: 'foreign', ownership: 'This module did not write this rule.' }
}

/**
 * Whether the scan is entitled to say a table has no way out.
 *
 * An empty entry and a missing entry look identical in the reply, so the only
 * thing separating "that table is empty" from "the routes pass never got to
 * it" is whether the pass was asked about this table at all - which is why the
 * question is asked of the router's own `===TABLES===` list and never of the
 * rules. Inferred from the rules instead, it was wrong in exactly the case it
 * mattered: the router harvests its sixty-four tokens from the whole rule file
 * while the printed rules stop at the cap, so on a busy router it spends every
 * slot on tokens the unprinted rules named, and every table this side could
 * see then looked like a table with no routes. That put a red "no way out"
 * against addresses whose default route was working, which is the kind of
 * wrong answer that costs a person an afternoon.
 *
 * `main` is exempt because its routes come back in a section of its own rather
 * than through the token loop.
 */
function exitKnown(queried: ReadonlySet<string>, token: string): boolean {
  if (token === 'main' || tableNumber(token) === 254) return true
  return queried.has(token)
}

/**
 * Selectors that pin a rule to traffic a bound client's packet is never in.
 *
 * `iif` and `oif` name the wire a packet arrived on or leaves by. The packets
 * this module's rules steer arrive on a LAN and are still unrouted when the rule
 * table is walked, so a rule keyed on either has nothing of ours underneath it
 * however low its preference.
 *
 * `fwmark` is deliberately not here: a marked packet from a LAN client is
 * exactly the case the accusation is right about. Nor is `ipproto`, which
 * narrows the traffic without excluding ours.
 */
const NARROWING_SELECTOR = /\b(?:iif|oif)\b/

/**
 * Whether a rule numbered below the managed bands could actually take traffic
 * from one of the rules this module wrote.
 *
 * "A binding shown as applied is not where the traffic actually goes" is a
 * heavy sentence, and it was being said of any rule with a low enough
 * preference - a `from 10.0.0.0/8 lookup vpn` on a router whose bindings all
 * live in 192.168.1.0/24, a `iif wg0` rule that no LAN address will ever match.
 * A preference only outranks something if there is something underneath it, so
 * the question is asked of the selector: a rule with a source has to cover an
 * address this module actually placed, and a rule without one is asked what
 * else it narrows on.
 *
 * That second half was written and then not applied. The selector was only ever
 * consulted where there was a source address to consult it beside, and an `iif`
 * rule has none - so the rule this comment names as the example took the
 * unconditional answer and got the red badge anyway, on every router running
 * WireGuard beside a binding.
 */
function couldReachManaged(rule: ScanRuleLine, managed: readonly string[]): boolean {
  if (!rule.ip) return !NARROWING_SELECTOR.test(rule.selector)
  const subnet = parseCidr(rule.ip)
  if (subnet) return managed.some((address) => subnetContains(subnet, address))
  return managed.includes(rule.ip)
}

function ownerBadges(
  kind: ScanOwnerKind,
  flags: { unreachable: boolean; blackholed: boolean; outranks: boolean; sourceRouted: boolean }
): ValueBadge[] {
  const tone =
    kind === 'catchAll' || kind === 'mwan3' || kind === 'foreign' ? BADGE.warn : BADGE.good
  const chips = [badge(OWNER_LABEL[kind], tone)]
  if (flags.blackholed) chips.push(badge('held', BADGE.warn))
  else if (flags.unreachable) chips.push(badge('no way out', BADGE.bad))
  if (flags.outranks) chips.push(badge('outranks module', BADGE.bad))
  if (!flags.sourceRouted) chips.push(badge('selector'))
  return chips
}

/**
 * The counts start at zero and the cut comes in from the readout, because
 * `total` is only honest next to it: the rows below are what came back, and
 * whether that is the router's rule table or the first five hundred lines of it
 * is not something the loop can work out afterwards.
 */
function emptySummary(rulesTruncated: boolean): ScanClassifyResult['summary'] {
  const byOwner: Record<string, number> = {}
  for (const label of Object.values(OWNER_LABEL)) byOwner[label] = 0
  return {
    total: 0,
    byOwner,
    foreign: 0,
    unreachable: 0,
    selectors: 0,
    rulesTruncated,
    rulesCap: SCAN_MAX_RULES
  }
}

/**
 * One row per policy rule on the router, and the counts behind the tiles.
 *
 * Pure: everything it needs was gathered by the caller, so the whole verdict
 * table is testable against fixture text without a router anywhere near it.
 */
/** One route per line in the evidence panel; a `keyValue` cannot join a list itself. */
const NEWLINE = '\n'

/**
 * What the table column says for a rule whose table token this reader refused.
 *
 * Not the token itself: it is administrator-written text that failed the one
 * check standing between the router and a row on somebody's screen, and the
 * column it would land in is also a grouping key. Not `no table` either - that
 * is a different rule with a different meaning, and the two sharing a label is
 * how a reader comes to look for a rule the kernel handles itself.
 */
const UNREAD_TABLE_LABEL = 'unreadable table name'

export function classifyScan(input: ScanClassifyInput): ScanClassifyResult {
  const bands = buildBands(input)
  const main = resolveExit(input.model, input.readout.mainDefaults)
  const mainDefault = main.route
  const summary = emptySummary(input.readout.rulesTruncated)
  const queried = new Set(input.readout.queried)
  const rows: ScanRow[] = []
  const seen = new Map<string, number>()

  for (const rule of input.readout.rules) {
    // The kernel's own three. They are on every Linux machine ever booted and
    // steer nothing away from the default connection; listing them as rules
    // written outside this module would put three permanent false positives at
    // the top of a table whose entire value is that a row in it means something.
    if (isKernelBaseline(rule)) continue

    const routes = rule.table ? routesFor(input.readout, rule.table) : []
    const exit: ScanExit = rule.table ? resolveExit(input.model, routes) : NO_EXIT
    const unreachable =
      !!rule.table && !exit.route && !exit.blackholed && exitKnown(queried, rule.table)
    const belowModule = rule.pref < bands.lowestManaged
    const outranksModule =
      belowModule && bands.writesRules && couldReachManaged(rule, bands.managedIps)
    const verdict = decide(rule, bands, input)
    const sourceRouted = rule.ip !== ''

    const base = `${rule.pref}|${rule.from}|${rule.table}`
    const repeat = seen.get(base) ?? 0
    seen.set(base, repeat + 1)

    rows.push({
      key: repeat === 0 ? base : `${base}|${repeat}`,
      ip: sourceRouted ? rule.ip : rule.selector || 'all traffic',
      sourceRouted,
      pref: rule.pref,
      table: rule.table,
      tableLabel: rule.tableUnread ? UNREAD_TABLE_LABEL : tableLabel(rule.table),
      wan: exit.wan,
      wanIp: exit.wanIp,
      ownerKind: verdict.kind,
      owner: OWNER_LABEL[verdict.kind],
      ownerBadges: ownerBadges(verdict.kind, {
        unreachable,
        blackholed: exit.blackholed,
        outranks: outranksModule,
        sourceRouted
      }),
      reason: buildReason({
        rule,
        exit,
        main,
        unreachable,
        belowModule,
        outranksModule,
        ownership: verdict.ownership
      }),
      rule: rule.text,
      routes: [...routes],
      routesText: routes.length
        ? routes.join(NEWLINE)
        : 'no routes were captured for this table',
      mainDefault,
      unreachable,
      outranksModule
    })

    summary.total += 1
    summary.byOwner[OWNER_LABEL[verdict.kind]] += 1
    if (!MANAGED_OWNERS.has(verdict.kind)) summary.foreign += 1
    if (unreachable) summary.unreachable += 1
    if (!sourceRouted) summary.selectors += 1
  }

  return { rows, summary }
}
