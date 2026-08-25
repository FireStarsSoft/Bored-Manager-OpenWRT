import { describe, expect, it, vi } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { ConfigStore, DEFAULT_RULES } from '../../openwrt/main/config'
import { Jobs, trimFinishedJob, type FinishedJob, type JobHistoryData, type JobStore } from '../../openwrt/main/jobs'
import { FastSweep } from '../../openwrt/main/service'
import { HostStore } from '../../openwrt/main/store'
import type { OpenWrtOverview } from '../../openwrt/main/types'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * Three ways this module used to say nothing when something was wrong: a
 * collector that stopped answering left the dashboard showing its last good
 * numbers, a firewall step that reloaded into no nft rule reported itself as a
 * clean green step, and a connection the router had no interface for looked
 * exactly like one somebody had stopped on purpose.
 */

const ok = (stdout: string, stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

interface SweepOptions {
  uptime?: number
  rulesOk?: boolean
  dump?: string | null
}

function sweepOutput(options: SweepOptions = {}): string {
  const { uptime = 4_000, rulesOk = true, dump = null } = options
  return [
    '===SYS===',
    JSON.stringify({ uptime, load: [0, 0, 0], memory: { total: 1, free: 1 } }),
    '===DEV===',
    'Inter-|   Receive                    |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes',
    '  eth1: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0',
    '===POOL=== 0 0 0',
    '===LEASES===',
    '===RULES===',
    '===RULESOK===',
    rulesOk ? '1' : '0',
    ...(dump === null ? [] : ['===DUMP===', dump])
  ].join('\n')
}

function newSweep(answer: (command: string) => ModuleExecResult): {
  sweep: FastSweep
  harness: ReturnType<typeof moduleHarness>
} {
  const harness = moduleHarness('openwrt', answer, { config: sharedModuleConfig(null) })
  const config = new ConfigStore(harness.ctx)
  const store = new HostStore(harness.ctx, () => config.effectiveRules())
  return { sweep: new FastSweep(harness.ctx, config, store), harness }
}

function overviews(harness: ReturnType<typeof moduleHarness>): OpenWrtOverview[] {
  return harness.emit.mock.calls
    .filter((call) => call[0] === 'overview')
    .map((call) => call[1] as OpenWrtOverview)
}

describe('collector health on the overview stream', () => {
  it('publishes a healthy verdict with the numbers it produced', async () => {
    const { sweep, harness } = newSweep(() => ok(sweepOutput({ dump: '[]' })))

    await sweep.run()

    const health = overviews(harness).at(-1)?.health
    expect(health).toMatchObject({ fastOk: true, slowOk: true, dumpOk: true, hookOk: true })
    expect(health?.lastFastT).toBeGreaterThan(0)
    expect(health?.lastError).toBe('')
  })

  it('re-pushes the last numbers marked stale when the router stops answering', async () => {
    let fail = false
    const { sweep, harness } = newSweep(() => {
      if (fail) throw new Error('ssh channel closed')
      return ok(sweepOutput())
    })

    await sweep.run()
    fail = true
    await sweep.run()

    const pushed = overviews(harness)
    expect(pushed).toHaveLength(2)
    // Same sample, now carrying the reason it stopped moving.
    expect(pushed[1].t).toBe(pushed[0].t)
    expect(pushed[1].health.fastOk).toBe(false)
    expect(pushed[1].health.lastError).toContain('ssh channel closed')
  })

  it('reports only once per failure streak, and recovers on the next good tick', async () => {
    let fail = true
    const { sweep, harness } = newSweep(() => {
      if (fail) throw new Error('ssh channel closed')
      return ok(sweepOutput())
    })

    // Nothing has ever been published, so there is no payload to re-push: an
    // invented one would read as a router reporting zero of everything.
    await sweep.run()
    expect(overviews(harness)).toHaveLength(0)

    fail = false
    await sweep.run()
    fail = true
    await sweep.run()
    await sweep.run()

    const pushed = overviews(harness)
    expect(pushed.map((overview) => overview.health.fastOk)).toEqual([true, false])
  })
})

describe('router reboot notices', () => {
  it('reports a reboot even when the rule list did not come back', async () => {
    let uptime = 4_000
    const onRouterReboot = vi.fn()
    const harness = moduleHarness('openwrt', () => ok(sweepOutput({ uptime, rulesOk: false })), {
      config: sharedModuleConfig(null)
    })
    const config = new ConfigStore(harness.ctx)
    const store = new HostStore(harness.ctx, () => config.effectiveRules())
    const sweep = new FastSweep(harness.ctx, config, store, { onRouterReboot })

    await sweep.run()
    uptime = 12
    await sweep.run()

    // The reconcile needs `ip rule`; the notice does not. Gating them together
    // silenced the one sample that most needs explaining.
    expect(onRouterReboot).toHaveBeenCalledTimes(1)
    // The old bare-string emit on an undeclared event: the `log` block routes
    // by `{ id, data }`, so the renderer dropped it and nobody ever saw it.
    expect(harness.emit.mock.calls.some((call) => call[0] === 'bindingLog')).toBe(false)
  })

  it('puts the reboot in the module event trail', async () => {
    let uptime = 4_000
    const harness = moduleHarness('openwrt', (command) =>
      command.includes('===SYS===') ? ok(sweepOutput({ uptime })) : ok('')
    , { config: sharedModuleConfig(null) })
    const runtime = activate(harness.ctx)

    await harness.ticks[0]()
    uptime = 12
    await harness.ticks[0]()

    const rows = harness.handlers.get('eventRows')?.('router') as Array<{
      kind: string
      text: string
    }>
    expect(rows.map((row) => row.kind)).toEqual(['reboot'])
    expect(rows[0].text).toContain('reboot')
    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })
})

describe('job steps that finished but not cleanly', () => {
  function jobStore(): JobStore & { data: JobHistoryData } {
    const data: JobHistoryData = { jobs: [] }
    return {
      data,
      read: () => data,
      update: <TResult>(mutate: (value: JobHistoryData) => TResult): TResult => mutate(data)
    }
  }

  it('marks a warning step without failing the job', async () => {
    const store = jobStore()
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, store)

    jobs.start({
      kind: 'pppoe-create',
      label: 'Create batch Home',
      items: [
        { name: 'Apply chunk 1/1', run: async () => {} },
        {
          name: 'Configure firewall zone bmwanpool',
          run: async () => ({ warning: 'Firewall reload produced no nft rule for pppoe-pd' })
        },
        { name: 'Verify interfaces', run: async () => 'all 2 up' }
      ]
    })
    await settle()

    const [finished] = store.data.jobs
    expect(finished.state).toBe('done')
    expect(finished.failed).toBe(0)
    expect(finished.items.map((item) => item.status)).toEqual(['ok', 'warning', 'ok'])
    expect(finished.items[1].message).toContain('no nft rule')
    expect(finished.items[2].message).toBe('all 2 up')
  })

  it('times each step so a stalled one is visible while it runs', async () => {
    const store = jobStore()
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, store)

    jobs.start({ kind: 'test', label: 'One step', items: [{ name: 'Step', run: async () => {} }] })
    await settle()

    const item = store.data.jobs[0].items[0]
    expect(item.startedAt).toBeGreaterThan(0)
    expect(typeof item.ms).toBe('number')
  })

  it('keeps warnings when a long job is trimmed to its cap', () => {
    const items = Array.from({ length: 40 }, (_, idx) => ({
      idx,
      name: `Step ${idx}`,
      status: idx === 39 ? ('warning' as const) : ('ok' as const)
    }))
    const job = {
      id: 'j1',
      kind: 'pppoe-create',
      label: 'Create',
      state: 'done',
      startedAt: 1,
      finishedAt: 2,
      total: 40,
      done: 40,
      failed: 0,
      progressPct: 100,
      items
    } as unknown as FinishedJob

    const trimmed = trimFinishedJob(job)

    expect(trimmed.items).toHaveLength(30)
    expect(trimmed.items.some((item) => item.status === 'warning')).toBe(true)
    // Display order is restored after the ranked selection.
    expect(trimmed.items.map((item) => item.idx)).toEqual(
      [...trimmed.items.map((item) => item.idx)].sort((a, b) => a - b)
    )
  })

  it('loads a warning step back out of persisted history', () => {
    const harness = moduleHarness('openwrt', () => ok(''), {
      hostData: {
        version: 1,
        jobs: [
          {
            id: 'j1',
            kind: 'pppoe-create',
            label: 'Create batch Home',
            state: 'done',
            startedAt: 1,
            finishedAt: 2,
            total: 1,
            done: 1,
            failed: 0,
            progressPct: 100,
            items: [{ idx: 0, name: 'Configure firewall zone', status: 'warning', startedAt: 5, ms: 3 }]
          }
        ]
      }
    })

    const stored = new HostStore(harness.ctx, () => DEFAULT_RULES).read().jobs[0]

    expect(stored.items[0]).toMatchObject({ status: 'warning', startedAt: 5, ms: 3 })
  })
})

