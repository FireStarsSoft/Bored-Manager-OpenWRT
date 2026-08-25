/**
 * Start, stop, delete - and the two ways the engine itself goes quiet.
 *
 * Each of the three writes the intended state, runs one reconcile, and puts
 * the old state back if that reconcile failed, so what the store says an
 * instance is doing always matches what the router was actually told. Delete
 * goes further and restores the catch-all it had just removed, because an
 * instance that is half deleted still has clients pointing at it.
 */
import type { OkResult } from '@shared/types'
import { recordLayout } from '../records'
import { recordEvents } from './events'
import { lanCidr } from './pool'
import { installCatchAll, removeFirewallForwardings } from './prepare'
import { reconcileModel } from './reconcile'
import {
  ENGINE_STOPPED,
  NO_SAMPLE,
  current,
  emptyBindingSnapshot,
  exclusive,
  execScript,
  runMutationJob
} from './runtime'
import { emitSnapshot } from './view'
import type { BindingRuntime } from './types'

export async function startInstance(
  runtime: BindingRuntime,
  idRaw: unknown
): Promise<OkResult> {
  const id = String(idRaw ?? '')
  const instance = runtime.store.read().instances.find((entry) => entry.id === id)
  if (!instance) return { ok: false, error: 'no such binding instance' }
  return runMutationJob(
    runtime,
    'binding-start',
    `Start binding ${instance.name}`,
    () => setRunning(runtime, id, true)
  )
}

export async function stopInstance(
  runtime: BindingRuntime,
  idRaw: unknown
): Promise<OkResult> {
  const id = String(idRaw ?? '')
  const instance = runtime.store.read().instances.find((entry) => entry.id === id)
  if (!instance) return { ok: false, error: 'no such binding instance' }
  return runMutationJob(
    runtime,
    'binding-stop',
    `Stop binding ${instance.name}`,
    () => setRunning(runtime, id, false)
  )
}

export async function deleteInstance(
  runtime: BindingRuntime,
  idRaw: unknown
): Promise<OkResult> {
  const id = String(idRaw ?? '')
  const instance = runtime.store.read().instances.find((entry) => entry.id === id)
  if (!instance) return { ok: false, error: 'no such binding instance' }
  return runMutationJob(
    runtime,
    'binding-delete',
    `Delete binding ${instance.name}`,
    () => deleteNow(runtime, id)
  )
}

/**
 * Both the pending value and the revert go through the store, so whatever
 * flush lands next writes what the engine actually believes.
 *
 * A bare `instance.running = x` reaches the same object - `read()` hands back
 * the live cache, not a copy - but leaves the record clean. Reconciliation
 * awaits SSH for seconds; any unrelated `update()` in that window schedules a
 * flush that persists the half-applied value, and the revert, being just as
 * clean, is never written at all. The instance then comes back running after
 * a restart although the work that was meant to start it failed.
 */
function persistRunning(runtime: BindingRuntime, id: string, running: boolean): void {
  runtime.store.update((data) => {
    const saved = data.instances.find((entry) => entry.id === id)
    if (saved) saved.running = running
  })
}

async function setRunning(
  runtime: BindingRuntime,
  id: string,
  running: boolean
): Promise<OkResult> {
  return exclusive(runtime, async () => {
    const instance = runtime.store.read().instances.find((entry) => entry.id === id)
    if (!instance) return { ok: false, error: 'no such binding instance' }
    const model = runtime.latestModel
    if (!model) return { ok: false, error: NO_SAMPLE }
    if (!lanCidr(model.ifaces.find((entry) => entry.name === instance.lan))) {
      return {
        ok: false,
        error: `LAN ${instance.lan} has no current IPv4 subnet; restore it before changing this instance`
      }
    }
    const old = instance.running
    persistRunning(runtime, id, running)
    const error = await reconcileModel(runtime, model, {
      forceKernel: true,
      rebooted: false
    })
    if (error) {
      persistRunning(runtime, id, old)
      return { ok: false, error }
    }
    // No write on success: the value above is already the one to keep.
    recordEvents(runtime, instance, [{
      t: Date.now(),
      kind: running ? 'started' : 'stopped',
      text: running
        ? `binding resumed for ${instance.lan} -> ${instance.carrier}`
        : 'binding stopped; assignment rules were removed and the safety catch-all remains'
    }])
    runtime.options.requestDump?.()
    return { ok: true }
  })
}

