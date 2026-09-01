import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { DirectEngine, routerLayout } from '../../openwrt/main/direct'
import { preparationProbe } from '../../openwrt/main/binding'
import { HostStore } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * The router the bug was reported on, written down exactly as it answered.
 *
 * Everything below was read off a real OpenWrt 25.12.5 box over SSH, not
 * imagined: the interface names, the addresses, the zones, the dnsmasq sections
 * and the default route are the lines that machine actually printed. The
 * operator typed the address of a device on their own wired LAN into Binding
 * 1-1 and was told `12.10.10.10 is on LAN_WIRED, which this router uses as an
 * uplink rather than as a LAN`.
 *
 * Three separate design faults had to line up to produce that sentence, and all
 * three were mine:
 *
 * 1. **`option gateway` was weighted as heavily as anything here.** `LAN_WIRED`
 *    carries one, because there is another box on that LAN. Any interface may;
 *    it is not a statement about which side of the router an interface is on.
 * 2. **A "routable" address counted as uplink evidence.** This site runs its
 *    LANs on 12.10.x, which is public space. Plenty of networks do - squatted
 *    ranges, real allocations, CGNAT - and a LAN holding one is still a LAN.
 * 3. **Nothing asked the kernel.** An uplink is the interface the default route
 *    leaves by. That is not an inference, and the router will say it outright,
 *    and this module was guessing at it from the shape of /etc/config instead.
 *
 * So this file is not really about `LAN_WIRED`. It is the regression net for the
 * rule that replaced all three: serving DHCP settles a LAN, carrying the default
 * route settles an uplink, and everything else is a tie-breaker that may not
 * overturn either.
 */

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

/** Verbatim, minus the pooled PPPoE sections that are not part of the question. */
const PROBE = [
  '===DHCP===',
  'dhcp.lan=dhcp',
  "dhcp.lan.interface='lan'",
  "dhcp.lan.limit='200'",
  'dhcp.LAN_WIRED=dhcp',
  "dhcp.LAN_WIRED.interface='LAN_WIRED'",
  "dhcp.LAN_WIRED.limit='250'",
  '===NETWORK===',
  'network.lan=interface',
  "network.lan.ip6assign='60'",
  'network.WAN0=interface',
  'network.WAN1=interface',
  'network.WAN2=interface',
  'network.WAN3=interface',
  'network.LAN_WIRED=interface',
  // The line that used to decide it. There is a second router on this LAN.
  "network.LAN_WIRED.gateway='168.192.1.1'",
  '===FIREWALL===',
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan' 'LAN_WIRED'",
  'firewall.@zone[1]=zone',
  "firewall.@zone[1].name='wan'",
  "firewall.@zone[1].masq='1'",
  "firewall.@zone[1].network='WAN1' 'WAN0' 'WAN2' 'WAN3'",
  '===DEFAULTROUTE===',
  'default via 192.168.1.1 dev eth2 proto static src 192.168.1.100 ',
  '===SYSCTL===',
  'net.netfilter.nf_conntrack_max=262144'
].join('\n')

const iface = (name: string, proto: string, device: string, addr?: string): IfaceState => ({
  name,
  proto,
  device,
  l3Device: device,
  up: true,
  pending: false,
  autostart: true,
  uptimeSec: 4_000,
  ...(addr ? { ipv4: { addr, mask: 24 } } : {})
})

const MODEL: RouterModel = {
  t: 1_700_000_000_000,
  sys: { uptimeSec: 4_000, load1: 0, memTotal: 512_000, memFree: 200_000 },
  ifaces: [
    iface('lan', 'static', 'eth1', '12.10.1.1'),
    iface('LAN_WIRED', 'static', 'eth0', '12.10.10.1'),
    iface('WAN0', 'dhcp', 'eth2', '192.168.1.100'),
    iface('WAN1', 'dhcp', 'eth3', '168.192.1.101'),
    iface('WAN2', 'dhcp', 'eth4'),
    iface('WAN3', 'dhcp', 'eth5')
  ],
  poolDev: { count: 0, rx: 0, tx: 0 },
  leases: [],
  rules: [],
  rates: {}
}

function engine(): DirectEngine {
  const harness = moduleHarness('openwrt', () => ok())
  harness.exec.mockImplementation(async (_command, options) => {
    const stdin = options?.stdin ?? ''
    if (stdin.includes("echo '===DHCP==='")) return ok(PROBE)
    return ok()
  })
  const rules = { ...DEFAULT_RULES }
  return new DirectEngine({
    ctx: harness.ctx,
    store: new HostStore(harness.ctx, () => rules),
    rules: () => rules,
    latestModel: () => MODEL
  })
}

async function probe() {
  const harness = moduleHarness('openwrt', () => ok())
  harness.exec.mockImplementation(async () => ok(PROBE))
  return preparationProbe({
    ctx: harness.ctx,
    options: { rules: () => ({ execTimeoutSec: 20 }) }
  } as never)
}

async function check(address: string, wan = 'WAN0'): Promise<{ ok: boolean; text: string }> {
  const report = await engine().check({
    name: 'Till',
    targetKind: 'ip',
    address,
    wan,
    whenDown: 'hold'
  })
  return {
    ok: report.ok,
    text: report.findings.map((f) => `${f.label}\n${f.detail ?? ''}`).join('\n')
  }
}

describe('the router the bug was reported on', () => {
  it('binds a device on LAN_WIRED, which is what it was refusing', async () => {
    const report = await check('12.10.10.10')

    expect(report.text).not.toContain('which this router uses as an uplink')
    expect(report.text).toContain('12.10.10.10 is on LAN LAN_WIRED')
    expect(report.ok).toBe(true)
  })

  it('does not let a gateway on a LAN outvote the leases it hands out', async () => {
    // The precise inversion that produced the report: one `option gateway` on
    // an interface with 250 DHCP addresses configured on it. Asserted on the
    // verdict rather than on a refusal, because there is no refusal any more -
    // which is the point, and is why the evidence has to be read from the one
    // place that still carries it.
    const layout = routerLayout(MODEL, await probe())
    const wired = layout.byName.get('LAN_WIRED')

    expect(wired?.role).toBe('lan')
    expect(wired?.lanEvidence).toContain('/etc/config/dhcp has it handing out DHCP leases')
    // The gateway is still read and still reported - it is a real line in the
    // file - it simply cannot decide the question on its own any more.
    expect(wired?.uplinkEvidence).toContain('/etc/config/network gives it a default gateway')
  })

  it('reads the uplink off the kernel rather than guessing at it', async () => {
    const layout = routerLayout(MODEL, await probe())

    expect(layout.byName.get('WAN0')?.role).toBe('uplink')
    expect(layout.byName.get('WAN0')?.uplinkEvidence).toContain(
      "the router's default route leaves by it"
    )
  })

  it('still binds on the other LAN, which never had a gateway', async () => {
    expect((await check('12.10.1.50')).ok).toBe(true)
  })

  it('treats public address space on a LAN as the LAN it is', async () => {
    // 12.10.10.0/24 is not private space. The site uses it anyway, which is
    // ordinary, and every address on it is still behind this router.
    const report = await check('12.10.10.77')

    expect(report.text).not.toContain('the public internet routes to')
    expect(report.ok).toBe(true)
  })

  it('refuses a WAN port that is one of the LANs, in both directions', async () => {
    const report = await check('12.10.10.10', 'LAN_WIRED')

    expect(report.ok).toBe(false)
    expect(report.text).toContain('LAN_WIRED is a LAN on this router, not a WAN port')
  })
})
