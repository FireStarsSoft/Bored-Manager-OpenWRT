/**
 * The tick: one fetch from the daemon per fast sample, and the two snapshots
 * every surface renders from.
 *
 * The cache is the whole trick of this domain, exactly as it is next door in
 * `pppoe/`. Every surface reads it synchronously and one fetch per tick
 * refreshes it over the connection the module already has, so a page repaints
 * without a round trip of its own and a router that stops answering keeps its
 * last answers with `stale` set - a table somebody can still read rather than
 * one that went blank at the exact moment they went looking for the reason.
 *
 * Nothing in this file writes to the router. Not one call here changes
 * anything, and there is no fall back to writing: from 3.4.0 the daemon owns
 * the instances, the bindings and every ip rule, and a module that wrote one
 * anyway is what the whole rearrangement exists to remove. A failed call means
 * the rows are one tick stale, and the snapshot says so.
 */
import {
  wanbindAssignmentsV2,
  wanbindBindingsV2,
  wanbindInfo,
  wanbindWaitingV2,
  type WanbindBindingsReply,
  type WanbindInfo
} from '../agent'
import { aggregateWans } from './pool'
import { bindingRows, countDirectTotals, instanceRows } from './rows'
import { agentDeps, daemonProblem, daemonReady, emptyCache } from './runtime'
import type {
  BindingRuntime,
  BindingSnapshot,
  BindingWanAggregate,
  DirectSnapshot,
  DirectTotals
} from './types'

/** How old the cache may be before a view-triggered read refetches, ms. */
const CACHE_TTL_MS = 2_000

/** The sentence a call that failed without one gets, so no surface shows ''. */
const NO_ANSWER = 'The router did not answer.'

/**
 * The first call in this tick that did not work.
 *
 * One sentence rather than a joined list: the three calls go to one daemon over
 * one connection, so when a second one fails it has almost always failed for
 * the reason the first did, and a panel reading "X. X. X." is three copies of
 * one fact taking the room the fact needed.
 */
function firstError(
  ...results: ReadonlyArray<{ ok: boolean; error: string | null } | null>
): string {
  for (const result of results) {
    if (result && !result.ok) return result.error ?? NO_ANSWER
  }
  return ''
}

/**
 * Whether anybody is unseated, which decides the third round trip.
 *
 * `waiting` and `held` are the queue and the devices somebody took out of it.
 * The last clause is the one that is not obvious and is not decoration: a
 * device the instance is deliberately leaving alone because a one-to-one
 * binding already decides its address is in neither counter, and it is in the
 * daemon's waiting list with the sentence explaining itself. Asking only about
 * the two counters left the hardest question on the page - "this device has a
 * lease, is on the LAN, and is in none of these tables; where is it?" -
 * answered by an empty table.
 */
function anybodyUnseated(info: WanbindInfo): boolean {
  return info.instances.some(
    (state) => state.waiting > 0 || state.held > 0 || state.devices > state.bound
  )
}

/**
 * Fetch the daemon's answers, once, whatever the number of callers.
 *
 * Three round trips on a router with anybody unseated and two on one without,
 * because `waiting` is the only call whose answer is usually empty and it is
 * the only one that can be skipped from another call's own counts. `info`,
 * `assignments` and `bindings` go together: they describe one moment, and
 * fetching them in series would have the instance table and the seats it counts
 * come from two different passes.
 *
 * A call that fails keeps the slice already in the cache. Rows that are one
 * tick old are worth far more than an empty table, because the table is what
 * somebody is looking at to work out why the router has gone quiet, and
 * blanking it answers that with "there is nothing on this router" - the one
 * thing this module must never say by accident.
 */
