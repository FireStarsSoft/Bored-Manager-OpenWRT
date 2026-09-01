import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { DirectEngine } from '../../openwrt/main/direct'
import { HostStore } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * Twelve routers that are not the stock one, put through the create gate.
 *
 * This file exists because of a specific released fault and the specific way it
 * got released. Whether an interface was a LAN or an uplink was decided by
 * looking at its device name: anything not on a `br-` device was an uplink. On
 * the one router that was ever tested - a stock OpenWRT with `lan` on `br-lan`
 * - that is true, so the gate passed. On a router whose LAN is a VLAN, a plain
 * port or a radio, every LAN was read as a WAN, the LAN search came back empty,
 * and typing the address of a device on your own network was answered with "is
 * not inside any LAN subnet on this router". Nothing on the page could tell
 * that apart from a typo, and the reporter's first guess was that their router
 * packages were out of date.
 *
 * So the assertions here are all of the same shape: an entire router layout is
 * written down - the interfaces netifd would report and the /etc/config the
 * preparation probe would read back - and the real check gate is asked what it
 * makes of it. A verdict is only worth anything if it holds for all twelve.
 */

const T0 = 1_700_000_000_000

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

// -------------------------------------------------------------- the layouts

/**
 * One router: what the interface dump says, and what `uci show` says.
 *
 * The two halves are kept apart because that is how they reach the module and
 * because they are what disagree in every case below - the dump carries device
 * names and protocols, and only /etc/config states which side of the router an
 * interface faces.
 */
interface Layout {
  ifaces: IfaceState[]
  dhcp: string[]
  network: string[]
  firewall: string[]
}

/** An interface with an IPv4 address, however it is wired underneath. */
function iface(
  name: string,
  proto: string,
  device: string,
  addr: string,
  over: Partial<IfaceState> = {}
): IfaceState {
  return {
    name,
    proto,
    device,
    l3Device: device,
    up: true,
    pending: false,
    autostart: true,
    uptimeSec: 4_000,
    ipv4: { addr, mask: 24 },
    ...over
  }
}

/** The dnsmasq section a LAN carries: it names the network and serves on it. */
const serves = (name: string): string[] => [
  `dhcp.${name}=dhcp`,
  `dhcp.${name}.interface='${name}'`,
  `dhcp.${name}.limit='150'`
]

/** Stock OpenWRT's stub for the uplink, which exists only to switch itself off. */
const ignores = (name: string): string[] => [
  `dhcp.${name}=dhcp`,
  `dhcp.${name}.interface='${name}'`,
  `dhcp.${name}.ignore='1'`
]

/**
 * `masq` takes the spelling as well as the answer, because UCI has four words
 * for true and fw4 honours all of them while LuCI writes only the first.
 */
const zone = (
  index: number,
  name: string,
  networks: string[],
  masq: boolean | string = false
): string[] => [
  `firewall.@zone[${index}]=zone`,
  `firewall.@zone[${index}].name='${name}'`,
  ...networks.map((network) => `firewall.@zone[${index}].network='${network}'`),
  ...(masq ? [`firewall.@zone[${index}].masq='${masq === true ? '1' : masq}'`] : [])
]

/** The other legal way to write a zone's membership: the netdevs themselves. */
const deviceZone = (index: number, name: string, devices: string[]): string[] => [
  `firewall.@zone[${index}]=zone`,
  `firewall.@zone[${index}].name='${name}'`,
  ...devices.map((device) => `firewall.@zone[${index}].device='${device}'`)
]

/** A LAN interface section, prefix delegation and all, as LuCI writes one. */
const lanSection = (name: string): string[] => [
  `network.${name}=interface`,
  `network.${name}.ip6assign='60'`
]

/** The uplink's section, already carrying the routing table this module needs. */
const wanSection = (name: string): string[] => [
  `network.${name}=interface`,
  `network.${name}.ip4table='42'`
]

/**
 * Rows 1-4: one LAN and one DHCP uplink, with the LAN moved onto a different
 * device each time. Only `device` changes between them, which is exactly the
 * point - it is the one thing the old classifier looked at.
 */
