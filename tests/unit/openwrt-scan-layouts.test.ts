import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { emptyCapabilities, type OpenWrtCapabilities } from '../../openwrt/main/probe'
import {
  SCAN_COMMAND,
  SCAN_MAX_RULES,
  classifyScan,
  parseScanOutput,
  scanRulesLookWhole
} from '../../openwrt/main/scan'
import type { ScanRow } from '../../openwrt/main/scan'
import type { BindingInstanceRecord, DirectBindingRecord } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'

/**
 * The monitor, read against routers that are not the one it was written on.
 *
 * `openwrt-scan-classify.test.ts` covers what the monitor is for; this file
 * covers the assumption that has already cost this module once. A device NAME
 * is not a fact about what an interface is - `isWanPort` decided an uplink from
 * `br-` and refused every LAN that was not a bridge - and the monitor makes the
 * same shape of decision every time it turns the netdev in a default route back
 * into the WAN it names in a sentence. So every claim below is checked on the
 * layouts the matrix carries rather than on the stock one: a LAN on a VLAN, on a
 * plain port and on wireless; a WAN over PPPoE, over a tagged VLAN and over a
 * bridge; two interfaces sharing one netdev; and a router whose
 * `/etc/iproute2/rt_tables` is not the file this module expects.
 *
 * The rule the whole file is built on: where the evidence does not settle the
 * question, the honest answer is the smaller one. A netdev name printed on its
 * own is less than the reader wanted and true; a WAN chosen from two candidates
 * is what they wanted and possibly a lie, inside a sentence written to be
 * believed.
 */

/** One reply, assembled the way the router assembles it. */
const reply = (parts: {
  rules: readonly string[]
  main?: readonly string[]
  routes?: readonly string[]
  tables?: readonly string[]
  ok?: boolean
}): string => {
  const routes = parts.routes ?? []
  const queried = parts.tables ?? [...new Set(routes.map((line) => line.split(/\s+/)[0]))]
  return [
    '===RULES===',
    ...parts.rules,
    '===DEFAULT===',
    ...(parts.main ?? []),
    '===TABLES===',
    ...queried,
    '===ROUTES===',
    ...routes,
    '===SCANOK===',
    parts.ok === false ? '0' : '1'
  ].join('\n')
}

/** The kernel's own three, as a router with a normal rt_tables prints them. */
const BASELINE = [
  '0:\tfrom all lookup local',
  '32766:\tfrom all lookup main',
  '32767:\tfrom all lookup default'
]

/**
 * The same three off a router that has no `/etc/iproute2/rt_tables` to read
 * names out of - a busybox-only image, or one where the file was trimmed.
 * `ip` then prints the numbers, which is the same rule table said differently.
 */
const NUMERIC_BASELINE = [
  '0:\tfrom all lookup 255',
  '32766:\tfrom all lookup 254',
  '32767:\tfrom all lookup 253'
]

const net = (patch: Partial<IfaceState> & { name: string }): IfaceState => ({
  proto: 'static',
  device: '',
  l3Device: patch.device ?? '',
  up: true,
  pending: false,
  autostart: true,
  uptimeSec: 100,
  ...patch
})

const model = (ifaces: readonly IfaceState[]): RouterModel => ({
  t: 1_000,
  sys: { uptimeSec: 100, load1: 0, memTotal: 0, memFree: 0 },
  ifaces: [...ifaces],
  poolDev: { count: 0, rx: 0, tx: 0 },
  leases: [],
  rules: [],
  rates: {}
})

/**
 * The twelve layouts, each as `network.interface dump` would hand them over.
 *
 * The v6 interface is in the stock rows on purpose rather than for completeness:
 * every OpenWrt install that has ever taken a v6 prefix carries a `wan6` on the
 * same netdev as its `wan`, so "the interface that owns this netdev" has two
 * answers on the most ordinary router there is. It is listed first in the dump
 * because ubus is under no obligation to order the two the way a reader would.
 */
