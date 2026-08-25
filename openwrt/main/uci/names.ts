/**
 * What a name is allowed to be before it reaches a shell.
 *
 * Every string this module writes into `/etc/config/*` passes through one of
 * these, and each one throws rather than sanitising: a name that does not match
 * is a bug in the caller, and quietly repairing it would write a section under
 * a name nothing else in the module can find again. The Linux `IFNAMSIZ` limit
 * of 15 visible characters is the other rule enforced here - past it netifd
 * silently truncates, and two sessions collide on one interface.
 */
export const MAX_PPPOE_SEQUENCE = 99_999
/** A malformed rule must never turn 5,000 accounts into 5,000 job rows. */
export const MAX_PPPOE_CHUNKS = 100

const PREFIX_RE = /^[a-z][a-z0-9]{0,3}$/
const UCI_NAME_RE = /^[A-Za-z0-9_]+$/
const ZONE_VALUE_RE = /^[A-Za-z0-9_-]{1,32}$/
const DEVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,31}$/
const SECTION_RE = /^[A-Za-z0-9_]+$/

export function wholeNumber(value: number, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number`)
  return value
}

export function validVlan(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  const vlan = wholeNumber(value, 'VLAN')
  if (vlan < 1 || vlan > 4094) throw new Error('VLAN must be between 1 and 4094')
  return vlan
}

export function execTimeout(value: number): number {
  return Number.isFinite(value) ? Math.max(1_000, Math.trunc(value)) : 60_000
}

export function isPppoePrefix(value: string): boolean {
  return PREFIX_RE.test(value)
}

export function isSafeDeviceName(value: string): boolean {
  return DEVICE_RE.test(value)
}

export function isManagedSectionName(value: string): boolean {
  return SECTION_RE.test(value) && value.length <= 15
}

/**
 * The sieve for a string this module writes as a UCI *value* rather than as a
 * name: a batch name, a PPPoE username, a PPPoE password.
 *
 * `uciQuote` quotes, it does not strip. A newline inside a password therefore
 * survives into `/etc/config/network`, and comes straight back out on the line
 * `uci batch` echoes when it rejects the command - the one output in this
 * module that may never be shown. Written as a loop rather than as a character
 * class so the control characters it refuses are not themselves in this file.
 */
export function isSafeUciValue(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

export function padPppoeSequence(seq: number): string {
  const value = wholeNumber(seq, 'PPPoE sequence')
  if (value < 1 || value > MAX_PPPOE_SEQUENCE) {
    throw new Error(`PPPoE sequence must be between 1 and ${MAX_PPPOE_SEQUENCE}`)
  }
  return String(value).padStart(5, '0')
}

export function pppoeSectionName(prefix: string, seq: number): string {
  if (!isPppoePrefix(prefix)) throw new Error('PPPoE prefix must be 1-4 lowercase letters or digits and start with a letter')
  const name = `${prefix}${padPppoeSequence(seq)}`
  // "pppoe-" plus the logical interface must fit Linux IFNAMSIZ (15 visible chars).
  if (`pppoe-${name}`.length > 15) throw new Error(`PPPoE interface name pppoe-${name} is too long`)
  return name
}

export function pppoeTableId(tableBase: number, seq: number): number {
  const base = wholeNumber(tableBase, 'table base')
  const table = base + wholeNumber(seq, 'PPPoE sequence')
  if (base < 1 || table > 2_147_483_647) throw new Error('PPPoE routing table is outside the supported range')
  return table
}

export function vlanSectionName(vlan: number): string {
  return `bmv${validVlan(vlan)}`
}

export function assertUciName(value: string, label: string): void {
  if (!UCI_NAME_RE.test(value)) throw new Error(`${label} is not a UCI section name`)
}

/**
 * A zone we only ever write as a value, never as a section id, so the stricter
 * section rule does not apply. `-` is legal in a zone name and common in one
 * (`lan-guest`); rejecting it would have failed the firewall step on the very
 * routers whose zone had to be discovered rather than assumed.
 */
export function assertZoneValue(value: string, label: string): void {
  if (!ZONE_VALUE_RE.test(value)) throw new Error(`${label} is not a firewall zone name`)
}

/** The subset of a caller's list that may be written as a section id, deduped. */
export function checkedSections(names: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const name = String(raw)
    if (!isManagedSectionName(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

export function chunkValues<T>(values: readonly T[], sizeRaw: number): T[][] {
  const size = Math.max(1, Math.trunc(sizeRaw) || 1)
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

/** Honour the configured size while enforcing a bounded live job payload. */
export function effectivePppoeChunkSize(rowCount: number, requested: number): number {
  const count = Math.max(0, Math.trunc(rowCount))
  const configured = Math.max(1, Math.trunc(requested) || 1)
  return Math.max(configured, Math.ceil(count / MAX_PPPOE_CHUNKS) || 1)
}
