import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { BindingPlannerWan } from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import {
  DirectEngine,
  freeDirectPref,
  planDirectReconciliation,
  type DirectMemoryEntry,
  type DirectPolicy,
  type DirectReconcileInput
} from '../../openwrt/main/direct'
import { DIRECT_PREF_SPAN } from '../../openwrt/main/records'
import { HostStore, type DirectBindingRecord } from '../../openwrt/main/store'
import type { IpRule, Lease, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * Binding 1-1 decided entirely in memory.
 *
 * Every rule this feature ever puts on a router comes out of one pure function,
 * so the assertions below are on the exact command strings rather than on "a
 * rule survived". That matters most for hold: a rule left pointing at a WAN
 * with no route does not fail, it falls through to the main table and out the
 * router's default connection - which looks identical to a working binding from
 * anywhere except the emitted lines.
 */

const T0 = 1_700_000_000_000

const POLICY: DirectPolicy = {
  directPrefBase: DEFAULT_RULES.directPrefBase,
  catchAllTable: DEFAULT_RULES.catchAllTable,
  ruleChunkLines: DEFAULT_RULES.ruleChunkLines,
  releaseGraceSec: DEFAULT_RULES.releaseGraceSec,
  wanWarnUptimeSec: DEFAULT_RULES.wanWarnUptimeSec
}

const BASE = POLICY.directPrefBase
const BLACKHOLE = POLICY.catchAllTable

/**
 * The kernel's main table by number, because that is how the pass writes it -
 * `ip rule add ... lookup main` needs `/etc/iproute2/rt_tables` to resolve the
 * name and a build carrying ip-tiny has no such file.
 */
const MAIN = 254

const DEL = `ip -4 rule del pref ${BASE} 2>/dev/null || true`
const ADD_WAN = `ip -4 rule add from 192.168.1.50/32 lookup 42 pref ${BASE}`
const ADD_HELD = `ip -4 rule add from 192.168.1.50/32 lookup ${BLACKHOLE} pref ${BASE}`
const ADD_MAIN = `ip -4 rule add from 192.168.1.50/32 lookup ${MAIN} pref ${BASE}`
const BLACKHOLE_ROUTE = `ip -4 route replace unreachable default table ${BLACKHOLE}`

const MAC = 'a4:b1:c2:00:11:22'

/** The subnet every fixture record is stamped against, as this tick sees it. */
const LAN_CIDRS = new Map([['lan', '192.168.1.0/24']])

function wan(over: Partial<BindingPlannerWan> = {}): BindingPlannerWan {
  return {
    name: 'wan',
    table: 42,
    up: true,
    pending: false,
    ipv4: '198.51.100.5',
    uptimeSec: 4_000,
    ...over
  }
}

function record(over: Partial<DirectBindingRecord> = {}): DirectBindingRecord {
  return {
    id: 'dir_aaa111',
    name: 'Printer',
    target: { kind: 'ip', ip: '192.168.1.50' },
    wan: 'wan',
    enabled: true,
    whenDown: 'hold',
    pref: BASE,
    table: 42,
    lan: 'lan',
    slot: 0,
    createdAt: 1,
    ...over
  }
}

function lease(mac: string, ip: string): Lease {
  return { expires: T0 / 1000 + 3_600, mac, ip, host: 'device' }
}

function rule(ip: string, table: number, pref = BASE): IpRule {
  return { pref, from: `${ip}/32`, table }
}

function memory(over: Partial<DirectMemoryEntry> = {}): DirectMemoryEntry {
  return {
    id: 'dir_aaa111',
    ip: '192.168.1.50',
    missingSince: 0,
    state: 'bound',
    since: T0 - 60_000,
    ...over
  }
}

function plan(over: Partial<DirectReconcileInput> = {}) {
  return planDirectReconciliation({
    now: T0,
    records: [],
    leases: [],
    rules: [],
    wans: [wan()],
    lanCidrs: LAN_CIDRS,
    memory: [],
    policy: POLICY,
    ...over
  })
}

// ------------------------------------------------------------ the preference

describe('a one-to-one binding is stamped with a preference from its own band', () => {
  const model = (rules: IpRule[]): RouterModel =>
    ({
      t: T0,
      sys: { uptimeSec: 4_000, load1: 0, memTotal: 0, memFree: 0 },
      ifaces: [],
      poolDev: { count: 0, rx: 0, tx: 0 },
      leases: [],
      rules,
      rates: {}
    }) as RouterModel

  it('takes the lowest number nothing else in the band holds', () => {
    const taken = [record({ id: 'a', pref: BASE }), record({ id: 'b', pref: BASE + 1 })]
    expect(freeDirectPref(BASE, taken, [], model([]))).toBe(BASE + 2)
  })

  it('counts a rule already on the router as taken even when no record claims it', () => {
    // A build that crashed between the `ip rule add` and the store write leaves
    // exactly this: a real rule nothing owns. Handing its number to a new
    // binding would make the two indistinguishable.
    expect(freeDirectPref(BASE, [], [], model([rule('10.0.0.9', 900, BASE)]))).toBe(BASE + 1)
  })

  it('counts a create that is still in flight', () => {
    expect(freeDirectPref(BASE, [], [record({ pref: BASE })], model([]))).toBe(BASE + 1)
  })

  it('ignores rules on either side of the band', () => {
    const outside = [rule('10.0.0.1', 900, BASE - 1), rule('10.0.0.2', 900, BASE + DIRECT_PREF_SPAN)]
    expect(freeDirectPref(BASE, [], [], model(outside))).toBe(BASE)
  })

  it('answers 0 when the whole band is spoken for', () => {
    const full = Array.from({ length: DIRECT_PREF_SPAN }, (_, index) =>
      record({ id: `d${index}`, pref: BASE + index })
    )
    expect(freeDirectPref(BASE, full, [], model([]))).toBe(0)
  })
})

// ------------------------------------------------------------- the two targets

describe('what a binding names', () => {
  it('writes an IP target at its stamped priority and table', () => {
    const result = plan({ records: [record()] })

    expect(result.diff.addLines).toEqual([ADD_WAN])
    // The delete in front of the add is unconditional: a record stamped outside
    // today's band is invisible in the read-back, and without it the same rule
    // would be stacked onto the router once per tick.
    expect(result.diff.deleteLines).toEqual([DEL])
    expect(result.routeLines).toEqual([])
    expect(result.rows[0]?.state).toBe('bound')
    expect(result.totals).toEqual({ ok: 1, held: 0 })
  })

  it('resolves a MAC target through the current leases', () => {
    const result = plan({
      records: [record({ target: { kind: 'mac', mac: MAC } })],
      leases: [lease(MAC, '192.168.1.77')]
    })

    expect(result.diff.addLines).toEqual([
      `ip -4 rule add from 192.168.1.77/32 lookup 42 pref ${BASE}`
    ])
    expect(result.rows[0]?.address).toBe('192.168.1.77')
  })

  it('writes nothing for a MAC that has never been seen', () => {
    const result = plan({ records: [record({ target: { kind: 'mac', mac: MAC } })] })

    expect(result.diff.lines).toEqual([])
    expect(result.rows[0]?.state).toBe('waiting')
    expect(result.rows[0]?.address).toBe('')
  })

  it('leaves rules outside the band alone', () => {
    // The band is what this pass owns. A rule above it belongs to the instance
    // half and one below it to somebody else entirely, and neither is ours to
    // delete because it happens to be in the same table.
    const result = plan({
      records: [record()],
      rules: [
        rule('192.168.1.60', 42, BASE - 1),
        rule('192.168.1.61', 42, BASE + DIRECT_PREF_SPAN)
      ]
    })

    expect(result.diff.deleteLines).toEqual([DEL])
    expect(result.diff.lines.join('\n')).not.toContain(String(BASE - 1))
    expect(result.diff.lines.join('\n')).not.toContain(String(BASE + DIRECT_PREF_SPAN))
  })
})

// --------------------------------------------------------- a device that moves

describe('a MAC target whose address changes', () => {
  it('deletes the rule at the old address and adds one at the new', () => {
    const result = plan({
      records: [record({ target: { kind: 'mac', mac: MAC } })],
      leases: [lease(MAC, '192.168.1.88')],
      rules: [rule('192.168.1.77', 42)],
      memory: [memory({ ip: '192.168.1.77' })]
    })

    expect(result.diff.deleteLines).toEqual([DEL])
    expect(result.diff.addLines).toEqual([
      `ip -4 rule add from 192.168.1.88/32 lookup 42 pref ${BASE}`
    ])
    expect(result.events.map((event) => event.kind)).toEqual(['moved'])
  })

  it('writes nothing at all while the address is unchanged', () => {
    const result = plan({
      records: [record({ target: { kind: 'mac', mac: MAC } })],
      leases: [lease(MAC, '192.168.1.77')],
      rules: [rule('192.168.1.77', 42)],
      memory: [memory({ ip: '192.168.1.77' })]
    })

    expect(result.diff.lines).toEqual([])
    expect(result.events).toEqual([])
  })
})

describe('a MAC target whose lease disappears', () => {
  const missing = {
    records: [record({ target: { kind: 'mac', mac: MAC } })],
    leases: [],
    rules: [rule('192.168.1.77', 42)]
  }

  it('keeps the rule at the last known address for the release grace', () => {
    // The same grace the instance planner gives a disappearing device: a laptop
    // that sleeps for thirty seconds should not lose and regain its WAN.
    const result = plan({ ...missing, memory: [memory({ ip: '192.168.1.77' })] })

    expect(result.diff.lines).toEqual([])
    expect(result.rows[0]?.state).toBe('bound')
    expect(result.memory[0]?.ip).toBe('192.168.1.77')
    expect(result.memory[0]?.missingSince).toBe(T0)
  })

  it('removes the rule once the grace has run out', () => {
    const result = plan({
      ...missing,
      now: T0 + POLICY.releaseGraceSec * 1000 + 1_000,
      memory: [memory({ ip: '192.168.1.77', missingSince: T0 })]
    })

    expect(result.diff.deleteLines).toEqual([DEL])
    expect(result.diff.addLines).toEqual([])
    expect(result.rows[0]?.state).toBe('waiting')
    expect(result.events.map((event) => event.kind)).toEqual(['released'])
  })
})

// ------------------------------------------------------------------- the WAN

describe('holding when the WAN is unusable', () => {
  const down = { records: [record({ whenDown: 'hold' })], wans: [wan({ up: false })] }

  it('re-points the rule at the blackhole table and installs the blackhole first', () => {
    // Not "keeps the rule". A rule whose table has no matching route does not
    // return unreachable: the kernel walks on to the next rule and out the main
    // table - the default connection, which is the leak holding exists to stop.
    const result = plan({ ...down, rules: [rule('192.168.1.50', 42)], memory: [memory()] })

    expect(result.routeLines).toEqual([BLACKHOLE_ROUTE])
    expect(result.diff.deleteLines).toEqual([DEL])
    expect(result.diff.addLines).toEqual([ADD_HELD])
    expect(result.rows[0]?.state).toBe('held')
    expect(result.totals).toEqual({ ok: 0, held: 1 })
  })

  it('writes the blackhole on a router that has never had one', () => {
    // Nothing else installs it: an `unreachable default` in this table is put
    // there by a binding instance's catch-all, and a router with no instance
    // has never had one written.
    const result = plan(down)

    expect(result.routeLines).toEqual([BLACKHOLE_ROUTE])
    expect(result.diff.addLines).toEqual([ADD_HELD])
  })

  it('says nothing more once the rule is already parked', () => {
    const result = plan({
      ...down,
      rules: [rule('192.168.1.50', BLACKHOLE)],
      memory: [memory({ state: 'held' })]
    })

    expect(result.diff.lines).toEqual([])
    expect(result.routeLines).toEqual([])
  })

  it('holds a WAN that is up but has lost its routing table', () => {
    const result = plan({ records: [record()], wans: [wan({ table: null })] })

    expect(result.diff.addLines).toEqual([ADD_HELD])
  })

  it('holds a WAN the sample does not carry at all', () => {
    const result = plan({ records: [record()], wans: [] })

    expect(result.diff.addLines).toEqual([ADD_HELD])
  })
})

describe('falling back when the WAN is unusable', () => {
  const down = {
    records: [record({ whenDown: 'fallback' })],
    wans: [wan({ up: false })]
  }

  it('re-points the rule at the main table instead of writing nothing', () => {
    // Writing nothing rested on "the address falls through to main", which is
    // only true on a router where nothing else matches it. A binding instance's
    // catch-all does match, and sends it to the unreachable table - so the
    // option chosen to keep the device online produced a total outage. A rule
    // at the stamped preference pointing at main reaches the default connection
    // from underneath that catch-all, and is right on a router with no instance
    // at all.
    const result = plan({ ...down, rules: [rule('192.168.1.50', 42)], memory: [memory()] })

    expect(result.diff.deleteLines).toEqual([DEL])
    expect(result.diff.addLines).toEqual([ADD_MAIN])
    expect(result.routeLines).toEqual([])
    expect(result.rows[0]?.state).toBe('fallback')
    expect(result.events.map((event) => event.kind)).toEqual(['fallback'])
    expect(result.events[0]?.text).toContain('main table')
  })

  it('says in the row that a rule is installed, and which one', () => {
    // An empty cell here read as "nothing is on the router", which is how a
    // fallback binding looked harmless while its traffic was being swallowed.
    // Spelled `main` rather than 254 because that is what `ip rule show`
    // prints, and this cell exists to be compared with it by eye.
    const result = plan({ ...down, memory: [memory()] })

    expect(result.rows[0]?.rule).toBe(`from 192.168.1.50/32 lookup main pref ${BASE}`)
  })

  it('writes that rule once rather than once per tick', () => {
    // `ip -4 rule show` prints table 254 back as `main` and the sample's parser
    // records numeric tables only, so this rule is absent from every read-back
    // it will ever appear in. Taking that absence at face value would del+add
    // it every two seconds for ever, with the address unrouted in between.
    const result = plan({ ...down, rules: [], memory: [memory({ state: 'fallback' })] })

    expect(result.diff.lines).toEqual([])
  })

  it('takes the main-table rule off again when the WAN recovers', () => {
    const result = plan({
      records: [record({ whenDown: 'fallback' })],
      rules: [],
      memory: [memory({ state: 'fallback' })]
    })

    expect(result.diff.deleteLines).toEqual([DEL])
    expect(result.diff.addLines).toEqual([ADD_WAN])
    expect(result.rows[0]?.state).toBe('bound')
    expect(result.events.map((event) => event.kind)).toEqual(['bound'])
  })
})

// ------------------------------------------------- a device on the wrong LAN

describe('a bound device that turns up on another LAN', () => {
  const GUEST = '192.168.9.40'
  const roamed = {
    records: [record({ target: { kind: 'mac', mac: MAC } })],
    leases: [lease(MAC, GUEST)],
    rules: [rule('192.168.1.77', 42)],
    memory: [memory({ ip: '192.168.1.77' })]
  }

  it('stops claiming the binding is bound', () => {
    // The rule and the scoped firewall forwarding were written together, for
    // one LAN, and only the rule follows the device. On a guest SSID or a
    // second VLAN the address is still policy-routed into the bound WAN's table
    // while fw4 has no forwarding from the zone it is now in, so every packet
    // is dropped - and both the row and the `direct` stream said "bound".
    const result = plan(roamed)

    expect(result.rows[0]?.state).toBe('stranded')
    expect(result.rows[0]?.address).toBe(GUEST)
    // Counted as held, because the next test proves the rule it is written to
    // carry looks up the blackhole table. This assertion read `held: 0` until
    // the Overview tile that exists to surface exactly this condition was found
    // reporting nothing on the one router that needs it.
    expect(result.totals).toEqual({ ok: 0, held: 1 })
    expect(result.events.map((event) => event.kind)).toEqual(['stranded'])
    expect(result.events[0]?.text).toContain('no firewall path')
  })

  it('parks it on the blackhole, which is what its owner asked for', () => {
    const result = plan(roamed)

    expect(result.diff.addLines).toEqual([
      `ip -4 rule add from ${GUEST}/32 lookup ${BLACKHOLE} pref ${BASE}`
    ])
    expect(result.routeLines).toEqual([BLACKHOLE_ROUTE])
    expect(result.rows[0]?.rule).toBe(`from ${GUEST}/32 lookup ${BLACKHOLE} pref ${BASE}`)
  })

  it('is left neither without a rule nor with one aimed at the WAN', () => {
    // `waiting` would have been the easy answer and it is the wrong one: with
    // no rule the address leaves through the main table, which is the leak
    // holding exists to deny. Leaving the rule pointing at the bound WAN is the
    // other wrong answer, and it is the one that shipped.
    const result = plan(roamed)

    expect(result.rows[0]?.state).not.toBe('waiting')
    expect(result.diff.addLines).toHaveLength(1)
    expect(result.diff.addLines[0]).not.toContain('lookup 42')
  })

  it('never resurrects the address the device has just left', () => {
    // Which is why the gate is not inside the address resolution: answering ''
    // there falls into the release-grace branch, and the pass would go on
    // writing a rule for the abandoned address for five minutes. If dnsmasq has
    // already handed that address to somebody else, that somebody else is the
    // one policy-routed onto the bound WAN.
    const result = plan(roamed)

    expect(result.diff.lines.join('\n')).not.toContain('192.168.1.77/32')
    expect(result.memory[0]?.ip).toBe(GUEST)
  })

  it('hands it to the default connection when that is what its owner chose', () => {
    const result = plan({
      ...roamed,
      records: [record({ target: { kind: 'mac', mac: MAC }, whenDown: 'fallback' })]
    })

    expect(result.diff.addLines).toEqual([
      `ip -4 rule add from ${GUEST}/32 lookup ${MAIN} pref ${BASE}`
    ])
    expect(result.routeLines).toEqual([])
    expect(result.rows[0]?.rule).toBe(`from ${GUEST}/32 lookup main pref ${BASE}`)
  })

  it('does not act on a LAN this tick could not read', () => {
    // An absent subnet is not evidence that the device moved, and one short
    // interface dump must not strand every binding on the router - the same way
    // every other unreadable sample in this module is treated.
    const result = plan({ ...roamed, lanCidrs: new Map() })

    expect(result.rows[0]?.state).toBe('bound')
    expect(result.diff.addLines).toEqual([
      `ip -4 rule add from ${GUEST}/32 lookup 42 pref ${BASE}`
    ])
  })
})

// --------------------------------------------------- the band moving under it

describe('moving the one-to-one priority base while bindings exist', () => {
  // `desired` is built from the number each record was stamped with, and that
  // number deliberately never moves. Reading `actual` back from the band
  // today's settings define made the two disagree about every live binding the
  // moment the setting was edited: a del+add on every fast tick for ever, with
  // the rule momentarily absent each cycle - which for a held binding is the
  // leak holding exists to deny.
  const moved: DirectPolicy = { ...POLICY, directPrefBase: BASE + 500 }

  it('leaves a record stamped outside the new band exactly where it is', () => {
    const result = plan({
      records: [record()],
      rules: [rule('192.168.1.50', 42)],
      memory: [memory()],
      policy: moved
    })

    expect(result.diff.lines).toEqual([])
  })

  it('still cleans up a rule in the band that no record claims', () => {
    const result = plan({
      rules: [rule('192.168.1.99', 42, BASE + 500)],
      policy: moved
    })

    expect(result.diff.deleteLines).toEqual([
      `ip -4 rule del pref ${BASE + 500} 2>/dev/null || true`
    ])
    expect(result.diff.addLines).toEqual([])
  })
})

// ------------------------------------------------------ what the engine holds

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

function routerModel(t: number, leases: Lease[]): RouterModel {
  return {
    t,
    sys: { uptimeSec: 4_000, load1: 0, memTotal: 0, memFree: 0 },
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
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        l3Device: 'eth1',
        up: true,
        pending: false,
        autostart: true,
        uptimeSec: 4_000,
        ip4Table: 42,
        ipv4: { addr: '198.51.100.5', mask: 24 }
      }
    ],
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases,
    rules: [],
    rates: {}
  }
}

