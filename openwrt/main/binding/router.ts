/**
 * The pass that runs instead, when the router is doing the binding itself.
 *
 * With `bm-wanbind` installed there are two possible writers of the same ip
 * rule priority range, and only one of them can be right. The router wins, and
 * not by preference: it is the one that sees a lease the moment dnsmasq writes
 * it, and the one whose rules survive this module being closed. So this pass
 * plans nothing and writes nothing at all - it asks who is bound, asks who is
 * waiting, and fills exactly the same caches `reconcile.ts` fills, so every
 * page above is unchanged and does not know which half answered.
 *
 * The division is worth stating because it is the whole design: **the agent
 * owns the assignment, the model owns the interfaces.** The agent knows which
 * client is on which WAN; it does not have to know whether that WAN is dialling
 * or has been up for a week, because this side already reads that on every
 * sweep. So the rows are built from the agent's answer and the sweep's
 * interface state, through the same builders the SSH path uses.
 *
 * A call that fails does **not** fall back to the SSH pass, and that is the one
 * counter-intuitive rule here. Once `bm-wanbind` is installed and running, this
 * module planning its own rules would be a second writer in the same priority
 * range - so a router that did not answer this tick means the rows are one tick
 * stale, which the snapshot says, and nothing else. Falling back would be two
 * halves writing the same rules from different ideas of the truth, which is far
 * worse than a table with a staleness marker on it.
 *
 * The fall back happens a level up instead, at the only place it is safe: the
 * capability verdict. No package, a stopped service, an API version this module
 * does not know - all of them mean the router is not binding, and the SSH pass
 * runs exactly as it did before any of this existed.
 */
import { wanbindAssignments, wanbindWaiting, type AgentDeps } from '../agent'
import { recordLayout } from '../records'
import type { BindingInstanceRecord } from '../store'
import type { RouterModel } from '../types'
import { normalizedMac } from './memory'
import { lanCidr, plannerPolicy, plannerWans, poolIfaces } from './pool'
import { buildWanTableIndex } from './tables'
import { currentWanTables } from './runtime'
import {
  emitSnapshot,
  emptyDeviceSummary,
  emptyWanSummary,
  plannerAssignmentRows,
  plannerWaitingRows,
  summarizeWans
} from './view'
import type {
  BindingDesiredAssignment,
  BindingDeviceMemory,
  BindingRuntime,
  BindingWaitingMemory,
  CurrentLease
} from './types'

/**
 * One pass. Null when it worked; the reason otherwise, for the snapshot.
 *
 * Two calls rather than one, because they are two questions with two answers
 * and combining them on the router would only mean a reply nobody could read at
 * a shell. Both are local ubus on the far side of one SSH round trip each,
 * which is two round trips against the seven the SSH pass needs.
 */
export async function routerSample(
  runtime: BindingRuntime,
  deps: AgentDeps,
  model: RouterModel
): Promise<string | null> {
  const rules = runtime.options.rules()
  const data = runtime.store.read()
  const instances = data.instances

  const rows = await wanbindAssignments(deps)
  if (!rows.ok || !rows.data) return rows.error ?? 'the router did not report its assignments'

  const queued = await wanbindWaiting(deps)
  if (!queued.ok || !queued.data) return queued.error ?? 'the router did not report its queue'

  if (runtime.disposed) return null

  const tables = buildWanTableIndex(model, data, rules, currentWanTables(runtime))

  // Grouped by the section name the router knows an instance as, which is what
  // its replies are keyed on. An instance the router has never heard of - one
  // created while the package was absent - simply gets no rows, which is the
  // truth about it rather than a guess.
  const assignmentsBySection = new Map<string, typeof rows.data.assignments>()
  for (const row of rows.data.assignments) {
    const list = assignmentsBySection.get(row.instance) ?? []
    list.push(row)
    assignmentsBySection.set(row.instance, list)
  }

  const waitingBySection = new Map<string, typeof queued.data.waiting>()
  for (const row of queued.data.waiting) {
    const list = waitingBySection.get(row.instance) ?? []
    list.push(row)
    waitingBySection.set(row.instance, list)
  }

  for (const instance of instances) {
    fillCache(runtime, model, instance, {
      rules,
      tables,
      assignments: assignmentsBySection.get(routerId(instance)) ?? [],
      waiting: waitingBySection.get(routerId(instance)) ?? []
    })
  }

  if (runtime.disposed) return null
  emitSnapshot(runtime, model.t)
  return null
}

/**
 * The name the router knows an instance by.
 *
 * The same derivation `agent/wanbind.ts` uses when it writes the section, and
 * deliberately so: the two have to agree, and one function producing the answer
 * in both directions is how they do.
 */
