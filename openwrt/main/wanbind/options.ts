/**
 * The three dropdowns the binding forms open on: which interface an address
 * leaves by, which LAN an instance hands out on, and which carrier a pool of
 * WANs sits under.
 *
 * All three are the router's answer now. They used to be built from the RAM
 * sample by reading device names - anything on a `br-` device was a LAN,
 * anything called `wan` was an uplink - which is true of a stock build and of
 * nothing else. It hid the uplink of every router whose modem port is bridged,
 * and it offered, then refused, every address behind a LAN that is a VLAN, a
 * plain port or a radio. The daemon weighs the same interfaces against
 * /etc/config, the firewall zones and the kernel's own default route, and says
 * which side of the router each one is on *and why*.
 *
 * So nothing here is hidden on a verdict. An interface the router reads the
 * other way round is listed, ordered below the ones that fit, and labelled with
 * the router's own clauses - because listing an interface that turns out to be
 * the wrong side costs a refusal somebody can read, and hiding the interface
 * they actually need costs them the feature with nothing on screen to say why.
 * The only thing that ever leaves a list is a row past the cap, and which row
 * that is has to be decided rather than fallen into - see `fitWithinCap`.
 */
import type { FormFieldOption } from '@shared/module-ui'
import {
  wanbindLayoutV2,
  wanbindWans,
  type WanbindVerdict,
  type WanbindWan
} from '../agent'
import { agentDeps, daemonReady } from './runtime'
import type { BindingRuntime } from './types'

/** Linux IFNAMSIZ: past 15 visible characters netifd truncates in silence. */
const MAX_DEVICE_NAME = 15
const DEVICE_BASE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/
const VLAN_TAG = /^\d{1,4}$/

/**
 * How many rows a dropdown may carry.
 *
 * The number is about the control and not about the router: past a few hundred
 * rows a select stops being a list anybody can read, and a payload pushed on
 * every form open stops being small. It is a ceiling, never a filter - which is
 * the distinction `fitWithinCap` exists to keep.
 */
const MAX_OPTIONS = 500

/** How much of the router's reasoning fits under one option before it stops helping. */
const MAX_EVIDENCE = 160

/**
 * A device name split into the device and the VLAN tags riding on it, or null
 * when it is not a name a carrier could have.
 *
 * The dot is the whole point: many ISPs hand out the uplink on a tagged VLAN,
 * so `wan.835` is the carrier. It is only accepted as a VLAN tag, so a stray
 * dot cannot turn a name the kernel would refuse into an option in a dropdown.
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

/**
 * Whether a device may be the carrier a pool of WANs sits under.
 *
 * A bare bridge is refused - a bridge is a LAN, not an uplink - but a tagged
 * VLAN riding on one can be exactly that, which is how a router carrying the
 * ISP VLAN on the LAN bridge is wired.
 *
 * This is the one rule on this page that is still about a name rather than
 * about evidence, and that is because a carrier *is* a name: it is the prefix
 * an instance's pool is matched by, `eth1` covering `eth1.835`, so what is
 * being judged is the shape of the string and not which side of the router
 * anything is on. The copy in `main/options.ts` serves the dropdowns of the
 * halves that still write rules over SSH and goes with them.
 */
export function isBindingCarrier(device: string): boolean {
  const parts = carrierParts(device)
  if (!parts) return false
  if (parts.tags.length === 0 && parts.base.toLowerCase().startsWith('br-')) return false
  return !isExcludedDevice(parts.base)
}