describe('a router that becomes usable without reconnecting', () => {
  const probeOutput = (tools: string[]): string =>
    [
      '===REL===',
      'DISTRIB_ID=OpenWrt',
      'DISTRIB_RELEASE=25.12.5',
      '===BOARD===',
      '{}',
      '===TOOLS===',
      ...tools,
      '===PPP===',
      '',
      '===PKG===',
      'apkdb',
      '===DONE==='
    ].join('\n')

  it('starts the collector once the missing command appears', async () => {
    let tools = ['ubus', 'uci', 'ip']
    const harness = moduleHarness(
      'openwrt',
      (command) => (command.includes('===TOOLS===') ? ok(probeOutput(tools)) : ok(sweepOutput())),
      { config: sharedModuleConfig(null) }
    )
    const runtime = activate(harness.ctx)

    runtime.applyPollers?.()
    await settle()
    // netifd is missing, so there is nothing to poll - and the verdict is
    // latched so the probe does not re-run on every tab switch.
    expect(harness.pollers[0].start).not.toHaveBeenCalled()

    tools = ['ubus', 'uci', 'ip', 'netifd']
    await runtime.refreshSlow?.('openwrt')
    await settle()

    // Until this reset, `applied` still held the blocked verdict: the module
    // sat idle on a ready router until the next reconnect or manual check.
    expect(harness.pollers[0].start).toHaveBeenCalledTimes(1)
    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })
})

