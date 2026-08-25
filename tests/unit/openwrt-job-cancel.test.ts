import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import {
  Jobs,
  type JobHistoryData,
  type JobStore,
  type JobsSnapshot
} from '../../openwrt/main/jobs'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'

/**
 * Cancel is the one control that acts on a job while it is halfway through a
 * router, and nothing in the suite exercised it.
 *
 * Two rules make it survivable. Work already in flight is never killed - the
 * chunk being committed finishes, because stopping between `uci commit network`
 * and `/etc/init.d/network reload` leaves netifd and UCI disagreeing. And the
 * steps that never ran are recorded as cancelled rather than skipped, because
 * the completion hook reads the difference: a create that was cancelled has to
 * cut its batch record down to the chunks that actually reached the router, or
 * the record goes on claiming interfaces UCI never got.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function jobStore(): JobStore & { data: JobHistoryData } {
  const data: JobHistoryData = { jobs: [] }
  return {
    data,
    read: () => data,
    update: <TResult>(mutate: (value: JobHistoryData) => TResult): TResult => mutate(data)
  }
}

/** A promise a test releases by hand, standing in for a chunk still on the wire. */
function gate(): { held: Promise<void>; release: () => void } {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return { held, release }
}

describe('cancelling a job that is halfway through', () => {
  it('lets the step in flight finish and marks the rest cancelled', async () => {
    const store = jobStore()
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, store)
    const { held, release } = gate()
    const ran: string[] = []

    const job = jobs.start({
      kind: 'pppoe-create',
      label: 'Create batch Home',
      items: [
        { name: 'Apply chunk 1/3', run: async () => { ran.push('1') } },
        { name: 'Apply chunk 2/3', run: async () => { ran.push('2'); await held } },
        { name: 'Apply chunk 3/3', run: async () => { ran.push('3') } }
      ]
    })
    await settle(5)

    expect(jobs.cancel(job.id)).toEqual({ ok: true })
    // Nothing is torn down under the running chunk: `uci commit network` has
    // already put those sections on the router and the reload after it still
    // has to happen, or netifd is left describing a config UCI no longer has.
    release()
    await settle()

    const [finished] = jobs.snapshot().finished
    expect(ran).toEqual(['1', '2'])
    expect(finished.state).toBe('cancelled')
    expect(finished.items.map((item) => item.status)).toEqual(['ok', 'ok', 'cancelled'])
    // Cancelling is not failing: no step errored, so nothing may be counted as
    // one or the card would send an operator looking for a router problem.
    expect(finished.failed).toBe(0)
    expect(finished.done).toBe(3)
  })

  it('says cancelling while the step in flight is still running', async () => {
    // The badge is the only thing on screen between the click and the step
    // finishing, and that gap is however long a chunk takes on a real router.
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, jobStore())
    const { held, release } = gate()
    const job = jobs.start({
      kind: 'pppoe-create',
      label: 'Create batch Home',
      items: [
        { name: 'Apply chunk 1/2', run: async () => held },
        { name: 'Apply chunk 2/2', run: async () => {} }
      ]
    })
    await settle(5)

    jobs.cancel(job.id)

    expect(jobs.snapshot().running[0].stateBadges.map((entry) => entry.label)).toEqual([
      'cancelling'
    ])
    release()
    await settle()
    expect(jobs.snapshot().finished[0].stateBadges.map((entry) => entry.label)).toEqual([
      'cancelled'
    ])
  })

  it('tells the step it is cancelled, so a long wait can stop early', async () => {
    // Every chunk gets a `cancelled()` it is expected to check inside its own
    // waits. Without it the inter-chunk delay - a second by default, per chunk,
    // across fifty chunks - would run to the end after the user gave up.
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, jobStore())
    const seen: boolean[] = []
    const { held, release } = gate()
    const job = jobs.start({
      kind: 'pppoe-create',
      label: 'Create batch Home',
      items: [
        {
          name: 'Apply chunk 1/1',
          run: async (cancelled) => {
            seen.push(cancelled())
            await held
            seen.push(cancelled())
          }
        }
      ]
    })
    await settle(5)
    jobs.cancel(job.id)
    release()
    await settle()

    expect(seen).toEqual([false, true])
  })

  it('still runs the completion hook, and tells it the job was cancelled', async () => {
    // The hook is where a create shrinks its record and repairs the zone. A
    // cancel that skipped it would leave the record claiming sections UCI never
    // got, and delete tripping over every one of them.
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, jobStore())
    const { held, release } = gate()
    const states: string[] = []

    const job = jobs.start({
      kind: 'pppoe-create',
      label: 'Create batch Home',
      items: [
        { name: 'Apply chunk 1/2', run: async () => held },
        { name: 'Apply chunk 2/2', run: async () => {} }
      ],
      onFinished: (finished) => {
        states.push(finished.state)
      }
    })
    await settle(5)
    jobs.cancel(job.id)
    release()
    await settle()

    expect(states).toEqual(['cancelled'])
  })

  it('keeps the cancelled job in history rather than losing what it did', async () => {
    const store = jobStore()
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, store)
    const { held, release } = gate()
    const job = jobs.start({
      kind: 'pppoe-create',
      label: 'Create batch Home',
      items: [
        { name: 'Apply chunk 1/2', run: async () => held },
        { name: 'Apply chunk 2/2', run: async () => {} }
      ]
    })
    await settle(5)
    jobs.cancel(job.id)
    release()
    await settle()

    expect(store.data.jobs).toHaveLength(1)
    expect(store.data.jobs[0]).toMatchObject({ state: 'cancelled', label: 'Create batch Home' })
  })
})