function oneLanOn(device: string): Layout {
  return {
    ifaces: [
      iface('lan', 'static', device, '192.168.1.1'),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
    ],
    dhcp: [...serves('lan'), ...ignores('wan')],
    network: [...lanSection('lan'), ...wanSection('wan')],
    firewall: [...zone(0, 'lan', ['lan']), ...zone(1, 'wan', ['wan', 'wan6'], true)]
  }
}

/** Rows 7-10 and 12: one bridged LAN, and an uplink the caller describes. */
function lanPlusUplink(wan: IfaceState, lanAddr = '192.168.1.1'): Layout {
  return {
    ifaces: [iface('lan', 'static', 'br-lan', lanAddr), wan],
    dhcp: [...serves('lan'), ...ignores(wan.name)],
    network: [...lanSection('lan'), ...wanSection(wan.name)],
    firewall: [...zone(0, 'lan', ['lan']), ...zone(1, 'wan', [wan.name], true)]
  }
}

// ------------------------------------------------------------ the check gate

const CREATE = {
  name: 'Printer',
  targetKind: 'ip',
  address: '192.168.1.50',
  wan: 'wan',
  whenDown: 'hold'
}

function probeText(layout: Layout): string {
  return [
    '===DHCP===',
    ...layout.dhcp,
    '===NETWORK===',
    ...layout.network,
    '===FIREWALL===',
    ...layout.firewall,
    '===SYSCTL===',
    'net.netfilter.nf_conntrack_max=65536'
  ].join('\n')
}

function model(layout: Layout): RouterModel {
  return {
    t: T0,
    sys: { uptimeSec: 4_000, load1: 0, memTotal: 0, memFree: 0 },
    ifaces: layout.ifaces,
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases: [],
    rules: [],
    rates: {}
  }
}

/**
 * The real engine over one written-down router. `configUnreadable` stands in
 * for the case that is not a layout at all - a router that answered nothing -
 * because the gate has to stay usable there rather than refusing every address
 * on the grounds that it could not classify anything.
 */
function engineOver(layout: Layout, options: { configUnreadable?: boolean } = {}): DirectEngine {
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
  harness.exec.mockImplementation(async (_command, execOptions) => {
    const stdin = execOptions?.stdin ?? ''
    if (stdin.includes("echo '===DHCP==='")) {
      return options.configUnreadable ? { code: 1, stdout: '', stderr: '' } : ok(probeText(layout))
    }
    if (stdin.includes('bm_wanbind')) return ok('===DONE===')
    return ok()
  })
  const rules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  const sample = model(layout)
  return new DirectEngine({
    ctx: harness.ctx,
    store,
    rules: () => rules,
    latestModel: () => sample
  })
}

async function check(
  layout: Layout,
  values: Partial<typeof CREATE> = {},
  options: { configUnreadable?: boolean } = {}
): Promise<{ ok: boolean; text: string }> {
  const report = await engineOver(layout, options).check({ ...CREATE, ...values })
  const text = report.findings
    .map((finding) => `${finding.label}\n${finding.detail ?? ''}`)
    .join('\n')
  return { ok: report.ok, text }
}

// ------------------------------------------------------------- rows 1 to 6

