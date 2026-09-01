import { describe, expect, it } from 'vitest'
import type { ModuleCheckFinding, ModuleCheckReport } from '@shared/check'
import type { ModuleExecOptions, ModuleExecResult } from '@shared/modules'
import {
  BindingEngine,
  firewallZoneForNetwork,
  preparationProbe,
  zoneFindings,
  type ExecDeps,
  type RouterPreparationProbe
} from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { routerLayout } from '../../openwrt/main/direct'
import { HostStore } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * One fact, several legal spellings, and the refusals that come of reading only
 * one of them.
 *
 * Every case here is the shape of the bug that started this work: a confident
 * refusal aimed at a router that is configured correctly, produced because
 * /etc/config was read for one narrow spelling of something OpenWrt lets an
 * operator state several ways. A zone that masquerades can say `masq 'on'`; a
 * zone can name its members by device instead of by network; a `config dhcp`
 * section can name its network by being called after it. LuCI writes none of
 * those three, which is exactly why they bite the hand-edited and migrated
 * routers this module's classifier exists to be right about.
 *
 * So nothing below hands a reader a document assembled by hand. Each router is
 * written down as `uci show` would print it in full, and then filtered by the
 * grep the preparation script really ships - lifted out of the script that was
 * sent, not copied into this file - so that narrowing one of those greps again
 * fails here rather than on somebody's router.
 */

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

// --------------------------------------------------------------- the routers

/** One router as `uci show` prints it, before anything filters a line out. */
interface Dump {
  ifaces: IfaceState[]
  dhcp: string[]
  network: string[]
  firewall: string[]
}

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

const DNSMASQ = ['dhcp.@dnsmasq[0]=dnsmasq', "dhcp.@dnsmasq[0].dhcpleasemax='1000'"]

const servesDhcp = (name: string): string[] => [
  `dhcp.${name}=dhcp`,
  `dhcp.${name}.interface='${name}'`,
  `dhcp.${name}.start='100'`,
  `dhcp.${name}.limit='150'`
]

const ignoresDhcp = (name: string): string[] => [
  `dhcp.${name}=dhcp`,
  `dhcp.${name}.interface='${name}'`,
  `dhcp.${name}.ignore='1'`
]

const lanSection = (name: string, addr: string): string[] => [
  `network.${name}=interface`,
  `network.${name}.device='br-${name}'`,
  `network.${name}.proto='static'`,
  `network.${name}.ipaddr='${addr}'`,
  `network.${name}.ip6assign='60'`
]

/** A zone as LuCI writes one: members by network, masquerading spelled `1`. */
const zone = (
  index: number,
  name: string,
  networks: readonly string[],
  masq?: string
): string[] => [
  `firewall.@zone[${index}]=zone`,
  `firewall.@zone[${index}].name='${name}'`,
  ...networks.map((network) => `firewall.@zone[${index}].network='${network}'`),
  `firewall.@zone[${index}].input='ACCEPT'`,
  ...(masq ? [`firewall.@zone[${index}].masq='${masq}'`] : [])
]

/** The other legal spelling: members named by the netdevs themselves. */
const deviceZone = (
  index: number,
  name: string,
  devices: readonly string[],
  masq?: string
): string[] => [
  `firewall.@zone[${index}]=zone`,
  `firewall.@zone[${index}].name='${name}'`,
  ...devices.map((device) => `firewall.@zone[${index}].device='${device}'`),
  ...(masq ? [`firewall.@zone[${index}].masq='${masq}'`] : [])
]

/**
 * The router the masquerading spelling decides.
 *
 * Its uplink is a static private address behind a bridged modem, its default
 * route lives in a `config route` section so the interface carries no
 * `option gateway`, and its `wan` zone spells masquerading `on` - which fw4
 * honours. Beside it sits a guest network that NATs its own clients and spells
 * the same option `1`. Read `masq` as the single string `1` and the uplink
 * loses two points of uplink evidence and gains one of LAN evidence, because
 * some other zone on the router masquerades and this one appears not to.
 */