describe('cancelling something that cannot be cancelled', () => {
  it('refuses a job that has already finished, and says why', async () => {
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, jobStore())
    const job = jobs.start({
      kind: 'test',
      label: 'One step',
      items: [{ name: 'Step', run: async () => {} }]
    })
    await settle()

    expect(jobs.cancel(job.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('already finished')
    })
  })

  it('refuses an id that is not a job id at all', () => {
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, jobStore())

    expect(jobs.cancel(undefined)).toMatchObject({ ok: false })
    expect(jobs.cancel('job_nope')).toMatchObject({ ok: false })
  })
})

// ------------------------------------------------------- through the module

const PROBE = [
  '===REL===',
  "DISTRIB_ID='OpenWrt'",
  "DISTRIB_RELEASE='25.12.0'",
  '===BOARD===',
  JSON.stringify({ model: 'Test Router', release: { distribution: 'OpenWrt', version: '25.12.0' } }),
  '===TOOLS===',
  '/sbin/ubus',
  '/sbin/uci',
  '/sbin/ip',
  '/sbin/fw4',
  '/sbin/logread',
  '/sbin/netifd',
  '/usr/sbin/nft',
  '/usr/sbin/pppd',
  '===PPP===',
  'plugin',
  'kmod',
  '===PKG===',
  'apkdb',
  '===DONE==='
].join('\n')

/** The last jobs payload the module pushed. */
function lastJobs(harness: ModuleHarness): JobsSnapshot {
  const pushes = harness.emit.mock.calls.filter((call) => call[0] === 'jobs')
  return pushes[pushes.length - 1]?.[1] as JobsSnapshot
}