describe('the LAN an address is behind, on routers whose LAN is not a bridge', () => {
  it('row 1: finds it on stock OpenWrt, where the LAN is br-lan', async () => {
    const report = await check(oneLanOn('br-lan'))

    expect(report.ok).toBe(true)
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })

  it('row 2: finds it when the LAN is a VLAN with no bridge under it', async () => {
    // The reported bug, exactly. `eth0.1` does not begin with `br-`, so the LAN
    // was classified as an uplink and the address was refused as belonging to
    // no network on a router where it plainly does.
    const report = await check(oneLanOn('eth0.1'))

    expect(report.ok).toBe(true)
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })

  it('row 3: finds it when the LAN is a plain port', async () => {
    const report = await check(oneLanOn('eth0'))

    expect(report.ok).toBe(true)
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })

  it('row 4: finds it when the LAN is wireless only', async () => {
    const report = await check(oneLanOn('wlan0'))

    expect(report.ok).toBe(true)
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })

  const several: Layout = {
    ifaces: [
      iface('lan', 'static', 'br-lan', '192.168.1.1'),
      iface('guest', 'static', 'br-guest', '192.168.3.1'),
      iface('iot', 'static', 'br-lan.20', '192.168.20.1'),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
    ],
    dhcp: [...serves('lan'), ...serves('guest'), ...serves('iot'), ...ignores('wan')],
    network: [
      ...lanSection('lan'),
      ...lanSection('guest'),
      ...lanSection('iot'),
      ...wanSection('wan')
    ],
    firewall: [
      ...zone(0, 'lan', ['lan']),
      ...zone(1, 'guest', ['guest']),
      ...zone(2, 'iot', ['iot']),
      ...zone(3, 'wan', ['wan'], true)
    ]
  }

  it('row 5: picks the right one of three LANs, whatever each is wired on', async () => {
    // Three LANs, three device shapes, and the zone the forwarding is written
    // from differs per LAN - so choosing the wrong one is not a cosmetic error,
    // it is a device with no firewall path.
    expect((await check(several, { address: '192.168.1.50' })).text).toContain(
      '192.168.1.50 is on LAN lan (192.168.1.0/24)'
    )
    expect((await check(several, { address: '192.168.3.50' })).text).toContain(
      '192.168.3.50 is on LAN guest (192.168.3.0/24)'
    )
    expect((await check(several, { address: '192.168.20.50' })).text).toContain(
      '192.168.20.50 is on LAN iot (192.168.20.0/24)'
    )
  })

  const nested: Layout = {
    ifaces: [
      iface('lan', 'static', 'br-lan', '192.168.1.1'),
      iface('lab', 'static', 'br-lan.30', '192.168.1.129', { ipv4: { addr: '192.168.1.129', mask: 25 } }),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
    ],
    dhcp: [...serves('lan'), ...serves('lab'), ...ignores('wan')],
    network: [...lanSection('lan'), ...lanSection('lab'), ...wanSection('wan')],
    firewall: [
      ...zone(0, 'lan', ['lan']),
      ...zone(1, 'lab', ['lab']),
      ...zone(2, 'wan', ['wan'], true)
    ]
  }

  it('row 6: gives a /25 inside a /24 to the /25', async () => {
    // Both answers are true and only the longer one names the zone the device
    // is really in.
    expect((await check(nested, { address: '192.168.1.130' })).text).toContain(
      '192.168.1.130 is on LAN lab (192.168.1.128/25)'
    )
    expect((await check(nested, { address: '192.168.1.50' })).text).toContain(
      '192.168.1.50 is on LAN lan (192.168.1.0/24)'
    )
  })
})

// ------------------------------------------------------------ rows 7 and 12

describe('a WAN that runs the static protocol, like every LAN does', () => {
  const doubleNat = lanPlusUplink(
    iface('wan', 'static', 'eth1', '192.168.100.2', { ip4Table: 42 })
  )

  it('row 7: leaves the LAN as the LAN when both contain private addresses', async () => {
    const report = await check(doubleNat)

    expect(report.ok).toBe(true)
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })

  it('row 7: says what an address on the upstream network really is', async () => {
    // The one case where the address is genuinely inside a subnet this router
    // carries and still cannot be bound. A bare "not inside any LAN subnet"
    // here is a lie the operator can see is a lie - the address is obviously on
    // the router - and it is the sentence that made the reported bug look like
    // a packaging problem.
    const report = await check(doubleNat, { address: '192.168.100.50' })

    expect(report.ok).toBe(false)
    expect(report.text).toContain(
      '192.168.100.50 is on wan, which this router uses as an uplink rather than as a LAN'
    )
    expect(report.text).toContain('192.168.100.0/24')
    expect(report.text).toContain('which masquerades')
    // And it says what would have to change for the answer to be different.
    expect(report.text).toContain('/etc/config/dhcp')
  })

  const overlapping = lanPlusUplink(
    iface('wan', 'static', 'eth1', '192.168.1.2', { ip4Table: 42 })
  )

  it('row 12: prefers the real LAN when the static WAN shares its subnet', async () => {
    // Both interfaces contain the address at the same prefix length, so nothing
    // about the arithmetic separates them - only the configuration does.
    const report = await check(overlapping)

    expect(report.ok).toBe(true)
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
    expect(report.text).not.toContain('is on LAN wan')
  })
})

