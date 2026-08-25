import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * Whether an instance is running is topology, not a cache: it decides what the
 * router does after the app restarts. Start, Stop and Delete used to set it by
 * assigning straight to the object `store.read()` returns - which is the live
 * document, so the value did take effect, but the record stayed clean and no
 * flush was ever scheduled for it.
 *
 * That is fine right up until anything else writes during the seconds the
 * reconcile spends on SSH. Then the pending value is persisted, and the revert
 * that follows a failure - just as clean - is never written at all.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

/**
 * A fresh copy per fixture. A successful reconcile writes its planned rules
 * back into the model it was given, so one shared object would leave the second
 * test looking at the first test's router.
 */
const model = (): RouterModel => structuredClone(MODEL)

const MODEL: RouterModel = {
  t: 1_700_000_000_000,
  sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
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
    }
  ],
  poolDev: { count: 1, rx: 0, tx: 0 },
  leases: [{ expires: 0, mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.20', host: 'desk' }],
  rules: [],
  rates: {}
}

function hostData(running: boolean): unknown {
  return {
    version: 1,
    nextSeq: 2,
    batches: [
      {
        id: 'b1',
        name: 'Home',
        prefix: 'pd',
        carrier: 'eth1',
        createdAt: 1,
        count: 1,
        seqFrom: 1,
        seqTo: 1
      }
    ],
    instances: [
      {
        id: 'bind1',
        name: 'Office LAN',
        lan: 'lan',
        carrier: 'eth1',
        running,
        sticky: true,
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
}

interface Fixture {
  engine: BindingEngine
  /** What the last completed write left on disk, or undefined if nothing was written. */
  savedRunning(): boolean | undefined
  /** Flush whatever the action left scheduled, the way the debounce timer would. */
  settle(): void
  /** Prime the engine with a sample, then arm the mock for the action itself. */
  ready(): Promise<void>
  failNextScript(): void
}

function fixture(running: boolean): Fixture {
  const saved: Array<{ instances?: Array<{ id: string; running: boolean }> }> = []
  const sample = model()
  let primed = false
  let failNext = false
  const harness = moduleHarness('openwrt', () => ok(), { hostData: hostData(running) })
  const context = harness.ctx as unknown as { hostDataSet: (value: unknown) => void }
  context.hostDataSet = (value) => {
    // `serializeHostData` passes `instances` through by reference, so a later
    // mutation of the cache would rewrite a snapshot taken by reference too -
    // and every assertion below would read the live value rather than the
    // written one, which is exactly the distinction under test.
    saved.push(JSON.parse(JSON.stringify(value)) as { instances?: Array<{ id: string; running: boolean }> })
  }
  const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
  harness.exec.mockImplementation(async (command) => {
    if (!primed || command !== 'sh -s') return ok()
    // A write from elsewhere in the module landing while the action is on SSH:
    // a job finishing, an event recorded, sticky-map churn. Any one of them
    // schedules the flush; doing it here only makes the timing deterministic.
    store.update((data) => data.moduleEvents.push(['router', sample.t, 'tick', 'unrelated']))
    store.flush()
    if (failNext) {
      failNext = false
      return ok('', '', 1)
    }
    return ok()
  })
  const engine = new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES })
  return {
    engine,
    savedRunning: () => saved.at(-1)?.instances?.find((entry) => entry.id === 'bind1')?.running,
    settle: () => store.flush(),
    ready: async () => {
      await engine.onSample(sample)
      store.flush()
      primed = true
    },
    failNextScript: () => {
      failNext = true
    }
  }
}

describe('an action whose reconcile failed', () => {
  it('does not leave a stopped instance persisted as running', async () => {
    const run = fixture(false)
    await run.ready()
    run.failNextScript()

    const result = await run.engine.start('bind1')
    run.settle()

    expect(result.ok).toBe(false)
    expect(run.savedRunning()).toBe(false)
  })

  it('does not leave a running instance persisted as stopped', async () => {
    const run = fixture(true)
    await run.ready()
    run.failNextScript()

    const result = await run.engine.stop('bind1')
    run.settle()

    expect(result.ok).toBe(false)
    expect(run.savedRunning()).toBe(true)
  })

  it('keeps a failed delete from persisting the stop it was about to make', async () => {
    // Delete stops the instance first so its rules can be torn down. The
    // instance is still there when that fails, and it is still running.
    const run = fixture(true)
    await run.ready()
    run.failNextScript()

    const result = await run.engine.delete('bind1')
    run.settle()

    expect(result.ok).toBe(false)
    expect(run.savedRunning()).toBe(true)
  })
})

describe('an action that worked', () => {
  it('still persists the value it set, with no second write to do it', async () => {
    const run = fixture(false)
    await run.ready()

    const result = await run.engine.start('bind1')
    run.settle()

    expect(result.ok).toBe(true)
    expect(run.savedRunning()).toBe(true)
  })
})
