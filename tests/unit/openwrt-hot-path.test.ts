import { describe, expect, it, vi } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { ConfigStore } from '../../openwrt/main/config'
import type { JobSpec, OpenWrtJob } from '../../openwrt/main/jobs'
import { PppoeManager } from '../../openwrt/main/pppoe'
import { Queries } from '../../openwrt/main/queries'
import { HostStore } from '../../openwrt/main/store'
import type { AgentCapability } from '../../openwrt/main/probe'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { ifaceIndex } from '../../openwrt/main/util'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import { BINDING_AGENT_INFO, routerProbeOutput } from '../helpers/router'
import { fakeWanbind, instanceConfig, type WanbindDaemon } from '../helpers/wanbind'

/**
 * What the module does between two ticks, when nothing has changed.
 *
 * Everything here is about work that was repeated rather than work that was
 * wrong: a sweep against a router with nothing on it and nobody watching,
 * surfaces re-fetching answers the cache already holds, and readers each
 * indexing the same interface list. Each one is asserted as a count of what
 * the module actually did, never as a duration.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 10): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function probeOutput(withBindingDaemon = false): string {
  // The shared builder, because it emits every section the probe parser looks
  // for. A hand-rolled subset here silently produced a router whose agent was
  // never read, which is a fixture that agrees with any implementation.
  return routerProbeOutput({ agent: withBindingDaemon ? BINDING_AGENT_INFO : null })
}

function sweepOutput(): string {
  return [
    '===SYS===',
    JSON.stringify({ uptime: 4_000, load: [0, 0, 0], memory: { total: 1, free: 1 } }),
    '===DEV===',
    '===POOL=== 0 0 0',
    '===LEASES===',
    '===RULES===',
    '===RULESOK===',
    '1',
    '===DUMP===',
    JSON.stringify({ interface: [] })
  ].join('\n')
}

// ----------------------------------------------------- the idle fast sweep

describe('the fast sweep on a router with nothing to automate', () => {
  /**
   * `fastIntervalMs` is 2 s and `slowIntervalSec` is 60 in the harness, so the
   * two cadences below are 30 sweeps a minute and 1.
   */
  function idleRouter(options: {
    tabActive?: boolean
    hostData?: unknown
    /** A router that answers for `bm.wanbind`, for the cases about automation. */
    daemon?: WanbindDaemon
  }): {
    harness: ReturnType<typeof moduleHarness>
    options: { tabActive?: boolean }
    probes: () => number
  } {
    let probes = 0
    const { daemon, ...rest } = options
    const shared = { config: sharedModuleConfig(null), ...rest }
    const harness = moduleHarness(
      'openwrt',
      (command) => {
        if (command.includes("echo '===REL==='")) {
          probes += 1
          return ok(probeOutput(!!daemon))
        }
        if (command.includes("echo '===SYS==='")) return ok(sweepOutput())
        return daemon?.answer(command) ?? ok('')
      },
      shared
    )
    return { harness, options: shared, probes: () => probes }
  }

  it('drops to the slow cadence when there is nothing to reconcile and nobody looking', async () => {
    // No pool, no binding instance, no open surface: every fast tick is one
    // SSH round trip producing numbers nothing reads - thirty a minute, for
    // each pooled machine the app happens to be connected to.
    const { harness } = idleRouter({ tabActive: false })
    const runtime = activate(harness.ctx)

    runtime.applyPollers?.()
    await settle()

    // Pollers 0 and 1 are the fast and slow collectors.
    expect(harness.pollers[0].start).toHaveBeenCalledWith(60_000)
    expect(harness.pollers[0].start).not.toHaveBeenCalledWith(2_000)
    expect(harness.pollers[1].start).toHaveBeenCalledWith(60_000)
    runtime.dispose?.()
  })

  it('keeps the full rate as soon as the router says it has automation', async () => {
    // Reconcile needs every tick whether or not anybody has the page open: a
    // client bound to a WAN that just dropped stays off the internet until a
    // sweep notices, and a minute of that is worse than any saving here.
    //
    // What changed at 3.4.0 is where the answer comes from, and it is worth
    // being exact about because it costs one tick. The instances used to be in
    // this module's own records, so `hostData` alone decided the cadence before
    // a single byte had been read off the router. They live in
    // /etc/config/bm_wanbind now, so the first fast sample is what learns of
    // them - and the re-time happens on the next `applyPollers`, which is every
    // tab switch, every settings change and every reconnect.
    //
    // The window that leaves is one slow interval on a router nobody is looking
    // at, and the daemon reconciles on its own thirty-second timer throughout
    // it. That is the whole point of the release: the router does not need this
    // module to be awake.
    const daemon = fakeWanbind({
      configured: [instanceConfig({ id: 'bmi_home', name: 'Office LAN', enabled: true })]
    })
    const { harness } = idleRouter({ tabActive: false, daemon })
    const runtime = activate(harness.ctx)

    runtime.applyPollers?.()
    await settle()

    // One fast sample, which is what asks the router. Driving it by hand is the
    // honest shape of this: the poller is a spy here, so nothing fires on its
    // own, and on a real router this is simply the first tick after connecting.
    await harness.ticks[0]?.()
    await settle()

    // The router has now been asked, so the next layout pass re-times.
    runtime.applyPollers?.()
    await settle()

    expect(harness.pollers[0].start).toHaveBeenCalledWith(2_000)
    runtime.dispose?.()
  })

  it('keeps the full rate for an idle router somebody is actually watching', async () => {
    const { harness } = idleRouter({ tabActive: true })
    const runtime = activate(harness.ctx)

    runtime.applyPollers?.()
    await settle()

    expect(harness.pollers[0].start).toHaveBeenCalledWith(2_000)
    runtime.dispose?.()
  })

  it('re-times on a tab switch without paying for another probe', async () => {
    // applyPollers() runs on every tab switch. The idle state is deliberately
    // kept out of the poller layout key: in the key, each switch would stop
    // both collectors and re-run PROBE_COMMAND over SSH to start them again.
    const { harness, options, probes } = idleRouter({ tabActive: false })
    const runtime = activate(harness.ctx)

    runtime.applyPollers?.()
    await settle()
    expect(harness.pollers[0].start).toHaveBeenLastCalledWith(60_000)

    options.tabActive = true
    runtime.applyPollers?.()
    await settle()

    expect(harness.pollers[0].start).toHaveBeenLastCalledWith(2_000)
    expect(probes()).toBe(1)
    runtime.dispose?.()
  })
})

