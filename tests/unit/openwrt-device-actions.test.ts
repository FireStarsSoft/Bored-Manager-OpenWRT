import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { Lease, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * Unassign and Reassign: the two things an operator does to one device that has
 * already been given a WAN.
 *
 * Both work by writing into the planner's memory and running an ordinary
 * reconcile, so a manual choice is allocated by exactly the same pass as an
 * automatic one. That is also what makes the failure case matter: the pass can
 * stop halfway through an SSH command, and a memory left holding the request
 * would leave the device held, or moved, by work that never reached the router.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const NOW = 1_700_000_000_000
const DESK = 'aa:bb:cc:dd:ee:01'
const PHONE = 'aa:bb:cc:dd:ee:02'

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

function poolIface(seq: number): RouterModel['ifaces'][number] {
  const name = `pd${String(seq).padStart(5, '0')}`
  return {
    name,
    proto: 'pppoe',
    device: 'eth1',
    l3Device: `pppoe-${name}`,
    up: true,
    pending: false,
    autostart: true,
    uptimeSec: 3_000,
    // The dump carries each pool member's table - written by bm-pppoe-pool -
    // which is where the binding half's WAN-to-table map reads it from.
    ip4Table: 10_000 + seq,
    ipv4: { addr: `198.51.100.${seq}`, mask: 32 }
  }
}

const LEASES: Lease[] = [
  { expires: 0, mac: DESK, ip: '192.168.1.20', host: 'desk' },
  { expires: 0, mac: PHONE, ip: '192.168.1.21', host: 'phone' }
]

function routerModel(leases: Lease[] = LEASES): RouterModel {
  return {
    t: NOW,
    sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
    ifaces: [LAN_IFACE, poolIface(1), poolIface(2), poolIface(3)],
    poolDev: { count: 3, rx: 0, tx: 0 },
    leases,
    rules: [],
    rates: {}
  }
}

interface Fixture {
  engine: BindingEngine
  store: HostStore
  sample(model?: RouterModel): Promise<void>
  wanOf(mac: string): string | undefined
  waiting(mac: string): { reason: string; held: boolean; heldLabel: string } | undefined
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
    waiting: (mac) => engine.waitingRows('bind1').find((row) => row.mac === mac),
    failScripts: (fail) => {
      failing = fail
    }
  }
}

describe('unassigning one device', () => {
  it('takes its WAN away and puts it in the queue as held by hand', async () => {
    const run = fixture()
    await run.sample()
    expect(run.wanOf(DESK)).toBeTruthy()

    expect(await run.engine.unassign('bind1', DESK)).toMatchObject({ ok: true })

    expect(run.wanOf(DESK)).toBeUndefined()
    // Every waiting row used to read as though a free WAN were the only thing
    // missing. For a device an operator took off the network by hand that is
    // untrue, and no WAN coming free will change it.
    expect(run.waiting(DESK)).toMatchObject({
      reason: 'unassigned by hand',
      held: true,
      heldLabel: 'Held'
    })
  })

  it('keeps holding it across later reconciles rather than handing it back a WAN', async () => {
    // The hold lives in the planner's memory and is carried from pass to pass;
    // a forced request is not. Losing the difference would give the device its
    // WAN back on the very next fast tick.
    const run = fixture()
    await run.sample()
    await run.engine.unassign('bind1', DESK)

    await run.sample()
    await run.sample()

    expect(run.wanOf(DESK)).toBeUndefined()
    expect(run.waiting(DESK)?.held).toBe(true)
  })

  it('leaves the other devices on the WANs they had', async () => {
    const run = fixture()
    await run.sample()
    const phoneWan = run.wanOf(PHONE)

    await run.engine.unassign('bind1', DESK)

    expect(run.wanOf(PHONE)).toBe(phoneWan)
  })

  it('does not hold it when the pass never reached the router', async () => {
    // The memory each instance had is restored on failure. Without that the
    // device would be shown as held by an operator action that failed, and the
    // next reconcile would act on a hold nothing on the router reflects.
    const run = fixture()
    await run.sample()
    run.failScripts(true)

    const result = (await run.engine.unassign('bind1', DESK)) as OkResult

    expect(result.ok).toBe(false)
    run.failScripts(false)
    await run.sample()
    expect(run.wanOf(DESK)).toBeTruthy()
    expect(run.waiting(DESK)).toBeUndefined()
  })
})