function engineOver(records: DirectBindingRecord[]): DirectEngine {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 3,
      instances: [],
      direct: records,
      extraTables: [],
      stickyPacked: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  const rules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  return new DirectEngine({
    ctx: harness.ctx,
    store,
    rules: () => rules,
    latestModel: () => null
  })
}

describe('the addresses the instance planner is told to leave alone', () => {
  it('keeps reserving one for as long as its rule stands', async () => {
    const engine = engineOver([record({ target: { kind: 'mac', mac: MAC } })])
    const seen = routerModel(T0, [lease(MAC, '192.168.1.77')])
    await engine.onSample(seen)

    expect(engine.reservedIps(seen)).toEqual(['192.168.1.77'])

    // The lease is gone and the rule is not: the pass holds it at the last
    // known address for the release grace. Answering "free" for those five
    // minutes told the instance planner it could hand the address out while a
    // 1-1 rule for it stood on the router, so a lease dnsmasq re-issued in that
    // window steered a completely different device onto the bound WAN.
    const asleep = routerModel(T0 + 1_000, [])
    await engine.onSample(asleep)

    expect(engine.rows()[0]?.rule).toContain('192.168.1.77/32')
    expect(engine.reservedIps(asleep)).toEqual(['192.168.1.77'])
  })

  it('releases it on the same pass that takes the rule off', async () => {
    const engine = engineOver([record({ target: { kind: 'mac', mac: MAC } })])
    await engine.onSample(routerModel(T0, [lease(MAC, '192.168.1.77')]))
    await engine.onSample(routerModel(T0 + 1_000, []))

    const expired = routerModel(T0 + POLICY.releaseGraceSec * 1_000 + 2_000, [])
    await engine.onSample(expired)

    expect(engine.rows()[0]?.rule).toBe('')
    expect(engine.reservedIps(expired)).toEqual([])
  })
})