const LAYOUTS = {
  /** 1. Stock OpenWrt 25.12: lan on a bridge, wan by DHCP on a plain port. */
  stock: () =>
    model([
      net({ name: 'lan', device: 'br-lan', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({ name: 'wan6', proto: 'dhcpv6', device: 'eth1' }),
      net({
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        ipv4: { addr: '203.0.113.10', mask: 24 }
      })
    ]),
  /** 2. A LAN on a VLAN with no bridge anywhere. */
  vlanLan: () =>
    model([
      net({ name: 'lan', device: 'eth0.1', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        ipv4: { addr: '203.0.113.10', mask: 24 }
      })
    ]),
  /** 3. A LAN on a plain port. */
  portLan: () =>
    model([
      net({ name: 'lan', device: 'eth0', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        ipv4: { addr: '203.0.113.10', mask: 24 }
      })
    ]),
  /** 4. A wireless-only LAN. */
  wirelessLan: () =>
    model([
      net({ name: 'lan', device: 'wlan0', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        ipv4: { addr: '203.0.113.10', mask: 24 }
      })
    ]),
  /** 5. Several LANs, one of them on a bridge VLAN. */
  manyLans: () =>
    model([
      net({ name: 'lan', device: 'br-lan', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({ name: 'guest', device: 'br-guest', ipv4: { addr: '192.168.2.1', mask: 24 } }),
      net({ name: 'iot', device: 'br-lan.20', ipv4: { addr: '192.168.20.1', mask: 24 } }),
      net({
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        ipv4: { addr: '203.0.113.10', mask: 24 }
      })
    ]),
  /**
   * 5b. Two networks on one netdev, both carrying an address - a second UCI
   * interface bolted onto the same bridge, which is how a router grows a
   * management address without growing a port.
   */
  sharedDevice: () =>
    model([
      net({ name: 'lan', device: 'br-lan', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({ name: 'mgmt', device: 'br-lan', ipv4: { addr: '10.10.0.1', mask: 24 } }),
      net({
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        ipv4: { addr: '203.0.113.10', mask: 24 }
      })
    ]),
  /** 6. A LAN that is a /25 sitting inside another LAN's /24. */
  nestedLan: () =>
    model([
      net({ name: 'lan', device: 'br-lan', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({ name: 'lab', device: 'br-lab', ipv4: { addr: '192.168.1.129', mask: 25 } }),
      net({
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        ipv4: { addr: '203.0.113.10', mask: 24 }
      })
    ]),
  /** 7. A static WAN behind somebody else's router. */
  doubleNat: () =>
    model([
      net({ name: 'lan', device: 'br-lan', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({
        name: 'wan',
        proto: 'static',
        device: 'eth1',
        ipv4: { addr: '192.168.100.2', mask: 24 }
      })
    ]),
  /** 8. PPPoE: the netdev in every route is the session, not the port. */
  pppoe: () =>
    model([
      net({ name: 'lan', device: 'br-lan', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({ name: 'wan6', proto: 'dhcpv6', device: 'eth1', l3Device: 'pppoe-wan' }),
      net({
        name: 'wan',
        proto: 'pppoe',
        device: 'eth1',
        l3Device: 'pppoe-wan',
        ipv4: { addr: '100.64.3.7', mask: 32 }
      })
    ]),
  /** 9. A WAN on a tagged VLAN, which is how most fibre handoffs arrive. */
  vlanWan: () =>
    model([
      net({ name: 'lan', device: 'br-lan', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({ name: 'wan6', proto: 'dhcpv6', device: 'eth1.835' }),
      net({
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1.835',
        ipv4: { addr: '203.0.113.10', mask: 24 }
      })
    ]),
  /** 10. A WAN on a bridge, which a bridged modem port produces. */
  bridgedWan: () =>
    model([
      net({ name: 'lan', device: 'br-lan', ipv4: { addr: '192.168.1.1', mask: 24 } }),
      net({ name: 'wan6', proto: 'dhcpv6', device: 'br-wan' }),
      net({
        name: 'wan',
        proto: 'dhcp',
        device: 'br-wan',
        ipv4: { addr: '203.0.113.10', mask: 24 }
      })
    ]),
  /** 11. No LAN carrying an IPv4 address at all. */
  noLanAddress: () =>
    model([
      net({ name: 'lan', device: 'br-lan' }),
      net({
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        ipv4: { addr: '203.0.113.10', mask: 24 }
      })
    ]),
  /** 12. A LAN and a static WAN whose subnets overlap. */
  overlapping: () =>
    model([
      net({ name: 'lan', device: 'br-lan', ipv4: { addr: '192.168.100.1', mask: 24 } }),
      net({
        name: 'wan',
        proto: 'static',
        device: 'eth1',
        ipv4: { addr: '192.168.100.2', mask: 24 }
      })
    ])
}

const instance = (patch: Partial<BindingInstanceRecord> = {}): BindingInstanceRecord => ({
  id: 'bind_1',
  name: 'Guest LAN',
  lan: 'lan',
  carrier: 'eth1',
  running: true,
  sticky: true,
  remap: true,
  createdAt: 1,
  slot: 0,
  ...patch
})

const direct = (patch: Partial<DirectBindingRecord> = {}): DirectBindingRecord => ({
  id: 'dir_1',
  name: 'Office NAS',
  target: { kind: 'ip', ip: '192.168.1.50' },
  wan: 'wan',
  enabled: true,
  whenDown: 'hold',
  pref: 19_003,
  table: 42,
  lan: 'lan',
  slot: 0,
  createdAt: 1,
  ...patch
})

const caps = (patch: Partial<OpenWrtCapabilities> = {}): OpenWrtCapabilities => ({
  ...emptyCapabilities(),
  ...patch
})

const scan = (
  stdout: string,
  patch: Partial<Parameters<typeof classifyScan>[0]> = {}
): ReturnType<typeof classifyScan> =>
  classifyScan({
    readout: parseScanOutput(stdout),
    rules: DEFAULT_RULES,
    model: LAYOUTS.stock(),
    direct: [],
    instances: [],
    assignments: [],
    capabilities: caps(),
    ...patch
  })

const rowAt = (rows: readonly ScanRow[], pref: number): ScanRow => {
  const found = rows.find((row) => row.pref === pref)
  if (!found) throw new Error(`no row at preference ${pref}`)
  return found
}

/** One foreign rule pointing at table `vpn`, whose default leaves through `dev`. */
const throughDevice = (device: string, patch: Partial<Parameters<typeof classifyScan>[0]>) =>
  scan(
    reply({
      rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
      main: ['default via 203.0.113.1 dev eth1 proto static'],
      routes: [`vpn default via 100.64.3.1 dev ${device}`]
    }),
    patch
  )

describe('naming the WAN a table leaves through, on layouts that are not the stock one', () => {
  it('reads a stock uplink off the interface that carries IPv4, not the one that shares its netdev', () => {
    // Every dual-stacked OpenWrt carries `wan` and `wan6` on one netdev, so
    // "the interface that owns eth1" has two answers on the most ordinary
    // router there is - and the first of the two is whichever ubus happened to
    // print first. Taking it named `wan6` as the WAN an address is bound to,
    // in a sentence that also carried no IP because a v6 interface has no v4
    // address to show. This scan reads `ip -4` from end to end, so the
    // interface that answers for it is the one holding an IPv4 address.
    const { rows } = throughDevice('eth1', { model: LAYOUTS.stock() })

    const row = rowAt(rows, 900)
    expect(row.wan).toBe('wan')
    expect(row.wanIp).toBe('203.0.113.10')
    expect(row.reason).toContain('eth1 (wan, 203.0.113.10)')
  })

  it('names the PPPoE session by its l3 device rather than the port underneath it', () => {
    const { rows } = throughDevice('pppoe-wan', { model: LAYOUTS.pppoe() })

    const row = rowAt(rows, 900)
    expect(row.wan).toBe('wan')
    expect(row.wanIp).toBe('100.64.3.7')
  })

  it('still names the PPPoE WAN when the route leaves through the ethernet under it', () => {
    // A route naming the carrier is ambiguous only when several interfaces
    // could be the one using it. Here the other claimant is the v6 half of the
    // same uplink, and it is not what an IPv4 default route leaves through.
    const { rows } = throughDevice('eth1', { model: LAYOUTS.pppoe() })

    expect(rowAt(rows, 900).wan).toBe('wan')
  })

  it('names a WAN on a tagged VLAN', () => {
    const { rows } = throughDevice('eth1.835', { model: LAYOUTS.vlanWan() })

    expect(rowAt(rows, 900).wan).toBe('wan')
  })

  it('names a WAN that happens to be a bridge', () => {
    // `br-` is not a fact about what an interface is. A bridged modem port is
    // an uplink, and a monitor that read the prefix as "this is a LAN" would
    // have refused to name the only WAN on the router.
    const { rows } = throughDevice('br-wan', { model: LAYOUTS.bridgedWan() })

    const row = rowAt(rows, 900)
    expect(row.wan).toBe('wan')
    expect(row.wanIp).toBe('203.0.113.10')
  })

  it.each([
    ['a VLAN', LAYOUTS.vlanLan, 'eth0.1', 'lan'],
    ['a plain port', LAYOUTS.portLan, 'eth0', 'lan'],
    ['wireless', LAYOUTS.wirelessLan, 'wlan0', 'lan'],
    ['a bridge VLAN', LAYOUTS.manyLans, 'br-lan.20', 'iot']
  ])(
    'names a LAN interface on %s when a table leads back into it',
    (_label, layout, device, expected) => {
      // A table whose default points back at a LAN is a real thing to find - a
      // transparent proxy, a VPN gateway that lives on the LAN - and the row has
      // to say which interface, whatever that interface happens to be built on.
      const { rows } = throughDevice(device, { model: layout() })

      expect(rowAt(rows, 900).wan).toBe(expected)
    }
  )

  it('refuses to name one of two interfaces that both hold an address on a netdev', () => {
    // Two UCI networks on one bridge is a management address bolted onto a LAN,
    // and nothing in a route naming that bridge says which of them the traffic
    // belongs to. The bare netdev is less than the reader wanted and true.
    const { rows } = throughDevice('br-lan', { model: LAYOUTS.sharedDevice() })

    const row = rowAt(rows, 900)
    expect(row.wan).toBe('')
    expect(row.wanIp).toBe('')
    expect(row.reason).toContain("Table vpn's default route leaves through br-lan;")
    expect(row.reason).not.toContain('mgmt')
  })

  it('says nothing about a WAN when the router has no interface on that netdev', () => {
    const { rows } = throughDevice('tun0', { model: LAYOUTS.stock() })

    const row = rowAt(rows, 900)
    expect(row.wan).toBe('')
    expect(row.reason).toContain("Table vpn's default route leaves through tun0;")
  })
})

describe('the sentence a row carries, against the same layouts', () => {
  it('does not claim an address is off the default connection when it leaves the same way', () => {
    // A one-to-one binding is allowed to point at the WAN the rest of the
    // router already uses - somebody pinning the NAS to the primary while the
    // pool moves everything else. Table 42's default and main's default then
    // leave through the same interface, and "this address does not use the
    // router's default connection" is a statement the evidence flatly
    // contradicts, on the row whose whole job is to explain the evidence.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.50/32 lookup 42'],
        main: ['default via 192.168.100.1 dev eth1 proto static'],
        routes: ['42 default via 192.168.100.1 dev eth1']
      }),
      { model: LAYOUTS.doubleNat(), direct: [direct()] }
    )

    const row = rowAt(rows, 19_003)
    expect(row.wan).toBe('wan')
    expect(row.reason).not.toContain("does not use the router's default connection")
    expect(row.reason).toContain(
      "This is the same interface the main table's own default uses, so the rule does not move this address off the router's default connection."
    )
  })

  it('describes a one-to-one binding in fallback as what it is', () => {
    // `whenDown: fallback` re-points the rule at the main table on purpose, so
    // the address leaves exactly the way everything else does until its WAN
    // comes back. The row used to announce that as "this address does not use
    // the router's default connection - it is bound to wan", which is the
    // opposite of what the rule in front of it was doing.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.50/32 lookup main'],
        main: ['default via 203.0.113.1 dev eth1 proto static']
      }),
      { direct: [direct()] }
    )

    const row = rowAt(rows, 19_003)
    expect(row.ownerKind).toBe('direct')
    expect(row.unreachable).toBe(false)
    expect(row.reason).toContain(
      "This is the same interface the main table's own default uses"
    )
    expect(row.reason).not.toContain("does not use the router's default connection - it is bound")
  })

  it('keeps the plain consequence when the table really does leave another way', () => {
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.50/32 lookup 42'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['42 default via 100.64.3.1 dev pppoe-wan']
      }),
      { model: LAYOUTS.pppoe(), direct: [] }
    )

    expect(rowAt(rows, 19_003).reason).toContain(
      "So this address does not use the router's default connection - it is bound to wan."
    )
  })
})

describe('deciding who wrote a rule where the numbers collide', () => {
  it('refuses to credit a binding instance for a foreign rule that only shares the catch-all priority', () => {
    // The one-to-one verdict already refuses this: a preference is where this
    // module writes, not evidence that it wrote. The catch-all verdict was
    // reached on the preference alone, so a stranger's rule numbered at
    // 29900 came back described as this module's own fail-closed catch-all -
    // the exact mistake the monitor exists to prevent, in the module's voice,
    // and about the one rule whose job is to take a LAN off the internet.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '29900:\tfrom 10.0.0.0/8 lookup vpn'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      { instances: [instance()] }
    )

    const row = rowAt(rows, 29_900)
    expect(row.ownerKind).toBe('foreign')
    expect(row.reason).toContain('This module did not write this rule.')
    expect(row.reason).toContain('It does sit at preference 29900')
  })

  it('still owns the catch-all it wrote, on a LAN that is not a bridge', () => {
    // The other half: the rule this module writes is `from <lan block> lookup
    // <catch-all table> pref <base + slot>`, and it stays ours on a LAN that
    // lives on a VLAN, a port or a radio - none of which the verdict reads.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '29900:\tfrom 192.168.1.0/24 lookup 29999'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['29999 unreachable default']
      }),
      { model: LAYOUTS.vlanLan(), instances: [instance()] }
    )

    const row = rowAt(rows, 29_900)
    expect(row.ownerKind).toBe('catchAll')
    expect(row.reason).toContain('fail-closed catch-all for binding instance "Guest LAN"')
  })

  it('refuses the catch-all verdict for a rule at that priority that selects on no address', () => {
    // This module writes one CIDR per catch-all rule and never `from all`, so
    // an fwmark rule sitting on the preference is somebody else's - and
    // reporting it as the LAN's fail-closed catch-all would describe a rule
    // that cannot park a single address.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '29900:\tfrom all fwmark 0x1 lookup 29999'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['29999 unreachable default']
      }),
      { instances: [instance()] }
    )

    expect(rowAt(rows, 29_900).ownerKind).toBe('foreign')
  })

  it('keeps the catch-all verdict when the table is named rather than numbered', () => {
    // An administrator is free to give 29999 a name in `/etc/iproute2/rt_tables`,
    // and `ip rule show` then prints the name. This side cannot resolve it back
    // to a number, so it cannot contradict the preference either - and a
    // verdict that demanded the number would have called this module's own
    // catch-all foreign on every router with a tidy rt_tables.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '29900:\tfrom 192.168.1.0/24 lookup bmhold'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['bmhold unreachable default']
      }),
      { instances: [instance()] }
    )

    expect(rowAt(rows, 29_900).ownerKind).toBe('catchAll')
  })

  it('keeps the catch-alls of two instances apart on a router with several LANs', () => {
    // Row 5. Each instance owns one preference and one LAN, and the block in
    // the rule is what tells them apart: the preference alone cannot, and a
    // catch-all credited to the wrong instance is a sentence naming the wrong
    // LAN as the one being parked.
    const both = [instance(), instance({ id: 'bind_2', name: 'IoT', lan: 'guest', slot: 1 })]
    const { rows } = scan(
      reply({
        rules: [
          ...BASELINE,
          '29900:\tfrom 192.168.1.0/24 lookup 29999',
          '29901:\tfrom 192.168.2.0/24 lookup 29999'
        ],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['29999 unreachable default']
      }),
      { model: LAYOUTS.manyLans(), instances: both }
    )

    expect(rowAt(rows, 29_900).reason).toContain('binding instance "Guest LAN"')
    expect(rowAt(rows, 29_901).reason).toContain('binding instance "IoT"')
  })

  it('refuses the catch-all verdict for a block belonging to the other LAN', () => {
    // The same two instances, with the blocks swapped onto each other's
    // preferences. Neither rule is one this module would have written, and the
    // row has to say which fact it failed rather than crediting the number.
    const both = [instance(), instance({ id: 'bind_2', name: 'IoT', lan: 'guest', slot: 1 })]
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '29901:\tfrom 192.168.1.0/24 lookup 29999'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['29999 unreachable default']
      }),
      { model: LAYOUTS.manyLans(), instances: both }
    )

    const row = rowAt(rows, 29_901)
    expect(row.ownerKind).toBe('foreign')
    expect(row.reason).toContain('that catch-all covers 192.168.2.0/24')
  })

  it('refuses a catch-all block wider than the LAN it is supposed to park', () => {
    // Row 6, from the other end: the instance's LAN is the /25, and a rule
    // selecting the /24 it sits inside covers addresses that belong to the
    // other LAN entirely. This module writes the LAN itself or blocks within
    // it and never anything wider, so containment is asked of the prefix as
    // well as the address - overlap alone would have accepted this one.
    const lab = [instance({ id: 'bind_3', name: 'Lab', lan: 'lab' })]
    const wide = scan(
      reply({
        rules: [...BASELINE, '29900:\tfrom 192.168.1.0/24 lookup 29999'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['29999 unreachable default']
      }),
      { model: LAYOUTS.nestedLan(), instances: lab }
    )
    expect(rowAt(wide.rows, 29_900).ownerKind).toBe('foreign')
    expect(rowAt(wide.rows, 29_900).reason).toContain('that catch-all covers 192.168.1.128/25')

    const exact = scan(
      reply({
        rules: [...BASELINE, '29900:\tfrom 192.168.1.128/25 lookup 29999'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['29999 unreachable default']
      }),
      { model: LAYOUTS.nestedLan(), instances: lab }
    )
    expect(rowAt(exact.rows, 29_900).ownerKind).toBe('catchAll')
  })

  it('keeps the catch-all verdict on a router that states no subnet for the LAN', () => {
    // Row 11, at the verdict rather than at the sentence. A LAN with no IPv4
    // address states no subnet, and an unavailable fact contradicts nothing -
    // read as a failed one it would call this module's own catch-all foreign on
    // exactly the routers whose layout it cannot see.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '29900:\tfrom 192.168.1.0/24 lookup 29999'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['29999 unreachable default']
      }),
      { model: LAYOUTS.noLanAddress(), instances: [instance()] }
    )

    expect(rowAt(rows, 29_900).ownerKind).toBe('catchAll')
  })

  it('says how far the mwan3 guess goes when the rule carries no firewall mark', () => {
    // mwan3 being installed is a fact about the router, not about the rule, and
    // it was being reported as "mwan3 is what put it there". The rule a person
    // opens this page to find is exactly the hand-written one that would then
    // have been filed under somebody else's name and skipped.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '2000:\tfrom 192.168.1.0/24 lookup vpn'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      { capabilities: caps({ mwan3: { config: true, running: true } }) }
    )

    const row = rowAt(rows, 2_000)
    expect(row.ownerKind).toBe('mwan3')
    expect(row.reason).toContain('so nothing here can be sure of that')
    expect(row.reason).not.toContain('so mwan3 is what put it there')
    expect(row.reason).toContain('This module will not touch it.')
  })

  it('names the firewall mark as the evidence when the rule carries one', () => {
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '2000:\tfrom all fwmark 0x100/0x3f00 lookup 1'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['1 default via 203.0.113.1 dev eth1']
      }),
      { capabilities: caps({ mwan3: { config: true, running: true } }) }
    )

    expect(rowAt(rows, 2_000).reason).toContain('it steers on a firewall mark the way mwan3 does')
  })

  it('does not accuse a low rule that cannot reach the /25 the bindings live in', () => {
    // Row 6 of the matrix: a LAN that is a /25 inside another LAN's /24. The
    // bound address is .50, the foreign rule claims .128/25, and the two do
    // not meet - so the red chip and "a binding shown as applied is not where
    // the traffic actually goes" would be an accusation about nothing.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 192.168.1.128/25 lookup vpn'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      { direct: [direct()] }
    )

    const row = rowAt(rows, 900)
    expect(row.outranksModule).toBe(false)
    expect(row.reason).not.toContain('is not where the traffic actually goes')
  })

  it('does accuse the same rule once a binding sits inside that /25', () => {
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 192.168.1.128/25 lookup vpn'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      { direct: [direct({ target: { kind: 'ip', ip: '192.168.1.200' } })] }
    )

    expect(rowAt(rows, 900).outranksModule).toBe(true)
  })

  it('warns about a rule over the WAN subnet when the LAN overlaps it', () => {
    // Row 12: the LAN and a static WAN share 192.168.100.0/24, so a rule
    // written for "the WAN side" covers bound clients as well. The overlap is
    // the reason the check asks whether the selector covers a managed address
    // rather than which side of the router the block looks like it belongs to.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 192.168.100.0/24 lookup vpn'],
        main: ['default via 192.168.100.1 dev eth1 proto static'],
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      {
        model: LAYOUTS.overlapping(),
        direct: [direct({ target: { kind: 'ip', ip: '192.168.100.50' } })]
      }
    )

    expect(rowAt(rows, 900).outranksModule).toBe(true)
  })

  it('reads a router with no LAN address at all without inventing anything', () => {
    // Row 11. Nothing is bound, so there is nothing for a low rule to outrank,
    // and the row still has to report the rule and its exit.
    const { rows, summary } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
        main: ['default via 203.0.113.1 dev eth1 proto static'],
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      { model: LAYOUTS.noLanAddress() }
    )

    const row = rowAt(rows, 900)
    expect(row.ownerKind).toBe('foreign')
    expect(row.outranksModule).toBe(false)
    expect(summary.total).toBe(1)
  })
})

