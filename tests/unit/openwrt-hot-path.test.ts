import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { ConfigStore, DEFAULT_RULES } from '../../openwrt/main/config'
import type { JobSpec, OpenWrtJob } from '../../openwrt/main/jobs'
import { PppoeManager, type PppoeStoreData } from '../../openwrt/main/pppoe'
import { Queries } from '../../openwrt/main/queries'
import { HostStore } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { ifaceIndex } from '../../openwrt/main/util'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * What the module does between two ticks, when nothing has changed.
 *
 * Everything here is about work that was repeated rather than work that was
 * wrong: a sweep against a router with nothing on it and nobody watching, four
 * surfaces each rebuilding the same five thousand rows, three readers each
 * indexing the same interface list, and a string built for every row that no
 * spec has ever asked for. Each one is asserted as a count of what the module
 * actually did, never as a duration.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 10): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const ROUTER_TOOLS = [
  '/sbin/ubus',
  '/sbin/uci',
  '/sbin/ip',
  '/sbin/fw4',
  '/sbin/logread',
  '/usr/sbin/nft',
  '/sbin/netifd',
  '/usr/sbin/pppd'
]

function probeOutput(): string {
  return [
    '===REL===',
    "DISTRIB_ID='OpenWrt'",
    "DISTRIB_RELEASE='25.12.0'",
    '===BOARD===',
    JSON.stringify({
      model: 'Test Router',
      release: { distribution: 'OpenWrt', version: '25.12.0' }
    }),
    '===TOOLS===',
    ...ROUTER_TOOLS,
    '===PPP===',
    'plugin',
    'kmod',
    '===PKG===',
    'apkdb',
    '===DONE==='
  ].join('\n')
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

const BATCH = {
  id: 'b1',
  name: 'Pool',
  prefix: 'pd',
  carrier: 'eth1',
  createdAt: 1,
  count: 2,
  seqFrom: 1,
  seqTo: 2
}

// ----------------------------------------------------- the idle fast sweep

describe('the fast sweep on a router with nothing to automate', () => {
  /**
   * `fastIntervalMs` is 2 s and `slowIntervalSec` is 60 in the harness, so the
   * two cadences below are 30 sweeps a minute and 1.
   */
  function idleRouter(options: { tabActive?: boolean; hostData?: unknown }): {
    harness: ReturnType<typeof moduleHarness>
    options: { tabActive?: boolean }
    probes: () => number
  } {
    let probes = 0
    const shared = { config: sharedModuleConfig(null), ...options }
    const harness = moduleHarness(
      'openwrt',
      (command) => {
        if (command.includes("echo '===REL==='")) {
          probes += 1
          return ok(probeOutput())
        }
        if (command.includes("echo '===SYS==='")) return ok(sweepOutput())
        return ok('')
      },
      shared
    )
    return { harness, options: shared, probes: () => probes }
  }

  it('drops to the slow cadence when there is nothing to reconcile and nobody looking', async () => {
    // No batch, no binding instance, no open surface: every fast tick is one
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

  it('keeps the full rate as soon as there is automation on the router', async () => {
    // Reconcile needs every tick whether or not anybody has the page open: a
    // client bound to a WAN that just dropped stays off the internet until a
    // sweep notices, and a minute of that is worse than any saving here.
    const { harness } = idleRouter({
      tabActive: false,
      hostData: { version: 1, nextSeq: 3, batches: [BATCH] }
    })
    const runtime = activate(harness.ctx)

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

// --------------------------------------------------------- the row builder

describe('the PPPoE rows four surfaces share', () => {
  const SESSIONS = 200

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function pooled(): {
    manager: PppoeManager
    builds: () => number
    data: PppoeStoreData
    bump: () => void
    setModel: (next: RouterModel) => void
  } {
    let builds = 0
    let revision = 1
    // `seqTo` is read by `batchSequences` and by nothing else on these paths,
    // and `batchSequences` is called once per row build - so this counts
    // builds without the module having to carry a counter for the test.
    const batch = {
      id: 'b1',
      name: 'Pool',
      prefix: 'pd',
      carrier: 'eth1',
      createdAt: 1,
      count: SESSIONS,
      seqFrom: 1,
      get seqTo(): number {
        builds += 1
        return SESSIONS
      }
    }
    const data: PppoeStoreData = { nextSeq: SESSIONS + 1, batches: [batch] }
    let model = modelWith([])
    const harness = moduleHarness('openwrt', () => ok())
    const manager = new PppoeManager(
      harness.ctx,
      { effectiveRules: () => ({ ...DEFAULT_RULES }) },
      {
        read: () => data,
        update: <T,>(mutate: (value: PppoeStoreData) => T): T => mutate(data),
        revision: () => revision
      },
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
      { model: () => model, forceDump: () => {} }
    )
    return {
      manager,
      builds: () => builds,
      data,
      bump: () => {
        revision += 1
      },
      setModel: (next: RouterModel) => {
        model = next
      }
    }
  }

  it('builds them once for the summary, the batch table, the rows and the attention list', () => {
    // One tick asks for the same rows four times over: the summary the module
    // emits, the batch table, the open batch's row detail, and the attention
    // table. Every one of them used to walk the whole pool and allocate a row
    // object per session - 800 here, 20,000 on a five-thousand-account pool.
    const { manager, builds } = pooled()

    const summary = manager.snapshot()
    const batches = manager.batches()
    const rows = manager.rows('b1')
    const attention = manager.attentionRows()

    expect(builds()).toBe(1)
    // Same answers as before, from the one build.
    expect(summary.total).toBe(SESSIONS)
    expect(batches[0]).toMatchObject({ id: 'b1', count: SESSIONS, unknown: SESSIONS })
    expect(rows).toHaveLength(SESSIONS)
    expect(attention).toHaveLength(0)
  })

  it('rebuilds them for the next sample', () => {
    const { manager, builds, setModel } = pooled()
    manager.snapshot()
    manager.batches()
    expect(builds()).toBe(1)

    // onSample drops the cache and then emits the summary off a fresh build.
    const next = modelWith([upIface('pd00001')])
    setModel(next)
    manager.onSample(next)
    expect(builds()).toBe(2)
    expect(manager.rows('b1')[0]).toMatchObject({ name: 'pd00001', status: 'up' })
    expect(builds()).toBe(2)
  })

  it('rebuilds them when the batch records move under it', () => {
    // `read()` hands back the same object before and after a create, so the
    // store revision is the only thing that can tell a batch that was just
    // added from one that was always there. Without it a create landing
    // between two ticks left the page showing the pool as it was.
    const { manager, builds, data, bump } = pooled()
    manager.batches()
    expect(builds()).toBe(1)

    data.batches.push({
      id: 'b2',
      name: 'Second',
      prefix: 'pe',
      carrier: 'eth1',
      createdAt: 2,
      count: 3,
      seqFrom: 1,
      seqTo: 3
    })
    bump()

    expect(manager.batches()).toHaveLength(2)
    expect(builds()).toBe(2)
  })

  it('still lets the dialing clock turn a stuck session into an error', () => {
    // The one input that is time rather than state: `dialing` becomes a
    // timeout on the wall clock alone, with the sample and the records
    // unchanged. The cache is therefore only good until that moment, and no
    // further - which is why it carries a deadline as well as a key.
    const clock = vi.spyOn(Date, 'now')
    const started = 1_700_000_000_000
    clock.mockReturnValue(started)
    const { manager, builds, setModel } = pooled()
    const dialing = modelWith([dialingIface('pd00001')])
    setModel(dialing)
    manager.onSample(dialing)

    expect(manager.batches()[0]).toMatchObject({ dialing: 1 })
    const cached = builds()
    // Four minutes in it is still a session that might yet come up, and the
    // rows already built say exactly that.
    clock.mockReturnValue(started + 4 * 60_000)
    expect(manager.batches()[0]).toMatchObject({ dialing: 1 })
    expect(builds()).toBe(cached)

    clock.mockReturnValue(started + 6 * 60_000)
    expect(manager.batches()[0]).toMatchObject({ dialing: 0, error: 1 })
    expect(builds()).toBe(cached + 1)
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

  it('is the only pass the three readers make over the interface list', () => {
    // The row builder, the manual-stop prune behind it and the device table
    // each built their own `name -> iface` map. On a five-thousand-session
    // router that was three passes over five thousand entries, per surface,
    // per tick, to produce three identical maps.
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
      hostData: { version: 1, nextSeq: 3, batches: [BATCH] },
      config: sharedModuleConfig(null)
    })
    const config = new ConfigStore(harness.ctx)
    const store = new HostStore(harness.ctx, () => config.effectiveRules())
    const data: PppoeStoreData = { nextSeq: 3, batches: [BATCH] }
    const manager = new PppoeManager(
      harness.ctx,
      { effectiveRules: () => ({ ...DEFAULT_RULES }) },
      // No `revision`, so the row cache never answers and every call really
      // does go looking for the index.
      {
        read: () => data,
        update: <T,>(mutate: (value: PppoeStoreData) => T): T => mutate(data)
      },
      { start: () => ({}) as OpenWrtJob, list: () => [] },
      { model: () => model, forceDump: () => {} }
    )
    const queries = new Queries(
      () => model,
      () => ({}),
      config,
      store
    )

    queries.deviceRows()
    manager.onSample(model)
    manager.rows('b1')
    manager.attentionRows()

    expect(passes).toBe(1)
  })
})

// -------------------------------------------------------- unrendered fields

describe('the fields a PPPoE row actually carries', () => {
  it('carries exactly what the batch detail table reads', async () => {
    // `uptimeLabel` was a formatted string built for every row of every batch
    // on every tick. No page spec has ever named it: the table asks for
    // `upSince` and counts from it in the renderer, which is what keeps a
    // session's uptime ticking between samples instead of freezing at
    // whatever the last one said.
    const harness = moduleHarness('openwrt', (command) => {
      if (command.includes("echo '===REL==='")) return ok(probeOutput())
      if (command.includes("echo '===SYS==='")) {
        return ok(
          sweepOutput().replace(
            JSON.stringify({ interface: [] }),
            JSON.stringify({
              interface: [
                {
                  interface: 'pd00001',
                  up: true,
                  proto: 'pppoe',
                  device: 'pppoe-pd00001',
                  uptime: 90,
                  'ipv4-address': [{ address: '10.0.0.2', mask: 32 }]
                }
              ]
            })
          )
        )
      }
      return ok('')
    }, {
      hostData: { version: 1, nextSeq: 3, batches: [BATCH] },
      config: sharedModuleConfig(null)
    })
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
    await settle(20)

    const rows = harness.handlers.get('pppoeRows')?.('b1') as Array<Record<string, unknown>>
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'batch',
        'errorCode',
        'ip',
        'name',
        'status',
        'statusBadges',
        'upSince',
        'username'
      ].sort()
    )
    expect(rows[0].upSince).toBeGreaterThan(0)
    runtime.dispose?.()
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

/** Listed, not up, nothing pending, no error code: the catch-all `dialing`. */
function dialingIface(name: string): IfaceState {
  return { ...upIface(name), up: false, ipv4: undefined, uptimeSec: 0 }
}
