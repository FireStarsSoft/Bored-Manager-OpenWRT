import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import {
  BindingEngine,
  planBindingReconciliation,
  type BindingPlannerMemory,
  type BindingPlannerPolicy,
  type BindingPlannerWan,
  type BindingReconcileInput
} from '../../openwrt/main/binding'
import { DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { Lease, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * Pinning one device to one named WAN.
 *
 * Every route from a handler into the planner went through the forced path,
 * and a forced request deliberately skips the sticky preference - that is what
 * makes Reassign move a device off the WAN it is on. So there was no way to
 * say "that WAN" rather than "not this one", and writing the sticky entry by
 * hand did not help either: the reconcile rewrites it to whatever the pass
 * actually chose.
 *
 * The request now carries the WAN it wants. What that must never become is a
 * near miss - a pin the planner could not honour and quietly turned into a
 * random reassignment - so the WAN is checked before the pass runs and the
 * refusals below say what to do instead.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const NOW = 1_700_000_000_000
const DESK = 'aa:bb:cc:dd:ee:01'
const PHONE = 'aa:bb:cc:dd:ee:02'

// --------------------------------------------------------------- pure planner

const POLICY: BindingPlannerPolicy = {
  rulePrefBase: 20_000,
  catchAllPrefBase: 29_900,
  ruleChunkLines: 500,
  wanErrorGraceSec: 30,
  wanWarnUptimeSec: 0,
  releaseGraceSec: 300,
  maxEvents: 200
}

function plannerWan(name: string, table: number): BindingPlannerWan {
  return {
    name,
    table,
    up: true,
    pending: false,
    ipv4: `198.51.100.${table % 250}`,
    uptimeSec: 3_600
  }
}

const PLANNER_WANS = [
  plannerWan('pd00001', 10_001),
  plannerWan('pd00002', 10_002),
  plannerWan('pd00003', 10_003)
]

const DESK_LEASE: Lease = {
  mac: DESK,
  ip: '192.168.10.20',
  host: 'desk',
  expires: Math.floor(NOW / 1000) + 3_600
}

function memoryPinning(wan: string): BindingPlannerMemory {
  return {
    devices: [],
    waiting: [],
    wanErrors: [],
    orphans: [],
    heldMacs: [],
    forceReassign: [{ mac: DESK, preferWan: wan }],
    nextOrder: 1
  }
}

function input(overrides: Partial<BindingReconcileInput> = {}): BindingReconcileInput {
  return {
    now: NOW,
    instance: { id: 'bind1', running: true, sticky: true, remap: true },
    lanCidr: '192.168.10.0/24',
    leases: [DESK_LEASE],
    rules: [],
    wans: PLANNER_WANS,
    tableToWan: PLANNER_WANS.map((wan) => [wan.table ?? 0, wan.name] as [number, string]),
    sticky: [],
    policy: POLICY,
    randomSeed: 7,
    ...overrides
  }
}

const wanFor = (
  result: { desired: ReadonlyArray<{ mac: string | null; wan: string }> },
  mac: string
): string | undefined => result.desired.find((entry) => entry.mac === mac)?.wan

describe('a reconcile asked for one particular WAN', () => {
  it('takes it ahead of the sticky choice the instance had recorded', () => {
    const result = planBindingReconciliation(
      input({
        memory: memoryPinning('pd00003'),
        sticky: [{ mac: DESK, wan: 'pd00001', lastSeenAt: NOW }]
      })
    )

    expect(wanFor(result, DESK)).toBe('pd00003')
  })

  it('honours it on an instance that keeps no sticky choices at all', () => {
    // The sticky branch is gated on the instance flag, so a pin that rode on it
    // would have worked on half the instances and silently done nothing on the
    // rest.
    const result = planBindingReconciliation(
      input({
        instance: { id: 'bind1', running: true, sticky: false, remap: true },
        memory: memoryPinning('pd00002')
      })
    )

    expect(wanFor(result, DESK)).toBe('pd00002')
  })

  it('spends the request on one pass rather than latching it', () => {
    const result = planBindingReconciliation(input({ memory: memoryPinning('pd00002') }))

    // The memory this pass hands to the next carries no request at all: what
    // holds the device there afterwards is the rule on the router, and - for an
    // instance that keeps them - the sticky choice the engine writes.
    expect(wanFor(result, DESK)).toBe('pd00002')
    expect(result.memory.forceReassign).toEqual([])
  })

  it('does not hold the WAN against a device that has gone away', () => {
    // The request is consumed by one pass either way; a device with no current
    // lease is never allocated, so the WAN must stay in the free pool.
    const result = planBindingReconciliation(
      input({ leases: [], memory: memoryPinning('pd00002') })
    )

    expect(result.desired).toEqual([])
  })
})

// ------------------------------------------------------------------- engine

const LAN_IFACE = {
  name: 'lan',
  proto: 'static',
  device: 'br-lan',
  l3Device: 'br-lan',
  up: true,
  pending: false,
  autostart: true,
  uptimeSec: 4_000,
  ipv4: { addr: '192.168.1.1', mask: 24 }
}

function poolIface(seq: number, up = true): RouterModel['ifaces'][number] {
  const name = `pd${String(seq).padStart(5, '0')}`
  return {
    name,
    proto: 'pppoe',
    device: 'eth1',
    l3Device: `pppoe-${name}`,
    up,
    pending: false,
    autostart: true,
    uptimeSec: 3_000,
    // The dump carries each pool member's table - written by bm-pppoe-pool -
    // which is where the binding half's WAN-to-table map reads it from.
    ip4Table: 10_000 + seq,
    ...(up ? { ipv4: { addr: `198.51.100.${seq}`, mask: 32 } } : {})
  }
}

function routerModel(options: { leases?: Lease[]; downSeq?: number } = {}): RouterModel {
  return {
    t: NOW,
    sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
    ifaces: [
      LAN_IFACE,
      poolIface(1, options.downSeq !== 1),
      poolIface(2, options.downSeq !== 2),
      poolIface(3, options.downSeq !== 3)
    ],
    poolDev: { count: 3, rx: 0, tx: 0 },
    leases: options.leases ?? [
      { expires: 0, mac: DESK, ip: '192.168.1.20', host: 'desk' }
    ],
    rules: [],
    rates: {}
  }
}

interface Fixture {
  engine: BindingEngine
  store: HostStore
  sample(model?: RouterModel): Promise<void>
  wanOf(mac: string): string | undefined
  failScripts(fail: boolean): void
}

function fixture(options: { sticky?: boolean } = {}): Fixture {
  let failing = false
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 2,
      instances: [
        {
          id: 'bind1',
          name: 'Office LAN',
          lan: 'lan',
          carrier: 'eth1',
          running: true,
          sticky: options.sticky ?? true,
          remap: true,
          createdAt: 1,
          slot: 0
        }
      ],
      extraTables: [],
      stickyMap: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  harness.exec.mockImplementation(async (command) => {
    if (command === 'sh -s' && failing) return ok('', '', 1)
    return ok()
  })
  const rules: OwrtRules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  const engine = new BindingEngine(harness.ctx, store, { rules: () => rules })
  return {
    engine,
    store,
    sample: (model) => engine.onSample(model ?? routerModel()),
    wanOf: (mac) => engine.rows('bind1').find((row) => row.mac === mac)?.wan,
    failScripts: (fail) => {
      failing = fail
    }
  }
}

/** The WAN this instance did not put `mac` on, so a pin has somewhere to move it. */
function otherWan(run: Fixture, mac: string): string {
  const current = run.wanOf(mac)
  return ['pd00001', 'pd00002', 'pd00003'].find((name) => name !== current) ?? 'pd00002'
}

describe('pinning a device from a row action', () => {
  it('moves it onto the WAN that was named', async () => {
    const run = fixture()
    await run.sample()
    const wanted = otherWan(run, DESK)

    expect(await run.engine.pin('bind1', DESK, wanted)).toMatchObject({ ok: true })

    expect(run.wanOf(DESK)).toBe(wanted)
  })

  it('keeps it there when the device drops off and comes back', async () => {
    const run = fixture()
    await run.sample()
    const wanted = otherWan(run, DESK)
    expect(await run.engine.pin('bind1', DESK, wanted)).toMatchObject({ ok: true })

    // Nothing on the router remembers the assignment: each sample here carries
    // an empty rule list, so the device is allocated from nothing every pass -
    // which is what a reconnect looks like to the planner.
    await run.sample(routerModel({ leases: [] }))
    await run.sample()

    expect(run.wanOf(DESK)).toBe(wanted)
    expect(
      run.store.read().stickyMap.find((entry) => entry[1] === DESK)?.[2]
    ).toBe(wanted)
  })

  it('puts the sticky map back when the pass never reached the router', async () => {
    const run = fixture()
    await run.sample()
    const before = JSON.stringify(run.store.read().stickyMap)
    run.failScripts(true)

    const result = (await run.engine.pin('bind1', DESK, otherWan(run, DESK))) as OkResult

    expect(result.ok).toBe(false)
    // A pin recorded by a pass that failed would steer the next one to a WAN
    // the router was never told about.
    expect(JSON.stringify(run.store.read().stickyMap)).toBe(before)
  })
})

describe('a pin that cannot be honoured', () => {
  it('refuses a WAN outside the instance pool instead of choosing another', async () => {
    const run = fixture()
    await run.sample()

    const result = (await run.engine.pin('bind1', DESK, 'pd00099')) as OkResult

    expect(result.ok).toBe(false)
    expect(result.error).toContain('pd00099 is not one of the 3 WANs')
    expect(result.error).toContain('carrier eth1')
  })

  it('refuses a WAN another device already carries, and names it', async () => {
    const run = fixture()
    await run.sample(
      routerModel({
        leases: [
          { expires: 0, mac: DESK, ip: '192.168.1.20', host: 'desk' },
          { expires: 0, mac: PHONE, ip: '192.168.1.21', host: 'phone' }
        ]
      })
    )
    const taken = run.wanOf(PHONE) ?? ''

    const result = (await run.engine.pin('bind1', DESK, taken)) as OkResult

    expect(result.ok).toBe(false)
    expect(result.error).toContain(`${taken} already carries phone`)
    expect(result.error).toContain('unassign that device first')
  })

  it('refuses a WAN that is not in a state to take a device', async () => {
    const run = fixture()
    await run.sample(routerModel({ downSeq: 3 }))

    const result = (await run.engine.pin('bind1', DESK, 'pd00003')) as OkResult

    expect(result.ok).toBe(false)
    // Without this the planner's own fallback took over and handed the device a
    // random free WAN, which is Reassign - the opposite of what was asked.
    expect(result.error).toContain('pd00003 cannot take a device right now')
    expect(result.error).toContain('is down, or reporting an error')
  })

  it('refuses an empty WAN name with the column to read one off', async () => {
    const run = fixture()
    await run.sample()

    const result = (await run.engine.pin('bind1', DESK, '   ')) as OkResult

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Name the WAN to pin this device to')
    expect(result.error).toContain('WAN column')
  })

  it('refuses a whole selection, because one WAN carries one device', async () => {
    const run = fixture()
    await run.sample()

    const result = (await run.engine.pin(
      [`bind1|${DESK}`, `bind1|${PHONE}`],
      undefined,
      'pd00002'
    )) as OkResult

    expect(result.ok).toBe(false)
    expect(result.error).toContain('one device at a time')
  })

  it('says nothing would happen when the device is away and nothing records it', async () => {
    const run = fixture({ sticky: false })
    await run.sample(routerModel({ leases: [] }))

    const result = (await run.engine.pin('bind1', DESK, 'pd00002')) as OkResult

    expect(result.ok).toBe(false)
    expect(result.error).toContain('holds no current DHCP lease')
    expect(result.error).toContain('Keep each device on the same WAN')
  })
})
