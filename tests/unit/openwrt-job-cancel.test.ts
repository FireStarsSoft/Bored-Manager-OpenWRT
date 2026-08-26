import { describe, expect, it } from 'vitest'
import {
  Jobs,
  type JobHistoryData,
  type JobStore
} from '../../openwrt/main/jobs'

/**
 * Cancel is the one control that acts on a job while it is halfway through a
 * router, and nothing in the suite exercised it.
 *
 * Two rules make it survivable. Work already in flight is never killed - the
 * step being run finishes, because stopping a write halfway leaves the router
 * and the record disagreeing. And the steps that never ran are recorded as
 * cancelled rather than skipped, because the completion hook reads the
 * difference.
 */

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

// The chunked PPPoE create these cancel tests used to interrupt is gone with
// the SSH path: a pool is created by bm-pppoe-pool in one call, record first,
// and an interrupted create is repaired or removed by the daemon's own
// reconcile - proved by the ucode probes in packages/ci.
