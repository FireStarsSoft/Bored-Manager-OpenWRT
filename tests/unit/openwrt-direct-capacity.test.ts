import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { DirectEngine } from '../../openwrt/main/direct'
import { DIRECT_PREF_SPAN, MAX_STORED_BINDINGS } from '../../openwrt/main/records'
import { HostStore, normalize, type DirectBindingRecord } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * How many one-to-one bindings a router may have, asked of the two things that
 * have to give the same answer.
 *
 * They used to give different ones. The per-router document stopped reading at
 * 512 bindings and threw the rest away without a word, while the create gate
 * refused only once all thousand preferences in the band were claimed - so the
 * 513th binding could be created, and disappeared from the module on the next
 * read of the document while its `ip rule`, its `bmd<slot>_` firewall sections
 * and its `ip4table` claim stayed on the router with no record left that could
 * name them, let alone remove them. That is the state the module is supposed to
 * reach only on a deliberate downgrade, after the bindings have been deleted.
 *
 * So there are two halves here: the reader keeps exactly the number it says it
 * keeps, and the gate refuses at exactly that number - with room still left in
 * the band, because the band is the wider of the two and is not what runs out.
 */

const T0 = 1_700_000_000_000

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

// --------------------------------------------------------------- the router

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

/** Stock OpenWrt: one bridged LAN that serves DHCP, one uplink that does not. */
const PROBE = [
  '===DHCP===',
  "dhcp.lan=dhcp",
  "dhcp.lan.interface='lan'",
  "dhcp.lan.limit='150'",
  'dhcp.wan=dhcp',
  "dhcp.wan.interface='wan'",
  "dhcp.wan.ignore='1'",
  '===NETWORK===',
  'network.lan=interface',
  "network.lan.ip6assign='60'",
  'network.wan=interface',
  "network.wan.ip4table='42'",
  '===FIREWALL===',
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan'",
  'firewall.@zone[1]=zone',
  "firewall.@zone[1].name='wan'",
  "firewall.@zone[1].network='wan'",
  "firewall.@zone[1].masq='1'",
  '===SYSCTL===',
  'net.netfilter.nf_conntrack_max=65536'
].join('\n')

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

// -------------------------------------------------------------- the records

/**
 * Bindings that fill the document without filling the band: the preferences run
 * from the base upwards and stop well short of the thousand the band holds, so
 * a refusal below can only be about the store's own ceiling.
 */
function existing(count: number): DirectBindingRecord[] {
  const records: DirectBindingRecord[] = []
  for (let index = 0; index < count; index++) {
    records.push({
      id: `dir_${index.toString(36).padStart(6, '0')}`,
      name: `Bound device ${index}`,
      target: { kind: 'ip', ip: `10.${Math.floor(index / 254)}.0.${(index % 254) + 1}` },
      wan: 'wan',
      enabled: true,
      whenDown: 'hold',
      pref: DEFAULT_RULES.directPrefBase + index,
      table: 42,
      lan: 'lan',
      slot: index,
      createdAt: 1
    })
  }
  return records
}

const CREATE = {
  name: 'Printer',
  targetKind: 'ip',
  address: '192.168.1.50',
  wan: 'wan',
  whenDown: 'hold'
}

async function check(held: number): Promise<{ ok: boolean; text: string }> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 3,
      instances: [],
      direct: existing(held),
      extraTables: [],
      stickyPacked: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  harness.exec.mockImplementation(async (_command, options) => {
    const stdin = options?.stdin ?? ''
    if (stdin.includes("echo '===DHCP==='")) return ok(PROBE)
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
  return {
    ok: report.ok,
    text: report.findings.map((finding) => `${finding.label}\n${finding.detail ?? ''}`).join('\n')
  }
}

// ------------------------------------------------------------- the two halves

describe('the per-router document and the create gate on how many bindings fit', () => {
  it('keeps exactly the number of one-to-one bindings it claims to keep', () => {
    const data = normalize({
      version: 3,
      instances: [],
      direct: existing(MAX_STORED_BINDINGS + 40),
      extraTables: [],
      stickyPacked: [],
      events: [],
      moduleEvents: [],
      jobs: []
    })

    expect(data.direct).toHaveLength(MAX_STORED_BINDINGS)
  })

  it('refuses the create that would not survive the next read of the document', async () => {
    const report = await check(MAX_STORED_BINDINGS)

    expect(report.ok).toBe(false)
    expect(report.text).toContain(
      `This router already has the ${MAX_STORED_BINDINGS} one-to-one bindings the module can keep a record of`
    )
    expect(report.text).toContain('One-to-one bindings list')
  })

  it('creates the one below the ceiling, so the refusal is the ceiling and not the form', async () => {
    // The positive control. Without it every assertion above would pass on a
    // gate that had simply stopped accepting anything.
    const report = await check(MAX_STORED_BINDINGS - 1)

    expect(report.ok).toBe(true)
    expect(report.text).toContain('192.168.1.50 is on LAN lan (192.168.1.0/24)')
  })

  it('refuses on the store rather than on the band, which still has room', async () => {
    // The band is the wider of the two numbers and is not what ran out: with
    // the document full, 488 of its thousand preferences are still free. A
    // refusal that talked about priorities here would send the user to Module
    // settings to widen something that was never the problem.
    expect(MAX_STORED_BINDINGS).toBeLessThan(DIRECT_PREF_SPAN)
    const report = await check(MAX_STORED_BINDINGS)

    expect(report.text).not.toContain('No free priority remains in the one-to-one band')
  })
})
