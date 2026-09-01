import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { DirectEngine } from '../../openwrt/main/direct'
import { HostStore } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * One report, read the way an operator reads it: from the top, once.
 *
 * A binding named by MAC whose device holds no DHCP lease used to be answered
 * with two sentences that cannot both be true. Near the top: "The binding is
 * created either way and its rule appears the moment the device takes a lease."
 * Fifty lines below, on any router with more than one LAN candidate: "The
 * device has to be seen on the network once before it can be bound", at level
 * error, with Create it still locked. The promise was the sentence read first.
 *
 * The promise was never wrong about every router - on a box with exactly one
 * candidate LAN `chooseLan` really does place an unresolved target, which is
 * why this is a warning at all and not a refusal. It was wrong about the router
 * it was said on, because it was said before anything had counted the
 * candidates. So the assertions below are all about one report at a time: which
 * sentence it carries, whether it also refuses, and - since the contradiction
 * was an ordering fault as much as a wording one - in what order the two
 * appear.
 *
 * The candidate count is `chooseLan`'s own: stated LANs plus the ones the
 * classifier leaves `unclear`, with the WAN being bound out of excluded. An
 * `unclear` interface is a candidate, so a router with one LAN and one
 * interface nothing settles behaves exactly like a router with two LANs, and
 * the last describe block here is that router.
 */

const T0 = 1_700_000_000_000

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

/** The MAC no lease file holds, which is the whole subject of this file. */
const ABSENT_MAC = 'a4:b1:c2:00:11:22'

// -------------------------------------------------------------- the layouts

/**
 * One router: what netifd reports, and what `uci show` says about it. Written
 * out in the same vocabulary tests/unit/openwrt-direct-layouts.test.ts uses, so
 * a router that has a verdict over there can be dropped in here and asked what
 * it says to a MAC that is not on the network.
 */
interface Layout {
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

/** The dnsmasq section a LAN carries: it names the network and serves on it. */
const serves = (name: string): string[] => [
  `dhcp.${name}=dhcp`,
  `dhcp.${name}.interface='${name}'`,
  `dhcp.${name}.limit='150'`
]

/** Stock OpenWrt's stub for the uplink, which exists only to switch itself off. */
const ignores = (name: string): string[] => [
  `dhcp.${name}=dhcp`,
  `dhcp.${name}.interface='${name}'`,
  `dhcp.${name}.ignore='1'`
]

const zone = (index: number, name: string, networks: string[], masq = false): string[] => [
  `firewall.@zone[${index}]=zone`,
  `firewall.@zone[${index}].name='${name}'`,
  ...networks.map((network) => `firewall.@zone[${index}].network='${network}'`),
  ...(masq ? [`firewall.@zone[${index}].masq='1'`] : [])
]

const lanSection = (name: string): string[] => [
  `network.${name}=interface`,
  `network.${name}.ip6assign='60'`
]

const wanSection = (name: string): string[] => [
  `network.${name}=interface`,
  `network.${name}.ip4table='42'`
]

const uplink = (): IfaceState =>
  iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })

/** A plain single-LAN box: one candidate, so an unresolved MAC can be placed. */
const oneLan: Layout = {
  ifaces: [iface('lan', 'static', 'br-lan', '192.168.1.1'), uplink()],
  dhcp: [...serves('lan'), ...ignores('wan')],
  network: [...lanSection('lan'), ...wanSection('wan')],
  firewall: [...zone(0, 'lan', ['lan']), ...zone(1, 'wan', ['wan'], true)]
}

/** A guest network beside the ordinary one, which is all it takes to be two. */
const twoLans: Layout = {
  ifaces: [
    iface('lan', 'static', 'br-lan', '192.168.1.1'),
    iface('guest', 'static', 'br-guest', '192.168.3.1'),
    uplink()
  ],
  dhcp: [...serves('lan'), ...serves('guest'), ...ignores('wan')],
  network: [...lanSection('lan'), ...lanSection('guest'), ...wanSection('wan')],
  firewall: [
    ...zone(0, 'lan', ['lan']),
    ...zone(1, 'guest', ['guest']),
    ...zone(2, 'wan', ['wan'], true)
  ]
}

