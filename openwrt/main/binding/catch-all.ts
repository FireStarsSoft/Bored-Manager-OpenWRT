/**
 * The two things an instance's fail-closed catch-all is made of: which source
 * blocks its safety rule selects, and the connected route that keeps the router
 * answering on the LAN it is blackholing.
 *
 * They live together in one file because three paths have to arrive at exactly
 * the same answer - the create job installs them, the per-tick repair rebuilds
 * whatever does not match, and a Delete that fails half way puts them back. Two
 * derivations would disagree the first time a range decomposed into a different
 * number of blocks, and the repair, which rebuilds whatever does not match,
 * would then tear the group down and write it again on every fast tick, for
 * ever.
 */
import type { BindingInstanceRecord } from '../store'
import type { IfaceState } from '../types'
import { rangeToCidrs } from '../util'
import { catchAllLocalRoute } from './rules'

/**
 * The source CIDRs one instance's fail-closed catch-all is written for.
 *
 * A whole-LAN instance gets its LAN, exactly as every instance always has. A
 * range instance gets the minimal set of blocks covering its range and nothing
 * wider, because the planner only ever hands an assignment to a lease inside
 * that range: a whole-LAN catch-all would put every other device on the LAN
 * behind an unreachable table with no assignment rule ever coming to lift it
 * out, so creating one range instance would take the rest of the LAN off the
 * internet with nothing on the page saying why.
 *
 * A range that cannot be decomposed falls back to the whole LAN rather than to
 * nothing: a catch-all covering no address at all is an instance that has
 * silently stopped being fail-closed.
 */
export function catchAllCidrs(
  instance: Pick<BindingInstanceRecord, 'source'>,
  lanCidr: string
): string[] {
  const source = instance.source
  if (source?.kind !== 'range') return [lanCidr]
  const blocks = rangeToCidrs(source.from, source.to)
  return blocks.length ? blocks : [lanCidr]
}

/**
 * The device an instance's LAN carries IPv4 on, or '' when this sample does not
 * name one.
 *
 * `l3Device` first, because that is the interface layer 3 actually leaves by.
 * `device` behind it, because a LAN is not always a bridge and a device name is
 * not a fact about what an interface is: on a LAN that is a plain port, a VLAN
 * or a wireless netdev the two fields are the same string, and on a sample that
 * filled in only one of them the other is not a guess but the only thing the
 * router said. What is still never guessed is a name nobody reported - a
 * connected route pointing at the wrong interface is worse than the blackhole
 * it softens - so both being absent stays ''.
 */
function lanRouteDevice(iface: IfaceState | undefined): string {
  return iface?.l3Device || iface?.device || ''
}

/**
 * The connected route for one instance's LAN inside the catch-all table, or ''
 * when there is no device to write it against.
 *
 * The catch-all rule selects on *source* and the blocks it selects contain the
 * router's own LAN address, so without this the router's replies on that LAN
 * are looked up in a table whose only route is `unreachable` and it stops
 * answering SSH, ping and ARP on the very interface being bound. The route is
 * the whole subnet however narrow the bound range is: reachability is
 * destination-scoped, and narrowing it to the range would take the router off
 * its own network for every address outside it.
 */
export function lanLocalRoute(
  iface: IfaceState | undefined,
  cidr: string,
  table: number
): string {
  const device = lanRouteDevice(iface)
  return device ? catchAllLocalRoute(table, cidr, device) : ''
}