async function deleteNow(runtime: BindingRuntime, id: string): Promise<OkResult> {
  return exclusive(runtime, async () => {
    const instance = runtime.store.read().instances.find((entry) => entry.id === id)
    if (!instance) return { ok: false, error: 'no such binding instance' }
    const model = runtime.latestModel
    if (!model) return { ok: false, error: NO_SAMPLE }
    if (!lanCidr(model.ifaces.find((entry) => entry.name === instance.lan))) {
      return {
        ok: false,
        error: `LAN ${instance.lan} has no current IPv4 subnet; restore it before deleting so its rules can be identified safely`
      }
    }

    const wasRunning = instance.running
    persistRunning(runtime, id, false)
    const cidr = lanCidr(model.ifaces.find((entry) => entry.name === instance.lan))
    const generation = runtime.workGeneration
    // The preference this instance's catch-all was actually installed at. Read
    // from config instead, a "Safety-rule priority base" edit made in between
    // would delete some other instance's rule and leave this one's in place -
    // a LAN pointed at an unreachable table with nothing left to remove it.
    const pref = recordLayout(instance, runtime.options.rules()).catchAllPrefBase + instance.slot
    try {
      await removeFirewallForwardings(runtime, instance)
      if (!current(runtime, generation)) throw new Error(ENGINE_STOPPED)
      const error = await reconcileModel(runtime, model, { forceKernel: false, rebooted: false })
      if (error) throw new Error(error)
      if (!current(runtime, generation)) throw new Error(ENGINE_STOPPED)
      await execScript(
        runtime,
        [
          `while ip -4 rule del pref ${pref} 2>/dev/null; do :; done`
        ],
        'remove binding catch-all'
      )
    } catch (errorValue) {
      if (current(runtime, generation) && cidr) {
        try {
          await installCatchAll(runtime, instance, cidr, true)
          await reconcileModel(runtime, model, { forceKernel: true, rebooted: false })
        } catch {
          // Keep the original failure; catch-all restore is best effort.
        }
      }
      if (current(runtime, generation)) persistRunning(runtime, id, wasRunning)
      return {
        ok: false,
        error: errorValue instanceof Error ? errorValue.message : String(errorValue)
      }
    }
    if (!current(runtime, generation)) {
      return { ok: false, error: ENGINE_STOPPED }
    }

    // Write-through: an instance disappearing is topology, not history, and a
    // crash inside the ten-second debounce would bring the module back
    // believing it still owns a LAN it has just torn the rules off.
    runtime.store.updateNow((data) => {
      data.instances = data.instances.filter((entry) => entry.id !== id)
      data.stickyMap = data.stickyMap.filter((entry) => entry[0] !== id)
      data.events = data.events.filter((entry) => entry[0] !== id)
      // The WAN-to-table assignments this instance's preparation wrote. Left
      // behind they kept overriding the map for every instance created after
      // it, forever. `trim` prunes the same way, so a document already
      // polluted by an earlier build heals on its next read.
      data.extraTables = data.extraTables.filter((entry) => entry[2] !== id)
    })
    runtime.memory.delete(id)
    runtime.cache.delete(id)
    emitSnapshot(runtime, model.t)
    runtime.options.requestDump?.()
    runtime.ctx.log(`openwrt: binding instance ${instance.name} deleted`)
    return { ok: true }
  })
}

export function reset(runtime: BindingRuntime): void {
  runtime.workGeneration += 1
  runtime.checkSession.clear()
  runtime.latestModel = null
  runtime.lastUptime = null
  runtime.memory.clear()
  runtime.cache.clear()
  runtime.latestPayload = emptyBindingSnapshot()
  runtime.manualWanTables = undefined
  runtime.preparations.clear()
  runtime.lastTableAuditWarning = ''
  runtime.lastTableRepairNotice = ''
  runtime.tableRepairAttempts = 0
}

export function dispose(runtime: BindingRuntime): void {
  runtime.workGeneration += 1
  runtime.disposed = true
  runtime.checkSession.clear()
  runtime.memory.clear()
  runtime.cache.clear()
  runtime.preparations.clear()
}
