import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { MANAGED_PREF_CEILING, MAX_STORED_BINDINGS } from '../../openwrt/main/records'
import { HostStore, normalize } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * How many binding instances a router may have, asked of the two things that
 * have to give the same answer.
 *
 * They used to give different ones, in exactly the way the one-to-one half did
 * before it was fixed. The per-router document stops reading at 512 instances
 * and throws the rest away without a word, and the only thing standing in front
 * of the create was the catch-all slot gate - which counts priorities, not
 * records. On a stock router that gate hides the hole: the shipped "Safety-rule
 * priority base" leaves a hundred slots, so the router refuses long before the
 * document fills. Lower that base to 2,000, which Module settings permits and
 * which is what an operator running many IP-range instances does, and the range
 * opens to 28,000 slots with nothing counting records at all - so the 513th
 * instance could be created, and would disappear from the module on the next
 * read of the document while its client rules, its fail-closed catch-all and
 * its `bmf<slot>_` firewall sections stayed on the router, leaving a LAN
 * swallowed by a catch-all no surface can show and no record can remove.
 *
 * So there are two halves here: the reader keeps exactly the number it says it
 * keeps, and the create gate refuses at exactly that number - with slots still
 * free, because the priority range is the wider of the two and is not what ran
 * out.
 */

const T0 = 1_700_000_000_000

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

/**
 * The base an operator lowers to open the catch-all range up. Everything below
 * turns on the two limits being far apart: at 2,000 the range holds 28,000
 * slots, so a refusal at 512 can only be the document's.
 */
const LOWERED_CATCH_ALL_BASE = 2_000

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
  // The global dnsmasq section a stock router carries: the lease ceiling the
  // capacity plan reads is an option on it, and without one the create refuses
  // for a reason that has nothing to do with how many instances are stored.
  'dhcp.@dnsmasq[0]=dnsmasq',
  "dhcp.@dnsmasq[0].dhcpleasemax='1000'",
  'dhcp.lan=dhcp',
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
  sys: { uptimeSec: 4_000, load1: 0, memTotal: 512_000, memFree: 200_000 },
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
 * Instances that fill the document without filling the catch-all range: the
 * slots run from 0 upwards and stop far short of the 28,000 the lowered base
 * leaves, so a refusal below can only be about the store's own ceiling.
 *
 * Their LANs and carriers are names this router does not have. That is
 * deliberate and it is what the module would see on a router whose interfaces
 * have been renamed under it: nothing here may clash with the pair being
 * created, and nothing here may look like a subnet overlap, or the refusal
 * under test would be indistinguishable from the exclusivity one.
 */
function existing(count: number): unknown[] {
  const records: unknown[] = []
  for (let index = 0; index < count; index++) {
    records.push({
      id: `bind_${index.toString(36).padStart(6, '0')}`,
      name: `Site ${index}`,
      lan: `held${index}`,
      carrier: `heldeth${index}`,
      // Not running: this fixture is about the gate in front of Create, and a
      // held instance that tried to reconcile against a LAN this router does
      // not have would fill the report with its own unrelated complaints.
      running: false,
      sticky: true,
      remap: true,
      createdAt: 1,
      slot: index
    })
  }
  return records
}

const CREATE = { name: 'New site', lan: 'lan', carrier: 'eth1' }

async function check(held: number): Promise<ModuleCheckReport> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 3,
      instances: existing(held),
      direct: [],
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
    return ok()
  })
  const rules: OwrtRules = {
    ...DEFAULT_RULES,
    catchAllPrefBase: LOWERED_CATCH_ALL_BASE
  }
  const store = new HostStore(harness.ctx, () => rules)
  const binding = new BindingEngine(harness.ctx, store, { rules: () => rules })
  await binding.onSample(structuredClone(MODEL))
  const report = await binding.check(CREATE)
  binding.dispose()
  return report
}

const text = (report: ModuleCheckReport): string =>
  report.findings.map((finding) => `${finding.label}\n${finding.detail ?? ''}`).join('\n')

// ------------------------------------------------------------ the two halves

describe('the per-router document and the create gate on how many instances fit', () => {
  it('keeps exactly the number of binding instances it claims to keep', () => {
    const data = normalize({
      version: 3,
      instances: existing(MAX_STORED_BINDINGS + 40),
      direct: [],
      extraTables: [],
      stickyPacked: [],
      events: [],
      moduleEvents: [],
      jobs: []
    })

    expect(data.instances).toHaveLength(MAX_STORED_BINDINGS)
  })

  it('refuses the create that would not survive the next read of the document', async () => {
    const report = await check(MAX_STORED_BINDINGS)

    expect(report.ok).toBe(false)
    expect(text(report)).toContain(
      `This router already has the ${MAX_STORED_BINDINGS} binding instances the module can keep a record of`
    )
    // The list the user has to go and delete something from, by the title it
    // carries on screen.
    expect(text(report)).toContain('Binding instances list')
  })

  it('creates the one below the ceiling, so the refusal is the ceiling and not the form', async () => {
    // The positive control. Without it every assertion above would pass on a
    // gate that had simply stopped accepting anything.
    const report = await check(MAX_STORED_BINDINGS - 1)

    expect(report.ok).toBe(true)
    expect(text(report)).toContain('Will prepare and start "New site"')
  })

  it('refuses on the store rather than on the catch-all range, which still has room', async () => {
    // The range is the wider of the two numbers here and is not what ran out:
    // with the document full, 27,488 of its slots are still free. A refusal
    // that talked about priorities would send the operator back to Module
    // settings to lower a base they have already lowered.
    expect(MANAGED_PREF_CEILING - LOWERED_CATCH_ALL_BASE).toBeGreaterThan(MAX_STORED_BINDINGS)
    const report = await check(MAX_STORED_BINDINGS)

    expect(text(report)).not.toContain('No catch-all preference slot remains in the managed range')
  })
})