describe('a router whose rt_tables is not the file this module expects', () => {
  it('knows the kernel baseline when `ip` prints the numbers instead of the names', () => {
    // `local`, `main` and `default` are names out of /etc/iproute2/rt_tables,
    // and a router without that file prints 255, 254 and 253. Matching on the
    // name alone, this side decided the reply held no baseline at all: the
    // whole scan was then discarded as unreadable, so the monitor showed
    // nothing whatever on a router whose rule table it had read perfectly.
    const readout = parseScanOutput(
      reply({ rules: NUMERIC_BASELINE, main: ['default via 203.0.113.1 dev eth1'] })
    )

    expect(scanRulesLookWhole(readout)).toBe(true)

    // And the three are the kernel's own, so they are not three foreign rules
    // at the top of the table either.
    const { rows, summary } = scan(
      reply({ rules: NUMERIC_BASELINE, main: ['default via 203.0.113.1 dev eth1'] })
    )
    expect(rows).toHaveLength(0)
    expect(summary.foreign).toBe(0)
  })

  it('still reports a hand-written rule that names a baseline table', () => {
    // The preference is half the test and the selector is the other half: at
    // priority 100, `from all lookup 254` is a real way to defeat every policy
    // rule below it rather than the rule the kernel booted with.
    const { rows } = scan(
      reply({
        rules: [...NUMERIC_BASELINE, '100:\tfrom all lookup 254'],
        main: ['default via 203.0.113.1 dev eth1']
      })
    )

    expect(rows.map((row) => row.pref)).toEqual([100])
    expect(rowAt(rows, 100).tableLabel).toBe('main (254)')
  })

  it('does not read a table whose name it cannot parse as some other table', () => {
    // A name in rt_tables is administrator-written text, and nothing stops it
    // holding a character this reader will not accept. The table pattern used
    // to match the leading run of acceptable characters and stop, so a rule
    // pointing at `x;reboot` was reported - in a sentence built to be believed
    // - as sending that address to table `x`, which on this router is a
    // different table with a different way out.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup x;reboot'],
        main: ['default via 203.0.113.1 dev eth1'],
        tables: ['x'],
        routes: ['x default via 10.9.9.1 dev tun9']
      })
    )

    const row = rowAt(rows, 900)
    expect(row.table).toBe('')
    expect(row.wan).toBe('')
    // The table column says which of the two it is, because `no table` is a
    // different rule and a reader grouping by it would go looking for one.
    expect(row.tableLabel).toBe('unreadable table name')
    expect(row.reason).not.toContain('table x')
    expect(row.reason).not.toContain('tun9')
    expect(row.reason).toContain('names a routing table this scan could not read')
    // ...and it is not the "no table at all" sentence either: that one says the
    // kernel acts on the rule directly, which is not what this rule does.
    expect(row.reason).not.toContain('the kernel acts on it directly')
    expect(row.unreachable).toBe(false)
  })

  it('keeps saying so for a rule that genuinely names no table', () => {
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '32000:\tfrom 10.0.0.5 blackhole'],
        main: ['default via 203.0.113.1 dev eth1']
      })
    )

    expect(rowAt(rows, 32_000).reason).toContain('names no routing table')
  })
})