export function refreshCache(runtime: BindingRuntime, force = false): Promise<void> {
  if (runtime.fetching) return runtime.fetching
  if (!force && Date.now() - runtime.cache.fetchedAt < CACHE_TTL_MS) return Promise.resolve()

  const generation = runtime.generation

  const run = async (): Promise<void> => {
    if (!runtime.ctx.connected) {
      // Stale, not empty, and only once there is something to be stale about:
      // these are still this router's rows, and they become right again the
      // moment it answers. Emptying them would report a disconnected machine as
      // a router with no binding on it.
      if (runtime.cache.fetchedAt) {
        runtime.cache.stale = true
        runtime.cache.error = 'The router is not connected.'
      }
      return
    }

    if (!daemonReady(runtime)) {
      // No daemon is not staleness: there is nothing to be stale about, and the
      // rows that were here belong to a router that has since had the package
      // removed or replaced. The sentence goes on the snapshot's `daemon`
      // field, which is the only thing that can tell an empty table on a router
      // with no instances from one on a router with no daemon to have any.
      runtime.cache = emptyCache()
      return
    }

    const deps = agentDeps(runtime)
    const [info, assignments, bindings] = await Promise.all([
      wanbindInfo(deps),
      wanbindAssignmentsV2(deps),
      wanbindBindingsV2(deps)
    ])

    if (generation !== runtime.generation) return

    if (!info.ok || !info.data) {
      // `info` is the one call the rest is built around - the instance rows,
      // the per-instance warning thresholds, and the decision about the third
      // round trip all come from it - so without it there is no tick, and
      // whatever the other two returned describes a router this module could
      // not otherwise account for.
      runtime.cache.stale = true
      runtime.cache.error = info.error ?? NO_ANSWER
      return
    }

    // Asked of the reply rather than of the cache, which is not fussiness: the
    // cache is not replaced until every call is in, so writing this answer into
    // it first would leave a surface reading between the two awaits a set of
    // fresh counts under the previous tick's timestamp.
    const waiting = anybodyUnseated(info.data) ? await wanbindWaitingV2(deps) : null

    if (generation !== runtime.generation) return

    runtime.cache = {
      info: info.data,
      assignments:
        assignments.ok && assignments.data
          ? assignments.data.assignments
          : runtime.cache.assignments,
      // An empty list rather than the previous one when the call was skipped:
      // it was skipped precisely because the daemon says nobody is unseated,
      // which makes empty the answer rather than the absence of one.
      waiting: waiting
        ? waiting.ok && waiting.data
          ? waiting.data.waiting
          : runtime.cache.waiting
        : [],
      bindings: bindings.ok && bindings.data ? bindings.data : runtime.cache.bindings,
      fetchedAt: Date.now(),
      stale: false,
      error: firstError(assignments, bindings, waiting)
    }
  }

  const fetching = run()
    .catch((error) => {
      if (generation !== runtime.generation) return
      runtime.cache.stale = true
      runtime.cache.error = error instanceof Error ? error.message : String(error)
    })
    .finally(() => {
      if (runtime.fetching === fetching) runtime.fetching = null
    })

  runtime.fetching = fetching
  return fetching
}

// ------------------------------------------------------------------ snapshots

/**
 * Whether this router keeps its own WAN Binding, as the page has to read it.
 *
 * Gated on the connection because a machine nobody is talking to has no verdict
 * about it: `bindingDaemonProblem` would answer for the empty capability and
 * the page would open on "there is no binding daemon on this router" about a
 * router that has not been asked. The empty problem is what `runtime.ts` uses
 * for "not looked yet", and this is the other place that state is real.
 */
function daemonState(runtime: BindingRuntime): { ready: boolean; problem: string } {
  if (!runtime.ctx.connected) return { ready: false, problem: '' }
  const ready = daemonReady(runtime)
  return { ready, problem: ready ? '' : daemonProblem(runtime) }
}

/**
 * Something the operator has to be told that is not a failed call.
 *
 * Both of these are a router answering perfectly and disagreeing, which is why
 * they are not `lastError`: folding them in would have the page's error panel
 * report silence from a router that is talking. The switched-off half comes
 * first because it explains every other number on the page at once - no client
 * is being seated, and every instance reads `stopped` for one reason rather
 * than for its own.
 */
