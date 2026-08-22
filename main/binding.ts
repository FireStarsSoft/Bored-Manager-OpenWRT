/**
 * One-to-one DHCP client -> WAN policy routing.
 *
 * The router remains the source of truth. Every fast sample reconstructs the
 * actual assignment from `ip rule`, DHCP leases and the table/WAN map, then the
 * pure planner below returns only the lines needed to reach the desired state.
 * RAM is used only for grace timers, FIFO order and action holds; only instance
 * configuration, extra tables, sticky choices and the bounded event ring are
 * written through HostStore.
 */
import {
  createCheckSession,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import { shQuote, splitSections } from '@shared/shell'
import type { OkResult } from '@shared/types'
import type { OwrtRules } from './config'
import type { JobSpec } from './jobs'
import type { BindingInstanceRecord, HostStore, OwrtHostData } from './store'
import type { IfaceState, IpRule, Lease, RouterModel } from './types'

const FAST_INTERVAL_KEY = 'openwrt'
const MANAGED_PREF_CEILING = 30_000
const CHECK_TIMEOUT_MS = 20_000
const STICKY_TOUCH_MS = 10_000
const UCI_SECTION = /^[A-Za-z0-9_]+$/
const DHCP_SECTION = /^(?:[A-Za-z0-9_]+|@[A-Za-z0-9_]+\[\d+\])$/
const FIREWALL_ZONE = /^[A-Za-z0-9_-]{1,32}$/
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/

// ---------------------------------------------------------------------------
// Pure planner contract

export interface BindingPlannerInstance {
  id: string
  running: boolean
  sticky: boolean
  remap: boolean
}

export interface BindingPlannerWan {
  name: string
  table: number | null
  up: boolean
  pending: boolean
  ipv4?: string
  uptimeSec: number
  errorCode?: string
}

export interface BindingPlannerPolicy {
  rulePrefBase: number
  catchAllPrefBase: number
  ruleChunkLines: number
  wanErrorGraceSec: number
  wanWarnUptimeSec: number
  releaseGraceSec: number
  remapOnWanError: boolean
  stickyByMac: boolean
  maxEvents: number
}

export interface BindingStickyChoice {
  mac: string
  wan: string
  lastSeenAt: number
}

export interface BindingDeviceMemory {
  mac: string
  ip: string
  host: string
  lastSeenAt: number
  assignedAt: number
  wan?: string
}

export interface BindingWaitingMemory {
  mac: string
  enqueuedAt: number
  order: number
}

export interface BindingWanErrorMemory {
  wan: string
  since: number
}

export interface BindingOrphanMemory {
  key: string
  ip: string
  table: number
  pref: number
  firstMissingAt: number
}

export interface BindingForcedReassign {
  mac: string
  avoidWan?: string
}

export interface BindingPlannerMemory {
  devices: BindingDeviceMemory[]
  waiting: BindingWaitingMemory[]
  wanErrors: BindingWanErrorMemory[]
  orphans: BindingOrphanMemory[]
  /** Manual Unassign holds are deliberately RAM-only. */
  heldMacs: string[]
  /** Consumed by one reconciliation. */
  forceReassign: BindingForcedReassign[]
  nextOrder: number
}

export interface BindingActualAssignment {
  pref: number
  ip: string
  table: number
  wan: string | null
  mac: string | null
}

export interface BindingDesiredAssignment {
  pref: number
  ip: string
  table: number
  wan: string
  mac: string | null
  assignedAt: number
}

export interface BindingRuleChange {
  pref: number
  ip: string
  table: number
}

export interface BindingRuleDiff {
  delete: BindingRuleChange[]
  add: BindingRuleChange[]
  deleteLines: string[]
  addLines: string[]
  lines: string[]
  chunks: string[][]
}

export interface BindingPlannerEvent {
  t: number
  kind: string
  text: string
}

export interface BindingWanSummary {
  total: number
  available: number
  bound: number
  error: number
  warning: number
  dialing: number
}

export interface BindingDeviceSummary {
  total: number
  bound: number
  waiting: number
}

export interface BindingAssignmentRow {
  key: string
  instanceId: string
  host: string
  mac: string
  ip: string
  wan: string
  wanIp: string
  wanStatus: string
  sinceLabel: string
}

export interface BindingWaitingRow {
  key: string
  instanceId: string
  mac: string
  host: string
  ip: string
  position: number
  waitingSince: number
  waitingFor: string
  held: boolean
  heldLabel: string
}

export interface BindingPlannerResult {
  actual: BindingActualAssignment[]
  desired: BindingDesiredAssignment[]
  ruleDiff: BindingRuleDiff
  memory: BindingPlannerMemory
  stickyUpdates: BindingStickyChoice[]
  events: BindingPlannerEvent[]
  assignments: BindingAssignmentRow[]
  waiting: BindingWaitingRow[]
  wan: BindingWanSummary
  devices: BindingDeviceSummary
}

export type BindingTableToWan =
  | ReadonlyMap<number, string>
  | Readonly<Record<string, string>>
  | ReadonlyArray<readonly [number, string]>

export interface BindingReconcileInput {
  now: number
  instance: BindingPlannerInstance
  lanCidr: string
  leases: readonly Lease[]
  rules: readonly IpRule[]
  wans: readonly BindingPlannerWan[]
  tableToWan: BindingTableToWan
  sticky: readonly BindingStickyChoice[]
  memory?: BindingPlannerMemory
  policy: BindingPlannerPolicy
  /** A local deterministic PRNG is seeded from this value. */
  randomSeed?: number
  rebooted?: boolean
}

interface ParsedSubnet {
  network: number
  prefix: number
  cidr: string
}

interface WorkingActual extends BindingActualAssignment {
  source: IpRule
  key: string
  exactLease: boolean
}

interface WorkingAssignment {
  mac: string | null
  ip: string
  wan: string
  table: number
  pref: number | null
  assignedAt: number
  previousWan?: string
  reason: 'actual' | 'sticky' | 'random' | 'remap' | 'forced' | 'orphan'
}

interface CurrentLease {
  lease: Lease
  index: number
}

function normalizedMac(value: unknown): string {
  const mac = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return MAC.test(mac) ? mac : ''
}

function ipv4ToInt(value: string): number | null {
  const parts = value.trim().split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    result = (result * 256 + octet) >>> 0
  }
  return result
}

function intToIpv4(value: number): string {
  const ip = value >>> 0
  return `${ip >>> 24}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`
}

function prefixMask(prefix: number): number {
  if (prefix <= 0) return 0
  return (0xffffffff << (32 - prefix)) >>> 0
}