describe('cancelling a PPPoE create part-way through', () => {
  it('keeps the record down to the chunks that reached the router', async () => {
    // One session per chunk, so the boundary is exact. The record is written
    // for the whole requested range before the first chunk runs; a cancel that
    // left it that way would put two phantom rows on the dashboard for good and
    // give delete two sections to trip over.
    const uciBatches: string[] = []
    const { held, release } = gate()
    const harness = moduleHarness('openwrt', () => ok(), {
      config: sharedModuleConfig({ rules: { uciChunkSize: 1, chunkDelayMs: 0 } })
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command.includes("echo '===REL==='")) return ok(PROBE)
      if (command === 'sh -s' && stdin.includes('===CARRIER===')) {
        return ok('===CARRIER===1\n===NETWORK===\n')
      }
      if (command === 'uci batch') {
        uciBatches.push(stdin)
        // Park the job on the second session's chunk until the cancel is in.
        if (stdin.includes('set network.pd00002=interface')) await held
        return ok()
      }
      if (command.startsWith('nft list ruleset')) return ok('1 1')
      return ok()
    })

    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    const values = {
      name: 'Pool',
      carrier: 'eth1',
      prefix: 'pd',
      listText: ['u1,p1', 'u2,p2', 'u3,p3', 'u4,p4'].join('\n')
    }
    const report = (await harness.handlers.get('pppoeBatchCheck')?.(values)) as {
      ok: boolean
      token?: string
    }
    expect(report.ok).toBe(true)
    const started = (await harness.handlers.get('pppoeBatchApply')?.({
      token: report.token,
      values: { ...values, listFile: '', listText: '' }
    })) as { ok: boolean; data?: string }
    expect(started.ok).toBe(true)
    await settle(10)

    expect(harness.handlers.get('jobCancel')?.(started.data)).toEqual({ ok: true })
    release()
    await settle()

    const batches = harness.handlers.get('pppoeBatches')?.() as Array<{ count: number }>
    expect(batches).toHaveLength(1)
    // Two committed, and only two. Chunks three and four never ran.
    expect(batches[0].count).toBe(2)
    expect(uciBatches.some((body) => body.includes('set network.pd00003=interface'))).toBe(false)

    const job = lastJobs(harness).finished[0]
    expect(job.state).toBe('cancelled')
    expect(job.items.filter((item) => item.status === 'cancelled').length).toBeGreaterThan(0)
    runtime.dispose?.()
  })

  it('puts the sessions it did create into the firewall zone on the way out', async () => {
    // The 2.0.0 fix that only a cancel can exercise. A cancel stops the job
    // between items, so no chunk closure runs its failure path and the step
    // that registers the new sections never runs at all - in `networks` mode
    // that leaves the sessions that did reach the router in no zone: up,
    // addressed, and unable to carry one client packet. The completion hook is
    // the only thing standing between a cancelled create and that state.
    const uciBatches: string[] = []
    const { held, release } = gate()
    const harness = moduleHarness('openwrt', () => ok(), {
      config: sharedModuleConfig({
        rules: { uciChunkSize: 1, chunkDelayMs: 0, zoneMode: 'networks' }
      })
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command.includes("echo '===REL==='")) return ok(PROBE)
      if (command === 'sh -s' && stdin.includes('===CARRIER===')) {
        return ok('===CARRIER===1\n===NETWORK===\n')
      }
      if (command === 'uci batch') {
        uciBatches.push(stdin)
        if (stdin.includes('set network.pd00002=interface')) await held
        return ok()
      }
      if (command.startsWith('nft list ruleset')) return ok('1 1')
      return ok()
    })

    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    const values = {
      name: 'Pool',
      carrier: 'eth1',
      prefix: 'pd',
      listText: ['u1,p1', 'u2,p2', 'u3,p3'].join('\n')
    }
    const report = (await harness.handlers.get('pppoeBatchCheck')?.(values)) as {
      ok: boolean
      token?: string
    }
    const started = (await harness.handlers.get('pppoeBatchApply')?.({
      token: report.token,
      values: { ...values, listFile: '', listText: '' }
    })) as { data?: string }
    await settle(10)
    harness.handlers.get('jobCancel')?.(started.data)
    release()
    await settle()

    const membership = (section: string): string =>
      `add_list firewall.bmwanpool.network='${section}'`
    // The zone itself is prepared before the first interface exists, so it
    // cannot list the new sections yet; the repair on the way out is what puts
    // them in it.
    expect(uciBatches[0]).toContain('set firewall.bmwanpool=zone')
    expect(uciBatches[0]).not.toContain(membership('pd00001'))
    expect(uciBatches.some((body) => body.includes(membership('pd00001')))).toBe(true)
    expect(uciBatches.some((body) => body.includes(membership('pd00002')))).toBe(true)
    // And only those: the third session was cancelled before it was created.
    expect(uciBatches.some((body) => body.includes(membership('pd00003')))).toBe(false)
    runtime.dispose?.()
  })
})
