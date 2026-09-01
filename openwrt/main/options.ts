import type { FormFieldOption } from '@shared/module-ui'
import type { OwrtHostData } from './store'
import type { IfaceState, RouterModel } from './types'

export type OpenWrtOptionKind =
  | 'lan-ifaces'
  | 'carriers'
  | 'binding-carriers'
  | 'wan-ports'

/** The order every dropdown here is read in: by what the row says, then by what it is. */
function sortOptions(options: FormFieldOption[]): FormFieldOption[] {
  return [...options].sort(
    (a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value)
  )
}

function uniqueSorted(options: FormFieldOption[]): FormFieldOption[] {
  const byValue = new Map<string, FormFieldOption>()
  for (const option of options) {
    if (option.value && !byValue.has(option.value)) byValue.set(option.value, option)
  }
  return sortOptions([...byValue.values()])
}

/** Linux IFNAMSIZ: past 15 visible characters netifd truncates in silence. */
const MAX_DEVICE_NAME = 15
const DEVICE_BASE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/
const VLAN_TAG = /^\d{1,4}$/

/**
 * A device name split into the device and the VLAN tags riding on it, or null
 * when it is not a name a carrier could have.
 *
 * The dot is the whole point: many ISPs hand out the uplink on a tagged VLAN,
 * so `wan.835` is the carrier, and nothing downstream had to change for it -
 * `carrierMatches` already puts a WAN on `eth1.835` inside `eth1`, and
 * `carrierScopesOverlap` already knows `eth1.835` and `eth1.836` are two
 * different uplinks. It is only accepted as a VLAN tag, so a stray dot cannot
 * turn a name the kernel would refuse into an option in a dropdown.
 */
function carrierParts(device: string): { base: string; tags: string[] } | null {
  if (device.length > MAX_DEVICE_NAME) return null
  const [base = '', ...tags] = device.split('.')
  if (!DEVICE_BASE.test(base)) return null
  if (!tags.every((tag) => VLAN_TAG.test(tag))) return null
  return { base, tags }
}

/**
 * Devices that reach no ISP whatever is tagged on top of them: the loopback,
 * the netdev this module creates *over* a carrier rather than beside one, and
 * the tunnel, mirror and container families.
 */
function isExcludedDevice(base: string): boolean {
  const lower = base.toLowerCase()
  return (
    lower === 'lo' ||
    lower.startsWith('pppoe-') ||
    lower.startsWith('ifb') ||
    lower.startsWith('tun') ||
    lower.startsWith('tap') ||
    lower.startsWith('wg') ||
    lower.startsWith('veth') ||
    lower.startsWith('docker') ||
    lower.startsWith('incus')
  )
}

/** A refusal worded for the check report, so the gate can say why. */
export interface CarrierRefusal {
  label: string
  detail: string
}

/**
 * Why a device may not be a PPPoE batch carrier, or null when it may be one.
 *
 * The dropdown and the check gate ask this one question, because they used to
 * answer it differently. The dropdown has always refused a tagged device - that
 * form takes a VLAN of its own and builds `<carrier>.<vid>` itself - while the
 * gate only asked `isSafeDeviceName`, where a dot is legal because the binding
 * half needs it there. So a hand-submitted `carrier=eth1.835` with VLAN 100 got
 * through a form that would never have offered it, and built device
 * `eth1.835.100` under section `bmv100` - a section whose whole job is to say
 * "VLAN 100 on the carrier" and which now describes something else.
 */