// --------------------------------------------------------- the pool cache

describe('the pool answers every surface shares', () => {
  /** A capability that says the 2.x pool daemon is on the router. */
  const withDaemon: AgentCapability = {
    installed: true,
    running: true,
    release: '2.0.0',
    apiVersion: 3,
    schema: 2,
    dataSchema: 2,
    provides: ['pppoe'],
    features: [
      { name: 'bm-pppoe-pool', version: '2.0.0', apiVersion: 2, provides: ['pppoe'] }
    ],
    guard: null,
    usable: true,
    problem: null,
    canGuard: true,
    canUpdate: true
  }

  const INFO = {
    name: 'bm-pppoe-pool',
    release: '2.0.0',
    apiVersion: 2,
    settings: { enabled: true, counter_interval: 5, redial_after: 120, redial_batch: 20 },
    started: 1,
    uptime: 100,
    pools: [
      {
        id: 'fpt1',
        mode: 'multi',
        label: 'FPT line',
        prefix: 'fpt',
        carrier: 'eth1',
        mac_mode: 'auto',
        username: 'u@isp',
        hasPassword: true,
        table_base: 10_000,
        service: '',
        ac: '',
        ac_mac: '',
        mtu: 0,
        keepalive: '5 1',
        ipv6: '0',
        peerdns: false,
        dns: [],
        defaultroute: true,
        host_uniq: '',
        demand: 0,
        padi_attempts: 0,
        padi_timeout: 0,
        pppd_options: '',
        zone: 'bmwanpool',
        masq: true,
        mtu_fix: true,
        lan_forward: true,
        created: 1_700_000_000,
        memberList: [
          { vlan: 101, username: '' },
          { vlan: 102, username: '' }
        ],
        members: 2,
        up: 1,
        dialing: 0,
        down: 0,
        error: 0,
        stopped: 0,
        unwritten: 1,
        createdAt: 1_700_000_000,
        rate: { rxBps: 1000, txBps: 2000 }
      }
    ],
    legacy: []
  }

  const ROWS = {
    sessions: [
      {
        pool: 'fpt1',
        section: 'fpt101',
        vlan: 101,
        device: 'eth1.101',
        username: 'u@isp',
        mac: '02:a6:65:b8:00:65',
        status: 'up',
        autostart: true,
        uptime: 90,
        ip: '10.0.0.2',
        table: 10_101,
        errorCode: '',
        rxBps: 500,
        txBps: 600,
        redials: 0
      },
      {
        pool: 'fpt1',
        section: 'fpt102',
        vlan: 102,
        device: 'eth1.102',
        username: 'u@isp',
        mac: '02:a6:65:b8:00:66',
        status: 'unwritten',
        autostart: true,
        uptime: 0,
        ip: '',
        table: 10_102,
        errorCode: '',
        rxBps: 0,
        txBps: 0,
        redials: 0
      }
    ],
    limit: 500
  }

  function cachedManager(): { manager: PppoeManager; calls: () => number } {
    let calls = 0
    const harness = moduleHarness('openwrt', () => ok())
    harness.exec.mockImplementation(async (command: string) => {
      calls += 1
      if (command.includes('bm.pppoe info')) return ok(JSON.stringify(INFO))
      if (command.includes('bm.pppoe sessions')) return ok(JSON.stringify(ROWS))
      return ok()
    })
    const manager = new PppoeManager(
      harness.ctx,
      { effectiveRules: () => ({ execTimeoutSec: 60, tableBase: 10_000 }) },
      {
        start: (spec: JobSpec): OpenWrtJob => ({
          id: 'job_1',
          kind: spec.kind,
          label: spec.label,
          state: 'running',
          startedAt: 0,
          total: spec.items.length,
          done: 0,
          failed: 0,
          progressPct: 0,
          items: []
        }),
        list: () => []
      },
      { forceDump: () => {} },
      () => withDaemon
    )
    return { manager, calls: () => calls }
  }

  it('fetches once per tick, and every surface reads the same answers', async () => {
    const { manager, calls } = cachedManager()

    await manager.refresh()
    const fetched = calls()
    expect(fetched).toBe(2) // one info, one sessions

    // The summary, the pools table, the row tables and the range provider all
    // read the cache; none of them costs another round trip.
    const summary = manager.snapshot()
    const pools = manager.pools()
    const rows = manager.rows('fpt1')
    const attention = manager.rows('', 'attention')
    manager.managedRanges()

    expect(calls()).toBe(fetched)
    expect(summary).toMatchObject({ pools: 1, interfaces: 2, up: 1, unwritten: 1, attention: 1 })
    expect(pools[0]).toMatchObject({
      id: 'fpt1',
      title: 'FPT line',
      account: 'u@isp',
      members: 2,
      listText: '101-102'
    })
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ name: 'fpt102', status: 'unwritten', table: 10_102 })
    expect(attention).toHaveLength(1)
    expect(attention[0]).toMatchObject({ name: 'fpt102' })
  })

  it('keeps the last answers and marks them stale when the router stops answering', async () => {
    const { manager } = cachedManager()
    await manager.refresh()
    expect(manager.snapshot().stale).toBe(false)

    // The next fetch fails outright; the pools must not vanish.
    const failing = vi.fn(async () => ok('', 'ubus timeout', 1))
    ;(manager as unknown as { runtime: { ctx: { exec: unknown } } }).runtime.ctx.exec = failing

    await manager.refresh()

    expect(manager.snapshot().stale).toBe(true)
    expect(manager.pools()).toHaveLength(1)
    expect(manager.rows('fpt1')).toHaveLength(2)
  })
})