const bridgedModem: Dump = {
  ifaces: [
    iface('lan', 'static', 'br-lan', '192.168.1.1'),
    iface('guest', 'static', 'br-guest', '192.168.3.1'),
    iface('wan', 'static', 'eth1', '192.168.100.2', { ip4Table: 201 })
  ],
  dhcp: [...DNSMASQ, ...servesDhcp('lan'), ...servesDhcp('guest')],
  network: [
    ...lanSection('lan', '192.168.1.1'),
    ...lanSection('guest', '192.168.3.1'),
    'network.wan=interface',
    "network.wan.device='eth1'",
    "network.wan.proto='static'",
    "network.wan.ipaddr='192.168.100.2'",
    "network.wan.ip4table='201'",
    'network.@route[0]=route',
    "network.@route[0].interface='wan'",
    "network.@route[0].target='0.0.0.0/0'",
    "network.@route[0].gateway='192.168.100.1'"
  ],
  firewall: [
    ...zone(0, 'lan', ['lan']),
    ...zone(1, 'guest', ['guest'], '1'),
    ...zone(2, 'wan', ['wan'], 'on')
  ]
}

/**
 * The router the zone-membership spelling decides: a LAN on a VLAN, put in its
 * zone by `list device` because there is no bridge to name a network on.
 */
const deviceNamedLan: Dump = {
  ifaces: [
    iface('lan', 'static', 'eth0.1', '192.168.1.1'),
    iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
  ],
  dhcp: [...DNSMASQ, ...servesDhcp('lan'), ...ignoresDhcp('wan')],
  network: [
    'network.lan=interface',
    "network.lan.device='eth0.1'",
    "network.lan.proto='static'",
    "network.lan.ip6assign='60'",
    'network.wan=interface',
    "network.wan.device='eth1'",
    "network.wan.ip4table='42'"
  ],
  firewall: [...deviceZone(0, 'lan', ['eth0.1']), ...zone(1, 'wan', ['wan'], '1')]
}

// ------------------------------------------------------- the shipped filters

/**
 * The `grep -E` one section of the preparation script really runs, pulled off
 * the script `preparationProbe` sent rather than copied.
 *
 * A POSIX ERE and a JavaScript RegExp mean the same thing by everything these
 * patterns use, so running one here is running the router's filter rather than
 * an imitation of it. Filtering is the whole point: a `list device` line that
 * the grep drops never reaches any reader, and a reader tested against a
 * hand-built document would pass while the router refused the create.
 */
function shippedFilter(script: string, config: string): RegExp {
  const found = script.match(new RegExp(`uci -q show ${config} [^\\n]*?grep -E '([^']*)'`))
  if (!found) throw new Error(`the preparation script no longer greps ${config} through one -E`)
  return new RegExp(found[1] ?? '')
}

const keep = (lines: readonly string[], filter: RegExp): string[] =>
  lines.filter((line) => filter.test(line))

/** What the router would send back, filtered exactly as the router filters it. */
function answer(dump: Dump, script: string): string {
  return [
    '===DHCP===',
    ...keep(dump.dhcp, shippedFilter(script, 'dhcp')),
    '===NETWORK===',
    ...keep(dump.network, shippedFilter(script, 'network')),
    '===FIREWALL===',
    ...keep(dump.firewall, shippedFilter(script, 'firewall')),
    '===SYSCTL===',
    'net.netfilter.nf_conntrack_max=262144'
  ].join('\n')
}

async function probeOf(dump: Dump): Promise<RouterPreparationProbe> {
  const harness = moduleHarness('openwrt', () => ok())
  harness.exec.mockImplementation(async (_command: string, options?: ModuleExecOptions) =>
    ok(answer(dump, options?.stdin ?? ''))
  )
  const deps: ExecDeps = {
    ctx: harness.ctx,
    disposed: false,
    options: { rules: () => DEFAULT_RULES }
  }
  return preparationProbe(deps)
}

function model(dump: Dump): RouterModel {
  return {
    t: 1_700_000_000_000,
    sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
    ifaces: dump.ifaces,
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases: [],
    rules: [],
    rates: {}
  }
}

const labels = (findings: readonly ModuleCheckFinding[]): string =>
  findings.map((finding) => `${finding.label} ${finding.detail ?? ''}`).join('\n')

// ------------------------------------------- the four spellings of a boolean