// ----------------------------------------------------------- rows 8, 9, 10

describe('uplinks that are not a plain ethernet port', () => {
  it('row 8: takes a PPPoE WAN, whose l3 device is not the port it dials on', async () => {
    const report = await check(
      lanPlusUplink(
        iface('wan', 'pppoe', 'eth1', '203.0.113.20', {
          l3Device: 'pppoe-wan',
          ip4Table: 42
        })
      )
    )

    expect(report.ok).toBe(true)
    expect(report.text).toContain('wan is a pppoe WAN port')
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })

  it('row 9: takes a WAN on a tagged VLAN', async () => {
    const report = await check(
      lanPlusUplink(iface('wan', 'dhcp', 'eth1.835', '203.0.113.20', { ip4Table: 42 }))
    )

    expect(report.ok).toBe(true)
    expect(report.text).toContain('wan is a dhcp WAN port')
  })

  it('row 10: takes a WAN that is itself a bridge', async () => {
    // A bridged modem port. The old classifier called this a LAN on the
    // strength of its name, so the WAN dropdown did not offer it at all and the
    // gate would have read it as a source zone if anything had.
    const report = await check(
      lanPlusUplink(iface('wan', 'dhcp', 'br-wan', '203.0.113.20', { ip4Table: 42 }))
    )

    expect(report.ok).toBe(true)
    expect(report.text).toContain('wan is a dhcp WAN port')
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })
})

// ------------------------------------------------------------------- row 11

describe('a router with nothing to bind from', () => {
  const noLan: Layout = {
    ifaces: [
      {
        name: 'lan',
        proto: 'static',
        device: 'br-lan',
        l3Device: 'br-lan',
        up: false,
        pending: false,
        autostart: true,
        uptimeSec: 0
      },
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
    ],
    dhcp: [...serves('lan'), ...ignores('wan')],
    network: [...lanSection('lan'), ...wanSection('wan')],
    firewall: [...zone(0, 'lan', ['lan']), ...zone(1, 'wan', ['wan'], true)]
  }

  it('row 11: still says the router has no LAN carrying an IPv4 subnet', async () => {
    // The refusal that has to survive the rewrite: with no LAN address there is
    // no subnet to be inside, and the remedy is on the router rather than in
    // the form. It fires for a typed address too, which it did not before - the
    // address branch answered first and said only "not inside any LAN subnet",
    // which sent the reader looking for a subnet that does not exist.
    const report = await check(noLan)

    expect(report.ok).toBe(false)
    expect(report.text).toContain('This router has no LAN interface with an IPv4 subnet')
    expect(report.text).toContain('Give the LAN an address')
  })
})

// ------------------------------------------------- the refusal is readable

describe('a refusal names what it looked at', () => {
  const several: Layout = {
    ifaces: [
      iface('lan', 'static', 'eth0.1', '192.168.1.1'),
      iface('guest', 'static', 'wlan0', '192.168.3.1'),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
    ],
    dhcp: [...serves('lan'), ...serves('guest'), ...ignores('wan')],
    network: [...lanSection('lan'), ...lanSection('guest'), ...wanSection('wan')],
    firewall: [
      ...zone(0, 'lan', ['lan']),
      ...zone(1, 'guest', ['guest']),
      ...zone(2, 'wan', ['wan'], true)
    ]
  }

  it('lists every LAN it searched, so a mismatch can be seen rather than guessed', async () => {
    const report = await check(several, { address: '10.0.0.5' })

    expect(report.ok).toBe(false)
    expect(report.text).toContain('10.0.0.5 is not inside any LAN subnet on this router')
    expect(report.text).toContain('lan 192.168.1.0/24')
    expect(report.text).toContain('guest 192.168.3.0/24')
  })

  it('names the uplinks it deliberately did not search', async () => {
    const report = await check(several, { address: '10.0.0.5' })

    expect(report.text).toContain('Uplinks are not searched')
    expect(report.text).toContain('wan 203.0.113.0/24')
  })

  it('lists the LANs when a MAC has no lease and there is more than one', async () => {
    const report = await check(several, {
      targetKind: 'mac',
      address: 'a4:b1:c2:00:11:22'
    })

    expect(report.ok).toBe(false)
    expect(report.text).toContain('this router has 2 LAN interfaces')
    expect(report.text).toContain('lan 192.168.1.0/24')
  })
})

