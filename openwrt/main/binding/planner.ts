/**
 * The pure reconciliation pass: from one sample of the router to the rules,
 * memory and rows that sample implies.
 *
 * It reads no clock/random/global state and mutates none of its inputs, so unit
 * tests can replay a complete outage, reboot or lease transition with
 * deterministic output. Everything it needs that is not in its input - the
 * current assignment, the rule diff, the rows, the events - is computed by the
 * neighbouring files, so this one is the order those decisions happen in.
 */
import type { Lease } from '../types'
import { ipv4ToInt, parseCidr, subnetContains } from '../util'
import { planBindingEvents } from './events'
import { clonePlannerMemory, normalizedMac } from './memory'
import { FreeWanPool, SeededRandom, wanState, wanUsable } from './pool'
import { emptyRuleDiff, planRuleDiff, readActualAssignments, ruleIp } from './rules'
import type {
  BindingDesiredAssignment,
  BindingDeviceMemory,
  BindingForcedReassign,
  BindingOrphanMemory,
  BindingPlannerResult,
  BindingPlannerWan,
  BindingReconcileInput,
  BindingStickyChoice,
  BindingWaitingMemory,
  BindingWanErrorMemory,
  CurrentLease,
  WorkingActual,
  WorkingAssignment
} from './types'
import {
  emptyDeviceSummary,
  emptyWanSummary,
  plannerAssignmentRows,
  plannerWaitingRows,
  summarizeWans
} from './view'

function leaseRank(lease: Lease): number {
  return lease.expires === 0 ? Number.MAX_SAFE_INTEGER : lease.expires
}

/**
 * The address window a range-scoped instance may see, or null when it serves
 * its whole LAN. Resolved once: the alternative is parsing both endpoints again
 * for every lease on the router on every fast tick. Endpoints that do not parse
 * or run backwards read as no window at all - the whole LAN, which is the
 * fallback the store already makes for a stored range it cannot read and the
 * only one that leaves the instance serving somebody rather than nobody.
 */
function leaseWindow(
  range: { from: string; to: string } | undefined
): { low: number; high: number } | null {
  if (!range) return null
  const low = ipv4ToInt(range.from)
  const high = ipv4ToInt(range.to)
  return low == null || high == null || low > high ? null : { low, high }
}

