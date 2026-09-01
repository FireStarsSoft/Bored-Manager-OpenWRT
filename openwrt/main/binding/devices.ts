/**
 * Unassign, Reassign and Pin: the three things an operator can do to one
 * device.
 *
 * All three work by writing into the planner's memory and then running a normal
 * reconcile, so a manual choice goes through exactly the same allocation the
 * automatic path uses. Because that pass can fail half way, the memory each
 * instance had before is kept and restored - otherwise a device would be left
 * held, force-reassigned or pinned by a pass that never reached the router.
 */
import type { OkResult } from '@shared/types'
import {
  hasFeature,
  wanbindPin,
  wanbindReassign,
  wanbindReconcile,
  wanbindSection,
  wanbindUnassign,
  type AgentDeps
} from '../agent'
import type { AgentCapability } from '../probe'
import { clonePlannerMemory, emptyPlannerMemory, normalizedMac } from './memory'
import { lanCidr, plannerWans, poolIfaces, wanState, wanUsable } from './pool'
import { reconcileModel } from './reconcile'
import { NO_SAMPLE, currentWanTables, exclusive, runMutationJob } from './runtime'
import { buildWanTableIndex } from './tables'
import type { BindingInstanceRecord, OwrtHostData } from '../store'
import type { RouterModel } from '../types'
import type { BindingPlannerMemory, BindingRuntime } from './types'

type DeviceAction = 'unassign' | 'reassign' | 'pin'

const ACTION_VERB: Record<DeviceAction, string> = {
  unassign: 'Unassign',
  reassign: 'Reassign',
  pin: 'Pin'
}

/**
 * What is wrong with a WAN that cannot take a device, as a sentence fragment.
 * The bare state word - `warning`, `dialing` - names the chip on the table but
 * says nothing about what to wait for.
 */
const WAN_TROUBLE: Record<string, string> = {
  dialing: 'is still dialing',
  error: 'is down, or reporting an error',
  warning:
    'has no IPv4 address, no routing table of its own, or has only just come up',
  missing: 'is not in the interface list this module last read off the router'
}

/** One row of a selection: which instance, which device. */
interface DeviceTarget {
  instanceId: string
  mac: string
}