// -------------------------------------------------- the gate on the WAN pick

describe('the WAN the form named', () => {
  it('refuses one the router describes as a LAN', async () => {
    // The dropdown is permissive on purpose now - it cannot read /etc/config,
    // and hiding a real WAN is worse than listing an extra interface - so this
    // is the only thing standing between a mis-click and a rule that steers a
    // device back into the network it is already on.
    const report = await check(oneLanOn('br-lan'), { wan: 'lan', address: '192.168.1.50' })

    expect(report.ok).toBe(false)
    expect(report.text).toContain('lan is a LAN on this router, not a WAN port')
    expect(report.text).toContain('/etc/config/dhcp has it handing out DHCP leases')
  })

  it('still accepts the uplink of the same router', async () => {
    // The positive control: the refusal is about what the router says, not
    // about every interface running a protocol a WAN can run.
    expect((await check(oneLanOn('br-lan'))).ok).toBe(true)
  })

  /**
   * A routed prefix from the ISP - so the WAN zone does no NAT - beside a guest
   * network that does. Both halves of the masquerading reading point the wrong
   * way here at once, which is why the classifier weighs several facts instead
   * of trusting one.
   */
  const routed: Layout = {
    ifaces: [
      iface('lan', 'static', 'br-lan', '192.168.1.1'),
      iface('guest', 'static', 'br-guest', '192.168.3.1'),
      iface('wan', 'static', 'eth1', '198.51.100.34', { ip4Table: 42 })
    ],
    dhcp: [...serves('lan'), ...serves('guest')],
    network: [...lanSection('lan'), ...lanSection('guest'), ...wanSection('wan')],
    firewall: [
      ...zone(0, 'lan', ['lan']),
      ...zone(1, 'guest', ['guest'], true),
      ...zone(2, 'wan', ['wan'])
    ]
  }

  it('takes a routed WAN whose zone does no NAT, even beside one that does', async () => {
    // Refusing this would be the same unactionable refusal in a new place: the
    // operator's WAN is a WAN and nothing they could read would say why the
    // form disagrees.
    const report = await check(routed)

    expect(report.text).not.toContain('wan is a LAN on this router')
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })

  it('keeps a masquerading guest network a LAN, because it serves DHCP', async () => {
    // The mirror of the case above: a guest zone that NATs its own clients is a
    // common way to write one, and it is still the network the device is on.
    const report = await check(routed, { address: '192.168.3.50' })

    expect(report.text).toContain('192.168.3.50 is on LAN guest (192.168.3.0/24)')
  })
})

// ------------------------------------- rows 13 and 14: the other spellings

/**
 * Two routers that are correct and were refused anyway, because one legal way
 * of writing something in /etc/config was read and the others were not.
 *
 * Both are the reported bug arriving by a different road, which is why they sit
 * beside the twelve rather than in a file of their own: the operator's router
 * works, the create gate says it does not, and nothing on the page explains the
 * disagreement.
 */
