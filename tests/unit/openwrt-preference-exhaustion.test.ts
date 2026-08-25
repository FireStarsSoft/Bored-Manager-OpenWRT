import { describe, expect, it } from 'vitest'
import {
  planBindingReconciliation,
  type BindingPlannerPolicy,
  type BindingPlannerWan,
  type BindingReconcileInput
} from '../../openwrt/main/binding'
import type { IpRule, Lease } from '../../openwrt/main/types'

/**
 * Every ip rule a binding installs needs a preference between `rulePrefBase`
 * and `catchAllPrefBase`. When that range runs out the planner used to delete
 * the device from its assignment map and say nothing at all: no event, and -
 * for a device that already held an assignment - no waiting row either, since
 * the queue had been built before the allocation ran. The device simply
 * stopped existing on both tables, and the only visible symptom was a client
 * that had no internet.
 */

const NOW = 1_700_000_000_000

const POLICY: BindingPlannerPolicy = {
  rulePrefBase: 20_000,
  catchAllPrefBase: 29_900,
  ruleChunkLines: 500,
  wanErrorGraceSec: 30,
  wanWarnUptimeSec: 0,
  releaseGraceSec: 300,
  maxEvents: 200
}

function lease(last: number, host: string): Lease {
  return {
    mac: `00:11:22:33:44:${String(last).padStart(2, '0')}`,
    ip: `192.168.10.${last}`,
    host,
    expires: Math.floor(NOW / 1000) + 3_600
  }
}

function wan(name: string, table: number): BindingPlannerWan {
  return {
    name,
    table,
    up: true,
    pending: false,
    ipv4: `198.51.100.${table % 250}`,
    uptimeSec: 3_600
  }
}

const LEASES = [lease(2, 'phone'), lease(3, 'desk'), lease(4, 'tv')]
const WANS = [wan('pd00001', 10_001), wan('pd00002', 10_002), wan('pd00003', 10_003)]
const TABLES: Array<[number, string]> = [
  [10_001, 'pd00001'],
  [10_002, 'pd00002'],
  [10_003, 'pd00003']
]

function input(overrides: Partial<BindingReconcileInput> = {}): BindingReconcileInput {
  return {
    now: NOW,
    instance: { id: 'bind_1', running: true, sticky: true, remap: true },
    lanCidr: '192.168.10.0/24',
    leases: LEASES,
    rules: [],
    wans: WANS,
    tableToWan: TABLES,
    sticky: [],
    policy: POLICY,
    randomSeed: 7,
    ...overrides
  }
}

/** A range with exactly `count` usable preferences. */
function narrow(count: number): BindingPlannerPolicy {
  return { ...POLICY, catchAllPrefBase: POLICY.rulePrefBase + count }
}

const reasons = (rows: ReadonlyArray<{ mac: string; reason: string }>): string[] =>
  rows.map((row) => `${row.mac}: ${row.reason}`)

describe('running out of ip rule preferences', () => {
  it('queues the devices it cannot seat instead of dropping them', () => {
    const result = planBindingReconciliation(input({ policy: narrow(2) }))

    expect(result.devices).toEqual({ total: 3, bound: 2, waiting: 1 })
    // Three devices went in, three come out: two bound and one accounted for.
    expect(result.desired).toHaveLength(2)
    expect(result.waiting).toHaveLength(1)
    expect(result.waiting[0]?.reason).toBe('preferences exhausted')
  })

  it('says so once, not on every tick', () => {
    const first = planBindingReconciliation(input({ policy: narrow(2) }))
    const exhausted = first.events.filter((event) => event.kind === 'exhausted')
    expect(exhausted).toHaveLength(1)
    expect(exhausted[0]?.text).toContain('20000')
    expect(exhausted[0]?.text).toContain('20001')
    expect(first.memory.prefsExhausted).toBe(true)

    const second = planBindingReconciliation(
      input({
        policy: narrow(2),
        rules: first.desired.map(
          (entry): IpRule => ({ pref: entry.pref, from: `${entry.ip}/32`, table: entry.table })
        ),
        memory: first.memory
      })
    )
    expect(second.events.some((event) => event.kind === 'exhausted')).toBe(false)
    expect(second.waiting[0]?.reason).toBe('preferences exhausted')
  })

  it('says so again after the range was widened and filled up once more', () => {
    const first = planBindingReconciliation(input({ policy: narrow(2) }))
    const rules = first.desired.map(
      (entry): IpRule => ({ pref: entry.pref, from: `${entry.ip}/32`, table: entry.table })
    )

    const widened = planBindingReconciliation(
      input({ rules, memory: first.memory })
    )
    expect(widened.waiting).toHaveLength(0)
    expect(widened.memory.prefsExhausted).toBe(false)

    const again = planBindingReconciliation(
      input({
        policy: narrow(2),
        rules: widened.desired.map(
          (entry): IpRule => ({ pref: entry.pref, from: `${entry.ip}/32`, table: entry.table })
        ),
        memory: widened.memory
      })
    )
    expect(again.events.some((event) => event.kind === 'exhausted')).toBe(true)
  })

  it('keeps a device that was already bound when its preference went away', () => {
    // One usable preference and two devices whose stored rules both claim it -
    // the shape a corrupt snapshot leaves behind. Both were in the assignment
    // map before the waiting queue was built, so the loser used to appear on
    // neither table.
    const result = planBindingReconciliation(
      input({
        policy: narrow(1),
        leases: [LEASES[0]!, LEASES[1]!],
        rules: [
          { pref: 20_000, from: '192.168.10.2/32', table: 10_001 },
          { pref: 20_000, from: '192.168.10.3/32', table: 10_002 }
        ]
      })
    )

    expect(result.devices).toEqual({ total: 2, bound: 1, waiting: 1 })
    expect(reasons(result.waiting)).toEqual(['00:11:22:33:44:03: preferences exhausted'])
    expect(result.events.some((event) => event.kind === 'exhausted')).toBe(true)
  })
})

describe('the other reasons a device is not bound', () => {
  it('distinguishes an empty WAN pool from an exhausted range', () => {
    const result = planBindingReconciliation(input({ wans: [], tableToWan: [] }))

    expect(reasons(result.waiting)).toEqual([
      '00:11:22:33:44:02: waiting for a free WAN',
      '00:11:22:33:44:03: waiting for a free WAN',
      '00:11:22:33:44:04: waiting for a free WAN'
    ])
    expect(result.events.some((event) => event.kind === 'exhausted')).toBe(false)
    expect(result.memory.prefsExhausted).toBe(false)
  })

  it('does not tell a device someone unassigned by hand to wait for a WAN', () => {
    const bound = planBindingReconciliation(input())
    const held = planBindingReconciliation(
      input({
        rules: bound.desired.map(
          (entry): IpRule => ({ pref: entry.pref, from: `${entry.ip}/32`, table: entry.table })
        ),
        memory: { ...bound.memory, heldMacs: ['00:11:22:33:44:02'] }
      })
    )

    const row = held.waiting.find((entry) => entry.mac === '00:11:22:33:44:02')
    expect(row?.held).toBe(true)
    expect(row?.reason).toBe('unassigned by hand')
  })
})
