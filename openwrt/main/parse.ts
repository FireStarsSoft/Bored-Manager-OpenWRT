import type {
  IfaceState,
  IpRule,
  Lease,
  PppoeErrorCode,
  PppoeListResult,
  ProcNetDevSnapshot,
  RouterSystemState
} from './types'
import { finite, isRecord, uciBoolean } from './util'

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Tolerant on purpose: ubus and BusyBox hand back numbers as text often enough
 * that rejecting a string here would drop real readings. `store.ts` validates
 * JSON this module wrote itself and takes the strict view instead.
 */
function integer(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

function firstError(entry: Record<string, unknown>): string | undefined {
  const direct = string(entry.error) || string(entry.errorCode)
  if (direct) return direct.slice(0, 100)
  const errors = Array.isArray(entry.errors) ? entry.errors : []
  for (let i = errors.length - 1; i >= 0; i--) {
    const error = errors[i]
    if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 100)
    if (!isRecord(error)) continue
    const code = string(error.code) || string(error.message)
    if (code) return code.slice(0, 100)
  }
  return undefined
}

/** Parse `ubus -S call network.interface dump`. Malformed entries are skipped. */
export function parseDump(text: string): IfaceState[] {
  const root = json(text)
  const entries = Array.isArray(root)
    ? root
    : isRecord(root) && Array.isArray(root.interface)
      ? root.interface
      : []
  const out: IfaceState[] = []
  const seen = new Set<string>()

  for (const value of entries) {
    if (!isRecord(value)) continue
    const name = string(value.interface).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)

    const addresses = Array.isArray(value['ipv4-address']) ? value['ipv4-address'] : []
    let ipv4: IfaceState['ipv4']
    for (const address of addresses) {
      if (!isRecord(address)) continue
      const addr = string(address.address)
      const mask = integer(address.mask, -1)
      if (validIpv4(addr) && mask >= 0 && mask <= 32) {
        ipv4 = { addr, mask }
        break
      }
    }

    const data = isRecord(value.data) ? value.data : {}
    const table = integer(value.ip4table, integer(data.ip4table, 0))
    out.push({
      name,
      proto: string(value.proto),
      device: string(value.device),
      l3Device: string(value.l3_device),
      up: value.up === true,
      pending: value.pending === true,
      autostart: value.autostart !== false,
      ipv4,
      uptimeSec: Math.max(0, finite(value.uptime)),
      errorCode: firstError(value),
      ip4Table: table > 0 ? table : undefined
    })
  }
  return out
}

/** Parse `ubus -S call system info`; OpenWRT load values are 16.16 fixed point. */
export function parseSystemInfo(text: string): RouterSystemState {
  const root = json(text)
  if (!isRecord(root)) {
    return { uptimeSec: 0, load1: 0, memTotal: 0, memFree: 0 }
  }
  const load = Array.isArray(root.load) ? finite(root.load[0]) : finite(root.load)
  const memory = isRecord(root.memory) ? root.memory : {}
  const free = finite(memory.available, finite(memory.free))
  return {
    uptimeSec: Math.max(0, finite(root.uptime)),
    load1: Math.max(0, Number.isInteger(load) ? load / 65_536 : load),
    memTotal: Math.max(0, finite(memory.total)),
    memFree: Math.max(0, free)
  }
}

function validIpv4(value: string): boolean {
  const parts = value.split('.')
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false
      const value = Number(part)
      return value >= 0 && value <= 255
    })
  )
}

/** Parse dnsmasq's `/tmp/dhcp.leases` format. */
export function parseLeases(text: string): Lease[] {
  const leases: Lease[] = []
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4) continue
    const expires = integer(fields[0], -1)
    const mac = (fields[1] ?? '').toLowerCase()
    const ip = fields[2] ?? ''
    if (
      expires < 0 ||
      !/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(mac) ||
      !validIpv4(ip)
    ) {
      continue
    }
    leases.push({
      expires,
      mac,
      ip,
      host: fields[3] === '*' ? '' : (fields[3] ?? '').slice(0, 253)
    })
  }
  return leases
}

