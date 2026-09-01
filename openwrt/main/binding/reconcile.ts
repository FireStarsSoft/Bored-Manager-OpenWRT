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
import { hasFeature, wanbindFlush, wanbindReconcile, wanbindSection } from '../agent'
import { recordLayout } from '../records'
import type { OwrtHostData } from '../store'
import type { RouterModel } from '../types'
import { catchAllCidrs, lanLocalRoute } from './catch-all'
import { recordEvents } from './events'
import { emptyPlannerMemory, normalizedMac } from './memory'
import { lanCidr, plannerPolicy, plannerWans, poolIfaces } from './pool'
import { planBindingReconciliation } from './planner'
import {
  applyRuleDiffInMemory,
  catchAllRoute,
  chunkRuleCommands,
  emptyRuleDiff,
  ruleCidr
} from './rules'
import { routerSample } from './router'
import { ENGINE_STOPPED, currentWanTables, execScript, exclusive } from './runtime'
import { syncRouterInstances } from './sync'
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

/**
 * Which half does this pass, asked once per tick.
 *
 * The verdict is read here rather than captured anywhere, because an `apk del`
 * or an `apk add` lands between one readiness cycle and the next: this is what
 * makes the changeover a tick rather than a reconnect.
 *
 * The two are exclusive and must stay that way. With `bm-wanbind` running, the
 * router owns the ip rule priority range; this engine planning against it as
 * well would be two writers with two ideas of the truth, which is worse than
 * either being wrong on its own. So a router-side pass that fails publishes the
 * reason and stops - it does not fall back. The only fall back is the verdict
 * itself saying the router is not binding.
 */
async function pass(
  runtime: BindingRuntime,
  model: RouterModel,
  flags: { forceKernel: boolean; rebooted: boolean }
): Promise<string | null> {
  const capability = runtime.options.agent?.()

  if (capability && hasFeature(capability, 'binding')) {
    const failed = await routerSample(
      runtime,
      { ctx: runtime.ctx, capability: () => capability },
      model
    )
    if (failed && !runtime.disposed) emitSnapshot(runtime, model.t, failed)
    return failed
  }

  return reconcileModel(runtime, model, flags)
}

/**
 * The same choice, for a change this module just made.
 *
 * `pass` is for a sweep; this is for Start, Stop, Delete and Apply, and it
 * exists because those used to call `reconcileModel` unconditionally. On a
 * router running `bm-wanbind` that is the second writer the whole boundary is
 * built to prevent: the fast sweep reads `ip -4 rule show` whether or not the
 * agent is there, so the daemon's own rules arrive as this instance's "actual",
 * and stopping an instance planned a `rule del` for every one of them.
 *
 * On the router-owned half the work is not skipped, it is handed over: write
 * the sections, tell the service, and ask for a pass now rather than waiting
 * for its timer.
 *
 * `flushInstanceId` is for Stop and Delete, and the order it implies is the
 * point. The daemon drops a disabled instance when it loads its config and
 * does not remove its rules on the way past, so an instance switched off after
 * the reload would leave every client bound to a table nothing maintains. The
 * flush therefore happens first, while the daemon still has the instance.
 */
/**
 * Whether this tick's binding work belongs to the router rather than to us.
 *
 * The way out of a broken state depends on the answer. On the router-owned half
 * the flush inside `applyChange` is the only thing that takes an instance's
 * rules off, so a failure there has to stop a Stop or a Delete - dropping the
 * record would strand every rule the daemon had written. On the SSH half it is
 * the opposite: the instance's own catch-all is removed by an explicit command
 * afterwards, and the rest of what `reconcileModel` does is other instances'
 * business. Letting that fail a Delete is how a router ends up carrying a
 * record nothing can remove.
 */
export function routerOwnsBinding(runtime: BindingRuntime): boolean {
  const capability = runtime.options.agent?.()
  return !!capability && hasFeature(capability, 'binding')
}

