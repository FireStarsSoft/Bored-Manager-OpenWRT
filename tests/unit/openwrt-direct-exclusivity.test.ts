import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import {
  BindingEngine,
  planBindingReconciliation,
  type BindingPlannerPolicy,
  type BindingPlannerWan,
  type BindingReconcileInput
} from '../../openwrt/main/binding'
import { DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { DIRECT_PREF_SPAN } from '../../openwrt/main/records'
import { HostStore } from '../../openwrt/main/store'
import type { IpRule, Lease, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * An address bound one-to-one belongs to the other automation, and this one has
 * to leave it entirely alone.
 *
 * The dangerous case is not a fresh device - it is the **pre-existing
 * assignment**. A device already bound by an instance, then given a 1-1
 * binding, ends up with two rules for the same source: the instance's, and the
 * 1-1 rule underneath it in the direct band. The 1-1 rule wins on preference,
 * so nothing looks broken - while the instance goes on holding a WAN out of its
 * pool for a device whose traffic never touches it, for ever, because every one
 * of the three paths that can seat a device would happily re-adopt the rule it
 * already wrote. All three have to refuse, which is why all three are tested.
 *
 * The other half of the boundary is that the direct band is invisible from
 * here: it sits below `rulePrefBase`, and the instance planner must neither
 * adopt a rule in it nor plan to delete one.
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

/** The band the sibling automation writes in, below every rule this one reads. */
const DIRECT_PREF = DEFAULT_RULES.directPrefBase + 3

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

const ALICE = lease(5, 'alice')
const BOB = lease(6, 'bob')

/** One WAN and two devices, so "the WAN was freed" is a visible event. */
const WANS = [wan('pd00001', 10_001)]
const TABLES: Array<[number, string]> = [[10_001, 'pd00001']]

function input(overrides: Partial<BindingReconcileInput> = {}): BindingReconcileInput {
  return {
    now: NOW,
    instance: { id: 'bind_1', running: true, sticky: false, remap: false },
    lanCidr: '192.168.10.0/24',
    leases: [ALICE, BOB],
    rules: [],
    wans: WANS,
    tableToWan: TABLES,
    sticky: [],
    policy: POLICY,
    randomSeed: 7,
    ...overrides
  }
}

const ruleFor = (ip: string, pref: number, table: number): IpRule => ({
  pref,
  from: `${ip}/32`,
  table
})

describe('a device this instance had already bound, then bound one-to-one', () => {
  /** The state of the router the moment before the 1-1 binding is created. */
  function alreadyBound(): ReturnType<typeof planBindingReconciliation> {
    const first = planBindingReconciliation(input())
    expect(first.desired.map((entry) => entry.ip)).toEqual(['192.168.10.5'])
    return first
  }

  it('deletes the instance rule on the very next pass', () => {
    const first = alreadyBound()
    const standing = first.desired.map((entry) =>
      ruleFor(entry.ip, entry.pref, entry.table)
    )

    const second = planBindingReconciliation(
      input({
        rules: standing,
        memory: first.memory,
        reservedIps: ['192.168.10.5']
      })
    )

    // Not adopted, so it lands in the delete half of the diff rather than
    // surviving as an assignment nothing will ever remove.
    expect(second.ruleDiff.delete.map((change) => change.ip)).toContain('192.168.10.5')
    expect(second.desired.map((entry) => entry.ip)).not.toContain('192.168.10.5')
    expect(second.ruleDiff.deleteLines.join('\n')).toContain(
      `ip -4 rule del pref ${first.desired[0]?.pref}`
    )
  })

  it('hands the WAN it was holding back to the pool in the same pass', () => {
    // The reason the first gate exists at all. With one WAN between two
    // devices, a reservation that freed nothing would leave Bob waiting for
    // ever behind an address that is not using the WAN it holds.
    const first = alreadyBound()
    const standing = first.desired.map((entry) =>
      ruleFor(entry.ip, entry.pref, entry.table)
    )

    const second = planBindingReconciliation(
      input({
        rules: standing,
        memory: first.memory,
        reservedIps: ['192.168.10.5']
      })
    )

    expect(second.desired.map((entry) => entry.ip)).toEqual(['192.168.10.6'])
    expect(second.wan.bound).toBe(1)
    expect(second.assignments.map((row) => row.ip)).toEqual(['192.168.10.6'])
  })

  it('puts it in the waiting table saying it is bound one-to-one', () => {
    const first = alreadyBound()
    const second = planBindingReconciliation(
      input({
        rules: first.desired.map((entry) => ruleFor(entry.ip, entry.pref, entry.table)),
        memory: first.memory,
        reservedIps: ['192.168.10.5']
      })
    )

    const row = second.waiting.find((entry) => entry.ip === '192.168.10.5')
    // "waiting for a free WAN" would be a lie: no WAN coming free will ever
    // move this address, and nothing on this page can change that.
    expect(row?.reason).toBe('bound one-to-one')
    expect(second.devices).toEqual({ total: 2, bound: 1, waiting: 1 })
  })

  it('never allocates a reserved address that was not bound before either', () => {
    // The third gate on its own: no prior rule, no prior memory, just a lease
    // for an address the other automation owns.
    const result = planBindingReconciliation(input({ reservedIps: ['192.168.10.5'] }))

    expect(result.desired.map((entry) => entry.ip)).toEqual(['192.168.10.6'])
    expect(
      result.waiting.find((entry) => entry.ip === '192.168.10.5')?.reason
    ).toBe('bound one-to-one')
  })

  it('leaves both devices alone when nothing is reserved', () => {
    // The positive control. Without it every assertion above would pass on a
    // planner that had simply stopped binding anything.
    const first = alreadyBound()
    const second = planBindingReconciliation(
      input({
        rules: first.desired.map((entry) => ruleFor(entry.ip, entry.pref, entry.table)),
        memory: first.memory
      })
    )

    expect(second.desired.map((entry) => entry.ip)).toEqual(['192.168.10.5'])
    expect(second.ruleDiff.delete).toEqual([])
    expect(second.waiting[0]?.reason).toBe('waiting for a free WAN')
  })
})

describe('a rule left behind for a reserved address with no device to claim it', () => {
  /**
   * An orphan: a rule in the managed band whose source resolves to no current
   * lease, no remembered device and no sticky choice. It is normally kept alive
   * through the release grace so a router that has just restarted does not leak
   * a WAN while dnsmasq repopulates.
   */
  const ORPHAN = [ruleFor('192.168.10.77', POLICY.rulePrefBase, 10_001)]

  it('is preserved on grace while the address is nobody else business', () => {
    const result = planBindingReconciliation(input({ leases: [], rules: ORPHAN }))

    expect(result.desired.map((entry) => entry.ip)).toEqual(['192.168.10.77'])
    expect(result.wan.bound).toBe(1)
  })

  it('is not preserved once a one-to-one binding owns that address', () => {
    // The second gate. Matched on the rule's own source, because an orphan has
    // no device behind it to ask - and this rule is precisely the stale
    // instance rule the 1-1 binding replaced.
    const result = planBindingReconciliation(
      input({ leases: [], rules: ORPHAN, reservedIps: ['192.168.10.77'] })
    )

    expect(result.desired).toEqual([])
    expect(result.ruleDiff.delete.map((change) => change.ip)).toEqual(['192.168.10.77'])
    expect(result.wan.bound).toBe(0)
    expect(result.wan.available).toBe(1)
  })

  it('gives the freed WAN to a real lease instead of holding it for the orphan', () => {
    const result = planBindingReconciliation(
      input({ leases: [ALICE], rules: ORPHAN, reservedIps: ['192.168.10.77'] })
    )

    expect(result.desired.map((entry) => entry.ip)).toEqual(['192.168.10.5'])
  })
})

describe('the direct band is invisible to the instance planner', () => {
  const DIRECT = ruleFor('192.168.10.5', DIRECT_PREF, 10_001)

  it('sits below every preference this planner reads', () => {
    // The arithmetic the whole separation rests on: the band ends before the
    // client rules begin, so `readActualAssignments` and the preference
    // allocator both skip it without knowing it exists.
    expect(DEFAULT_RULES.directPrefBase + DIRECT_PREF_SPAN).toBeLessThanOrEqual(
      DEFAULT_RULES.rulePrefBase
    )
    expect(DIRECT_PREF).toBeLessThan(POLICY.rulePrefBase)
  })

  it('is neither adopted as an assignment nor planned for deletion', () => {
    const result = planBindingReconciliation(
      input({ rules: [DIRECT], reservedIps: ['192.168.10.5'] })
    )

    expect(result.actual).toEqual([])
    expect(result.ruleDiff.delete).toEqual([])
    expect(result.ruleDiff.lines.join('\n')).not.toContain(String(DIRECT_PREF))
    // And the address it names is still refused a WAN, by the queue gate.
    expect(result.desired.map((entry) => entry.ip)).toEqual(['192.168.10.6'])
  })

  it('is left alone even when the module has been told nothing is reserved', () => {
    // A reservation list that has not caught up yet - the 1-1 binding was
    // created between two fast samples - must still not turn the rule into
    // this instance's property.
    const result = planBindingReconciliation(input({ rules: [DIRECT] }))

    expect(result.actual).toEqual([])
    expect(result.ruleDiff.lines.join('\n')).not.toContain(String(DIRECT_PREF))
  })
})

// ------------------------------------------------- the engine that supplies it

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

const STAMPED = {
  tableBase: DEFAULT_RULES.tableBase,
  rulePrefBase: DEFAULT_RULES.rulePrefBase,
  catchAllPrefBase: DEFAULT_RULES.catchAllPrefBase,
  catchAllTable: DEFAULT_RULES.catchAllTable,
  zoneName: DEFAULT_RULES.zoneName
}

const MODEL: RouterModel = {
  t: NOW,
  sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
  ifaces: [
    {
      name: 'lan',
      proto: 'static',
      device: 'eth0',
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
      ip4Table: 10_001,
      ipv4: { addr: '198.51.100.1', mask: 32 }
    }
  ],
  poolDev: { count: 1, rx: 0, tx: 0 },
  leases: [{ expires: 0, mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.20', host: 'desk' }],
  rules: [],
  rates: {}
}

describe('the reservation the engine asks for on every pass', () => {
  function fixture(reserved: string[]): { engine: BindingEngine; scripts: string[] } {
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: {
        version: 1,
        nextSeq: 2,
        batches: [],
        instances: [
          {
            id: 'bind1',
            name: 'Office LAN',
            lan: 'lan',
            carrier: 'eth1',
            running: true,
            sticky: true,
            remap: true,
            createdAt: 1,
            slot: 0,
            layout: { ...STAMPED }
          }
        ],
        extraTables: [],
        stickyMap: [],
        events: [],
        moduleEvents: [],
        jobs: []
      }
    })
    const scripts: string[] = []
    harness.exec.mockImplementation(async (command, options) => {
      if (command === 'sh -s') scripts.push(options?.stdin ?? '')
      return ok()
    })
    const rules: OwrtRules = { ...DEFAULT_RULES }
    const store = new HostStore(harness.ctx, () => rules)
    return {
      engine: new BindingEngine(harness.ctx, store, {
        rules: () => rules,
        // A closure, not a value: a 1-1 binding created between two fast
        // samples has to take effect on the next tick, not on the next restart.
        reservedIps: () => reserved
      }),
      scripts
    }
  }

  it('writes no client rule for a reserved address and says why on the page', async () => {
    const run = fixture(['192.168.1.20'])

    await run.engine.onSample(structuredClone(MODEL))

    expect(run.scripts.join('\n')).not.toContain('from 192.168.1.20/32')
    expect(run.engine.rows('bind1')).toEqual([])
    expect(run.engine.waitingRows('bind1')[0]).toMatchObject({
      ip: '192.168.1.20',
      reason: 'bound one-to-one'
    })
  })

  it('binds the same address normally when nothing reserves it', async () => {
    const run = fixture([])

    await run.engine.onSample(structuredClone(MODEL))

    expect(run.scripts.join('\n')).toContain('ip -4 rule add from 192.168.1.20/32 lookup 10001')
    expect(run.engine.rows('bind1').map((row) => row.ip)).toEqual(['192.168.1.20'])
  })
})
