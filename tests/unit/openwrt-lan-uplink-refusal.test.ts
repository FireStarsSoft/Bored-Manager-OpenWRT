import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecOptions, ModuleExecResult } from '@shared/modules'
import {
  BindingEngine,
  preparationProbe,
  type ExecDeps,
  type RouterPreparationProbe
} from '../../openwrt/main/binding'
import { DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { routerLayout } from '../../openwrt/main/direct'
import { HostStore } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * The other half of the interface decision, on Create an instance.
 *
 * "DHCP LAN interface" used to be filtered with `iface.name !== 'wan'`, which
 * is the device-name guess the rest of this work removed: a second ISP on a
 * section called `wan2` is an uplink, and a LAN on a section called `wan` is
 * not. Taking the filter out was right, and for a while nothing stood in its
 * place - so an uplink running the static protocol under any other name was
 * offered as one of the router's own networks and accepted. Nothing downstream
 * catches it: the pool-identity check only warns when /etc/config/dhcp serves
 * the interface, which an uplink does not, and the zone reader hands back the
 * uplink's own zone for the forwardings to be written from. The instance then
 * lays its fail-closed catch-all over the WAN's own subnet and starts handing
 * WANs to whatever it can see upstream of this router.
 *
 * So the guess is replaced by the reading, and the sentence is the mirror of
 * the one the sibling gate says about a WAN port that reads as a LAN. What is
 * asserted below is both directions of that: the pick is refused, blocking,
 * naming the evidence, when the router's configuration places the interface
 * outside - and it is not refused at all when the configuration does not settle
 * it, because a refusal there is the confident sentence about an unread router
 * that this whole classifier exists to end.
 *
 * Every router here is written down as `uci show` prints it and then filtered
 * by the grep the preparation script really ships, lifted off the script that
 * was sent. A line the router would never have sent must not decide a verdict
 * in a test.
 */

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

// --------------------------------------------------------------- the router

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
  over: { mask?: number; table?: number } = {}
): IfaceState {
  return {
    name,
    proto,
    device,
    l3Device: device,
    up: true,
    pending: false,
    autostart: true,
    // Above `wanWarnUptimeSec`, so an uplink here is available rather than
    // warning about how recently it came up.
    uptimeSec: 3_000,
    ipv4: { addr, mask: over.mask ?? 24 },
    ...(over.table ? { ip4Table: over.table } : {})
  }
}

const DNSMASQ = ['dhcp.@dnsmasq[0]=dnsmasq', "dhcp.@dnsmasq[0].dhcpleasemax='1000'"]

const servesDhcp = (name: string): string[] => [
  `dhcp.${name}=dhcp`,
  `dhcp.${name}.interface='${name}'`,
  `dhcp.${name}.start='100'`,
  `dhcp.${name}.limit='150'`
]

/** The stock `config dhcp 'wan'`, which exists only to switch itself off. */
const ignoresDhcp = (name: string): string[] => [
  `dhcp.${name}=dhcp`,
  `dhcp.${name}.interface='${name}'`,
  `dhcp.${name}.ignore='1'`
]

const zone = (
  index: number,
  name: string,
  networks: readonly string[],
  masq = false
): string[] => [
  `firewall.@zone[${index}]=zone`,
  `firewall.@zone[${index}].name='${name}'`,
  ...networks.map((network) => `firewall.@zone[${index}].network='${network}'`),
  `firewall.@zone[${index}].input='ACCEPT'`,
  ...(masq ? [`firewall.@zone[${index}].masq='1'`] : [])
]

/**
 * A router with two ways out and one network of its own.
 *
 * `wan` dials nothing and takes a lease, which settles it on its own. `wan2` is
 * the second ISP the old filter would have offered as a LAN: it runs proto
 * static exactly as a LAN does, and what places it outside is what the router
 * states about it - a next hop, a public address and a zone that NATs. `spare`
 * is a transit port somebody has addressed and nothing else: no dnsmasq
 * section, no zone, no gateway, a private address. The router says nothing
 * about which side of itself it is on, and neither may this module.
 */