describe('PPPoE connections the router does not have', () => {
  it('separates a half-created batch from one somebody stopped', async () => {
    const harness = moduleHarness(
      'openwrt',
      (command) =>
        command.includes('===SYS===')
          ? ok(
              sweepOutput({
                dump: JSON.stringify({
                  interface: [
                    { interface: 'lan', up: true, proto: 'static' },
                    { interface: 'pd00001', up: true, proto: 'pppoe', device: 'pppoe-pd00001' }
                  ]
                })
              })
            )
          : ok(''),
      {
        hostData: {
          version: 1,
          nextSeq: 4,
          batches: [
            {
              id: 'b1',
              name: 'Home',
              prefix: 'pd',
              carrier: 'eth1',
              createdAt: 1,
              count: 3,
              seqFrom: 1,
              seqTo: 3
            }
          ]
        },
        config: sharedModuleConfig(null)
      }
    )
    const runtime = activate(harness.ctx)

    await harness.ticks[0]()

    const [batch] = harness.handlers.get('pppoeBatches')?.() as Array<{
      up: number
      dialing: number
      stopped: number
      missing: number
    }>
    // pd00001 is dialing (up, no address yet); pd00002/pd00003 were never
    // written to UCI, which used to read as "stopped" - the same thing a
    // deliberate Stop looks like.
    expect(batch).toMatchObject({ dialing: 1, stopped: 0, missing: 2 })
    const rows = harness.handlers.get('pppoeRows')?.('b1') as Array<{ status: string }>
    expect(rows.map((row) => row.status)).toEqual(['dialing', 'missing', 'missing'])
    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })
})
