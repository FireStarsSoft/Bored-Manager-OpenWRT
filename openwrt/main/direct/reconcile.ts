/**
 * The pure pass: given a moment, the records, and what the router says it is
 * doing, the lines that would make the two agree.
 *
 * No clock, no randomness, no I/O - `engine.ts` supplies all three. That is
 * what makes the tests real: every rule this folder ever puts on a router is
 * decided here, so a fixture that says "this WAN is down and this binding holds"
 * can assert the exact strings rather than the fact that something happened.
 *
 * The one piece of judgement worth stating up front is what hold means. A rule
 * whose lookup table has no matching route does not fail: the kernel's fib rule
 * walk simply carries on to the next rule and out of the main table - the
 * router's default connection, which is the leak hold exists to prevent. So a
 * held binding is re-pointed at the module's blackhole table rather than left
 * where it was, and the `unreachable default` in that table is written before
 * anything is aimed at it.
 *
 * The mirror image of that is what fallback means, and it is the same mistake
 * read backwards: "no rule falls through to main" is only true where nothing
 * else matches the address, and a binding instance's catch-all does. So
 * fallback is a rule pointing at the main table rather than the absence of one,
 * because the absence was a total outage for the option chosen to avoid exactly
 * that.
 */
import {
  catchAllRoute,
  chunkRuleCommands,
  ruleIp,
  wanUsable,
  type BindingPlannerWan,
  type BindingRuleChange,
  type BindingRuleDiff
} from '../binding'
import { DIRECT_PREF_SPAN } from '../records'
import type { DirectBindingRecord } from '../store'
import type { RouterModel } from '../types'
import { ipv4ToInt, parseCidr, subnetContains } from '../util'
import { leaseAddresses, targetLabel } from './target'
import { buildRow, countTotals } from './view'
import type {
  DirectDesiredRule,
  DirectMemoryEntry,
  DirectPlannerEvent,
  DirectPlannerResult,
  DirectPolicy,
  DirectReconcileInput,
  DirectRow,
  DirectState
} from './types'

/** The three protocols a WAN port can be running to carry a bound address. */
const WAN_PROTOS = ['pppoe', 'dhcp', 'static']

/**
 * The kernel's main table, written as its number and never as the word `main`.
 *
 * `ip rule add ... lookup main` only resolves the name through
 * `/etc/iproute2/rt_tables`, which is a file whoever administers the router
 * owns and which a build carrying ip-tiny may not have at all; 254 is the
 * kernel's own constant and needs nothing on disk to mean what it means.
 *
 * It does not survive the round trip either way, which is the thing to know
 * before reading `input.rules`: `ip -4 rule show` prints table 254 back as
 * `main`, and `parseIpRules` records numeric tables only, so a rule written
 * here is simply absent from the next sample. `planDirectReconciliation` stands
 * the last pass's own memory in for that read-back rather than reading the
 * absence as "no rule".
 */
const MAIN_TABLE = 254

/**
 * Every interface a binding could name, with the state `wanUsable` reads.
 *
 * Unlike an instance's pool this is not scoped to a carrier: a one-to-one
 * binding names one WAN section by hand, so the answer has to be available for
 * whichever one that is. The table comes from the index first and from the
 * interface dump second, which is the same order of trust the instance half
 * uses.
 */
export function directWans(
  model: RouterModel,
  byWan: ReadonlyMap<string, number>
): BindingPlannerWan[] {
  return model.ifaces
    .filter((iface) => WAN_PROTOS.includes(iface.proto))
    .map((iface) => ({
      name: iface.name,
      table: byWan.get(iface.name) ?? iface.ip4Table ?? null,
      up: iface.up,
      pending: iface.pending,
      ...(iface.ipv4?.addr ? { ipv4: iface.ipv4.addr } : {}),
      uptimeSec: iface.uptimeSec,
      ...(iface.errorCode ? { errorCode: iface.errorCode } : {})
    }))
}

