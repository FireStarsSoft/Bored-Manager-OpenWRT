import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine, type BindingSnapshot } from '../../openwrt/main/binding'
import { DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * What the reconcile pass says about itself, and the two moments it used to
 * describe wrongly: a pass that failed halfway published the rows it already
 * had with the time of the failure stamped on them, so the page reported
 * devices as bound - and reported that answer as fresh - long after their ip
 * rules had gone; and a sample whose `ubus call system info` did not parse
 * carried uptime 0, which is below every uptime there has ever been, so an
 * unreadable section read as a reboot and re-applied everything, every tick.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const LAN_CIDR = '192.168.1.0/24'
const CATCH_TABLE = DEFAULT_RULES.catchAllTable
const CATCH_PREF = DEFAULT_RULES.catchAllPrefBase

function routerModel(uptimeSec = 4_000): RouterModel {
  return {
    t: 1_700_000_000_000,
    sys: { uptimeSec, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
    ifaces: [
      {
        name: 'lan',
        proto: 'static',
        device: 'br-lan',
        l3Device: 'br-lan',
        up: true,
        pending: false,
        autostart: true,
        uptimeSec: 4_000,
        ipv4: { addr: '192.168.1.1', mask: 24 }
      },
      {
        name: 'pd00001',
        proto: 'pppoe',
        device: 'eth1',
        l3Device: 'pppoe-pd00001',
        up: true,
        pending: false,
        autostart: true,
        uptimeSec: 3_000,
        ipv4: { addr: '198.51.100.1', mask: 32 }
      },
      {
        name: 'pd00002',
        proto: 'pppoe',
        device: 'eth1',
        l3Device: 'pppoe-pd00002',
        up: true,
        pending: false,
        autostart: true,
        uptimeSec: 3_000,
        ipv4: { addr: '198.51.100.2', mask: 32 }
      }
    ],
    poolDev: { count: 2, rx: 0, tx: 0 },
    leases: [{ expires: 0, mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.20', host: 'desk' }],
    rules: [],
    rates: {}
  }
}

function hostData(sticky: Array<[string, string, string, number]> = []): unknown {
  return {
    version: 1,
    nextSeq: 3,
    batches: [{
      id: 'b1',
      name: 'Home',
      prefix: 'pd',
      carrier: 'eth1',
      createdAt: 1,
      count: 2,
      seqFrom: 1,
      seqTo: 2
    }],
    instances: [{
      id: 'bind1',
      name: 'Office LAN',
      lan: 'lan',
      carrier: 'eth1',
      running: true,
      sticky: true,
      remap: true,
      createdAt: 1,
      slot: 0
    }],
    extraTables: [],
    stickyMap: sticky,
    events: [],
    moduleEvents: [],
    jobs: []
  }
}

interface Engine {
  sample(model: RouterModel): Promise<void>
  /** Every `sh -s` script the engine sent, one string per command. */
  scripts: string[]
  /** Every payload pushed on the `binding` stream, in order. */
  published: BindingSnapshot[]
  snapshot(): BindingSnapshot
  failScripts(fail: boolean): void
}

function engineFor(options: {
  rules?: Partial<OwrtRules>
  sticky?: Array<[string, string, string, number]>
} = {}): Engine {
  const scripts: string[] = []
  const published: BindingSnapshot[] = []
  let failing = false
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: hostData(options.sticky)
  })
  harness.exec.mockImplementation(async (command, execOptions) => {
    if (command === 'sh -s') {
      scripts.push(execOptions?.stdin ?? '')
      if (failing) return ok('', '', 1)
    }
    return ok()
  })
  const emit = harness.ctx.emit.bind(harness.ctx)
  harness.ctx.emit = (event: string, payload: unknown): void => {
    if (event === 'binding') published.push(payload as BindingSnapshot)
    emit(event, payload)
  }
  const rules: OwrtRules = { ...DEFAULT_RULES, ...options.rules }
  const store = new HostStore(harness.ctx, () => rules)
  const engine = new BindingEngine(harness.ctx, store, { rules: () => rules })
  return {
    scripts,
    published,
    snapshot: () => engine.snapshot(),
    failScripts: (fail) => {
      failing = fail
    },
    sample: (model) => engine.onSample(model)
  }
}

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the catch-all table', () => {
  it('is replaced in place, never emptied first', async () => {
    const run = engineFor()

    await run.sample(routerModel())

    const route = run.scripts.find((script) => script.includes('unreachable default'))
    // Flush-then-add left the table with no default for as long as the add
    // took, and a client whose rule already pointed at it fell through to the
    // next rule - the main table - and left through the router's own WAN.
    expect(route).toContain(`ip -4 route replace unreachable default table ${CATCH_TABLE}`)
    expect(run.scripts.join('\n')).not.toContain('route flush')
    expect(run.scripts.join('\n')).not.toContain('route add unreachable')
  })
})