describe('a binding that is switched off', () => {
  it('has no rule, and its old one is removed', () => {
    const result = plan({
      records: [record({ enabled: false })],
      rules: [rule('192.168.1.50', 42)],
      memory: [memory()]
    })

    expect(result.diff.deleteLines).toEqual([DEL])
    expect(result.diff.addLines).toEqual([])
    expect(result.rows[0]?.state).toBe('disabled')
    expect(result.totals).toEqual({ ok: 0, held: 0 })
  })

  it('is not held either, however far down its WAN is', () => {
    // Hold is about a WAN that failed. Switched off is a statement that this
    // address is not spoken for, and parking it on the blackhole would take it
    // off the internet for as long as the binding stayed disabled.
    const result = plan({
      records: [record({ enabled: false, whenDown: 'hold' })],
      wans: [wan({ up: false })]
    })

    expect(result.diff.lines).toEqual([])
    expect(result.routeLines).toEqual([])
  })
})

// ------------------------------------------- two bindings, one address

describe('two bindings that end up claiming the same address', () => {
  /**
   * The create gate refuses an address another binding already holds, and it
   * cannot refuse this one: the MAC target was created while its device was
   * offline, so at that moment it had no address to compare. The lease it takes
   * later is the one the IP binding was created for, and both records then
   * believe they steer it.
   */
  const printer = record({ id: 'dir_aaa111', name: 'Printer', pref: BASE, slot: 0 })
  const laptop = record({
    id: 'dir_bbb222',
    name: 'Laptop',
    target: { kind: 'mac', mac: MAC },
    pref: BASE + 1,
    slot: 1
  })
  const collided = { records: [printer, laptop], leases: [lease(MAC, '192.168.1.50')] }

  it('writes one rule, and it is the lower priority one', () => {
    // Which is what the kernel would do with both of them anyway: the fib rule
    // walk takes the lowest preference that matches and never reaches the
    // second. Writing both meant the page reported a binding as in force while
    // the address left through the other one's WAN.
    const result = plan(collided)

    expect(result.diff.addLines).toEqual([ADD_WAN])
    expect(result.desired.map((entry) => entry.id)).toEqual(['dir_aaa111'])
  })

  it('says on the losing row which binding is holding its address', () => {
    const result = plan(collided)
    const row = result.rows.find((entry) => entry.id === 'dir_bbb222')

    expect(row?.state).toBe('shadowed')
    // Empty because nothing is installed for it, which is the one state where
    // an empty rule cell is the truth rather than a missing read-back.
    expect(row?.rule).toBe('')
    expect(row?.stateBadges.map((chip) => chip.label)).toEqual([
      'not in force',
      'held by Printer'
    ])
  })

  it('counts the address once rather than once per record', () => {
    const result = plan(collided)

    expect(result.rows.map((entry) => entry.state)).toEqual(['bound', 'shadowed'])
    expect(result.totals).toEqual({ ok: 1, held: 0 })
  })

  it('names the holder in the trail as well, the moment the collision starts', () => {
    const result = plan({
      ...collided,
      memory: [memory(), memory({ id: 'dir_bbb222', ip: '192.168.1.90' })]
    })

    const event = result.events.find((entry) => entry.kind === 'shadowed')
    expect(event?.text).toContain('already bound by Printer')
    expect(result.events.map((entry) => entry.kind)).toEqual(['shadowed'])
  })

  it('gives the second binding its rule back once the addresses differ', () => {
    // The positive control: without it every assertion above would pass on a
    // pass that had simply stopped writing a second rule at all.
    const result = plan({ records: [printer, laptop], leases: [lease(MAC, '192.168.1.90')] })

    expect(result.rows.map((entry) => entry.state)).toEqual(['bound', 'bound'])
    expect(result.diff.addLines).toEqual([
      ADD_WAN,
      `ip -4 rule add from 192.168.1.90/32 lookup 42 pref ${BASE + 1}`
    ])
  })

  it('lets a switched-off binding hold nothing at all', () => {
    // Being disabled is exactly the statement that this address is not spoken
    // for, so the record underneath it must not be told it is shadowed.
    const result = plan({
      records: [record({ ...printer, enabled: false }), laptop],
      leases: [lease(MAC, '192.168.1.50')]
    })

    expect(result.rows.map((entry) => entry.state)).toEqual(['disabled', 'bound'])
    expect(result.diff.addLines).toEqual([
      `ip -4 rule add from 192.168.1.50/32 lookup 42 pref ${BASE + 1}`
    ])
  })
})

