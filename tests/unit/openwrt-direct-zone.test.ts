import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { preparationProbe, zoneFindings, type ExecDeps } from '../../openwrt/main/binding'
import type { ModuleCheckFinding } from '@shared/check'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { DirectEngine } from '../../openwrt/main/direct'
import { HostStore } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * What a one-to-one binding is allowed to leave in /etc/config/firewall.
 *
 * A binding names one WAN section by hand and has no pool that could put more
 * WANs behind it later, so the only zone it has any business forwarding to is
 * the one the router already puts that WAN in. It used to ask for the module's
 * own masquerading pool zone as well, which meant the first binding on a router
 * with no PPPoE pool and no binding instance - the router this feature is most
 * useful on - created a masquerading zone with no member networks that no
 * document mentions and that Delete never takes away again.
 *
 * The half that is easy to break while fixing that is the router where the pool
 * zone genuinely exists and the chosen WAN is a member of it. There the zone is
 * still the WAN's zone, the forwarding still has to name it, and nothing here
 * may touch its `masq` - getting that wrong means traffic that used to be
 * masqueraded silently stops being.
 */

const T0 = 1_700_000_000_000

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

const POOL_ZONE = DEFAULT_RULES.zoneName

// --------------------------------------------------------------- the routers

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

const DHCP = [
  'dhcp.lan=dhcp',
  "dhcp.lan.interface='lan'",
  "dhcp.lan.limit='150'",
  'dhcp.wan=dhcp',
  "dhcp.wan.interface='wan'",
  "dhcp.wan.ignore='1'"
]

const NETWORK = [
  'network.lan=interface',
  "network.lan.ip6assign='60'",
  'network.wan=interface',
  "network.wan.ip4table='42'"
]

/** Stock OpenWrt: the uplink is in its own `wan` zone and nothing else exists. */
const PLAIN_FIREWALL = [
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan'",
  'firewall.@zone[1]=zone',
  "firewall.@zone[1].name='wan'",
  "firewall.@zone[1].network='wan'",
  "firewall.@zone[1].masq='1'"
]

/**
 * A router that already runs the pool: the module's masquerading zone exists,
 * and the WAN the binding names is one of its member networks.
 */
const POOLED_FIREWALL = [
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan'",
  `firewall.${POOL_ZONE}=zone`,
  `firewall.${POOL_ZONE}.name='${POOL_ZONE}'`,
  `firewall.${POOL_ZONE}.network='wan'`,
  `firewall.${POOL_ZONE}.masq='1'`
]

function probeText(firewall: string[]): string {
  return [
    '===DHCP===',
    ...DHCP,
    '===NETWORK===',
    ...NETWORK,
    '===FIREWALL===',
    ...firewall,
    '===SYSCTL===',
    'net.netfilter.nf_conntrack_max=65536'
  ].join('\n')
}

const MODEL: RouterModel = {
  t: T0,
  sys: { uptimeSec: 4_000, load1: 0, memTotal: 0, memFree: 0 },
  ifaces: [
    iface('lan', 'static', 'br-lan', '192.168.1.1'),
    iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
  ],
  poolDev: { count: 0, rx: 0, tx: 0 },
  leases: [],
  rules: [],
  rates: {}
} as RouterModel

const CREATE = {
  name: 'Printer',
  targetKind: 'ip',
  address: '192.168.1.50',
  wan: 'wan',
  whenDown: 'hold'
}

// ------------------------------------------------------- create and apply it

interface Created {
  ok: boolean
  /** Every line this create sent to the router, in order. */
  written: string
  findings: string
}

async function createOver(firewall: string[]): Promise<Created> {
  const sent: string[] = []
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
  harness.exec.mockImplementation(async (command, options) => {
    const stdin = options?.stdin ?? ''
    if (stdin.includes("echo '===DHCP==='")) return ok(probeText(firewall))
    sent.push(command, stdin)
    if (stdin.includes('bm_wanbind')) return ok('===DONE===')
    return ok()
  })
  const rules = { ...DEFAULT_RULES }
  const engine = new DirectEngine({
    ctx: harness.ctx,
    store: new HostStore(harness.ctx, () => rules),
    rules: () => rules,
    latestModel: () => MODEL
  })
  const report = await engine.check(CREATE)
  const findings = report.findings
    .map((finding) => `${finding.label}\n${finding.detail ?? ''}`)
    .join('\n')
  if (!report.ok) return { ok: false, written: sent.join('\n'), findings }
  const applied = await engine.apply({ token: report.token, values: CREATE })
  expect(applied.ok).toBe(true)
  return { ok: true, written: sent.join('\n'), findings }
}

// ------------------------------------------------------ the router with no pool

describe('a one-to-one binding on a router with no pool and no instance', () => {
  it('forwards the LAN zone to the WAN zone the router already has', async () => {
    const created = await createOver(PLAIN_FIREWALL)

    expect(created.ok).toBe(true)
    expect(created.written).toContain('set firewall.bmd0_0=forwarding')
    expect(created.written).toContain("set firewall.bmd0_0.src='lan'")
    expect(created.written).toContain("set firewall.bmd0_0.dest='wan'")
  })

  it('leaves no masquerading pool zone behind for a delete to miss', async () => {
    // The whole gap: the zone was created here, no document mentioned it, and
    // deleting the binding takes the `bmd` sections and nothing else - so a
    // careful tester finds an empty masquerading zone on their router and has
    // to read it as a bug, because nothing told them otherwise.
    const created = await createOver(PLAIN_FIREWALL)

    expect(created.written).not.toContain(POOL_ZONE)
    expect(created.written).not.toContain('=zone')
    expect(created.written).not.toContain(".masq='1'")
  })

  it('writes one forwarding, not two', async () => {
    const created = await createOver(PLAIN_FIREWALL)

    const forwardings = created.written.match(/set firewall\.bmd0_\d+=forwarding/g) ?? []
    expect(forwardings).toHaveLength(1)
  })
})

