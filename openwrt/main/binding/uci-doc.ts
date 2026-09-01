/**
 * What the router says it is configured to do, and the names this module is
 * willing to write back.
 *
 * One command carries the whole preparation state, filtered down to the keys
 * the readers below ask for. Everything that has to decide something about
 * /etc/config reads it through here, so a half-dump is caught in one place
 * instead of being mistaken for a router with nothing configured.
 */
import { splitSections } from '@shared/shell'
// One tokenizer for `uci show` values, shared with the slow probe's firewall
// zone reader.
import { tokenizeUciValues } from '../parse'
import { uciBoolean } from '../util'
import { ENGINE_STOPPED, shellFailure } from './runtime'
import type { ExecDeps, RouterPreparationProbe, UciDocument } from './types'

const CHECK_TIMEOUT_MS = 20_000

export const UCI_SECTION = /^[A-Za-z0-9_]+$/
export const DHCP_SECTION = /^(?:[A-Za-z0-9_]+|@[A-Za-z0-9_]+\[\d+\])$/
export const FIREWALL_ZONE = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Each dump is filtered down to exactly the keys `preparationProbe`'s readers
 * ask for. Unfiltered, `uci show network` on a router carrying a few thousand
 * managed PPPoE sections is tens of thousands of lines - far past the output
 * cap of one command - and a truncated `uci show` parses as a perfectly
 * well-formed document that is merely missing sections. The filter is the
 * first line of defence; the sentinel check in `preparationProbe` is the
 * second, because filtering shrinks the dump without bounding it.
 *
 * A section declaration line (`network.wan=interface`) is unquoted, while an
 * option's value is quoted, so anchoring on `=<type>$` catches declarations
 * without catching an option that happens to hold the same word.
 *
 * `option gateway` is the one key kept here for what it *says* rather than for
 * what this module writes. It names a next hop that is off this router, so an
 * interface carrying one faces outward - and on a router whose uplink is a
 * plain static address, with no dnsmasq stub and no masquerading zone, it is
 * the only statement anywhere in /etc/config that says so. A modem in bridge
 * mode behind another router, a double-NAT lab and an ISP handing out RFC1918
 * are all that router, and without this line the interface classifier in
 * `direct/layout.ts` has nothing to weigh and calls the uplink a LAN.
 *
 * It is affordable for the same reason the rest of the filter is. `uci show`
 * prints the option once per section that sets it, and the only sections that
 * set it are statically addressed interfaces and `config route` - both written
 * by hand, both a handful. The sections that run into the thousands here are
 * the managed PPPoE ones, and a dialled interface is *handed* its gateway by
 * its peer rather than told it in the file, so the dump grows by low single
 * digits on the router it was already largest on.
 *
 * `option device` on the firewall side is kept for the same kind of reason. A
 * zone states its membership in either of two ways and fw4 honours both, so a
 * VLAN or a plain port put in a zone by `list device` - an ordinary way to write
 * a LAN that is not a bridge - was in no zone at all as far as this module was
 * concerned: the classifier lost both of its zone readings and the create was
 * refused outright with "is not assigned to a firewall zone", about a router the
 * operator had already assigned. Its cost is bounded by the number of firewall
 * sections a router has, which is dozens; unlike the network and dhcp dumps,
 * /etc/config/firewall does not grow with clients or with managed WANs.
 */
const PREPARATION_SCRIPT = String.raw`set +e
command -v uci >/dev/null 2>&1 || exit 20
echo '===DHCP==='
uci -q show dhcp 2>/dev/null | grep -E '=dhcp$|=dnsmasq$|\.(interface|limit|dhcpleasemax|ra|dhcpv6|ignore)=' || true
echo '===NETWORK==='
uci -q show network 2>/dev/null | grep -E '^network\.[^.=]+=|\.(ip4table|ip6assign|gateway)=' || true
echo '===FIREWALL==='
uci -q show firewall 2>/dev/null | grep -E '=zone$|=defaults$|\.(name|network|device|masq|flow_offloading)=' || true
echo '===SYSCTL==='
for key in \
  net.netfilter.nf_conntrack_max \
  net.ipv4.neigh.default.gc_thresh1 \
  net.ipv4.neigh.default.gc_thresh2 \
  net.ipv4.neigh.default.gc_thresh3
do
  value="$(sysctl -n "$key" 2>/dev/null)"
  printf '%s=%s\n' "$key" "$value"
done
exit 0
`

function probeTruncated(): Error {
  return new Error(
    'the router configuration dump was cut off before it finished; it is larger than one command can carry, so the check cannot tell what is really configured'
  )
}

/**
 * Deliberately does not point at Install missing packages: `uci` is not in
 * PACKAGE_GROUPS, and it would not belong there - it is part of the OpenWRT
 * base system, so a router without it is not a build this module can drive.
 */
