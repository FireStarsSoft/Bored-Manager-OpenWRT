/**
 * Whether the interfaces an instance is about are the ones the operator meant:
 * that the pool is made of uplinks, that the LAN is one the router serves, and
 * that no member's own subnet collides with the LAN being bound.
 *
 * These three run together because they answer one question from three angles,
 * and because the first of them was for a long time the only one asked.
 */
import type { ModuleCheckFinding } from '@shared/check'
import { wanIsLanRefusal, type RouterLayout } from '../direct'
import type { IfaceState } from '../types'
import { parseCidr, subnetsOverlap } from '../util'
import { lanCidr } from './pool'

/**
 * Whether the router's own configuration agrees that the pool is made of
 * uplinks, and that the LAN is one it actually serves.
 *
 * `poolIfaces` collects an interface by its protocol and by the device it
 * terminates on, and neither of those says an interface is not a LAN: every LAN
 * on the router runs proto static too, and a LAN that is not a bridge - a VLAN,
 * a plain port, a wireless netdev - is a device name away from looking exactly
 * like a WAN port. So a carrier naming a device a second LAN happens to sit on
 * put that LAN in the pool, and binding a client to it sends the client out of
 * one of the router's own LANs while the page calls it bound.
 *
 * What the router does state is /etc/config/dhcp. An interface it hands
 * addresses out on is a LAN whatever it is plugged into, and one it explicitly
 * ignores is not - which is the half that makes this safe on an untouched
 * router, where `config dhcp 'wan'` exists and is switched off with exactly
 * that line.
 *
 * Two facts that disagree are reported as disagreeing rather than settled here:
 * `pppoe` and `dhcp` say uplink on their own, so an interface that both dials
 * and serves is left in the pool with a warning naming both halves.
 */
export function poolIdentityFindings(
  context: {
    lan: string
    carrier: string
    pool: readonly IfaceState[]
    served: ReadonlyMap<string, boolean>
  },
  findings: ModuleCheckFinding[]
): void {
  if (context.served.get(context.lan) === false) {
    findings.push({
      level: 'warning',
      label: `The router's DHCP server is switched off for LAN "${context.lan}"`,
      detail: `WAN Binding follows DHCP leases, so with option ignore set on ${context.lan} in /etc/config/dhcp no client on it ever gets one and this instance would have nothing to bind.`
    })
  }
  for (const iface of context.pool) {
    if (context.served.get(iface.name) !== true) continue
    if (iface.proto === 'static') {
      findings.push({
        level: 'error',
        label: `WAN "${iface.name}" is a LAN: the router hands out DHCP addresses on it`,
        detail: `Carrier ${context.carrier} put it in this pool because it runs proto static on that device, but /etc/config/dhcp serves ${iface.name}, which an uplink does not. Bound clients would leave through one of the router's own LANs. Scope the carrier to the uplink device instead.`
      })
    } else {
      findings.push({
        level: 'warning',
        label: `WAN "${iface.name}" both dials an uplink and serves DHCP`,
        detail: `It runs proto ${iface.proto}, which says uplink, while /etc/config/dhcp hands out addresses on it, which says LAN. Nothing here can tell which it really is, so it stays in the pool - check it is the interface you meant.`
      })
    }
  }
}

/**
 * The pool members the classifier reads as one of the router's own LANs.
 *
 * `poolIdentityFindings` above asks /etc/config/dhcp and nothing else, so it can
 * only speak about a LAN this router serves addresses on. A LAN whose DHCP comes
 * from a box downstream, or a static-only VLAN, has no `config dhcp` section at
 * all: the lookup returns nothing, the loop skips it, and the pool keeps it. The
 * classifier weighs six facts rather than one and had already scored exactly
 * that interface `lan` with its evidence written out - it was simply never
 * asked, so the create wrote `option ip4table` onto the router's own second LAN
 * and began handing it out as a WAN.
 *
 * It is the same refusal `direct/check.ts` gives for a single WAN port, in the
 * same words, because it is the same mistake made in bulk. An `unclear` verdict
 * says nothing at all: an interface the configuration does not place is not
 * evidence of anything, and refusing on it would put us back to a confident
 * refusal about a router the operator does not recognise.
 *
 * One finding per member rather than one naming them all: each carries the
 * evidence read about that interface, and a carrier scoped a device too wide
 * usually pulls in one wrong interface rather than several.
 */
export function poolIsLanFindings(
  context: { pool: readonly IfaceState[]; layout: RouterLayout },
  findings: ModuleCheckFinding[]
): void {
  for (const iface of context.pool) {
    const verdict = context.layout.byName.get(iface.name)
    if (verdict?.role === 'lan') findings.push(wanIsLanRefusal(verdict))
  }
}

/**
 * A WAN in the pool whose own subnet overlaps the LAN being bound.
 *
 * Two things break at once and neither is visible on any page. The catch-all
 * selects on source over the whole LAN, so it covers the uplink's own address
 * and the router's traffic out of it lands in a table holding `unreachable`;
 * and a client bound to that WAN looks the LAN up in the WAN's own routing
 * table, where the connected route points at the uplink - so traffic between
 * two clients of the LAN leaves through the modem. A double-NAT uplink handed
 * an address in the same private range as the LAN is the ordinary way to arrive
 * here, and it is arithmetic rather than a judgement, so it is refused.
 */
export function poolOverlapFindings(
  context: { cidr: string | null; pool: readonly IfaceState[] },
  findings: ModuleCheckFinding[]
): void {
  const lanSubnet = context.cidr ? parseCidr(context.cidr) : null
  if (!lanSubnet) return
  for (const iface of context.pool) {
    const wanCidr = lanCidr(iface)
    const wanSubnet = wanCidr ? parseCidr(wanCidr) : null
    if (!wanSubnet || !subnetsOverlap(lanSubnet, wanSubnet)) continue
    findings.push({
      level: 'error',
      label: `WAN "${iface.name}" sits in ${wanCidr}, which overlaps the LAN ${context.cidr}`,
      detail: 'Source-only IPv4 rules cannot separate the two: the catch-all would cover this uplink\'s own address, and a client bound to it would route the rest of its LAN out through the uplink. Renumber one of the two subnets.'
    })
  }
}
