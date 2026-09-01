/**
 * What the router says each of its interfaces is, and every sentence the create
 * gate says about that answer.
 *
 * The first version of this decision was a guess about a device name: an
 * interface running pppoe, dhcp or static whose device did not begin with `br-`
 * was read as an uplink. That is true of a stock build and of nothing else. A
 * LAN on a VLAN (`eth0.1`), on a plain port (`eth0`) or on a radio (`wlan0`) was
 * therefore classified as a WAN, the LAN search returned an empty list, and
 * every address on that LAN was refused with "is not inside any LAN subnet on
 * this router" - a sentence about a router the operator does not have, and one
 * they could do nothing about. The same guess ran the other way in the WAN
 * dropdown, which hid the uplink of every router whose modem port is bridged.
 *
 * So nothing here reads a name. Each verdict is weighed from statements the
 * router actually makes - the dnsmasq sections in /etc/config/dhcp, the
 * masquerading flag on the firewall zone an interface is in, the IPv6 prefix it
 * delegates, and the protocol netifd reports - and none of them decides on its
 * own except the two protocols that can only mean one thing. Where the
 * statements do not settle it the answer is `unclear`, and the gate says so out
 * loud rather than choosing on the operator's behalf.
 */
import type { ModuleCheckFinding } from '@shared/check'
import {
  FIREWALL_ZONE,
  dhcpSectionNetwork,
  firewallZoneForNetwork,
  lanCidr,
  type RouterPreparationProbe,
  type UciDocument
} from '../binding'
import type { IfaceState, RouterModel } from '../types'
import { ifaceDevices, uciBoolean } from '../util'
import { lanForAddress } from './allocate'
import type { IfaceRole, IfaceVerdict, LanSearch, RouterLayout } from './types'

/**
 * The two protocols that settle an interface on their own: a router that dials
 * PPPoE or takes a DHCP lease on an interface is a *client* of the network on
 * the other side of it, and a router is not a client of its own LAN.
 */
const CLIENT_PROTOS = ['pppoe', 'dhcp']

/**
 * The dnsmasq options only a section that really hands out leases carries.
 *
 * `option ignore` is the first thing read about a section and it settles most
 * routers on its own - stock OpenWRT ships a `config dhcp 'wan'` that exists
 * solely to switch itself off with that line. These three are the second
 * reading, and they are here because the shared preparation dump is filtered:
 * if `ignore` ever stops being one of the keys it keeps, a stub section for the
 * uplink would come through looking exactly like a LAN's, and the difference
 * between "names it" and "is configured to serve on it" is what stops that
 * turning into a wrong answer instead of a weaker one.
 */
const SERVING_OPTIONS = ['limit', 'ra', 'dhcpv6']

/**
 * How much each statement counts for.
 *
 * They are small numbers on purpose. No single one of them decides an
 * interface, which is the whole correction being made here: a router is
 * described by several weak facts agreeing with each other, and the one
 * strong-looking fact this used to rest on turned out not to be a fact at all.
 */
const WEIGHT = {
  /** A dnsmasq section that names it without switching itself off. */
  namedByDhcp: 1,
  /** The only dnsmasq section naming it sets `option ignore`, as a WAN's does. */
  dhcpSwitchedOff: 1,
  /** `option ip6assign`, which delegates a prefix downstream - only a LAN does. */
  delegatesPrefix: 1,
  /** A firewall zone that does not masquerade on a router where another does. */
  quietZone: 1,
  /** `option gateway` on an interface the router still lets install a default. */
  gateway: 2,
  /** A firewall zone that masquerades, which is what a WAN zone is for. */
  masquerades: 2
}

/** Past every weight added together, for the protocols that admit no argument. */
const DECISIVE = 100

/** How many interfaces a finding may name before it stops being readable. */
const MAX_LISTED = 8

/**
 * Zone names reach findings, and they come off the router. Anything outside the
 * name this module is willing to write back is described rather than quoted.
 */