describe('a reconcile that failed', () => {
  it('publishes the rows it has without calling them fresh', async () => {
    const run = engineFor()
    await run.sample(routerModel())
    const good = run.snapshot()
    expect(good.hookOk).toBe(true)
    expect(good.t).toBe(routerModel().t)

    run.failScripts(true)
    const later = routerModel()
    later.t = good.t + 60_000
    // A device leased since the last good pass: the rules for it are what
    // cannot be written.
    later.leases = [
      ...later.leases,
      { expires: 0, mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.1.21', host: 'phone' }
    ]
    await run.sample(later)

    const failed = last(run.published)
    expect(failed?.hookOk).toBe(false)
    expect(failed?.lastError).toContain('failed (exit 1)')
    // The rows describe the router as it was; saying they are a minute newer
    // is what made the staleness indicator report fresh data for an
    // assignment the router no longer had.
    expect(failed?.t).toBe(good.t)
    expect(run.snapshot().t).toBe(good.t)
  })

  it('never carries what the router printed', async () => {
    const run = engineFor()
    await run.sample(routerModel())
    run.failScripts(true)

    const later = routerModel()
    later.leases = [
      ...later.leases,
      { expires: 0, mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.1.21', host: 'phone' }
    ]
    await run.sample(later)

    expect(last(run.published)?.lastError).toMatch(/^[\w -]+ failed \(exit 1\)$/)
  })

  it('says so again as soon as one succeeds', async () => {
    const run = engineFor()
    await run.sample(routerModel())
    run.failScripts(true)
    const broken = routerModel()
    broken.leases = [
      ...broken.leases,
      { expires: 0, mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.1.21', host: 'phone' }
    ]
    await run.sample(broken)
    expect(last(run.published)?.hookOk).toBe(false)

    run.failScripts(false)
    const healed = routerModel()
    healed.t = broken.t + 120_000
    await run.sample(healed)

    expect(last(run.published)?.hookOk).toBe(true)
    expect(last(run.published)?.lastError).toBe('')
    expect(last(run.published)?.t).toBe(healed.t)
  })
})

describe('an unreadable system section', () => {
  it('is not a reboot', async () => {
    const run = engineFor()
    const model = routerModel()
    await run.sample(model)
    // The pass above installed the catch-all and the client rule, and wrote
    // them back into the model the way a fast tick would.
    run.scripts.length = 0
    await run.sample(model)
    expect(run.scripts).toEqual([])

    // `ubus call system info` that did not parse: every other field is intact
    // and uptime is 0. Read as a reboot, it re-applies every catch-all and
    // resets every WAN error timer, on every tick for as long as it lasts.
    model.sys = { ...model.sys, uptimeSec: 0 }
    await run.sample(model)

    expect(run.scripts).toEqual([])
  })

  it('does not make the next readable sample look like one either', async () => {
    const run = engineFor()
    const model = routerModel()
    await run.sample(model)
    model.sys = { ...model.sys, uptimeSec: 0 }
    await run.sample(model)
    run.scripts.length = 0

    // Back to the uptime it had before the unreadable tick. Remembering 0 as
    // the last uptime would make this look like a router that has been up
    // longer than it was a moment ago - harmless - but the reverse, a real
    // reboot after an unreadable tick, has to still be caught.
    model.sys = { ...model.sys, uptimeSec: 4_010 }
    await run.sample(model)
    expect(run.scripts).toEqual([])

    model.sys = { ...model.sys, uptimeSec: 12 }
    await run.sample(model)
    expect(run.scripts.join('\n')).toContain('unreachable default')
  })

  it('still ignores a second of clock jitter', async () => {
    const run = engineFor()
    const model = routerModel()
    await run.sample(model)
    run.scripts.length = 0

    model.sys = { ...model.sys, uptimeSec: 3_999 }
    await run.sample(model)

    expect(run.scripts).toEqual([])
  })
})

describe('the module-wide sticky and remap defaults', () => {
  it('do not override what an instance recorded for itself', async () => {
    // Both are the initial value the create form offers, and nothing more: the
    // instance carries its own `sticky` / `remap`, and that is what the planner
    // reads. A live copy on the policy would let this settings toggle change
    // what a running instance does with no record of it on the instance.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const run = engineFor({
      rules: { stickyByMac: false, remapOnWanError: false },
      sticky: [['bind1', 'aa:bb:cc:dd:ee:01', 'pd00002', 1_699_999_999_000]]
    })

    await run.sample(routerModel())

    // pd00001 is what an unseeded pick would have taken; the recorded choice
    // is pd00002, and the instance's own `sticky` is on.
    expect(run.scripts.join('\n')).toContain(
      `ip -4 rule add from 192.168.1.20/32 lookup 10002 pref ${DEFAULT_RULES.rulePrefBase}`
    )
  })
})

describe('the rows a surface renders', () => {
  it('carry the two flags its edit form opens on', async () => {
    const run = engineFor()

    await run.sample(routerModel())

    expect(run.snapshot().rows[0]).toMatchObject({
      id: 'bind1',
      name: 'Office LAN',
      sticky: true,
      remap: true
    })
    expect(last(run.published)?.rows[0]?.lan).toBe('lan')
  })
})

describe('the first catch-all rule', () => {
  it('is written at the instance slot for the whole LAN', async () => {
    const run = engineFor()

    await run.sample(routerModel())

    expect(run.scripts.join('\n')).toContain(
      `ip -4 rule add from ${LAN_CIDR} lookup ${CATCH_TABLE} pref ${CATCH_PREF}`
    )
  })
})
