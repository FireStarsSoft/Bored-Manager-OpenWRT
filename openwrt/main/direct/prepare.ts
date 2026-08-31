/**
 * What a one-to-one binding installs on the router, and the job that installs
 * it.
 *
 * The check produced a plan; by the time the job runs, minutes may have passed
 * and the router may have moved, so every step revalidates before it writes.
 * The three writes - the WAN's routing table, the scoped firewall forwarding
 * and the rule itself - live here together with the reservation that stops two
 * Saves a second apart claiming the same preference.
 */
import type { OkResult } from '@shared/types'
import {
  ENGINE_STOPPED,
  NO_SAMPLE,
  claimExtraTables,
  firewallZoneForNetwork,
  installScopedForwardings,
  lanCidr,
  networkTables,
  preparationProbe,
  removeScopedForwardings,
  writeWanTables
} from '../binding'
import type { JobSpec } from '../jobs'
import { lanForAddress } from './allocate'
import { runDirectPass } from './pass'
import { exclusive } from './runtime'
import { leaseAddresses, resolveTarget, targetLabel } from './target'
import { emitSnapshot } from './view'
import type { DirectPlan, DirectRuntime } from './types'

/**
 * The `bmd<slot>_` band this binding's firewall sections live under.
 *
 * Guarded rather than trusted even though the store reader already bounds the
 * slot: the value is concatenated into a UCI section name that a `uci delete`
 * is built from, and that guard is the only thing between a hand-edited
 * per-router document and a shell token nobody meant to write.
 */
export function sectionPrefix(slot: number): string {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot > 4_095) {
    throw new Error(`one-to-one binding slot ${slot} is outside the range this module writes`)
  }
  return `bmd${slot}_`
}

