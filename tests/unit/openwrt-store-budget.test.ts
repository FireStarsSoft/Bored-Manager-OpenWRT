import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModuleContext } from '@shared/modules'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import type { FinishedJob, StoredJobItemState } from '../../openwrt/main/records'
import {
  HostStore,
  PERSIST_TARGET_BYTES,
  emptyData,
  fitHostData,
  serializedBytes,
  trim,
  type BindingInstanceRecord,
  type OwrtHostData
} from '../../openwrt/main/store'
import { moduleHarness } from '../helpers/module-harness'

/**
 * What the per-router document gives up, and when.
 *
 * Every case below is a way the old order lost the wrong thing: history
 * sacrificed to save a sticky map that was the actual problem, a job's failed
 * steps thrown away in favour of its first eight successes, one instance's
 * events emptying another's drawer, table assignments outliving the instance
 * that claimed them, and a write still on the debounce when the context moved
 * to another machine.
 */

function instance(id: string, slot = 0): BindingInstanceRecord {
  return {
    id,
    name: id,
    lan: 'lan',
    carrier: 'eth1',
    running: true,
    sticky: true,
    remap: false,
    createdAt: 1,
    slot
  }
}

function mac(index: number): string {
  const hex = index.toString(16).padStart(8, '0')
  return `aa:bb:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}`
}

function job(id: string, items: StoredJobItemState[]): FinishedJob {
  return {
    id,
    kind: 'pppoe-create',
    label: `Create batch ${id}`,
    state: 'partial',
    startedAt: 1,
    finishedAt: 2,
    total: items.length,
    done: items.length,
    failed: items.filter((status) => status === 'error').length,
    progressPct: 100,
    items: items.map((status, idx) => ({
      idx,
      name: `Apply PPPoE chunk ${idx + 1}/${items.length}`,
      status,
      message: `chunk ${idx + 1}`
    }))
  }
}

/** A document big enough that a 500 KB write is refused, entirely because of sticky. */
function oversized(): OwrtHostData {
  const data = emptyData()
  data.instances.push(instance('bind1'))
  for (let index = 0; index < 20_000; index++) {
    data.stickyMap.push(['bind1', mac(index), `pd${index}`, 1_700_000_000 + index])
  }
  for (let index = 0; index < 120; index++) {
    data.events.push(['bind1', 1_700_000_000 + index, 'assigned', `device ${index} bound`])
  }
  for (let index = 0; index < 10; index++) {
    data.jobs.push(job(`job${index}`, ['ok', 'ok', 'error']))
  }
  return data
}

describe('fitting a document that will not fit', () => {
  it('spends the sticky map before it spends any history', () => {
    const data = oversized()
    expect(serializedBytes(data)).toBeGreaterThan(PERSIST_TARGET_BYTES)

    fitHostData(data, DEFAULT_RULES)

    expect(serializedBytes(data)).toBeLessThanOrEqual(PERSIST_TARGET_BYTES)
    // The rings are what the old order cut first, down to 20 rows and 3 jobs,
    // on every single flush - and it never was the sticky map's size problem.
    expect(data.events).toHaveLength(120)
    expect(data.jobs).toHaveLength(10)
    expect(data.stickyMap.length).toBeLessThan(20_000)
  })

  it('only touches the rings once sticky is at its floor', () => {
    const data = emptyData()
    data.instances.push(instance('bind1'))
    for (let index = 0; index < 100; index++) {
      data.stickyMap.push(['bind1', mac(index), 'pd1', 1_700_000_000 + index])
    }
    // Nothing but history left to give.
    for (let index = 0; index < 2_000; index++) {
      data.events.push(['bind1', 1_700_000_000 + index, 'assigned', 'x'.repeat(400)])
    }

    fitHostData(data, DEFAULT_RULES)

    expect(data.stickyMap).toHaveLength(100)
    expect(data.events.length).toBeLessThanOrEqual(20)
  })
})

describe('trimming job history', () => {
  it('keeps the steps that failed, not the first few that worked', () => {
    const data = emptyData()
    const statuses: StoredJobItemState[] = Array.from({ length: 60 }, (_, index) =>
      index >= 55 ? 'error' : 'ok'
    )
    data.jobs.push(job('big', statuses))

    trim(data, DEFAULT_RULES)

    const kept = data.jobs[0]!.items
    expect(kept).toHaveLength(30)
    // A positional slice(0, 30) kept chunks 1-30 and dropped every failure -
    // which is the only reason anyone opens a finished job.
    expect(kept.filter((item) => item.status === 'error')).toHaveLength(5)
    expect(kept.map((item) => item.idx)).toEqual([...kept.map((item) => item.idx)].sort((a, b) => a - b))
  })
})