// ------------------------------------------------------------ renaming one

describe('renaming a binding that already exists', () => {
  it('refuses a name the create gate would have refused, in the same words', async () => {
    // The name reaches job labels, event rows and `ctx.log`, and a newline in
    // it forges a whole log line. Update only measured the length, so the one
    // field the create gate guards had a second door standing open beside it.
    const engine = engineOver([record()])

    expect(await engine.update('dir_aaa111', { name: 'Printer\ndeleted binding Printer' })).toEqual({
      ok: false,
      error: 'binding name must contain 1-80 characters on one line'
    })
  })

  it('takes an ordinary rename', async () => {
    const engine = engineOver([record()])

    expect(await engine.update('dir_aaa111', { name: 'Front desk printer' })).toEqual({ ok: true })
    expect(engine.rows()[0]?.name).toBe('Front desk printer')
  })
})

// ------------------------------------------------------- the create job

/**
 * A router whose `lan` is a bridge, whose `wan` already has table 42, and whose
 * second uplink `uplink2` is a plain port carrying a static address - which is
 * the shape the LAN search used to mistake for a downstream network.
 */
const PREPARATION_PROBE = [
  '===DHCP===',
  'dhcp.lan=dhcp',
  "dhcp.lan.interface='lan'",
  '===NETWORK===',
  'network.lan=interface',
  "network.lan.device='br-lan'",
  'network.wan=interface',
  "network.wan.device='eth1'",
  "network.wan.ip4table='42'",
  'network.uplink2=interface',
  "network.uplink2.device='eth2'",
  '===FIREWALL===',
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan'",
  'firewall.@zone[1]=zone',
  "firewall.@zone[1].name='wan'",
  "firewall.@zone[1].network='wan'",
  "firewall.@zone[1].network='uplink2'",
  "firewall.@zone[1].masq='1'",
  '===SYSCTL===',
  'net.netfilter.nf_conntrack_max=65536'
].join('\n')