describe('reassigning one device', () => {
  it('moves it off the WAN it is on, every time it is pressed', async () => {
    const run = fixture()
    await run.sample()

    // Eight in a row, because the WAN is otherwise picked at random from the
    // free pool: "not this one" is the whole request, and a reassign that can
    // land back where it started is a button that sometimes does nothing.
    for (let press = 0; press < 8; press++) {
      const before = run.wanOf(DESK)
      expect(before).toBeTruthy()
      expect(await run.engine.reassign('bind1', DESK)).toMatchObject({ ok: true })
      expect(run.wanOf(DESK)).toBeTruthy()
      expect(run.wanOf(DESK)).not.toBe(before)
    }
  })

  it('forgets the sticky choice, so the old WAN cannot pull it back', async () => {
    const run = fixture()
    await run.sample()
    const before = run.wanOf(DESK)
    expect(run.store.read().stickyMap.find((entry) => entry[1] === DESK)?.[2]).toBe(before)

    await run.engine.reassign('bind1', DESK)
    // The device drops off the network and comes back, which is when a sticky
    // choice is consulted. A stale entry here would undo the reassign.
    await run.sample(routerModel([]))
    await run.sample()

    expect(run.wanOf(DESK)).not.toBe(before)
  })

  it('releases a device that was being held', async () => {
    const run = fixture()
    await run.sample()
    await run.engine.unassign('bind1', DESK)
    expect(run.waiting(DESK)?.held).toBe(true)

    expect(await run.engine.reassign('bind1', DESK)).toMatchObject({ ok: true })

    expect(run.wanOf(DESK)).toBeTruthy()
    expect(run.waiting(DESK)).toBeUndefined()
  })

  it('puts the sticky map back when the pass never reached the router', async () => {
    // The order the entries come back in is the store's business; which
    // device is on which WAN is not.
    const sticky = (): string[] =>
      run.store
        .read()
        .stickyMap.map((entry) => `${entry[1]}=${entry[2]}`)
        .sort()
    const run = fixture()
    await run.sample()
    const before = sticky()
    expect(before).toHaveLength(2)
    run.failScripts(true)

    const result = (await run.engine.reassign('bind1', DESK)) as OkResult

    expect(result.ok).toBe(false)
    // The entry is deleted before the pass runs, so a failure that did not put
    // it back would silently forget which WAN the device was on.
    expect(sticky()).toEqual(before)
  })

  it('acts on a whole selection sent as instance-and-mac keys', async () => {
    // What the bulk action on the table posts, as opposed to the two arguments
    // a row action sends.
    const run = fixture()
    await run.sample()
    const before = { desk: run.wanOf(DESK), phone: run.wanOf(PHONE) }

    expect(await run.engine.reassign([`bind1|${DESK}`, `bind1|${PHONE}`])).toMatchObject({
      ok: true,
      data: '2'
    })

    expect(run.wanOf(DESK)).not.toBe(before.desk)
    expect(run.wanOf(PHONE)).not.toBe(before.phone)
  })
})

describe('a device action that names nothing usable', () => {
  it('is refused rather than applied to whatever is first', async () => {
    const run = fixture()
    await run.sample()

    for (const result of [
      (await run.engine.unassign('bind1', 'not-a-mac')) as OkResult,
      (await run.engine.reassign([])) as OkResult,
      (await run.engine.unassign([':::'])) as OkResult
    ]) {
      expect(result).toMatchObject({ ok: false, error: 'no valid device was selected' })
    }
  })

  it('is refused when the instance is gone', async () => {
    const run = fixture()
    await run.sample()

    expect(await run.engine.reassign('bind9', DESK)).toMatchObject({
      ok: false,
      error: expect.stringContaining('no longer exists')
    })
  })
})
