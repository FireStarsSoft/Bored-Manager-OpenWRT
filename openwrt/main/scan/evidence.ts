/**
 * Where a rule actually leads, and the sentence that says so.
 *
 * A row of numbers is not an explanation. `19003 / 192.168.1.50 / 42` tells a
 * person nothing at all unless they already know what table 42 is, and the
 * whole reason this monitor exists is that nobody does - the rules it finds
 * were written months ago, by somebody else, for a reason nobody wrote down.
 * So every row carries one plain sentence assembled from the same evidence the
 * verdict was reached on: the priority, the table, the interface that table's
 * default route actually leaves through, and what the main table would have
 * done with the same packet.
 *
 * The honest variants matter more than the happy one. A table with no default
 * route means the address has no way out at all; a rule below this module's own
 * band means every binding this module reports as applied is a fiction. Both
 * are silent failures, and a monitor that only knew how to say "bound to
 * wan_bm0" would report them as normal.
 */
import type { IfaceState, RouterModel } from '../types'
import { tableLabel } from './parse'
import type { ScanReadout, ScanRuleLine } from './types'

/** Where a table's traffic leaves, once the route has been resolved to a WAN. */
export interface ScanExit {
  /** The Linux netdev the default route names, e.g. `pppoe-bm0`. */
  device: string
  /** The UCI network section that device belongs to, when one can be found. */
  wan: string
  wanIp: string
  /** The default route as printed; empty when the table has none. */
  route: string
  /** The table deliberately answers "unreachable", which is the module's hold state. */
  blackholed: boolean
}

export const NO_EXIT: ScanExit = {
  device: '',
  wan: '',
  wanIp: '',
  route: '',
  blackholed: false
}

/**
 * The interface a netdev belongs to, in that order of confidence.
 *
 * Both spellings are checked because both are true at different times: a
 * static WAN's `device` is its netdev, and a PPPoE WAN's netdev is its
 * `l3_device` while `device` still names the ethernet underneath it. Matching
 * only one of the two is how `pppoe-bm0` came back unresolved on exactly the
 * routers this feature is for.
 *
 * They are two passes rather than one `||` because the second spelling is not
 * unique and the first is. Every PPPoE session in a pool carries the same
 * shared carrier as its `device`, so a default route that leaves through the
 * raw carrier matched whichever session happened to sit first in `ifaces` -
 * and the row then named a WAN the traffic has nothing to do with, in a
 * sentence written to be believed. An ambiguous fallback answers null instead,
 * which degrades the sentence to the bare netdev name: less than the reader
 * wanted, and true.
 */
function ifaceForDevice(model: RouterModel | null, device: string): IfaceState | null {
  if (!model || !device) return null
  const exact = model.ifaces.find((iface) => iface.l3Device === device)
  if (exact) return exact
  const carried = model.ifaces.filter((iface) => iface.device === device)
  return carried.length === 1 ? carried[0] : null
}

/** The routes captured for one lookup token, main included. */
export function routesFor(readout: ScanReadout, token: string): string[] {
  const number = /^\d+$/.test(token) ? Number(token) : null
  if (token === 'main' || number === 254) return readout.mainDefaults
  return readout.routes[token] ?? []
}

/**
 * Follow one table to its exit.
 *
 * A table with no default route is not an error to be swallowed: it is the
 * whole of the answer, and `route` staying empty is what the sentence builder
 * reads to say so. `unreachable default` is kept apart from "nothing at all"
 * because they mean opposite things - one is this module holding an address on
 * purpose, the other is a table somebody forgot to finish.
 */
export function resolveExit(
  model: RouterModel | null,
  routes: readonly string[]
): ScanExit {
  const blackholed = routes.some((line) => /^(?:unreachable|blackhole|prohibit)\s+default\b/.test(line))
  const route = routes.find((line) => /^default\b/.test(line)) ?? ''
  if (!route) return { ...NO_EXIT, blackholed }
  const device = route.match(/\bdev\s+([A-Za-z0-9_.:@-]{1,32})/)?.[1] ?? ''
  const iface = ifaceForDevice(model, device)
  return {
    device,
    wan: iface?.name ?? '',
    wanIp: iface?.ipv4?.addr ?? '',
    route,
    blackholed
  }
}

/** `pppoe-bm0 (wan_bm0, 100.64.3.7)`, degrading to whichever parts are known. */
function exitLabel(exit: ScanExit): string {
  if (!exit.device) return ''
  const detail = [exit.wan, exit.wanIp].filter(Boolean).join(', ')
  return detail ? `${exit.device} (${detail})` : exit.device
}