export function pppoeCarrierRefusal(device: string): CarrierRefusal | null {
  const parts = carrierParts(device)
  if (!parts) {
    // The submitted value is deliberately not quoted back: it is the one field
    // here that reached us unparsed, and a report is rendered, not escaped.
    return {
      label: 'Choose a valid carrier interface',
      detail: `A carrier is a device name of at most ${MAX_DEVICE_NAME} characters, such as eth1.`
    }
  }
  if (parts.tags.length > 0) {
    return {
      label: `Carrier ${device} is already a tagged VLAN device`,
      detail:
        `Choose ${parts.base} instead and set the VLAN in this form: it builds ` +
        `${parts.base}.<vid> itself, so a tagged carrier would dial on ` +
        `${device}.<vid>, a device nothing here created.`
    }
  }
  if (parts.base.toLowerCase().startsWith('br-')) {
    return {
      label: `Carrier ${device} is a bridge, not an uplink`,
      detail: 'Choose the device the ISP is reached through, or the VLAN riding on it.'
    }
  }
  if (isExcludedDevice(parts.base)) {
    return {
      label: `Carrier ${device} cannot reach an ISP`,
      detail: 'Loopback, tunnel, mirror and container devices are never carriers.'
    }
  }
  return null
}

function isPppoeCarrier(device: string): boolean {
  return pppoeCarrierRefusal(device) === null
}

/**
 * The WAN Binding carrier, which may be a VLAN as well as the device beneath
 * it. A bare bridge is still refused - a bridge is a LAN, not a WAN uplink -
 * but a tagged VLAN riding on one can be exactly that, which is how a router
 * carrying the ISP VLAN on the LAN bridge is wired.
 */
export function isBindingCarrier(device: string): boolean {
  const parts = carrierParts(device)
  if (!parts) return false
  if (parts.tags.length === 0 && parts.base.toLowerCase().startsWith('br-')) return false
  return !isExcludedDevice(parts.base)
}

/** The protocols an interface has to run before it can carry a bound address. */
const WAN_PORT_PROTOS = ['pppoe', 'dhcp', 'static']

/**
 * How many rows a dropdown may carry.
 *
 * The number is about the control and not about the router: past a few hundred
 * rows a select stops being a list anybody can read, and a payload pushed on
 * every form open stops being small. It is a ceiling, never a filter - which is
 * the distinction `fitWithinCap` below exists to keep, because the plain
 * truncation that used to sit here silently made it one.
 */
const MAX_OPTIONS = 500

/**
 * The protocols an interface can hold one of the router's own networks on.
 *
 * These are the two ways a router's own address arrives: written down, or taken
 * from a DHCP server further out - which is what a dumb AP and a downstream
 * router both do, and neither of them stops being a LAN for it. The protocols
 * left out are left out on what they say rather than on what they are called: a
 * `pppoe` interface is a session with one peer and no subnet behind it, and a
 * tunnel is an endpoint. `dhcp` is also what an uplink runs, so this list
 * cannot be the thing that decides - see the note at the dropdown itself.
 */
const LAN_PROTOS = ['static', 'dhcp']

/**
 * Where an interface sits in the WAN Binding dropdown, lowest first.
 *
 * `pppoe` and `dhcp` say the router is a client of the network on the other
 * side of that interface, which is what an uplink is; `static` says nothing at
 * all, because it is what every LAN on the router runs too.
 */
function wanPortRank(iface: IfaceState): number {
  if (iface.proto === 'pppoe') return 0
  if (iface.proto === 'dhcp') return 1
  return 2
}

/**
 * One candidate row, with the fact the cap has to weigh kept beside it.
 *
 * `pooledUnder` is the port a managed PPPoE pool rides on, with any VLAN tag
 * taken off, and null for every row that is not one of that pool's members. A
 * pool is up to five hundred sessions that all dial over one port - the pool
 * form builds `<carrier>.<vid>` per member, so their devices are `eth1.101`,
 * `eth1.102` and so on and only the base is common to them - which makes the
 * base the one thing in the sample that tells a pool apart from the separate
 * uplink beside it. `rank` is the order the caller would rather keep rows in
 * when it has to choose; where a list has no such preference every row carries
 * the same one and the name decides.
 */
interface CapRow {
  rank: number
  pooledUnder: string | null
  option: FormFieldOption
}