describe('a firewall zone that spells masquerading `on`', () => {
  it('is read as masquerading, because that is what fw4 does with it', async () => {
    const layout = routerLayout(model(bridgedModem), await probeOf(bridgedModem))

    expect(layout.byName.get('wan')?.zoneMasquerades).toBe(true)
  })

  it('leaves the uplink an uplink instead of moving it three points to LAN', async () => {
    // The sharp end. Denied `masquerades`, this uplink scores nothing at all,
    // and the guest zone's `masq '1'` then makes its own quiet zone read as
    // evidence of an inside network - so choosing the router's only WAN port
    // was refused with "wan is a LAN on this router, not a WAN port".
    const layout = routerLayout(model(bridgedModem), await probeOf(bridgedModem))

    expect(layout.byName.get('wan')?.role).toBe('uplink')
    expect(layout.byName.get('wan')?.uplinkEvidence.join(' ')).toContain('which masquerades')
    expect(layout.byName.get('wan')?.lanEvidence).toEqual([])
  })

  it('still keeps the LANs on the inside, masquerading guest network and all', async () => {
    // The control: reading the option properly must not turn a guest network
    // that NATs its own clients into an uplink.
    const layout = routerLayout(model(bridgedModem), await probeOf(bridgedModem))

    expect(layout.byName.get('lan')?.role).toBe('lan')
    expect(layout.byName.get('guest')?.role).toBe('lan')
  })

  it('stops the instance half warning about SNAT the router already does', async () => {
    // Same option, other reader. This warning stood on every check of that
    // router, on both create forms, and named a remedy already in place.
    const findings: ModuleCheckFinding[] = []
    zoneFindings(await probeOf(bridgedModem), { lan: 'lan', wans: ['wan'] }, findings)

    expect(labels(findings)).not.toContain('does not have masquerading enabled')
  })

  it('still says so for a zone that really does not masquerade', async () => {
    // The negative control the fix must not swallow: `masq '0'` is false, and
    // a WAN zone without SNAT is worth saying out loud.
    const quiet: Dump = {
      ...deviceNamedLan,
      firewall: [...deviceZone(0, 'lan', ['eth0.1']), ...zone(1, 'wan', ['wan'], '0')]
    }
    const findings: ModuleCheckFinding[] = []
    zoneFindings(await probeOf(quiet), { lan: 'lan', wans: ['wan'] }, findings)

    expect(labels(findings)).toContain('does not have masquerading enabled')
  })
})

// ------------------------------------------ a zone that names members by device

describe('a firewall zone whose members are named by device', () => {
  it('survives the preparation grep at all', async () => {
    // The filter is the first thing that has to keep the line: a reader cannot
    // match what the router never sent.
    const probe = await probeOf(deviceNamedLan)

    expect(
      probe.firewall.entries.some(([key, value]) => key.endsWith('.device') && value === 'eth0.1')
    ).toBe(true)
  })

  it('places the interface that sits on that device', async () => {
    const probe = await probeOf(deviceNamedLan)

    expect(firewallZoneForNetwork(probe.firewall, 'lan', ['eth0.1'])).toBe('lan')
  })

  it('places nothing when the caller has no device names to offer', async () => {
    // Not a regression, a boundary: this function is handed logical names, and
    // a caller that cannot say which netdevs they answer to gets the reading it
    // always gave rather than a guess.
    const probe = await probeOf(deviceNamedLan)

    expect(firewallZoneForNetwork(probe.firewall, 'lan')).toBe('')
  })

  it('lets `list network` answer first, wherever the zones happen to sit', async () => {
    // A device can appear in a zone the interface is not a member of - a zone
    // written against a VLAN's parent port, say. The statement naming the
    // logical interface is about the interface, so it wins even when the zone
    // making it is written second.
    const both: Dump = {
      ...deviceNamedLan,
      firewall: [
        ...deviceZone(0, 'iot', ['eth0.1']),
        ...zone(1, 'lan', ['lan']),
        ...zone(2, 'wan', ['wan'], '1')
      ]
    }
    const probe = await probeOf(both)

    expect(firewallZoneForNetwork(probe.firewall, 'lan', ['eth0.1'])).toBe('lan')
  })

  it('reads a trailing wildcard and refuses to read an exclusion as membership', async () => {
    // fw4 takes a pattern here and a leading `!` to exclude. Treating `!eth0.1`
    // as a membership statement would put the LAN in the one zone that has
    // explicitly said it is not in it.
    const wild: Dump = {
      ...deviceNamedLan,
      firewall: [
        ...deviceZone(0, 'blocked', ['!eth0.1']),
        ...deviceZone(1, 'lan', ['eth0.*']),
        ...zone(2, 'wan', ['wan'], '1')
      ]
    }
    const probe = await probeOf(wild)

    expect(firewallZoneForNetwork(probe.firewall, 'lan', ['eth0.1'])).toBe('lan')
  })

  it('gives the interface classifier back both of its zone readings', async () => {
    // Without the zone, `weigh` learns neither that this interface's zone does
    // not masquerade while the WAN's does, nor that the WAN's does - so the
    // whole firewall half of the evidence went missing on a router that states
    // it perfectly clearly.
    const layout = routerLayout(model(deviceNamedLan), await probeOf(deviceNamedLan))

    expect(layout.byName.get('lan')?.zone).toBe('lan')
    expect(layout.byName.get('lan')?.lanEvidence.join(' ')).toContain('does not masquerade')
    expect(layout.byName.get('lan')?.role).toBe('lan')
  })

  it('is found by the create gate when the caller passes the device names', async () => {
    const findings: ModuleCheckFinding[] = []
    const zones = zoneFindings(
      await probeOf(deviceNamedLan),
      { lan: 'lan', wans: ['wan'], devices: new Map([['lan', ['eth0.1']]]) },
      findings
    )

    expect(zones.lanZone).toBe('lan')
    expect(labels(findings)).not.toContain('is not assigned to a firewall zone')
  })

  it('says what was looked at when the caller passes none', async () => {
    // The gate's own callers do not pass devices yet, so this refusal can still
    // be reached. What it may not do is state something false about the router:
    // the operator has assigned that LAN to a zone, and a message telling them
    // to go and do it sends them looking for a fault they do not have.
    const findings: ModuleCheckFinding[] = []
    zoneFindings(await probeOf(deviceNamedLan), { lan: 'lan', wans: ['wan'] }, findings)

    const text = labels(findings)
    expect(text).toContain('LAN "lan" is not assigned to a firewall zone')
    expect(text).toContain('lists lan under "list network"')
    expect(text).toContain('"list device"')
  })
})

