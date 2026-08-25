import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * An instance owns exactly two interfaces, and it owns them alone.
 *
 * Binding steers a client by source address only, so two instances that can see
 * the same addresses cannot be told apart: the second one's rules match the
 * first one's clients and hand them to WANs their own instance knows nothing
 * about. That makes overlapping LANs as fatal as a shared interface, and the
 * subnets are what decide it - not the interface names, which two different
 * bridges on one address range would happily disagree about.
 *
 * The exclusivity is checked in three places, because the check and the job are
 * minutes apart and another surface can create an instance in between.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const iface = (name: string, device: string, over: Partial<IfaceState> = {}): IfaceState => ({
  name,
  proto: 'static',
  device,
  l3Device: device,
  up: true,
  pending: false,
  autostart: true,
  uptimeSec: 4_000,
  ...over
})

/**
 * Three LANs and three uplinks. `office` is the interesting one: a different
 * bridge, a different name, and a /25 sitting inside `lan`'s /24.
 */
const SAMPLE: RouterModel = {
  t: 1_700_000_000_000,
  sys: { uptimeSec: 4_000, load1: 0, memTotal: 512_000, memFree: 200_000 },
  ifaces: [
    iface('lan', 'br-lan', { ipv4: { addr: '192.168.1.1', mask: 24 } }),
    iface('guest', 'br-guest', { ipv4: { addr: '192.168.9.1', mask: 24 } }),
    iface('office', 'br-office', { ipv4: { addr: '192.168.1.129', mask: 25 } }),
    iface('wan835', 'eth1.835', { proto: 'dhcp', ipv4: { addr: '198.51.100.5', mask: 24 } }),
    iface('wan836', 'eth1.836', { proto: 'dhcp', ipv4: { addr: '198.51.100.6', mask: 24 } }),
    iface('wan2', 'eth2', { proto: 'dhcp', ipv4: { addr: '198.51.100.7', mask: 24 } })
  ],
  poolDev: { count: 0, rx: 0, tx: 0 },
  leases: [],
  rules: [],
  rates: { 'br-lan.10': { rx: 0, tx: 0 } }
}

const held = (name: string, lan: string, carrier: string, slot: number): unknown => ({
  id: `bind_${slot}`,
  name,
  lan,
  carrier,
  running: true,
  sticky: true,
  remap: true,
  createdAt: 1,
  slot
})

async function checkWith(
  instances: unknown[],
  values: Record<string, unknown>
): Promise<ModuleCheckReport> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 1,
      nextSeq: 1,
      batches: [],
      instances,
      extraTables: [],
      stickyMap: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
  const binding = new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES })
  await binding.onSample(SAMPLE)
  const report = await binding.check(values)
  binding.dispose()
  return report
}

const text = (report: ModuleCheckReport): string =>
  report.findings.map((finding) => `${finding.label} ${finding.detail ?? ''}`).join('\n')

const OWNED = 'An interface is already owned by another binding instance'

describe('two binding instances cannot claim the same interface', () => {
  it('refuses a second instance on a LAN that is already spoken for, and names the holder', async () => {
    const report = await checkWith([held('ISP A', 'lan', 'eth1.835', 0)], {
      name: 'ISP B',
      lan: 'lan',
      carrier: 'eth2'
    })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain(OWNED)
    // The holder, so the user is not left to work out which of their instances
    // is in the way.
    expect(text(report)).toContain('ISP A: lan + eth1.835')
  })

  it('refuses a carrier that is a VLAN on another instance LAN bridge', async () => {
    // `br-lan.10` is a tagged uplink an ISP might genuinely hand over, and it
    // rides the same wire as the LAN that instance is serving. Nothing about
    // the two names says so; `carrierScopesOverlap` on the LAN device does.
    const report = await checkWith([held('ISP A', 'lan', 'eth1.835', 0)], {
      name: 'ISP B',
      lan: 'guest',
      carrier: 'br-lan.10'
    })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain(OWNED)
  })

  it('refuses a carrier that is a VLAN on the instance own LAN bridge', async () => {
    // No other instance involved at all: the pool would be carried on the wire
    // it is meant to serve, so every client would be steered onto its own LAN.
    const report = await checkWith([], { name: 'X', lan: 'lan', carrier: 'br-lan.10' })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('The LAN physical device and WAN carrier overlap')
    expect(text(report)).toContain('br-lan')
  })

  it('refuses one interface used as both ends', async () => {
    const report = await checkWith([], { name: 'X', lan: 'lan', carrier: 'lan' })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('The LAN logical interface and WAN carrier must be different')
  })

  it('refuses a name another instance already carries', async () => {
    // The name reaches job labels, event rows and the app log, and it is how
    // every refusal on this page identifies the instance in the way.
    const report = await checkWith([held('ISP A', 'guest', 'eth1.835', 0)], {
      name: 'isp a',
      lan: 'lan',
      carrier: 'eth2'
    })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('An instance named "isp a" already exists')
  })

  it('lets two instances that share nothing exist side by side', async () => {
    // The positive control. Without it every assertion above would pass on a
    // check that refuses everything.
    const report = await checkWith([held('ISP A', 'lan', 'eth1.835', 0)], {
      name: 'ISP B',
      lan: 'guest',
      carrier: 'eth2'
    })

    expect(text(report)).toContain('Exactly two exclusive interfaces: guest + eth2')
    expect(text(report)).not.toContain(OWNED)
    expect(text(report)).not.toContain('The LAN physical device and WAN carrier overlap')
  })
})