/**
 * What the router would have done with the packet if this rule were not there.
 *
 * The three cases are branched on the route first and the device second,
 * because the device is the part that is allowed to be missing from a route
 * that exists. `ip route show` prints a load-balanced default across several
 * lines - the head, then a `nexthop via ... dev ...` per WAN - and the scan
 * command's `grep '^default'` keeps the head, so a router balancing over two
 * WANs hands this a real default route that names no single `dev`. Read as "no
 * device, therefore no default route" it told that reader their router had no
 * way out at all, which is a sentence they would have acted on.
 */
function mainClause(main: ScanExit): string {
  if (main.device) {
    return `the main table's default leaves through ${main.wan || main.device}`
  }
  if (main.route) {
    return "the main table's own default names no single interface"
  }
  return 'the main table has no default route of its own'
}

export interface EvidenceInput {
  rule: ScanRuleLine
  exit: ScanExit
  main: ScanExit
  /** The table offers no way out, and the scan is sure enough to say so. */
  unreachable: boolean
  /** This rule is numbered below every preference this module writes at. */
  belowModule: boolean
  /** ...and it could actually take traffic from a rule this module wrote. */
  outranksModule: boolean
  /** Who wrote it, already decided, in one clause of its own. */
  ownership: string
}

/**
 * The first sentence: what the rule does, before anything is known about who
 * wrote it or where the table goes.
 *
 * A rule with no `from` gets a different one rather than a blank address. It
 * selects on a mark, an inbound interface or a protocol, so it is reported -
 * "shown, never touched" applies to it as much as to any other - but it is
 * never attributed to an address it does not name, because that attribution
 * would be invented.
 */
function actionSentence(rule: ScanRuleLine): string {
  const table = tableLabel(rule.table)
  if (!rule.table) {
    return `A priority-${rule.pref} rule matching ${rule.ip || rule.selector || 'all traffic'} names no routing table, so the kernel acts on it directly rather than looking anything up.`
  }
  if (rule.ip) {
    return `${rule.ip} has a priority-${rule.pref} policy rule that sends its traffic to routing table ${table} before the main table is consulted.`
  }
  const selector = rule.selector || 'every packet'
  return `A priority-${rule.pref} policy rule selecting on ${selector} sends matching traffic to routing table ${table} before the main table is consulted. It does not select on a source address, so it is not attributed to one here.`
}

/** The second sentence: whether that table is actually a way out. */
function exitSentence(input: EvidenceInput): string {
  const table = tableLabel(input.rule.table)
  if (!input.rule.table) return ''
  if (input.exit.blackholed) {
    return `Table ${table} answers unreachable for its default route, so traffic matching this rule is parked with no way out rather than quietly falling back to the default connection.`
  }
  if (input.unreachable) {
    return `Table ${table} currently has no default route, so this traffic has no way out while the rule stands.`
  }
  if (!input.exit.route) {
    return `Table ${table}'s routes could not be read in this scan, so where it leads is not known.`
  }
  const label = exitLabel(input.exit)
  return `Table ${table}'s default route leaves through ${label || 'an interface this router did not name'}; ${mainClause(input.main)}.`
}

/** The third: the consequence, which is the only part most people read. */
function consequenceSentence(input: EvidenceInput): string {
  if (!input.rule.ip) return ''
  if (input.unreachable || input.exit.blackholed || !input.exit.route) return ''
  if (input.exit.wan) {
    return `So this address does not use the router's default connection - it is bound to ${input.exit.wan}.`
  }
  return `So this address does not use the router's default connection.`
}

/**
 * The whole explanation. Assembled rather than templated because the honest
 * variants drop clauses instead of filling them with an empty string - a
 * sentence reading "it is bound to ." is worse than no sentence at all.
 */
export function buildReason(input: EvidenceInput): string {
  const parts = [
    actionSentence(input.rule),
    exitSentence(input),
    consequenceSentence(input),
    input.ownership
  ]
  // The preference and the consequence are two different statements, and only
  // the first of them is a fact about this rule alone. "A binding shown as
  // applied is not where the traffic actually goes" was being said on routers
  // where this module has never written a rule at all, and about rules whose
  // source cannot touch a managed address - a red badge and an accusation over
  // a rule that is doing nothing to anybody. So the low preference is still
  // reported, and the consequence waits until there is something for the rule
  // to outrank.
  if (input.outranksModule) {
    parts.push(
      'This rule outranks every rule this module writes, so a binding shown as applied is not where the traffic actually goes.'
    )
  } else if (input.belowModule) {
    parts.push(
      'This rule is numbered below every preference this module writes at, so the kernel consults it before any of them.'
    )
  }
  return parts.filter(Boolean).join(' ')
}
