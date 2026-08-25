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
import { ENGINE_STOPPED, shellFailure } from './runtime'
import type { BindingRuntime, RouterPreparationProbe, UciDocument } from './types'

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
 */
const PREPARATION_SCRIPT = String.raw`set +e
command -v uci >/dev/null 2>&1 || exit 20
echo '===DHCP==='
uci -q show dhcp 2>/dev/null | grep -E '=dhcp$|=dnsmasq$|\.(interface|limit|dhcpleasemax|ra|dhcpv6)=' || true
echo '===NETWORK==='
uci -q show network 2>/dev/null | grep -E '^network\.[^.=]+=|\.(ip4table|ip6assign)=' || true
echo '===FIREWALL==='
uci -q show firewall 2>/dev/null | grep -E '=zone$|=defaults$|\.(name|network|masq|flow_offloading)=' || true
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

export function firewallZoneForNetwork(document: UciDocument, network: string): string {
  for (const section of sectionsOfType(document, 'firewall', 'zone')) {
    const key = `firewall.${section}.network`
    if (!document.entries.some(([entryKey, value]) => entryKey === key && value === network)) {
      continue
    }
    return uciOption(document, 'firewall', section, 'name') || section
  }
  return ''
}

export function firewallZoneMasquerades(document: UciDocument, zoneName: string): boolean {
  for (const section of sectionsOfType(document, 'firewall', 'zone')) {
    const name = uciOption(document, 'firewall', section, 'name') || section
    if (name !== zoneName) continue
    return uciOption(document, 'firewall', section, 'masq') === '1'
  }
  return false
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
  runtime: BindingRuntime
): Promise<RouterPreparationProbe> {
  if (runtime.disposed) throw new Error(ENGINE_STOPPED)
  const result = await runtime.ctx.exec('sh -s', {
    stdin: PREPARATION_SCRIPT,
    timeoutMs: CHECK_TIMEOUT_MS
  })
  if (runtime.disposed) throw new Error(ENGINE_STOPPED)
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
