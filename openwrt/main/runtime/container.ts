/**
 * Where the domains are built and where they meet.
 *
 * Each of them - the collector, PPPoE, binding, setup, the editors - knows
 * nothing about the others; every one of them takes a small dependency object
 * instead, and this file is the only place those objects are written. That is
 * what keeps `pppoe/` free of any mention of `binding/` while the two still
 * cooperate, and it is why the wiring below reads like a list of promises the
 * module makes on each domain's behalf.
 *
 * Construction order matters in one place, marked where it happens: the two
 * automations refer to each other lazily because neither can exist first.
 */
import type { ModuleContext } from '@shared/modules'
import { AgentManager, guardedJobs } from '../agent'
import { BindingEngine } from '../binding'
import { ConfigStore, RulesEditor } from '../config'
import { EventLog } from '../events'
import { Jobs } from '../jobs'
import { LimitsManager } from '../limits'
import { PppoeManager } from '../pppoe'
import { Queries } from '../queries'
import { FastSweep } from '../service'
import { SetupManager } from '../setup'
import { HostStore, type OwrtHostData } from '../store'
import {
  createCapabilityLatch,
  disposeLatch,
  refreshCapabilities,
  resetLatch,
  type CapabilityLatch
} from './readiness'

export interface OpenWrtRuntime {
  ctx: ModuleContext
  config: ConfigStore
  agent: AgentManager
  store: HostStore
  events: EventLog<OwrtHostData>
  jobs: Jobs<OwrtHostData>
  service: FastSweep
  pppoe: PppoeManager
  binding: BindingEngine
  queries: Queries
  rules: RulesEditor
  setup: SetupManager
  limits: LimitsManager
  latch: CapabilityLatch
}

export function createRuntime(ctx: ModuleContext): OpenWrtRuntime {
  const config = new ConfigStore(ctx)
  const store = new HostStore(ctx, () => config.effectiveRules())
  const events = new EventLog<OwrtHostData>(ctx, store)
  const jobs = new Jobs<OwrtHostData>(ctx, store)

  let pppoe!: PppoeManager
  let binding!: BindingEngine
  let latch!: CapabilityLatch

  // Every job that changes the router's network configuration runs under the
  // router's own commit-confirm guard, and no domain knows about it: the
  // wrapper adds an item at each end of the spec, and a router with no agent -
  // or one too old to have the call - is handed straight through unchanged.
  //
  // Hoisted like the two automations above, and for the same reason: the
  // capability verdict is produced by the latch, the latch watches the
  // collector, and the collector is built from the domains that need this. The
  // closure is only ever called when a job starts, by which point all of them
  // exist.
  const guarded = guardedJobs(jobs, { ctx, capability: () => latch.capabilities.agent })
  const service = new FastSweep(ctx, config, store, {
    async onSample() {
      pppoe.onSample()
      const model = service.latest
      if (model) await binding.onSample(model)
    },
    async onSlowSample(sample) {
      // Only against a map the router answered for on this tick. The audit
      // repairs and refuses on the strength of what is missing from it, and a
      // probe that came back without its UCI section would have every managed
      // WAN missing and no conflict visible at all.
      if (sample.uciTablesOk) await binding.reconcileWanTables(sample.uciTables)
    },
    onRouterReboot() {
      events.record(
        'router',
        'reboot',
        'Router reboot detected; ip rules and bindings are reapplied on the next reconcile'
      )
    },
    bindingTotals() {
      return binding.snapshot().instances.reduce(
        (total, instance) => ({
          bound: total.bound + instance.devices.bound,
          waiting: total.waiting + instance.devices.waiting
        }),
        { bound: 0, waiting: 0 }
      )
    },
    pppoeTotals() {
      const latest = pppoe.latest
      return {
        total: latest.interfaces,
        up: latest.up,
        // The dashboard pie has no slice for `down`; a session netifd is not
        // actively dialling still belongs with the busy slice rather than
        // with the deliberate stops.
        dialing: latest.dialing + latest.down,
        error: latest.error,
        // Nor for `unwritten`: a member recorded and not written counts with
        // stopped so the slices keep adding up to the pool total. The PPPoE
        // page reports it separately, where it is worth acting on.
        stopped: latest.stopped + latest.unwritten
      }
    },
    pppoeRanges() {
      return pppoe.managedRanges()
    }
  })

  const sharedService = {
    forceDump: () => service.forceDumpNextTick(),
    refreshNow: () => service.run(),
    event: (kind: string, text: string) => events.record('pppoe', kind, text),
    // The one place the two automations meet. A binding instance running on the
    // same carrier is distributing LAN clients across this pool behind a
    // fail-closed catch-all, so deleting the pool would take the LAN down; the
    // PPPoE side cannot know that without asking. Read lazily - `binding` is
    // constructed just below.
    bindingCarriers: () => binding.carriers()
  }
  // The same verdict the binding engine reads, and read the same way: per
  // operation, never captured. It is not a preference any more: the daemon is
  // the only way pools are read or written, and a router without it gets a
  // readiness row saying to install it.
  pppoe = new PppoeManager(ctx, config, guarded, sharedService, () => latch.capabilities.agent)

  binding = new BindingEngine(ctx, store, {
    rules: () => config.effectiveRules(),
    jobs: guarded,
    // Which half binds. Read per pass, never captured: `bm-wanbind` arriving or
    // being removed lands between two readiness cycles, and the engine has to
    // change over on the next tick rather than on the next reconnect. Hoisted
    // like the two automations for the same reason - the latch is built from
    // the collector, which is built from these.
    agent: () => latch.capabilities.agent,
    wanTables: () => service.uciTables,
    requestDump: () => service.forceDumpNextTick(),
    // The routing-table audit belongs to the router, not to any one binding
    // instance, so it goes to the module ring rather than an instance's own.
    event: (kind: string, text: string) => events.record('router', kind, text)
  })

  const queries = new Queries(
    () => service.latest,
    () => service.uciTables,
    config,
    store
  )
  const rules = new RulesEditor(ctx, config, () => {
    // The records are per-machine, the rules are global. Read off a context
    // with no host - disconnected, or a machine entry that is not this router -
    // "no records" is not evidence that the router has none, so the lock has to
    // stay closed rather than open on a guess.
    if (!ctx.connected || ctx.hostKey == null) return 'unknown'
    return store.read().instances.length > 0 ? 'present' : 'none'
  })

  // Whether the fast sweep is worth its full rate on this router. Anything
  // automated here has to be reconciled every tick whether or not a surface is
  // open - a client bound to a WAN that just dropped stays off the internet
  // until the next sweep sees it - so the answer is simply yes. With neither
  // automation configured the sweep only feeds a dashboard, and a router nobody
  // is looking at was still being asked thirty times a minute, over SSH, for
  // every pooled machine the app is connected to. Re-read on every
  // applyPollers(), which the host already runs on each tab switch, connect and
  // settings change.
  latch = createCapabilityLatch(ctx, service, () => {
    if (store.read().instances.length > 0 || pppoe.poolCount() > 0) return true
    return ctx.streamActive('overview') || ctx.tabActive
  })
  const agent = new AgentManager({
    ctx,
    capabilities: () => latch.capabilities,
    agent: () => latch.capabilities.agent,
    reprobe: () => refreshCapabilities(latch),
    // The plain starter, not the guarded one. Installing a package is not a
    // network change the guard's snapshot could undo - it snapshots UCI, and
    // apk does not touch UCI - and the uninstall job takes a snapshot of its
    // own, which is the part that is actually worth having.
    jobs,
    event: (kind, text) => events.record('router', kind, text),
    // Read at the moment somebody asks, never captured: an instance can be
    // started between reading an uninstall report and pressing the button, and
    // the refusal exists precisely so that nothing is removed from underneath
    // one.
    // Instances from the stored records; pools from the daemon cache, which
    // is the only record of them this side holds. A router that has not been
    // fetched yet reports no pools, and the uninstall's own check re-reads
    // the router before anything is removed.
    blockers: () => {
      const data = store.read()
      return {
        instances: data.instances
          .filter((instance) => instance.running)
          .map((instance) => instance.name),
        batches: pppoe.poolNames()
      }
    }
  })

  const setup = new SetupManager(ctx, {
    capabilities: () => latch.capabilities,
    // The same call the rest of the module uses: it emits the new verdict and,
    // when the router just became usable, starts the collector.
    reprobe: () => refreshCapabilities(latch),
    jobs,
    event: (kind, text) => events.record('router', kind, text)
  })

  // The scale limits: read off the slow sweep, sized from what the two
  // automations are actually carrying, written by the agent when it is new
  // enough to own the write and over SSH when it is not.
  const limits = new LimitsManager({
    ctx,
    agentDeps: { ctx, capability: () => latch.capabilities.agent },
    current: () => ({ sysctl: service.sysctl, flowOffload: service.flowOffload }),
    scale: () => ({
      clients: service.latest?.leases.length ?? 0,
      sessions: pppoe.latest.interfaces
    }),
    afterApply: () => {
      void service.runSlow()
    }
  })

  return {
    ctx,
    config,
    agent,
    store,
    events,
    jobs,
    service,
    pppoe,
    binding,
    queries,
    rules,
    setup,
    limits,
    latch
  }
}

