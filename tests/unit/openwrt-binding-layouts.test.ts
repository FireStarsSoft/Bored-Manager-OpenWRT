import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { IfaceState, IpRule, Lease, RouterModel } from '../../openwrt/main/types'
import { parseCidr, rangeToCidrs, subnetContains } from '../../openwrt/main/util'
import { moduleHarness } from '../helpers/module-harness'

/**
 * WAN Binding against the routers people actually have, rather than the one the
 * defaults describe.
 *
 * The bug this file was written after shipped because a LAN was assumed to be a
 * bridge: an interface was read as an uplink when its device name did not start
 * with `br-`, so a LAN on a VLAN, on a plain port or on a wireless netdev was
 * quietly classified as a WAN. A device name is not a fact about what an
 * interface is, and neither is a subnet count, a zone name or a protocol on its
 * own - so every claim the instance half makes is asserted here against each
 * layout in turn: a bridged LAN, a VLAN LAN, a bare-port LAN, a wireless-only
 * LAN, several LANs at once, a /25 inside a /24, a static double-NAT uplink, a
 * PPPoE uplink whose l3 device is not its carrier, a tagged-VLAN uplink, a
 * bridged uplink, a router with no LAN address at all, and a LAN whose subnet
 * collides with its own uplink's.
 */

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

const STAMPED = {
  tableBase: DEFAULT_RULES.tableBase,
  rulePrefBase: DEFAULT_RULES.rulePrefBase,
  catchAllPrefBase: DEFAULT_RULES.catchAllPrefBase,
  catchAllTable: DEFAULT_RULES.catchAllTable,
  zoneName: DEFAULT_RULES.zoneName
}

const CATCH_PREF = DEFAULT_RULES.catchAllPrefBase
const CATCH_TABLE = DEFAULT_RULES.catchAllTable

// ------------------------------------------------------------------ fixtures

interface LanShape {
  name: string
  /** The netdev the address is on: a bridge, a VLAN, a port or a wireless netdev. */
  device: string
  /** Only ever different from `device` on releases that report one and not the other. */
  l3Device?: string
  addr: string
  mask?: number
  up?: boolean
}

function lanIface(shape: LanShape): IfaceState {
  const up = shape.up ?? true
  return {
    name: shape.name,
    proto: 'static',
    device: shape.device,
    l3Device: shape.l3Device ?? shape.device,
    up,
    pending: false,
    autostart: true,
    uptimeSec: 4_000,
    // A netifd dump carries no `ipv4-address` for an interface that is down,
    // which is exactly how a LAN whose device has bounced arrives here.
    ...(up ? { ipv4: { addr: shape.addr, mask: shape.mask ?? 24 } } : {})
  }
}

interface WanShape {
  name: string
  proto?: string
  device: string
  l3Device?: string
  addr?: string
  mask?: number
  table?: number
}

function wanIface(shape: WanShape): IfaceState {
  return {
    name: shape.name,
    proto: shape.proto ?? 'dhcp',
    device: shape.device,
    l3Device: shape.l3Device ?? shape.device,
    up: true,
    pending: false,
    autostart: true,
    // Above `wanWarnUptimeSec`, so the WAN is available rather than warning.
    uptimeSec: 3_000,
    ipv4: { addr: shape.addr ?? '198.51.100.7', mask: shape.mask ?? 32 },
    ip4Table: shape.table ?? 10_001
  }
}

function lease(mac: string, ip: string, host = 'client'): Lease {
  return { expires: 0, mac, ip, host }
}

interface InstanceShape {
  id: string
  lan: string
  carrier: string
  slot?: number
  source?: { kind: 'range'; from: string; to: string }
}

function instanceRecord(shape: InstanceShape): Record<string, unknown> {
  return {
    id: shape.id,
    name: `Instance ${shape.id}`,
    lan: shape.lan,
    carrier: shape.carrier,
    running: true,
    sticky: true,
    remap: true,
    createdAt: 1,
    slot: shape.slot ?? 0,
    layout: { ...STAMPED },
    ...(shape.source ? { source: shape.source } : {})
  }
}

interface RouterShape {
  ifaces: IfaceState[]
  leases?: Lease[]
  rules?: IpRule[]
  instances?: InstanceShape[]
  reservedIps?: string[]
  /** Answered to every `sh -s` that carries the preparation probe. */
  probe?: string
}

interface Run {
  engine: BindingEngine
  store: HostStore
  scripts: string[]
  model: RouterModel
  /** The next fast sample, carrying whatever the last pass left on the router. */
  next(over?: { ifaces?: IfaceState[]; leases?: Lease[] }): RouterModel
}