/** The second uplink: static protocol, no bridge, its own private subnet. */
const UPLINK2: RouterModel['ifaces'][number] = {
  name: 'uplink2',
  proto: 'static',
  device: 'eth2',
  l3Device: 'eth2',
  up: true,
  pending: false,
  autostart: true,
  uptimeSec: 4_000,
  ipv4: { addr: '192.168.50.1', mask: 24 }
}

interface CreateFixture {
  engine: DirectEngine
  store: HostStore
  /** Every `sh -s` body the engine sent, in order. */
  scripts: string[]
}

/**
 * An engine with a router behind it that answers both probes, so `check` and
 * `apply` can actually be driven. `ruleWritesFail` stands in for a router that
 * takes the firewall change and then refuses the `ip rule` - which is the only
 * way to reach the window between the forwarding and the record.
 */
function createFixture(
  options: { extraIfaces?: RouterModel['ifaces']; ruleWritesFail?: boolean } = {}
): CreateFixture {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 3,
      instances: [],
      direct: [],
      extraTables: [],
      stickyPacked: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  const scripts: string[] = []
  harness.exec.mockImplementation(async (command, execOptions) => {
    const stdin = execOptions?.stdin ?? ''
    if (command === 'sh -s') scripts.push(stdin)
    if (stdin.includes("echo '===DHCP==='")) return ok(PREPARATION_PROBE)
    if (stdin.includes('bm_wanbind')) return ok('===DONE===')
    if (options.ruleWritesFail && stdin.includes('ip -4 rule')) {
      return { code: 1, stdout: '', stderr: '' }
    }
    return ok()
  })
  const rules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  const model = routerModel(T0, [])
  model.ifaces.push(...(options.extraIfaces ?? []))
  return {
    engine: new DirectEngine({
      ctx: harness.ctx,
      store,
      rules: () => rules,
      latestModel: () => model
    }),
    store,
    scripts
  }
}