function parseCidr(value: string): ParsedSubnet | null {
  const match = value.trim().match(/^([^/]+)\/(\d{1,2})$/)
  if (!match) return null
  const ip = ipv4ToInt(match[1] ?? '')
  const prefix = Number(match[2])
  if (ip == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const network = (ip & prefixMask(prefix)) >>> 0
  return { network, prefix, cidr: `${intToIpv4(network)}/${prefix}` }
}

function subnetContains(subnet: ParsedSubnet, ipRaw: string): boolean {
  const ip = ipv4ToInt(ipRaw)
  return ip != null && ((ip & prefixMask(subnet.prefix)) >>> 0) === subnet.network
}

function subnetsOverlap(first: ParsedSubnet, second: ParsedSubnet): boolean {
  const prefix = Math.min(first.prefix, second.prefix)
  const mask = prefixMask(prefix)
  return ((first.network & mask) >>> 0) === ((second.network & mask) >>> 0)
}

function ruleIp(from: string): string | null {
  const text = String(from ?? '').trim()
  const slash = text.indexOf('/')
  const ip = slash >= 0 ? text.slice(0, slash) : text
  return ipv4ToInt(ip) == null ? null : ip
}

function normalizeTableMap(source: BindingTableToWan): Map<number, string> {
  const result = new Map<number, string>()
  if (source instanceof Map) {
    for (const [table, wan] of source) {
      if (Number.isSafeInteger(table) && table > 0 && typeof wan === 'string' && wan) {
        result.set(table, wan)
      }
    }
    return result
  }
  if (Array.isArray(source)) {
    for (const pair of source) {
      const table = Number(pair[0])
      const wan = pair[1]
      if (Number.isSafeInteger(table) && table > 0 && typeof wan === 'string' && wan) {
        result.set(table, wan)
      }
    }
    return result
  }
  for (const [tableRaw, wan] of Object.entries(source)) {
    const table = Number(tableRaw)
    if (Number.isSafeInteger(table) && table > 0 && typeof wan === 'string' && wan) {
      result.set(table, wan)
    }
  }
  return result
}

function emptyPlannerMemory(): BindingPlannerMemory {
  return {
    devices: [],
    waiting: [],
    wanErrors: [],
    orphans: [],
    heldMacs: [],
    forceReassign: [],
    nextOrder: 1
  }
}

function clonePlannerMemory(memory?: BindingPlannerMemory): BindingPlannerMemory {
  const source = memory ?? emptyPlannerMemory()
  return {
    devices: (source.devices ?? []).map((entry) => ({ ...entry })),
    waiting: (source.waiting ?? []).map((entry) => ({ ...entry })),
    wanErrors: (source.wanErrors ?? []).map((entry) => ({ ...entry })),
    orphans: (source.orphans ?? []).map((entry) => ({ ...entry })),
    heldMacs: [...(source.heldMacs ?? [])],
    forceReassign: (source.forceReassign ?? []).map((entry) => ({ ...entry })),
    nextOrder: Math.max(1, Math.trunc(source.nextOrder) || 1)
  }
}

function durationLabel(msRaw: number): string {
  const seconds = Math.max(0, Math.floor(msRaw / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function wanUsable(wan: BindingPlannerWan, warnUptimeSec: number): boolean {
  return (
    wan.table != null &&
    wan.up &&
    !wan.pending &&
    Boolean(wan.ipv4) &&
    !wan.errorCode &&
    wan.uptimeSec >= warnUptimeSec
  )
}

function wanState(wan: BindingPlannerWan, warnUptimeSec: number): string {
  if (wan.pending) return 'dialing'
  if (!wan.up || wan.errorCode) return 'error'
  if (!wan.ipv4 || wan.table == null || wan.uptimeSec < warnUptimeSec) return 'warning'
  return 'available'
}

function leaseRank(lease: Lease): number {
  return lease.expires === 0 ? Number.MAX_SAFE_INTEGER : lease.expires
}

function activeLease(lease: Lease, now: number): boolean {
  return lease.expires === 0 || lease.expires * 1000 > now
}

function ruleSignature(rule: BindingRuleChange): string {
  return `${rule.pref}|${rule.ip}|${rule.table}`
}

function applyRuleDiffInMemory(rules: IpRule[], diff: BindingRuleDiff): void {
  const removals = new Map<string, number>()
  for (const change of diff.delete) {
    const signature = ruleSignature(change)
    removals.set(signature, (removals.get(signature) ?? 0) + 1)
  }
  const kept: IpRule[] = []
  for (const rule of rules) {
    const ip = ruleIp(rule.from)
    const signature = ip
      ? ruleSignature({ pref: rule.pref, ip, table: rule.table })
      : ''
    const remaining = removals.get(signature) ?? 0
    if (remaining > 0) {
      removals.set(signature, remaining - 1)
    } else {
      kept.push(rule)
    }
  }
  for (const change of diff.add) {
    kept.push({
      pref: change.pref,
      from: `${change.ip}/32`,
      table: change.table
    })
  }
  rules.splice(0, rules.length, ...kept)
}

/** Split generated `ip rule` lines without changing their order. */
export function chunkRuleCommands(lines: readonly string[], sizeRaw: number): string[][] {
  const size = Math.max(1, Math.trunc(sizeRaw) || 1)
  const chunks: string[][] = []
  for (let index = 0; index < lines.length; index += size) {
    chunks.push(lines.slice(index, index + size))
  }
  return chunks
}

/**
 * Reconstruct managed assignment rules. Rules outside the module preference
 * range or outside this LAN are deliberately invisible to the caller.
 */
export function deriveActualAssignments(input: {
  rules: readonly IpRule[]
  leases: readonly Lease[]
  tableToWan: BindingTableToWan
  lanCidr: string
  rulePrefBase: number
  catchAllPrefBase: number
  knownDevices?: readonly BindingDeviceMemory[]
}): BindingActualAssignment[] {
  const subnet = parseCidr(input.lanCidr)
  if (!subnet) return []
  const leasesByIp = new Map<string, string>()
  for (const lease of input.leases) {
    const mac = normalizedMac(lease.mac)
    if (mac && subnetContains(subnet, lease.ip)) leasesByIp.set(lease.ip, mac)
  }
  const knownByIp = new Map(
    (input.knownDevices ?? [])
      .map((device) => [device.ip, normalizedMac(device.mac)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  )
  const tables = normalizeTableMap(input.tableToWan)
  const result: BindingActualAssignment[] = []
  for (const rule of input.rules) {
    if (rule.pref < input.rulePrefBase || rule.pref >= input.catchAllPrefBase) continue
    const ip = ruleIp(rule.from)
    if (!ip) continue
    const knownMac = leasesByIp.get(ip) ?? knownByIp.get(ip) ?? null
    if (!subnetContains(subnet, ip) && knownMac == null) continue
    result.push({
      pref: rule.pref,
      ip,
      table: rule.table,
      wan: tables.get(rule.table) ?? null,
      mac: knownMac
    })
  }
  return result.sort((a, b) => a.pref - b.pref || a.ip.localeCompare(b.ip))
}

class SeededRandom {
  private state: number

  constructor(seedRaw: number) {
    this.state = (Math.trunc(seedRaw) >>> 0) || 0x9e3779b9
  }

  next(): number {
    let value = this.state
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    this.state = value >>> 0
    return this.state / 0x1_0000_0000
  }
}

class FreeWanPool {
  private values: BindingPlannerWan[]
  private positions = new Map<string, number>()

  constructor(values: readonly BindingPlannerWan[]) {
    this.values = [...values]
    this.values.forEach((wan, index) => this.positions.set(wan.name, index))
  }

  get size(): number {
    return this.values.length
  }

  has(name: string): boolean {
    return this.positions.has(name)
  }

  takeNamed(name: string): BindingPlannerWan | null {
    const index = this.positions.get(name)
    return index == null ? null : this.takeAt(index)
  }

  takeRandom(random: SeededRandom, avoid?: string): BindingPlannerWan | null {
    if (this.values.length === 0) return null
    let index = Math.min(
      this.values.length - 1,
      Math.floor(random.next() * this.values.length)
    )
    if (avoid && this.values.length > 1 && this.values[index]?.name === avoid) {
      index = (index + 1) % this.values.length
    }
    return this.takeAt(index)
  }

  private takeAt(index: number): BindingPlannerWan | null {
    const selected = this.values[index]
    if (!selected) return null
    const last = this.values.pop()
    this.positions.delete(selected.name)
    if (last && index < this.values.length) {
      this.values[index] = last
      this.positions.set(last.name, index)
    }
    return selected
  }
}

/**
 * Pure reconciliation planner. It reads no clock/random/global state and
 * mutates none of its inputs, so unit tests can replay a complete outage,
 * reboot or lease transition with deterministic output.
 */
export function planBindingReconciliation(
  input: BindingReconcileInput
): BindingPlannerResult {
  const now = Number.isFinite(input.now) ? input.now : 0
  const policy = input.policy
  const subnet = parseCidr(input.lanCidr)
  const oldMemory = clonePlannerMemory(input.memory)
  if (!subnet) {
    return {
      actual: [],
      desired: [],
      ruleDiff: {
        delete: [],
        add: [],
        deleteLines: [],
        addLines: [],
        lines: [],
        chunks: []
      },
      memory: oldMemory,
      stickyUpdates: [],
      events: [],
      assignments: [],
      waiting: [],
      wan: {
        total: input.wans.length,
        available: 0,
        bound: 0,
        error: 0,
        warning: input.wans.length,
        dialing: 0
      },
      devices: { total: 0, bound: 0, waiting: 0 }
    }
  }

  const releaseGraceMs = Math.max(0, policy.releaseGraceSec) * 1000
  const errorGraceMs = Math.max(0, policy.wanErrorGraceSec) * 1000
  const previousDevices = new Map(
    oldMemory.devices
      .map((device) => [normalizedMac(device.mac), { ...device }] as const)
      .filter((entry): entry is readonly [string, BindingDeviceMemory] =>
        Boolean(entry[0])
      )
  )
  const previousIpToMac = new Map<string, string>()
  for (const [mac, device] of previousDevices) previousIpToMac.set(device.ip, mac)

  // dnsmasq can briefly contain old and new rows for the same MAC. Prefer the
  // row with the later expiry, retaining file order as a stable tie-breaker.
  const currentLeases = new Map<string, CurrentLease>()
  input.leases.forEach((lease, index) => {
    const mac = normalizedMac(lease.mac)
    if (!mac || !subnetContains(subnet, lease.ip) || !activeLease(lease, now)) return
    const old = currentLeases.get(mac)
    if (
      !old ||
      leaseRank(lease) > leaseRank(old.lease) ||
      (leaseRank(lease) === leaseRank(old.lease) && index > old.index)
    ) {
      currentLeases.set(mac, { lease: { ...lease, mac }, index })
    }
  })
  const leasesByIp = new Map<string, string>()
  for (const [mac, current] of currentLeases) leasesByIp.set(current.lease.ip, mac)

  const workingDevices = new Map<string, BindingDeviceMemory>()
  for (const [mac, current] of currentLeases) {
    const previous = previousDevices.get(mac)
    workingDevices.set(mac, {
      mac,
      ip: current.lease.ip,
      host: current.lease.host || previous?.host || '',
      lastSeenAt: now,
      assignedAt: previous?.assignedAt ?? now,
      ...(previous?.wan ? { wan: previous.wan } : {})
    })
  }
  for (const [mac, previous] of previousDevices) {
    if (workingDevices.has(mac)) continue
    if (
      previous.wan &&
      now - previous.lastSeenAt < releaseGraceMs
    ) {
      workingDevices.set(mac, { ...previous })
    }
  }

  const tableToWan = normalizeTableMap(input.tableToWan)
  for (const wan of input.wans) {
    if (wan.table != null && !tableToWan.has(wan.table)) {
      tableToWan.set(wan.table, wan.name)
    }
  }
  const poolByName = new Map(input.wans.map((wan) => [wan.name, wan]))
  const stickyMacByWan = new Map<string, string>()
  const ambiguousStickyWans = new Set<string>()
  for (const choice of input.sticky) {
    const mac = normalizedMac(choice.mac)
    if (!mac || !currentLeases.has(mac) || !choice.wan) continue
    const old = stickyMacByWan.get(choice.wan)
    if (old && old !== mac) {
      ambiguousStickyWans.add(choice.wan)
      stickyMacByWan.delete(choice.wan)
    } else if (!ambiguousStickyWans.has(choice.wan)) {
      stickyMacByWan.set(choice.wan, mac)
    }
  }

  const actual: WorkingActual[] = []
  for (const rule of input.rules) {
    if (rule.pref < policy.rulePrefBase || rule.pref >= policy.catchAllPrefBase) {
      continue
    }
    const ip = ruleIp(rule.from)
    if (!ip) continue
    const mappedWan = tableToWan.get(rule.table) ?? null
    const mac =
      leasesByIp.get(ip) ??
      previousIpToMac.get(ip) ??
      (mappedWan ? stickyMacByWan.get(mappedWan) : undefined) ??
      null
    if (
      !subnetContains(subnet, ip) &&
      mac == null &&
      (mappedWan == null || !poolByName.has(mappedWan))
    ) {
      continue
    }
    actual.push({
      pref: rule.pref,
      ip,
      table: rule.table,
      wan: mappedWan,
      mac,
      source: rule,
      key: `${rule.pref}|${ip}|${rule.table}`,
      exactLease: mac != null && currentLeases.get(mac)?.lease.ip === ip
    })
  }
  actual.sort(
    (a, b) =>
      Number(b.exactLease) - Number(a.exactLease) ||
      a.pref - b.pref ||
      a.ip.localeCompare(b.ip)
  )
  const observedWanByMac = new Map<string, string>()
  for (const entry of actual) {
    if (entry.mac && entry.wan && !observedWanByMac.has(entry.mac)) {
      observedWanByMac.set(entry.mac, entry.wan)
    }
  }

  const held = new Set(oldMemory.heldMacs.map(normalizedMac).filter(Boolean))
  const forced = new Map<string, BindingForcedReassign>()
  for (const entry of oldMemory.forceReassign) {
    const mac = normalizedMac(entry.mac)
    if (mac) forced.set(mac, { mac, ...(entry.avoidWan ? { avoidWan: entry.avoidWan } : {}) })
  }

  const oldOrphans = new Map(oldMemory.orphans.map((entry) => [entry.key, entry]))
  const nextOrphans: BindingOrphanMemory[] = []
  const assignments = new Map<string, WorkingAssignment>()
  const opaqueAssignments: WorkingAssignment[] = []
  const usedWans = new Set<string>()
  const usedMacs = new Set<string>()
  const actualByMac = new Map<string, WorkingActual>()

  if (input.instance.running) {
    // Preserve unmatched post-restart rules for one release grace. This avoids
    // immediately leaking a WAN merely because dnsmasq has not repopulated yet.
    for (const entry of actual) {
      if (entry.mac != null || !entry.wan) continue
      const wan = poolByName.get(entry.wan)
      if (!wan || wan.table !== entry.table || usedWans.has(wan.name)) continue
      const firstMissingAt = oldOrphans.get(entry.key)?.firstMissingAt ?? now
      if (now - firstMissingAt >= releaseGraceMs) continue
      nextOrphans.push({
        key: entry.key,
        ip: entry.ip,
        table: entry.table,
        pref: entry.pref,
        firstMissingAt
      })
      usedWans.add(wan.name)
      opaqueAssignments.push({
        mac: null,
        ip: entry.ip,
        wan: wan.name,
        table: entry.table,
        pref: entry.pref,
        assignedAt: firstMissingAt,
        reason: 'orphan'
      })
    }

    // Preserve one valid rule per MAC and per WAN. Exact-current-IP rules sort
    // ahead of stale-IP duplicates, then lower preferences win deterministically.
    for (const entry of actual) {
      const mac = entry.mac
      if (!mac || usedMacs.has(mac) || held.has(mac) || forced.has(mac)) continue
      const device = workingDevices.get(mac)
      const wan = entry.wan ? poolByName.get(entry.wan) : undefined
      if (
        !device ||
        !wan ||
        wan.table == null ||
        wan.table !== entry.table ||
        usedWans.has(wan.name)
      ) {
        continue
      }
      const previous = previousDevices.get(mac)
      assignments.set(mac, {
        mac,
        ip: device.ip,
        wan: wan.name,
        table: wan.table,
        pref: entry.pref,
        assignedAt:
          previous?.wan === wan.name ? previous.assignedAt : now,
        previousWan: previous?.wan,
        reason: 'actual'
      })
      actualByMac.set(mac, entry)
      usedMacs.add(mac)
      usedWans.add(wan.name)
    }
  }

  // Error timers survive samples but deliberately reset across a router reboot:
  // every WAN is expected to be transiently down while netifd starts.
  const previousErrors = input.rebooted
    ? new Map<string, BindingWanErrorMemory>()
    : new Map(oldMemory.wanErrors.map((entry) => [entry.wan, entry]))
  const nextErrors: BindingWanErrorMemory[] = []
  const errorSince = new Map<string, number>()
  for (const wan of input.wans) {
    if (wanState(wan, policy.wanWarnUptimeSec) !== 'error') continue
    const since = previousErrors.get(wan.name)?.since ?? now
    errorSince.set(wan.name, since)
    nextErrors.push({ wan: wan.name, since })
  }

  const initiallyFree = input.wans.filter(
    (wan) => wanUsable(wan, policy.wanWarnUptimeSec) && !usedWans.has(wan.name)
  )
  let remapCapacity = initiallyFree.length
  const priority: BindingForcedReassign[] = [...forced.values()]
  if (
    input.instance.running &&
    input.instance.remap &&
    remapCapacity > 0
  ) {
    const candidates = [...assignments.entries()]
      .filter(([, assignment]) => {
        const since = errorSince.get(assignment.wan)
        return since != null && now - since >= errorGraceMs
      })
      .sort((a, b) => {
        const aSince = errorSince.get(a[1].wan) ?? now
        const bSince = errorSince.get(b[1].wan) ?? now
        return aSince - bSince || (a[1].pref ?? 0) - (b[1].pref ?? 0)
      })
    for (const [mac, assignment] of candidates) {
      if (remapCapacity <= 0) break
      assignments.delete(mac)
      usedMacs.delete(mac)
      usedWans.delete(assignment.wan)
      priority.push({ mac, avoidWan: assignment.wan })
      remapCapacity -= 1
    }
  }

  // Rebuild FIFO from still-present leases. Existing entries retain their
  // sequence; all new leases append in lease-file order.
  const queueByMac = new Map<string, BindingWaitingMemory>()
  for (const entry of [...oldMemory.waiting].sort((a, b) => a.order - b.order)) {
    const mac = normalizedMac(entry.mac)
    if (!mac || !currentLeases.has(mac) || assignments.has(mac) || queueByMac.has(mac)) {
      continue
    }
    queueByMac.set(mac, { ...entry, mac })
  }
  let nextOrder = oldMemory.nextOrder
  const currentInOrder = [...currentLeases.entries()].sort(
    (a, b) => a[1].index - b[1].index
  )
  for (const [mac] of currentInOrder) {
    if (assignments.has(mac) || queueByMac.has(mac)) continue
    queueByMac.set(mac, { mac, enqueuedAt: now, order: nextOrder++ })
  }

  const freeWans = new FreeWanPool(
    input.wans.filter(
      (wan) =>
        wanUsable(wan, policy.wanWarnUptimeSec) &&
        !usedWans.has(wan.name)
    )
  )
  const random = new SeededRandom(input.randomSeed ?? 1)
  const stickyByMac = new Map<string, BindingStickyChoice>()
  for (const choice of input.sticky) {
    const mac = normalizedMac(choice.mac)
    if (mac && !stickyByMac.has(mac)) stickyByMac.set(mac, { ...choice, mac })
  }

  const allocationOrder: BindingForcedReassign[] = []
  const queuedForAllocation = new Set<string>()
  for (const request of priority) {
    if (
      currentLeases.has(request.mac) &&
      !held.has(request.mac) &&
      !queuedForAllocation.has(request.mac)
    ) {
      queuedForAllocation.add(request.mac)
      allocationOrder.push(request)
    }
  }
  for (const entry of [...queueByMac.values()].sort((a, b) => a.order - b.order)) {
    if (held.has(entry.mac) || queuedForAllocation.has(entry.mac)) continue
    queuedForAllocation.add(entry.mac)
    allocationOrder.push({ mac: entry.mac })
  }

  for (const request of allocationOrder) {
    if (!input.instance.running || assignments.has(request.mac)) continue
    const device = workingDevices.get(request.mac)
    if (!device) continue
    const isForced = forced.has(request.mac)
    let selected: BindingPlannerWan | null = null
    if (
      !isForced &&
      input.instance.sticky
    ) {
      const choice = stickyByMac.get(request.mac)
      if (choice && freeWans.has(choice.wan)) selected = freeWans.takeNamed(choice.wan)
    }
    selected ??= freeWans.takeRandom(random, request.avoidWan)
    if (!selected || selected.table == null) continue
    const oldWan =
      request.avoidWan ??
      observedWanByMac.get(request.mac) ??
      previousDevices.get(request.mac)?.wan
    assignments.set(request.mac, {
      mac: request.mac,
      ip: device.ip,
      wan: selected.name,
      table: selected.table,
      pref: null,
      assignedAt:
        previousDevices.get(request.mac)?.wan === selected.name
          ? previousDevices.get(request.mac)?.assignedAt ?? now
          : now,
      ...(oldWan ? { previousWan: oldWan } : {}),
      reason: isForced
        ? 'forced'
        : request.avoidWan
          ? 'remap'
          : stickyByMac.get(request.mac)?.wan === selected.name
            ? 'sticky'
            : 'random'
    })
    usedWans.add(selected.name)
  }

  // Every rule outside this LAN reserves its preference. Owned rules are
  // released first; valid preserved rules then reserve their existing pref.
  const availablePrefs = new Set<number>()
  for (let pref = policy.rulePrefBase; pref < policy.catchAllPrefBase; pref++) {
    availablePrefs.add(pref)
  }
  const ownedKeys = new Set(actual.map((entry) => entry.key))
  for (const rule of input.rules) {
    if (rule.pref < policy.rulePrefBase || rule.pref >= policy.catchAllPrefBase) continue
    const ip = ruleIp(rule.from)
    const key = ip ? `${rule.pref}|${ip}|${rule.table}` : ''
    if (!ownedKeys.has(key)) availablePrefs.delete(rule.pref)
  }
  for (const assignment of [...opaqueAssignments, ...assignments.values()]) {
    if (assignment.pref != null && availablePrefs.has(assignment.pref)) {
      availablePrefs.delete(assignment.pref)
    } else if (assignment.pref != null) {
      // A duplicate/conflicting pref is not safe to preserve; allocate it below.
      assignment.pref = null
    }
  }
  let nextPref = policy.rulePrefBase
  const takePref = (): number | null => {
    while (nextPref < policy.catchAllPrefBase && !availablePrefs.has(nextPref)) {
      nextPref += 1
    }
    if (nextPref >= policy.catchAllPrefBase) return null
    const selected = nextPref
    availablePrefs.delete(selected)
    nextPref += 1
    return selected
  }

  const unallocatable = new Set<string>()
  for (const assignment of assignments.values()) {
    if (assignment.pref != null) continue
    assignment.pref = takePref()
    if (assignment.pref == null && assignment.mac) unallocatable.add(assignment.mac)
  }
  for (const mac of unallocatable) assignments.delete(mac)
  for (const assignment of opaqueAssignments) {
    if (assignment.pref == null) assignment.pref = takePref()
  }

  const desired: BindingDesiredAssignment[] = []
  for (const assignment of [...opaqueAssignments, ...assignments.values()]) {
    if (assignment.pref == null) continue
    desired.push({
      pref: assignment.pref,
      ip: assignment.ip,
      table: assignment.table,
      wan: assignment.wan,
      mac: assignment.mac,
      assignedAt: assignment.assignedAt
    })
  }
  desired.sort((a, b) => a.pref - b.pref)

  // Compare whole preference groups. If a corrupt snapshot contains duplicate
  // preferences, delete the group and recreate the one desired rule.
  const actualByPref = new Map<number, WorkingActual[]>()
  for (const entry of actual) {
    const group = actualByPref.get(entry.pref) ?? []
    group.push(entry)
    actualByPref.set(entry.pref, group)
  }
  const desiredByPref = new Map<number, BindingDesiredAssignment[]>()
  for (const entry of desired) {
    const group = desiredByPref.get(entry.pref) ?? []
    group.push(entry)
    desiredByPref.set(entry.pref, group)
  }
  const deleteChanges: BindingRuleChange[] = []
  const addChanges: BindingRuleChange[] = []
  const prefs = new Set([...actualByPref.keys(), ...desiredByPref.keys()])
  for (const pref of [...prefs].sort((a, b) => a - b)) {
    const oldGroup = actualByPref.get(pref) ?? []
    const newGroup = desiredByPref.get(pref) ?? []
    const oldSignatures = oldGroup
      .map((entry) => ruleSignature(entry))
      .sort()
    const newSignatures = newGroup
      .map((entry) => ruleSignature(entry))
      .sort()
    if (
      oldSignatures.length === newSignatures.length &&
      oldSignatures.every((signature, index) => signature === newSignatures[index])
    ) {
      continue
    }
    for (const entry of oldGroup) {
      deleteChanges.push({ pref: entry.pref, ip: entry.ip, table: entry.table })
    }
    for (const entry of newGroup) {
      addChanges.push({ pref: entry.pref, ip: entry.ip, table: entry.table })
    }
  }
  const deleteLines = deleteChanges.map(
    (entry) => `ip -4 rule del pref ${entry.pref} 2>/dev/null || true`
  )
  const addLines = addChanges.map(
    (entry) =>
      `ip -4 rule add from ${entry.ip}/32 lookup ${entry.table} pref ${entry.pref}`
  )
  const lines = [...deleteLines, ...addLines]

  const desiredByMac = new Map(
    desired
      .filter(
        (entry): entry is BindingDesiredAssignment & { mac: string } =>
          entry.mac != null
      )
      .map((entry) => [entry.mac, entry] as const)
  )
  const nextDevices: BindingDeviceMemory[] = []
  for (const [mac, current] of currentInOrder) {
    const lease = current.lease
    const assignment = desiredByMac.get(mac)
    const previous = previousDevices.get(mac)
    nextDevices.push({
      mac,
      ip: lease.ip,
      host: lease.host || previous?.host || '',
      lastSeenAt: now,
      assignedAt:
        assignment == null
          ? previous?.assignedAt ?? now
          : previous?.wan === assignment.wan
            ? previous.assignedAt
            : assignment.assignedAt,
      ...(assignment ? { wan: assignment.wan } : {})
    })
  }
  for (const [mac, previous] of previousDevices) {
    if (currentLeases.has(mac)) continue
    const assignment = desiredByMac.get(mac)
    if (!assignment || now - previous.lastSeenAt >= releaseGraceMs) continue
    nextDevices.push({
      ...previous,
      assignedAt:
        previous.wan === assignment.wan ? previous.assignedAt : assignment.assignedAt,
      wan: assignment.wan
    })
  }
  const nextDeviceByMac = new Map(nextDevices.map((device) => [device.mac, device]))

  const nextWaiting = [...queueByMac.values()]
    .filter((entry) => currentLeases.has(entry.mac) && !desiredByMac.has(entry.mac))
    .sort((a, b) => a.order - b.order)
  const waitingRows: BindingWaitingRow[] = nextWaiting.map((entry, index) => {
    const lease = currentLeases.get(entry.mac)?.lease
    const isHeld = held.has(entry.mac)
    return {
      key: `${input.instance.id}|${entry.mac}`,
      instanceId: input.instance.id,
      mac: entry.mac,
      host: lease?.host ?? previousDevices.get(entry.mac)?.host ?? '',
      ip: lease?.ip ?? previousDevices.get(entry.mac)?.ip ?? '',
      position: index + 1,
      waitingSince: entry.enqueuedAt,
      waitingFor: durationLabel(now - entry.enqueuedAt),
      held: isHeld,
      heldLabel: isHeld ? 'Held' : 'Waiting'
    }
  })

  const assignmentRows: BindingAssignmentRow[] = desired
    .filter(
      (entry): entry is BindingDesiredAssignment & { mac: string } =>
        entry.mac != null
    )
    .map((entry) => {
      const device = nextDeviceByMac.get(entry.mac)
      const wan = poolByName.get(entry.wan)
      const state = wan ? wanState(wan, policy.wanWarnUptimeSec) : 'missing'
      return {
        key: `${input.instance.id}|${entry.mac}`,
        instanceId: input.instance.id,
        host: device?.host ?? '',
        mac: entry.mac,
        ip: entry.ip,
        wan: entry.wan,
        wanIp: wan?.ipv4 ?? '',
        wanStatus: state === 'available' ? 'bound' : state,
        sinceLabel: durationLabel(now - entry.assignedAt)
      }
    })

  const events: BindingPlannerEvent[] = []
  const eventKeys = new Set<string>()
  const pushEvent = (kind: string, text: string, key: string): void => {
    if (eventKeys.has(key) || events.length >= Math.max(1, policy.maxEvents)) return
    eventKeys.add(key)
    events.push({ t: now, kind, text })
  }
  if (input.instance.running) {
    const oldWaiting = new Set(oldMemory.waiting.map((entry) => normalizedMac(entry.mac)))
    for (const [mac, current] of currentLeases) {
      const previous = previousDevices.get(mac)
      const assignment = desiredByMac.get(mac)
      const actualEntry = actualByMac.get(mac)
      const oldWan = previous?.wan ?? observedWanByMac.get(mac)
      if (assignment) {
        if (oldWan && oldWan !== assignment.wan) {
          pushEvent(
            'remapped',
            `${mac} (${current.lease.ip}) moved from ${oldWan} to ${assignment.wan}`,
            `remap:${mac}:${assignment.wan}`
          )
        } else if (!oldWan && actualEntry?.wan !== assignment.wan) {
          pushEvent(
            'assigned',
            `${mac} (${current.lease.ip}) assigned to ${assignment.wan}`,
            `assign:${mac}:${assignment.wan}`
          )
        }
        if (
          previous?.wan === assignment.wan &&
          previous.ip !== current.lease.ip
        ) {
          pushEvent(
            'ip-change',
            `${mac} kept ${assignment.wan} after IP changed from ${previous.ip} to ${current.lease.ip}`,
            `ip:${mac}:${current.lease.ip}`
          )
        }
      } else if (previous?.wan) {
        pushEvent(
          held.has(mac) ? 'unassigned' : 'waiting',
          `${mac} (${current.lease.ip}) released ${previous.wan} and is waiting`,
          `release:${mac}`
        )
      }
      if (!assignment && !oldWaiting.has(mac)) {
        pushEvent(
          'waiting',
          `${mac} (${current.lease.ip}) entered the WAN queue`,
          `wait:${mac}`
        )
      }
    }
    for (const [mac, previous] of previousDevices) {
      if (
        currentLeases.has(mac) ||
        now - previous.lastSeenAt < releaseGraceMs ||
        !previous.wan
      ) {
        continue
      }
      pushEvent(
        'released',
        `${mac} lease grace expired; ${previous.wan} returned to the pool`,
        `expired:${mac}`
      )
    }
  }

  const usedWanNames = new Set(desired.map((entry) => entry.wan))
  const wanSummary: BindingWanSummary = {
    total: input.wans.length,
    available: 0,
    bound: 0,
    error: 0,
    warning: 0,
    dialing: 0
  }
  for (const wan of input.wans) {
    const state = wanState(wan, policy.wanWarnUptimeSec)
    if (state === 'dialing') wanSummary.dialing += 1
    else if (state === 'error') wanSummary.error += 1
    else if (state === 'warning') wanSummary.warning += 1
    else if (usedWanNames.has(wan.name)) wanSummary.bound += 1
    else wanSummary.available += 1
  }

  const stickyUpdates: BindingStickyChoice[] =
    input.instance.sticky
      ? desired
          .filter(
            (entry): entry is BindingDesiredAssignment & { mac: string } =>
              entry.mac != null
          )
          .map((entry) => ({ mac: entry.mac, wan: entry.wan, lastSeenAt: now }))
      : []

  return {
    actual: actual.map(({ pref, ip, table, wan, mac }) => ({
      pref,
      ip,
      table,
      wan,
      mac
    })),
    desired,
    ruleDiff: {
      delete: deleteChanges,
      add: addChanges,
      deleteLines,
      addLines,
      lines,
      chunks: chunkRuleCommands(lines, policy.ruleChunkLines)
    },
    memory: {
      devices: nextDevices,
      waiting: nextWaiting,
      wanErrors: nextErrors,
      orphans: nextOrphans,
      heldMacs: [...held].filter((mac) => currentLeases.has(mac)),
      forceReassign: [],
      nextOrder
    },
    stickyUpdates,
    events,
    assignments: assignmentRows,
    waiting: waitingRows,
    wan: wanSummary,
    devices: {
      total: nextDevices.length,
      bound: assignmentRows.length,
      waiting: waitingRows.length
    }
  }
}

/** Short aliases kept convenient for unit fixtures. */
export const planBinding = planBindingReconciliation
export const reconcileBinding = planBindingReconciliation

// ---------------------------------------------------------------------------
// Engine integration

export interface BindingSummaryInstance {
  id: string
  name: string
  lan: string
  carrier: string
  running: boolean
  wan: BindingWanSummary
  devices: BindingDeviceSummary
}

export interface BindingSnapshot {
  t: number
  instances: BindingSummaryInstance[]
  /** Flattened renderer rows; kept small because there is one per automation instance. */
  rows: BindingListRow[]
}

export interface BindingListRow extends BindingSummaryInstance {
  runningLabel: string
  wanTotal: number
  wanAvailable: number
  wanBound: number
  wanError: number
  wanWarning: number
  wanDialing: number
  deviceTotal: number
  deviceBound: number
  deviceWaiting: number
}

export interface BindingEventRow {
  id: string
  when: string
  t: number
  kind: string
  text: string
}

export interface BindingJobRunner {
  start(spec: JobSpec): { id: string }
}

export type WanTableSource =
  | Readonly<Record<string, number>>
  | ReadonlyArray<readonly [string, number]>

export interface BindingEngineOptions {
  rules: () => OwrtRules
  jobs?: BindingJobRunner
  /** Latest slow-tick UCI section -> table mapping. */
  wanTables?: () => WanTableSource
  /** FastSweep uses this to force a fresh interface dump after mutations. */
  requestDump?: () => void
}

interface InstanceCache {
  summary: BindingSummaryInstance
  assignments: BindingAssignmentRow[]
  waiting: BindingWaitingRow[]
}

interface WanTableIndex {
  byWan: Map<string, number>
  byTable: Map<number, string>
  conflicts: Array<{ table: number; first: string; second: string }>
}

interface UciDocument {
  values: Map<string, string>
  sectionTypes: Map<string, string>
  /** Retains repeated UCI list options; `values` deliberately keeps only the last. */
  entries: Array<[key: string, value: string]>
}

interface RouterPreparationProbe {
  dhcp: UciDocument
  network: UciDocument
  firewall: UciDocument
  sysctl: Map<string, number>
}

interface TablePreparation {
  wan: string
  table: number
}

interface DhcpPreparation {
  section: string
  dnsmasqSection: string
  lanLimit: number
  globalLimit: number
}

interface BindingCreatePlan {
  instance: BindingInstanceRecord
  lanCidr: string
  lanZone: string
  destinationZones: string[]
  tableAdds: TablePreparation[]
  dhcp?: DhcpPreparation
}

interface ReconcileOutcome {
  instance: BindingInstanceRecord
  result: BindingPlannerResult
}

const PREPARATION_SCRIPT = String.raw`set +e
command -v uci >/dev/null 2>&1 || exit 20
echo '===DHCP==='
uci -q show dhcp 2>/dev/null
echo '===NETWORK==='
uci -q show network 2>/dev/null
echo '===FIREWALL==='
uci -q show firewall 2>/dev/null
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

function textField(values: Record<string, unknown>, key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value)
}

function makeBindingId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `bind_${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
  return `bind_${Date.now().toString(36)}`
}

function lanCidr(iface: IfaceState | undefined): string | null {
  if (!iface?.ipv4) return null
  const prefix = Math.trunc(iface.ipv4.mask)
  if (prefix < 0 || prefix > 32) return null
  const parsed = parseCidr(`${iface.ipv4.addr}/${prefix}`)
  return parsed?.cidr ?? null
}

function carrierMatches(device: string, carrier: string): boolean {
  return device === carrier || device.startsWith(`${carrier}.`)
}

function carrierScopesOverlap(first: string, second: string): boolean {
  return (
    first === second ||
    first.startsWith(`${second}.`) ||
    second.startsWith(`${first}.`)
  )
}

function poolIfaces(model: RouterModel, lan: string, carrier: string): IfaceState[] {
  const seen = new Set<string>()
  const result: IfaceState[] = []
  for (const iface of model.ifaces) {
    if (
      iface.name === lan ||
      iface.name === 'loopback' ||
      !['pppoe', 'dhcp', 'static'].includes(iface.proto) ||
      !carrierMatches(iface.device, carrier) ||
      seen.has(iface.name)
    ) {
      continue
    }
    seen.add(iface.name)
    result.push(iface)
  }
  return result
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

function parseUciDocument(raw: string): UciDocument {
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

function uciOption(
  document: UciDocument,
  config: string,
  section: string,
  option: string
): string {
  return document.values.get(`${config}.${section}.${option}`) ?? ''
}

function sectionsOfType(
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

function firewallZoneForNetwork(document: UciDocument, network: string): string {
  for (const section of sectionsOfType(document, 'firewall', 'zone')) {
    const key = `firewall.${section}.network`
    if (!document.entries.some(([entryKey, value]) => entryKey === key && value === network)) {
      continue
    }
    return uciOption(document, 'firewall', section, 'name') || section
  }
  return ''
}

function firewallZoneMasquerades(document: UciDocument, zoneName: string): boolean {
  for (const section of sectionsOfType(document, 'firewall', 'zone')) {
    const name = uciOption(document, 'firewall', section, 'name') || section
    if (name !== zoneName) continue
    return uciOption(document, 'firewall', section, 'masq') === '1'
  }
  return false
}

function ifaceScopeKeys(iface: IfaceState | undefined): string[] {
  if (!iface) return []
  return [iface.name, iface.device, iface.l3Device].filter(Boolean)
}

function isManagedPppoeSection(
  name: string,
  batches: ReadonlyArray<{ prefix: string }>
): boolean {
  return batches.some((batch) => {
    if (!name.startsWith(batch.prefix)) return false
    const seq = name.slice(batch.prefix.length)
    return /^\d{5}$/.test(seq)
  })
}

function numericOption(value: string, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback
}

function tableSourceEntries(source: WanTableSource | undefined): Array<[string, number]> {
  if (!source) return []
  if (Array.isArray(source)) {
    return source
      .map((entry) => [String(entry[0]), Number(entry[1])] as [string, number])
      .filter((entry) => entry[0] && Number.isSafeInteger(entry[1]) && entry[1] > 0)
  }
  return Object.entries(source)
    .map(([wan, table]) => [wan, Number(table)] as [string, number])
    .filter((entry) => entry[0] && Number.isSafeInteger(entry[1]) && entry[1] > 0)
}

function buildWanTableIndex(
  model: RouterModel,
  data: OwrtHostData,
  rules: OwrtRules,
  source?: WanTableSource
): WanTableIndex {
  const candidates = new Map<string, number>()

  // The naming convention is a fallback. Persisted and router-observed values
  // below override it.
  for (const batch of data.batches) {
    for (let seq = batch.seqFrom; seq <= batch.seqTo; seq++) {
      candidates.set(`${batch.prefix}${String(seq).padStart(5, '0')}`, rules.tableBase + seq)
    }
  }
  for (const [wan, table] of data.extraTables) candidates.set(wan, table)
  for (const iface of model.ifaces) {
    if (iface.ip4Table != null && iface.ip4Table > 0) {
      candidates.set(iface.name, iface.ip4Table)
    }
  }
  for (const [wan, table] of tableSourceEntries(source)) candidates.set(wan, table)

  const byWan = new Map<string, number>()
  const byTable = new Map<number, string>()
  const conflicts: WanTableIndex['conflicts'] = []
  const conflictedTables = new Map<number, string>()
  for (const [wan, table] of candidates) {
    const firstConflict = conflictedTables.get(table)
    if (firstConflict) {
      conflicts.push({ table, first: firstConflict, second: wan })
      byWan.delete(wan)
      continue
    }
    const oldWan = byTable.get(table)
    if (oldWan && oldWan !== wan) {
      conflicts.push({ table, first: oldWan, second: wan })
      conflictedTables.set(table, oldWan)
      byWan.delete(oldWan)
      byWan.delete(wan)
      byTable.delete(table)
      continue
    }
    byWan.set(wan, table)
    byTable.set(table, wan)
  }
  return { byWan, byTable, conflicts }
}

function plannerWans(
  model: RouterModel,
  instance: BindingInstanceRecord,
  tables: WanTableIndex
): BindingPlannerWan[] {
  return poolIfaces(model, instance.lan, instance.carrier).map((iface) => ({
    name: iface.name,
    table: tables.byWan.get(iface.name) ?? null,
    up: iface.up,
    pending: iface.pending,
    ...(iface.ipv4?.addr ? { ipv4: iface.ipv4.addr } : {}),
    uptimeSec: iface.uptimeSec,
    ...(iface.errorCode ? { errorCode: iface.errorCode } : {})
  }))
}

function plannerPolicy(rules: OwrtRules): BindingPlannerPolicy {
  return {
    rulePrefBase: rules.rulePrefBase,
    catchAllPrefBase: rules.catchAllPrefBase,
    ruleChunkLines: rules.ruleChunkLines,
    wanErrorGraceSec: rules.wanErrorGraceSec,
    wanWarnUptimeSec: rules.wanWarnUptimeSec,
    releaseGraceSec: rules.releaseGraceSec,
    remapOnWanError: rules.remapOnWanError,
    stickyByMac: rules.stickyByMac,
    maxEvents: rules.maxEvents
  }
}

function emptyWanSummary(): BindingWanSummary {
  return { total: 0, available: 0, bound: 0, error: 0, warning: 0, dialing: 0 }
}

function emptyDeviceSummary(): BindingDeviceSummary {
  return { total: 0, bound: 0, waiting: 0 }
}

function shellFailure(label: string, code: number): Error {
  return new Error(`${label} failed (exit ${code})`)
}

function cloneMemory(memory: BindingPlannerMemory): BindingPlannerMemory {
  return clonePlannerMemory(memory)
}

export class BindingEngine {
  private checkSession = createCheckSession<BindingCreatePlan>()
  private latestModel: RouterModel | null = null
  private lastUptime: number | null = null
  private memory = new Map<string, BindingPlannerMemory>()
  private cache = new Map<string, InstanceCache>()
  private latestPayload: BindingSnapshot = { t: 0, instances: [], rows: [] }
  private serial: Promise<void> = Promise.resolve()
  private workGeneration = 0
  private disposed = false
  private manualWanTables: WanTableSource | undefined
  private preparations = new Map<string, BindingCreatePlan>()
  private lastTableAuditWarning = ''

  constructor(
    private ctx: ModuleContext,
    private store: HostStore,
    private options: BindingEngineOptions
  ) {}

  // ---------------------------------------------------------------- queries

  snapshot(): BindingSnapshot {
    return this.latestPayload
  }

  bindingList(): BindingListRow[] {
    return this.list()
  }

  list(): BindingListRow[] {
    return this.store.read().instances.map((instance) => {
      const summary = this.cache.get(instance.id)?.summary ?? {
        id: instance.id,
        name: instance.name,
        lan: instance.lan,
        carrier: instance.carrier,
        running: instance.running,
        wan: emptyWanSummary(),
        devices: emptyDeviceSummary()
      }
      return {
        ...summary,
        runningLabel: instance.running ? 'running' : 'stopped',
        wanTotal: summary.wan.total,
        wanAvailable: summary.wan.available,
        wanBound: summary.wan.bound,
        wanError: summary.wan.error,
        wanWarning: summary.wan.warning,
        wanDialing: summary.wan.dialing,
        deviceTotal: summary.devices.total,
        deviceBound: summary.devices.bound,
        deviceWaiting: summary.devices.waiting
      }
    })
  }

  bindingRows(idRaw: unknown): BindingAssignmentRow[] {
    return this.rows(idRaw)
  }

  rows(idRaw: unknown): BindingAssignmentRow[] {
    return [...(this.cache.get(String(idRaw ?? ''))?.assignments ?? [])]
  }

  bindingWaitingRows(idRaw: unknown): BindingWaitingRow[] {
    return this.waitingRows(idRaw)
  }

  waitingRows(idRaw: unknown): BindingWaitingRow[] {
    return [...(this.cache.get(String(idRaw ?? ''))?.waiting ?? [])]
  }

  bindingEventRows(idRaw: unknown): BindingEventRow[] {
    return this.eventRows(idRaw)
  }

  eventRows(idRaw: unknown): BindingEventRow[] {
    const id = String(idRaw ?? '')
    return this.store
      .read()
      .events.map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry[0] === id)
      .reverse()
      .map(({ entry, index }) => ({
        id: `${entry[1]}-${index}`,
        when: new Date(entry[1]).toISOString(),
        t: entry[1],
        kind: entry[2],
        text: entry[3]
      }))
  }

  /** SlowSweep may hand over its fresh `uci ... ip4table` mapping. */
  setWanTables(source: WanTableSource): void {
    this.manualWanTables = source
  }

  /**
   * Slow-tick ownership audit. A deleted `option ip4table` would otherwise
   * survive in the running netifd state until the next reboot, then silently
   * strand every sticky assignment that points at it.
   */
  async reconcileWanTables(source: WanTableSource): Promise<void> {
    this.manualWanTables = source
    if (this.disposed || !this.latestModel || this.store.read().instances.length === 0) return
    await this.exclusive(async () => {
      const model = this.latestModel
      if (!model || this.disposed) return
      const data = this.store.read()
      const rules = this.options.rules()
      const observed = new Map(tableSourceEntries(source))
      const expected = new Map<string, number>()
      for (const batch of data.batches) {
        for (let seq = batch.seqFrom; seq <= batch.seqTo; seq++) {
          expected.set(
            `${batch.prefix}${String(seq).padStart(5, '0')}`,
            rules.tableBase + seq
          )
        }
      }
      for (const [wan, table] of data.extraTables) expected.set(wan, table)
      for (const iface of model.ifaces) {
        if (iface.ip4Table != null && !expected.has(iface.name)) {
          expected.set(iface.name, iface.ip4Table)
        }
      }

      const missing = new Map<string, number>()
      const conflicts: string[] = []
      for (const instance of data.instances) {
        for (const iface of poolIfaces(model, instance.lan, instance.carrier)) {
          const wanted = expected.get(iface.name)
          if (wanted == null || !UCI_SECTION.test(iface.name)) continue
          const current = observed.get(iface.name)
          if (current == null) missing.set(iface.name, wanted)
          else if (current !== wanted) {
            conflicts.push(`${iface.name}: expected ${wanted}, found ${current}`)
          }
        }
      }
      const warning = conflicts.sort().join('; ')
      if (warning && warning !== this.lastTableAuditWarning) {
        this.ctx.log(`openwrt: WAN table ownership conflict; not overwriting (${warning})`)
      }
      this.lastTableAuditWarning = warning
      if (missing.size === 0) return

      const entries = [...missing].map(([wan, table]) => ({ wan, table }))
      for (let index = 0; index < entries.length; index += rules.uciChunkSize) {
        const chunk = entries.slice(index, index + rules.uciChunkSize)
        const lines = chunk.map(
          (entry) => `set network.${entry.wan}.ip4table='${entry.table}'`
        )
        lines.push('commit network')
        const result = await this.ctx.exec('uci -q batch', {
          stdin: `${lines.join('\n')}\n`,
          timeoutMs: rules.execTimeoutSec * 1000
        })
        if (result.code !== 0) throw shellFailure('repair WAN routing tables', result.code)
      }
      const reload = await this.ctx.exec('/etc/init.d/network reload', {
        timeoutMs: rules.execTimeoutSec * 1000
      })
      if (reload.code !== 0) throw shellFailure('reload repaired WAN tables', reload.code)
      this.manualWanTables = [
        ...observed,
        ...entries.map((entry) => [entry.wan, entry.table] as const)
      ]
      this.options.requestDump?.()
      this.ctx.log(`openwrt: restored option ip4table on ${entries.length} WAN(s)`)
    })
  }

  // ------------------------------------------------------------- check/apply

  async bindingCheck(raw: unknown): Promise<ModuleCheckReport> {
    return this.check(raw)
  }

  async check(raw: unknown): Promise<ModuleCheckReport> {
    const values =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : {}
    const findings: ModuleCheckFinding[] = []
    if (!this.ctx.connected) {
      return {
        ok: false,
        findings: [{ level: 'error', label: 'The router is not connected' }]
      }
    }
    const model = this.latestModel
    if (!model) {
      return {
        ok: false,
        findings: [{
          level: 'error',
          label: 'No router sample is available',
          detail: 'Run Refresh once, then check this form again.'
        }]
      }
    }

    const name = textField(values, 'name')
    const lan = textField(values, 'lan')
    const carrier = textField(values, 'carrier')
    const rules = this.options.rules()
    const sticky =
      typeof values.sticky === 'boolean' ? values.sticky : rules.stickyByMac
    const remap =
      typeof values.remap === 'boolean' ? values.remap : rules.remapOnWanError
    const raiseDhcpLimits = values.raiseDhcpLimits === true
    if (!name || name.length > 80) {
      findings.push({
        level: 'error',
        label: 'Instance name must contain 1-80 characters'
      })
    } else if (
      this.store
        .read()
        .instances.some((instance) => instance.name.toLowerCase() === name.toLowerCase())
    ) {
      findings.push({ level: 'error', label: `An instance named "${name}" already exists` })
    }
    if (!lan || !carrier) {
      findings.push({
        level: 'error',
        label: 'Choose exactly one LAN interface and one WAN carrier'
      })
    } else if (lan === carrier) {
      findings.push({
        level: 'error',
        label: 'The LAN logical interface and WAN carrier must be different'
      })
    }

    const lanIface = model.ifaces.find((iface) => iface.name === lan)
    const cidr = lanCidr(lanIface)
    if (!lanIface) {
      findings.push({ level: 'error', label: `LAN interface "${lan}" is not in the router model` })
    } else if (!cidr) {
      findings.push({
        level: 'error',
        label: `LAN interface "${lan}" has no usable IPv4 subnet`
      })
    } else {
      findings.push({ level: 'pass', label: `LAN ${lan} is scoped to ${cidr}` })
      const parsed = parseCidr(cidr)
      for (const other of this.store.read().instances) {
        const otherCidr = lanCidr(
          model.ifaces.find((iface) => iface.name === other.lan)
        )
        const otherParsed = otherCidr ? parseCidr(otherCidr) : null
        if (parsed && otherParsed && subnetsOverlap(parsed, otherParsed)) {
          findings.push({
            level: 'error',
            label: `${cidr} overlaps ${otherCidr} used by "${other.name}"`,
            detail: 'Source-only IPv4 rules cannot distinguish clients in overlapping LAN subnets.'
          })
        }
      }
    }

    const carrierExists = model.ifaces.some(
      (iface) =>
        iface.device === carrier ||
        iface.l3Device === carrier ||
        carrierMatches(iface.device, carrier)
    ) || Object.prototype.hasOwnProperty.call(model.rates, carrier)
    if (!carrierExists) {
      findings.push({
        level: 'error',
        label: `Carrier "${carrier}" is not used by a router interface`
      })
    }

    if (
      lanIface &&
      carrier &&
      ifaceScopeKeys(lanIface).some((key) => carrierScopesOverlap(key, carrier))
    ) {
      findings.push({
        level: 'error',
        label: 'The LAN physical device and WAN carrier overlap',
        detail: `${lan} uses ${[lanIface.device, lanIface.l3Device].filter(Boolean).join(' / ')}.`
      })
    }

    const clashes = this.store.read().instances.filter((instance) => {
      const otherLan = model.ifaces.find((iface) => iface.name === instance.lan)
      return (
        instance.lan === lan ||
        instance.carrier === lan ||
        instance.lan === carrier ||
        carrierScopesOverlap(instance.carrier, carrier) ||
        ifaceScopeKeys(otherLan).some((key) => carrierScopesOverlap(key, carrier)) ||
        ifaceScopeKeys(lanIface).some((key) => carrierScopesOverlap(key, instance.carrier))
      )
    })
    if (clashes.length) {
      findings.push({
        level: 'error',
        label: 'An interface is already owned by another binding instance',
        detail: clashes.map((instance) => `${instance.name}: ${instance.lan} + ${instance.carrier}`).join(', ')
      })
    } else if (lan && carrier) {
      findings.push({
        level: 'pass',
        label: `Exactly two exclusive interfaces: ${lan} + ${carrier}`
      })
    }

    const pool = poolIfaces(model, lan, carrier)
    if (pool.length === 0) {
      findings.push({
        level: 'warning',
        label: `No PPPoE, DHCP or static WAN currently uses ${carrier}`,
        detail: 'The instance can still start; WANs that dial later will enter this carrier-scoped pool.'
      })
    } else {
      findings.push({
        level: 'pass',
        label: `${pool.length} WAN interface(s) are scoped to carrier ${carrier}`
      })
    }

    let probe: RouterPreparationProbe | null = null
    try {
      probe = await this.preparationProbe()
    } catch (error) {
      findings.push({
        level: 'error',
        label: 'Router preparation state could not be read',
        detail: error instanceof Error ? error.message : String(error)
      })
    }

    const data = this.store.read()
    const externalTables = this.currentWanTables()
    const tableIndex = buildWanTableIndex(model, data, rules, externalTables)
    for (const conflict of tableIndex.conflicts) {
      if (!pool.some((iface) => iface.name === conflict.first || iface.name === conflict.second)) {
        continue
      }
      findings.push({
        level: 'error',
        label: `Routing table ${conflict.table} is shared by ${conflict.first} and ${conflict.second}`,
        detail: 'Every WAN in a one-to-one pool needs a unique ip4table.'
      })
    }

    const networkTables = probe ? this.networkTables(probe.network) : new Map<string, number>()
    const networkTableOwners = new Map<number, string>()
    for (const [wan, table] of networkTables) {
      const owner = networkTableOwners.get(table)
      if (
        owner &&
        owner !== wan &&
        pool.some((iface) => iface.name === owner || iface.name === wan)
      ) {
        findings.push({
          level: 'error',
          label: `Router UCI assigns table ${table} to both ${owner} and ${wan}`,
          detail: 'Correct the duplicate ip4table values before starting one-to-one binding.'
        })
      } else if (!owner) {
        networkTableOwners.set(table, wan)
      }
    }
    const usedTables = new Set<number>([
      ...tableIndex.byTable.keys(),
      ...networkTables.values(),
      rules.catchAllTable
    ])
    const tableAdds: TablePreparation[] = []
    let candidateTable = rules.catchAllTable - 1
    for (const iface of pool) {
      const observed = networkTables.get(iface.name)
      if (observed != null) continue
      if (!UCI_SECTION.test(iface.name)) {
        findings.push({
          level: 'error',
          label: `WAN section "${iface.name}" cannot be prepared safely`,
          detail: 'Its UCI section name contains unsupported characters.'
        })
        continue
      }
      const conventional = tableIndex.byWan.get(iface.name)
      if (
        conventional != null &&
        conventional !== rules.catchAllTable &&
        tableIndex.byTable.get(conventional) === iface.name
      ) {
        tableAdds.push({ wan: iface.name, table: conventional })
        continue
      }
      while (
        candidateTable > rules.tableBase &&
        usedTables.has(candidateTable)
      ) {
        candidateTable -= 1
      }
      if (candidateTable <= rules.tableBase) {
        findings.push({
          level: 'error',
          label: 'No free numeric routing table remains between the PPPoE and catch-all ranges'
        })
        break
      }
      tableAdds.push({ wan: iface.name, table: candidateTable })
      usedTables.add(candidateTable)
      candidateTable -= 1
    }
    if (tableAdds.length) {
      findings.push({
        level: 'info',
        label: `${tableAdds.length} pre-existing WAN(s) need option ip4table`,
        detail: tableAdds
          .slice(0, 12)
          .map((entry) => `${entry.wan} -> ${entry.table}`)
          .join(', ')
          .concat(tableAdds.length > 12 ? `, and ${tableAdds.length - 12} more` : '')
      })
    }

    let lanZone = ''
    const destinationZones = new Set<string>()
    if (probe) {
      lanZone = firewallZoneForNetwork(probe.firewall, lan)
      if (!lanZone) {
        findings.push({
          level: 'error',
          label: `LAN "${lan}" is not assigned to a firewall zone`,
          detail: 'WAN Binding needs the source zone so it can install scoped forwarding without changing unrelated LANs.'
        })
      } else if (!FIREWALL_ZONE.test(lanZone)) {
        findings.push({
          level: 'error',
          label: `LAN firewall zone "${lanZone}" has an unsupported name`
        })
      } else {
        findings.push({
          level: 'pass',
          label: `LAN ${lan} uses firewall zone ${lanZone}`
        })
      }
      for (const iface of pool) {
        const zone = firewallZoneForNetwork(probe.firewall, iface.name)
        if (zone) {
          if (FIREWALL_ZONE.test(zone)) {
            destinationZones.add(zone)
          } else {
            findings.push({
              level: 'error',
              label: `WAN "${iface.name}" uses firewall zone "${zone}" with an unsupported name`
            })
          }
        } else if (
          iface.proto === 'pppoe' &&
          isManagedPppoeSection(iface.name, this.store.read().batches)
        ) {
          // Managed PPPoE netdevs are commonly attached to the module zone by
          // its `pppoe-<prefix>+` device wildcard rather than `list network`.
          destinationZones.add(rules.zoneName)
        } else {
          findings.push({
            level: 'error',
            label: `WAN "${iface.name}" is not assigned to a firewall zone`,
            detail: 'Assign the DHCP/static WAN to a masquerading firewall zone before putting it in a one-to-one pool.'
          })
        }
      }
      destinationZones.add(rules.zoneName)
      for (const zone of destinationZones) {
        if (!firewallZoneMasquerades(probe.firewall, zone) && zone !== rules.zoneName) {
          findings.push({
            level: 'warning',
            label: `Firewall zone "${zone}" does not have masquerading enabled`,
            detail: 'One-to-one WAN binding needs SNAT on the selected WAN zone or clients will not reach the internet.'
          })
        }
      }
      // A pool may be empty during preparation and receive managed PPPoE WANs
      // later. Keep its scoped forwarding ready without touching other zones.
      if (destinationZones.size > 32) {
        findings.push({
          level: 'error',
          label: 'The selected pool spans more than 32 firewall zones',
          detail: 'Split it into smaller carrier-scoped binding instances.'
        })
      }
    }

    let dhcp: DhcpPreparation | undefined
    if (probe && cidr) {
      const dhcpSections = sectionsOfType(probe.dhcp, 'dhcp', 'dhcp')
      const dhcpSection = dhcpSections.find(
        (section) =>
          uciOption(probe!.dhcp, 'dhcp', section, 'interface') === lan ||
          section === lan
      )
      if (!dhcpSection) {
        findings.push({
          level: 'error',
          label: `LAN "${lan}" has no dnsmasq DHCP section`
        })
      } else if (!DHCP_SECTION.test(dhcpSection)) {
        findings.push({
          level: 'error',
          label: `DHCP section "${dhcpSection}" cannot be prepared safely`
        })
      } else {
        const dnsmasqSection = sectionsOfType(probe.dhcp, 'dhcp', 'dnsmasq')[0]
        if (!dnsmasqSection || !DHCP_SECTION.test(dnsmasqSection)) {
          findings.push({
            level: 'error',
            label: 'No usable global dnsmasq section was found'
          })
        } else {
          const currentLanLimit = numericOption(
            uciOption(probe.dhcp, 'dhcp', dhcpSection, 'limit'),
            150
          )
          const currentGlobalLimit = numericOption(
            uciOption(probe.dhcp, 'dhcp', dnsmasqSection, 'dhcpleasemax'),
            1_000
          )
          const leaseCount = model.leases.filter((lease) => {
            const parsed = parseCidr(cidr)
            return parsed ? subnetContains(parsed, lease.ip) : false
          }).length
          const expected = Math.max(pool.length, leaseCount)
          const parsed = parseCidr(cidr)
          const addressCount = parsed
            ? parsed.prefix >= 31
              ? 2 ** (32 - parsed.prefix)
              : Math.max(0, 2 ** (32 - parsed.prefix) - 2)
            : expected
          const expectedClients = Math.min(addressCount, expected)
          const targetLan = Math.min(addressCount, Math.max(currentLanLimit, expectedClients))
          const targetGlobal = Math.max(currentGlobalLimit, targetLan + 64)
          if (
            expectedClients > currentLanLimit ||
            expectedClients > currentGlobalLimit
          ) {
            dhcp = {
              section: dhcpSection,
              dnsmasqSection,
              lanLimit: targetLan,
              globalLimit: targetGlobal
            }
            findings.push({
              level: 'warning',
              label: `dnsmasq limits are below the expected ${expectedClients} device(s)`,
              detail: raiseDhcpLimits
                ? `Apply will run: uci set dhcp.${dhcpSection}.limit='${targetLan}'; uci set dhcp.${dnsmasqSection}.dhcpleasemax='${targetGlobal}'; service dnsmasq restart.`
                : `Enable "Raise dnsmasq lease limits" or prepare them manually: dhcp.${dhcpSection}.limit=${targetLan}, dhcp.${dnsmasqSection}.dhcpleasemax=${targetGlobal}.`
            })
          }

          const ipv6Enabled =
            numericOption(uciOption(probe.network, 'network', lan, 'ip6assign'), 0) > 0 ||
            !['', 'disabled', '0'].includes(
              uciOption(probe.dhcp, 'dhcp', dhcpSection, 'ra')
            ) ||
            !['', 'disabled', '0'].includes(
              uciOption(probe.dhcp, 'dhcp', dhcpSection, 'dhcpv6')
            )
          if (ipv6Enabled) {
            findings.push({
              level: 'warning',
              label: `IPv6 service is enabled on ${lan}`,
              detail: 'WAN Binding controls IPv4 only. Disable RA/DHCPv6 if clients must not bypass the IPv4 one-to-one policy.'
            })
          }
        }
      }

      const defaults = sectionsOfType(probe.firewall, 'firewall', 'defaults')[0]
      const flowOffload = defaults
        ? uciOption(probe.firewall, 'firewall', defaults, 'flow_offloading')
        : ''
      if (flowOffload !== '1') {
        findings.push({
          level: 'info',
          label: 'Software flow offload is disabled',
          detail: "For thousands of linear fib rules consider: uci set firewall.@defaults[0].flow_offloading='1'; uci commit firewall; service firewall reload."
        })
      }
      const conntrack = probe.sysctl.get('net.netfilter.nf_conntrack_max') ?? 0
      if (conntrack < 262_144) {
        findings.push({
          level: 'info',
          label: `nf_conntrack_max is ${conntrack || 'unknown'}`,
          detail: 'For a large client pool consider: sysctl -w net.netfilter.nf_conntrack_max=262144, then persist it under /etc/sysctl.d/.'
        })
      }
      const gc1 = probe.sysctl.get('net.ipv4.neigh.default.gc_thresh1') ?? 0
      const gc2 = probe.sysctl.get('net.ipv4.neigh.default.gc_thresh2') ?? 0
      const gc3 = probe.sysctl.get('net.ipv4.neigh.default.gc_thresh3') ?? 0
      if (Math.max(pool.length, model.leases.length) > 1_024 || gc3 < 8_192) {
        findings.push({
          level: 'info',
          label: `Neighbour thresholds are ${gc1 || '?'}/${gc2 || '?'}/${gc3 || '?'}`,
          detail: 'For more than 1024 clients consider gc_thresh1=2048, gc_thresh2=4096 and gc_thresh3=8192.'
        })
      }
    }

    if (this.ctx.fastIntervalMs(FAST_INTERVAL_KEY) === 0) {
      findings.push({
        level: 'warning',
        label: 'The OpenWRT fast interval is paused',
        detail: 'The binding engine only reconciles on fast samples; new DHCP clients will wait until refresh resumes.'
      })
    }
    findings.push({
      level: 'info',
      label: 'Unassigned clients are blocked by a scoped catch-all',
      detail: `The instance will install an unreachable default in table ${rules.catchAllTable}; LANs and carriers outside this exact pair are untouched.`
    })

    const usedSlots = new Set(data.instances.map((instance) => instance.slot))
    for (const rule of model.rules) {
      if (
        rule.pref >= rules.catchAllPrefBase &&
        rule.pref < MANAGED_PREF_CEILING
      ) {
        usedSlots.add(rule.pref - rules.catchAllPrefBase)
      }
    }
    let slot = 0
    while (usedSlots.has(slot)) slot += 1
    if (rules.catchAllPrefBase + slot >= MANAGED_PREF_CEILING) {
      findings.push({
        level: 'error',
        label: 'No catch-all preference slot remains in the managed range'
      })
    }

    const ok = !hasBlockingFinding(findings)
    if (!ok || !cidr) return { ok: false, findings }
    const instance: BindingInstanceRecord = {
      id: makeBindingId(new Set(data.instances.map((entry) => entry.id))),
      name,
      lan,
      carrier,
      running: true,
      sticky,
      remap,
      createdAt: Date.now(),
      slot
    }
    const plan: BindingCreatePlan = {
      instance,
      lanCidr: cidr,
      lanZone,
      destinationZones: [...destinationZones].sort(),
      tableAdds,
      ...(raiseDhcpLimits && dhcp ? { dhcp } : {})
    }
    findings.push({
      level: 'pass',
      label: `Will prepare and start "${name}"`,
      detail: `${lan} -> ${carrier}; sticky ${sticky ? 'on' : 'off'}, error remap ${remap ? 'on' : 'off'}.`
    })
    return {
      ok: true,
      token: this.checkSession.issue(values, plan),
      findings
    }
  }

  async bindingApply(raw: unknown): Promise<OkResult> {
    return this.apply(raw)
  }

  async apply(raw: unknown): Promise<OkResult> {
    const payload =
      typeof raw === 'object' && raw !== null
        ? (raw as { token?: unknown; values?: unknown })
        : {}
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.checkSession.take(token, payload.values)
    if (!taken) {
      return { ok: false, error: 'that check expired or the form changed - check again' }
    }
    const plan = taken.payload
    const reservationProblem = this.reservePreparation(plan)
    if (reservationProblem) return { ok: false, error: reservationProblem }
    const spec = this.preparationJob(plan)
    if (this.options.jobs) {
      try {
        const job = this.options.jobs.start(spec)
        return { ok: true, data: job.id }
      } catch (error) {
        this.releasePreparation(plan.instance.id)
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
    try {
      for (const item of spec.items) await item.run(() => false)
      return { ok: true, data: plan.instance.id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.releasePreparation(plan.instance.id)
    }
  }

  // --------------------------------------------------------------- lifecycle

  async onSample(model: RouterModel, forceKernel = false): Promise<void> {
    if (this.disposed) return
    await this.exclusive(async () => {
      if (this.disposed) return
      const rebooted =
        this.lastUptime != null && model.sys.uptimeSec < this.lastUptime
      this.latestModel = model
      this.lastUptime = model.sys.uptimeSec
      const error = await this.reconcileModel(model, {
        forceKernel: forceKernel || rebooted,
        rebooted
      })
      if (error && !this.disposed) {
        this.ctx.log(`openwrt: binding reconcile failed: ${error}`)
      }
    })
  }

  async forceReapply(model = this.latestModel): Promise<void> {
    if (!model) return
    await this.onSample(model, true)
  }

  reset(): void {
    this.workGeneration += 1
    this.checkSession.clear()
    this.latestModel = null
    this.lastUptime = null
    this.memory.clear()
    this.cache.clear()
    this.latestPayload = { t: 0, instances: [], rows: [] }
    this.manualWanTables = undefined
    this.preparations.clear()
    this.lastTableAuditWarning = ''
  }

  dispose(): void {
    this.workGeneration += 1
    this.disposed = true
    this.checkSession.clear()
    this.memory.clear()
    this.cache.clear()
    this.preparations.clear()
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.workGeneration && this.ctx.connected
  }

  // --------------------------------------------------------------- actions

  async bindingStart(idRaw: unknown): Promise<OkResult> {
    return this.start(idRaw)
  }

  async start(idRaw: unknown): Promise<OkResult> {
    const id = String(idRaw ?? '')
    const instance = this.store.read().instances.find((entry) => entry.id === id)
    if (!instance) return { ok: false, error: 'no such binding instance' }
    return this.runMutationJob(
      'binding-start',
      `Start binding ${instance.name}`,
      () => this.setRunning(id, true)
    )
  }

  async bindingStop(idRaw: unknown): Promise<OkResult> {
    return this.stop(idRaw)
  }

  async stop(idRaw: unknown): Promise<OkResult> {
    const id = String(idRaw ?? '')
    const instance = this.store.read().instances.find((entry) => entry.id === id)
    if (!instance) return { ok: false, error: 'no such binding instance' }
    return this.runMutationJob(
      'binding-stop',
      `Stop binding ${instance.name}`,
      () => this.setRunning(id, false)
    )
  }

  async bindingDelete(idRaw: unknown): Promise<OkResult> {
    return this.delete(idRaw)
  }

  async delete(idRaw: unknown): Promise<OkResult> {
    const id = String(idRaw ?? '')
    const instance = this.store.read().instances.find((entry) => entry.id === id)
    if (!instance) return { ok: false, error: 'no such binding instance' }
    return this.runMutationJob(
      'binding-delete',
      `Delete binding ${instance.name}`,
      () => this.deleteNow(id)
    )
  }

  private async deleteNow(id: string): Promise<OkResult> {
    return this.exclusive(async () => {
      const instance = this.store.read().instances.find((entry) => entry.id === id)
      if (!instance) return { ok: false, error: 'no such binding instance' }
      const model = this.latestModel
      if (!model) return { ok: false, error: 'no router sample is available' }
      if (!lanCidr(model.ifaces.find((entry) => entry.name === instance.lan))) {
        return {
          ok: false,
          error: `LAN ${instance.lan} has no current IPv4 subnet; restore it before deleting so its rules can be identified safely`
        }
      }

      const wasRunning = instance.running
      instance.running = false
      const cidr = lanCidr(model.ifaces.find((entry) => entry.name === instance.lan))
      const generation = this.workGeneration
      const rules = this.options.rules()
      const pref = rules.catchAllPrefBase + instance.slot
      try {
        await this.removeFirewallForwardings(instance)
        if (!this.current(generation)) throw new Error('binding engine stopped')
        const error = await this.reconcileModel(model, { forceKernel: false, rebooted: false })
        if (error) throw new Error(error)
        if (!this.current(generation)) throw new Error('binding engine stopped')
        await this.execScript(
          [
            `while ip -4 rule del pref ${pref} 2>/dev/null; do :; done`
          ],
          'remove binding catch-all'
        )
      } catch (errorValue) {
        if (this.current(generation) && cidr) {
          try {
            await this.installCatchAll(instance, cidr, true)
            await this.reconcileModel(model, { forceKernel: true, rebooted: false })
          } catch {
            // Keep the original failure; catch-all restore is best effort.
          }
        }
        if (this.current(generation)) instance.running = wasRunning
        return {
          ok: false,
          error: errorValue instanceof Error ? errorValue.message : String(errorValue)
        }
      }
      if (!this.current(generation)) {
        return { ok: false, error: 'binding engine stopped' }
      }

      this.store.update((data) => {
        data.instances = data.instances.filter((entry) => entry.id !== id)
        data.stickyMap = data.stickyMap.filter((entry) => entry[0] !== id)
        data.events = data.events.filter((entry) => entry[0] !== id)
      })
      this.memory.delete(id)
      this.cache.delete(id)
      this.emitSnapshot(model.t)
      this.options.requestDump?.()
      this.ctx.log(`openwrt: binding instance ${instance.name} deleted`)
      return { ok: true }
    })
  }

  async bindingUnassign(
    idOrKeys: unknown,
    macRaw?: unknown
  ): Promise<OkResult> {
    return this.unassign(idOrKeys, macRaw)
  }

  async unassign(idOrKeys: unknown, macRaw?: unknown): Promise<OkResult> {
    return this.queueDeviceAction(idOrKeys, macRaw, 'unassign')
  }

  async bindingReassign(
    idOrKeys: unknown,
    macRaw?: unknown
  ): Promise<OkResult> {
    return this.reassign(idOrKeys, macRaw)
  }

  async reassign(idOrKeys: unknown, macRaw?: unknown): Promise<OkResult> {
    return this.queueDeviceAction(idOrKeys, macRaw, 'reassign')
  }

  // ------------------------------------------------------------- internals

  private currentWanTables(): WanTableSource | undefined {
    return this.manualWanTables ?? this.options.wanTables?.()
  }

  private async preparationProbe(): Promise<RouterPreparationProbe> {
    if (this.disposed) throw new Error('binding engine stopped')
    const result = await this.ctx.exec('sh -s', {
      stdin: PREPARATION_SCRIPT,
      timeoutMs: CHECK_TIMEOUT_MS
    })
    if (this.disposed) throw new Error('binding engine stopped')
    if (result.code !== 0) throw shellFailure('OpenWRT UCI probe', result.code)
    const sections = splitSections(result.stdout)
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

  private networkTables(document: UciDocument): Map<string, number> {
    const result = new Map<string, number>()
    for (const [key, value] of document.values) {
      const match = key.match(/^network\.([^.]+)\.ip4table$/)
      if (!match) continue
      const table = Number(value)
      if (Number.isSafeInteger(table) && table > 0) result.set(match[1] ?? '', table)
    }
    return result
  }

  private preparationJob(plan: BindingCreatePlan): JobSpec {
    const rules = this.options.rules()
    const timeoutMs = rules.execTimeoutSec * 1000
    const chunks: TablePreparation[][] = []
    for (let index = 0; index < plan.tableAdds.length; index += rules.uciChunkSize) {
      chunks.push(plan.tableAdds.slice(index, index + rules.uciChunkSize))
    }
    const items: JobSpec['items'] = [
      {
        name: 'Revalidate LAN, carrier and routing tables',
        run: async () => {
          await this.exclusive(() => this.revalidatePreparation(plan))
          return 'router state still matches the check'
        }
      }
    ]
    chunks.forEach((chunk, index) => {
      items.push({
        name: `Prepare WAN tables ${index + 1}/${chunks.length}`,
        run: async (cancelled) => {
          if (cancelled()) throw new Error('cancelled')
          await this.exclusive(async () => {
            await this.applyTableChunk(chunk, timeoutMs, plan.instance.id)
          })
          return `${chunk.length} WAN table(s)`
        }
      })
    })
    if (plan.dhcp) {
      items.push({
        name: 'Raise dnsmasq lease limits',
        run: async (cancelled) => {
          if (cancelled()) throw new Error('cancelled')
          await this.exclusive(() => this.applyDhcpPreparation(plan.dhcp!, timeoutMs))
          return `${plan.dhcp!.lanLimit}/${plan.dhcp!.globalLimit}`
        }
      })
    }
    items.push({
      name: 'Install safety catch-all and start',
      run: async (cancelled) => {
        if (cancelled()) throw new Error('cancelled')
        await this.exclusive(async () => {
          const existing = this.store.read().instances
          const plannedSubnet = parseCidr(plan.lanCidr)
          const overlapsExisting = existing.some((entry) => {
            const otherCidr = this.latestModel
              ? lanCidr(
                  this.latestModel.ifaces.find((iface) => iface.name === entry.lan)
                )
              : null
            const otherSubnet = otherCidr ? parseCidr(otherCidr) : null
            return (
              plannedSubnet != null &&
              otherSubnet != null &&
              subnetsOverlap(plannedSubnet, otherSubnet)
            )
          })
          if (existing.some((entry) => entry.id === plan.instance.id)) {
            throw new Error('binding instance already exists')
          }
          if (
            existing.some(
              (entry) =>
                entry.slot === plan.instance.slot ||
                entry.lan === plan.instance.lan ||
                entry.carrier === plan.instance.lan ||
                entry.lan === plan.instance.carrier ||
                carrierScopesOverlap(entry.carrier, plan.instance.carrier)
            )
          ) {
            throw new Error('an interface or catch-all slot was claimed while the job waited')
          }
          if (overlapsExisting) {
            throw new Error('the LAN subnet now overlaps another binding instance')
          }
          await this.installFirewallForwardings(
            plan.instance,
            plan.lanZone,
            plan.destinationZones
          )
          await this.installCatchAll(plan.instance, plan.lanCidr, true)
          if (this.latestModel) {
            const rules = this.options.rules()
            const pref = rules.catchAllPrefBase + plan.instance.slot
            this.latestModel.rules = this.latestModel.rules.filter(
              (rule) => rule.pref !== pref
            )
            this.latestModel.rules.push({
              pref,
              from: plan.lanCidr,
              table: rules.catchAllTable
            })
          }
          this.store.update((data) => {
            const busy = data.instances.some(
              (entry) =>
                entry.lan === plan.instance.lan ||
                entry.carrier === plan.instance.lan ||
                entry.lan === plan.instance.carrier ||
                carrierScopesOverlap(entry.carrier, plan.instance.carrier)
            )
            if (busy) throw new Error('one of the interfaces was claimed while the job waited')
            data.instances.push({ ...plan.instance })
          })
          this.recordEvents(plan.instance, [{
            t: Date.now(),
            kind: 'started',
            text: `binding started for ${plan.instance.lan} -> ${plan.instance.carrier}`
          }])
          this.options.requestDump?.()
          if (this.latestModel) {
            const error = await this.reconcileModel(this.latestModel, {
              forceKernel: false,
              rebooted: false
            })
            if (error) throw new Error(error)
          }
        })
        return plan.instance.id
      }
    })
    return {
      kind: 'binding-prepare',
      label: `Prepare binding ${plan.instance.name}`,
      items,
      onError: 'abort',
      onFinished: () => {
        this.releasePreparation(plan.instance.id)
      }
    }
  }

  private reservePreparation(plan: BindingCreatePlan): string | null {
    const plannedSubnet = parseCidr(plan.lanCidr)
    for (const other of this.preparations.values()) {
      if (
        other.instance.id === plan.instance.id ||
        other.instance.slot === plan.instance.slot ||
        other.instance.name.toLowerCase() === plan.instance.name.toLowerCase() ||
        other.instance.lan === plan.instance.lan ||
        other.instance.carrier === plan.instance.lan ||
        other.instance.lan === plan.instance.carrier ||
        carrierScopesOverlap(other.instance.carrier, plan.instance.carrier)
      ) {
        return 'another binding preparation already reserved this name, slot or interface'
      }
      const otherSubnet = parseCidr(other.lanCidr)
      if (
        plannedSubnet &&
        otherSubnet &&
        subnetsOverlap(plannedSubnet, otherSubnet)
      ) {
        return 'another binding preparation already reserved an overlapping LAN subnet'
      }
      const tables = new Map(other.tableAdds.map((entry) => [entry.table, entry.wan]))
      for (const entry of plan.tableAdds) {
        const owner = tables.get(entry.table)
        if (owner && owner !== entry.wan) {
          return `routing table ${entry.table} is reserved by another binding preparation`
        }
      }
    }
    this.preparations.set(plan.instance.id, plan)
    return null
  }

  private releasePreparation(id: string): void {
    this.preparations.delete(id)
  }

  private async revalidatePreparation(plan: BindingCreatePlan): Promise<void> {
    if (this.disposed || !this.ctx.connected) throw new Error('router disconnected')
    const model = this.latestModel
    if (!model) throw new Error('no router sample is available')
    const currentLan = lanCidr(model.ifaces.find((iface) => iface.name === plan.instance.lan))
    if (currentLan !== plan.lanCidr) throw new Error('LAN subnet changed; check the form again')
    const data = this.store.read()
    if (
      data.instances.some(
        (entry) =>
          entry.lan === plan.instance.lan ||
          entry.carrier === plan.instance.lan ||
          entry.lan === plan.instance.carrier ||
          carrierScopesOverlap(entry.carrier, plan.instance.carrier)
      )
    ) {
      throw new Error('one of the two interfaces is now owned by another instance')
    }
    const plannedSubnet = parseCidr(plan.lanCidr)
    if (
      plannedSubnet &&
      data.instances.some((entry) => {
        const otherCidr = lanCidr(
          model.ifaces.find((iface) => iface.name === entry.lan)
        )
        const otherSubnet = otherCidr ? parseCidr(otherCidr) : null
        return otherSubnet != null && subnetsOverlap(plannedSubnet, otherSubnet)
      })
    ) {
      throw new Error('the LAN subnet now overlaps another binding instance')
    }
    const probe = await this.preparationProbe()
    const currentLanZone = firewallZoneForNetwork(probe.firewall, plan.instance.lan)
    if (currentLanZone !== plan.lanZone) {
      throw new Error('the LAN firewall zone changed; check the form again')
    }
    const knownZones = new Set(
      sectionsOfType(probe.firewall, 'firewall', 'zone').map(
        (section) => uciOption(probe.firewall, 'firewall', section, 'name') || section
      )
    )
    for (const zone of plan.destinationZones) {
      if (zone !== this.options.rules().zoneName && !knownZones.has(zone)) {
        throw new Error(`destination firewall zone ${zone} no longer exists`)
      }
    }
    const currentTables = this.networkTables(probe.network)
    const occupied = new Map<number, string>()
    for (const [wan, table] of currentTables) occupied.set(table, wan)
    for (const entry of plan.tableAdds) {
      if (!probe.network.sectionTypes.has(`network.${entry.wan}`)) {
        throw new Error(`WAN section ${entry.wan} no longer exists`)
      }
      const current = currentTables.get(entry.wan)
      if (current != null && current !== entry.table) {
        throw new Error(`${entry.wan} now uses table ${current}; check again`)
      }
      const owner = occupied.get(entry.table)
      if (owner && owner !== entry.wan) {
        throw new Error(`table ${entry.table} is now used by ${owner}; check again`)
      }
    }
    const rules = this.options.rules()
    const pref = rules.catchAllPrefBase + plan.instance.slot
    if (model.rules.some((rule) => rule.pref === pref)) {
      throw new Error(`catch-all preference ${pref} is no longer free; check again`)
    }
  }

  private async applyTableChunk(
    chunk: readonly TablePreparation[],
    timeoutMs: number,
    preparationId: string
  ): Promise<void> {
    if (chunk.length === 0) return
    const owners = new Map<number, string>()
    for (const [wan, table] of this.store.read().extraTables) {
      if (!owners.has(table)) owners.set(table, wan)
    }
    for (const [id, preparation] of this.preparations) {
      for (const entry of preparation.tableAdds) {
        if (id !== preparationId && !owners.has(entry.table)) {
          owners.set(entry.table, entry.wan)
        }
      }
    }
    const lines: string[] = []
    for (const entry of chunk) {
      if (!UCI_SECTION.test(entry.wan)) throw new Error(`unsafe WAN section ${entry.wan}`)
      const owner = owners.get(entry.table)
      if (owner && owner !== entry.wan) {
        throw new Error(`routing table ${entry.table} was claimed by ${owner}`)
      }
      lines.push(`set network.${entry.wan}.ip4table='${entry.table}'`)
    }
    lines.push('commit network')
    const written = await this.ctx.exec('uci -q batch', {
      stdin: `${lines.join('\n')}\n`,
      timeoutMs
    })
    if (written.code !== 0) throw shellFailure('write WAN routing tables', written.code)
    if (this.disposed) throw new Error('binding engine stopped')
    // The UCI mutation is already durable even if a later ifup fails. Remember
    // it now so a cancelled/partial preparation never loses the table mapping.
    this.store.update((data) => {
      const map = new Map(data.extraTables)
      for (const entry of chunk) map.set(entry.wan, entry.table)
      data.extraTables = [...map]
    })

    const restarted = await this.ctx.exec('sh -s', {
      stdin: `set -e\n${chunk.map((entry) => `ifup ${shQuote(entry.wan)}`).join('\n')}\n`,
      timeoutMs
    })
    if (restarted.code !== 0) throw shellFailure('restart prepared WANs', restarted.code)
    if (this.disposed) throw new Error('binding engine stopped')
    this.options.requestDump?.()
  }

  private async applyDhcpPreparation(
    preparation: DhcpPreparation,
    timeoutMs: number
  ): Promise<void> {
    if (
      !DHCP_SECTION.test(preparation.section) ||
      !DHCP_SECTION.test(preparation.dnsmasqSection)
    ) {
      throw new Error('unsafe DHCP section')
    }
    const lines = [
      `set dhcp.${preparation.section}.limit='${preparation.lanLimit}'`,
      `set dhcp.${preparation.dnsmasqSection}.dhcpleasemax='${preparation.globalLimit}'`,
      'commit dhcp'
    ]
    const written = await this.ctx.exec('uci -q batch', {
      stdin: `${lines.join('\n')}\n`,
      timeoutMs
    })
    if (written.code !== 0) throw shellFailure('write dnsmasq limits', written.code)
    if (this.disposed) throw new Error('binding engine stopped')
    const restarted = await this.ctx.exec('sh -s', {
      stdin: 'set -e\nservice dnsmasq restart\n',
      timeoutMs
    })
    if (restarted.code !== 0) throw shellFailure('restart dnsmasq', restarted.code)
    if (this.disposed) throw new Error('binding engine stopped')
  }

  private async installFirewallForwardings(
    instance: BindingInstanceRecord,
    sourceZone: string,
    destinationZonesRaw: readonly string[]
  ): Promise<void> {
    const rules = this.options.rules()
    if (!FIREWALL_ZONE.test(sourceZone)) throw new Error('unsafe LAN firewall zone')
    const destinationZones = [...new Set(destinationZonesRaw)]
    if (
      destinationZones.length === 0 ||
      destinationZones.length > 32 ||
      destinationZones.some((zone) => !FIREWALL_ZONE.test(zone))
    ) {
      throw new Error('unsafe destination firewall zone set')
    }
    const prefix = `bmf${instance.slot}_`
    const lines = [
      // This is the module-owned masquerading zone used by managed PPPoE
      // wildcard devices. Existing DHCP/static WAN zones are left untouched.
      `set firewall.${rules.zoneName}=zone`,
      `set firewall.${rules.zoneName}.name=${shQuote(rules.zoneName)}`,
      `set firewall.${rules.zoneName}.input='REJECT'`,
      `set firewall.${rules.zoneName}.output='ACCEPT'`,
      `set firewall.${rules.zoneName}.forward='REJECT'`,
      `set firewall.${rules.zoneName}.masq='1'`,
      `set firewall.${rules.zoneName}.mtu_fix='1'`
    ]
    const cleanup: string[] = []
    for (let index = 0; index < 32; index++) {
      cleanup.push(`uci -q delete firewall.${prefix}${index} 2>/dev/null || true`)
    }
    destinationZones.forEach((zone, index) => {
      const section = `${prefix}${index}`
      lines.push(
        `set firewall.${section}=forwarding`,
        `set firewall.${section}.src=${shQuote(sourceZone)}`,
        `set firewall.${section}.dest=${shQuote(zone)}`
      )
    })
    lines.push('commit firewall')
    await this.store.withFirewall(async () => {
      const cleaned = await this.ctx.exec('sh -s', {
        stdin: `${cleanup.join('\n')}\n`,
        timeoutMs: rules.execTimeoutSec * 1000
      })
      if (cleaned.code !== 0) throw shellFailure('clean old binding firewall forwarding', cleaned.code)
      const written = await this.ctx.exec('uci -q batch', {
        stdin: `${lines.join('\n')}\n`,
        timeoutMs: rules.execTimeoutSec * 1000
      })
      if (written.code !== 0) throw shellFailure('write binding firewall forwarding', written.code)
      const reloaded = await this.ctx.exec('service firewall reload', {
        timeoutMs: rules.execTimeoutSec * 1000
      })
      if (reloaded.code !== 0) throw shellFailure('reload binding firewall', reloaded.code)
      if (this.disposed) throw new Error('binding engine stopped')
    })
  }

  private async removeFirewallForwardings(instance: BindingInstanceRecord): Promise<void> {
    const rules = this.options.rules()
    const prefix = `bmf${instance.slot}_`
    const lines: string[] = ['set -e']
    for (let index = 0; index < 32; index++) {
      lines.push(`uci -q delete firewall.${prefix}${index} 2>/dev/null || true`)
    }
    lines.push('uci commit firewall')
    await this.store.withFirewall(async () => {
      const written = await this.ctx.exec('sh -s', {
        stdin: `${lines.join('\n')}\n`,
        timeoutMs: rules.execTimeoutSec * 1000
      })
      if (written.code !== 0) throw shellFailure('remove binding firewall forwarding', written.code)
      const reloaded = await this.ctx.exec('service firewall reload', {
        timeoutMs: rules.execTimeoutSec * 1000
      })
      if (reloaded.code !== 0) throw shellFailure('reload binding firewall', reloaded.code)
      if (this.disposed) throw new Error('binding engine stopped')
    })
  }

  private async installCatchAll(
    instance: BindingInstanceRecord,
    cidr: string,
    replace: boolean
  ): Promise<void> {
    const rules = this.options.rules()
    const pref = rules.catchAllPrefBase + instance.slot
    if (pref < rules.catchAllPrefBase || pref >= MANAGED_PREF_CEILING) {
      throw new Error('catch-all preference is outside the managed range')
    }
    const lines = [
      `ip -4 route flush table ${rules.catchAllTable} 2>/dev/null || true`,
      `ip -4 route add unreachable default table ${rules.catchAllTable}`,
      ...(replace
        ? [`while ip -4 rule del pref ${pref} 2>/dev/null; do :; done`]
        : []),
      `ip -4 rule add from ${cidr} lookup ${rules.catchAllTable} pref ${pref}`
    ]
    await this.execScript(lines, 'install binding catch-all')
  }

  private async runMutationJob(
    kind: string,
    label: string,
    work: () => Promise<OkResult>
  ): Promise<OkResult> {
    if (!this.options.jobs) return work()
    try {
      const job = this.options.jobs.start({
        kind,
        label,
        items: [{
          name: label,
          run: async () => {
            const result = await work()
            if (!result.ok) throw new Error(result.error || `${label} failed`)
            return result.data || 'done'
          }
        }],
        onError: 'abort'
      })
      return { ok: true, data: job.id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async setRunning(id: string, running: boolean): Promise<OkResult> {
    return this.exclusive(async () => {
      const instance = this.store.read().instances.find((entry) => entry.id === id)
      if (!instance) return { ok: false, error: 'no such binding instance' }
      const model = this.latestModel
      if (!model) return { ok: false, error: 'no router sample is available' }
      if (!lanCidr(model.ifaces.find((entry) => entry.name === instance.lan))) {
        return {
          ok: false,
          error: `LAN ${instance.lan} has no current IPv4 subnet; restore it before changing this instance`
        }
      }
      const old = instance.running
      instance.running = running
      const error = await this.reconcileModel(model, {
        forceKernel: true,
        rebooted: false
      })
      if (error) {
        instance.running = old
        return { ok: false, error }
      }
      this.store.update((data) => {
        const saved = data.instances.find((entry) => entry.id === id)
        if (saved) saved.running = running
      })
      this.recordEvents(instance, [{
        t: Date.now(),
        kind: running ? 'started' : 'stopped',
        text: running
          ? `binding resumed for ${instance.lan} -> ${instance.carrier}`
          : 'binding stopped; assignment rules were removed and the safety catch-all remains'
      }])
      this.options.requestDump?.()
      return { ok: true }
    })
  }

  private actionTargets(
    idOrKeys: unknown,
    macRaw?: unknown
  ): Array<{ instanceId: string; mac: string }> {
    const targets: Array<{ instanceId: string; mac: string }> = []
    if (Array.isArray(idOrKeys)) {
      for (const raw of idOrKeys) {
        const key = String(raw ?? '')
        const separator = key.indexOf('|')
        if (separator <= 0) continue
        const instanceId = key.slice(0, separator)
        const mac = normalizedMac(key.slice(separator + 1))
        if (instanceId && mac) targets.push({ instanceId, mac })
      }
    } else {
      const instanceId = String(idOrKeys ?? '')
      const mac = normalizedMac(macRaw)
      if (instanceId && mac) targets.push({ instanceId, mac })
    }
    const seen = new Set<string>()
    return targets.filter((target) => {
      const key = `${target.instanceId}|${target.mac}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private async queueDeviceAction(
    idOrKeys: unknown,
    macRaw: unknown,
    action: 'unassign' | 'reassign'
  ): Promise<OkResult> {
    const targets = this.actionTargets(idOrKeys, macRaw)
    if (targets.length === 0) return { ok: false, error: 'no valid device was selected' }
    return this.runMutationJob(
      `binding-${action}`,
      `${action === 'unassign' ? 'Unassign' : 'Reassign'} ${targets.length} device${targets.length === 1 ? '' : 's'}`,
      () => this.deviceActionNow(idOrKeys, macRaw, action)
    )
  }

  private async deviceActionNow(
    idOrKeys: unknown,
    macRaw: unknown,
    action: 'unassign' | 'reassign'
  ): Promise<OkResult> {
    const targets = this.actionTargets(idOrKeys, macRaw)
    if (targets.length === 0) return { ok: false, error: 'no valid device was selected' }
    return this.exclusive(async () => {
      const model = this.latestModel
      if (!model) return { ok: false, error: 'no router sample is available' }
      const instances = new Map(this.store.read().instances.map((entry) => [entry.id, entry]))
      for (const target of targets) {
        const instance = instances.get(target.instanceId)
        if (!instance) {
          return { ok: false, error: `binding instance ${target.instanceId} no longer exists` }
        }
        if (!lanCidr(model.ifaces.find((entry) => entry.name === instance.lan))) {
          return { ok: false, error: `LAN ${instance.lan} has no current IPv4 subnet` }
        }
      }

      const memoryBackups = new Map<string, BindingPlannerMemory>()
      for (const target of targets) {
        const memory = this.memory.get(target.instanceId) ?? emptyPlannerMemory()
        if (!memoryBackups.has(target.instanceId)) {
          memoryBackups.set(target.instanceId, cloneMemory(memory))
        }
        const held = new Set(memory.heldMacs.map(normalizedMac).filter(Boolean))
        const forced = new Map(memory.forceReassign.map((entry) => [normalizedMac(entry.mac), entry]))
        if (action === 'unassign') {
          held.add(target.mac)
          forced.delete(target.mac)
        } else {
          held.delete(target.mac)
          const oldWan = this.cache
            .get(target.instanceId)
            ?.assignments.find((row) => row.mac === target.mac)?.wan
          forced.set(target.mac, {
            mac: target.mac,
            ...(oldWan ? { avoidWan: oldWan } : {})
          })
        }
        memory.heldMacs = [...held]
        memory.forceReassign = [...forced.values()]
        this.memory.set(target.instanceId, memory)
      }

      const removedSticky: OwrtHostData['stickyMap'] = []
      if (action === 'reassign') {
        this.store.update((data) => {
          const selected = new Set(
            targets.map((target) => `${target.instanceId}|${target.mac}`)
          )
          data.stickyMap = data.stickyMap.filter((entry) => {
            const remove = selected.has(`${entry[0]}|${normalizedMac(entry[1])}`)
            if (remove) removedSticky.push(entry)
            return !remove
          })
        })
      }

      const error = await this.reconcileModel(model, {
        forceKernel: false,
        rebooted: false
      })
      if (error) {
        for (const [id, backup] of memoryBackups) this.memory.set(id, backup)
        if (removedSticky.length) {
          this.store.update((data) => {
            data.stickyMap.push(...removedSticky)
          })
        }
        return { ok: false, error }
      }
      return { ok: true, data: String(targets.length) }
    })
  }

  private async reconcileModel(
    model: RouterModel,
    flags: { forceKernel: boolean; rebooted: boolean }
  ): Promise<string | null> {
    if (this.disposed) return 'binding engine stopped'
    const rules = this.options.rules()
    const data = this.store.read()
    const instances = [...data.instances].sort(
      (a, b) => a.slot - b.slot || a.id.localeCompare(b.id)
    )
    const tables = buildWanTableIndex(
      model,
      data,
      rules,
      this.currentWanTables()
    )
    const virtualRules = model.rules.map((rule) => ({ ...rule }))
    const outcomes: ReconcileOutcome[] = []
    const assignmentDeletes: string[] = []
    const assignmentAdds: string[] = []
    const catchDeletes: string[] = []
    const catchAdds: string[] = []
    let repairCatchAll = flags.forceKernel

    for (const instance of instances) {
      const iface = model.ifaces.find((entry) => entry.name === instance.lan)
      const cidr = lanCidr(iface)
      if (!cidr) {
        outcomes.push({
          instance,
          result: {
            actual: [],
            desired: [],
            ruleDiff: {
              delete: [],
              add: [],
              deleteLines: [],
              addLines: [],
              lines: [],
              chunks: []
            },
            memory: this.memory.get(instance.id) ?? emptyPlannerMemory(),
            stickyUpdates: [],
            events: [],
            assignments: [],
            waiting: [],
            wan: {
              ...emptyWanSummary(),
              total: poolIfaces(model, instance.lan, instance.carrier).length,
              warning: poolIfaces(model, instance.lan, instance.carrier).length
            },
            devices: emptyDeviceSummary()
          }
        })
        continue
      }
      const sticky: BindingStickyChoice[] = data.stickyMap
        .filter((entry) => entry[0] === instance.id)
        .map((entry) => ({
          mac: entry[1],
          wan: entry[2],
          lastSeenAt: entry[3]
        }))
      const result = planBindingReconciliation({
        now: model.t,
        instance,
        lanCidr: cidr,
        leases: model.leases,
        rules: virtualRules,
        wans: plannerWans(model, instance, tables),
        tableToWan: [...tables.byTable],
        sticky,
        memory: this.memory.get(instance.id),
        policy: plannerPolicy(rules),
        randomSeed: Math.floor(Math.random() * 0x1_0000_0000),
        rebooted: flags.rebooted
      })
      outcomes.push({ instance, result })
      assignmentDeletes.push(...result.ruleDiff.deleteLines)
      assignmentAdds.push(...result.ruleDiff.addLines)
      applyRuleDiffInMemory(virtualRules, result.ruleDiff)

      const pref = rules.catchAllPrefBase + instance.slot
      const atPref = model.rules.filter((rule) => rule.pref === pref)
      const correct =
        atPref.length === 1 &&
        atPref[0]?.table === rules.catchAllTable &&
        parseCidr(atPref[0]?.from ?? '')?.cidr === cidr
      if (!correct) {
        repairCatchAll = true
        for (let count = 0; count < atPref.length; count++) {
          catchDeletes.push(`ip -4 rule del pref ${pref} 2>/dev/null || true`)
        }
        catchAdds.push(
          `ip -4 rule add from ${cidr} lookup ${rules.catchAllTable} pref ${pref}`
        )
        for (const rule of [...virtualRules]) {
          if (rule.pref === pref) {
            virtualRules.splice(virtualRules.indexOf(rule), 1)
          }
        }
        virtualRules.push({
          pref,
          from: cidr,
          table: rules.catchAllTable
        })
      }
    }

    try {
      if (repairCatchAll) {
        await this.execScript(
          [
            `ip -4 route flush table ${rules.catchAllTable} 2>/dev/null || true`,
            `ip -4 route add unreachable default table ${rules.catchAllTable}`
          ],
          'repair binding catch-all'
        )
        for (const chunk of chunkRuleCommands(
          [...catchDeletes, ...catchAdds],
          rules.ruleChunkLines
        )) {
          await this.execScript(chunk, 'reconcile binding catch-all rules')
        }
      }
      const ruleLines = [...assignmentDeletes, ...assignmentAdds]
      for (const chunk of chunkRuleCommands(ruleLines, rules.ruleChunkLines)) {
        await this.execScript(chunk, 'reconcile binding rules')
      }
    } catch (error) {
      if (!this.disposed) this.emitSnapshot(model.t)
      return error instanceof Error ? error.message : String(error)
    }
    if (this.disposed) return 'binding engine stopped'

    // Actions can run between fast samples. Reflect successful kernel writes in
    // the cached router model so Stop -> Start and Unassign -> Reassign do not
    // wait one extra tick on a stale rule snapshot.
    model.rules = virtualRules
    for (const outcome of outcomes) {
      this.memory.set(outcome.instance.id, outcome.result.memory)
      this.cache.set(outcome.instance.id, {
        summary: {
          id: outcome.instance.id,
          name: outcome.instance.name,
          lan: outcome.instance.lan,
          carrier: outcome.instance.carrier,
          running: outcome.instance.running,
          wan: outcome.result.wan,
          devices: outcome.result.devices
        },
        assignments: outcome.result.assignments,
        waiting: outcome.result.waiting
      })
    }
    this.syncSticky(outcomes, model.t)
    for (const outcome of outcomes) {
      this.recordEvents(outcome.instance, outcome.result.events)
    }
    this.emitSnapshot(model.t)
    return null
  }

  private syncSticky(
    outcomes: readonly ReconcileOutcome[],
    now: number
  ): void {
    if (this.disposed) return
    const data = this.store.read()
    type StickyEntry = OwrtHostData['stickyMap'][number]
    const disabled = new Set(
      outcomes
        .filter((outcome) => !outcome.instance.sticky)
        .map((outcome) => outcome.instance.id)
    )
    const existing = new Map<string, StickyEntry>()
    for (const entry of data.stickyMap) {
      const mac = normalizedMac(entry[1])
      if (!mac || disabled.has(entry[0])) continue
      existing.set(`${entry[0]}|${mac}`, [entry[0], mac, entry[2], entry[3]])
    }

    const candidates = new Map(existing)
    for (const outcome of outcomes) {
      if (!outcome.instance.sticky) continue
      for (const update of outcome.result.stickyUpdates) {
        const mac = normalizedMac(update.mac)
        if (!mac) continue
        const key = `${outcome.instance.id}|${mac}`
        const old = existing.get(key)
        const touchAt =
          Math.floor(Math.max(0, now) / STICKY_TOUCH_MS) * STICKY_TOUCH_MS
        const lastSeen =
          old &&
          old[2] === update.wan &&
          old[3] >= touchAt
            ? old[3]
            : touchAt
        candidates.set(key, [
          outcome.instance.id,
          mac,
          update.wan,
          lastSeen
        ])
      }
    }

    // Timestamp is the LRU key. A lexical tie-break keeps the same subset when
    // more active clients exist than stickyCap, instead of rotating thousands
    // of entries and dirtying hostData on every tick.
    const cap = Math.max(1, this.options.rules().stickyCap)
    const selected = [...candidates.entries()]
      .sort(
        (a, b) =>
          b[1][3] - a[1][3] ||
          (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      )
      .slice(0, cap)
      .map((entry) => entry[1])
    const selectedByKey = new Map(
      selected.map((entry) => [
        `${entry[0]}|${normalizedMac(entry[1])}`,
        entry
      ])
    )
    const changed =
      selectedByKey.size !== data.stickyMap.length ||
      data.stickyMap.some((entry) => {
        const selectedEntry = selectedByKey.get(
          `${entry[0]}|${normalizedMac(entry[1])}`
        )
        return (
          !selectedEntry ||
          selectedEntry[2] !== entry[2] ||
          selectedEntry[3] !== entry[3]
        )
      })
    if (!changed) return
    this.store.update((draft) => {
      draft.stickyMap = selected
    })
  }

  private recordEvents(
    instance: BindingInstanceRecord,
    events: readonly BindingPlannerEvent[]
  ): void {
    if (this.disposed || events.length === 0) return
    this.store.update((data) => {
      for (const event of events) {
        data.events.push([
          instance.id,
          event.t,
          event.kind,
          event.text.slice(0, 500)
        ])
      }
    })
    const emitLimit = 8
    if (events.length > emitLimit) {
      this.ctx.emit('bindingLog', {
        id: instance.id,
        data: `${new Date().toISOString()} [${instance.name}] ${events.length - emitLimit} earlier event(s) omitted from the live log`
      })
    }
    for (const event of events.slice(-emitLimit)) {
      this.ctx.emit(
        'bindingLog',
        {
          id: instance.id,
          data: `${new Date(event.t).toISOString()} [${instance.name}] ${event.text}`
        }
      )
    }
  }

  private emitSnapshot(t: number): void {
    if (this.disposed) return
    const instances = this.store.read().instances.map((instance) => {
      const cached = this.cache.get(instance.id)
      return cached?.summary ?? {
        id: instance.id,
        name: instance.name,
        lan: instance.lan,
        carrier: instance.carrier,
        running: instance.running,
        wan: emptyWanSummary(),
        devices: emptyDeviceSummary()
      }
    })
    this.latestPayload = { t, instances, rows: this.list() }
    this.ctx.emit('binding', this.latestPayload)
  }

  private async execScript(lines: readonly string[], label: string): Promise<void> {
    if (lines.length === 0) return
    if (this.disposed) throw new Error('binding engine stopped')
    const result = await this.ctx.exec('sh -s', {
      stdin: `set -eu\n${lines.join('\n')}\n`,
      timeoutMs: this.options.rules().execTimeoutSec * 1000
    })
    if (result.code !== 0) throw shellFailure(label, result.code)
    if (this.disposed) throw new Error('binding engine stopped')
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const generation = this.workGeneration
    const guarded = (): Promise<T> =>
      this.current(generation)
        ? run()
        : Promise.reject(new Error('binding engine stopped'))
    const pending = this.serial.then(guarded, guarded)
    this.serial = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }
}