function bindingNotice(runtime: BindingRuntime): string {
  const info = runtime.cache.info
  if (!info) return ''
  if (!info.enabled && info.configured.length > 0) {
    return 'The instance half of the router\'s binding daemon is switched off, so no client is being seated. One-to-one bindings are still maintained.'
  }
  const refused = info.configured.filter((config) => !config.usable).length
  if (refused > 0) {
    return refused === 1
      ? 'The router refused one instance; its row says why.'
      : `The router refused ${refused} instances; each row says why.`
  }
  return ''
}

/**
 * The same for the one-to-one half, and the first line is the one that stops
 * work rather than merely describing it: while the band is unusable the daemon
 * will not allocate a priority, so every create is going to be refused after
 * somebody has typed an address into a form.
 */
function directNotice(runtime: BindingRuntime): string {
  const reply = runtime.cache.bindings
  if (!reply) return ''
  if (!reply.band.usable) {
    return `The router will not allocate one-to-one rule priorities: ${reply.band.reason ?? 'it did not say why'}`
  }
  if (!reply.maintained) {
    return 'The router is not maintaining one-to-one bindings, so the rows below are sections rather than rules in force.'
  }
  const core = runtime.cache.info?.core
  return core && !core.ready && core.reason ? core.reason : ''
}

/**
 * Build the instance half's payload and keep it on the runtime.
 *
 * `t` is the cache's own timestamp rather than the moment this ran, which is
 * the whole reason it lives on the cache: a failed fetch leaves it where it
 * was, and stamping these rows with the time of the failure would make the
 * staleness indicator report fresh data about a router that has moved on.
 *
 * `hookOk` is false for a partial answer as readily as for a total one. Two of
 * the three calls landing is still a call that failed, and the rows built from
 * the third are the previous tick's.
 *
 * No clock is taken. Nothing on an instance row counts from a moment - the
 * durations are all in the drawer tables and the one-to-one rows - so a `now`
 * here would only be a second timestamp for one tick to be inconsistent about.
 */
export function bindingSnapshot(runtime: BindingRuntime): BindingSnapshot {
  const cache = runtime.cache
  const rows = instanceRows(cache.info, runtime.service.latestModel(), cache.assignments)
  const notice = bindingNotice(runtime)
  runtime.latestBinding = {
    t: cache.fetchedAt,
    hookOk: !cache.stale && cache.error === '',
    lastError: cache.error,
    rows,
    wans: aggregateWans(rows.map((row) => row.wan)),
    daemon: daemonState(runtime),
    // Omitted rather than sent empty: the page's only test for "is there
    // anything to say here" is `exists`, which an empty string passes - and a
    // note with a blank sentence under it is worse than no note.
    ...(notice ? { notice } : {})
  }
  return runtime.latestBinding
}

export function directSnapshot(
  runtime: BindingRuntime,
  now = Date.now()
): DirectSnapshot {
  const cache = runtime.cache
  const rows = bindingRows(cache.bindings, now)
  const notice = directNotice(runtime)
  runtime.latestDirect = {
    t: cache.fetchedAt,
    hookOk: !cache.stale && cache.error === '',
    lastError: cache.error,
    rows,
    totals: countDirectTotals(rows),
    ...(notice ? { notice } : {})
  }
  return runtime.latestDirect
}

/**
 * Push both payloads on the two streams the pages already listen on.
 *
 * Emitted together, because the instance table and the one-to-one table are two
 * halves of one router: they are built from one cache and a tick that sent one
 * without the other would show a seat and the binding reserving its address as
 * belonging to different moments.
 */
export function emitSnapshots(runtime: BindingRuntime): void {
  runtime.ctx.emit('binding', bindingSnapshot(runtime))
  runtime.ctx.emit('direct', directSnapshot(runtime))
}

/**
 * Called after the fast sweep replaced its model: refresh from the daemon in
 * the background and emit when it lands.
 *
 * The second emit goes out immediately as well, so a `stale` flip is never held
 * back by a fetch that hangs - the page learns the router stopped answering at
 * the tick it stopped, not at the tick the timeout expired.
 */
export function onSample(runtime: BindingRuntime): void {
  void refreshCache(runtime).then(() => emitSnapshots(runtime))
  emitSnapshots(runtime)
}