export async function applyChange(
  runtime: BindingRuntime,
  model: RouterModel,
  flags: { forceKernel: boolean; rebooted: boolean },
  options: { flushInstanceId?: string } = {}
): Promise<string | null> {
  const capability = runtime.options.agent?.()
  if (!capability || !hasFeature(capability, 'binding')) {
    return reconcileModel(runtime, model, flags)
  }

  const deps = { ctx: runtime.ctx, capability: () => capability }

  try {
    if (options.flushInstanceId) {
      const flushed = await wanbindFlush(deps, wanbindSection(options.flushInstanceId))
      if (!flushed.ok) {
        return flushed.error ?? 'the router would not take this instance\'s rules off'
      }
    }

    const synced = await syncRouterInstances(runtime, capability)
    if (synced.skipped) return `the router's instance list was not updated: ${synced.skipped}`

    // Best effort, and deliberately not checked. The daemon reconciles on its
    // own timer anyway, so a refused pass costs a few seconds rather than
    // correctness - and failing a Start that did start would be reporting the
    // wrong thing.
    await wanbindReconcile(deps)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

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
    const error = await pass(runtime, model, {
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
  // Asked once for the whole pass rather than per instance: the answer is a
  // fact about the router, and reading it twice inside one tick could seat an
  // address in one instance that a later instance was told to leave alone.
  const reservedIps = runtime.options.reservedIps?.() ?? []
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
  /**
   * The catch-all repair, one entry per instance that needs one, each holding
   * that instance's deletes followed by its own adds.
   *
   * They are kept apart rather than flattened into one deletes-then-adds list
   * because every chunk below is a separate `execScript`, and therefore a
   * separate round trip to the router. Flattened, a chunk boundary could fall
   * between one instance's deletes and its adds - and for as long as that round
   * trip was in flight that instance had no catch-all standing at all, so its
   * unassigned clients leaked onto the router's default WAN, which is the one
   * thing the catch-all exists to prevent. A range instance repairs several
   * blocks at one preference instead of a single rule, which is what made the
   * group wide enough for a boundary to land inside it.
   */
  const catchGroups: string[][] = []
  /**
   * The unreachable-default tables to (re)establish. Every instance normally
   * names the same one, but the number comes from each instance's own recorded
   * layout, so an instance created before the catch-all table was moved keeps
   * the table its rules actually point at.
   */
  const catchTables = new Set<number>()
  /**
   * The connected routes that keep the router answering on the LANs it is
   * blackholing, deduplicated because several instances share one table.
   * Written whenever the blackhole beside them is, so the two never exist apart.
   */
  const catchLocalRoutes = new Set<string>()
  /**
   * What each instance's connected route will be once the commands below land,
   * folded into `runtime.lanRoutes` only after they have. Remembering it any
   * earlier is remembering a route the repair below then believes is standing
   * and is not.
   */
  const routeWrites = new Map<string, string>()
  let repairCatchAll = flags.forceKernel

  for (const instance of instances) {
    const layout = recordLayout(instance, rules)
    const iface = model.ifaces.find((entry) => entry.name === instance.lan)
    const cidr = lanCidr(iface)
    if (!cidr) {
      // Nothing was written and nothing can be, so nothing is remembered
      // either: a LAN that comes back has to have its connected route put in
      // again, and a stale entry saying it is already there is what would stop
      // that happening.
      runtime.lanRoutes.delete(instance.id)
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
      reservedIps,
      // Only a range instance carries one; the planner reads an absent range as
      // "the whole LAN", which is what every instance written before ranges
      // existed means.
      ...(instance.source?.kind === 'range'
        ? { range: { from: instance.source.from, to: instance.source.to } }
        : {}),
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
    const wanted = catchAllCidrs(instance, cidr)
    const atPref = model.rules.filter((rule) => rule.pref === pref)
    /**
     * One preference now holds a group of rules rather than a single one - the
     * kernel is happy to carry several at the same priority, and the existing
     * `while ip -4 rule del pref N` removal already takes a whole group off - so
     * the comparison is a set: every wanted block present exactly once, all of
     * them on the catch-all table, and nothing else sharing the preference.
     *
     * Sorted before it is compared because `ip rule show` is under no
     * obligation to hand a same-priority group back in the order it was
     * written; compared positionally, a router that reordered them would have
     * had its catch-all torn down and rebuilt on every fast tick.
     *
     * Read through `ruleCidr` and not `parseCidr` because the kernel prints a
     * /32 selector without its prefix, and a range that ends in a /32 - which
     * most of them do - would otherwise never match what it was written with,
     * for exactly the same for-ever rebuild the sort above prevents.
     */
    const present = atPref
      .map((rule) => (rule.table === layout.catchAllTable ? ruleCidr(rule.from) : ''))
      .sort()
    const correct =
      present.length === wanted.length &&
      present.join(' ') === [...wanted].sort().join(' ')
    /**
     * The connected route is not in `ip -4 rule show`, so nothing in the sample
     * can say whether it is still there - which is why what this module last
     * saw land is remembered instead, and why a difference is enough to write
     * it again.
     *
     * It goes missing on its own. The kernel drops every route whose device
     * goes down, in every table, and the LAN device goes down for reasons that
     * have nothing to do with binding: a `service network reload` recreates a
     * VLAN netdev, restarting wifi takes a wireless-only LAN's device with it,
     * a bridge with no carrier goes down when the last port is unplugged. The
     * `unreachable default` beside it has no device and survives all three, so
     * the router was left blackholing its own LAN - no SSH, no DHCP answers, no
     * ARP - until a reboot or an unrelated rule mismatch happened to rebuild
     * the group. Comparing only the rules, this pass saw a correct catch-all
     * and wrote nothing, for ever.
     */
    const localRoute = lanLocalRoute(iface, cidr, layout.catchAllTable)
    // A sample that names no device for this LAN ends the belief along with it:
    // whatever was written is for a device this router is no longer describing,
    // and remembering it would be what stops the route going back in when the
    // device is named again.
    if (!localRoute) runtime.lanRoutes.delete(instance.id)
    const routeStale = localRoute !== '' && runtime.lanRoutes.get(instance.id) !== localRoute
    if (!correct || routeStale || flags.forceKernel) {
      repairCatchAll = true
      catchTables.add(layout.catchAllTable)
      if (localRoute) {
        catchLocalRoutes.add(localRoute)
        routeWrites.set(instance.id, localRoute)
      }
    }
    if (!correct) {
      const group: string[] = []
      for (let count = 0; count < atPref.length; count++) {
        group.push(`ip -4 rule del pref ${pref} 2>/dev/null || true`)
      }
      for (const block of wanted) {
        group.push(
          `ip -4 rule add from ${block} lookup ${layout.catchAllTable} pref ${pref}`
        )
      }
      catchGroups.push(group)
      for (const rule of [...virtualRules]) {
        if (rule.pref === pref) {
          virtualRules.splice(virtualRules.indexOf(rule), 1)
        }
      }
      for (const block of wanted) {
        virtualRules.push({
          pref,
          from: block,
          table: layout.catchAllTable
        })
      }
    }
  }

  try {
    if (repairCatchAll) {
      await execScript(
        runtime,
        [...[...catchTables].map((table) => catchAllRoute(table)), ...catchLocalRoutes],
        'repair binding catch-all'
      )
      // Only now, and only for the instances whose line was in that command.
      for (const [id, line] of routeWrites) runtime.lanRoutes.set(id, line)
      // Chunked per instance, so the cap still bounds how long a single command
      // is without ever putting one instance's deletes and adds on either side
      // of a round trip. An instance whose own group is wider than the cap is
      // split anyway - there is no way to send more lines than the router will
      // take at once - but that is one instance's exposure rather than every
      // instance planned after the boundary.
      for (const group of catchGroups) {
        for (const chunk of chunkRuleCommands(group, rules.ruleChunkLines)) {
          await execScript(runtime, chunk, 'reconcile binding catch-all rules')
        }
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