function actionTargets(idOrKeys: unknown, macRaw?: unknown): DeviceTarget[] {
  const targets: DeviceTarget[] = []
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

/**
 * Why this pin cannot be honoured, or null.
 *
 * A pin that cannot be honoured must be refused rather than approximated: the
 * planner falls back to a random free WAN when the named one is unavailable,
 * which is exactly what Reassign does and the opposite of what was asked for.
 * Every answer here names the WAN and what to do about it.
 */
function pinRefusal(
  runtime: BindingRuntime,
  model: RouterModel,
  instance: BindingInstanceRecord,
  mac: string,
  wan: string
): string | null {
  const pool = poolIfaces(model, instance.lan, instance.carrier)
  if (!wan) {
    return `Name the WAN to pin this device to - one of the ${pool.length} ${instance.carrier} interfaces ${instance.name} hands out, spelled as it is in the WAN column of the Assignments table.`
  }
  if (!pool.some((iface) => iface.name === wan)) {
    return `${wan} is not one of the ${pool.length} WANs ${instance.name} can hand out: its pool is every interface on carrier ${instance.carrier}. Use a name from the WAN column of the Assignments table.`
  }
  const holder = runtime.cache
    .get(instance.id)
    ?.assignments.find((row) => row.wan === wan && row.mac !== mac)
  if (holder) {
    return `${wan} already carries ${holder.host || holder.mac}. Binding is one device per WAN, so unassign that device first, then pin this one.`
  }
  const rules = runtime.options.rules()
  const tables = buildWanTableIndex(model, runtime.store.read(), rules, currentWanTables(runtime))
  const planner = plannerWans(model, instance, tables).find((entry) => entry.name === wan)
  if (!planner || !wanUsable(planner, rules.wanWarnUptimeSec)) {
    return `${wan} cannot take a device right now: it ${
      planner ? WAN_TROUBLE[wanState(planner, rules.wanWarnUptimeSec)] : WAN_TROUBLE.missing
    }. Wait for the WAN state column on the Assignments table to say available or bound, then pin again.`
  }
  /**
   * The address is a one-to-one binding's, so this instance leaves it alone on
   * every path that could seat it. Accepted, the pin would be recorded, the
   * planner would drop the device at the same gate it always does, and the
   * action would have reported success for something that was never going to
   * happen - which is the approximation the rest of this function exists to
   * refuse.
   */
  const reservedIps = new Set(runtime.options.reservedIps?.() ?? [])
  const leasedIp = model.leases.find((lease) => normalizedMac(lease.mac) === mac)?.ip ?? ''
  if (leasedIp && reservedIps.has(leasedIp)) {
    return `${leasedIp} is bound one-to-one, and ${instance.name} leaves an address that is bound one-to-one entirely alone - so a pin here would name a WAN no rule of this instance ever gets to use. Change the one-to-one binding for that address instead.`
  }
  if (
    !instance.sticky &&
    !model.leases.some((lease) => normalizedMac(lease.mac) === mac)
  ) {
    // Nothing would happen: the planner only allocates devices that hold a
    // current lease, and with sticky choices off there is nowhere to record the
    // pin until this one comes back.
    return `${mac} holds no current DHCP lease, and ${instance.name} does not keep the same WAN across reconnects, so there is nothing to pin it onto yet. Turn on "Keep each device on the same WAN" for this instance, or pin the device once it is back on the network.`
  }
  return null
}

export async function queueDeviceAction(
  runtime: BindingRuntime,
  idOrKeys: unknown,
  macRaw: unknown,
  action: DeviceAction,
  wanRaw?: unknown
): Promise<OkResult> {
  const targets = actionTargets(idOrKeys, macRaw)
  if (targets.length === 0) return { ok: false, error: 'no valid device was selected' }
  return runMutationJob(
    runtime,
    `binding-${action}`,
    `${ACTION_VERB[action]} ${targets.length} device${targets.length === 1 ? '' : 's'}`,
    () => deviceActionNow(runtime, idOrKeys, macRaw, action, wanRaw)
  )
}

/**
 * The same three actions, asked of the router instead.
 *
 * They are the router's to perform when it holds the assignment, and the
 * mapping is one to one because the package was built to make it so: Unassign
 * holds a client out of the pool, Reassign moves it off the WAN it has, and Pin
 * puts it on a named one. Nothing here touches planner memory - there is no
 * planner running on this side - and nothing writes an ip rule.
 *
 * A pass is asked for afterwards so the rows a surface reads next are the ones
 * the action produced, rather than the ones from up to thirty seconds ago.
 */
async function routerDeviceAction(
  runtime: BindingRuntime,
  capability: AgentCapability,
  targets: readonly DeviceTarget[],
  action: DeviceAction,
  wan: string
): Promise<OkResult> {
  const deps: AgentDeps = { ctx: runtime.ctx, capability: () => capability }
  const instances = new Map(runtime.store.read().instances.map((entry) => [entry.id, entry]))
  const done: string[] = []

  for (const target of targets) {
    const instance = instances.get(target.instanceId)
    if (!instance) {
      return { ok: false, error: `binding instance ${target.instanceId} no longer exists` }
    }

    const section = wanbindSection(instance.id)
    const result =
      action === 'pin'
        ? await wanbindPin(deps, section, target.mac, wan)
        : action === 'unassign'
          ? await wanbindUnassign(deps, section, target.mac)
          : await wanbindReassign(deps, section, target.mac)

    if (!result.ok) {
      // Named, and with however many already went through. A selection that
      // stopped half way is a fact the user needs; reporting only the failure
      // would have them repeat the ones that worked.
      return {
        ok: false,
        error: done.length
          ? `${result.error ?? 'the router refused'} (${done.length} of ${targets.length} were done first)`
          : (result.error ?? 'the router refused')
      }
    }

    done.push(target.mac)
  }

  // Best effort. The rows are one pass behind if this does not land, which the
  // next tick corrects; failing an action that the router did perform would be
  // reporting the wrong thing.
  await wanbindReconcile(deps)

  return { ok: true, data: `${done.length}` }
}

async function deviceActionNow(
  runtime: BindingRuntime,
  idOrKeys: unknown,
  macRaw: unknown,
  action: DeviceAction,
  wanRaw?: unknown
): Promise<OkResult> {
  const targets = actionTargets(idOrKeys, macRaw)
  if (targets.length === 0) return { ok: false, error: 'no valid device was selected' }
  const wan = String(wanRaw ?? '').trim()
  if (action === 'pin' && targets.length > 1) {
    // One WAN carries one device, so a selection cannot share the one that was
    // typed. Silently pinning the first of them would be worse than saying so.
    return {
      ok: false,
      error: 'Pin acts on one device at a time: a WAN carries exactly one device, so a selection of devices cannot share the one you named. Pin them one at a time.'
    }
  }
  return exclusive(runtime, async () => {
    // The router's, when the router is holding the assignment. Checked inside
    // the exclusive block so it cannot change under the branch, and before the
    // model is required: the agent knows who is bound whether or not a sweep
    // has landed on this side yet.
    const capability = runtime.options.agent?.()
    if (capability && hasFeature(capability, 'binding')) {
      return routerDeviceAction(runtime, capability, targets, action, wan)
    }

    const model = runtime.latestModel
    if (!model) return { ok: false, error: NO_SAMPLE }
    const instances = new Map(runtime.store.read().instances.map((entry) => [entry.id, entry]))
    for (const target of targets) {
      const instance = instances.get(target.instanceId)
      if (!instance) {
        return { ok: false, error: `binding instance ${target.instanceId} no longer exists` }
      }
      if (!lanCidr(model.ifaces.find((entry) => entry.name === instance.lan))) {
        return { ok: false, error: `LAN ${instance.lan} has no current IPv4 subnet` }
      }
      if (action === 'pin') {
        const refusal = pinRefusal(runtime, model, instance, target.mac, wan)
        if (refusal) return { ok: false, error: refusal }
      }
    }

    const memoryBackups = new Map<string, BindingPlannerMemory>()
    for (const target of targets) {
      const memory = runtime.memory.get(target.instanceId) ?? emptyPlannerMemory()
      if (!memoryBackups.has(target.instanceId)) {
        memoryBackups.set(target.instanceId, clonePlannerMemory(memory))
      }
      const held = new Set(memory.heldMacs.map(normalizedMac).filter(Boolean))
      const forced = new Map(memory.forceReassign.map((entry) => [normalizedMac(entry.mac), entry]))
      if (action === 'unassign') {
        held.add(target.mac)
        forced.delete(target.mac)
      } else if (action === 'pin') {
        held.delete(target.mac)
        forced.set(target.mac, { mac: target.mac, preferWan: wan })
      } else {
        held.delete(target.mac)
        const oldWan = runtime.cache
          .get(target.instanceId)
          ?.assignments.find((row) => row.mac === target.mac)?.wan
        forced.set(target.mac, {
          mac: target.mac,
          ...(oldWan ? { avoidWan: oldWan } : {})
        })
      }
      memory.heldMacs = [...held]
      memory.forceReassign = [...forced.values()]
      runtime.memory.set(target.instanceId, memory)
    }

    const removedSticky: OwrtHostData['stickyMap'] = []
    if (action === 'reassign') {
      runtime.store.update((data) => {
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
    const stickyBackup = action === 'pin' ? writePin(runtime, targets[0], wan, model.t) : null

    const error = await reconcileModel(runtime, model, {
      forceKernel: false,
      rebooted: false
    })
    if (error) {
      for (const [id, backup] of memoryBackups) runtime.memory.set(id, backup)
      if (removedSticky.length) {
        runtime.store.update((data) => {
          data.stickyMap.push(...removedSticky)
        })
      }
      if (stickyBackup) {
        runtime.store.update((data) => {
          data.stickyMap = stickyBackup
        })
      }
      return { ok: false, error }
    }
    return { ok: true, data: String(targets.length) }
  })
}

/**
 * Record the pin where a reconnect can still find it, and hand back the sticky
 * map as it was so a failed pass can put it back.
 *
 * Only an instance that keeps sticky choices has anywhere to put this: the
 * reconcile drops every sticky entry belonging to an instance with the flag
 * off, so writing one there would be deleted on the next pass. That is also why
 * the memory entry above is not enough on its own - it is consumed by one
 * reconciliation, and a device that is not on the network during that pass is
 * never allocated, so the pin would have applied to nothing at all.
 */
function writePin(
  runtime: BindingRuntime,
  target: { instanceId: string; mac: string } | undefined,
  wan: string,
  now: number
): OwrtHostData['stickyMap'] | null {
  if (!target) return null
  const instance = runtime.store
    .read()
    .instances.find((entry) => entry.id === target.instanceId)
  if (!instance?.sticky) return null
  const before = runtime.store.read().stickyMap.map((entry) => [...entry] as typeof entry)
  runtime.store.update((data) => {
    data.stickyMap = [
      ...data.stickyMap.filter(
        (entry) =>
          entry[0] !== target.instanceId || normalizedMac(entry[1]) !== target.mac
      ),
      [target.instanceId, target.mac, wan, Math.max(0, now)]
    ]
  })
  return before
}