/**
 * Fit the candidates inside the cap without letting one PPPoE pool decide who
 * falls off.
 *
 * This used to be `.slice(0, 500)` at the end of each list, and on the one
 * router that reaches the cap that is a filter rather than a ceiling: a pool at
 * its documented maximum of five hundred members fills the list on its own, and
 * everything sorting after it - the separate uplink the operator opened the
 * form to bind out of - falls off the end. Nothing on screen said so, and the
 * field's own hint sends them to Refresh now, which cannot help: the device is
 * in the sample and was dropped after it arrived. That is the refusal this
 * module keeps re-inventing, wearing a dropdown instead of a sentence.
 *
 * Both lists a pool can fill are fitted here, because the two came off the same
 * mistake: WAN port lists one row per PPPoE session, WAN carrier lists one per
 * session *device*, and a full pool overflows either on its own. So the two
 * kinds of row are fitted differently, because only one of them comes in pools.
 * Every row that is not a pool member is kept - a router has a handful of those
 * and they are the rows most likely to be the answer, the bare port a pool of
 * VLANs on another port must never push off the end - and the members fill what
 * is left, taken round-robin over the port they ride on so that a pool on
 * `eth1` cannot crowd out the single session dialed on `eth2`. Nothing is
 * dropped that does not have to be: the members are exactly as selectable as
 * anything else here, and hiding the one an operator came for would be the same
 * bug pointed at the other half of the list.
 */
function fitWithinCap(rows: readonly CapRow[]): CapRow[] {
  if (rows.length <= MAX_OPTIONS) return [...rows]
  const byRankThenName = (a: CapRow, b: CapRow): number =>
    a.rank - b.rank || a.option.value.localeCompare(b.option.value)
  const kept = rows
    .filter((row) => row.pooledUnder === null)
    .sort(byRankThenName)
    .slice(0, MAX_OPTIONS)
  const queues = new Map<string, CapRow[]>()
  for (const row of rows) {
    if (row.pooledUnder === null) continue
    const queue = queues.get(row.pooledUnder) ?? []
    queue.push(row)
    queues.set(row.pooledUnder, queue)
  }
  const turns = [...queues]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, queue]) => queue.sort(byRankThenName))
  // One session from each port per pass, until the budget is spent or every
  // port has been emptied. A single pass would only be fair when the ports
  // carry equal numbers, which a pool and a lone session never do.
  for (let taken = true; taken && kept.length < MAX_OPTIONS; ) {
    taken = false
    for (const queue of turns) {
      if (kept.length >= MAX_OPTIONS) break
      const row = queue.shift()
      if (!row) continue
      kept.push(row)
      taken = true
    }
  }
  return kept
}

/**
 * The ports this router dials PPPoE over, which is where its pools are.
 *
 * The WAN carrier list is built from devices rather than from interfaces, so
 * the protocol is not on the row the cap weighs - `eth1.101` is a name, and
 * nothing in the name says a session is dialed on it. The sample does say so
 * one step away: the session's own interface names that device, and its base is
 * the carrier the whole pool rides on. A single untagged session on `eth1`
 * marks `eth1` too, which is right - a VLAN on a port that dials is in that
 * port's family whether the pool has one member or five hundred.
 */
function pppoeCarrierBases(model: RouterModel): PoolDevices {
  const bases = new Set<string>()
  const members = new Set<string>()
  for (const iface of model.ifaces) {
    if (iface.proto !== 'pppoe') continue
    members.add(iface.device)
    const base = carrierParts(iface.device)?.base
    if (base) bases.add(base)
  }
  return { bases, members }
}

/**
 * The pool seen two ways: the trunk ports its sessions dial over, and the
 * session devices themselves.
 *
 * Both are needed because a base alone cannot say what a tagged device is. An
 * ISP-style trunk carries the pool's VLANs and other things besides, and a
 * second uplink on one of those other VLANs is a device in its own right - not
 * a member queued behind five hundred sessions and dropped off the end of the
 * list.
 */
interface PoolDevices {
  bases: ReadonlySet<string>
  members: ReadonlySet<string>
}