// ------------------------------ a dhcp section that names its network by name

describe('a `config dhcp` section that names its network by being called after it', () => {
  /**
   * The router the pool-identity guard was written for: a second LAN the
   * carrier scooped into the WAN pool because it runs proto static on a device
   * the carrier names. /etc/config/dhcp hands out addresses on it, which an
   * uplink does not - but the section says so by being called `iot` rather than
   * by carrying `option interface`, which is how a hand-written one usually
   * does. Read strictly, that section contributed nothing, the guard could not
   * fire, and clients bound by this instance would have left through one of the
   * router's own LANs while the page called them bound.
   */
  const swallowedLan: Dump = {
    ifaces: [
      iface('lan', 'static', 'br-lan', '192.168.1.1'),
      iface('iot', 'static', 'eth2.20', '192.168.3.1')
    ],
    dhcp: [
      ...DNSMASQ,
      ...servesDhcp('lan'),
      'dhcp.iot=dhcp',
      "dhcp.iot.start='100'",
      "dhcp.iot.limit='150'"
    ],
    network: [...lanSection('lan', '192.168.1.1'), ...lanSection('iot', '192.168.3.1')],
    firewall: [...zone(0, 'lan', ['lan']), ...zone(1, 'iot', ['iot'])]
  }

  async function checkInstance(dump: Dump): Promise<ModuleCheckReport> {
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: {
        version: 1,
        nextSeq: 2,
        batches: [],
        instances: [],
        extraTables: [],
        stickyMap: [],
        events: [],
        moduleEvents: [],
        jobs: []
      }
    })
    harness.exec.mockImplementation(async (command: string, options?: ModuleExecOptions) => {
      const stdin = options?.stdin ?? ''
      if (command === 'sh -s' && stdin.includes("echo '===DHCP==='")) return ok(answer(dump, stdin))
      return ok()
    })
    const rules = { ...DEFAULT_RULES }
    const engine = new BindingEngine(harness.ctx, new HostStore(harness.ctx, () => rules), {
      rules: () => rules
    })
    await engine.onSample(model(dump))
    const report = await engine.check({ name: 'New instance', lan: 'lan', carrier: 'eth2' })
    engine.dispose()
    return report
  }

  it('refuses the pool that has swallowed it', async () => {
    const report = await checkInstance(swallowedLan)

    expect(report.ok).toBe(false)
    expect(labels(report.findings)).toContain(
      'WAN "iot" is a LAN: the router hands out DHCP addresses on it'
    )
  })

  it('still reads a section that switches itself off as switched off', async () => {
    // The half that keeps the fallback safe on a stock router: falling back to
    // the section name must not turn `config dhcp 'wan'`, which exists solely
    // to carry `option ignore`, into a statement that the WAN is a LAN.
    const stockish: Dump = {
      ...swallowedLan,
      dhcp: [
        ...DNSMASQ,
        ...servesDhcp('lan'),
        'dhcp.iot=dhcp',
        "dhcp.iot.ignore='1'"
      ]
    }
    const report = await checkInstance(stockish)

    expect(labels(report.findings)).not.toContain(
      'WAN "iot" is a LAN: the router hands out DHCP addresses on it'
    )
  })
})