const CREATE_VALUES = {
  name: 'Printer',
  targetKind: 'ip',
  address: '192.168.1.50',
  wan: 'wan',
  whenDown: 'hold'
}

const labels = (report: { findings: Array<{ label: string }> }): string =>
  report.findings.map((finding) => finding.label).join('\n')

/**
 * How many times slot 0's firewall sections were *removed*.
 *
 * Matched on the commit rather than on the delete alone: installing the
 * forwarding clears the same 32 section names first, so counting deletes would
 * count the install as a removal and the positive control below would pass on
 * an engine that never compensated anything.
 */
const removals = (scripts: readonly string[]): number =>
  scripts.filter(
    (body) => body.includes('uci -q delete firewall.bmd0_0') && body.includes('uci commit firewall')
  ).length

describe('a create that fails after the firewall step', () => {
  it('takes its own forwarding back off, so no bmd section is left unowned', async () => {
    // The forwarding is installed one step before the record. Failing in
    // between left `bmd0_` sections on the router that nothing owned: no record
    // names slot 0, so Delete could never be asked to remove them, and the next
    // create takes slot 1 rather than reusing this one - so they stayed for good.
    const run = createFixture({ ruleWritesFail: true })
    const report = await run.engine.check(CREATE_VALUES)
    expect(report.ok).toBe(true)

    const applied = await run.engine.apply({ token: report.token, values: CREATE_VALUES })

    expect(applied.ok).toBe(false)
    expect(run.store.read().direct).toEqual([])
    expect(removals(run.scripts)).toBe(1)
  })

  it('leaves the forwarding alone when the record was written', async () => {
    // The positive control, and the one case the compensation must not fire in:
    // a binding that exists needs the forwarding it is using.
    const run = createFixture()
    const report = await run.engine.check(CREATE_VALUES)
    expect(report.ok).toBe(true)

    expect(await run.engine.apply({ token: report.token, values: CREATE_VALUES })).toMatchObject({
      ok: true
    })
    expect(run.store.read().direct.map((entry) => entry.name)).toEqual(['Printer'])
    expect(removals(run.scripts)).toBe(0)
  })
})

