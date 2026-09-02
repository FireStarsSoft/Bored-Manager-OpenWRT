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
import { BindingManager } from '../wanbind'
import { ConfigStore, RulesEditor } from '../config'
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
  binding: BindingManager
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
  let binding!: BindingManager
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
    onSample() {
      pppoe.onSample()
      // One read of the router, and nothing written back into the sample.
      //
      // The two halves this replaced each folded their own rule writes into
      // `model.rules` so that whichever ran second planned against what the
      // router now held. Neither writes any more - the daemon owns every rule -
      // so there is nothing to fold and no ordering to get right.
      binding.onSample()
    },
    onRouterReboot() {
      events.record(
        'router',
        'reboot',
        'Router reboot detected; bm-wanbind reapplies its rules on its next pass'
      )
    },
    bindingTotals() {
      return binding.list().reduce(
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
      return binding.directTotals()
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

  // One object for both halves of WAN Binding, because on the router they are
  // one thing: an instance is a generator of the same address-to-table bindings
  // somebody places by hand. Two engines here would be two caches of one
  // daemon, able to disagree about the same router between ticks.
  //
  // The capability is read per call and never captured, exactly as the pool
  // manager reads its own: `bm-wanbind` arriving or being removed lands between
  // two readiness cycles, and that is what makes the changeover a tick rather
  // than a reconnect.
  binding = new BindingManager(
    ctx,
    config,
    guarded,
    {
      forceDump: () => service.forceDumpNextTick(),
      latestModel: () => service.latest,
      // The router's own events, not any one instance's: which half of the
      // router a change belongs to is the daemon's business now, and this ring
      // is what a page shows when it asks what happened while nobody looked.
      event: (kind: string, text: string) => events.record('router', kind, text)
    },
    store,
    () => latch.capabilities.agent
  )

  const queries = new Queries(
    () => service.latest,
    () => service.uciTables,
    config,
    store
  )
  // No topology lock any more, and nothing to lock. The settings this editor
  // holds were once the priority bands the rules on the router had been written
  // against, so moving one under a live instance made the next pass fail to
  // recognise its own work. Those numbers belong to the daemon now and are
  // edited on Connection, under WAN Binding; what is left here is this module's
  // own housekeeping, which no rule on any router was written against.
  const rules = new RulesEditor(ctx, config)

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
      if (binding.instanceCount() > 0 || pppoe.poolCount() > 0) return true
      return ctx.streamActive('overview') || ctx.tabActive
    },
    // Read off the daemon rather than out of this module's settings, because
    // they are the daemon's numbers now: a probe holding the shipped defaults
    // on a router whose bands had been moved would report the daemon's own
    // rules as competing ones, which is the readiness card telling somebody to
    // go and remove the thing that is working.
    () => binding.settings().rule_pref_base,
    () => binding.settings().direct_pref_base,
    // The monitor's own poller follows the same verdict, and is built just
    // below - so it is reached lazily, like the two automations above.
    () => scan.applyPollers()
  )
  // The monitor asks the daemon for the router's whole rule table rather than
  // the window the collector filters to, which is the only way a rule somebody
  // else wrote can be seen at all - and it asks rather than works it out,
  // because the daemon is the half that knows which sections exist and which
  // priority bands they own. Two classifiers would be two answers about one
  // rule.
  const scan = new ScanEngine({
    ctx,
    rules: () => config.effectiveRules(),
    agent: () => latch.capabilities.agent,
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
    // Both halves are read off the router, and both are read *now* rather
    // than out of whatever the last page left behind.
    //
    // Neither list is this module's own record any more - instances live in
    // /etc/config/bm_wanbind and pools in the pool daemon - so the cache
    // backing them is filled by a page nobody need have opened. Answering from
    // a cold one said "nothing is running" about a router carrying a live
    // instance, and the check that exists to stop `apk del` under one let it
    // through. Two fetches on the one screen where somebody is about to remove
    // packages is not a cost worth optimising.
    blockers: async () => {
      await Promise.all([binding.refresh(), pppoe.refresh()])
      return {
        instances: binding.runningInstanceNames(),
        batches: pppoe.poolNames(),
        // These live in the router's own configuration and nowhere else. That
        // is the whole shape of this release and it has one cost, which lands
        // exactly here: `apk del bm-wanbind` takes the sections with it and
        // this module cannot put them back, because it keeps no copy -
        // two records of one binding is the state nothing can reason about. So
        // the names have to reach the uninstall check, which is the mitigation.
        bindings: binding.directNames()
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
    direct: runtime.binding.directSnapshot(),
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
  // Its own poller, so its own stop: the host's backstop only fires when the
  // module is deactivated, not when this context changes machine.
  runtime.scan.dispose()
  runtime.rules.clear()
  runtime.limits.clear()
  runtime.store.dispose()
  runtime.config.dispose()
}