/** Parse the numeric module-owned subset of `ip -4 rule show`. */
export function parseIpRules(text: string): IpRule[] {
  const rules: IpRule[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const prefMatch = line.match(/^\s*(\d+)\s*:\s*/)
    const fromMatch = line.match(/\bfrom\s+(\S+)/)
    const tableMatch = line.match(/\b(?:lookup|table)\s+(\d+)\b/)
    if (!prefMatch || !fromMatch || !tableMatch) continue
    const pref = integer(prefMatch[1], -1)
    const table = integer(tableMatch[1], -1)
    if (pref < 0 || table <= 0) continue
    const from = fromMatch[1]
    const key = `${pref}\0${from}\0${table}`
    if (seen.has(key)) continue
    seen.add(key)
    rules.push({ pref, from, table })
  }
  return rules.sort((a, b) => a.pref - b.pref)
}

/**
 * Parse either ordinary `/proc/net/dev` rows or the compact rows emitted by
 * FastSweep's router-side awk (`dev rx tx` plus the aggregate sentinel).
 */
export function parseProcNetDev(text: string): ProcNetDevSnapshot {
  const devices = Object.create(null) as Record<string, { rx: number; tx: number }>
  let poolDev = { count: 0, rx: 0, tx: 0 }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const pool = line.match(/^===POOL===\s+(\d+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)$/)
    if (pool) {
      poolDev = {
        count: Math.max(0, integer(pool[1])),
        rx: nonNegative(pool[2]),
        tx: nonNegative(pool[3])
      }
      continue
    }

    const colon = line.match(/^([A-Za-z0-9_.:@-]+):\s*(.*)$/)
    if (colon) {
      const fields = colon[2].trim().split(/\s+/)
      if (fields.length >= 9) {
        devices[colon[1]] = { rx: nonNegative(fields[0]), tx: nonNegative(fields[8]) }
      }
      continue
    }

    const compact = line.match(/^([A-Za-z0-9_.:@-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)$/)
    if (compact) {
      devices[compact[1]] = {
        rx: nonNegative(compact[2]),
        tx: nonNegative(compact[3])
      }
    }
  }
  return { devices, poolDev }
}

function nonNegative(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function splitPppoeLine(line: string): string[] | null {
  if (line.includes('\t')) return line.split(/\t+/).map((part) => part.trim())
  if (line.includes(',')) return line.split(',').map((part) => part.trim())
  if (line.includes(';')) return line.split(';').map((part) => part.trim())
  if (line.includes('|')) return line.split('|').map((part) => part.trim())
  if (/\s/.test(line)) return line.trim().split(/\s+/)
  return null
}

/** Parse an uploaded/pasted PPPoE account list without retaining it anywhere. */
export function parsePppoeList(text: string): PppoeListResult {
  const rows: PppoeListResult['rows'] = []
  const errors: PppoeListResult['errors'] = []
  const duplicates: string[] = []
  const seen = new Set<string>()
  const duplicateSeen = new Set<string>()

  for (const [offset, raw] of String(text ?? '').split(/\r?\n/).entries()) {
    const lineNumber = offset + 1
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const fields = splitPppoeLine(line)
    if (!fields || fields.length < 2 || fields.length > 3) {
      errors.push({
        line: lineNumber,
        reason: 'expected username and password, with an optional VLAN'
      })
      continue
    }
    const [user = '', pass = '', vlanRaw = ''] = fields
    if (user.length < 1 || user.length > 64) {
      errors.push({ line: lineNumber, reason: 'username must contain 1-64 characters' })
      continue
    }
    if (pass.length < 1 || pass.length > 64) {
      errors.push({ line: lineNumber, reason: 'password must contain 1-64 characters' })
      continue
    }
    let vlan: number | undefined
    if (vlanRaw !== '') {
      vlan = Number(vlanRaw)
      if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) {
        errors.push({ line: lineNumber, reason: 'VLAN must be a whole number from 1 to 4094' })
        continue
      }
    }
    if (seen.has(user) && !duplicateSeen.has(user)) {
      duplicateSeen.add(user)
      duplicates.push(user)
    }
    seen.add(user)
    rows.push(vlan == null ? { user, pass } : { user, pass, vlan })
  }
  return { rows, errors, duplicates }
}

