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
import type { OwrtRules } from '../config'
import { leaseAddresses, resolveTarget } from '../direct'
import { MANAGED_PREF_CEILING, recordLayout } from '../records'
import type { BindingInstanceRecord } from '../store'
import { parseCidr, subnetContains } from '../util'
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

/** One stored one-to-one binding, with the address it answers to right now. */
interface DirectClaim {
  name: string
  wan: string
  /**
   * The record's target resolved against the leases, so a MAC-targeted binding
   * can be compared with a rule at all. Empty when the device is not on the
   * network, which is also when the rule for it is on its way off the router.
   */
  ip: string
}

/** Everything derived once from the records, so the per-rule pass stays cheap. */
interface Bands {
  /** The assignment bands: the live one plus every stamped instance layout. */
  instance: PrefBand[]
  /** Catch-all preference -> the instance that owns it. */
  catchAll: Map<number, BindingInstanceRecord>
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
  const catchAll = new Map<number, BindingInstanceRecord>()
  const instanceById = new Map<string, BindingInstanceRecord>()
  let lowestManaged = Math.min(rules.directPrefBase, rules.rulePrefBase)

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
      catchAll.set(pref, record)
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
  const directByPref = new Map<number, DirectClaim>()
  for (const record of input.direct) {
    directByPref.set(record.pref, {
      name: record.name,
      wan: record.wan,
      ip: resolveTarget(record.target, leaseByMac)
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
    managedIps: [
      ...assignmentByIp.keys(),
      ...[...directByPref.values()].map((claim) => claim.ip).filter(Boolean)
    ]
  }
}

function inBand(pref: number, band: PrefBand): boolean {
  return pref >= band.from && pref < band.to
}

/** The verdict, plus the one clause that says how it was reached. */
interface Verdict {
  kind: ScanOwnerKind
  ownership: string
}

function decide(
  rule: ScanRuleLine,
  bands: Bands,
  input: ScanClassifyInput
): Verdict {
  // A stored record sitting at exactly this preference, written for exactly
  // this address, is the evidence. The preference on its own is not: nothing
  // stops somebody else's rule from being numbered where this module numbers
  // its own, and crediting that rule to a binding is the exact mistake this
  // feature exists to prevent, made in the module's own voice. A rule inside
  // the live one-to-one band with no record behind it is still unattributed and
  // falls through, which is the only thing that band was ever able to tell us
  // that the record does not.
  //
  // The second piece of evidence is the address rather than the record's
  // stamped table because a held binding is re-pointed at the blackhole table
  // while keeping its address and its preference, and matching on the table
  // would have called every held one-to-one binding on the router foreign - a
  // fresh way of saying the wrong thing about the rules this module wrote.
  const claim = bands.directByPref.get(rule.pref)
  if (claim) {
    if (rule.ip && rule.ip === claim.ip) {
      const target = claim.wan ? ` to send that address out ${claim.wan}` : ''
      return {
        kind: 'direct',
        ownership: `This is the one-to-one binding "${claim.name}", which this module wrote${target}.`
      }
    }
    const written = claim.ip
      ? `that binding is written for ${claim.ip} and this rule is not`
      : 'that binding names a device this module cannot resolve an address for right now'
    return {
      kind: 'foreign',
      ownership:
        `This module did not write this rule. It does sit at preference ${rule.pref}, ` +
        `which is where this module writes the one-to-one binding "${claim.name}" - but ` +
        `${written}, so the shared preference is a coincidence rather than evidence of who wrote it.`
    }
  }

  const assignment = rule.ip ? bands.assignmentByIp.get(rule.ip) : undefined
  if (assignment && bands.instance.some((band) => inBand(rule.pref, band))) {
    const named = bands.instanceById.get(assignment.instance)?.name ?? assignment.instance
    return {
      kind: 'instance',
      ownership: `This module wrote it - binding instance "${named}" has that address assigned to ${assignment.wan}.`
    }
  }

  const owner = bands.catchAll.get(rule.pref)
  if (owner) {
    return {
      kind: 'catchAll',
      ownership: `This is the fail-closed catch-all for binding instance "${owner.name}": an address on that LAN with no WAN of its own is parked here rather than let out through the router's default connection.`
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

  if (input.capabilities.mwan3.config) {
    return {
      kind: 'mwan3',
      ownership:
        'mwan3 is configured on this router and this rule sits outside every band this module writes, so mwan3 is what put it there. This module will not touch it.'
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
 * Whether a rule numbered below the managed bands could actually take traffic
 * from one of the rules this module wrote.
 *
 * "A binding shown as applied is not where the traffic actually goes" is a
 * heavy sentence, and it was being said of any rule with a low enough
 * preference - a `from 10.0.0.0/8 lookup vpn` on a router whose bindings all
 * live in 192.168.1.0/24, a `iif wg0` rule that no LAN address will ever match.
 * A preference only outranks something if there is something underneath it, so
 * the question is asked of the selector: a rule with no source at all matches
 * every packet a managed rule would have, and a rule with one has to cover an
 * address this module actually placed.
 */
function couldReachManaged(rule: ScanRuleLine, managed: readonly string[]): boolean {
  if (!rule.ip) return true
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
      tableLabel: tableLabel(rule.table),
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