function fixture(shape: RouterShape): Run {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 1,
      nextSeq: 2,
      batches: [],
      instances: (shape.instances ?? []).map(instanceRecord),
      extraTables: [],
      stickyMap: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  const scripts: string[] = []
  harness.exec.mockImplementation(async (command, options) => {
    const stdin = options?.stdin ?? ''
    if (command === 'sh -s' && stdin.includes("echo '===DHCP==='")) {
      return ok(shape.probe ?? '')
    }
    if (command === 'sh -s') scripts.push(stdin)
    return ok()
  })
  const rules: OwrtRules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  const model: RouterModel = {
    t: 1_700_000_000_000,
    sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
    ifaces: shape.ifaces,
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases: shape.leases ?? [],
    rules: shape.rules ?? [],
    rates: {}
  }
  const run: Run = {
    engine: new BindingEngine(harness.ctx, store, {
      rules: () => rules,
      ...(shape.reservedIps ? { reservedIps: () => shape.reservedIps ?? [] } : {})
    }),
    store,
    scripts,
    model,
    next: (over = {}) => {
      // The rules the engine folded back into the model are what the sweep
      // would read off the router on the next tick, so they are carried over
      // rather than reset: a test that dropped them would see every pass
      // install the catch-all again and never exercise the quiet path.
      run.model = {
        ...run.model,
        t: run.model.t + 5_000,
        sys: { ...run.model.sys, uptimeSec: run.model.sys.uptimeSec + 5 },
        rules: run.model.rules.map((rule) => ({ ...rule })),
        ...(over.ifaces ? { ifaces: over.ifaces } : {}),
        ...(over.leases ? { leases: over.leases } : {})
      }
      return run.model
    }
  }
  return run
}

const written = (run: Run): string => run.scripts.join('\n')

// ------------------------------------------------------------- the four LANs

/**
 * Row 1 to row 4 of the layout matrix. The stock bridge is the only one of the
 * four the old uplink test would have got right.
 */
const LAN_LAYOUTS: Array<{ what: string; device: string; l3Device?: string }> = [
  { what: 'a stock bridge', device: 'br-lan' },
  { what: 'a VLAN with no bridge', device: 'eth0.1' },
  { what: 'a plain switch port', device: 'eth0' },
  { what: 'a wireless netdev', device: 'wlan0' },
  { what: 'a bridge VLAN', device: 'br-lan.20' },
  // Some releases fill in one of the two device fields and not the other. The
  // one that is there is not a guess, it is the only thing the router said.
  { what: 'a port reported with no l3 device', device: 'eth0.1', l3Device: '' }
]

describe('a LAN the router really has, whatever it is carried on', () => {
  const bound = (device: string, l3Device?: string): Run =>
    fixture({
      ifaces: [
        lanIface({ name: 'lan', device, ...(l3Device != null ? { l3Device } : {}), addr: '192.168.1.1' }),
        wanIface({ name: 'wan', device: 'eth1', table: 10_001 })
      ],
      leases: [lease('aa:bb:cc:dd:ee:01', '192.168.1.60')],
      instances: [{ id: 'bind1', lan: 'lan', carrier: 'eth1' }]
    })

  it.each(LAN_LAYOUTS)('binds a client behind $what', async ({ device, l3Device }) => {
    const run = bound(device, l3Device)

    await run.engine.onSample(run.model)

    expect(run.engine.rows('bind1').map((row) => row.ip)).toEqual(['192.168.1.60'])
    expect(written(run)).toContain(
      'ip -4 rule add from 192.168.1.60/32 lookup 10001 pref 20000'
    )
  })

  it.each(LAN_LAYOUTS)('blackholes only its own subnet behind $what', async ({ device, l3Device }) => {
    const run = bound(device, l3Device)

    await run.engine.onSample(run.model)

    expect(written(run)).toContain(
      `ip -4 rule add from 192.168.1.0/24 lookup ${CATCH_TABLE} pref ${CATCH_PREF}`
    )
    expect(written(run)).toContain(`ip -4 route replace unreachable default table ${CATCH_TABLE}`)
  })

  it.each(LAN_LAYOUTS)('keeps answering on the LAN behind $what', async ({ device, l3Device }) => {
    /**
     * The connected route beside the blackhole, named after the device the LAN
     * actually carries IP on. A bridge is one of six answers here and there is
     * nothing to derive it from but what the sample says, so the route has to
     * follow the sample rather than a shape.
     */
    const run = bound(device, l3Device)

    await run.engine.onSample(run.model)

    expect(written(run)).toContain(
      `ip -4 route replace 192.168.1.0/24 dev ${device} scope link table ${CATCH_TABLE}`
    )
  })
})

// -------------------------------------------------- the route that goes away