function routerId(instance: BindingInstanceRecord): string {
  return `bm${instance.id.replace(/[^A-Za-z0-9_]/g, '')}`
}

function fillCache(
  runtime: BindingRuntime,
  model: RouterModel,
  instance: BindingInstanceRecord,
  input: {
    rules: ReturnType<BindingRuntime['options']['rules']>
    tables: ReturnType<typeof buildWanTableIndex>
    assignments: ReadonlyArray<{
      mac: string
      ip: string
      host: string
      wan: string
      pref: number
      table: number
      assignedAt: number
    }>
    waiting: ReadonlyArray<{
      mac: string
      ip: string
      host: string
      order: number
      since: number
      held: boolean
      why: string
    }>
  }
): void {
  const layout = recordLayout(instance, input.rules)
  const policy = plannerPolicy(input.rules, layout)
  const wans = plannerWans(model, instance, input.tables)
  const poolByName = new Map(wans.map((wan) => [wan.name, wan]))

  const iface = model.ifaces.find((entry) => entry.name === instance.lan)
  const cidr = lanCidr(iface)

  // Same shape as the LAN-with-no-address case in the SSH pass: every WAN in
  // the pool counted as a warning, no rows, and nothing claimed about devices.
  if (!cidr) {
    runtime.cache.set(instance.id, {
      summary: {
        id: instance.id,
        name: instance.name,
        lan: instance.lan,
        carrier: instance.carrier,
        running: instance.running,
        wan: {
          ...emptyWanSummary(),
          total: poolIfaces(model, instance.lan, instance.carrier).length,
          warning: poolIfaces(model, instance.lan, instance.carrier).length
        },
        devices: emptyDeviceSummary()
      },
      assignments: [],
      waiting: []
    })
    return
  }

  const devicesByMac = new Map<string, BindingDeviceMemory>()
  const desired: BindingDesiredAssignment[] = []
  const usedWanNames = new Set<string>()

  for (const row of input.assignments) {
    const mac = normalizedMac(row.mac)
    if (!mac) continue

    devicesByMac.set(mac, {
      mac,
      ip: row.ip,
      host: row.host,
      // The router does not report either of these per device, and neither is
      // read by the row builder. They exist because the memory shape is shared
      // with the planner, which does keep them.
      lastSeenAt: model.t,
      assignedAt: row.assignedAt * 1000,
      wan: row.wan
    })

    desired.push({
      pref: row.pref,
      ip: row.ip,
      table: row.table,
      wan: row.wan,
      mac,
      // The router keeps seconds and this side counts in milliseconds; a raw
      // epoch here reported every device as bound since 1970.
      assignedAt: row.assignedAt * 1000
    })

    usedWanNames.add(row.wan)
  }

  const queue: BindingWaitingMemory[] = []
  const held = new Set<string>()
  const unallocatable = new Set<string>()
  const currentLeases = new Map<string, CurrentLease>()

  for (const [index, lease] of model.leases.entries()) {
    const mac = normalizedMac(lease.mac)
    if (mac) currentLeases.set(mac, { lease: { ...lease, mac }, index })
  }

  // Held first, then the queue in the router's own order, which is arrival
  // order. Sorting here would invent an order the router does not have.
  const ordered = [...input.waiting].sort((a, b) => a.order - b.order)
  for (const row of ordered) {
    const mac = normalizedMac(row.mac)
    if (!mac) continue

    if (row.held) held.add(mac)
    if (row.why === 'exhausted') unallocatable.add(mac)

    queue.push({ mac, enqueuedAt: row.since * 1000, order: row.order })

    if (!devicesByMac.has(mac)) {
      devicesByMac.set(mac, {
        mac,
        ip: row.ip,
        host: row.host,
        lastSeenAt: model.t,
        assignedAt: model.t
      })
    }
  }

  runtime.cache.set(instance.id, {
    summary: {
      id: instance.id,
      name: instance.name,
      lan: instance.lan,
      carrier: instance.carrier,
      running: instance.running,
      wan: summarizeWans(wans, policy.wanWarnUptimeSec, usedWanNames),
      devices: {
        total: devicesByMac.size,
        bound: desired.length,
        waiting: queue.length
      }
    },
    assignments: plannerAssignmentRows({
      instanceId: instance.id,
      now: model.t,
      warnUptimeSec: policy.wanWarnUptimeSec,
      desired,
      devicesByMac,
      poolByName
    }),
    waiting: plannerWaitingRows({
      instanceId: instance.id,
      now: model.t,
      queue,
      currentLeases,
      previousDevices: devicesByMac,
      held,
      unallocatable
    })
  })
}