/** Quote one UCI batch value using POSIX single-quote escaping. */
export function uciQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Parse `uci -q show network | grep ip4table` into section -> table. */
export function parseUciIp4Tables(text: string): Record<string, number> {
  const out = Object.create(null) as Record<string, number>
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*network\.([A-Za-z0-9_]+)\.ip4table=(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/
    )
    if (!match) continue
    const table = integer(match[2] ?? match[3] ?? match[4], -1)
    if (table > 0) out[match[1]] = table
  }
  return out
}

/**
 * The `===SYSCTL===` section of the slow probe: `key=value` lines for the
 * scale limits, plus one `flow_offload=` line carrying fw4's UCI flag.
 *
 * `flowOffload` reads false for an empty value on purpose: `uci -q get` of an
 * absent option prints nothing, and an absent `flow_offloading` is fw4's
 * default, which is off. Null is reserved for "the section never arrived",
 * which the caller keeps as unknown.
 */
export function parseSysctlReport(text: string): {
  values: Record<string, number>
  flowOffload: boolean | null
} {
  const values = Object.create(null) as Record<string, number>
  let flowOffload: boolean | null = null
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9._]+)=(.*)$/)
    if (!match) continue
    if (match[1] === 'flow_offload') {
      const raw = match[2].trim().replace(/^'+|'+$/g, '')
      // `option flow_offloading 'on'` is as true as `'1'` to fw4, so reading
      // only the one spelling told the Router limits page that a router already
      // running software flow offload had it switched off - and offered to turn
      // on what was on, with no way to turn it off.
      flowOffload = uciBoolean(raw)
      continue
    }
    const value = integer(match[2].trim(), -1)
    if (value >= 0) values[match[1]] = value
  }
  return { values, flowOffload }
}

/** Read PPPoE usernames for cached table rows; passwords are deliberately ignored. */
export function parseUciPppoeUsers(text: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*network\.([A-Za-z0-9_]+)\.username=(?:'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+))\s*$/
    )
    if (!match) continue
    const value = (match[2] ?? match[3] ?? match[4] ?? '')
      .split("'\\''")
      .join("'")
      .slice(0, 64)
    out[match[1]] = value
  }
  return out
}

function unquoteUci(valueRaw: string): string {
  const value = valueRaw.trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'")
  }
  return value
}

/** Split `uci show` list values such as `'lan' 'guest'`. */
export function tokenizeUciValues(valueRaw: string): string[] {
  const tokens: string[] = []
  const matches = valueRaw.matchAll(/'(?:[^']|\\'')*'|[^\s]+/g)
  for (const match of matches) {
    const token = unquoteUci(match[0])
    if (token) tokens.push(token)
  }
  return tokens
}

export interface FirewallZone {
  /** UCI section id; `@zone[0]` for the anonymous sections most routers use. */
  section: string
  /** `option name`, falling back to the section id. */
  name: string
  /** Every `list network` value on the zone. */
  networks: string[]
}

/**
 * Parse the `===FWZONES===` slow-probe section: `uci -q show firewall` filtered
 * to zone declarations, names and network membership.
 *
 * The filter is a grep, so it also lets through the `.name=` of a rule and any
 * other section that happens to carry one. Only sections the output actually
 * declared as `=zone` are returned, so those lines are collected and dropped.
 */