/**
 * The pool a device belongs to, or null when it is a device in its own right.
 *
 * Only a tagged device can be a member: the base itself is the carrier the
 * sessions ride on and is exactly the row an operator picks to claim the whole
 * pool, so it is kept unconditionally alongside every other bare port.
 *
 * And only a tagged device a session actually dials over. Asking the base alone
 * counted every VLAN on a dialing trunk as pool membership, so a static second
 * uplink sharing that port entered the budget as one of five hundred and,
 * sorting after every `eth1.1xx`, was the row the cap ran out on - absent from
 * the only list that could have named it, with the field's own hint sending the
 * operator to Refresh, which cannot help a device that was in the sample and
 * then discarded.
 */
function poolMemberBase(device: string, pool: PoolDevices): string | null {
  const parts = carrierParts(device)
  if (!parts || parts.tags.length === 0) return null
  if (!pool.members.has(device)) return null
  return pool.bases.has(parts.base) ? parts.base : null
}

/**
 * Every interface a one-to-one binding could leave through, likeliest first.
 *
 * This list used to be filtered by the device name - anything terminating on a
 * `br-` device was left out - which is the same guess that made the check
 * refuse an address on a LAN that is not a bridge, running the other way: it
 * hid the WAN of every router whose modem port is bridged, and it offered the
 * LAN of every router whose LAN is a VLAN, a plain port or a radio. So nothing
 * is hidden here any more.
 *
 * Being permissive is the right trade for this one control. Listing an
 * interface that turns out to be a LAN costs a refusal the operator can read;
 * hiding the interface they actually need costs them the feature, with nothing
 * on screen to say why. The facts that would settle it live in /etc/config and
 * a dropdown may not read them - opening a form never starts an SSH command -
 * so the ordering below is built from the one uplink signal the RAM sample does
 * carry, and `checkDirect` is what refuses a pick that is really a LAN.
 *
 * The only thing that ever leaves the list is a row past the cap, and which row
 * that is has to be decided rather than fallen into - see `fitWithinCap`.
 */
function wanPortOptions(model: RouterModel): FormFieldOption[] {
  const seen = new Set<string>()
  const rows: CapRow[] = []
  for (const iface of model.ifaces) {
    if (iface.name === 'loopback' || !iface.name) continue
    if (!WAN_PORT_PROTOS.includes(iface.proto)) continue
    if (seen.has(iface.name)) continue
    seen.add(iface.name)
    // The protocol is named on every row because it is the whole of what
    // separates the top of this list from the bottom, and a list ordered by a
    // fact it does not print reads as an arbitrary order. The address is what a
    // person recognises the uplink by, and the state is here because binding to
    // a WAN that is down is allowed and should be a deliberate choice rather
    // than a surprise.
    const device = iface.l3Device || iface.device
    const kindWord = iface.proto === 'static' ? 'static' : `${iface.proto} uplink`
    const where = device ? ` on ${device}` : ''
    const address = iface.ipv4?.addr ? ` — ${iface.ipv4.addr}` : ''
    const state = iface.up && iface.ipv4 ? '' : iface.pending ? ' (dialing)' : ' (down)'
    rows.push({
      rank: wanPortRank(iface),
      pooledUnder:
        iface.proto === 'pppoe'
          ? carrierParts(iface.device)?.base || iface.device || iface.name
          : null,
      option: {
        value: iface.name,
        label: `${iface.name} — ${kindWord}${where}${address}${state}`
      }
    })
  }
  const kept = fitWithinCap(rows)
  kept.sort((a, b) => a.rank - b.rank || a.option.value.localeCompare(b.option.value))
  return kept.map((row) => row.option)
}

/**
 * Dropdown data comes only from the latest RAM model and the cached host
 * document. Opening a form never starts another SSH command.
 */