describe('the one shell the scan runs, read as a shell programmer', () => {
  it('guards every table token at each line that puts it on a command line', () => {
    // The token comes out of the router's own rt_tables, so it is untrusted
    // text arriving in the middle of a script. The guard appears twice on
    // purpose - once where the list is built and once in the loop that
    // interpolates it - and proving it again costs nothing at all.
    const guard = SCAN_COMMAND.split(`case "$t" in ''|*[!A-Za-z0-9_.-]*) continue;; esac`)
    expect(guard).toHaveLength(3)
    expect(SCAN_COMMAND.indexOf('ip -4 route show table "$t"')).toBeGreaterThan(
      SCAN_COMMAND.lastIndexOf(`case "$t" in`)
    )
  })

  it('keeps pathname expansion off, for a table named like a glob', () => {
    // The token loop iterates over unquoted words that came off the router, so
    // a table named `*` would expand to the working directory's contents
    // before the guard above ever saw it.
    expect(SCAN_COMMAND.startsWith('set -uf\n')).toBe(true)
  })

  it('prints the queried token list with printf, for a table named like a flag', () => {
    // The guarded character set allows a leading `-`, and a table named `-n`
    // is a flag to every echo on the router rather than a name: the token
    // would vanish from `===TABLES===` while the routes loop went on querying
    // it, and this side would read a table it had asked about as one it had not.
    expect(SCAN_COMMAND).toContain(`for t in $BM_T; do printf '%s\\n' "$t"; done`)
    expect(SCAN_COMMAND).not.toContain('echo "$t"')
  })

  it('asks the router for one rule more than this side keeps', () => {
    // The only way a table that ends at the cap can be told from one that was
    // cut there. `head` prints the same thing either way.
    expect(SCAN_COMMAND).toContain(`head -n ${SCAN_MAX_RULES + 1} "$BM_SCAN"`)
  })
})