describe('the connected route after the LAN device has been away', () => {
  /**
   * A VLAN LAN, because that is the layout where this happens most: a
   * `service network reload` destroys and recreates `eth0.1`, and the kernel
   * removes every route whose device went down - in every table, not only in
   * main. The `unreachable default` beside it has no device and survives, so
   * what is left is a router blackholing its own LAN: no SSH, no DHCP answers,
   * no ARP, until something unrelated happened to rebuild the rule group.
   */
  const bouncing = (): Run =>
    fixture({
      ifaces: [
        lanIface({ name: 'lan', device: 'eth0.1', addr: '192.168.1.1' }),
        wanIface({ name: 'wan', device: 'eth1' })
      ],
      leases: [lease('aa:bb:cc:dd:ee:01', '192.168.1.60')],
      instances: [{ id: 'bind1', lan: 'lan', carrier: 'eth1' }]
    })

  const ROUTE = `ip -4 route replace 192.168.1.0/24 dev eth0.1 scope link table ${CATCH_TABLE}`

  it('writes it again on the tick after the device comes back', async () => {
    const run = bouncing()
    await run.engine.onSample(run.model)

    // Down: netifd reports no address, so this instance has no subnet to plan
    // against and nothing at all is written for it.
    const down = run.next({
      ifaces: [
        lanIface({ name: 'lan', device: 'eth0.1', addr: '192.168.1.1', up: false }),
        wanIface({ name: 'wan', device: 'eth1' })
      ]
    })
    run.scripts.length = 0
    await run.engine.onSample(down)
    expect(written(run)).not.toContain('scope link table')

    // Up again, with the same rules still on the router. The rule group is
    // therefore correct and the old pass wrote nothing - which is precisely how
    // the route stayed missing for as long as the router stayed up.
    const back = run.next({
      ifaces: [
        lanIface({ name: 'lan', device: 'eth0.1', addr: '192.168.1.1' }),
        wanIface({ name: 'wan', device: 'eth1' })
      ]
    })
    run.scripts.length = 0
    await run.engine.onSample(back)

    expect(written(run)).toContain(ROUTE)
    // And only the route: the rules were never in doubt.
    expect(written(run)).not.toContain(`ip -4 rule del pref ${CATCH_PREF}`)
  })

  it('leaves it alone on a tick where nothing about the LAN changed', async () => {
    // The control for the assertion above: re-asserting the route on every
    // sample would be a round trip to the router every two seconds, for ever.
    const run = bouncing()
    await run.engine.onSample(run.model)

    run.scripts.length = 0
    await run.engine.onSample(run.next())

    expect(written(run)).not.toContain('scope link table')
  })

  it('follows the LAN onto a different device', async () => {
    // The LAN was moved from a bridge to a bare VLAN by a config edit. The old
    // route went with the old device; the new one has to be written even though
    // the rule group still matches to the letter.
    const run = fixture({
      ifaces: [
        lanIface({ name: 'lan', device: 'br-lan', addr: '192.168.1.1' }),
        wanIface({ name: 'wan', device: 'eth1' })
      ],
      instances: [{ id: 'bind1', lan: 'lan', carrier: 'eth1' }]
    })
    await run.engine.onSample(run.model)

    const moved = run.next({
      ifaces: [
        lanIface({ name: 'lan', device: 'eth0.1', addr: '192.168.1.1' }),
        wanIface({ name: 'wan', device: 'eth1' })
      ]
    })
    run.scripts.length = 0
    await run.engine.onSample(moved)

    expect(written(run)).toContain(ROUTE)
  })

  it('writes none at all when the sample names no device for the LAN', async () => {
    // A guessed device is a route pointing at the wrong interface, which is
    // worse than the blackhole it is there to soften. The blackhole still goes
    // in, so the instance stays fail-closed either way.
    const run = fixture({
      ifaces: [
        lanIface({ name: 'lan', device: '', l3Device: '', addr: '192.168.1.1' }),
        wanIface({ name: 'wan', device: 'eth1' })
      ],
      instances: [{ id: 'bind1', lan: 'lan', carrier: 'eth1' }]
    })

    await run.engine.onSample(run.model)

    expect(written(run)).toContain(`ip -4 route replace unreachable default table ${CATCH_TABLE}`)
    expect(written(run)).not.toContain('scope link table')
  })
})

// ------------------------------------------------------------- several LANs

describe('a router carrying several LANs at once', () => {
  /** Row 5: a bridge, a second bridge and a bridge VLAN, each its own /24. */
  const threeLans = (): Run =>
    fixture({
      ifaces: [
        lanIface({ name: 'lan', device: 'br-lan', addr: '192.168.1.1' }),
        lanIface({ name: 'guest', device: 'br-guest', addr: '192.168.2.1' }),
        lanIface({ name: 'iot', device: 'br-lan.20', addr: '192.168.3.1' }),
        wanIface({ name: 'wan1', device: 'eth1', table: 10_001 }),
        wanIface({ name: 'wan2', device: 'eth2', table: 10_002 }),
        wanIface({ name: 'wan3', device: 'eth3.7', table: 10_003 })
      ],
      leases: [
        lease('aa:bb:cc:dd:ee:01', '192.168.1.60'),
        lease('aa:bb:cc:dd:ee:02', '192.168.2.60'),
        lease('aa:bb:cc:dd:ee:03', '192.168.3.60')
      ],
      instances: [
        { id: 'bind1', lan: 'lan', carrier: 'eth1', slot: 0 },
        { id: 'bind2', lan: 'guest', carrier: 'eth2', slot: 1 },
        { id: 'bind3', lan: 'iot', carrier: 'eth3', slot: 2 }
      ]
    })

  it('gives each one its own preference, its own blocks and its own route', async () => {
    const run = threeLans()

    await run.engine.onSample(run.model)

    const text = written(run)
    for (const [slot, subnet, device] of [
      [0, '192.168.1.0/24', 'br-lan'],
      [1, '192.168.2.0/24', 'br-guest'],
      [2, '192.168.3.0/24', 'br-lan.20']
    ] as const) {
      expect(text).toContain(
        `ip -4 rule add from ${subnet} lookup ${CATCH_TABLE} pref ${CATCH_PREF + slot}`
      )
      expect(text).toContain(
        `ip -4 route replace ${subnet} dev ${device} scope link table ${CATCH_TABLE}`
      )
    }
  })

  it('scopes each pool to its own carrier and nobody else', async () => {
    // Three uplinks on three devices, one of them a tagged VLAN. A pool that
    // counted every WAN on the router would read three here.
    const run = threeLans()

    await run.engine.onSample(run.model)

    expect(run.engine.list().map((row) => [row.id, row.wanTotal])).toEqual([
      ['bind1', 1],
      ['bind2', 1],
      ['bind3', 1]
    ])
  })

  it('binds each LAN only to its own carrier', async () => {
    const run = threeLans()

    await run.engine.onSample(run.model)

    expect(run.engine.rows('bind1').map((row) => row.wan)).toEqual(['wan1'])
    expect(run.engine.rows('bind2').map((row) => row.wan)).toEqual(['wan2'])
    expect(run.engine.rows('bind3').map((row) => row.wan)).toEqual(['wan3'])
  })
})