/**
 * One stated LAN and one interface the configuration says nothing about: a
 * static, privately addressed section with no dnsmasq entry, no firewall zone,
 * no delegated prefix and no gateway. Nothing weighs either way, so the
 * classifier returns `unclear` - and `chooseLan` counts it, because an
 * interface nobody has placed is still an interface a forwarding could be
 * written from.
 */
const oneLanAndAnUnclearOne: Layout = {
  ifaces: [
    iface('lan', 'static', 'br-lan', '192.168.1.1'),
    iface('spare', 'static', 'eth0.9', '192.168.9.1'),
    uplink()
  ],
  dhcp: [...serves('lan'), ...ignores('wan')],
  network: [...lanSection('lan'), 'network.spare=interface', ...wanSection('wan')],
  firewall: [...zone(0, 'lan', ['lan']), ...zone(1, 'wan', ['wan'], true)]
}

/** The uplink and nothing else: no candidate at all, and no promise to make. */
const noLanAtAll: Layout = {
  ifaces: [uplink()],
  dhcp: [...ignores('wan')],
  network: [...wanSection('wan')],
  firewall: [...zone(0, 'wan', ['wan'], true)]
}

// ------------------------------------------------------------ the check gate

const CREATE = {
  name: 'Printer',
  targetKind: 'mac',
  address: ABSENT_MAC,
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

/** No leases at all, which is what makes every MAC below an unresolved one. */
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

interface Report {
  ok: boolean
  /** Every finding in the order the page renders them, label and detail joined. */
  lines: string[]
  /** The same report as one string, for the sentences that must not be in it. */
  text: string
}

/** Where a sentence appears in the report, or -1 - the report is read in order. */
function lineWith(report: Report, needle: string): number {
  return report.lines.findIndex((line) => line.includes(needle))
}

async function check(layout: Layout, values: Partial<typeof CREATE> = {}): Promise<Report> {
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
    if (stdin.includes("echo '===DHCP==='")) return ok(probeText(layout))
    if (stdin.includes('bm_wanbind')) return ok('===DONE===')
    return ok()
  })
  const rules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  const engine = new DirectEngine({
    ctx: harness.ctx,
    store,
    rules: () => rules,
    latestModel: () => model(layout)
  })
  const result = await engine.check({ ...CREATE, ...values })
  const lines = result.findings.map(
    (finding) => `${finding.label}\n${finding.detail ?? ''}`
  )
  return { ok: result.ok, lines, text: lines.join('\n') }
}

const REASSURANCE = 'The binding is created either way'
const REFUSAL = 'The device has to be seen on the network once before it can be bound'
const NO_LEASE = `${ABSENT_MAC} has no current DHCP lease`

// ------------------------------------------------------- one candidate LAN

describe('a MAC with no lease on a router with exactly one candidate LAN', () => {
  it('keeps the reassurance, because on this router it is true', async () => {
    const report = await check(oneLan)

    expect(report.text).toContain(NO_LEASE)
    expect(report.text).toContain(
      'The device is not on the network right now. The binding is created either way and its rule appears the moment the device takes a lease.'
    )
  })

  it('passes the gate, so Create it unlocks and the promise is kept', async () => {
    const report = await check(oneLan)

    expect(report.ok).toBe(true)
    expect(report.text).not.toContain(REFUSAL)
    // And it says which LAN it settled on, which is the reason it may promise
    // anything at all: there was only ever one interface to choose.
    expect(report.text).toContain('The binding will be installed on LAN lan (192.168.1.0/24)')
  })
})

// ------------------------------------------------------ two candidate LANs