function activeLease(lease: Lease, now: number): boolean {
  // A lease whose expiry could not be rebased onto our clock counts as active:
  // the router's own epoch says nothing next to `now` (see Lease.expiresUnknown),
  // and dropping it would unbind every client of a router waiting for NTP.
  return lease.expires === 0 || lease.expiresUnknown === true || lease.expires * 1000 > now
}

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
      ruleDiff: emptyRuleDiff(),
      memory: oldMemory,
      stickyUpdates: [],
      events: [],
      assignments: [],
      waiting: [],
      wan: {
        ...emptyWanSummary(),
        total: input.wans.length,
        warning: input.wans.length
      },
      devices: emptyDeviceSummary()
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

  /**
   * The addresses a one-to-one binding owns, which this instance must not seat
   * at all. Three separate paths can put a device on a WAN and each has to
   * refuse a reserved address: a device that already held an instance rule when
   * the 1-1 binding was created would otherwise keep both rules for ever -
   * steered by the 1-1 rule, since lower preference wins - while its instance
   * held a WAN out of the pool for a device that never uses it.
   */
  const reservedIps = new Set(input.reservedIps ?? [])
  const bounds = leaseWindow(input.range)

  // dnsmasq can briefly contain old and new rows for the same MAC. Prefer the
  // row with the later expiry, retaining file order as a stable tie-breaker.
  const currentLeases = new Map<string, CurrentLease>()
  input.leases.forEach((lease, index) => {
    const mac = normalizedMac(lease.mac)
    if (!mac || !subnetContains(subnet, lease.ip) || !activeLease(lease, now)) return
    // The range decides which devices exist for this instance and nothing else.
    // Allocation, sticky choices, remap and the FIFO queue are untouched by it,
    // and none of them ever walks the addresses between the endpoints.
    const address = bounds ? ipv4ToInt(lease.ip) : null
    if (bounds && (address == null || address < bounds.low || address > bounds.high)) {
      return
    }
    const old = currentLeases.get(mac)
    if (
      !old ||
      leaseRank(lease) > leaseRank(old.lease) ||
      (leaseRank(lease) === leaseRank(old.lease) && index > old.index)
    ) {
      currentLeases.set(mac, { lease: { ...lease, mac }, index })
    }
  })

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

  const poolByName = new Map(input.wans.map((wan) => [wan.name, wan]))
  const { actual, observedWanByMac } = readActualAssignments(input, {
    subnet,
    currentLeases,
    previousDevices,
    poolByName
  })

  const held = new Set(oldMemory.heldMacs.map(normalizedMac).filter(Boolean))
  const forced = new Map<string, BindingForcedReassign>()
  for (const entry of oldMemory.forceReassign) {
    const mac = normalizedMac(entry.mac)
    if (mac) {
      forced.set(mac, {
        mac,
        ...(entry.avoidWan ? { avoidWan: entry.avoidWan } : {}),
        ...(entry.preferWan ? { preferWan: entry.preferWan } : {})
      })
    }
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
      // Gate two, matched on the rule's own address because an orphan has no
      // device behind it to ask. A rule for a reserved address is the stale
      // instance rule the 1-1 binding replaced, and keeping it alive through
      // the grace would hold a WAN for an address bound somewhere else.
      if (reservedIps.has(entry.ip)) continue
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
      // Gate one, and the one that matters: this device was already bound here
      // when the 1-1 binding was created. Refusing to adopt its rule is what
      // puts that rule in `planRuleDiff.delete` and hands its WAN back to the
      // pool - adopting it leaves two rules and no pass that removes either.
      if (device && reservedIps.has(device.ip)) continue
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
    // Gate three. The device keeps its place in the queue and the waiting table
    // says why it will never leave it, rather than promising a WAN that is
    // never coming.
    if (reservedIps.has(device.ip)) continue
    const isForced = forced.has(request.mac)
    let selected: BindingPlannerWan | null = null
    // A hand-placed pin outranks both the sticky choice and the random draw,
    // and is honoured whether or not the instance keeps sticky choices at all:
    // it is a request about this device, not a policy about all of them.
    if (request.preferWan && freeWans.has(request.preferWan)) {
      selected = freeWans.takeNamed(request.preferWan)
    }
    if (
      !selected &&
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
  // A device the range could not seat used to disappear from both tables: it
  // has no assignment, and it was absent from the queue because it held one
  // when the queue was built. Put it back in line so the waiting table can
  // account for it and say why.
  for (const mac of unallocatable) {
    if (!currentLeases.has(mac) || queueByMac.has(mac)) continue
    queueByMac.set(mac, { mac, enqueuedAt: now, order: nextOrder++ })
  }
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
  const ruleDiff = planRuleDiff(actual, desired, policy.ruleChunkLines)

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
  const waitingRows = plannerWaitingRows({
    instanceId: input.instance.id,
    now,
    queue: nextWaiting,
    currentLeases,
    previousDevices,
    held,
    unallocatable,
    reservedIps
  })
  const assignmentRows = plannerAssignmentRows({
    instanceId: input.instance.id,
    now,
    warnUptimeSec: policy.wanWarnUptimeSec,
    desired,
    devicesByMac: nextDeviceByMac,
    poolByName
  })

  const events = planBindingEvents({
    now,
    policy,
    running: input.instance.running,
    releaseGraceMs,
    prefsExhausted: oldMemory.prefsExhausted === true,
    previousWaiting: oldMemory.waiting,
    currentLeases,
    previousDevices,
    desiredByMac,
    actualByMac,
    observedWanByMac,
    held,
    unallocatable
  })

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
    ruleDiff,
    memory: {
      devices: nextDevices,
      waiting: nextWaiting,
      wanErrors: nextErrors,
      orphans: nextOrphans,
      heldMacs: [...held].filter((mac) => currentLeases.has(mac)),
      forceReassign: [],
      nextOrder,
      prefsExhausted: unallocatable.size > 0
    },
    stickyUpdates,
    events,
    assignments: assignmentRows,
    waiting: waitingRows,
    wan: summarizeWans(
      input.wans,
      policy.wanWarnUptimeSec,
      new Set(desired.map((entry) => entry.wan))
    ),
    devices: {
      total: nextDevices.length,
      bound: assignmentRows.length,
      waiting: waitingRows.length
    }
  }
}