describe('routers that spell a fact the way LuCI does not', () => {
  /**
   * Row 13. A bridged modem upstream, so the uplink is static and private; the
   * default route comes from a `config route` section, so the interface carries
   * no `option gateway`; the WAN zone says `masq 'on'`, which fw4 honours; and
   * a guest network that NATs its own clients says `masq '1'`. Reading `masq`
   * as the one string `1` costs the uplink two points and hands the LAN side
   * one, on a scale whose largest single weight is three.
   */
  const spelledOn: Layout = {
    ifaces: [
      iface('lan', 'static', 'br-lan', '192.168.1.1'),
      iface('guest', 'static', 'br-guest', '192.168.3.1'),
      iface('wan', 'static', 'eth1', '192.168.100.2', { ip4Table: 42 })
    ],
    dhcp: [...serves('lan'), ...serves('guest')],
    network: [...lanSection('lan'), ...lanSection('guest'), ...wanSection('wan')],
    firewall: [
      ...zone(0, 'lan', ['lan']),
      ...zone(1, 'guest', ['guest'], '1'),
      ...zone(2, 'wan', ['wan'], 'on')
    ]
  }

  it('row 13: takes the WAN whose zone spells masquerading `on`', async () => {
    const report = await check(spelledOn)

    expect(report.ok).toBe(true)
    expect(report.text).not.toContain('wan is a LAN on this router')
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })

  it('row 13: does not warn about SNAT the zone already performs', async () => {
    const report = await check(spelledOn)

    expect(report.text).not.toContain('does not have masquerading enabled')
  })

  /**
   * Row 14. The LAN is `eth0.1` with no bridge to name a network on, so its
   * zone lists the device instead - which fw4 accepts and this module could not
   * read at all. The interface classifier reads it now; the create gate's own
   * zone lookup is still given logical names only, so the create is still
   * refused here. What it may no longer do is tell the operator to assign a
   * zone they have already assigned.
   */
  const zonedByDevice: Layout = {
    ifaces: [
      iface('lan', 'static', 'eth0.1', '192.168.1.1'),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
    ],
    dhcp: [...serves('lan'), ...ignores('wan')],
    network: [...lanSection('lan'), ...wanSection('wan')],
    firewall: [...deviceZone(0, 'lan', ['eth0.1']), ...zone(1, 'wan', ['wan'], true)]
  }

  it('row 14: still finds the LAN the address is on', async () => {
    // The classifier has both zone readings back, so nothing here reads the
    // LAN as an uplink the way an unplaced interface used to.
    const report = await check(zonedByDevice)

    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
    expect(report.text).not.toContain('lan is a LAN on this router')
  })

  it('row 14: accepts the zone rather than denying the router', async () => {
    // The check now passes the interface's netdevs down to the zone lookup, so
    // a zone written `list device 'eth0.1'` is found and this router creates.
    // While only half of that wiring existed the check refused, and the useful
    // thing about the refusal was that it named both spellings instead of
    // telling a correctly configured router it had no zone at all.
    const report = await check(zonedByDevice)

    expect(report.ok).toBe(true)
    expect(report.text).not.toContain('is not assigned to a firewall zone')
  })
})

// ------------------------------------------------- when nothing settles it

describe('a router whose configuration settles nothing', () => {
  /** Zones with no masquerading anywhere and no dnsmasq section on the LAN. */
  const silent: Layout = {
    ifaces: [
      iface('lan', 'static', 'eth0', '192.168.1.1'),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
    ],
    dhcp: [],
    network: ['network.lan=interface', ...wanSection('wan')],
    firewall: [...zone(0, 'lan', ['lan']), ...zone(1, 'wan', ['wan'])]
  }

  it('still finds the LAN, and says out loud that it is not sure', async () => {
    // Refusing here would put us back where we started - a refusal about a
    // router the operator does not recognise. Choosing silently is the other
    // failure: the forwarding is written once, from this zone, and never
    // rewritten, so a wrong choice is a device with no path and a page that
    // says everything worked.
    const report = await check(silent)

    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
    expect(report.text).toContain(
      'Nothing this router states says whether lan is a LAN or an uplink'
    )
  })

  it('says the difference when the configuration could not be read at all', async () => {
    const report = await check(oneLanOn('eth0'), {}, { configUnreadable: true })

    expect(report.ok).toBe(false)
    expect(report.text).toContain('Router preparation state could not be read')
    // The LAN search does not collapse just because the probe did: the address
    // is still placed, and the warning says which of the two situations it is.
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
    expect(report.text).toContain('The router configuration could not be read on this check')
  })
})

// ------------------------------------------- both ends of a routed prefix