describe('a MAC with no lease on a router with two LANs', () => {
  it('refuses, and says nothing anywhere about the binding being created', async () => {
    const report = await check(twoLans)

    expect(report.ok).toBe(false)
    expect(report.text).toContain(REFUSAL)
    expect(report.text).not.toContain(REASSURANCE)
  })

  it('says instead that there is more than one interface and nothing to choose', async () => {
    const report = await check(twoLans)

    expect(report.text).toContain(NO_LEASE)
    expect(report.text).toContain(
      'The device is not on the network right now, and this router has more than one interface a binding could be installed on, so there is nothing to say which one it belongs to. Connect the device once, then check again.'
    )
  })

  it('puts the refusal above the warning, since the report is read downwards', async () => {
    // The fault this file is about was an ordering one as much as a wording
    // one: the promise arrived first and the refusal that undid it arrived a
    // screen later. A qualified sentence under the refusal reads as one answer.
    const report = await check(twoLans)

    const refusal = lineWith(report, REFUSAL)
    const warning = lineWith(report, NO_LEASE)
    expect(refusal).toBeGreaterThanOrEqual(0)
    expect(warning).toBeGreaterThan(refusal)
  })

  it('names the candidate LANs in the refusal, so the count can be checked', async () => {
    const report = await check(twoLans)

    expect(report.text).toContain('lan 192.168.1.0/24')
    expect(report.text).toContain('guest 192.168.3.0/24')
  })
})

// --------------------------------------- one LAN and one the router leaves open

describe('a MAC with no lease where the second candidate is only unclear', () => {
  it('behaves as the two-LAN router does, because that is what chooseLan counts', async () => {
    const report = await check(oneLanAndAnUnclearOne)

    expect(report.ok).toBe(false)
    expect(report.text).toContain(REFUSAL)
    expect(report.text).not.toContain(REASSURANCE)
    expect(report.text).toContain(
      'this router has more than one interface a binding could be installed on'
    )
  })

  it('counts the unsettled interface out loud, listing it beside the stated LAN', async () => {
    // If `spare` had been read as an uplink there would be one candidate, the
    // reassurance would be correct, and this whole describe block would be
    // asserting the wrong router. The subnet list is what proves it was not.
    const report = await check(oneLanAndAnUnclearOne)

    expect(report.text).toContain('lan 192.168.1.0/24')
    expect(report.text).toContain('spare 192.168.9.0/24')
  })

  it('still puts the refusal first', async () => {
    const report = await check(oneLanAndAnUnclearOne)

    expect(lineWith(report, NO_LEASE)).toBeGreaterThan(lineWith(report, REFUSAL))
  })
})

// ------------------------------------------------------------ no candidate

describe('a MAC with no lease on a router with no LAN interface at all', () => {
  it('promises nothing, and points at the refusal that is actually in the way', async () => {
    // Zero candidates is not "more than one", and saying so would be the same
    // fault in the other direction - a sentence about a router nobody has.
    const report = await check(noLanAtAll)

    expect(report.ok).toBe(false)
    expect(report.text).toContain('This router has no LAN interface with an IPv4 subnet')
    expect(report.text).toContain(NO_LEASE)
    expect(report.text).toContain(
      'though on this router that is not what stops the binding, since there is no LAN interface for it to be installed on at all'
    )
    expect(report.text).not.toContain(REASSURANCE)
    expect(report.text).not.toContain('more than one interface')
  })
})

// ------------------------------------------- the MAC that does hold a lease

describe('a MAC the lease file still holds', () => {
  it('says none of this, on the router that would otherwise refuse', async () => {
    // The warning is about an absent device, not about MAC targets, and a
    // resolved one is placed by its address like any typed IPv4.
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
      if (stdin.includes("echo '===DHCP==='")) return ok(probeText(twoLans))
      if (stdin.includes('bm_wanbind')) return ok('===DONE===')
      return ok()
    })
    const rules = { ...DEFAULT_RULES }
    const store = new HostStore(harness.ctx, () => rules)
    const sample: RouterModel = {
      ...model(twoLans),
      leases: [{ mac: ABSENT_MAC, ip: '192.168.3.50', host: 'printer', expires: T0 + 3_600_000 }]
    }
    const engine = new DirectEngine({
      ctx: harness.ctx,
      store,
      rules: () => rules,
      latestModel: () => sample
    })
    const result = await engine.check({ ...CREATE })
    const text = result.findings
      .map((finding) => `${finding.label}\n${finding.detail ?? ''}`)
      .join('\n')

    expect(result.ok).toBe(true)
    expect(text).not.toContain(NO_LEASE)
    expect(text).not.toContain(REFUSAL)
    expect(text).toContain('192.168.3.50 is on LAN guest (192.168.3.0/24)')
  })
})