function noUciCommand(): Error {
  return new Error(
    'this router has no uci command; WAN Binding reads the router configuration through uci, which is part of the OpenWRT base system'
  )
}

export function parseUciDocument(raw: string): UciDocument {
  const values = new Map<string, string>()
  const sectionTypes = new Map<string, string>()
  const entries: Array<[string, string]> = []
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim()
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    const key = line.slice(0, equals)
    const tokens = tokenizeUciValues(line.slice(equals + 1))
    if (tokens.length === 0) continue
    for (const token of tokens) entries.push([key, token])
    values.set(key, tokens[tokens.length - 1] ?? '')
    const parts = key.split('.')
    if (parts.length === 2) sectionTypes.set(`${parts[0]}.${parts[1]}`, tokens[0] ?? '')
  }
  return { values, sectionTypes, entries }
}

export function uciOption(
  document: UciDocument,
  config: string,
  section: string,
  option: string
): string {
  return document.values.get(`${config}.${section}.${option}`) ?? ''
}

export function sectionsOfType(
  document: UciDocument,
  config: string,
  type: string
): string[] {
  const prefix = `${config}.`
  const result: string[] = []
  for (const [key, sectionType] of document.sectionTypes) {
    if (sectionType === type && key.startsWith(prefix)) result.push(key.slice(prefix.length))
  }
  return result
}

/**
 * One `list device` entry weighed against one netdev name.
 *
 * fw4 accepts a shell-style pattern here and a leading `!` to exclude, so
 * `eth0.*` is a real way to write a zone's membership and `!eth2` is the exact
 * opposite of one. Only a trailing `*` is honoured: that is the shape routers
 * actually carry, and a half-understood pattern that matched too much would put
 * an interface into a zone it is not in - the same failure this fallback exists
 * to prevent, pointed the other way.
 */
function deviceMatches(entry: string, device: string): boolean {
  if (entry === '' || entry.startsWith('!')) return false
  if (entry.endsWith('*')) {
    const prefix = entry.slice(0, -1)
    return prefix !== '' && device.startsWith(prefix)
  }
  return entry === device
}

/**
 * The firewall zone an interface sits in, by the name that zone answers to.
 *
 * A zone states its membership either way and fw4 honours both: `list network`
 * names logical interfaces, `list device` names the netdevs themselves. LuCI
 * writes the first, so the first was all this read - and a LAN placed in its
 * zone by device was then in no zone at all here, which cost the classifier both
 * of its zone readings and refused the create with a sentence denying something
 * the operator had already done.
 *
 * `list network` still answers first, because it is a statement about *this*
 * interface rather than about the wire underneath it; the device pass is the
 * fallback for the zone that made no such statement.
 *
 * `devices` is the interface's own netdevs - its `device` and its `l3Device` -
 * which only a caller holding the interface state can supply. A caller with
 * none passes none and gets exactly the reading this function always gave.
 */
export function firewallZoneForNetwork(
  document: UciDocument,
  network: string,
  devices: readonly string[] = []
): string {
  const zones = sectionsOfType(document, 'firewall', 'zone')
  for (const section of zones) {
    const key = `firewall.${section}.network`
    // A zone's member list has two legal spellings and `uci show` prints them
    // differently: `list network 'lan'` twice arrives as two entries under this
    // key, while `option network 'lan guest'` arrives as one entry holding both
    // names separated by a space. fw4 splits that value on whitespace, so a
    // router written the second way is configured correctly - and comparing the
    // whole token to the network name told such a router its LAN was in no zone
    // at all. The split belongs here, at this key, rather than in the tokenizer:
    // values under other keys legitimately contain spaces.
    if (
      !document.entries.some(
        ([entryKey, value]) => entryKey === key && value.split(/\s+/).includes(network)
      )
    ) {
      continue
    }
    return uciOption(document, 'firewall', section, 'name') || section
  }
  if (devices.length === 0) return ''
  for (const section of zones) {
    const key = `firewall.${section}.device`
    const claims = document.entries.some(
      ([entryKey, value]) =>
        entryKey === key && devices.some((device) => deviceMatches(value, device))
    )
    if (claims) return uciOption(document, 'firewall', section, 'name') || section
  }
  return ''
}

/**
 * Whether the zone answering to this name masquerades.
 *
 * Two sections can only share a name by mistake, and the safe reading of that
 * mistake is that a name any copy of which masquerades masquerades - which is
 * the reading the interface classifier in `direct/layout.ts` already took.
 * Answering off the first section carrying the name made the two disagree on
 * exactly the router where the difference is visible.
 */
export function firewallZoneMasquerades(document: UciDocument, zoneName: string): boolean {
  for (const section of sectionsOfType(document, 'firewall', 'zone')) {
    const name = uciOption(document, 'firewall', section, 'name') || section
    if (name === zoneName && uciBoolean(uciOption(document, 'firewall', section, 'masq'))) {
      return true
    }
  }
  return false
}