// -------------------------------------------------------------- WAN shapes

describe('which interfaces a carrier really scopes', () => {
  const poolOf = async (carrier: string, ifaces: IfaceState[]): Promise<number> => {
    const run = fixture({
      ifaces: [lanIface({ name: 'lan', device: 'br-lan', addr: '192.168.1.1' }), ...ifaces],
      instances: [{ id: 'bind1', lan: 'lan', carrier }]
    })
    await run.engine.onSample(run.model)
    return run.engine.list()[0]?.wanTotal ?? -1
  }

  it('takes a PPPoE uplink by the device it dials over, not by its netdev', async () => {
    // Row 8. `device` is the physical port and `l3Device` is `pppoe-wan`;
    // a carrier names the port, so matching on the netdev would pool nothing.
    expect(
      await poolOf('eth1', [
        wanIface({ name: 'wan', proto: 'pppoe', device: 'eth1', l3Device: 'pppoe-wan' })
      ])
    ).toBe(1)
  })

  it('takes a tagged-VLAN uplink under its parent device', async () => {
    // Row 9, and the reason a carrier is a device rather than an interface: one
    // carrier is meant to cover every VLAN dialled over the same port.
    expect(
      await poolOf('eth1', [
        wanIface({ name: 'wan', device: 'eth1.835', table: 10_001 }),
        wanIface({ name: 'wan2', device: 'eth1.836', table: 10_002 })
      ])
    ).toBe(2)
  })

  it('takes the same uplink when the carrier names the VLAN itself', async () => {
    expect(
      await poolOf('eth1.835', [wanIface({ name: 'wan', device: 'eth1.835' })])
    ).toBe(1)
  })

  it('does not take a device whose name merely starts the same way', async () => {
    // `eth1` scopes `eth1.835` and does not scope `eth10`: the separator is
    // part of the test, not a prefix match.
    expect(
      await poolOf('eth1', [
        wanIface({ name: 'wan', device: 'eth1.835', table: 10_001 }),
        wanIface({ name: 'other', device: 'eth10', table: 10_002 })
      ])
    ).toBe(1)
  })

  it('takes a bridged uplink when the carrier names the bridge', async () => {
    // Row 10. A modem port behind a bridge is an uplink like any other, and
    // the pool takes it - it is only the carrier vocabulary in `options.ts`
    // that refuses to offer a bare bridge as a carrier at all.
    expect(await poolOf('br-wan', [wanIface({ name: 'wan', device: 'br-wan' })])).toBe(1)
  })

  it('takes a static double-NAT uplink, which looks exactly like a LAN', async () => {
    // Row 7. `static` is the protocol every LAN runs, so nothing about the
    // protocol says uplink here; what puts it in the pool is the carrier.
    const run = fixture({
      ifaces: [
        lanIface({ name: 'lan', device: 'eth0.1', addr: '192.168.1.1' }),
        wanIface({
          name: 'wan',
          proto: 'static',
          device: 'eth1',
          addr: '192.168.100.2',
          mask: 24
        })
      ],
      leases: [lease('aa:bb:cc:dd:ee:01', '192.168.1.60')],
      instances: [{ id: 'bind1', lan: 'lan', carrier: 'eth1' }]
    })

    await run.engine.onSample(run.model)

    expect(run.engine.list()[0]?.wanTotal).toBe(1)
    expect(run.engine.rows('bind1').map((row) => row.wan)).toEqual(['wan'])
  })
})

// -------------------------------------------------- a LAN with no address

describe('a router with no LAN address to bind', () => {
  it('writes nothing at all for an instance whose LAN lost its subnet', async () => {
    // Row 11. Fail-closed means the rules that are already there stay there;
    // it does not mean planning against a subnet nobody can name.
    const run = fixture({
      ifaces: [
        lanIface({ name: 'lan', device: 'eth0.1', addr: '192.168.1.1', up: false }),
        wanIface({ name: 'wan', device: 'eth1' })
      ],
      leases: [lease('aa:bb:cc:dd:ee:01', '192.168.1.60')],
      instances: [{ id: 'bind1', lan: 'lan', carrier: 'eth1' }]
    })

    await run.engine.onSample(run.model)

    expect(run.scripts).toEqual([])
    expect(run.engine.rows('bind1')).toEqual([])
    // The pool is still counted, and counted as unusable rather than absent:
    // "no WANs" and "no LAN" are different faults and the row has to say which.
    expect(run.engine.list()[0]?.wanWarning).toBe(1)
  })
})

// ------------------------------------------------------------ ranged sources