// --------------------------------------------------- the router that has a pool

describe('a one-to-one binding on a WAN that really is inside the pool zone', () => {
  it('still forwards to that zone, because it is the zone the WAN is in', async () => {
    // Nothing about dropping the unconditional zone may drop the forwarding a
    // WAN needs: this one reaches the pool zone by being a member of it, not
    // by the create having asked for it.
    const created = await createOver(POOLED_FIREWALL)

    expect(created.ok).toBe(true)
    expect(created.written).toContain(`set firewall.bmd0_0.dest='${POOL_ZONE}'`)
  })

  it('does not rewrite the zone, so its masquerading survives untouched', async () => {
    // The dangerous half. The zone belongs to the pool - bm-pppoe-pool owns its
    // member networks and the instance half rewrites it - and a one-to-one
    // create that reached into it could only ever make things worse.
    const created = await createOver(POOLED_FIREWALL)

    expect(created.written).not.toContain(`set firewall.${POOL_ZONE}=zone`)
    expect(created.written).not.toContain(`set firewall.${POOL_ZONE}.masq=`)
  })

  it('says nothing about masquerading, because that zone masquerades', async () => {
    const created = await createOver(POOLED_FIREWALL)

    expect(created.findings).not.toContain('does not have masquerading enabled')
  })
})

// ------------------------------------------------------- the instance half

describe('the instance half, which does own the pool zone', () => {
  async function probeOver(firewall: string[]) {
    const harness = moduleHarness('openwrt', () => ok(probeText(firewall)))
    const rules = { ...DEFAULT_RULES }
    const deps: ExecDeps = { ctx: harness.ctx, disposed: false, options: { rules: () => rules } }
    return preparationProbe(deps)
  }

  it('still gets the module zone as a destination, empty pool or not', async () => {
    // An instance's pool receives its WANs later, so its forwarding has to be
    // in place before there is anything in the zone to forward to. That is the
    // caller the zone was always for.
    const findings: ModuleCheckFinding[] = []
    const zones = zoneFindings(
      await probeOver(PLAIN_FIREWALL),
      { lan: 'lan', wans: ['wan'], moduleZone: POOL_ZONE },
      findings
    )

    expect(zones.lanZone).toBe('lan')
    expect(zones.destinationZones).toContain(POOL_ZONE)
    expect(zones.destinationZones).toContain('wan')
  })

  it('still exempts the module zone from the masquerading warning', async () => {
    // It does not masquerade on this router yet because it does not exist yet;
    // the create writes it, masq and all, a moment later.
    const findings: ModuleCheckFinding[] = []
    zoneFindings(
      await probeOver(PLAIN_FIREWALL),
      { lan: 'lan', wans: ['wan'], moduleZone: POOL_ZONE },
      findings
    )

    expect(findings.map((finding) => finding.label).join('\n')).not.toContain(POOL_ZONE)
  })

  it('leaves it out entirely for the caller that does not name one', async () => {
    const findings: ModuleCheckFinding[] = []
    const zones = zoneFindings(
      await probeOver(PLAIN_FIREWALL),
      { lan: 'lan', wans: ['wan'] },
      findings
    )

    expect(zones.destinationZones).toEqual(['wan'])
  })

  /**
   * The zone verdicts this gate hands back move with how UCI booleans are read,
   * and they are supposed to: `masq` has four spellings of true and fw4 honours
   * all of them, while LuCI writes only `1`. Compared against that one string,
   * the warning below stood on every check of a hand-edited or migrated router
   * and named a remedy the operator had already applied.
   */
  const spelledMasq = (word: string): string[] => [
    'firewall.@zone[0]=zone',
    "firewall.@zone[0].name='lan'",
    "firewall.@zone[0].network='lan'",
    'firewall.@zone[1]=zone',
    "firewall.@zone[1].name='wan'",
    "firewall.@zone[1].network='wan'",
    `firewall.@zone[1].masq='${word}'`
  ]

  const warned = async (word: string): Promise<boolean> => {
    const findings: ModuleCheckFinding[] = []
    zoneFindings(await probeOver(spelledMasq(word)), { lan: 'lan', wans: ['wan'] }, findings)
    return findings.some((finding) => finding.label.includes('does not have masquerading enabled'))
  }

  it('reads all four spellings of a true UCI boolean as masquerading', async () => {
    expect(await warned('1')).toBe(false)
    expect(await warned('on')).toBe(false)
    expect(await warned('true')).toBe(false)
    expect(await warned('yes')).toBe(false)
  })

  it('still warns about a WAN zone that really does no SNAT', async () => {
    // The control. Widening what counts as true must not stop the gate saying
    // the one thing it is there to say.
    expect(await warned('0')).toBe(true)
    expect(await warned('off')).toBe(true)
  })
})