function zonePhrase(zone: string): string {
  return FIREWALL_ZONE.test(zone) ? `zone ${zone}` : 'a firewall zone with an unsupported name'
}

/** "a", "a and b", "a, b and c" - evidence read as one sentence. */
function clauses(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** Which zone names masquerade, by the name a zone answers to. */
function masqueradeByZone(firewall: UciDocument): Map<string, boolean> {
  const result = new Map<string, boolean>()
  for (const [key, type] of firewall.sectionTypes) {
    if (type !== 'zone' || !key.startsWith('firewall.')) continue
    const section = key.slice('firewall.'.length)
    const name = firewall.values.get(`firewall.${section}.name`) || section
    // Two sections can only share a name by mistake, and the safe reading of
    // that mistake is that a name any copy of which masquerades masquerades.
    const masq = uciBoolean(firewall.values.get(`firewall.${section}.masq`) ?? '')
    result.set(name, result.get(name) === true || masq)
  }
  return result
}

/**
 * What /etc/config/dhcp says about one interface: that leases are configured on
 * it, that a section merely names it, or that the only section naming it turns
 * itself off. Absent when the file says nothing at all.
 */
type DhcpStatement = 'serving' | 'named' | 'ignored'

/** Strongest LAN statement first, because two sections can name one network. */
const DHCP_RANK: Record<DhcpStatement, number> = { serving: 2, named: 1, ignored: 0 }

/**
 * What /etc/config/dhcp states about each interface it mentions.
 *
 * `option interface` is what a section is really about; the section name is the
 * fallback, because a hand-written `config dhcp 'guest'` sometimes leaves the
 * option out and means itself. That rule is `dhcpSectionNetwork` in the binding
 * folder's `uci-doc.ts` now, and every reader of /etc/config/dhcp in this tree
 * follows it - for a while this file and the capacity check applied it and the
 * pool-identity guard did not, so one router state was three different routers
 * depending on which reader was asked. It is restated rather than imported here
 * only because the binding barrel does not publish it.
 *
 * A second section for one network can only ever add service, so the strongest
 * statement wins: one that ignores the network cannot take back what another one
 * hands out.
 */
function dhcpByInterface(dhcp: UciDocument): Map<string, DhcpStatement> {
  const result = new Map<string, DhcpStatement>()
  for (const [key, type] of dhcp.sectionTypes) {
    if (type !== 'dhcp' || !key.startsWith('dhcp.')) continue
    const section = key.slice('dhcp.'.length)
    const name = dhcpSectionNetwork(dhcp, section)
    const serving = SERVING_OPTIONS.some((option) => {
      const value = dhcp.values.get(`dhcp.${section}.${option}`) ?? ''
      return value !== '' && value !== '0' && value !== 'disabled'
    })
    const statement: DhcpStatement = uciBoolean(dhcp.values.get(`dhcp.${section}.ignore`) ?? '')
      ? 'ignored'
      : serving
        ? 'serving'
        : 'named'
    const previous = result.get(name)
    if (previous && DHCP_RANK[previous] >= DHCP_RANK[statement]) continue
    result.set(name, statement)
  }
  return result
}

interface Statements {
  masquerading: ReadonlyMap<string, boolean>
  dhcpSections: ReadonlyMap<string, DhcpStatement>
  anyMasquerade: boolean
  /** The netdevs the main table's default route leaves by, straight from the kernel. */
  defaultRouteDevices: ReadonlySet<string>
}

function weigh(
  iface: IfaceState,
  probe: RouterPreparationProbe | null,
  stated: Statements
): IfaceVerdict {
  const lanEvidence: string[] = []
  const uplinkEvidence: string[] = []
  let lanScore = 0
  let uplinkScore = 0
  // The devices are handed over because a zone is allowed to name its members
  // either way and fw4 reads both. Without them a LAN put in its zone by
  // `list device` - a VLAN, a plain port, anything that is not a bridge - came
  // back with no zone at all, and this function then weighed neither the
  // masquerading reading nor the quiet-zone one about an interface the router
  // has perfectly clearly placed.
  const zone = probe
    ? firewallZoneForNetwork(probe.firewall, iface.name, ifaceDevices(iface))
    : ''
  const zoneMasquerades = zone !== '' && stated.masquerading.get(zone) === true

  if (CLIENT_PROTOS.includes(iface.proto)) {
    uplinkScore += DECISIVE
    uplinkEvidence.push(
      `it runs ${iface.proto}, so this router is a client of the network on the other side of it`
    )
  }
  // Decisive, and the only statement here that is not an inference. An uplink is
  // the interface everything else leaves by - that is what the word means - and
  // the kernel answers it outright. Every other reading below is this fact
  // guessed at from the shape of /etc/config, and each of those guesses has by
  // now been wrong on somebody's router.
  if (ifaceDevices(iface).some((device) => stated.defaultRouteDevices.has(device))) {
    uplinkScore += DECISIVE
    uplinkEvidence.push("the router's default route leaves by it")
  }
  // The statement that settles the one router nothing else here can read: an
  // uplink running the static protocol, on a private address, with no dnsmasq
  // stub to switch itself off and no masquerading zone. A modem in bridge mode
  // behind another router is that router, and so is a double-NAT lab and an ISP
  // handing out RFC1918. Every other reading below is either silent about it or
  // pointing the wrong way, so this one is worth as much as serving DHCP is.
  //
  // The key only arrives because the preparation dump's network filter in the
  // binding folder's uci-doc.ts keeps it, which it did not until this signal
  // was made to work: for a while the weight was declared here and the branch
  // could never be entered. Nothing about narrowing that grep again would look
  // like it touched this file, so the two are held together from the outside,
  // by tests/unit/openwrt-gateway-signal.test.ts running the real filter over a
  // written-down router rather than handing this function a probe by hand.
  // `option gateway` says less than it looks like it says, and it used to be
  // weighted as heavily as anything here. Any interface may carry one - a LAN
  // with an upstream box on it is written exactly that way - so on a real
  // router `LAN_WIRED`, handing out 250 leases in the zone named `lan`, was
  // called an uplink on the strength of this line alone. It is a tie-breaker
  // now, and cannot outweigh a single decisive statement either way.
  if (probe?.network.values.get(`network.${iface.name}.gateway`)) {
    uplinkScore += WEIGHT.gateway
    uplinkEvidence.push('/etc/config/network gives it a default gateway')
  }
  if (zoneMasquerades) {
    uplinkScore += WEIGHT.masquerades
    uplinkEvidence.push(`it is in ${zonePhrase(zone)}, which masquerades`)
  }

  const dhcp = stated.dhcpSections.get(iface.name)
  if (dhcp === 'serving') {
    // Decisive, and the only LAN statement that is. A router does not run a
    // DHCP server on the interface its own address came from - the stock
    // `config dhcp 'wan'` exists precisely to switch itself off - so a section
    // actually configured to hand out leases is the router saying "clients live
    // here" as plainly as it ever says anything.
    lanScore += DECISIVE
    lanEvidence.push('/etc/config/dhcp has it handing out DHCP leases')
  } else if (dhcp === 'named') {
    lanScore += WEIGHT.namedByDhcp
    lanEvidence.push('a section in /etc/config/dhcp names it and does not switch itself off')
  } else if (dhcp === 'ignored') {
    uplinkScore += WEIGHT.dhcpSwitchedOff
    uplinkEvidence.push('the only section in /etc/config/dhcp naming it sets option ignore')
  }
  if (probe?.network.values.get(`network.${iface.name}.ip6assign`)) {
    lanScore += WEIGHT.delegatesPrefix
    lanEvidence.push('it delegates an IPv6 prefix downstream (option ip6assign)')
  }
  if (zone !== '' && !zoneMasquerades && stated.anyMasquerade) {
    lanScore += WEIGHT.quietZone
    lanEvidence.push(
      `it is in ${zonePhrase(zone)}, which does not masquerade while another zone on this router does`
    )
  }

  // Two decisive statements pointing opposite ways is a real router state - an
  // interface that both takes a lease and serves them is a downstream router
  // wired as a LAN - and the honest answer to it is `unclear`, which is
  // searched rather than refused. Comparing the sums would have let one
  // decisive fact plus a tie-breaker quietly outvote the other.
  const bothDecisive = uplinkScore >= DECISIVE && lanScore >= DECISIVE
  const role: IfaceRole = bothDecisive
    ? 'unclear'
    : uplinkScore > lanScore
      ? 'uplink'
      : lanScore > uplinkScore
        ? 'lan'
        : 'unclear'
  return {
    name: iface.name,
    role,
    cidr: lanCidr(iface) ?? '',
    zone,
    zoneMasquerades,
    lanEvidence,
    uplinkEvidence
  }
}

/**
 * Weigh every interface in one sample against one reading of /etc/config.
 *
 * Pure, and the probe is passed in rather than fetched, so the whole of this
 * decision can be replayed against a router layout written down in a test - the
 * only way the class of bug being fixed here stays fixed.
 */
export function routerLayout(
  model: RouterModel,
  probe: RouterPreparationProbe | null
): RouterLayout {
  const masquerading = probe ? masqueradeByZone(probe.firewall) : new Map<string, boolean>()
  const dhcpSections = probe ? dhcpByInterface(probe.dhcp) : new Map<string, DhcpStatement>()
  const stated: Statements = {
    masquerading,
    dhcpSections,
    anyMasquerade: [...masquerading.values()].some(Boolean),
    defaultRouteDevices: probe?.defaultRouteDevices ?? new Set<string>()
  }
  const byName = new Map<string, IfaceVerdict>()
  for (const iface of model.ifaces) {
    if (iface.name === 'loopback') continue
    byName.set(iface.name, weigh(iface, probe, stated))
  }
  return { byName, stated: probe != null }
}

/**
 * The interfaces an address could be behind, split by how firmly the router
 * places them.
 *
 * The port this binding is about to leave through is put with the uplinks
 * whatever the configuration says about it: a WAN port supplies no firewall
 * *source* zone, so it can never be the LAN a forwarding is written from.
 */
export function lanCandidates(
  model: RouterModel,
  wan: string,
  layout: RouterLayout
): LanSearch {
  const search: LanSearch = { lans: [], unclear: [], uplinks: [] }
  for (const iface of model.ifaces) {
    if (iface.name === 'loopback' || lanCidr(iface) == null) continue
    const role = layout.byName.get(iface.name)?.role ?? 'unclear'
    if (iface.name === wan || role === 'uplink') search.uplinks.push(iface)
    else if (role === 'lan') search.lans.push(iface)
    else search.unclear.push(iface)
  }
  return search
}

/**
 * The LAN this binding will be written from: a stated one before one that is
 * merely not denied, and among equals the longest prefix.
 *
 * With no address to place - a MAC whose device has never taken a lease - there
 * is only one safe answer, and it is the router that has exactly one candidate.
 * Anything else would be a guess written into a firewall forwarding.
 */
export function chooseLan(search: LanSearch, resolved: string): IfaceState | undefined {
  if (!resolved) {
    const all = [...search.lans, ...search.unclear]
    return all.length === 1 ? all[0] : undefined
  }
  return lanForAddress(search.lans, resolved) ?? lanForAddress(search.unclear, resolved)
}

/** "lan 192.168.1.0/24, guest 192.168.3.0/24", bounded. */
function subnetList(ifaces: readonly IfaceState[]): string {
  const shown = ifaces
    .slice(0, MAX_LISTED)
    .map((iface) => `${iface.name} ${lanCidr(iface) ?? 'no IPv4 subnet'}`)
  const rest = ifaces.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

/**
 * Why no LAN was found, listing what was actually looked at.
 *
 * The old version of this said only that the address was in no LAN subnet,
 * which is the same sentence whether the router has six LANs and the operator
 * mistyped one octet or whether the search misclassified every LAN on the
 * router - and it was the second of those for months, with nothing on the page
 * able to tell the two apart. Every branch here names the subnets it searched.
 */
export function lanRefusal(
  resolved: string,
  search: LanSearch,
  layout: RouterLayout
): ModuleCheckFinding {
  const considered = [...search.lans, ...search.unclear]
  if (considered.length === 0) {
    const uplinks = search.uplinks.length
      ? ` Every interface here that carries a subnet reads as an uplink: ${subnetList(search.uplinks)}.`
      : ''
    return {
      level: 'error',
      label: 'This router has no LAN interface with an IPv4 subnet',
      detail: `A one-to-one binding forwards from the LAN the address sits on, and there is none to forward from.${uplinks} Give the LAN an address, run Refresh, then check again.`
    }
  }
  if (resolved) {
    const uplink = lanForAddress(search.uplinks, resolved)
    if (uplink) return uplinkAddressRefusal(resolved, uplink, layout)
    const skipped = search.uplinks.length
      ? ` Uplinks are not searched, and these were the ones skipped: ${subnetList(search.uplinks)}.`
      : ''
    return {
      level: 'error',
      label: `${resolved} is not inside any LAN subnet on this router`,
      detail: `A bound address needs a LAN interface behind it, because that interface's firewall zone is what the forwarding is written from. The LANs this check looked in were ${subnetList(considered)}.${skipped}`
    }
  }
  return {
    level: 'error',
    label: 'The device has to be seen on the network once before it can be bound',
    detail: `Its MAC has no DHCP lease, and this router has ${considered.length} LAN interfaces - ${subnetList(considered)} - so there is no way to tell which firewall zone the forwarding belongs in. Connect the device once, then check again.`
  }
}

/**
 * The address is real and the router does contain it - on the network the
 * router reaches the internet *through*.
 *
 * A refusal saying only "not inside any LAN subnet" is what started all of
 * this, so this one names the interface, the subnet, the evidence that made it
 * an uplink, and the two configuration statements that would change the answer
 * if the classification is the thing that is wrong.
 */
function uplinkAddressRefusal(
  resolved: string,
  iface: IfaceState,
  layout: RouterLayout
): ModuleCheckFinding {
  const verdict = layout.byName.get(iface.name)
  const because = verdict?.uplinkEvidence.length
    ? `, and ${clauses(verdict.uplinkEvidence)}`
    : ''
  return {
    level: 'error',
    label: `${resolved} is on ${iface.name}, which this router uses as an uplink rather than as a LAN`,
    detail: `${iface.name} carries ${lanCidr(iface) ?? 'that subnet'}${because}.${against(verdict)} That network is on the far side of this router, so it has no LAN firewall zone for the forwarding to be written from and a rule pointed at it would steer traffic the device never sends.${remedy(verdict, iface.name)}`
  }
}

/**
 * What argued the other way, when anything did.
 *
 * A verdict is a sum of small readings and the close ones are the ones worth
 * doubting, but both refusals used to quote only the evidence that won - so a
 * two-against-one reading reached the operator looking unanimous, and the one
 * fact on their side was never mentioned. A refusal that hides the contrary
 * fact it weighed is the same defect as one that never read the router.
 */
function against(verdict: IfaceVerdict | undefined): string {
  if (!verdict?.lanEvidence.length) return ''
  return ` Against that, ${clauses(verdict.lanEvidence)} - so this is a reading of the configuration rather than a certainty.`
}

/**
 * What would change the answer, minus whatever the router has already done.
 *
 * Telling an operator to give the interface a firewall zone that does not
 * masquerade, on a router where the classifier has just read that its zone does
 * not masquerade, is a remedy that cannot be carried out because it is already
 * in place - and it was the sentence a DMZ interface got.
 */
function remedy(verdict: IfaceVerdict | undefined, name: string): string {
  const quiet = verdict?.lanEvidence.some((line) => line.includes('which does not masquerade'))
  const served = verdict?.lanEvidence.some((line) => line.includes('/etc/config/dhcp'))
  const wants = [
    served ? '' : 'a section for it in /etc/config/dhcp',
    quiet ? '' : 'a firewall zone that does not masquerade'
  ].filter(Boolean)
  if (wants.length === 0) {
    return ` If ${name} really is a LAN here, nothing else in /etc/config says so - the readings above are all this router states about it.`
  }
  return ` If ${name} really is a LAN here, give it ${clauses(wants)}, run Refresh, then check again.`
}

/**
 * The chosen LAN is one the configuration does not actually place.
 *
 * Said rather than swallowed because this is the case the whole rewrite is
 * about: the forwarding is written once, from this interface's zone, and never
 * rewritten. Getting it wrong leaves the device with no firewall path at all,
 * and the create otherwise looks exactly like a create that worked.
 */
export function unsettledLanFinding(
  iface: IfaceState,
  layout: RouterLayout
): ModuleCheckFinding {
  const why = layout.stated
    ? 'Nothing in /etc/config/dhcp hands out leases on it and no firewall zone settles it either way.'
    : 'The router configuration could not be read on this check, so there was nothing to settle it with.'
  return {
    level: 'warning',
    label: `Nothing this router states says whether ${iface.name} is a LAN or an uplink`,
    detail: `${iface.name} carries the subnet the address is in, so it is the interface this binding would be written from. ${why} If it is really an uplink, the forwarding installed here would be written from the uplink's own zone and the device would end up with no path at all.`
  }
}

/**
 * The two halves of one decision, said in one voice.
 *
 * Both dropdowns are deliberately permissive now - hiding a real WAN, or a real
 * LAN, is worse than listing an extra interface, and neither dropdown can read
 * /etc/config to tell them apart - so this pair is where a pick the router's
 * own configuration contradicts has to stop. They are written next to each
 * other on purpose: it is the same verdict read from opposite ends, and the day
 * they explain themselves differently is the day the module has two opinions
 * about one interface.
 *
 * Neither of them ever speaks about an `unclear` verdict. That is the answer the
 * classifier gives when the configuration does not settle the interface, and a
 * refusal there would be exactly the confident sentence about an unread router
 * that all of this exists to stop.
 */

/** The port the form named is one the router describes as a LAN. */
export function wanIsLanRefusal(verdict: IfaceVerdict): ModuleCheckFinding {
  const because = verdict.lanEvidence.length
    ? `The router says so itself: ${clauses(verdict.lanEvidence)}.`
    : 'Its configuration places it on the inside of this router.'
  return {
    level: 'error',
    label: `${verdict.name} is a LAN on this router, not a WAN port`,
    detail: `${because} A one-to-one binding steers an address out through an uplink, so a rule pointed at a LAN would send it back the way it came and the device would reach nothing. Choose the interface this router reaches the internet through.`
  }
}

/**
 * The interface the form named as its LAN is one the router describes as an
 * uplink.
 *
 * This is the mirror above read the other way, and it is the more expensive of
 * the two to get wrong. A WAN port picked by mistake refuses to carry traffic
 * and the operator sees it; a LAN picked by mistake installs, and what it
 * installs is aimed at the network this router gets its own connection from.
 */
export function lanIsUplinkRefusal(verdict: IfaceVerdict): ModuleCheckFinding {
  const because = verdict.uplinkEvidence.length
    ? `The router says so itself: ${clauses(verdict.uplinkEvidence)}.`
    : 'Its configuration places it on the outside of this router.'
  const subnet = verdict.cidr
    ? `${verdict.cidr}, which is ${verdict.name}'s own subnet`
    : "that interface's own subnet"
  return {
    level: 'error',
    label: `${verdict.name} is an uplink on this router, not a LAN`,
    detail: `${because}${against(verdict)} An instance hands a WAN to every DHCP client it sees on the interface it is given, and writes its firewall forwardings from that interface's own zone - so this one would distribute the pool to whatever sits upstream of this router rather than to the clients behind it, and its fail-closed catch-all would be laid over ${subnet}. Under "DHCP LAN interface", choose the network the clients you want to bind are on.${remedy(verdict, verdict.name)}`
  }
}
