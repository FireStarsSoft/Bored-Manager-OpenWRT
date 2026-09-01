import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { DirectEngine } from '../../openwrt/main/direct'
import { HostStore } from '../../openwrt/main/store'
import type { OwrtHostData } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * The reported bug, driven all the way to the router.
 *
 * tests/unit/openwrt-direct-layouts.test.ts is twelve routers deep on the
 * question the reporter's router got wrong - is this VLAN a LAN or an uplink -
 * but every one of those assertions stops at the check report. The only file
 * that drives check-then-apply through a real `DirectEngine` is
 * openwrt-direct-zone.test.ts, and both of its routers are the stock one, with
 * `lan` on `br-lan`. So on the day the fix shipped, not one line of
 * `applyDirect`, `revalidate`, `installScopedForwardings` or `runDirectPass`
 * had ever run over the shape of router the bug was reported on.
 *
 * That gap has a specific failure in it. The check places the address and
 * stamps a plan; the job then re-derives the same facts from a fresh probe -
 * `revalidate` compares the LAN's firewall zone against the stamped one, and
 * `installScopedForwardings` refuses a zone name it would not write. Any
 * disagreement between the two halves is a create that passes the page and then
 * fails as a job item minutes later, which the reporter would have experienced
 * as the same bug a second time. So the assertions here are about what actually
 * reaches the router: the `bmd<slot>_` forwarding, the `ip -4 rule add`, and
 * `option ip4table`.
 */

const T0 = 1_700_000_000_000

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

// -------------------------------------------------------------- the layouts

/**
 * One router, in the vocabulary openwrt-direct-layouts.test.ts already uses:
 * what the interface dump says, and what `uci show` says.
 *
 * Written out again rather than imported because importing one test file from
 * another runs its `describe` blocks a second time, under this file's name. The
 * builders are deliberately identical in shape and name, so a router that has a
 * verdict over there can be dropped in here and driven to completion.
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

/**
 * The uplink's section. `table` is optional here, which it is not in the
 * layouts file, because a WAN whose `/etc/config/network` carries no
 * `option ip4table` is the only router on which the create writes one - and
 * that write is one of the three things this file exists to watch land.
 */
const wanSection = (name: string, table: number | null = 42): string[] => [
  `network.${name}=interface`,
  ...(table == null ? [] : [`network.${name}.ip4table='${table}'`])
]

/** One LAN on whatever device the caller names, and one DHCP uplink. */
function oneLanOn(device: string, over: Partial<Layout> = {}): Layout {
  return {
    ifaces: [
      iface('lan', 'static', device, '192.168.1.1'),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: 42 })
    ],
    dhcp: [...serves('lan'), ...ignores('wan')],
    network: [...lanSection('lan'), ...wanSection('wan')],
    firewall: [...zone(0, 'lan', ['lan']), ...zone(1, 'wan', ['wan', 'wan6'], true)],
    ...over
  }
}

// ------------------------------------------------------- driving a real create

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

interface Created {
  checkOk: boolean
  /** Every finding the page would have shown, label and detail together. */
  findings: string
  /** Null when the check refused, so nothing was ever applied. */
  applied: OkResult | null
  /** Every line this create sent to the router, in order. Reads excluded. */
  written: string
  /** The per-router document as it stands after the job. */
  data: OwrtHostData
  /** How many times the preparation probe was read - the check, then the job. */
  probes: number
}

/**
 * Check, then apply, over one written-down router.
 *
 * `afterCheck` is the whole point of the second half: `revalidate` exists
 * because minutes can pass between the page saying yes and the job writing, and
 * the only way to exercise it is to hand the job a different router from the
 * one the check read. It replaces the /etc/config the probe reads and not the
 * interface dump, which is the same split the module lives with - the sample is
 * refreshed on a tick of its own.
 */