export function uiSnapshot(runtime: OpenWrtRuntime): { hintsOn: boolean } {
  return { hintsOn: runtime.config.read().ui.showHints }
}

export function emitUi(runtime: OpenWrtRuntime): void {
  runtime.ctx.emit('ui', uiSnapshot(runtime))
}

export function snapshots(runtime: OpenWrtRuntime): Record<string, unknown> {
  return {
    capabilities: runtime.latch.capabilities,
    ui: uiSnapshot(runtime),
    overview: runtime.service.overview,
    series: runtime.service.series,
    pppoe: runtime.pppoe.snapshot(),
    binding: runtime.binding.snapshot(),
    jobs: runtime.jobs.snapshot()
  }
}

/** Drop everything that described the machine this context just stopped pointing at. */
export function resetRuntime(runtime: OpenWrtRuntime): void {
  resetLatch(runtime.latch)
  // A token describes one router, and so does anything staged in its /tmp.
  void runtime.agent.reset()
  runtime.service.reset()
  // A token describes one router; the machine behind this context changed.
  runtime.setup.reset()
  runtime.jobs.reset()
  runtime.pppoe.reset()
  runtime.binding.reset()
  runtime.rules.clear()
  // A limits token froze values read off one router; the next one is not it.
  runtime.limits.clear()
  runtime.store.reset()
  runtime.config.reset()
  emitUi(runtime)
}

/**
 * The last thing that may touch `ctx`. Every poller, watcher and listener the
 * module opened is stopped here rather than left for the app to cut off, so a
 * deactivated module cannot keep hitting the target machine.
 */
export function disposeRuntime(runtime: OpenWrtRuntime): void {
  disposeLatch(runtime.latch)
  runtime.agent.dispose()
  runtime.events.dispose()
  runtime.service.dispose()
  runtime.setup.dispose()
  runtime.jobs.dispose()
  runtime.pppoe.dispose()
  runtime.binding.dispose()
  runtime.rules.clear()
  runtime.limits.clear()
  runtime.store.dispose()
  runtime.config.dispose()
}