describe('a second uplink that happens to carry a static address', () => {
  it('is not offered as the LAN an address sits behind', async () => {
    // It has a subnet and the address is inside it, which was the whole of the
    // old test - so the binding was stamped with a "LAN" that is really a WAN
    // and its firewall forwarding would have been written from the uplink's own
    // zone, leaving the device with no path from the zone it is actually on.
    //
    // The refusal names it now rather than staying silent about it. Saying only
    // "not inside any LAN subnet" was true and useless: it is the same sentence
    // a router whose LANs were all misclassified produced, which is how that
    // bug survived a release.
    const run = createFixture({ extraIfaces: [UPLINK2] })

    const report = await run.engine.check({ ...CREATE_VALUES, address: '192.168.50.20' })

    expect(report.ok).toBe(false)
    expect(labels(report)).toContain(
      '192.168.50.20 is on uplink2, which this router uses as an uplink rather than as a LAN'
    )
    // Named, but never chosen: nothing here says the binding would be written
    // from it, which is the fault the exclusion exists to prevent.
    expect(labels(report)).not.toContain('is on LAN uplink2')
  })

  it('still finds the bridge behind an address that really is on the LAN', async () => {
    // The positive control: the exclusion is about uplinks, not about every
    // interface running the static protocol - which is what a LAN runs too.
    const run = createFixture({ extraIfaces: [UPLINK2] })

    const report = await run.engine.check(CREATE_VALUES)

    expect(report.ok).toBe(true)
    expect(labels(report)).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })
})