describe('an address range on a LAN that is not a /24', () => {
  const ranged = (
    lan: { addr: string; mask: number },
    source: { kind: 'range'; from: string; to: string },
    leases: Lease[] = []
  ): Run =>
    fixture({
      ifaces: [
        lanIface({ name: 'lan', device: 'eth0.1', addr: lan.addr, mask: lan.mask }),
        wanIface({ name: 'wan', device: 'eth1' })
      ],
      leases,
      instances: [{ id: 'bind1', lan: 'lan', carrier: 'eth1', source }]
    })

  it('covers a range whose endpoints sit inside a /25', async () => {
    // Row 6 from the range's side: the blocks are arithmetic on the addresses
    // and owe nothing to the LAN's prefix, but every one of them still has to
    // land inside it.
    const source = { kind: 'range', from: '192.168.1.140', to: '192.168.1.160' } as const
    const run = ranged({ addr: '192.168.1.129', mask: 25 }, source)

    await run.engine.onSample(run.model)

    const blocks = rangeToCidrs(source.from, source.to)
    expect(blocks.length).toBeGreaterThan(1)
    for (const block of blocks) {
      expect(written(run)).toContain(
        `ip -4 rule add from ${block} lookup ${CATCH_TABLE} pref ${CATCH_PREF}`
      )
    }
    // The route is the whole /25 and not the /24 the address would suggest.
    expect(written(run)).toContain(
      `ip -4 route replace 192.168.1.128/25 dev eth0.1 scope link table ${CATCH_TABLE}`
    )
  })

  it('covers a range of exactly one address as one /32', async () => {
    const run = ranged(
      { addr: '192.168.1.1', mask: 24 },
      { kind: 'range', from: '192.168.1.77', to: '192.168.1.77' }
    )

    await run.engine.onSample(run.model)

    expect(written(run)).toContain(
      `ip -4 rule add from 192.168.1.77/32 lookup ${CATCH_TABLE} pref ${CATCH_PREF}`
    )
    expect(
      written(run).match(new RegExp(`lookup ${CATCH_TABLE} pref ${CATCH_PREF}`, 'g'))
    ).toHaveLength(1)
  })

  it('still keeps the router answering when the range covers its own address', async () => {
    /**
     * The catch-all selects on source, so a range starting at .1 blackholes the
     * router itself. The connected route is what makes that survivable, and it
     * is destination-scoped - the whole LAN, not the range - so it has to be
     * written for a ranged instance exactly as it is for a whole-LAN one.
     */
    const run = ranged(
      { addr: '192.168.1.1', mask: 24 },
      { kind: 'range', from: '192.168.1.1', to: '192.168.1.99' }
    )

    await run.engine.onSample(run.model)

    expect(written(run)).toContain(
      `ip -4 route replace 192.168.1.0/24 dev eth0.1 scope link table ${CATCH_TABLE}`
    )
    expect(written(run)).toContain(
      `ip -4 rule add from 192.168.1.1/32 lookup ${CATCH_TABLE} pref ${CATCH_PREF}`
    )
  })

  it('installs a wide decomposition once and then leaves it alone', async () => {
    /**
     * Eighteen blocks at one preference. The comparison that decides whether to
     * rebuild them is a sorted set rather than a list, because `ip rule show`
     * is under no obligation to hand a same-priority group back in the order it
     * was written - and a group that never matched would have been torn down
     * and rewritten on every fast tick, leaking every unassigned in-range
     * device out of the router's own WAN in the gap.
     */
    const source = { kind: 'range', from: '10.0.0.1', to: '10.0.7.254' } as const
    const run = ranged({ addr: '10.0.0.1', mask: 21 }, source)
    const blocks = rangeToCidrs(source.from, source.to)
    expect(blocks.length).toBeGreaterThan(10)

    await run.engine.onSample(run.model)
    for (const block of blocks) {
      expect(written(run)).toContain(
        `ip -4 rule add from ${block} lookup ${CATCH_TABLE} pref ${CATCH_PREF}`
      )
    }

    const second = run.next()
    // The kernel prints a /32 selector without its prefix and is free to hand
    // the group back in any order; both are what the next sweep really parses.
    second.rules = second.rules
      .map((rule) => (rule.from.endsWith('/32') ? { ...rule, from: rule.from.slice(0, -3) } : rule))
      .reverse()
    run.scripts.length = 0
    await run.engine.onSample(second)

    expect(written(run)).toBe('')
  })
})

// -------------------------------------------------- one-to-one reservations