export function selectOptions(
  kind: unknown,
  model: RouterModel | null,
  _data: OwrtHostData
): FormFieldOption[] {
  if (!model) return []

  if (kind === 'lan-ifaces') {
    // Every interface that could be a LAN this instance distributes, on the
    // same terms the WAN port list is built on: an address to be scoped to, a
    // protocol that could belong to one of the router's own networks, and no
    // guess about which of them is really an uplink.
    //
    // This list used to drop the interface literally named `wan` and keep only
    // proto static, and both halves of that were the device-name guess wearing
    // different clothes. A second ISP or an LTE failover on `wan2` running
    // static was offered here as though it were a LAN, because the string did
    // not match; a LAN that takes its own address by DHCP - a dumb AP, a
    // downstream router - was hidden, with nothing on screen to say why, and
    // hiding is the failure that costs an operator the feature. A dropdown
    // cannot read /etc/config to settle it, so it does not try: it lists, and
    // `checkBinding` refuses a pick that reads as an uplink in a sentence that
    // names the evidence.
    return uniqueSorted(
      model.ifaces
        .filter(
          (iface) =>
            iface.name !== 'loopback' &&
            LAN_PROTOS.includes(iface.proto) &&
            iface.ipv4 != null &&
            // Not a naming guess but a device family, the same one
            // `isExcludedDevice` refuses: a `pppoe-` netdev has a peer at the
            // far end rather than a subnet, so there is no LAN behind it to
            // hand leases out on whatever protocol is reported over it.
            !iface.l3Device.startsWith('pppoe-')
        )
        .map((iface) => ({
          value: iface.name,
          // The protocol is named for the reason it is named on a WAN port row:
          // this list now mixes the two, and `dhcp` on a LAN is worth seeing,
          // since it is the router's own address that came from somewhere else.
          label: `${iface.name} — ${iface.proto} ${iface.ipv4?.addr}/${iface.ipv4?.mask}${
            iface.device ? ` on ${iface.device}` : ''
          }`
        }))
    ).slice(0, MAX_OPTIONS)
  }

  // The WAN a single address can be bound to. Unlike a carrier - which names a
  // device and scopes a whole pool of interfaces under it - this is one UCI
  // interface section, because a one-to-one binding points at exactly one
  // routing table and a table belongs to an interface rather than to a device.
  if (kind === 'wan-ports') return wanPortOptions(model)

  if (kind === 'carriers' || kind === 'binding-carriers') {
    // Two dropdowns, two rules: only the binding form may take a tagged device.
    const accepts = kind === 'carriers' ? isPppoeCarrier : isBindingCarrier
    const pooledBases = pppoeCarrierBases(model)
    const usedBy = new Map<string, Set<string>>()
    const add = (device: string, iface: string): void => {
      if (!accepts(device)) return
      const names = usedBy.get(device) ?? new Set<string>()
      names.add(iface)
      usedBy.set(device, names)
    }
    for (const iface of model.ifaces) {
      add(iface.device, iface.name)
      if (iface.proto !== 'pppoe') add(iface.l3Device, iface.name)
    }
    // A raw carrier can exist before it has a UCI interface section.
    for (const device of Object.keys(model.rates)) add(device, '')
    // The device is what the cap has to weigh here rather than the protocol:
    // this list holds one row per session *device*, and a pooled session
    // contributes `eth1.<vid>` through its own interface and again through the
    // rate counter beside it. `carriers` never reaches the cap - a tagged
    // device is refused above, so no pool member is ever in that list - but it
    // is fitted by the same call, because the difference between the two lists
    // should stay the one rule at the top of this branch.
    const rows: CapRow[] = [...usedBy].map(([device, names]) => {
      const labels = [...names].filter(Boolean).slice(0, 3)
      return {
        rank: 0,
        pooledUnder: poolMemberBase(device, pooledBases),
        option: {
          value: device,
          label: labels.length ? `${device} — ${labels.join(', ')}` : device
        }
      }
    })
    return sortOptions(fitWithinCap(rows).map((row) => row.option))
  }
  return []
}