export async function applyDirect(runtime: DirectRuntime, raw: unknown): Promise<OkResult> {
  const payload =
    typeof raw === 'object' && raw !== null ? (raw as { token?: unknown; values?: unknown }) : {}
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.checkSession.take(token, payload.values)
  if (!taken) {
    return { ok: false, error: 'that check expired or the form changed - check again' }
  }
  const plan = taken.payload
  const problem = reservePreparation(runtime, plan)
  if (problem) return { ok: false, error: problem }
  const progress: PreparationProgress = { forwardingInstalled: false }
  const spec = preparationJob(runtime, plan, progress)
  if (runtime.options.jobs) {
    try {
      const job = runtime.options.jobs.start(spec)
      return { ok: true, data: job.id }
    } catch (error) {
      releasePreparation(runtime, plan.record.id)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    for (const item of spec.items) await item.run(() => false)
    return { ok: true, data: plan.record.id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    releasePreparation(runtime, plan.record.id)
    // The no-jobs path runs the same items by hand, so it needs the same
    // compensation; `onFinished` is the runner's hook and never fires here.
    await dropOrphanedForwardings(runtime, plan, progress)
  }
}

/**
 * What the job has actually put on the router so far, so the compensation below
 * knows whether there is anything to take off.
 *
 * A flag rather than "just try the removal anyway": the removal is a `uci`
 * batch plus a firewall reload, and a create refused by the very first step
 * would otherwise reload fw4 on the router for nothing every time somebody
 * mistypes a form.
 */
interface PreparationProgress {
  forwardingInstalled: boolean
}

/**
 * Take the scoped forwarding back off when the job that installed it never
 * reached the record.
 *
 * The forwarding is written one step before the record is, so a job that fails
 * or is cancelled in between leaves `bmd<slot>_` sections on the router that
 * nothing owns: no record names that slot, so Delete can never be asked to
 * remove them, and the next create is stamped with the next free slot rather
 * than this one - which is what made them permanent. The rule the same job may
 * have written needs no compensation, because the next pass reads it back as an
 * in-band rule no record claims and deletes it.
 *
 * Compensating rather than moving the forwarding install below the rule write,
 * which would strand only that self-cleaning rule: the rule and the record are
 * written inside one `exclusive` block on purpose, so that no fast tick can
 * ever see the rule before a record owns it. Sliding a third router write
 * between them would open exactly that window, and the tick landing in it would
 * delete the rule the job had just written. This way the successful path is
 * unchanged and only the failure grows a step.
 *
 * Nothing here is fatal and nothing may be: the job has already reported the
 * failure this is cleaning up after, and a second error on top of it would only
 * bury the one the user has to act on.
 */
async function dropOrphanedForwardings(
  runtime: DirectRuntime,
  plan: DirectPlan,
  progress: PreparationProgress
): Promise<void> {
  const record = plan.record
  if (!progress.forwardingInstalled) return
  if (runtime.store.read().direct.some((entry) => entry.id === record.id)) return
  try {
    await exclusive(runtime, () =>
      removeScopedForwardings(runtime, runtime.store, sectionPrefix(record.slot))
    )
  } catch (error) {
    runtime.ctx.log(
      `openwrt: one-to-one binding ${record.name} was not created and the firewall forwarding it had already installed could not be removed (${
        error instanceof Error ? error.message : String(error)
      })`
    )
  }
}

/**
 * Naming the holder is the whole remedy: the collision clears itself once that
 * job finishes, and a bare "already in progress" gave no hint of that.
 */
function reservePreparation(runtime: DirectRuntime, plan: DirectPlan): string | null {
  const record = plan.record
  for (const other of runtime.preparations.values()) {
    const clash =
      other.record.id === record.id ||
      other.record.pref === record.pref ||
      other.record.slot === record.slot ||
      other.record.name.toLowerCase() === record.name.toLowerCase() ||
      targetLabel(other.record.target) === targetLabel(record.target)
    if (clash) {
      return `one-to-one binding "${other.record.name}" is still being prepared and holds the same name, address or rule priority - wait for that job to finish, then check again`
    }
  }
  runtime.preparations.set(record.id, plan)
  return null
}

export function releasePreparation(runtime: DirectRuntime, id: string): void {
  runtime.preparations.delete(id)
}

function preparationJob(
  runtime: DirectRuntime,
  plan: DirectPlan,
  progress: PreparationProgress
): JobSpec {
  const record = plan.record
  const items: JobSpec['items'] = [
    {
      name: 'Revalidate the address, LAN, WAN and routing table',
      run: async () => {
        await exclusive(runtime, () => revalidate(runtime, plan))
        return 'router state still matches the check'
      }
    }
  ]
  const tableAdd = plan.tableAdd
  if (tableAdd) {
    items.push({
      name: `Give ${tableAdd.wan} routing table ${tableAdd.table}`,
      run: async (cancelled) => {
        if (cancelled()) throw new Error('cancelled')
        await exclusive(runtime, async () => {
          // Serialized against every other writer of /etc/config/network.
          await runtime.store.withNetwork(() => writeWanTables(runtime, [tableAdd]))
          if (runtime.disposed) throw new Error(ENGINE_STOPPED)
          // Written without an owner, exactly as an instance preparation writes
          // it. `trim` runs inside every read and every update and drops an
          // owned entry whose owner is in neither array - and this binding is
          // not in `direct` until the last item of this same job. Stamping the
          // owner here would delete the claim in the update that made it. The
          // UCI write did happen, so an unowned entry is the honest record of it.
          runtime.store.updateNow((data) => {
            const map = new Map(data.extraTables.map((entry) => [entry[0], entry]))
            map.set(tableAdd.wan, [tableAdd.wan, tableAdd.table])
            data.extraTables = [...map.values()]
          })
        })
        return `${tableAdd.wan} -> ${tableAdd.table}`
      }
    })
  }
  items.push({
    name: 'Install the firewall forwarding',
    run: async (cancelled) => {
      if (cancelled()) throw new Error('cancelled')
      await exclusive(runtime, () =>
        installScopedForwardings(runtime, runtime.store, {
          sectionPrefix: sectionPrefix(record.slot),
          sourceZone: plan.lanZone,
          destinationZones: plan.destinationZones,
          zoneName: runtime.options.rules().zoneName
        })
      )
      progress.forwardingInstalled = true
      return `${plan.lanZone} -> ${plan.destinationZones.join(', ')}`
    }
  })
  items.push({
    name: 'Write the rule and record the binding',
    run: async (cancelled) => {
      if (cancelled()) throw new Error('cancelled')
      await exclusive(runtime, () => installBinding(runtime, plan))
      return record.id
    }
  })
  return {
    kind: 'direct-prepare',
    label: `Prepare one-to-one binding ${record.name}`,
    items,
    onError: 'abort',
    onFinished: async () => {
      releasePreparation(runtime, record.id)
      await dropOrphanedForwardings(runtime, plan, progress)
    }
  }
}

/**
 * The rule first and the record second, in one exclusive block.
 *
 * The pass is run with the new record appended rather than with a hand-written
 * `ip rule add`, so a WAN that went down between the check and the job installs
 * the held rule and its blackhole instead of one pointing at an interface with
 * no route - the same decision the fast tick would make a moment later, made
 * once, here.
 */
async function installBinding(runtime: DirectRuntime, plan: DirectPlan): Promise<void> {
  const record = plan.record
  const data = runtime.store.read()
  if (data.direct.some((entry) => entry.id === record.id)) {
    throw new Error('this one-to-one binding already exists')
  }
  if (
    data.direct.some(
      (entry) =>
        entry.pref === record.pref ||
        entry.slot === record.slot ||
        entry.name.toLowerCase() === record.name.toLowerCase()
    )
  ) {
    throw new Error('another one-to-one binding claimed that name, priority or slot while the job waited')
  }
  const model = runtime.options.latestModel()
  if (!model) throw new Error(NO_SAMPLE)
  const failed = await runDirectPass(runtime, model, { extra: [record], publish: false })
  if (failed) throw new Error(failed)
  // Write-through: a binding appearing is topology. The debounce would put ten
  // seconds between the router carrying this rule and the module having any
  // record that it does - and the record is the only thing that can remove it.
  runtime.store.updateNow((draft) => {
    if (draft.direct.some((entry) => entry.id === record.id)) {
      throw new Error('this one-to-one binding already exists')
    }
    draft.direct.push({ ...record })
    if (plan.tableAdd) claimExtraTables(draft, record.id, [plan.tableAdd.wan])
  })
  runtime.options.event?.(
    'created',
    `one-to-one binding ${record.name} sends ${targetLabel(record.target)} through ${record.wan}`
  )
  emitSnapshot(runtime, model.t)
  runtime.options.requestDump?.()
}

async function revalidate(runtime: DirectRuntime, plan: DirectPlan): Promise<void> {
  const record = plan.record
  if (runtime.disposed || !runtime.ctx.connected) throw new Error('router disconnected')
  const model = runtime.options.latestModel()
  if (!model) throw new Error(NO_SAMPLE)
  const data = runtime.store.read()
  if (data.direct.some((entry) => entry.pref === record.pref)) {
    throw new Error(`rule priority ${record.pref} is no longer free; check again`)
  }
  if (model.rules.some((rule) => rule.pref === record.pref)) {
    throw new Error(`the router already has a rule at priority ${record.pref}; check again`)
  }
  const lanIface = model.ifaces.find((iface) => iface.name === record.lan)
  const currentCidr = lanCidr(lanIface)
  if (currentCidr !== plan.lanCidr) throw new Error('the LAN subnet changed; check the form again')
  const address = resolveTarget(record.target, leaseAddresses(model.leases))
  if (address && lanForAddress(lanIface ? [lanIface] : [], address) == null) {
    throw new Error(`${address} is no longer inside ${plan.lanCidr}; check the form again`)
  }
  const probe = await preparationProbe(runtime)
  if (firewallZoneForNetwork(probe.firewall, record.lan) !== plan.lanZone) {
    throw new Error('the LAN firewall zone changed; check the form again')
  }
  if (!probe.network.sectionTypes.has(`network.${record.wan}`)) {
    throw new Error(`WAN section ${record.wan} no longer exists`)
  }
  const currentTables = networkTables(probe.network)
  const observed = currentTables.get(record.wan)
  if (observed != null && observed !== record.table) {
    throw new Error(`${record.wan} now uses table ${observed}; check again`)
  }
  for (const [wan, table] of currentTables) {
    if (table === record.table && wan !== record.wan) {
      throw new Error(`table ${record.table} is now used by ${wan}; check again`)
    }
  }
}