// ------------------------------------------------------------- what others ask

/** Every instance's pool as one set of counts; see `BindingWanAggregate`. */
export function totals(runtime: BindingRuntime): BindingWanAggregate {
  return runtime.latestBinding.wans
}

export function directTotals(runtime: BindingRuntime): DirectTotals {
  return runtime.latestDirect.totals
}

/** Which line one device leaves by, and whose doing that is. */
export interface BindingDeviceView {
  wan: string
  /** Empty for an address a hand-placed binding decides; see `deviceView`. */
  instanceId: string
  instanceName: string
}

/**
 * Address -> the WAN it leaves by, for the dashboard's device table.
 *
 * Both halves, keyed by address, because the question that table asks of every
 * lease is "which line does this device use" and a hand-bound device uses one.
 * It used to be answered by reading the ip rules back out of the sweep and
 * filtering them to the instance band, which meant a one-to-one binding showed
 * as no WAN at all - and on 3.4.0 there are no rules of this module's to read
 * anyway.
 *
 * A manual binding's `instanceId` is empty and that is load-bearing rather than
 * missing: the row offers Reassign and Unassign from it, and both are
 * meaningless for an address somebody pinned by hand. Derived seats are left to
 * the assignments, which name their instance and win any address the two
 * somehow both claim.
 */
export function deviceView(runtime: BindingRuntime): Map<string, BindingDeviceView> {
  const names = new Map<string, string>()
  for (const config of runtime.cache.info?.configured ?? []) {
    names.set(config.id, config.name || config.id)
  }

  const view = new Map<string, BindingDeviceView>()
  for (const binding of runtime.cache.bindings?.bindings ?? []) {
    // Enabled and on an address, whatever state it is in. A held binding still
    // decides where that device goes - nowhere - and reporting it as unbound
    // would put it back among the devices nothing has claimed.
    if (binding.source !== 'manual' || !binding.enabled || !binding.ip) continue
    view.set(binding.ip, { wan: binding.wan, instanceId: '', instanceName: '' })
  }
  for (const seat of runtime.cache.assignments) {
    if (!seat.ip) continue
    view.set(seat.ip, {
      wan: seat.wan,
      instanceId: seat.instance,
      instanceName: names.get(seat.instance) ?? seat.instance
    })
  }
  return view
}

/**
 * What the rule monitor needs to tell this module's own rules from everybody
 * else's.
 *
 * All three lists are the router's own answers rather than anything kept here,
 * which is the point: this module holds no record of an instance or a binding
 * any more, so a monitor working from records would have called every rule the
 * daemon wrote a foreign one - in this module's own voice, about its own
 * daemon's work, with advice to go and remove it.
 */
export interface BindingMonitorInput {
  /** Each instance's priority band and catch-all, as the daemon allocated it. */
  instances: WanbindBindingsReply['instances']
  /** The one-to-one rules the daemon is holding, with the address each is on. */
  bindings: Array<{ id: string; name: string; wan: string; ip: string; pref: number }>
  /** Every address an instance has seated, and where. */
  assignments: Array<{ ip: string; wan: string; instance: string }>
}

export function monitorInput(runtime: BindingRuntime): BindingMonitorInput {
  const reply = runtime.cache.bindings
  return {
    instances: reply?.instances ?? [],
    bindings: (reply?.bindings ?? [])
      // A rule the daemon has actually written: an address, and a priority it
      // managed to allocate. A refused or disabled section holds nothing, and
      // claiming its address would have the monitor attribute somebody else's
      // rule on that address to this module.
      .filter((binding) => binding.enabled && binding.ip && binding.pref > 0)
      .map((binding) => ({
        id: binding.id,
        name: binding.name || binding.id,
        wan: binding.wan,
        ip: binding.ip,
        pref: binding.pref
      })),
    assignments: runtime.cache.assignments
      .filter((seat) => seat.ip)
      .map((seat) => ({ ip: seat.ip, wan: seat.wan, instance: seat.instance }))
  }
}
