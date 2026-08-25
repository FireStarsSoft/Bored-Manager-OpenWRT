/**
 * The pass that runs on every fast sample, and after every action that could
 * have changed what the router should be doing.
 *
 * It plans each instance against one shared virtual copy of the rule table, so
 * two instances cannot both claim the same preference in the same tick, then
 * writes the difference in chunks. The kernel writes come first and the caches
 * only afterwards: a rule that failed to land must not be remembered as though
 * it had.
 */
import { recordLayout } from '../records'
import type { OwrtHostData } from '../store'
import type { RouterModel } from '../types'
import { parseCidr } from '../util'
import { recordEvents } from './events'
import { emptyPlannerMemory, normalizedMac } from './memory'
import { lanCidr, plannerPolicy, plannerWans, poolIfaces } from './pool'
import { planBindingReconciliation } from './planner'
import {
  applyRuleDiffInMemory,
  catchAllRoute,
  chunkRuleCommands,
  emptyRuleDiff
} from './rules'
import { ENGINE_STOPPED, currentWanTables, execScript, exclusive } from './runtime'
import { buildWanTableIndex } from './tables'
import { emitSnapshot, emptyDeviceSummary, emptyWanSummary } from './view'
import type {
  BindingRuntime,
  BindingStickyChoice,
  ReconcileOutcome
} from './types'

/**
 * Sticky timestamps are quantized to this window so a pool that is merely
 * still connected does not dirty hostData on every tick.
 */
const STICKY_TOUCH_MS = 10_000

/**
 * Slack on the uptime comparison, matching the fast sweep's own reboot test.
 * `ubus call system info` is read once per tick over SSH and its seconds are
 * whole, so two samples taken either side of a rounding boundary can come back
 * one lower without the router having gone anywhere.
 */
const REBOOT_SLACK_SEC = 5

export async function onSample(
  runtime: BindingRuntime,
  model: RouterModel,
  forceKernel = false
): Promise<void> {
  if (runtime.disposed) return
  await exclusive(runtime, async () => {
    if (runtime.disposed) return
    /**
     * A sample whose `ubus call system info` did not parse carries uptime 0,
     * and 0 is below every uptime there has ever been - so an unreadable
     * system section read as "the router just rebooted" and made the whole
     * engine re-apply every catch-all and reset every WAN error timer, on
     * every tick for as long as the section stayed unreadable. `FastSweep`
     * requires a positive uptime on both sides for the same reason.
     */
    const rebooted =
      runtime.lastUptime != null &&
      runtime.lastUptime > 0 &&
      model.sys.uptimeSec > 0 &&
      model.sys.uptimeSec + REBOOT_SLACK_SEC < runtime.lastUptime
    runtime.latestModel = model
    // Not overwritten with 0: an unreadable section says nothing about how
    // long the router has been up, and remembering it as zero would make the
    // next readable sample look like a reboot in the other direction.
    if (model.sys.uptimeSec > 0) runtime.lastUptime = model.sys.uptimeSec
    const error = await reconcileModel(runtime, model, {
      forceKernel: forceKernel || rebooted,
      rebooted
    })
    if (error && !runtime.disposed) {
      runtime.ctx.log(`openwrt: binding reconcile failed: ${error}`)
    }
  })
}

