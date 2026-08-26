import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { sampleHistory } from '../../openwrt/main/service'
import type { SweepRuntime } from '../../openwrt/main/service/runtime'

/**
 * How often the dashboard's charts gain a point.
 *
 * It used to be "once per slow sweep", which was not a decision so much as
 * where the call happened to sit - so a chart was one point per minute however
 * fast the router was being read, and every window shorter than an hour looked
 * like a staircase. It is a setting now, offered from Module settings under
 * Display & charts, and the tick that offers a sample is the fast one.
 */

interface Fake {
  runtime: SweepRuntime
  points: Array<Record<string, number>>
}

function fakeRuntime(historySampleSec = DEFAULT_RULES.historySampleSec, at = 1_000): Fake {
  const points: Array<Record<string, number>> = []
  const runtime = {
    ctx: { addHistory: (point: Record<string, number>) => points.push(point) },
    config: {
      effectiveRules: () => ({ ...DEFAULT_RULES, historySampleSec })
    },
    historyModelAt: 0,
    historyAt: 0,
    overview: {
      t: at,
      counts: { wanUp: 1, wanErr: 0, devices: 4, bound: 3, waiting: 1 },
      poolAgg: { rx: 10, tx: 20 },
      sys: { load1: 0.5, memPct: 42 }
    }
  } as unknown as SweepRuntime
  return { runtime, points }
}

/** Move the sweep on, the way a fast tick does. */
function tick(fake: Fake, at: number): boolean {
  ;(fake.runtime.overview as unknown as { t: number }).t = at
  return sampleHistory(fake.runtime, at)
}

describe('how often a chart point is written', () => {
  it('writes the first point it is offered, whatever the interval', () => {
    const fake = fakeRuntime(3_600)

    expect(sampleHistory(fake.runtime, 1_000)).toBe(true)
    expect(fake.points).toHaveLength(1)
    expect(fake.points[0]).toMatchObject({ t: 1_000, devices: 4, bound: 3, waiting: 1 })
  })

  it('holds the next one back until the interval has elapsed', () => {
    const fake = fakeRuntime(60)
    sampleHistory(fake.runtime, 1_000)

    expect(tick(fake, 1_000 + 30_000)).toBe(false)
    expect(tick(fake, 1_000 + 59_999)).toBe(false)
    // `>=`, so a router configured at the same cadence as its sweep does not
    // silently drop every other point to timer jitter.
    expect(tick(fake, 1_000 + 60_000)).toBe(true)
    expect(fake.points).toHaveLength(2)
  })

  it('follows the setting rather than the tick that offered it', () => {
    const fast = fakeRuntime(5)
    sampleHistory(fast.runtime, 1_000)
    expect(tick(fast, 6_000)).toBe(true)
    expect(tick(fast, 11_000)).toBe(true)
    expect(fast.points).toHaveLength(3)

    const slow = fakeRuntime(600)
    sampleHistory(slow.runtime, 1_000)
    expect(tick(slow, 6_000)).toBe(false)
    expect(tick(slow, 11_000)).toBe(false)
    expect(slow.points).toHaveLength(1)
  })

  it('defaults to what the slow sweep used to produce', () => {
    // A router that never touches the setting charts exactly as it did before
    // there was one.
    expect(DEFAULT_RULES.historySampleSec).toBe(60)
  })

  it('writes nothing while the sweep has produced nothing new', () => {
    // A slow tick on a router whose fast sweep has stalled must leave a gap in
    // the chart rather than archive the same numbers over and over: a flat line
    // and no data look very different, and only one of them is the truth.
    const fake = fakeRuntime(5)
    sampleHistory(fake.runtime, 1_000)

    expect(sampleHistory(fake.runtime, 60_000)).toBe(false)
    expect(fake.points).toHaveLength(1)
  })

  it('writes nothing before the first overview lands', () => {
    const fake = fakeRuntime()
    ;(fake.runtime as unknown as { overview: unknown }).overview = null

    expect(sampleHistory(fake.runtime, 1_000)).toBe(false)
    expect(fake.points).toHaveLength(0)
  })
})

describe('both ticks offer a sample', () => {
  /**
   * The pacing above is only honest if the fast tick is what offers most of the
   * samples. Read off the source rather than driven through a sweep: the point
   * is that neither call site quietly goes away again, and a full sweep would
   * need a router to answer three commands to prove one line.
   */
  it('is called from the fast tick and from the slow one', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../openwrt/main/service')

    for (const file of ['fast.ts', 'slow.ts']) {
      expect(readFileSync(join(root, file), 'utf8')).toContain('sampleHistory(runtime,')
    }
  })

  it('keeps the writer in one place', () => {
    // Two copies of the point payload is how the chart and the tiles came to
    // disagree about what `bound` meant.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../openwrt/main')
    const callers = readdirSync(join(root, 'service'))
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => readFileSync(join(root, 'service', name), 'utf8').includes('addHistory('))

    expect(callers).toEqual(['history.ts'])
  })
})