/**
 * One candidate row, with the fact the cap has to weigh kept beside it.
 *
 * `pooledUnder` is the port a managed PPPoE pool rides on, with any VLAN tag
 * taken off, and null for every row that is not one of that pool's members. A
 * pool is up to five hundred sessions that all dial over one port, which makes
 * that port the one thing in the answer that tells a pool apart from the
 * separate uplink beside it. `rank` is the order the caller would rather keep
 * rows in when it has to choose.
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
 * This used to be `.slice(0, 500)`, and on the one router that reaches the cap
 * that is a filter rather than a ceiling: a pool at its documented maximum of
 * five hundred members fills the list on its own, and everything sorting after
 * it - the separate uplink the operator opened the form to bind out of - falls
 * off the end, with nothing on screen saying so and the field's own hint
 * sending them to Refresh, which cannot help a row that was in the answer and
 * then discarded.
 *
 * Every row that is not a pool member is kept: a router has a handful of those
 * and they are the rows most likely to be the answer. The members fill what is
 * left, taken round-robin over the port they ride on, so a pool on `eth1`
 * cannot crowd out the single session dialled on `eth2`.
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

function finish(rows: readonly CapRow[]): FormFieldOption[] {
  const kept = fitWithinCap(rows)
  kept.sort((a, b) => a.rank - b.rank || a.option.value.localeCompare(b.option.value))
  return kept.map((row) => row.option)
}

/**
 * The router's reasoning about one interface, as a phrase under the option.
 *
 * It arrives as a list of clauses rather than a sentence, so that a caller can
 * join them - which is what this is - and so that a caller that wants them one
 * per line can have that instead. Cut, because a select is a line of text and
 * an option that wrapped to four of them would push the rest of the list off
 * the screen it is meant to be read from.
 */
