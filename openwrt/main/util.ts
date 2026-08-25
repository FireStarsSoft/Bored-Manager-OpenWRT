/**
 * The helpers more than one file needs.
 *
 * Only what was genuinely duplicated moved here. `store.ts` and `parse.ts` keep
 * their own `string` and `integer` on purpose: one validates JSON this module
 * wrote itself and should reject anything that is not already the right type,
 * the other reads router output where a number routinely arrives as text. A
 * single shared version would have to loosen the first or break the second, so
 * the two definitions are a difference in meaning rather than a duplication.
 */
import type { IfaceState, RouterModel } from './types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One field of a submitted form, as a trimmed string.
 *
 * Every handler receives `unknown`, and a `number` field arrives as a number
 * while the same field left blank arrives as an empty string or nothing at all,
 * so anything that is not a string is stringified rather than refused. The
 * settings form, the binding create form and the PPPoE batch form each had
 * their own copy of this; they now have to agree about what "blank" means,
 * because all three read "blank means leave this alone" off the answer.
 */
export function textField(values: Record<string, unknown>, key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

const EMPTY_IFACES: ReadonlyMap<string, IfaceState> = new Map()

/**
 * The index hangs off the sample rather than being cached under a host key, so
 * a new sample simply has no entry and the old index is collected along with
 * the model it described. Nothing has to remember to invalidate it.
 */
const ifaceIndexes = new WeakMap<RouterModel, ReadonlyMap<string, IfaceState>>()

/**
 * One sample's interfaces by logical name.
 *
 * Three readers on the fast path want exactly this map - the PPPoE row
 * builder, the manual-stop prune behind it, and the device table - and each
 * built its own from the whole interface array every time it was called. On a
 * five-thousand-session router that was three passes over five thousand
 * entries per surface per tick, to produce three identical maps.
 */
export function ifaceIndex(
  model: RouterModel | null | undefined
): ReadonlyMap<string, IfaceState> {
  if (!model) return EMPTY_IFACES
  const cached = ifaceIndexes.get(model)
  if (cached) return cached
  const index = new Map(model.ifaces.map((iface) => [iface.name, iface]))
  ifaceIndexes.set(model, index)
  return index
}

/**
 * Whether two carrier names describe overlapping sets of devices.
 *
 * A carrier names a physical device and, implicitly, every VLAN sub-device
 * under it: `eth1` covers `eth1.835`, so those two overlap, while `eth1.835`
 * and `eth1.836` do not. Both the binding engine (which claims a carrier
 * exclusively) and the PPPoE delete path (which has to know whether a running
 * instance is distributing clients across the pool it is about to remove) ask
 * the same question, so they ask it in the same words.
 */
export function carrierScopesOverlap(first: string, second: string): boolean {
  return (
    first === second ||
    first.startsWith(`${second}.`) ||
    second.startsWith(`${first}.`)
  )
}

export function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** A subnet reduced to the two numbers every comparison here works from. */
export interface ParsedSubnet {
  network: number
  prefix: number
  cidr: string
}

/**
 * Trimmed because callers hand over fields lifted straight out of router
 * output. The digit test is what makes the result trustworthy: `Number('1e3')`
 * and `Number('0x10')` are both finite, and neither is an octet.
 */
export function ipv4ToInt(value: string): number | null {
  const parts = value.trim().split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    result = (result * 256 + octet) >>> 0
  }
  return result
}

export function intToIpv4(value: number): string {
  const ip = value >>> 0
  return `${ip >>> 24}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`
}

/**
 * Callers must pass a prefix already known to be 0-32. JavaScript truncates a
 * shift count to five bits, so `32 - 33` would silently shift by 31 and return
 * a mask for a completely different subnet rather than fail.
 */
export function prefixMask(prefix: number): number {
  if (prefix <= 0) return 0
  return (0xffffffff << (32 - prefix)) >>> 0
}

export function parseCidr(value: string): ParsedSubnet | null {
  const match = value.trim().match(/^([^/]+)\/(\d{1,2})$/)
  if (!match) return null
  const ip = ipv4ToInt(match[1] ?? '')
  const prefix = Number(match[2])
  if (ip == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const network = (ip & prefixMask(prefix)) >>> 0
  return { network, prefix, cidr: `${intToIpv4(network)}/${prefix}` }
}

export function subnetContains(subnet: ParsedSubnet, ipRaw: string): boolean {
  const ip = ipv4ToInt(ipRaw)
  return ip != null && ((ip & prefixMask(subnet.prefix)) >>> 0) === subnet.network
}

export function subnetsOverlap(first: ParsedSubnet, second: ParsedSubnet): boolean {
  const prefix = Math.min(first.prefix, second.prefix)
  const mask = prefixMask(prefix)
  return ((first.network & mask) >>> 0) === ((second.network & mask) >>> 0)
}

/**
 * Whether two addresses share a subnet of the given length, for callers holding
 * an address and a mask rather than a parsed CIDR. The range check is this
 * function's own: an out-of-range prefix reaching `prefixMask` is a wrong
 * answer, not a rejected one.
 */
export function sameSubnet(first: string, second: string, prefix: number): boolean {
  const left = ipv4ToInt(first)
  const right = ipv4ToInt(second)
  if (left == null || right == null || prefix < 0 || prefix > 32) return false
  const mask = prefixMask(prefix)
  return ((left & mask) >>> 0) === ((right & mask) >>> 0)
}