async function createOn(
  layout: Layout,
  options: { values?: Partial<typeof CREATE>; afterCheck?: Layout } = {}
): Promise<Created> {
  const sent: string[] = []
  let probes = 0
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
  harness.exec.mockImplementation(async (command, execOptions) => {
    const stdin = execOptions?.stdin ?? ''
    if (stdin.includes("echo '===DHCP==='")) {
      probes += 1
      return ok(probeText(probes === 1 ? layout : (options.afterCheck ?? layout)))
    }
    // Read, not a write: kept out of `written` so an assertion about what
    // reached the router is not satisfied by a probe script quoting it.
    if (stdin.includes('bm_wanbind')) return ok('===DONE===')
    sent.push(command, stdin)
    return ok()
  })
  const rules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  const values = { ...CREATE, ...options.values }
  // One sample, handed back to every caller, because the pass folds its own
  // diff into `model.rules` and a fresh object per call would hide that.
  const sample = model(layout)
  const engine = new DirectEngine({
    ctx: harness.ctx,
    store,
    rules: () => rules,
    latestModel: () => sample
  })
  const report = await engine.check(values)
  const findings = report.findings
    .map((finding) => `${finding.label}\n${finding.detail ?? ''}`)
    .join('\n')
  const applied = report.ok ? await engine.apply({ token: report.token, values }) : null
  return {
    checkOk: report.ok,
    findings,
    applied,
    written: sent.join('\n'),
    data: store.read(),
    probes
  }
}

/** The default band and table, so the assertions read as the numbers they are. */
const PREF = DEFAULT_RULES.directPrefBase
const TABLE = 42

// ------------------------------------------------- the routers that were refused

describe('a create driven to completion on a LAN that is not a bridge', () => {
  it('installs the forwarding, the rule and the record on a VLAN LAN', async () => {
    // The reporter's router. `eth0.1` is what the old classifier read as an
    // uplink, and everything below this line is what that reporter never got
    // to see happen.
    const created = await createOn(oneLanOn('eth0.1'))

    expect(created.checkOk).toBe(true)
    expect(created.applied?.ok).toBe(true)
    expect(created.written).toContain('set firewall.bmd0_0=forwarding')
    expect(created.written).toContain("set firewall.bmd0_0.src='lan'")
    expect(created.written).toContain("set firewall.bmd0_0.dest='wan'")
    expect(created.written).toContain(
      `ip -4 rule add from 192.168.1.50/32 lookup ${TABLE} pref ${PREF}`
    )
    expect(created.data.direct).toHaveLength(1)
    expect(created.data.direct[0]).toMatchObject({
      name: 'Printer',
      lan: 'lan',
      wan: 'wan',
      pref: PREF,
      table: TABLE,
      slot: 0
    })
  })

  it('installs the same three things on a LAN that is a plain port', async () => {
    const created = await createOn(oneLanOn('eth0'))

    expect(created.applied?.ok).toBe(true)
    expect(created.written).toContain("set firewall.bmd0_0.src='lan'")
    expect(created.written).toContain(
      `ip -4 rule add from 192.168.1.50/32 lookup ${TABLE} pref ${PREF}`
    )
  })

  /**
   * A LAN the router places on the strength of one statement: it hands out DHCP
   * leases. No `option ip6assign`, and no masquerading anywhere on the router,
   * so the quiet-zone reading says nothing either. This is the thinnest
   * evidence a create is allowed to proceed on, which makes it the one most
   * worth driving to the end.
   */
  const dhcpOnly: Layout = {
    ifaces: [
      iface('lan', 'static', 'wlan0', '192.168.1.1'),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: TABLE })
    ],
    dhcp: [...serves('lan')],
    network: ['network.lan=interface', ...wanSection('wan')],
    firewall: [...zone(0, 'lan', ['lan']), ...zone(1, 'wan', ['wan'])]
  }

  it('installs them on a LAN whose only evidence is a dnsmasq section', async () => {
    const created = await createOn(dhcpOnly)

    expect(created.checkOk).toBe(true)
    expect(created.applied?.ok).toBe(true)
    // Placed, not merely tolerated: an `unclear` verdict would have created
    // this binding too, and it would have said so.
    expect(created.findings).not.toContain('Nothing this router states says whether')
    expect(created.written).toContain("set firewall.bmd0_0.src='lan'")
    expect(created.written).toContain("set firewall.bmd0_0.dest='wan'")
    expect(created.written).toContain(
      `ip -4 rule add from 192.168.1.50/32 lookup ${TABLE} pref ${PREF}`
    )
  })

  it('claims option ip4table when the WAN section carries none', async () => {
    // The third write, and the only router it happens on: netifd is running the
    // WAN on table 42, /etc/config/network does not say so, and a rule looking
    // that table up would stop working the moment netifd forgot it.
    const created = await createOn(
      oneLanOn('eth0.1', {
        ifaces: [
          iface('lan', 'static', 'eth0.1', '192.168.1.1'),
          iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: TABLE })
        ],
        network: [...lanSection('lan'), ...wanSection('wan', null)]
      })
    )

    expect(created.applied?.ok).toBe(true)
    expect(created.written).toContain(`set network.wan.ip4table='${TABLE}'`)
    // Claimed by this binding's record, which is what a later delete reads to
    // decide whether the option was ever this module's to take away again.
    expect(created.data.extraTables).toContainEqual(['wan', TABLE, created.data.direct[0]?.id])
    expect(created.written).toContain(
      `ip -4 rule add from 192.168.1.50/32 lookup ${TABLE} pref ${PREF}`
    )
  })

  /**
   * Three LANs on three device shapes, each in its own firewall zone. The
   * forwarding is written once, from one zone, and never rewritten - so writing
   * it from the wrong LAN's zone is not a cosmetic error, it is a device with
   * no path out and a page that says the create worked.
   */
  const threeLans: Layout = {
    ifaces: [
      iface('lan', 'static', 'eth0.1', '192.168.1.1'),
      iface('guest', 'static', 'wlan0', '192.168.3.1'),
      iface('iot', 'static', 'eth0.20', '192.168.20.1'),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: TABLE })
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

  it('writes the forwarding from the zone of the LAN the address is really on', async () => {
    const created = await createOn(threeLans, { values: { address: '192.168.20.50' } })

    expect(created.applied?.ok).toBe(true)
    expect(created.written).toContain("set firewall.bmd0_0.src='iot'")
    expect(created.written).not.toContain("set firewall.bmd0_0.src='lan'")
    expect(created.data.direct[0]?.lan).toBe('iot')
    expect(created.written).toContain(
      `ip -4 rule add from 192.168.20.50/32 lookup ${TABLE} pref ${PREF}`
    )
  })
})