const twoUplinks: Dump = {
  ifaces: [
    iface('lan', 'static', 'br-lan', '192.168.1.1'),
    iface('wan', 'dhcp', 'eth1', '203.0.113.20', { table: 10_001 }),
    iface('wan2', 'static', 'eth2', '198.51.100.9', { mask: 30, table: 10_002 }),
    iface('spare', 'static', 'eth3', '10.9.0.1')
  ],
  dhcp: [...DNSMASQ, ...servesDhcp('lan'), ...ignoresDhcp('wan')],
  network: [
    'network.lan=interface',
    "network.lan.device='br-lan'",
    "network.lan.proto='static'",
    "network.lan.ip6assign='60'",
    'network.wan=interface',
    "network.wan.device='eth1'",
    "network.wan.proto='dhcp'",
    "network.wan.ip4table='10001'",
    'network.wan2=interface',
    "network.wan2.device='eth2'",
    "network.wan2.proto='static'",
    "network.wan2.ipaddr='198.51.100.9'",
    "network.wan2.netmask='255.255.255.252'",
    "network.wan2.gateway='198.51.100.10'",
    "network.wan2.ip4table='10002'",
    'network.spare=interface',
    "network.spare.device='eth3'",
    "network.spare.proto='static'",
    "network.spare.ipaddr='10.9.0.1'"
  ],
  firewall: [
    ...zone(0, 'lan', ['lan']),
    ...zone(1, 'wan', ['wan', 'wan2'], true)
  ]
}

// ------------------------------------------------------- the shipped filter

/**
 * The `grep -E` one section of the preparation script really runs, pulled off
 * the script `preparationProbe` sent rather than copied.
 *
 * A POSIX ERE and a JavaScript RegExp mean the same thing by everything these
 * patterns use, so running one here is running the router's own filter. It
 * matters most for `option gateway`: that line is the only thing separating
 * `wan2` from a LAN, and a filter that stopped keeping it would leave this
 * router `unclear` and the create wide open again.
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

const isProbe = (stdin: string): boolean => stdin.includes("echo '===DHCP==='")

/** The verdict the classifier reaches, so each case states its own premise. */
async function verdict(dump: Dump, name: string) {
  const harness = moduleHarness('openwrt', () => ok())
  harness.exec.mockImplementation(async (_command: string, options?: ModuleExecOptions) =>
    ok(answer(dump, options?.stdin ?? ''))
  )
  const deps: ExecDeps = {
    ctx: harness.ctx,
    disposed: false,
    options: { rules: () => DEFAULT_RULES }
  }
  const probe: RouterPreparationProbe = await preparationProbe(deps)
  return routerLayout(model(dump), probe).byName.get(name)
}

/** One trip through the create gate, on the router above. */
async function checkOn(
  dump: Dump,
  values: Record<string, unknown>
): Promise<ModuleCheckReport> {
  const harness = moduleHarness('openwrt', () => ok())
  harness.exec.mockImplementation(async (command: string, options?: ModuleExecOptions) => {
    const stdin = options?.stdin ?? ''
    if (command === 'sh -s' && isProbe(stdin)) return ok(answer(dump, stdin))
    return ok()
  })
  const rules: OwrtRules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  const engine = new BindingEngine(harness.ctx, store, { rules: () => rules })
  await engine.onSample(model(dump))
  const report = await engine.check({ name: 'New instance', ...values })
  engine.dispose()
  return report
}

const text = (report: ModuleCheckReport): string =>
  report.findings.map((finding) => `${finding.label} ${finding.detail ?? ''}`).join('\n')

/** The refusal itself, so its level can be asserted rather than its wording. */
const uplinkRefusal = (report: ModuleCheckReport) =>
  report.findings.find((finding) => finding.label.includes('is an uplink on this router'))

// ------------------------------------------------- an uplink named something else