/**
 * Compare whole preference groups, the way the instance half's `planRuleDiff`
 * does, with one addition it does not need.
 *
 * That half reads back its entire managed band, so a preference it wants to
 * write is either already in the group or genuinely absent. Here one kind of
 * rule cannot be read back at all: a fallback rule points at the main table,
 * and `ip -4 rule show` names table 254 `main` while `parseIpRules` records
 * numeric tables only. The caller stands its own memory in for the rules *it*
 * wrote, but a main-table rule at that preference that this pass did not write
 * - left by a module that restarted, or put there by hand - is still invisible,
 * and `ip rule add` stacks rather than replaces. So the add is preceded by a
 * delete even when the group looked empty, or that rule would be duplicated
 * once per tick, forever.
 */
function planDirectRuleDiff(
  actual: readonly BindingRuleChange[],
  desired: readonly BindingRuleChange[],
  chunkLines: number
): BindingRuleDiff {
  const group = <T extends { pref: number }>(entries: readonly T[]): Map<number, T[]> => {
    const result = new Map<number, T[]>()
    for (const entry of entries) {
      const bucket = result.get(entry.pref) ?? []
      bucket.push(entry)
      result.set(entry.pref, bucket)
    }
    return result
  }
  const signature = (entry: BindingRuleChange): string =>
    `${entry.pref}|${entry.ip}|${entry.table}`
  const actualByPref = group(actual)
  const desiredByPref = group(desired)
  const deleteChanges: BindingRuleChange[] = []
  const addChanges: BindingRuleChange[] = []
  const deleteLines: string[] = []
  const addLines: string[] = []
  const prefs = new Set([...actualByPref.keys(), ...desiredByPref.keys()])
  for (const pref of [...prefs].sort((a, b) => a - b)) {
    const oldGroup = actualByPref.get(pref) ?? []
    const newGroup = desiredByPref.get(pref) ?? []
    const oldSignatures = oldGroup.map(signature).sort()
    const newSignatures = newGroup.map(signature).sort()
    if (
      oldSignatures.length === newSignatures.length &&
      oldSignatures.every((value, index) => value === newSignatures[index])
    ) {
      continue
    }
    for (const entry of oldGroup) {
      deleteChanges.push({ pref: entry.pref, ip: entry.ip, table: entry.table })
      deleteLines.push(`ip -4 rule del pref ${pref} 2>/dev/null || true`)
    }
    // The extra delete described above. It is a line only, not a change: there
    // is no rule in the in-memory snapshot for it to remove, and inventing one
    // would make `applyRuleDiffInMemory` drop a rule that is really there.
    if (oldGroup.length === 0 && newGroup.length > 0) {
      deleteLines.push(`ip -4 rule del pref ${pref} 2>/dev/null || true`)
    }
    for (const entry of newGroup) {
      addChanges.push({ pref: entry.pref, ip: entry.ip, table: entry.table })
      addLines.push(`ip -4 rule add from ${entry.ip}/32 lookup ${entry.table} pref ${entry.pref}`)
    }
  }
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

/**
 * The address this binding is written for on this pass, and how long it has
 * been missing.
 *
 * An IP target is its own answer. A MAC target reads the leases, and when the
 * device is not on the network it keeps the last address it was seen at for
 * `releaseGraceSec` before the rule comes off - the same grace the instance
 * planner gives a disappearing device, and for the same reason: a laptop that
 * sleeps for thirty seconds should not lose and regain its WAN.
 *
 * The address is re-validated even though it came from a lease. It is spliced
 * into an `ip -4 rule add`, and `/tmp/dhcp.leases` is a file on the router;
 * "the parser would have caught it" is not a guarantee worth resting a shell
 * command on.
 */
function resolveAddress(
  record: DirectBindingRecord,
  leaseByMac: ReadonlyMap<string, string>,
  previous: DirectMemoryEntry | undefined,
  now: number,
  graceMs: number
): { ip: string; missingSince: number } {
  const live = record.target.kind === 'ip' ? record.target.ip : (leaseByMac.get(record.target.mac) ?? '')
  if (live && ipv4ToInt(live) != null) return { ip: live, missingSince: 0 }
  if (record.target.kind === 'ip') return { ip: '', missingSince: 0 }
  const remembered = previous?.ip ?? ''
  if (!remembered) return { ip: '', missingSince: 0 }
  const missingSince = previous?.missingSince || now
  if (now - missingSince < graceMs) return { ip: remembered, missingSince }
  return { ip: '', missingSince: 0 }
}

/**
 * Whether the address this pass resolved has left the LAN the binding was
 * stamped with.
 *
 * The scoped firewall forwarding was written once, at create time, from that
 * LAN's zone, and nothing ever rewrites it. So a device that roams onto a guest
 * SSID or a second VLAN keeps its rule and loses its firewall path: it is still
 * policy-routed into the bound WAN's table while fw4 has no forwarding from the
 * zone it is now in, and every packet is dropped while the row and the `direct`
 * stream both say "bound".
 *
 * This is asked after the address is resolved and never inside the resolution
 * itself. Answering '' there would fall into the release-grace branch, which
 * resurrects the address the device has just abandoned and goes on writing a
 * rule for it - and if dnsmasq has already handed that address to somebody
 * else, that somebody else is the one steered onto the bound WAN.
 *
 * A LAN with no CIDR this tick is not an answer. It may simply be missing from
 * a short interface dump, and reading that absence as "the device has moved"
 * would strand every binding on the router over one bad sample.
 */
function offStampedLan(
  record: DirectBindingRecord,
  ip: string,
  lanCidrs: ReadonlyMap<string, string> | undefined
): boolean {
  const cidr = lanCidrs?.get(record.lan) ?? ''
  if (!cidr) return false
  const subnet = parseCidr(cidr)
  if (!subnet) return false
  return !subnetContains(subnet, ip)
}

/**
 * The rule a state asks for, or null for the states that hold none.
 *
 * `fallback` writes a rule rather than nothing at all. "No rule falls through
 * to the main table" is only true on a router where nothing else matches the
 * address, and a binding instance's catch-all at `catchAllPrefBase + slot` does
 * match it - and sends it to the unreachable table, which the instance never
 * lifts it back out of because this module reserves the address. The option
 * that promises the device stays online was a total outage; a rule at the
 * stamped preference pointing at main reaches the default connection from
 * underneath that catch-all, and is equally correct on a router that carries no
 * instance at all.
 *
 * `stranded` has no table of its own on purpose. The device is on a LAN this
 * binding has no forwarding from, so the honest answer is the one its owner
 * already chose for a WAN it cannot use: park it, or hand it to the default
 * connection. What it must never become is the absence of a rule, which would
 * let the address out through main by accident - the leak `hold` exists to deny.
 *
 * `shadowed` is the one down state that genuinely writes nothing, and it is the
 * opposite case: another binding already holds this address at a lower
 * preference, so a rule here would either be beaten by that one or - at a lower
 * number still - quietly steal the address from the binding that was created
 * for it. Falling through to the `null` below is the whole behaviour.
 */
function desiredRuleFor(
  record: DirectBindingRecord,
  state: DirectState,
  ip: string,
  policy: DirectPolicy
): DirectDesiredRule | null {
  if (!ip) return null
  const at = { id: record.id, pref: record.pref, ip }
  if (state === 'bound') return { ...at, table: record.table, mode: 'wan' }
  if (state === 'held' || (state === 'stranded' && record.whenDown === 'hold')) {
    return { ...at, table: policy.catchAllTable, mode: 'hold' }
  }
  if (state === 'fallback' || (state === 'stranded' && record.whenDown === 'fallback')) {
    return { ...at, table: MAIN_TABLE, mode: 'fallback' }
  }
  return null
}

/**
 * What changed, in sentences a person can read in the event trail.
 *
 * Nothing is said on the first pass a binding is seen on: a reconnect would
 * otherwise announce every binding it found as though it had just done it, and
 * the trail is capped, so that is the noise that evicts the transitions worth
 * having.
 */
function transitionEvents(
  record: DirectBindingRecord,
  previous: DirectMemoryEntry | undefined,
  entry: DirectMemoryEntry,
  catchAllTable: number,
  now: number
): DirectPlannerEvent[] {
  if (!previous) return []
  if (previous.state === entry.state) {
    if (entry.state !== 'bound' || !entry.ip || previous.ip === entry.ip) return []
    return [{
      t: now,
      kind: 'moved',
      text: `${record.name} followed ${targetLabel(record.target)} from ${previous.ip} to ${entry.ip}`
    }]
  }
  if (entry.state === 'bound') {
    return [{ t: now, kind: 'bound', text: `${record.name} is bound: ${entry.ip} leaves through ${record.wan}` }]
  }
  if (entry.state === 'held') {
    return [{
      t: now,
      kind: 'held',
      text: `${record.name} is held: ${record.wan} is unusable, so ${entry.ip} is parked on table ${catchAllTable} and has no way out`
    }]
  }
  if (entry.state === 'fallback') {
    return [{
      t: now,
      kind: 'fallback',
      text: `${record.name} fell back: ${record.wan} is unusable, so ${entry.ip} is re-pointed at the main table and leaves through the router's default connection`
    }]
  }
  if (entry.state === 'stranded') {
    return [{
      t: now,
      kind: 'stranded',
      text: `${record.name} has moved off ${record.lan}: ${targetLabel(record.target)} answers to ${entry.ip} now, and this binding has no firewall path from the LAN that address is on, so it is ${
        record.whenDown === 'hold'
          ? `parked on table ${catchAllTable} and has no way out`
          : "on the router's default connection"
      } until it comes back`
    }]
  }
  if (entry.state === 'shadowed') {
    return [{
      t: now,
      kind: 'shadowed',
      text: `${record.name} is not in force: ${entry.ip} is already bound by ${
        entry.shadowedBy ?? 'another one-to-one binding'
      }, which holds it at a lower rule priority, so this binding writes no rule of its own`
    }]
  }
  if (entry.state === 'waiting') {
    return [{
      t: now,
      kind: 'released',
      text: `${record.name} has no lease for ${targetLabel(record.target)} any more; its rule was removed`
    }]
  }
  return [{ t: now, kind: 'disabled', text: `${record.name} was switched off; its rule was removed` }]
}

export function planDirectReconciliation(input: DirectReconcileInput): DirectPlannerResult {
  const { now, policy } = input
  const leaseByMac = leaseAddresses(input.leases)
  const wanByName = new Map(input.wans.map((wan) => [wan.name, wan]))
  const previousById = new Map((input.memory ?? []).map((entry) => [entry.id, entry]))
  const graceMs = Math.max(0, policy.releaseGraceSec) * 1000

  const desired: DirectDesiredRule[] = []
  const memory: DirectMemoryEntry[] = []
  const events: DirectPlannerEvent[] = []
  const rows: DirectRow[] = []

  const records = [...input.records].sort(
    (a, b) => a.pref - b.pref || a.id.localeCompare(b.id)
  )
  // Which binding owns each address this pass resolved. The create gate cannot
  // catch every collision - a MAC target created while its device was offline
  // had no address to compare - so the second claim on an address is settled
  // here, once, and the same way the kernel would settle it: the lowest
  // preference wins. The loop runs in preference order, so the first record to
  // reach an address is that one.
  const claimedBy = new Map<string, string>()
  for (const record of records) {
    const previous = previousById.get(record.id)
    const { ip, missingSince } = resolveAddress(record, leaseByMac, previous, now, graceMs)
    const wan = wanByName.get(record.wan)
    const usable = wan ? wanUsable(wan, policy.wanWarnUptimeSec) : false
    // A disabled binding claims nothing, which is exactly what being switched
    // off says about an address, and a binding with no address has none to
    // claim - so both are asked before the collision is.
    const holder = record.enabled && ip ? claimedBy.get(ip) : undefined
    // `stranded` is asked ahead of the WAN's own health on purpose. Either
    // answer writes the same rule, so the ordering only decides which sentence
    // the row and the trail carry - and of the two, "the device has moved
    // somewhere this binding cannot reach it" is the one nobody could have
    // guessed from the page.
    const state: DirectState = !record.enabled
      ? 'disabled'
      : !ip
        ? 'waiting'
        : holder
          ? 'shadowed'
          : offStampedLan(record, ip, input.lanCidrs)
            ? 'stranded'
            : usable
              ? 'bound'
              : record.whenDown === 'hold'
                ? 'held'
                : 'fallback'
    if (record.enabled && ip && !holder) claimedBy.set(ip, record.name)
    const rule = desiredRuleFor(record, state, ip, policy)
    if (rule) desired.push(rule)
    const entry: DirectMemoryEntry = {
      id: record.id,
      ip,
      missingSince,
      state,
      since: previous && previous.state === state ? previous.since : now,
      ...(holder ? { shadowedBy: holder } : {})
    }
    memory.push(entry)
    rows.push(buildRow(record, entry, now, policy.catchAllTable))
    events.push(...transitionEvents(record, previous, entry, policy.catchAllTable, now))
  }

  // The band today's settings define, plus every preference a record was
  // stamped with. A rule outside both belongs to the instance half, to another
  // tool, or to nobody - and this pass never deletes what it did not put there.
  //
  // The stamped half is what makes moving `directPrefBase` survivable.
  // `desired` is built from each record's stamped number, which deliberately
  // never moves; reading `actual` back from the live band alone meant that
  // after any edit of that setting the two disagreed about every binding on the
  // router, so each one emitted a del+add on every fast tick for ever - and its
  // rule was momentarily absent each cycle, which for a held binding is exactly
  // the leak holding exists to deny. Rules that belong to no record are still
  // read from the band, because those are the ones that need cleaning up.
  const bandStart = policy.directPrefBase
  const bandEnd = policy.directPrefBase + DIRECT_PREF_SPAN
  const stamped = new Set(records.map((record) => record.pref))
  const actual: BindingRuleChange[] = []
  for (const rule of input.rules) {
    const inBand = rule.pref >= bandStart && rule.pref < bandEnd
    if (!inBand && !stamped.has(rule.pref)) continue
    const ip = ruleIp(rule.from)
    if (!ip) continue
    actual.push({ pref: rule.pref, ip, table: rule.table })
  }
  // A fallback rule cannot be read back at all: `ip -4 rule show` prints table
  // 254 as `main` and `parseIpRules` records numeric tables only, so the rule
  // the last pass wrote is missing from this sample however healthy the router
  // is. What that pass remembered writing is the only evidence there is, and
  // taking the absence at face value instead would rewrite the rule on every
  // tick. Only when nothing readable already sits at that preference: a real
  // rule there is the truth and has to win.
  for (const record of records) {
    const before = previousById.get(record.id)
    if (!before) continue
    const wrote = desiredRuleFor(record, before.state, before.ip, policy)
    if (wrote?.table !== MAIN_TABLE) continue
    if (actual.some((entry) => entry.pref === record.pref)) continue
    actual.push({ pref: record.pref, ip: before.ip, table: MAIN_TABLE })
  }

  const diff = planDirectRuleDiff(
    actual,
    desired.map((entry) => ({ pref: entry.pref, ip: entry.ip, table: entry.table })),
    policy.ruleChunkLines
  )
  const holdAdded = diff.add.some((change) =>
    desired.some(
      (entry) =>
        entry.mode === 'hold' && entry.pref === change.pref && entry.ip === change.ip
    )
  )
  return {
    desired,
    diff,
    // `route replace` rather than flush-then-add, and written on the pass that
    // first aims something here: on a router carrying no binding instance
    // nothing else has ever put an `unreachable default` in this table, so a
    // hold rule pointed at an empty table would fall straight through to the
    // main one - which is the default connection hold is meant to deny.
    routeLines: holdAdded ? [catchAllRoute(policy.catchAllTable)] : [],
    memory,
    events,
    rows,
    totals: countTotals(rows)
  }
}
