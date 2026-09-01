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
import { DirectEngine } from '../direct'
import { EventLog } from '../events'
import { Jobs } from '../jobs'
import { LimitsManager } from '../limits'
import { PppoeManager } from '../pppoe'
import { Queries } from '../queries'
import { ScanEngine } from '../scan'
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
  direct: DirectEngine
  scan: ScanEngine
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
  let direct!: DirectEngine
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
      if (!model) return
      await binding.onSample(model)
      // After the instance half, not before: both fold their own writes back
      // into `model.rules` so an action arriving between ticks plans against
      // what the router now holds, and the second one to run has to see the
      // first one's result. The two bands are disjoint, so this is about the
      // freshness of the snapshot rather than about who wins.
      await direct.onSample(model)
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
          waiting: total.waiting + instance.devices.waiting,
          // Charted beside `bound` and `waiting` because the three only mean
          // anything together: a queue that is growing while free WANs sit
          // unused is a different fault from one that is growing because the
          // pool is full, and the counters alone cannot tell them apart.
          wanFree: total.wanFree + instance.wan.available,
          // This pool's own failures, which is not what `wanErr` counts - that
          // is the PPPoE dialer's. A chart pairing free WANs with the dialer's
          // errors reads as a flat zero on a router whose binding carrier is a
          // DHCP uplink.
          wanErrBound: total.wanErrBound + instance.wan.error
        }),
        { bound: 0, waiting: 0, wanFree: 0, wanErrBound: 0 }
      )
    },
    directTotals() {
      return direct.totals()
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
    // Addresses a hand-placed one-to-one binding has already claimed. The
    // instance planner leaves them alone entirely - it does not seat them, does
    // not preserve a rule it finds for them and does not hold a WAN open for
    // one - because a device carrying both rules would read as bound to a WAN
    // its traffic never uses. Read per pass, like everything else here.
    reservedIps: () => {
      const model = service.latest
      return model ? direct.reservedIps(model) : []
    },
    // The routing-table audit belongs to the router, not to any one binding
    // instance, so it goes to the module ring rather than an instance's own.
    event: (kind: string, text: string) => events.record('router', kind, text)
  })

  direct = new DirectEngine({
    ctx,
    store,
    rules: () => config.effectiveRules(),
    jobs: guarded,
    agent: () => latch.capabilities.agent,
    wanTables: () => service.uciTables,
    latestModel: () => service.latest,
    requestDump: () => service.forceDumpNextTick(),
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
  latch = createCapabilityLatch(
    ctx,
    service,
    () => {
      if (store.read().instances.length > 0 || pppoe.poolCount() > 0) return true
      return ctx.streamActive('overview') || ctx.tabActive
    },
    // Read per probe rather than captured, because the Rules editor moves both
    // bands while the module is running - and a probe holding the shipped
    // defaults would report this module's own rules as competing ones.
    () => config.effectiveRules().rulePrefBase,
    () => config.effectiveRules().directPrefBase,
    // The monitor's own poller follows the same verdict, and is built just
    // below - so it is reached lazily, like the two automations above.
    () => scan.applyPollers()
  )
  // The monitor reads the router's whole rule table rather than the window the
  // collector filters to, which is the only way a rule somebody else wrote can
  // be seen at all. Everything it needs to tell those apart from this module's
  // own is handed to it as a closure, so it never holds a copy that could go
  // stale between scans.
  const scan = new ScanEngine({
    ctx,
    rules: () => config.effectiveRules(),
    latestModel: () => service.latest,
    direct: () => store.read().direct,
    instances: () => store.read().instances,
    assignments: () =>
      binding
        .snapshot()
        .instances.flatMap((instance) =>
          binding
            .rows(instance.id)
            .map((row) => ({ ip: row.ip, wan: row.wan, instance: instance.id }))
        ),
    // What the one-to-one pass actually has standing on the router, which is
    // not what the records and the leases say between them: a binding naming a
    // MAC keeps its rule at the last address it was seen at for the whole of
    // Lease release grace (s). Without this the monitor files that rule - at a
    // preference in this module's own band - under "written outside this
    // module" for the length of every grace, and tells the reader to go and
    // remove a rule this module owns and is about to withdraw itself.
    installed: () => direct.rows().map((row) => ({ id: row.id, ip: row.address })),
    capabilities: () => latch.capabilities
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
    direct,
    scan,
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
    direct: runtime.direct.snapshot(),
    monitor: runtime.scan.snapshot(),
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
  runtime.direct.reset()
  // The rows described one router's rule table, and nothing about them
  // survives the machine behind this context changing.
  runtime.scan.reset()
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
  runtime.direct.dispose()
  // Its own poller, so its own stop: the host's backstop only fires when the
  // module is deactivated, not when this context changes machine.
  runtime.scan.dispose()
  runtime.rules.clear()
  runtime.limits.clear()
  runtime.store.dispose()
  runtime.config.dispose()
}