// ----------------------------------------------------- the interface index

describe('the interface index every reader shares', () => {
  it('is built once per sample and hung off it', () => {
    const model = modelWith([upIface('pd00001'), upIface('pd00002')])

    expect(ifaceIndex(model)).toBe(ifaceIndex(model))
    expect(ifaceIndex(model).get('pd00002')?.name).toBe('pd00002')
    expect(ifaceIndex(modelWith([]))).not.toBe(ifaceIndex(model))
    expect(ifaceIndex(null).size).toBe(0)
  })

  it('is the only pass the device table makes over the interface list', () => {
    const model = modelWith([upIface('pd00001'), upIface('pd00002')])
    let passes = 0
    const walk = model.ifaces.map.bind(model.ifaces)
    Object.defineProperty(model.ifaces, 'map', {
      configurable: true,
      value: (fn: (iface: IfaceState, index: number) => unknown) => {
        passes += 1
        return walk(fn as never)
      }
    })

    const harness = moduleHarness('openwrt', () => ok(), {
      config: sharedModuleConfig(null)
    })
    const config = new ConfigStore(harness.ctx)
    const store = new HostStore(harness.ctx, () => config.effectiveRules())
    const queries = new Queries(
      () => model,
      () => ({}),
      config,
      store,
      // No daemon in this fixture: the table falls back to what the rules say,
      // which is what it does on a router that has not answered yet.
      {
        answered: () => false,
        deviceView: () => new Map(),
        heldKeys: () => new Set<string>(),
        instanceLans: () => new Map()
      }
    )

    queries.deviceRows()

    expect(passes).toBe(1)
  })
})

// ------------------------------------------------------------------ fixtures

function modelWith(ifaces: IfaceState[]): RouterModel {
  return {
    t: 1_700_000_000_000,
    sys: { uptimeSec: 4_000, load1: 0, memTotal: 1, memFree: 1 },
    ifaces,
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases: [],
    rules: [],
    rates: {}
  }
}

function upIface(name: string): IfaceState {
  return {
    name,
    proto: 'pppoe',
    device: 'eth1',
    l3Device: `pppoe-${name}`,
    up: true,
    pending: false,
    autostart: true,
    ipv4: { addr: '10.0.0.2', mask: 32 },
    uptimeSec: 90
  }
}