// ------------------------------------------- where the two halves could disagree

describe('the check and the job reading the router at two different moments', () => {
  it('reads the configuration twice, which is the only reason any of this can differ', async () => {
    const created = await createOn(oneLanOn('eth0.1'))

    expect(created.probes).toBe(2)
  })

  it('still creates when the router changed in a way this binding is not about', async () => {
    // Somebody added a guest network between the page and the job. Nothing
    // about this binding moved, and a create that failed here would be the
    // reported bug wearing a different hat: a refusal about a router that is
    // configured perfectly well.
    const before = oneLanOn('eth0.1')
    const after: Layout = {
      ...before,
      dhcp: [...before.dhcp, ...serves('guest')],
      network: [...before.network, ...lanSection('guest')],
      firewall: [...before.firewall, ...zone(2, 'guest', ['guest'])]
    }
    const created = await createOn(before, { afterCheck: after })

    expect(created.applied?.ok).toBe(true)
    expect(created.written).toContain("set firewall.bmd0_0.src='lan'")
  })

  it('refuses in the job, by name, when the LAN zone was renamed underneath it', async () => {
    // The disagreement `revalidate` exists for. The forwarding must not be
    // written from a zone that no longer exists, and the sentence has to send
    // the operator back to the form rather than leaving them a failed job.
    const before = oneLanOn('eth0.1')
    const after: Layout = {
      ...before,
      firewall: [...zone(0, 'trusted', ['lan']), ...zone(1, 'wan', ['wan', 'wan6'], true)]
    }
    const created = await createOn(before, { afterCheck: after })

    expect(created.checkOk).toBe(true)
    expect(created.applied?.ok).toBe(false)
    expect(created.applied?.error).toContain('the LAN firewall zone changed')
    // And nothing reached the firewall on the way to finding that out.
    expect(created.written).not.toContain('set firewall.bmd0_0=forwarding')
  })

  it('refuses in the job when the WAN section is gone by the time it runs', async () => {
    const before = oneLanOn('eth0.1')
    const after: Layout = { ...before, network: [...lanSection('lan')] }
    const created = await createOn(before, { afterCheck: after })

    expect(created.applied?.ok).toBe(false)
    expect(created.applied?.error).toContain('WAN section wan no longer exists')
  })
})

// ------------------------------------------------------- awkward firewall zones