function evidenceLabel(clauses: readonly string[]): string {
  const joined = clauses
    .map((clause) => clause.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('; ')
  return joined.length > MAX_EVIDENCE ? `${joined.slice(0, MAX_EVIDENCE - 3)}...` : joined
}

/** The port a tagged device rides on, or null when the device is not tagged. */
function taggedBase(device: string): string | null {
  const parts = carrierParts(device)
  return parts && parts.tags.length > 0 ? parts.base : null
}

/** A pooled session's trunk port, or null when the row stands on its own. */
function pooledUnder(wan: WanbindWan): string | null {
  if (wan.proto !== 'pppoe') return null
  const device = wan.device || wan.l3Device
  return taggedBase(device) || device || wan.name
}

/**
 * Where an interface sits in the WAN port list, lowest first.
 *
 * The router's verdict rather than the protocol, which is the whole change: an
 * uplink is an uplink because of what /etc/config, the zones and the default
 * route say about it, and `static` - which used to sink a row to the bottom -
 * is what a fixed-address ISP connection and every LAN on the router both run.
 */
function wanPortRank(wan: WanbindWan): number {
  if (wan.role === 'uplink') return 0
  return wan.role === 'unclear' ? 1 : 2
}

function wanPortLabel(wan: WanbindWan): string {
  const device = wan.l3Device || wan.device
  const where = device ? ` on ${device}` : ''
  const address = wan.ipv4 ? ` — ${wan.ipv4.addr}/${wan.ipv4.mask}` : ''
  // `available` is the ordinary case and printing it on every row would be
  // noise; every other word is something to know before binding an address to
  // it, `bound` included - that WAN already carries somebody.
  const state = wan.state === 'available' ? '' : ` (${wan.state})`
  const evidence =
    wan.role === 'lan'
      ? ` — the router reads this as one of its own LANs: ${evidenceLabel(wan.evidence)}`
      : wan.role === 'unclear'
        ? ' — the router cannot tell which side of it this is'
        : ''
  return `${wan.name} — ${wan.proto || 'no protocol'}${where}${address}${state}${evidence}`
}

/**
 * Every interface a one-to-one binding could leave through, likeliest first.
 *
 * One `wans` call answers it, which is what makes this cheap enough for a form
 * to open on: netifd's dump, the router's own classification of it and what the
 * daemon is currently doing with each interface, in one round trip.
 *
 * Empty on any failure. A select with no options and a help line under it beats
 * a form that refuses to open.
 */
export async function wanPortOptions(runtime: BindingRuntime): Promise<FormFieldOption[]> {
  if (!runtime.ctx.connected || !daemonReady(runtime)) return []

  const result = await wanbindWans(agentDeps(runtime))
  if (!result.ok || !result.data) return []

  const rows: CapRow[] = []
  const seen = new Set<string>()
  for (const wan of result.data.wans) {
    // The router's own address lives on the loopback and no rule can send an
    // address out through it. Everything else is listed whatever it looks like.
    if (!wan.name || wan.name === 'loopback' || seen.has(wan.name)) continue
    seen.add(wan.name)
    rows.push({
      rank: wanPortRank(wan),
      pooledUnder: pooledUnder(wan),
      option: { value: wan.name, label: wanPortLabel(wan) }
    })
  }
  return finish(rows)
}

/**
 * Where a LAN sits in the instance's DHCP LAN list, lowest first.
 *
 * An interface with no IPv4 subnet is ranked below its own kind rather than
 * dropped: it cannot hand out leases as it stands, but an interface that is
 * merely down has no subnet either, and a LAN that vanishes from this list the
 * moment it goes down is a form somebody cannot fill in at exactly the moment
 * they are trying to fix the router.
 */
function lanRank(verdict: WanbindVerdict): number {
  const role = verdict.role === 'lan' ? 0 : verdict.role === 'unclear' ? 2 : 4
  return role + (verdict.cidr ? 0 : 1)
}

function lanLabel(verdict: WanbindVerdict): string {
  const where = verdict.device ? ` on ${verdict.device}` : ''
  const zone = verdict.zone ? `, zone ${verdict.zone}` : ''
  const evidence =
    verdict.role === 'uplink'
      ? ` — the router reads this as an uplink: ${evidenceLabel(verdict.uplinkEvidence)}`
      : verdict.role === 'unclear'
        ? ' — the router cannot tell which side of it this is'
        : ''
  return `${verdict.name} — ${verdict.cidr || 'no IPv4 subnet'}${where}${zone}${evidence}`
}

/**
 * Every interface an instance could hand leases out on, likeliest first.
 *
 * `layout` rather than `wans` because this list is about the router's own
 * networks: the subnet the instance is scoped to and the firewall zone its
 * forwardings are written against are what the classifier reads, and they are
 * what somebody picking a LAN recognises it by.
 *
 * A refusal - /etc/config unreadable - comes back as an empty interface list
 * and therefore as an empty dropdown, never as a list of guesses.
 */
export async function lanOptions(runtime: BindingRuntime): Promise<FormFieldOption[]> {
  if (!runtime.ctx.connected || !daemonReady(runtime)) return []

  const result = await wanbindLayoutV2(agentDeps(runtime))
  if (!result.ok || !result.data) return []

  const rows: CapRow[] = []
  const seen = new Set<string>()
  for (const verdict of result.data.interfaces) {
    if (!verdict.name || verdict.name === 'loopback' || seen.has(verdict.name)) continue
    seen.add(verdict.name)
    rows.push({
      // A pool's sessions are one tagged device per member, and they are the
      // only rows here that arrive five hundred at a time. Naming the trunk
      // they ride on is what stops them spending the whole budget between them
      // and pushing a LAN on another port off the end of the list.
      rank: lanRank(verdict),
      pooledUnder: taggedBase(verdict.device),
      option: { value: verdict.name, label: lanLabel(verdict) }
    })
  }
  return finish(rows)
}

/**
 * The devices a pool of WANs can sit under.
 *
 * Grouped by the router rather than here, and that is why this list cannot
 * overflow the way the other two can: five hundred PPPoE sessions on `eth1` are
 * one row, because a carrier is the device with the VLAN tag taken off and that
 * is exactly the prefix an instance's pool is matched by. The cap is applied
 * anyway, so that the three lists stay one shape.
 */
export async function carrierOptions(runtime: BindingRuntime): Promise<FormFieldOption[]> {
  if (!runtime.ctx.connected || !daemonReady(runtime)) return []

  const result = await wanbindWans(agentDeps(runtime))
  if (!result.ok || !result.data) return []

  const rows: CapRow[] = []
  for (const carrier of result.data.carriers) {
    if (!isBindingCarrier(carrier.device)) continue
    const names = carrier.wans.slice(0, 3).join(', ')
    const rest = carrier.wans.length > 3 ? ` and ${carrier.wans.length - 3} more` : ''
    const on = names ? `: ${names}${rest}` : ''
    const count = `${carrier.wans.length} interface${carrier.wans.length === 1 ? '' : 's'}`
    rows.push({
      rank: 0,
      pooledUnder: null,
      option: {
        value: carrier.device,
        label: `${carrier.device} — ${count}${on}${carrier.up ? '' : ' (down)'}`
      }
    })
  }
  return finish(rows)
}
