/**
 * Turning a frozen plan into interfaces on the router.
 *
 * The passwords live in the closures below and nowhere else - not in the batch
 * record, not in a job label, not in an event. What the record does have to
 * describe exactly is which sections reached the router, because that record is
 * the only thing delete will ever work from; `shrinkToCommitted` is what keeps
 * the two in step when the job stops half-way.
 */
import type { OkResult } from '@shared/types'
import { hasFeature, poolCreate, routerPoolId } from '../agent'
import { managedLayout, type PppoeBatchRecord } from '../records'
import type { JobSpec, OpenWrtJob } from '../jobs'
import {
  UciCancelledError,
  applyFirewallPlan,
  applyPppoeChunk,
  buildFirewallPlan,
  planPppoeChunks,
  waitCancelable,
  type FirewallPlan,
  type PppoeUciChunk
} from '../uci'
import { inspectRouter, visibleInterfaceCount } from './inspect'
import { allBatchNames } from './names'
import { asRecord } from './parse'
import { applyRulesFingerprint, requestedVlans, vlanConflict } from './plan'
import { rangeStillFree } from './range'
import {
  clearRowCache,
  forceDump,
  recordEvent,
  runFirewall,
  runNetwork,
  timeoutMs,
  writeThrough,
  type PppoeRuntime
} from './runtime'
import type { PppoeRules, RouterInventory } from './types'
import { emitSummary } from './view'

function makeBatchId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    if (!taken.has(id)) return id
  }
  return `batch_${Date.now().toString(36)}_${taken.size.toString(36)}`
}