describe('two binding instances cannot serve overlapping LAN subnets', () => {
  it('refuses a LAN whose subnet sits inside one another instance already has', async () => {
    // Two different bridges, two different interface names, one address range.
    // Every rule this module writes is "from <source> lookup <table>", so the
    // second instance's rules would match the first instance's clients and send
    // them out WANs the first one is not managing.
    const report = await checkWith([held('ISP A', 'lan', 'eth1.835', 0)], {
      name: 'ISP B',
      lan: 'office',
      carrier: 'eth2'
    })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('192.168.1.128/25 overlaps 192.168.1.0/24 used by "ISP A"')
    expect(text(report)).toContain('cannot distinguish clients in overlapping LAN subnets')
  })

  it('says nothing about subnets that merely sit next to each other', async () => {
    const report = await checkWith([held('ISP A', 'lan', 'eth1.835', 0)], {
      name: 'ISP B',
      lan: 'guest',
      carrier: 'eth2'
    })

    expect(text(report)).toContain('LAN guest is scoped to 192.168.9.0/24')
    expect(text(report)).not.toContain('overlaps')
  })
})

// ---------------------------------------------------- the same rules at apply

const PREPARATION_PROBE = [
  '===DHCP===',
  'dhcp.@dnsmasq[0]=dnsmasq',
  "dhcp.@dnsmasq[0].dhcpleasemax='150'",
  'dhcp.lan=dhcp',
  "dhcp.lan.interface='lan'",
  "dhcp.lan.limit='150'",
  'dhcp.office=dhcp',
  "dhcp.office.interface='office'",
  "dhcp.office.limit='100'",
  '===NETWORK===',
  'network.lan=interface',
  "network.lan.device='br-lan'",
  'network.office=interface',
  "network.office.device='br-office'",
  'network.wan2=interface',
  "network.wan2.device='eth2'",
  "network.wan2.ip4table='202'",
  '===FIREWALL===',
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan'",
  "firewall.@zone[0].network='guest'",
  "firewall.@zone[0].network='office'",
  'firewall.@zone[1]=zone',
  "firewall.@zone[1].name='wan'",
  "firewall.@zone[1].network='wan2'",
  "firewall.@zone[1].masq='1'",
  '===SYSCTL===',
  'net.netfilter.nf_conntrack_max=65536'
].join('\n')

function preparedEngine(): { engine: BindingEngine; store: HostStore } {
  const harness = moduleHarness('openwrt', () => ok())
  harness.exec.mockImplementation(async (command, options) => {
    const stdin = options?.stdin ?? ''
    if (command === 'sh -s' && stdin.includes("echo '===DHCP==='")) return ok(PREPARATION_PROBE)
    return ok()
  })
  const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
  return { engine: new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES }), store }
}

describe('an instance claimed between the check and the job', () => {
  it('is refused at apply, not overwritten', async () => {
    // Ten minutes can pass between a check and Save, and every connected
    // surface shares one set of records. The check that approved this form
    // cannot speak for the router any more.
    const { engine, store } = preparedEngine()
    await engine.onSample(SAMPLE)
    const values = { name: 'ISP B', lan: 'lan', carrier: 'eth2' }
    const report = await engine.check(values)
    expect(report.ok).toBe(true)
    if (!report.ok) return

    store.update((data) => {
      data.instances.push(held('ISP A', 'lan', 'eth1.835', 0) as never)
    })

    const applied = await engine.apply({ token: report.token, values })
    expect(applied).toMatchObject({
      ok: false,
      error: expect.stringContaining('now owned by another instance')
    })
    // And the instance that was refused left no record behind.
    expect(store.read().instances.map((entry) => entry.name)).toEqual(['ISP A'])
  })

  it('refuses an overlapping LAN subnet at apply as well', async () => {
    const { engine, store } = preparedEngine()
    await engine.onSample(SAMPLE)
    const values = { name: 'ISP B', lan: 'office', carrier: 'eth2' }
    const report = await engine.check(values)
    expect(report.ok).toBe(true)
    if (!report.ok) return

    // A different interface, so the interface guard above says nothing; only
    // the subnets do.
    store.update((data) => {
      data.instances.push(held('ISP A', 'lan', 'eth1.835', 0) as never)
    })

    expect(await engine.apply({ token: report.token, values })).toMatchObject({
      ok: false,
      error: expect.stringContaining('overlaps another binding instance')
    })
  })
})