describe('a second ISP offered as the DHCP LAN interface', () => {
  it('is what the router says it is, whatever the section is called', async () => {
    // The premise of the case: nothing about the name decides this, and the
    // three statements below are the whole of what does.
    const wan2 = await verdict(twoUplinks, 'wan2')

    expect(wan2?.role).toBe('uplink')
    expect(wan2?.uplinkEvidence).toContain('/etc/config/network gives it a default gateway')
  })

  it('is refused, and the refusal blocks the create rather than warning about it', async () => {
    // The blocker: accepted, this instance writes its forwardings from the WAN
    // zone and its catch-all over the uplink's own subnet. A warning would let
    // it through.
    const report = await checkOn(twoUplinks, { lan: 'wan2', carrier: 'eth1' })

    expect(report.ok).toBe(false)
    expect(uplinkRefusal(report)?.level).toBe('error')
    expect(uplinkRefusal(report)?.label).toBe('wan2 is an uplink on this router, not a LAN')
  })

  it('says which lines of the configuration placed it out there', async () => {
    // The sentence has to be actionable on the router, not just correct: an
    // operator who disagrees needs to know what was read.
    const report = await checkOn(twoUplinks, { lan: 'wan2', carrier: 'eth1' })

    const detail = uplinkRefusal(report)?.detail ?? ''
    expect(detail).toContain('/etc/config/network gives it a default gateway')
    expect(detail).toContain('which masquerades')
    // Not "it carries an address the public internet routes to". That reading is
    // gone: a LAN may legitimately hold public space - a routed block, or an
    // allocation somebody is squatting on - and treating the address as evidence
    // of direction called a router's own LAN an uplink on the one router this
    // whole classifier was rewritten for.
    expect(detail).not.toContain('the public internet routes to')
  })

  it('says what the instance would do with it, and what would change the answer', async () => {
    const report = await checkOn(twoUplinks, { lan: 'wan2', carrier: 'eth1' })

    const detail = uplinkRefusal(report)?.detail ?? ''
    expect(detail).toContain('hands a WAN to every DHCP client it sees')
    expect(detail).toContain("writes its firewall forwardings from that interface's own zone")
    expect(detail).toContain('upstream of this router')
    // The subnet the fail-closed catch-all would have been laid over.
    expect(detail).toContain('198.51.100.8/30')
    expect(detail).toContain('/etc/config/dhcp')
    expect(detail).toContain('a firewall zone that does not masquerade')
  })

  it('refuses the uplink that takes a lease on the same terms', async () => {
    // The other spelling of the same mistake, and the one the old filter did
    // catch - by its name, for the wrong reason.
    const wan = await verdict(twoUplinks, 'wan')
    expect(wan?.role).toBe('uplink')

    const report = await checkOn(twoUplinks, { lan: 'wan', carrier: 'eth2' })

    expect(report.ok).toBe(false)
    expect(uplinkRefusal(report)?.label).toBe('wan is an uplink on this router, not a LAN')
    expect(uplinkRefusal(report)?.detail).toContain(
      'it runs dhcp, so this router is a client of the network on the other side of it'
    )
  })
})

// ------------------------------------------------------- the router that is silent

describe('an interface the router does not place either way', () => {
  it('is left unclear rather than guessed at', async () => {
    const spare = await verdict(twoUplinks, 'spare')

    expect(spare?.role).toBe('unclear')
    expect(spare?.uplinkEvidence).toEqual([])
    expect(spare?.lanEvidence).toEqual([])
  })

  it('is not refused, because there is nothing to refuse it with', async () => {
    // The distinction the whole design rests on. `unclear` is the classifier
    // reporting that /etc/config does not settle the interface, and a refusal
    // there would be a confident sentence about a router the operator has done
    // nothing wrong with - which is the fault all of this replaced. The create
    // may still be held up by the findings that name what is missing; what it
    // may not say is that this interface is an uplink.
    const report = await checkOn(twoUplinks, { lan: 'spare', carrier: 'eth1' })

    expect(uplinkRefusal(report)).toBeUndefined()
    expect(text(report)).not.toContain('is an uplink on this router')
  })
})