describe('an address a one-to-one binding has taken over', () => {
  /**
   * The sibling automation binds a single address at a lower preference, so its
   * rule wins wherever both exist. What must not happen is this instance also
   * holding a WAN for that address: the client is steered by the 1-1 rule, and
   * the WAN the instance is keeping for it is one no other client can have.
   */
  const reserved = (over: { rules?: IpRule[]; source?: { kind: 'range'; from: string; to: string } } = {}): Run =>
    fixture({
      ifaces: [
        lanIface({ name: 'lan', device: 'wlan0', addr: '192.168.1.1' }),
        wanIface({ name: 'wan1', device: 'eth1', table: 10_001 }),
        wanIface({ name: 'wan2', device: 'eth1.835', table: 10_002 })
      ],
      leases: [
        lease('aa:bb:cc:dd:ee:01', '192.168.1.60', 'reserved'),
        lease('aa:bb:cc:dd:ee:02', '192.168.1.61', 'ordinary')
      ],
      reservedIps: ['192.168.1.60'],
      ...(over.rules ? { rules: over.rules } : {}),
      instances: [
        {
          id: 'bind1',
          lan: 'lan',
          carrier: 'eth1',
          ...(over.source ? { source: over.source } : {})
        }
      ]
    })

  const RANGE = { kind: 'range', from: '192.168.1.50', to: '192.168.1.99' } as const

  it('is never seated by a range instance whose range contains it', async () => {
    const run = reserved({ source: RANGE })

    await run.engine.onSample(run.model)

    expect(run.engine.rows('bind1').map((row) => row.ip)).toEqual(['192.168.1.61'])
    expect(written(run)).not.toContain('from 192.168.1.60/32')
  })

  it('says on the waiting table why it will never be seated', async () => {
    // The queue is not the answer for this device and never will be, so a row
    // reading "waiting for a free WAN" would be sending somebody to free one.
    const run = reserved({ source: RANGE })

    await run.engine.onSample(run.model)

    expect(
      run.engine.waitingRows('bind1').map((row) => [row.ip, row.reason])
    ).toEqual([['192.168.1.60', 'bound one-to-one']])
  })

  it('gives up a rule it already held for that address', async () => {
    /**
     * The device was bound by this instance before the 1-1 binding existed.
     * Adopting the rule again would leave two rules for one address with no
     * pass that ever removes either, while the instance went on holding a WAN
     * for a client it no longer steers.
     */
    const run = reserved({
      source: RANGE,
      rules: [{ pref: 20_000, from: '192.168.1.60/32', table: 10_001 }]
    })

    await run.engine.onSample(run.model)

    expect(written(run)).toContain('ip -4 rule del pref 20000')
    expect(written(run)).not.toContain(
      'ip -4 rule add from 192.168.1.60/32 lookup 10001 pref 20000'
    )
  })

  it('does not hold a WAN through the grace for an orphan rule at that address', async () => {
    // A rule with no lease behind it is normally kept for one release grace, so
    // a WAN is not surrendered merely because dnsmasq has not repopulated. A
    // reserved address is the one case where the rule is stale by construction.
    const run = fixture({
      ifaces: [
        lanIface({ name: 'lan', device: 'wlan0', addr: '192.168.1.1' }),
        wanIface({ name: 'wan1', device: 'eth1', table: 10_001 })
      ],
      leases: [lease('aa:bb:cc:dd:ee:02', '192.168.1.61', 'ordinary')],
      rules: [{ pref: 20_000, from: '192.168.1.60/32', table: 10_001 }],
      reservedIps: ['192.168.1.60'],
      instances: [{ id: 'bind1', lan: 'lan', carrier: 'eth1' }]
    })

    await run.engine.onSample(run.model)

    // The single WAN goes to the client that can actually use it.
    expect(run.engine.rows('bind1').map((row) => [row.ip, row.wan])).toEqual([
      ['192.168.1.61', 'wan1']
    ])
  })

  it('refuses a Pin onto it rather than recording one that does nothing', async () => {
    /**
     * Every gate in the planner drops this device, so an accepted pin would be
     * stored, ignored on the very next pass, and reported to the operator as
     * done. A pin that cannot be honoured is refused, and the refusal says
     * where the address is really bound.
     */
    const run = reserved({ source: RANGE })
    await run.engine.onSample(run.model)
    // Which of the two WANs the ordinary client drew is a random choice; the
    // other one is free, so nothing but the reservation can refuse this pin.
    const free = run.engine.rows('bind1')[0]?.wan === 'wan1' ? 'wan2' : 'wan1'

    const refused = await run.engine.pin('bind1', 'aa:bb:cc:dd:ee:01', free)

    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringContaining('192.168.1.60 is bound one-to-one')
    })
    // The control: the same pin onto the same WAN for the device beside it is
    // honoured, so the refusal is about the address and not about the pool.
    expect(await run.engine.pin('bind1', 'aa:bb:cc:dd:ee:02', free)).toMatchObject({
      ok: true
    })
  })

  it('leaves the address inside the catch-all it is covered by', async () => {
    // Deliberately not carved out of the blocks: the 1-1 rule sits at a lower
    // preference and is matched first, and a hole in the catch-all would be a
    // way out of it for any address the 1-1 binding later gives up.
    const run = reserved({ source: RANGE })

    await run.engine.onSample(run.model)

    const blocks = run.model.rules
      .filter((rule) => rule.pref === CATCH_PREF)
      .map((rule) => parseCidr(rule.from))
    expect(blocks.length).toBeGreaterThan(1)
    expect(
      blocks.filter((block) => block && subnetContains(block, '192.168.1.60'))
    ).toHaveLength(1)
  })
})

// ------------------------------------------------------------- the create gate

const text = (report: ModuleCheckReport): string =>
  report.findings.map((finding) => `${finding.label} ${finding.detail ?? ''}`).join('\n')

interface ProbeShape {
  /** Networks `/etc/config/dhcp` hands addresses out on. */
  served?: string[]
  /** Networks it has a section for and switches off, as a stock `wan` is. */
  ignored?: string[]
  zones?: Array<{ name: string; networks: string[]; masq?: boolean }>
  tables?: Record<string, number>
}

