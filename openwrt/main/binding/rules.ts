/**
 * The `ip rule` layer: reading the router's rules back into assignments, and
 * turning a plan into the commands that reach the desired state.
 *
 * The router is the source of truth, so every pass starts by reconstructing
 * what is actually bound from the rules themselves rather than trusting what
 * the last pass believed.
 */
import type { ParsedSubnet } from '../util'
import { ipv4ToInt, subnetContains } from '../util'
import { normalizedMac } from './memory'
import type {
  BindingDesiredAssignment,
  BindingDeviceMemory,
  BindingPlannerWan,
  BindingReconcileInput,
  BindingRuleChange,
  BindingRuleDiff,
  BindingTableToWan,
  CurrentLease,
  WorkingActual
} from './types'
import type { IpRule } from '../types'

/**
 * Re-exported so the rest of this folder keeps naming it here. The number
 * itself lives in `records.ts`, beside the other constant two files used to
 * declare for themselves.
 */
export { MANAGED_PREF_CEILING } from '../records'

/**
 * The one line that (re)establishes an instance's fail-closed catch-all.
 *
 * `route replace` and not `route flush` followed by `route add`: the flush left
 * the table empty for as long as the add took, and every client whose rule
 * already pointed at it fell through to the next matching rule - the main
 * table - and left through the router's own WAN. `replace` is a single netlink
 * message, so there is no instant in which the blackhole is not there.
 */
export function catchAllRoute(table: number): string {
  return `ip -4 route replace unreachable default table ${table}`
}

export function ruleIp(from: string): string | null {
  const text = String(from ?? '').trim()
  const slash = text.indexOf('/')
  const ip = slash >= 0 ? text.slice(0, slash) : text
  return ipv4ToInt(ip) == null ? null : ip
}

export function ruleSignature(rule: BindingRuleChange): string {
  return `${rule.pref}|${rule.ip}|${rule.table}`
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

export function applyRuleDiffInMemory(rules: IpRule[], diff: BindingRuleDiff): void {
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

export function emptyRuleDiff(): BindingRuleDiff {
  return {
    delete: [],
    add: [],
    deleteLines: [],
    addLines: [],
    lines: [],
    chunks: []
  }
}

export interface ActualAssignments {
  actual: WorkingActual[]
  /** The WAN each device is on right now, taken from the rules themselves. */
  observedWanByMac: Map<string, string>
}

/**
 * Rebuild the current assignment from the router's own `ip rule` output.
 *
 * A rule only carries a source IP, so the owning device is recovered from the
 * current leases, then the previous pass's IP map, then a sticky choice for the
 * WAN the rule's table belongs to. Rules that resolve to nothing recognizable
 * are dropped unless their table maps into this instance's pool, which is what
 * keeps a post-restart rule alive long enough for dnsmasq to catch up.
 */
export function readActualAssignments(
  input: BindingReconcileInput,
  context: {
    subnet: ParsedSubnet
    currentLeases: ReadonlyMap<string, CurrentLease>
    previousDevices: ReadonlyMap<string, BindingDeviceMemory>
    poolByName: ReadonlyMap<string, BindingPlannerWan>
  }
): ActualAssignments {
  const { subnet, currentLeases, previousDevices, poolByName } = context
  const previousIpToMac = new Map<string, string>()
  for (const [mac, device] of previousDevices) previousIpToMac.set(device.ip, mac)
  const leasesByIp = new Map<string, string>()
  for (const [mac, current] of currentLeases) leasesByIp.set(current.lease.ip, mac)

  const tableToWan = normalizeTableMap(input.tableToWan)
  for (const wan of input.wans) {
    if (wan.table != null && !tableToWan.has(wan.table)) {
      tableToWan.set(wan.table, wan.name)
    }
  }
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
    if (rule.pref < input.policy.rulePrefBase || rule.pref >= input.policy.catchAllPrefBase) {
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
  return { actual, observedWanByMac }
}

/**
 * Compare whole preference groups. If a corrupt snapshot contains duplicate
 * preferences, delete the group and recreate the one desired rule.
 */
export function planRuleDiff(
  actual: readonly WorkingActual[],
  desired: readonly BindingDesiredAssignment[],
  chunkLines: number
): BindingRuleDiff {
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
  return {
    delete: deleteChanges,
    add: addChanges,
    deleteLines,
    addLines,
    lines,
    chunks: chunkRuleCommands(lines, chunkLines)
  }
}