// ------------------------------------------------------------- the ordinary router

describe('the LAN the operator meant', () => {
  it('is still accepted, with the whole gate run over it', async () => {
    // The control the refusal is worthless without: the router above is an
    // ordinary one, and picking its own network has to pass end to end.
    const lan = await verdict(twoUplinks, 'lan')
    expect(lan?.role).toBe('lan')

    const report = await checkOn(twoUplinks, { lan: 'lan', carrier: 'eth1' })

    expect(report.ok).toBe(true)
    expect(uplinkRefusal(report)).toBeUndefined()
    expect(text(report)).toContain('LAN lan is scoped to 192.168.1.0/24')
  })
})

// ------------------------------------------- the same decision, run the other way

/**
 * A carrier scoped one device too wide, so the pool swallows a second LAN.
 *
 * This is the mirror of everything above and it was the half that was missing.
 * `poolIfaces` collects an interface by its protocol and by the device it
 * terminates on, and neither says an interface is not a LAN. The one guard on a
 * pool member asked /etc/config/dhcp and nothing else - so a LAN whose DHCP is
 * served by a box downstream, which has no `config dhcp` section at all, was
 * skipped in silence. Meanwhile the classifier in the same function had already
 * scored that interface `lan` with its evidence written out, and the create went
 * on to write `option ip4table` onto one of the router's own LANs and hand it
 * out as a WAN to clients on another.
 */
const poolAteALan: Dump = {
  ifaces: [
    iface('lan', 'static', 'br-lan', '192.168.1.1'),
    iface('iot', 'static', 'eth0.30', '192.168.30.1'),
    iface('wan', 'dhcp', 'eth0.2', '203.0.113.20', { table: 10_001 })
  ],
  // Nothing here names `iot`: its addresses come from a server downstream, which
  // is exactly the router the DHCP-only guard cannot see.
  dhcp: [...DNSMASQ, ...servesDhcp('lan'), ...ignoresDhcp('wan')],
  network: [
    'network.lan=interface',
    "network.lan.device='br-lan'",
    "network.lan.proto='static'",
    "network.lan.ip6assign='60'",
    'network.iot=interface',
    "network.iot.device='eth0.30'",
    "network.iot.proto='static'",
    "network.iot.ipaddr='192.168.30.1'",
    "network.iot.ip6assign='62'",
    'network.wan=interface',
    "network.wan.device='eth0.2'",
    "network.wan.proto='dhcp'",
    "network.wan.ip4table='10001'"
  ],
  firewall: [
    ...zone(0, 'lan', ['lan']),
    ...zone(1, 'iot', ['iot']),
    ...zone(2, 'wan', ['wan'], true)
  ]
}

describe('a pool member the router calls one of its own LANs', () => {
  it('is scored a LAN even though /etc/config/dhcp never mentions it', async () => {
    const iot = await verdict(poolAteALan, 'iot')

    expect(iot?.role).toBe('lan')
    expect(iot?.lanEvidence.length).toBeGreaterThan(0)
  })

  it('is refused, blocking, in the same words the WAN-port gate uses', async () => {
    const report = await checkOn(poolAteALan, { lan: 'lan', carrier: 'eth0' })

    const refusal = report.findings.find((finding) =>
      finding.label.includes('iot') && finding.label.includes('is a LAN on this router')
    )
    expect(refusal?.level).toBe('error')
    expect(report.ok).toBe(false)
  })

  it('says nothing about a pool of genuine uplinks', async () => {
    // The positive control. `wan` alone under its own device must still create,
    // or the refusal is just a broken gate rather than a reading.
    const report = await checkOn(poolAteALan, { lan: 'lan', carrier: 'eth0.2' })

    expect(
      report.findings.some((finding) => finding.label.includes('is a LAN on this router'))
    ).toBe(false)
  })
})