function probeText(shape: ProbeShape): string {
  const lines = ['===DHCP===', 'dhcp.@dnsmasq[0]=dnsmasq', "dhcp.@dnsmasq[0].dhcpleasemax='1000'"]
  for (const network of shape.served ?? []) {
    lines.push(
      `dhcp.${network}=dhcp`,
      `dhcp.${network}.interface='${network}'`,
      `dhcp.${network}.limit='150'`
    )
  }
  for (const network of shape.ignored ?? []) {
    lines.push(
      `dhcp.${network}=dhcp`,
      `dhcp.${network}.interface='${network}'`,
      `dhcp.${network}.ignore='1'`
    )
  }
  lines.push('===NETWORK===')
  for (const [name, table] of Object.entries(shape.tables ?? {})) {
    lines.push(`network.${name}=interface`, `network.${name}.ip4table='${table}'`)
  }
  lines.push('===FIREWALL===')
  ;(shape.zones ?? []).forEach((zone, index) => {
    lines.push(`firewall.@zone[${index}]=zone`, `firewall.@zone[${index}].name='${zone.name}'`)
    for (const network of zone.networks) {
      lines.push(`firewall.@zone[${index}].network='${network}'`)
    }
    if (zone.masq) lines.push(`firewall.@zone[${index}].masq='1'`)
  })
  lines.push('===SYSCTL===', 'net.netfilter.nf_conntrack_max=262144')
  return lines.join('\n')
}

async function checkOn(
  shape: RouterShape,
  values: Record<string, unknown>
): Promise<ModuleCheckReport> {
  const run = fixture(shape)
  await run.engine.onSample(run.model)
  const report = await run.engine.check({ name: 'New instance', ...values })
  run.engine.dispose()
  return report
}