export function parseFirewallZones(text: string): FirewallZone[] {
  const declared: string[] = []
  const isZone = new Set<string>()
  const names = new Map<string, string>()
  const networks = new Map<string, string[]>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    const key = line.slice(0, equals)
    if (!key.startsWith('firewall.')) continue
    const rest = key.slice('firewall.'.length)
    const value = line.slice(equals + 1)
    const dot = rest.indexOf('.')
    if (dot < 0) {
      if (value.trim() !== 'zone' || isZone.has(rest)) continue
      isZone.add(rest)
      declared.push(rest)
      continue
    }
    const section = rest.slice(0, dot)
    const option = rest.slice(dot + 1)
    if (option === 'name') {
      const token = tokenizeUciValues(value)[0]
      if (token) names.set(section, token)
    } else if (option === 'network') {
      const list = networks.get(section) ?? []
      // Both spellings of a UCI list reach us: one line per value on some
      // releases, `'lan' 'guest'` on one line on others - and `option network
      // 'lan guest'`, which quotes both names inside a single token. fw4 splits
      // that one on whitespace, so a token holding two names is two members
      // rather than a member nothing can match.
      list.push(...tokenizeUciValues(value).flatMap((token) => token.split(/\s+/)))
      networks.set(section, list)
    }
  }
  return declared.map((section) => ({
    section,
    name: names.get(section) || section,
    networks: networks.get(section) ?? []
  }))
}

/** A firewall zone name as it may appear in a value; `-` is legal here. */
const ZONE_NAME = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Which zone LAN clients sit in, for the forwarding that lets them reach the
 * managed WAN pool.
 *
 * A zone that actually lists network `lan` wins over one merely called `lan`:
 * the name is a label, the membership is the routing fact. An empty string
 * means "no answer" - every caller keeps its own fallback rather than guessing
 * a different zone.
 */
export function pickLanZone(zones: readonly FirewallZone[]): string {
  const usable = zones.filter((zone) => ZONE_NAME.test(zone.name))
  const byNetwork = usable.find((zone) => zone.networks.includes('lan'))
  if (byNetwork) return byNetwork.name
  return usable.find((zone) => zone.name === 'lan')?.name ?? ''
}

function logErrorCode(line: string): PppoeErrorCode | null {
  if (/auth(?:entication)? failed|PAP.*fail|CHAP.*fail|access denied/i.test(line)) {
    return 'AUTH_FAILED'
  }
  if (/PADO.*(?:timeout|not received)|no PADO|unable to complete discovery/i.test(line)) {
    return 'NO_PADO'
  }
  if (/peer.*terminat|LCP terminated by peer/i.test(line)) return 'PEER_TERMINATED'
  if (/link.*(?:lost|down)|connection terminated|modem hangup/i.test(line)) return 'LINK_LOST'
  if (/timed?\s*out|timeout/i.test(line)) return 'TIMEOUT'
  if (/\berror\b|\bfailed\b/i.test(line)) return 'UNKNOWN'
  return null
}

/** Best-effort recent PPPoE error enrichment from `logread`. */
export function parsePppoeLogErrors(text: string): Record<string, PppoeErrorCode> {
  const out = Object.create(null) as Record<string, PppoeErrorCode>
  const ifaceByPid = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const pid = line.match(/\bpppd\[(\d+)\]/i)?.[1]
    const quoted = line.match(/\bInterface\s+['"]([^'"]+)['"]/i)?.[1]
    const netdev = line.match(/\bpppoe-([a-z][a-z0-9_]{0,14})\b/i)?.[1]
    const explicit = line.match(/\binterface[ =:]([a-z][a-z0-9_]{0,14})\b/i)?.[1]
    const direct = quoted || netdev || explicit
    if (pid && direct) ifaceByPid.set(pid, direct)
    const name = direct || (pid ? ifaceByPid.get(pid) : undefined)
    if (!name) continue
    if (/is now up|connection established|authentication succeeded/i.test(line)) {
      delete out[name]
      continue
    }
    const code = logErrorCode(line)
    if (code) out[name] = code
  }
  return out
}
