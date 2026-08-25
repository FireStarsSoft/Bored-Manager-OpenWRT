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
import { BindingEngine } from '../binding'
import { ConfigStore, RulesEditor } from '../config'
import { EventLog } from '../events'
import { Jobs } from '../jobs'
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
  store: HostStore
  events: EventLog<OwrtHostData>
  jobs: Jobs<OwrtHostData>
  service: FastSweep
  pppoe: PppoeManager<OwrtHostData>
  binding: BindingEngine
  queries: Queries
  rules: RulesEditor
  setup: SetupManager
  latch: CapabilityLatch
}

export function createRuntime(ctx: ModuleContext): OpenWrtRuntime {
  const config = new ConfigStore(ctx)
  const store = new HostStore(ctx, () => config.effectiveRules())
  const events = new EventLog<OwrtHostData>(ctx, store)
  const jobs = new Jobs<OwrtHostData>(ctx, store)

  let pppoe!: PppoeManager<OwrtHostData>
  let binding!: BindingEngine
  const service = new FastSweep(ctx, config, store, {
    async onSample(model) {
      pppoe.onSample(model)
      await binding.onSample(model)
    },
    async onSlowSample(sample) {
      pppoe.slowTick(sample.t)
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
      return pppoe.batches().reduce(
        (total, batch) => ({
          total: total.total + batch.count,
          up: total.up + batch.up,
          dialing: total.dialing + batch.dialing,
          error: total.error + batch.error,
          // The dashboard pie has no slice for a connection the router has no
          // interface for, nor for one nothing has been read about yet;
          // counting both as stopped keeps the slices adding up to the pool
          // total. The PPPoE page reports `missing` and `unknown` separately,
          // and it is the page where the difference is worth acting on.
          stopped: total.stopped + batch.stopped + batch.missing + batch.unknown
        }),
        { total: 0, up: 0, dialing: 0, error: 0, stopped: 0 }
      )
    }
  })

  const sharedService = {
    model: () => service.latest,
    forceDump: () => service.forceDumpNextTick(),
    refreshNow: () => service.run(),
    pppoeErrors: () => service.pppoeErrorSnapshot(),
    pppoeUsers: () => service.pppoeUserSnapshot(),
    // Read from the router's own firewall configuration by the slow probe. It
    // used to be the literal 'lan': on a router whose LAN zone is named
    // anything else, the forwarding was installed from a zone that does not
    // exist and every session in the pool dialed successfully and carried no
    // client traffic at all.
    lanFirewallZone: () => service.lanZone(),
    event: (kind: string, text: string) => events.record('pppoe', kind, text),
    // The one place the two automations meet. A binding instance running on the
    // same carrier is distributing LAN clients across this pool behind a
    // fail-closed catch-all, so deleting the pool would take the LAN down; the
    // PPPoE side cannot know that without asking. Read lazily - `binding` is
    // constructed just below.
    bindingCarriers: () => binding.carriers()
  }
  pppoe = new PppoeManager(ctx, config, store, jobs, sharedService)

  binding = new BindingEngine(ctx, store, {
    rules: () => config.effectiveRules(),
    jobs,
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
    const data = store.read()
    return data.batches.length > 0 || data.instances.length > 0 ? 'present' : 'none'
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
  const latch = createCapabilityLatch(ctx, service, () => {
    const data = store.read()
    if (data.batches.length > 0 || data.instances.length > 0) return true
    return ctx.streamActive('overview') || ctx.tabActive
  })
  const setup = new SetupManager(ctx, {
    capabilities: () => latch.capabilities,
    // The same call the rest of the module uses: it emits the new verdict and,
    // when the router just became usable, starts the collector.
    reprobe: () => refreshCapabilities(latch),
    jobs,
    event: (kind, text) => events.record('router', kind, text)
  })

  return {
    ctx,
    config,
    store,
    events,
    jobs,
    service,
    pppoe,
    binding,
    queries,
    rules,
    setup,
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
  runtime.service.reset()
  // A token describes one router; the machine behind this context changed.
  runtime.setup.reset()
  runtime.jobs.reset()
  runtime.pppoe.reset()
  runtime.binding.reset()
  runtime.rules.clear()
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
  runtime.events.dispose()
  runtime.service.dispose()
  runtime.setup.dispose()
  runtime.jobs.dispose()
  runtime.pppoe.dispose()
  runtime.binding.dispose()
  runtime.rules.clear()
  runtime.store.dispose()
  runtime.config.dispose()
}