export async function applyPppoe(runtime: PppoeRuntime, raw: unknown): Promise<OkResult> {
  const payload = asRecord(raw)
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.session.take(token, payload.values)
  if (!taken) return { ok: false, error: 'that check expired or the form changed - check again' }
  if (!runtime.ctx.connected) return { ok: false, error: 'the router disconnected after the check' }

  const plan = taken.payload
  const currentRules = runtime.config.effectiveRules()
  if (applyRulesFingerprint(currentRules) !== applyRulesFingerprint(plan.rules)) {
    return { ok: false, error: 'OpenWRT rules changed after the check - check again' }
  }
  const rules = plan.rules
  let inventory: RouterInventory
  try {
    inventory = await inspectRouter(runtime, plan.carrier, timeoutMs(rules))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!inventory.carrierExists) return { ok: false, error: `carrier ${plan.carrier} no longer exists` }
  for (const vlan of requestedVlans(plan.rows, plan.vlan)) {
    const conflict = vlanConflict(inventory, plan.carrier, vlan)
    if (conflict) return { ok: false, error: `${conflict} - check again` }
  }
  const data = runtime.store.read()
  if (data.batches.some((batch) => batch.name.toLowerCase() === plan.name.toLowerCase())) {
    return { ok: false, error: 'that batch name was taken after the check - check again' }
  }
  if (!rangeStillFree(plan, rules, data, inventory)) {
    return { ok: false, error: 'the checked interface/table range is no longer free - check again' }
  }

  const chunks = planPppoeChunks(plan.rows, {
    prefix: plan.prefix,
    carrier: plan.carrier,
    seqFrom: plan.seqFrom,
    tableBase: rules.tableBase,
    ...(plan.vlan === undefined ? {} : { vlan: plan.vlan })
  }, rules.uciChunkSize)
  const names = chunks.flatMap((chunk) => chunk.sections)
  const id = makeBatchId(new Set(data.batches.map((batch) => batch.id)))
  const batch: PppoeBatchRecord = {
    id,
    name: plan.name,
    prefix: plan.prefix,
    carrier: plan.carrier,
    ...(plan.vlan === undefined ? {} : { vlan: plan.vlan }),
    createdAt: Date.now(),
    count: plan.rows.length,
    seqFrom: plan.seqFrom,
    seqTo: plan.seqTo,
    // Where these sections are about to be written, recorded on the record
    // that will one day have to find them again. Read live instead, a later
    // edit to "Routing table base" would send delete looking for tables this
    // batch never used.
    layout: managedLayout(rules)
  }
  writeThrough(runtime, (host) => {
    host.batches.push(batch)
    host.nextSeq = Math.max(host.nextSeq, plan.seqTo + 1)
  })
  const managerGeneration = runtime.generation
  const firewallCancelled = (): boolean => managerGeneration !== runtime.generation

  /**
   * The shared zone as the store describes it right now.
   *
   * `existingOnly` leaves this batch out. Its record is written before the
   * job starts but its interfaces do not exist yet, and `networks` mode
   * rebuilds the whole membership list rather than appending to it - so the
   * pass that runs before the chunks has to list exactly what is on the
   * router, or every batch created earlier loses its zone for as long as
   * this job takes. The new prefix is still passed separately so the
   * wildcard glob is in place before the first interface appears.
   */
  const firewallPlanNow = (existingOnly: boolean): FirewallPlan => {
    const live = runtime.store.read()
    const batches = existingOnly
      ? live.batches.filter((entry) => entry.id !== id)
      : live.batches
    return buildFirewallPlan({
      zoneName: rules.zoneName,
      prefix: plan.prefix,
      prefixes: [...new Set([plan.prefix, ...batches.map((entry) => entry.prefix)])],
      mode: rules.zoneMode,
      networkSections: batches.flatMap(allBatchNames),
      chunkSize: rules.uciChunkSize,
      lanZone: runtime.service.lanFirewallZone?.() || 'lan'
    })
  }

  /**
   * Which half writes the sections.
   *
   * Read once, here, rather than per chunk: a create is one operation and it
   * must not write half its pool through one path and half through the other.
   *
   * Unlike binding, this is not a boundary that has to hold - there is nothing
   * for two writers to fight over, because netifd owns the sections whichever
   * half wrote them. It is a choice about cost and about credentials, so a
   * router whose agent fails mid-create simply fails the job, and running it
   * again on a router without the package writes the same sections the slow
   * way.
   */
  const capability = runtime.agent?.()
  const routerWrites = capability !== undefined && hasFeature(capability, 'pppoe')

  const jobItems: JobSpec['items'] = []
  jobItems.push({
    /**
     * First, not last. The zone, its masquerading and the LAN forwarding do
     * not depend on the interfaces existing, and running them last meant a
     * create that was cancelled - or that failed on chunk 7 of 10 - left
     * every session it had already dialed in no zone at all: up, addressed,
     * and unable to carry a single client packet.
     */
    name: `Prepare firewall zone ${rules.zoneName}`,
    run: async () => {
      try {
        await runFirewall(runtime, () =>
          applyFirewallPlan(runtime.ctx, firewallPlanNow(true), {
            timeoutMs: timeoutMs(rules),
            cancelled: firewallCancelled,
            onMutated: () => forceDump(runtime),
            verify: false
          })
        )
      } finally {
        forceDump(runtime)
      }
    }
  })

  /**
   * Which chunks reached `uci commit network`, recorded by the step that
   * performs the commit rather than inferred from how the job item ended. A
   * chunk that commits and then fails its `network reload` is committed:
   * its sections are on the router and the batch record has to keep
   * covering them.
   */
  const committed = new Set<number>()
  /**
   * The store this job may write to. A host change bumps the generation and
   * points `runtime.store` at another router, so a shrink after that point
   * would edit the wrong document. The record is left claiming the full
   * requested range instead - it may cover sections that never reached the
   * router, which delete tolerates, rather than miss sections that did.
   */
  const ownsStore = (): boolean => managerGeneration === runtime.generation

  if (routerWrites && capability) {
    jobItems.push({
      name: `Create ${plan.rows.length} PPPoE interfaces on the router`,
      run: async () => {
        const result = await poolCreate(
          { ctx: runtime.ctx, capability: () => capability },
          {
            id: routerPoolId(id),
            prefix: plan.prefix,
            carrier: plan.carrier,
            seqFrom: plan.seqFrom,
            tableBase: rules.tableBase,
            ...(plan.vlan === undefined ? {} : { vlan: plan.vlan })
          },
          // The one place in this module where a password is held in a variable
          // longer than a line. It goes from here into a 0600 file on the
          // router and nowhere else: not into the record, not into an event,
          // not into the job label, and not onto any command line on either
          // side of the connection.
          plan.rows.map((row) => ({
            user: row.user,
            pass: row.pass,
            ...(row.vlan === undefined ? {} : { vlan: row.vlan })
          }))
        )

        if (!result.ok) {
          throw new Error(result.error ?? 'the router refused to create the pool')
        }

        // Every chunk, in one step. The record already covers the whole range,
        // so `shrinkToCommitted` has nothing to shrink - which is correct: the
        // router wrote all of them or none.
        for (let index = 0; index < chunks.length; index++) committed.add(index)
        forceDump(runtime)
      }
    })
  }

  // The chunked path, unchanged and still the one most routers take. It is not
  // a fallback for the step above failing - a create either goes one way or the
  // other - it is what a router without the package does, which is every router
  // until somebody installs it.
  if (!routerWrites) {
    jobItems.push(...chunks.map((chunk, index): JobSpec['items'][number] => ({
    name: `Apply PPPoE chunk ${chunk.index}/${chunk.total} (${chunk.seqFrom}-${chunk.seqTo})`,
    run: async (cancelled) => {
      try {
        await runNetwork(runtime, () =>
          applyPppoeChunk(runtime.ctx, chunk, timeoutMs(rules), {
            onCommitted: () => committed.add(index),
            // The commit is a round trip, and the module can be disposed or
            // moved to another machine while it is in flight. The reload after
            // it would then be a command sent over a context the host has
            // already revoked - see `ownsStore` above, which is the same
            // question the shrink asks.
            stopped: () => !ownsStore()
          })
        )
      } catch (error) {
        // Shrink here rather than only in `onFinished`: the runner drops the
        // completion hook when the generation changed under it, and this is
        // the path where the record and the router are most likely to
        // disagree.
        if (ownsStore()) shrinkToCommitted(runtime, id, chunks, committed)
        throw error
      } finally {
        forceDump(runtime)
      }
      if (index + 1 < chunks.length && rules.chunkDelayMs > 0 && !cancelled()) {
        try {
          await waitCancelable(rules.chunkDelayMs, cancelled)
        } catch (error) {
          // The chunk is already committed/reloaded. Count it as successful;
          // the runner will mark later chunks cancelled.
          if (!(error instanceof UciCancelledError)) throw error
        }
      }
    }
    })))
  }

  jobItems.push({
    /**
     * Now that the interfaces exist: add them to the zone in `networks` mode,
     * reload, and check nft actually produced rules for the prefix. The check
     * belongs here rather than in the preparation step above, which runs
     * before there is anything for the zone to match.
     */
    name: `Register ${names.length} interfaces with the firewall`,
    run: async () => {
      let result: { warning?: string }
      try {
        result = await runFirewall(runtime, () =>
          applyFirewallPlan(runtime.ctx, firewallPlanNow(false), {
            timeoutMs: timeoutMs(rules),
            // A job cancels between items. Rebuilding shared membership is one
            // item and finishes after a user cancel so earlier batches are not
            // left half-removed. A host reset still stops it.
            cancelled: firewallCancelled,
            onMutated: () => forceDump(runtime)
          })
        )
      } finally {
        forceDump(runtime)
      }
      if (result.warning) {
        recordEvent(runtime, 'pppoe-firewall-warning', result.warning)
        // A step that reloaded the firewall and found no matching nft rule
        // used to be reported as a green "ok" carrying a note, so a pool
        // that could not actually reach the internet looked like a clean
        // create.
        return { warning: result.warning }
      }
    }
  })
  jobItems.push({
    name: `Verify ${names.length} PPPoE interfaces`,
    run: async () => {
      forceDump(runtime)
      await runtime.service.refreshNow?.()
      const visible = await visibleInterfaceCount(runtime, names, timeoutMs(rules))
      if (visible !== names.length) {
        throw new Error(`only ${visible}/${names.length} PPPoE interfaces appeared after reload`)
      }
    }
  })

  let job: OpenWrtJob
  // Before `start`, not inside it: the runner may begin the first item
  // synchronously, and a delete arriving in between would find no guard.
  runtime.creating.add(id)
  try {
    job = runtime.jobs.start({
      kind: 'pppoe-create',
      label: `Create batch ${batch.name} (${batch.count} connections)`,
      items: jobItems,
      onError: 'abort',
      onFinished: async (finished) => {
        // First thing in the hook, and before the awaits below: the batch is
        // no longer being written to, and the delete that was refused while
        // it ran has to become possible again even if the rest of this hook
        // throws.
        runtime.creating.delete(id)
        if (finished.state !== 'done') {
          // Cancelling stops the job between items, so no chunk closure runs
          // its failure path; this is the call that covers it. Shrinking is
          // idempotent, so the failed-chunk path having run first is fine.
          if (ownsStore()) shrinkToCommitted(runtime, id, chunks, committed)
          // The registration step never ran, so in `networks` mode the zone
          // still lists only what existed before this job: the connections
          // that did reach the router belong to no zone and would dial
          // without carrying traffic. `wildcard` mode needs nothing - its
          // device glob was installed by the preparation step and already
          // covers them.
          if (rules.zoneMode === 'networks') await restoreZoneMembership(runtime, rules)
        }
        forceDump(runtime)
        emitSummary(runtime)
        recordEvent(
          runtime,
          'pppoe-create',
          `Batch ${batch.name} create job ${finished.state} (${plan.rows.length} connections)`
        )
      }
    })
  } catch (error) {
    runtime.creating.delete(id)
    writeThrough(runtime, (host) => {
      host.batches = host.batches.filter((entry) => entry.id !== id)
    })
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  for (let index = 0; index < names.length; index++) {
    const user = plan.rows[index]?.user
    if (user !== undefined) runtime.usernames.set(names[index], user)
  }
  // The one username-cache write with no store write beside it, so it is also
  // the one the row cache cannot see. Without this the new batch's rows keep
  // the blank usernames they were built with until the next sample.
  clearRowCache(runtime)
  emitSummary(runtime)
  return { ok: true, data: job.id }
}

/**
 * Rebuild the shared zone from the batch records as they now stand, without
 * verifying: used after an interrupted create, where the step that would have
 * registered the new sections never ran. Failure is recorded rather than
 * thrown - this runs inside a completion hook, and the bookkeeping after it
 * matters more than this best-effort repair.
 */
async function restoreZoneMembership(runtime: PppoeRuntime, rules: PppoeRules): Promise<void> {
  if (!runtime.ctx.connected) return
  const batches = runtime.store.read().batches
  const first = batches[0]
  if (!first) return
  try {
    const plan = buildFirewallPlan({
      zoneName: rules.zoneName,
      prefix: first.prefix,
      prefixes: [...new Set(batches.map((entry) => entry.prefix))],
      mode: rules.zoneMode,
      networkSections: batches.flatMap(allBatchNames),
      chunkSize: rules.uciChunkSize,
      lanZone: runtime.service.lanFirewallZone?.() || 'lan'
    })
    await runFirewall(runtime, () =>
      applyFirewallPlan(runtime.ctx, plan, { timeoutMs: timeoutMs(rules), verify: false })
    )
    forceDump(runtime)
  } catch (error) {
    recordEvent(
      runtime,
      'pppoe-firewall-warning',
      `Could not restore ${rules.zoneName} zone membership after an interrupted create (${
        error instanceof Error ? error.message : String(error)
      }); the sessions that were created may not be in the zone`
    )
  }
}

/**
 * Cut an interrupted batch record down to the connections that actually
 * reached the router.
 *
 * `committed` is filled by `applyPppoeChunk` at the moment `uci commit
 * network` returns - not derived from job item status, which also folds in
 * the reload and the inter-chunk delay. A chunk that committed and then
 * failed to reload counts, or the record would stop covering a hundred live
 * sections that still hold their PPPoE passwords.
 *
 * Safe to call more than once: it only ever moves the record down, and stops
 * as soon as the record already ends at or below the last committed chunk.
 *
 * `nextSeq` is deliberately left alone: it is a high-water mark, and lowering
 * it would hand out sequence numbers a half-finished create may still own.
 */
function shrinkToCommitted(
  runtime: PppoeRuntime,
  id: string,
  chunks: readonly PppoeUciChunk[],
  committed: ReadonlySet<number>
): void {
  // Highest committed range, not the last committed chunk in array order:
  // `onError: 'abort'` makes a gap impossible today, and over-claiming is the
  // survivable direction if that ever changes.
  let lastOk: PppoeUciChunk | undefined
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    if (!chunk || !committed.has(index)) continue
    if (!lastOk || chunk.seqTo > lastOk.seqTo) lastOk = chunk
  }
  const names = chunks.flatMap((chunk) => chunk.sections)
  const batch = runtime.store.read().batches.find((entry) => entry.id === id)
  if (!batch) return
  if (!lastOk) {
    writeThrough(runtime, (host) => {
      host.batches = host.batches.filter((entry) => entry.id !== id)
    })
    for (const name of names) runtime.usernames.delete(name)
    runtime.ctx.log(`openwrt: batch ${batch.name} was dropped; no chunk reached the router`)
    return
  }
  if (lastOk.seqTo >= batch.seqTo) return
  const kept = lastOk.seqTo - batch.seqFrom + 1
  writeThrough(runtime, (host) => {
    const entry = host.batches.find((record) => record.id === id)
    if (!entry) return
    entry.count = kept
    entry.seqTo = lastOk.seqTo
  })
  for (const name of names.slice(kept)) runtime.usernames.delete(name)
  runtime.ctx.log(
    `openwrt: batch ${batch.name} shrunk to the ${kept} connection(s) that reached the router`
  )
}