/**
 * A routed /29 from the ISP, delegated to a DMZ.
 *
 * Both ends of that block carry a public address, so `routableAddress` on its
 * own cannot tell them apart - and it used to be worth 2 against the 1 a quiet
 * zone is worth, which made the DMZ read as an uplink and had Binding 1-1
 * refuse a public server on it. Pinning a public host to a chosen WAN is the
 * one thing that feature is for, so this pair of routers is the regression net
 * for the whole reading: here the router names its uplink another way (`wan`
 * dials DHCP), so the address stops being evidence on the DMZ; in `routed`
 * above, nothing else on the router faces outwards and it still is.
 */
const dmz: Layout = {
  ifaces: [
    iface('lan', 'static', 'br-lan', '192.168.1.1'),
    iface('dmz', 'static', 'eth0.5', '203.0.113.1'),
    iface('wan', 'dhcp', 'eth1', '198.51.100.34', { ip4Table: 42 })
  ],
  dhcp: [...serves('lan'), ...ignores('wan')],
  network: [...lanSection('lan'), 'network.dmz=interface', ...wanSection('wan')],
  firewall: [
    ...zone(0, 'lan', ['lan']),
    ...zone(1, 'dmz', ['dmz']),
    ...zone(2, 'wan', ['wan'], true)
  ]
}

describe('a routed public block, seen from both ends', () => {
  it('reads the DMZ as a LAN, not as a second uplink', async () => {
    const report = await check(dmz, { address: '203.0.113.3' })

    expect(report.ok).toBe(true)
    expect(report.text).toContain('203.0.113.3 is on LAN dmz')
    expect(report.text).not.toContain('which this router uses as an uplink')
  })

  it('still reads the ISP-facing port as the uplink', async () => {
    // The other half of the same router: `wan` dials, which settles it on its
    // own, so narrowing the address reading cannot cost us the real uplink.
    expect((await check(dmz)).ok).toBe(true)
  })
})

describe('a refusal that weighed something the other way', () => {
  /** One LAN, and a second interface the router places outwards but weakly. */
  const contested: Layout = {
    ifaces: [
      iface('lan', 'static', 'br-lan', '192.168.1.1'),
      iface('iot', 'static', 'eth0.30', '10.9.0.1'),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
    ],
    // /etc/config/dhcp says nothing about `iot`, so the only two readings are
    // its masquerading zone (uplink, 2) and the prefix it delegates downstream
    // (LAN, 1) - a 2-1 verdict, which is the shape this describe block is about.
    dhcp: [...serves('lan'), ...ignores('wan')],
    network: [...lanSection('lan'), ...lanSection('iot'), ...wanSection('wan')],
    firewall: [
      ...zone(0, 'lan', ['lan']),
      ...zone(1, 'iot', ['iot'], true),
      ...zone(2, 'wan', ['wan'], true)
    ]
  }

  it('says what argued the other way instead of sounding unanimous', async () => {
    const report = await check(contested, { address: '10.9.0.50' })

    expect(report.ok).toBe(false)
    expect(report.text).toContain('which this router uses as an uplink')
    // The reading is 2-1, not 2-0, and the operator is told so.
    expect(report.text).toContain('Against that')
    expect(report.text).toContain('a reading of the configuration rather than a certainty')
  })

  it('does not offer a remedy the router has already applied', async () => {
    // `iot` is in a zone that masquerades, so "give it a zone that does not
    // masquerade" is real advice here and must still be offered...
    const report = await check(contested, { address: '10.9.0.50' })
    expect(report.text).toContain('a firewall zone that does not masquerade')

    // ...while on the DMZ router the zone already does not masquerade, so that
    // half of the sentence would be a no-op and must not be printed.
    const quiet = await check(
      { ...dmz, ifaces: dmz.ifaces.map((i) => (i.name === 'wan' ? { ...i, proto: 'static' } : i)) },
      { address: '203.0.113.3' }
    )
    if (quiet.text.includes('which this router uses as an uplink')) {
      expect(quiet.text).not.toContain('a firewall zone that does not masquerade')
    }
  })
})
