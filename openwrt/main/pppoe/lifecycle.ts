/**
 * The end of a batch's life: the refusals that have to happen before anything
 * is removed, and the job that removes it.
 *
 * Delete is the path with the most ways to go wrong, and nearly every step
 * below exists because one of them happened: a record that outlived the
 * sections it names, a zone the failed create never got as far as writing, a
 * cancellation between chunks that left committed UCI and a running netifd
 * disagreeing - and a WAN binding still steering LAN clients into the pool
 * about to be deleted.
 */
import type { OkResult } from '@shared/types'
import type { JobSpec, OpenWrtJob } from '../jobs'
import {
  POOL_FORWARDING_SECTION,
  UciCancelledError,
  applyInterfaceWave,
  buildDeletePppoeLines,
  buildDeleteVlanLines,
  buildFirewallPlan,
  buildZoneTeardownLines,
  chunkValues,
  effectivePppoeChunkSize,
  reloadFirewall,
  reloadNetwork,
  runUciBatch,
  vlanSectionName,
  waitCancelable
} from '../uci'
import { recordLayout } from '../records'
import { carrierScopesOverlap } from '../util'
import { inspectNetworkDevices } from './inspect'
import { allBatchNames } from './names'
import {
  forceDump,
  recordEvent,
  runFirewall,
  runNetwork,
  timeoutMs,
  writeThrough,
  type PppoeRuntime
} from './runtime'
import { emitSummary } from './view'