export async function reconcileModel(
  runtime: BindingRuntime,
  model: RouterModel,
  flags: { forceKernel: boolean; rebooted: boolean }
): Promise<string | null> {
  if (runtime.disposed) return ENGINE_STOPPED
  const rules = runtime.options.rules()
  const data = runtime.store.read()
  const instances = [...data.instances].sort(
    (a, b) => a.slot - b.slot || a.id.localeCompare(b.id)
  )
  const tables = buildWanTableIndex(
    model,
    data,
    rules,
    currentWanTables(runtime)
  )
  const virtualRules = model.rules.map((rule) => ({ ...rule }))
  const outcomes: ReconcileOutcome[] = []
  const assignmentDeletes: string[] = []
  const assignmentAdds: string[] = []
  const catchDeletes: string[] = []
  const catchAdds: string[] = []
  /**
   * The unreachable-default tables to (re)establish. Every instance normally
   * names the same one, but the number comes from each instance's own recorded
   * layout, so an instance created before the catch-all table was moved keeps
   * the table its rules actually point at.
   */
  const catchTables = new Set<number>()
  let repairCatchAll = flags.forceKernel

  for (const instance of instances) {
    const layout = recordLayout(instance, rules)
    const iface = model.ifaces.find((entry) => entry.name === instance.lan)
    const cidr = lanCidr(iface)
    if (!cidr) {
      outcomes.push({
        instance,
        result: {
          actual: [],
          desired: [],
          ruleDiff: emptyRuleDiff(),
          memory: runtime.memory.get(instance.id) ?? emptyPlannerMemory(),
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
      memory: runtime.memory.get(instance.id),
      policy: plannerPolicy(rules, layout),
      /**
       * Reseeded every tick, on purpose. The planner is a pure function of
       * its input and seeds its own PRNG from this number, so tests pass a
       * fixed seed and get a fixed plan; only this caller is random.
       *
       * That randomness is what spreads devices over the pool. The seed
       * drives one decision - `freeWans.takeRandom`, the WAN a device with no
       * sticky choice lands on - and a constant here would make every tick
       * walk the free list in the same order, so a router that reassigns a
       * few devices at a time would refill the same front WANs each time
       * rather than spread across them. Pinning it changes live behaviour,
       * not just test output.
       */
      randomSeed: Math.floor(Math.random() * 0x1_0000_0000),
      rebooted: flags.rebooted
    })
    outcomes.push({ instance, result })
    assignmentDeletes.push(...result.ruleDiff.deleteLines)
    assignmentAdds.push(...result.ruleDiff.addLines)
    applyRuleDiffInMemory(virtualRules, result.ruleDiff)

    const pref = layout.catchAllPrefBase + instance.slot
    const atPref = model.rules.filter((rule) => rule.pref === pref)
    const correct =
      atPref.length === 1 &&
      atPref[0]?.table === layout.catchAllTable &&
      parseCidr(atPref[0]?.from ?? '')?.cidr === cidr
    if (!correct) {
      repairCatchAll = true
      catchTables.add(layout.catchAllTable)
      for (let count = 0; count < atPref.length; count++) {
        catchDeletes.push(`ip -4 rule del pref ${pref} 2>/dev/null || true`)
      }
      catchAdds.push(
        `ip -4 rule add from ${cidr} lookup ${layout.catchAllTable} pref ${pref}`
      )
      for (const rule of [...virtualRules]) {
        if (rule.pref === pref) {
          virtualRules.splice(virtualRules.indexOf(rule), 1)
        }
      }
      virtualRules.push({
        pref,
        from: cidr,
        table: layout.catchAllTable
      })
    } else if (flags.forceKernel) {
      catchTables.add(layout.catchAllTable)
    }
  }

  try {
    if (repairCatchAll) {
      await execScript(
        runtime,
        [...catchTables].map((table) => catchAllRoute(table)),
        'repair binding catch-all'
      )
      for (const chunk of chunkRuleCommands(
        [...catchDeletes, ...catchAdds],
        rules.ruleChunkLines
      )) {
        await execScript(runtime, chunk, 'reconcile binding catch-all rules')
      }
    }
    const ruleLines = [...assignmentDeletes, ...assignmentAdds]
    for (const chunk of chunkRuleCommands(ruleLines, rules.ruleChunkLines)) {
      await execScript(runtime, chunk, 'reconcile binding rules')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Published, but not as this sample's answer. The rows below are the ones
    // the last good pass produced; stamping them with `model.t` made a page
    // show devices as bound, with a fresh staleness indicator, minutes after
    // their ip rules had been removed from the router.
    if (!runtime.disposed) emitSnapshot(runtime, model.t, message)
    return message
  }
  if (runtime.disposed) return ENGINE_STOPPED

  // Actions can run between fast samples. Reflect successful kernel writes in
  // the cached router model so Stop -> Start and Unassign -> Reassign do not
  // wait one extra tick on a stale rule snapshot.
  model.rules = virtualRules
  for (const outcome of outcomes) {
    runtime.memory.set(outcome.instance.id, outcome.result.memory)
    runtime.cache.set(outcome.instance.id, {
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
  syncSticky(runtime, outcomes, model.t)
  for (const outcome of outcomes) {
    recordEvents(runtime, outcome.instance, outcome.result.events)
  }
  emitSnapshot(runtime, model.t)
  return null
}

function syncSticky(
  runtime: BindingRuntime,
  outcomes: readonly ReconcileOutcome[],
  now: number
): void {
  if (runtime.disposed) return
  const data = runtime.store.read()
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
  const cap = Math.max(1, runtime.options.rules().stickyCap)
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
  runtime.store.update((draft) => {
    draft.stickyMap = selected
  })
}