describe('the create gate on a router that is not the stock one', () => {
  it('accepts a LAN on a VLAN behind a static double-NAT uplink', async () => {
    /**
     * The positive control for the whole file: neither half of this pair is a
     * bridge, neither is PPPoE, and nothing about either name says what it is.
     * A gate that reads shapes rather than configuration refuses this router.
     */
    const report = await checkOn(
      {
        ifaces: [
          lanIface({ name: 'lan', device: 'eth0.1', addr: '192.168.1.1' }),
          wanIface({
            name: 'wan',
            proto: 'static',
            device: 'eth1',
            addr: '192.168.100.2',
            mask: 24,
            table: 10_001
          })
        ],
        probe: probeText({
          served: ['lan'],
          ignored: ['wan'],
          zones: [
            { name: 'lan', networks: ['lan'] },
            { name: 'wan', networks: ['wan'], masq: true }
          ],
          tables: { wan: 10_001 }
        })
      },
      { lan: 'lan', carrier: 'eth1' }
    )

    expect(report.ok).toBe(true)
    expect(text(report)).toContain('LAN lan is scoped to 192.168.1.0/24')
    expect(text(report)).toContain('1 WAN interface(s) are scoped to carrier eth1')
  })

  it('refuses a pool that has swallowed one of the router\'s own LANs', async () => {
    /**
     * The carrier names a device a second LAN happens to sit on, so the pool
     * collected it: it runs proto static, like every LAN, and its device name
     * says nothing. What does say something is /etc/config/dhcp, which hands
     * out addresses on it - an uplink does not. Left in, every client bound to
     * it would have left through one of the router's own LANs while the page
     * called it bound.
     */
    const report = await checkOn(
      {
        ifaces: [
          lanIface({ name: 'lan', device: 'br-lan', addr: '192.168.1.1' }),
          lanIface({ name: 'iot', device: 'eth2.20', addr: '192.168.3.1' })
        ],
        probe: probeText({
          served: ['lan', 'iot'],
          zones: [
            { name: 'lan', networks: ['lan'] },
            { name: 'iot', networks: ['iot'] }
          ]
        })
      },
      { lan: 'lan', carrier: 'eth2' }
    )

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('WAN "iot" is a LAN: the router hands out DHCP addresses on it')
  })

  it('does not read a stock switched-off wan section as a LAN', async () => {
    /**
     * OpenWrt ships `config dhcp 'wan'` with `option ignore '1'`. A test that
     * only asked whether a DHCP section existed would refuse the WAN of every
     * router nobody has ever edited - which is the same mistake, made in the
     * other direction, as reading a device name.
     */
    const report = await checkOn(
      {
        ifaces: [
          lanIface({ name: 'lan', device: 'br-lan', addr: '192.168.1.1' }),
          wanIface({ name: 'wan', device: 'eth1', addr: '10.0.0.2', mask: 24, table: 10_001 })
        ],
        probe: probeText({
          served: ['lan'],
          ignored: ['wan'],
          zones: [
            { name: 'lan', networks: ['lan'] },
            { name: 'wan', networks: ['wan'], masq: true }
          ],
          tables: { wan: 10_001 }
        })
      },
      { lan: 'lan', carrier: 'eth1' }
    )

    expect(report.ok).toBe(true)
    expect(text(report)).not.toContain('is a LAN')
  })

  it('says so rather than choosing when an interface both dials and serves', async () => {
    // proto dhcp says uplink; a dnsmasq section serving it says LAN. Neither
    // fact outranks the other, so the pool keeps it and the report names both.
    const report = await checkOn(
      {
        ifaces: [
          lanIface({ name: 'lan', device: 'br-lan', addr: '192.168.1.1' }),
          wanIface({ name: 'wan', device: 'eth1', addr: '10.0.0.2', mask: 24, table: 10_001 })
        ],
        probe: probeText({
          served: ['lan', 'wan'],
          zones: [
            { name: 'lan', networks: ['lan'] },
            { name: 'wan', networks: ['wan'], masq: true }
          ],
          tables: { wan: 10_001 }
        })
      },
      { lan: 'lan', carrier: 'eth1' }
    )

    expect(report.ok).toBe(true)
    expect(text(report)).toContain('both dials an uplink and serves DHCP')
  })

  it('warns when the router serves no DHCP on the LAN being bound', async () => {
    // The instance follows leases, so a LAN whose dnsmasq section is switched
    // off would never bind anything and never say why.
    const report = await checkOn(
      {
        ifaces: [
          lanIface({ name: 'lan', device: 'br-lan', addr: '192.168.1.1' }),
          wanIface({ name: 'wan', device: 'eth1', addr: '10.0.0.2', mask: 24, table: 10_001 })
        ],
        probe: probeText({
          served: [],
          ignored: ['lan', 'wan'],
          zones: [
            { name: 'lan', networks: ['lan'] },
            { name: 'wan', networks: ['wan'], masq: true }
          ],
          tables: { wan: 10_001 }
        })
      },
      { lan: 'lan', carrier: 'eth1' }
    )

    expect(text(report)).toContain("The router's DHCP server is switched off for LAN \"lan\"")
  })

  it('refuses an uplink whose subnet collides with the LAN it would bind', async () => {
    /**
     * Row 12, and it breaks twice over. The catch-all selects the whole LAN as
     * a source, which now covers the uplink's own address; and a client bound
     * to that uplink looks the LAN up in the uplink's own table, where the
     * connected route points at the modem - so two clients of the same LAN
     * would talk to each other through it.
     */
    const report = await checkOn(
      {
        ifaces: [
          lanIface({ name: 'lan', device: 'eth0.1', addr: '192.168.1.1' }),
          wanIface({
            name: 'wan',
            proto: 'static',
            device: 'eth1',
            addr: '192.168.1.250',
            mask: 24,
            table: 10_001
          })
        ],
        probe: probeText({
          served: ['lan'],
          ignored: ['wan'],
          zones: [
            { name: 'lan', networks: ['lan'] },
            { name: 'wan', networks: ['wan'], masq: true }
          ],
          tables: { wan: 10_001 }
        })
      },
      { lan: 'lan', carrier: 'eth1' }
    )

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('which overlaps the LAN 192.168.1.0/24')
  })

  it('refuses a second instance on a /25 inside a LAN one already owns', async () => {
    /**
     * Row 6. Both answers are true for an address in the /25, and a rule
     * selecting on source cannot express which one it belongs to - so each
     * instance would read the other's client rules as its own and delete them,
     * on every tick, for ever.
     */
    const report = await checkOn(
      {
        ifaces: [
          lanIface({ name: 'lan', device: 'br-lan', addr: '192.168.1.1' }),
          lanIface({ name: 'inner', device: 'br-lan.30', addr: '192.168.1.129', mask: 25 }),
          wanIface({ name: 'wan', device: 'eth1', addr: '10.0.0.2', mask: 24, table: 10_001 })
        ],
        instances: [{ id: 'bind1', lan: 'lan', carrier: 'eth2' }],
        probe: probeText({
          served: ['lan', 'inner'],
          ignored: ['wan'],
          zones: [
            { name: 'lan', networks: ['lan', 'inner'] },
            { name: 'wan', networks: ['wan'], masq: true }
          ],
          tables: { wan: 10_001 }
        })
      },
      { lan: 'inner', carrier: 'eth1' }
    )

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('192.168.1.128/25 overlaps 192.168.1.0/24')
  })

  it('refuses a LAN that carries no IPv4 address at all', async () => {
    // Row 11 at the gate rather than in the pass.
    const report = await checkOn(
      {
        ifaces: [
          lanIface({ name: 'lan', device: 'eth0.1', addr: '192.168.1.1', up: false }),
          wanIface({ name: 'wan', device: 'eth1', addr: '10.0.0.2', mask: 24, table: 10_001 })
        ],
        probe: probeText({ served: ['lan'], zones: [{ name: 'wan', networks: ['wan'], masq: true }] })
      },
      { lan: 'lan', carrier: 'eth1' }
    )

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('has no usable IPv4 subnet')
  })

  it('refuses a bare bridge as a carrier, which is how a bridged uplink is turned away', async () => {
    /**
     * Row 10, recorded rather than fixed. The pool itself takes a bridged
     * uplink perfectly well - see the carrier tests above - but the carrier
     * vocabulary in `options.ts` will not offer or accept a bare bridge, so a
     * modem behind `br-wan` cannot be bound today. The refusal at least says
     * what a carrier is instead of failing later with an empty pool.
     */
    const report = await checkOn(
      {
        ifaces: [
          lanIface({ name: 'lan', device: 'br-lan', addr: '192.168.1.1' }),
          wanIface({ name: 'wan', device: 'br-wan', addr: '10.0.0.2', mask: 24, table: 10_001 })
        ],
        probe: probeText({
          served: ['lan'],
          ignored: ['wan'],
          zones: [
            { name: 'lan', networks: ['lan'] },
            { name: 'wan', networks: ['wan'], masq: true }
          ],
          tables: { wan: 10_001 }
        })
      },
      { lan: 'lan', carrier: 'br-wan' }
    )

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('is not a device an instance can bind to')
  })
})