describe('LANs whose firewall zone is not spelled the way the stock one is', () => {
  it('carries a hyphenated zone name through to the forwarding it writes', async () => {
    // Legal in UCI and legal here; the only thing that must not happen is the
    // check passing and the job then refusing the same name.
    const created = await createOn(
      oneLanOn('eth0.1', {
        firewall: [...zone(0, 'lan-vlan_7', ['lan']), ...zone(1, 'wan', ['wan'], true)]
      })
    )

    expect(created.checkOk).toBe(true)
    expect(created.applied?.ok).toBe(true)
    expect(created.written).toContain("set firewall.bmd0_0.src='lan-vlan_7'")
  })

  it('stops a zone name it will not write at the gate, not inside the job', async () => {
    // `installScopedForwardings` throws on a name outside the character set it
    // is willing to interpolate. That throw belongs to a router nobody has, and
    // the gate is where it has to be caught: a job item is a much worse place
    // to read this sentence than the form is.
    const created = await createOn(
      oneLanOn('eth0.1', {
        firewall: [...zone(0, 'lan.guest', ['lan']), ...zone(1, 'wan', ['wan'], true)]
      })
    )

    expect(created.checkOk).toBe(false)
    expect(created.findings).toContain('LAN firewall zone "lan.guest" has an unsupported name')
    expect(created.applied).toBeNull()
  })

  it('refuses at the gate when the WAN is in no firewall zone at all', async () => {
    // There is no zone to forward to, so there is nothing to write; the point
    // of the assertion is that this is said on the page, with the WAN named,
    // rather than surfacing as "the WAN pool resolved to no firewall zone at
    // all" on a failed job item minutes later.
    const created = await createOn(
      oneLanOn('eth0.1', { firewall: [...zone(0, 'lan', ['lan'])] })
    )

    expect(created.checkOk).toBe(false)
    expect(created.findings).toContain('WAN "wan" is not assigned to a firewall zone')
    expect(created.applied).toBeNull()
    expect(created.written).not.toContain('=forwarding')
  })

  /**
   * The same router as every passing test above, with its zone membership
   * written the other way UCI spells a list: `option network 'lan guest'` on
   * one line rather than a `list network` entry per network. fw4 splits that
   * value on whitespace, so both zones on this router really do contain their
   * networks and the firewall it builds is the same one.
   *
   * The check does not agree. It refuses with `LAN "lan" is not assigned to a
   * firewall zone` and `WAN "wan" is not assigned to a firewall zone` - the
   * reported bug's own shape exactly: a confident refusal aimed at a router
   * that is configured correctly, derived from reading one narrow spelling of a
   * fact OpenWrt states in several legal ways. `firewallZoneForNetwork` in
   * openwrt/main/binding/uci-doc.ts compares whole `uci show` tokens against
   * the network name, and `tokenizeUciValues` hands it `lan guest` as one
   * token. The two-quoted-tokens spelling a `list` prints as - `'lan' 'guest'`
   * - does tokenize apart, which is why nothing before this noticed.
   *
   * That reader has since learned the spelling: `firewallZoneForNetwork` splits
   * the value on whitespace before looking for the network in it, which is what
   * fw4 does with the same line. The split is at that one key rather than in
   * `tokenizeUciValues`, because values under other keys legitimately contain
   * spaces and a tokenizer that broke them apart would be a wider bug than the
   * one it fixed.
   */
  const spaceSeparatedZones: Layout = oneLanOn('eth0.1', {
    ifaces: [
      iface('lan', 'static', 'eth0.1', '192.168.1.1'),
      iface('guest', 'static', 'wlan0', '192.168.3.1'),
      iface('wan', 'dhcp', 'eth1', '203.0.113.20', { ip4Table: TABLE })
    ],
    dhcp: [...serves('lan'), ...serves('guest'), ...ignores('wan')],
    network: [...lanSection('lan'), ...lanSection('guest'), ...wanSection('wan')],
    firewall: [
      'firewall.@zone[0]=zone',
      "firewall.@zone[0].name='lan'",
      "firewall.@zone[0].network='lan guest'",
      'firewall.@zone[1]=zone',
      "firewall.@zone[1].name='wan'",
      "firewall.@zone[1].network='wan wan6'",
      "firewall.@zone[1].masq='1'"
    ]
  })

  it('creates when a zone names its networks in one option', async () => {
    const created = await createOn(spaceSeparatedZones)

    expect(created.checkOk).toBe(true)
    expect(created.applied?.ok).toBe(true)
    expect(created.written).toContain("set firewall.bmd0_0.src='lan'")
    expect(created.written).toContain("set firewall.bmd0_0.dest='wan'")
  })
})