describe('the per-instance event ring', () => {
  it('does not let one instance empty another instance drawer', () => {
    const data = emptyData()
    data.instances.push(instance('chatty', 0), instance('quiet', 1))
    for (let index = 0; index < 5; index++) {
      data.events.push(['quiet', 1_000 + index, 'assigned', `quiet ${index}`])
    }
    for (let index = 0; index < 500; index++) {
      data.events.push(['chatty', 2_000 + index, 'assigned', `chatty ${index}`])
    }

    trim(data, DEFAULT_RULES)

    const quiet = data.events.filter((entry) => entry[0] === 'quiet')
    const chatty = data.events.filter((entry) => entry[0] === 'chatty')
    // One shared 200-row budget filled entirely with the chatty instance's
    // last 200 entries and left the quiet one with nothing at all.
    expect(quiet).toHaveLength(5)
    expect(chatty.length).toBeLessThanOrEqual(100)
    expect(chatty.at(-1)?.[3]).toBe('chatty 499')
  })
})

describe('table assignments left by a deleted instance', () => {
  it('heals a document polluted by an earlier build on the next read', () => {
    const harness = moduleHarness('openwrt', () => ({ stdout: '', stderr: '', code: 0 }), {
      hostData: {
        version: 1,
        nextSeq: 1,
        batches: [],
        instances: [],
        // Written before entries named an owner, by instances long since gone.
        extraTables: [['pd00001', 10_001], ['pd00002', 10_002]],
        stickyMap: [],
        events: [],
        moduleEvents: [],
        jobs: []
      }
    })

    expect(new HostStore(harness.ctx, () => DEFAULT_RULES).read().extraTables).toEqual([])
  })

  it('keeps an assignment a preparation has written but not yet claimed', () => {
    // The instance record is pushed by the last item of the same job, so
    // between the UCI write and that push the entry belongs to nobody. Pruning
    // it as an orphan would throw away the only record of the very first
    // instance's tables while its own job was still running.
    const data = emptyData()
    data.extraTables.push(['wan2', 10_500])

    trim(data, DEFAULT_RULES)

    expect(data.extraTables).toEqual([['wan2', 10_500]])
  })

  it('drops only the entries the deleted instance claimed', () => {
    const data = emptyData()
    data.instances.push(instance('bind1'))
    data.extraTables.push(['pd00001', 10_001, 'bind1'], ['pd00002', 10_002, 'gone'])

    trim(data, DEFAULT_RULES)

    expect(data.extraTables).toEqual([['pd00001', 10_001, 'bind1']])
  })
})

describe('a write still on the debounce', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A store whose context can be pointed at another machine mid-test. */
  function switchable(): {
    store: HostStore
    writes: unknown[]
    point(at: string | null): void
  } {
    const harness = moduleHarness('openwrt', () => ({ stdout: '', stderr: '', code: 0 }))
    const writes: unknown[] = []
    let saved: unknown = null
    let key: string | null = 'router-a'
    const ctx = harness.ctx as ModuleContext & {
      hostDataGet: () => unknown
      hostDataSet: (value: unknown) => void
    }
    Object.defineProperty(ctx, 'hostKey', { get: () => key, configurable: true })
    ctx.hostDataSet = (value: unknown) => {
      writes.push(value)
      saved = value
    }
    ctx.hostDataGet = () => saved
    return {
      store: new HostStore(ctx, () => DEFAULT_RULES),
      writes,
      point: (at) => {
        key = at
      }
    }
  }

  it('survives the debounce firing while the context is on another machine', () => {
    vi.useFakeTimers()
    const { store, writes, point } = switchable()

    store.update((data) => {
      data.extraTables.push(['wan1', 10_042])
    })
    // The app moves to the next machine in the pool before the timer lands.
    point('router-b')
    vi.advanceTimersByTime(11_000)
    expect(writes).toHaveLength(0)

    // ...and back. The write used to be unreachable from here: the timer had
    // fired, found the wrong host, and cancelled itself for good.
    point('router-a')
    vi.advanceTimersByTime(11_000)

    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ extraTables: [['wan1', 10_042]] })
  })

  it('gives up rather than retrying for the life of the process', () => {
    vi.useFakeTimers()
    const { store, writes, point } = switchable()

    store.update((data) => {
      data.extraTables.push(['wan1', 10_042])
    })
    point('router-b')
    vi.advanceTimersByTime(10 * 60_000)
    point('router-a')
    vi.advanceTimersByTime(10 * 60_000)

    expect(writes).toHaveLength(0)
    // Still in memory, so the next mutation carries it out.
    store.update((data) => {
      data.extraTables.push(['wan2', 10_043])
    })
    vi.advanceTimersByTime(11_000)
    expect(writes).toHaveLength(1)
  })

  it('writes a topology change through instead of waiting out the debounce', () => {
    vi.useFakeTimers()
    const { store, writes } = switchable()

    store.update((data) => {
      data.moduleEvents.push(['router', 1, 'reboot', 'history can wait'])
    })
    expect(writes).toHaveLength(0)

    store.updateNow((data) => {
      data.instances.push(instance('bind1'))
    })

    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ instances: [expect.objectContaining({ id: 'bind1' })] })
  })
})