export function batchDelete(runtime: PppoeRuntime, idRaw: unknown): OkResult {
  const id = typeof idRaw === 'string' ? idRaw : ''
  const batch = runtime.store.read().batches.find((entry) => entry.id === id)
  if (!batch) return { ok: false, error: 'no such PPPoE batch' }
  if (runtime.deleting.has(id)) return { ok: false, error: 'that batch is already being deleted' }
  if (runtime.creating.has(id)) {
    return {
      ok: false,
      error: 'that batch is still being created - cancel the create job first, then delete'
    }
  }
  const holders = (runtime.service.bindingCarriers?.() ?? []).filter(
    (instance) => instance.running && carrierScopesOverlap(instance.carrier, batch.carrier)
  )
  if (holders.length) {
    const names = holders.map((instance) => `"${instance.name}"`).join(', ')
    return {
      ok: false,
      error:
        `WAN binding ${names} ${holders.length === 1 ? 'is' : 'are'} running on ${batch.carrier} ` +
        `and send LAN clients through this pool. Deleting it would leave those clients on a ` +
        `catch-all with no route out. Stop ${holders.length === 1 ? 'that instance' : 'those instances'} first.`
    }
  }
  runtime.deleting.add(id)

  const rules = runtime.config.effectiveRules()
  // Where this batch's sections actually live, taken from the record rather
  // than from config: chunk sizes and timeouts are how fast to work and are
  // read live, but the zone is part of the layout this batch was created in.
  // Read live, a zone renamed after the create would send `del_list
  // firewall.<new>.network=...` at a zone that never held these sections and
  // leave the old one listing five thousand interfaces that no longer exist.
  const layout = recordLayout(batch, rules)
  const names = allBatchNames(batch)
  const size = effectivePppoeChunkSize(names.length, rules.uciChunkSize)
  const waves = chunkValues(names, size)
  const candidateVlans = new Set<number>()
  if (batch.vlan !== undefined) candidateVlans.add(batch.vlan)
  let networkMutated = false
  let firewallMutated = false
  let finalReloadDone = false
  // A create that was cancelled or failed part-way leaves a record covering
  // the whole requested range while UCI only has the chunks that committed.
  // `uci delete` on a section that is not there prints `uci: Entry not
  // found`, which runUciBatch treats - correctly, for real mistakes - as a
  // failure, so the delete job aborted on the first phantom chunk and the
  // batch could never be removed. Delete only what the router has.
  const present = new Set<string>()
  let zonePresent = false

  const items: JobSpec['items'] = [{
    name: 'Inspect batch VLAN devices',
    run: async () => {
      const inventory = await inspectNetworkDevices(runtime, timeoutMs(rules))
      zonePresent = inventory.zoneSections.has(layout.zoneName)
      for (const name of names) {
        if (inventory.interfaceSections.has(name)) present.add(name)
        const device = inventory.interfaceDevices.get(name) ?? ''
        const prefix = `${batch.carrier}.`
        if (!device.startsWith(prefix)) continue
        const vlan = Number(device.slice(prefix.length))
        if (Number.isInteger(vlan) && vlan >= 1 && vlan <= 4094) candidateVlans.add(vlan)
      }
      if (present.size < names.length) {
        return `${names.length - present.size} of ${names.length} interfaces are already gone`
      }
    }
  }]
  for (const [index, wave] of waves.entries()) {
    items.push({
      name: `Stop batch wave ${index + 1}/${waves.length}`,
      run: async (cancelled) => {
        try {
          // A cancelled/failed create may have produced only part of the
          // recorded range; missing interfaces must not block cleanup.
          await applyInterfaceWave(runtime.ctx, wave, 'stop', timeoutMs(rules), {
            bestEffort: true
          })
          for (const name of wave) runtime.manuallyStopped.add(name)
        } finally {
          forceDump(runtime)
        }
        if (index + 1 < waves.length && rules.chunkDelayMs > 0 && !cancelled()) {
          try {
            await waitCancelable(rules.chunkDelayMs, cancelled)
          } catch (error) {
            if (!(error instanceof UciCancelledError)) throw error
          }
        }
      }
    })
  }
  for (const [index, chunk] of waves.entries()) {
    items.push({
      name: `Delete UCI chunk ${index + 1}/${waves.length}`,
      run: async () => {
        const sections = chunk.filter((name) => present.has(name))
        if (!sections.length) return 'nothing left to delete'
        // `del_list firewall.<zone>.network=...` on a zone the failed create
        // never got as far as adding fails with `uci: Invalid argument`.
        const firewall =
          layout.zoneMode === 'networks' && zonePresent
            ? { zoneName: layout.zoneName, mode: layout.zoneMode }
            : undefined
        const lines = buildDeletePppoeLines(sections, firewall)
        networkMutated = true
        if (firewall) firewallMutated = true
        try {
          await runNetwork(runtime, () =>
            runUciBatch(
              runtime.ctx,
              lines,
              firewall ? ['network', 'firewall'] : ['network'],
              timeoutMs(rules)
            )
          )
        } finally {
          forceDump(runtime)
        }
      }
    })
  }
  items.push({
    name: 'Clean unused VLAN devices and reload',
    run: async () => {
      const inventory = await inspectNetworkDevices(runtime, timeoutMs(rules))
      const used = new Set(inventory.interfaceDevices.values())
      const removable = [...candidateVlans].filter((vlan) => {
        const device = `${batch.carrier}.${vlan}`
        return !used.has(device) && inventory.deviceNames.get(vlanSectionName(vlan)) === device
      })
      const cleanup = buildDeleteVlanLines(removable)
      if (cleanup.length) {
        networkMutated = true
        try {
          await runNetwork(runtime, () =>
            runUciBatch(runtime.ctx, cleanup, ['network'], timeoutMs(rules))
          )
        } finally {
          forceDump(runtime)
        }
      }
      const remaining = runtime.store.read().batches.filter((entry) => entry.id !== id)
      firewallMutated = true
      await runFirewall(runtime, async () => {
        if (!remaining.length) {
          // Nothing is left for the zone to hold. Rebuilding it here left every
          // router this module had finished with carrying an empty zone that
          // still masqueraded, was still forwarded to from the LAN, and in
          // wildcard mode still claimed `pppoe-<prefix>+` for a prefix no batch
          // uses - and the next `buildFirewallPlan` had to invent a prefix out
          // of the batch being deleted to write it.
          const teardown = buildZoneTeardownLines({
            zoneName: layout.zoneName,
            zonePresent: inventory.zoneSections.has(layout.zoneName),
            forwardingPresent: inventory.forwardingSections.has(POOL_FORWARDING_SECTION)
          })
          if (teardown.length) {
            await runUciBatch(runtime.ctx, teardown, ['firewall'], timeoutMs(rules))
          }
          return
        }
        const rebuiltFirewall = buildFirewallPlan({
          zoneName: layout.zoneName,
          prefix: remaining[0].prefix,
          prefixes: [...new Set(remaining.map((entry) => entry.prefix))],
          mode: layout.zoneMode,
          networkSections: remaining.flatMap(allBatchNames),
          chunkSize: rules.uciChunkSize,
          lanZone: runtime.service.lanFirewallZone?.() || 'lan'
        })
        await runUciBatch(runtime.ctx, rebuiltFirewall.setupLines, ['firewall'], timeoutMs(rules))
        for (const membership of rebuiltFirewall.membershipChunks) {
          await runUciBatch(runtime.ctx, membership, ['firewall'], timeoutMs(rules))
        }
      })
      await reloadNetwork(runtime.ctx, timeoutMs(rules))
      await reloadFirewall(runtime.ctx, timeoutMs(rules))
      finalReloadDone = true
      forceDump(runtime)
    }
  })

  let job: OpenWrtJob
  try {
    job = runtime.jobs.start({
      kind: 'pppoe-delete',
      label: `Delete batch ${batch.name} (${batch.count} connections)`,
      items,
      onError: 'abort',
      onFinished: async (finished) => {
        runtime.deleting.delete(id)
        // Cancellation between delete chunks must not leave committed UCI and
        // the running netifd/firewall configuration out of sync.
        if (networkMutated && !finalReloadDone) {
          try {
            await reloadNetwork(runtime.ctx, timeoutMs(rules))
            if (firewallMutated) await reloadFirewall(runtime.ctx, timeoutMs(rules))
          } catch (error) {
            runtime.ctx.log(
              `openwrt: reload after interrupted delete failed: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
        if (finished.state === 'done') {
          writeThrough(runtime, (host) => {
            host.batches = host.batches.filter((entry) => entry.id !== id)
          })
          for (const name of names) {
            runtime.manuallyStopped.delete(name)
            runtime.usernames.delete(name)
            runtime.dialingSince.delete(name)
          }
        }
        forceDump(runtime)
        emitSummary(runtime)
        recordEvent(runtime, 'pppoe-delete', `Batch ${batch.name} delete job ${finished.state}`)
      }
    })
  } catch (error) {
    runtime.deleting.delete(id)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, data: job.id }
}