/**
 * Which network a `config dhcp` section is about.
 *
 * `option interface` is what the section states, and the section name is the
 * fallback, because a hand-written `config dhcp 'guest'` routinely leaves the
 * option out and means itself - dnsmasq resolves it that way and so must
 * anything reading the file. Three places in this tree used to answer this
 * question and two of them agreed, so the third quietly excused every such
 * router from the guard that stops a WAN pool swallowing one of the router's own
 * LANs. It is one rule now, stated here.
 *
 * An anonymous section falls back to `@dhcp[0]`, which no interface is ever
 * named, so it simply matches nothing rather than having to be special-cased.
 */
export function dhcpSectionNetwork(document: UciDocument, section: string): string {
  return uciOption(document, 'dhcp', section, 'interface') || section
}

/**
 * Which networks /etc/config/dhcp actually serves addresses on: `true` for a
 * `config dhcp` section naming the network, `false` when such a section exists
 * and switches itself off, and absent when the file says nothing about it.
 *
 * This is the router's own statement of which of its interfaces is a LAN, and
 * it is worth having because nothing else on the fast path is: an interface is
 * put in a WAN pool by its protocol and by the device it terminates on, and
 * neither of those separates a LAN from an uplink. Every LAN runs proto static,
 * and a LAN that is not a bridge - a VLAN, a plain port, a wireless netdev - is
 * a device name away from looking exactly like a WAN port.
 *
 * `option ignore` is the half that has to be read for this to be true on a
 * stock router at all. OpenWrt ships a `config dhcp 'wan'` section for the
 * uplink and switches it off with exactly that line, so a reader that only
 * asked whether a section existed would call the WAN of every untouched router
 * a LAN.
 *
 * Which network a section is about is `dhcpSectionNetwork`'s answer, not one
 * given again here. This reader used to demand `option interface` and skip a
 * section without it, so on a router whose LANs are named by their sections -
 * the hand-written arrangement, and the one the pool-identity guard downstream
 * was written for - the map came back saying nothing about them and the guard
 * could not fire at all.
 */
export function dhcpServedNetworks(document: UciDocument): Map<string, boolean> {
  const served = new Map<string, boolean>()
  for (const section of sectionsOfType(document, 'dhcp', 'dhcp')) {
    const network = dhcpSectionNetwork(document, section)
    if (!network) continue
    const ignored = uciBoolean(uciOption(document, 'dhcp', section, 'ignore'))
    // A second section for the same network only ever adds service: one that
    // ignores it cannot take back what another one hands out.
    served.set(network, !ignored || served.get(network) === true)
  }
  return served
}

export function numericOption(value: string, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback
}

/** The `option ip4table` each WAN section carries, as the router has it now. */
export function networkTables(document: UciDocument): Map<string, number> {
  const result = new Map<string, number>()
  for (const [key, value] of document.values) {
    const match = key.match(/^network\.([^.]+)\.ip4table$/)
    if (!match) continue
    const table = Number(value)
    if (Number.isSafeInteger(table) && table > 0) result.set(match[1] ?? '', table)
  }
  return result
}

export async function preparationProbe(
  deps: ExecDeps
): Promise<RouterPreparationProbe> {
  if (deps.disposed) throw new Error(ENGINE_STOPPED)
  const result = await deps.ctx.exec('sh -s', {
    stdin: PREPARATION_SCRIPT,
    timeoutMs: CHECK_TIMEOUT_MS
  })
  if (deps.disposed) throw new Error(ENGINE_STOPPED)
  if (result.code === 125 || result.stderr.includes('[overflow]')) {
    throw probeTruncated()
  }
  // The script exits 20 on purpose when `uci` is absent. Nothing decoded that
  // sentinel, so the one router state it was written to identify surfaced as
  // "OpenWRT UCI probe failed (exit 20)".
  if (result.code === 20) throw noUciCommand()
  if (result.code !== 0) throw shellFailure('OpenWRT UCI probe', result.code)
  const sections = splitSections(result.stdout)
  // `===SYSCTL===` is echoed after all three dumps, so its absence means
  // stdout was cut short - whether or not the executor said so. Without this
  // the check reads a half-dump as the router's whole configuration and
  // reports something confident and wrong: "LAN has no dnsmasq DHCP
  // section", or "WAN section pd00734 no longer exists".
  if (!sections.has('SYSCTL')) throw probeTruncated()
  const sysctl = new Map<string, number>()
  for (const line of (sections.get('SYSCTL') ?? '').split(/\r?\n/)) {
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    const value = Number(line.slice(equals + 1).trim())
    if (Number.isFinite(value)) sysctl.set(line.slice(0, equals).trim(), value)
  }
  return {
    dhcp: parseUciDocument(sections.get('DHCP') ?? ''),
    network: parseUciDocument(sections.get('NETWORK') ?? ''),
    firewall: parseUciDocument(sections.get('FIREWALL') ?? ''),
    sysctl
  }
}
