import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { Lease, RouterModel } from '../../openwrt/main/types'
import { harnessOverHostData, hostDataDocument, type HostDataDocument } from '../helpers/host-data'
import { sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import { POOL_AGENT_INFO, routerProbeOutput } from '../helpers/router'

/**
 * Everything here is one question asked four times: was it written, or was it
 * only ever in memory?
 *
 * The four records below are the ones a restart cannot reconstruct. A batch
 * record is the only thing that can ever find five thousand live PPPoE sections
 * again; an instance record is the only thing that knows which LAN a set of ip
 * rules belongs to; the sticky map is what keeps a device on the same WAN
 * across a reconnect; job history is the only account of what the module did to
 * the router. Asking a handler whether they are there proves nothing on its own
 * - the answer comes out of the store's in-memory cache and would be identical
 * if every write had been thrown away. So each of these writes through one
 * document, drops everything holding it, and asks a module that has just
 * started up against that document instead.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// ------------------------------------------------------------- PPPoE + jobs
//
// The batch record itself no longer lives in this document - the pool of
// record is /etc/config/bm_pppoe on the router, kept by bm-pppoe-pool - so
// the restart question left with it. What still has to survive a restart on
// this side is the job history the create leaves behind.

/** A router whose pool daemon accepts a one-member create. */
function pppoeRouter(doc: HostDataDocument): ModuleHarness {
  const harness = harnessOverHostData('openwrt', () => ok(), doc, {
    config: sharedModuleConfig(null)
  })
  harness.exec.mockImplementation(async (command) => {
    if (command.includes("echo '===REL==='")) {
      return ok(routerProbeOutput({ agent: POOL_AGENT_INFO }))
    }
    if (command.includes('mktemp /tmp/bm-pool.XXXXXX')) return ok('/tmp/bm-pool.doc001\n')
    if (command.includes("cat > '/tmp/bm-pool.")) return ok()
    if (command.includes('bm.pppoe pool_check')) {
      return ok(JSON.stringify({ ok: true, findings: [] }))
    }
    if (command.includes('bm.pppoe pool_create')) {
      return ok(JSON.stringify({ ok: true, id: 'fpt1', created: 1 }))
    }
    if (command.includes('bm.pppoe info')) {
      return ok(
        JSON.stringify({
          name: 'bm-pppoe-pool',
          release: '2.0.0',
          apiVersion: 2,
          settings: { enabled: true, counter_interval: 5, redial_after: 120, redial_batch: 20 },
          started: 1,
          uptime: 1,
          pools: [
            {
              id: 'fpt1',
              mode: 'multi',
              label: '',
              prefix: 'fpt',
              carrier: 'eth1',
              mac_mode: 'auto',
              username: 'u@isp',
              hasPassword: true,
              table_base: 10_000,
              service: '',
              ac: '',
              ac_mac: '',
              mtu: 0,
              keepalive: '',
              ipv6: '0',
              peerdns: false,
              dns: [],
              defaultroute: true,
              host_uniq: '',
              demand: 0,
              padi_attempts: 0,
              padi_timeout: 0,
              pppd_options: '',
              zone: 'bmwanpool',
              masq: true,
              mtu_fix: true,
              lan_forward: true,
              created: 1,
              memberList: [{ vlan: 101, username: '' }],
              members: 1,
              up: 0,
              dialing: 0,
              down: 1,
              error: 0,
              stopped: 0,
              unwritten: 0,
              createdAt: 1,
              rate: { rxBps: 0, txBps: 0 }
            }
          ],
          legacy: []
        })
      )
    }
    if (command.includes('bm.pppoe sessions')) {
      return ok(JSON.stringify({ sessions: [], limit: 500 }))
    }
    return ok()
  })
  return harness
}

describe('a PPPoE create after the module is restarted', () => {
  it('brings the job that created it back out of the document', async () => {
    const doc = hostDataDocument()
    const first = pppoeRouter(doc)
    const running = activate(first.ctx)
    running.applyPollers?.()
    await settle()

    const values = { mode: 'multi', id: 'fpt1', carrier: 'eth1', prefix: 'fpt', vlans: '101' }
    const report = (await first.handlers.get('poolCreateCheck')?.(values)) as {
      ok: boolean
      token?: string
    }
    expect(report.ok).toBe(true)
    expect(
      await first.handlers.get('poolCreateApply')?.({ token: report.token, values })
    ).toMatchObject({ ok: true })
    await settle()

    // Job history is written on the ten-second debounce, so the flush that
    // dispose performs is the only thing that can have saved it.
    running.dispose?.()
    expect(doc.writes).toBeGreaterThan(0)

    const second = pppoeRouter(doc)
    const restarted = activate(second.ctx)
    const jobs = (restarted.snapshots?.() as { jobs: { finished: Array<{ label: string; state: string }> } })
      .jobs

    expect(jobs.finished.map((job) => job.label)).toContain('Create pool fpt1 (1 interface)')
    expect(jobs.finished[0].state).toBe('done')
    restarted.dispose?.()
  })
})

// ------------------------------------------------------------------ binding

const DHCP_DUMP = [
  'dhcp.@dnsmasq[0]=dnsmasq',
  "dhcp.@dnsmasq[0].leasefile='/tmp/dhcp.leases'",
  "dhcp.@dnsmasq[0].dhcpleasemax='150'",
  'dhcp.lan=dhcp',
  "dhcp.lan.interface='lan'",
  "dhcp.lan.start='100'",
  "dhcp.lan.limit='150'",
  "dhcp.lan.leasetime='12h'"
].join('\n')

const NETWORK_DUMP = [
  'network.lan=interface',
  "network.lan.device='br-lan'",
  "network.lan.proto='static'",
  'network.wan=interface',
  "network.wan.device='eth1'",
  "network.wan.proto='dhcp'",
  "network.wan.ip4table='201'"
].join('\n')

const FIREWALL_DUMP = [
  'firewall.@defaults[0]=defaults',
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan'",
  'firewall.@zone[1]=zone',
  "firewall.@zone[1].name='wan'",
  "firewall.@zone[1].network='wan'",
  "firewall.@zone[1].masq='1'"
].join('\n')

const PREPARATION_PROBE = [
  '===DHCP===',
  DHCP_DUMP,
  '===NETWORK===',
  NETWORK_DUMP,
  '===FIREWALL===',
  FIREWALL_DUMP,
  '===SYSCTL===',
  'net.netfilter.nf_conntrack_max=65536'
].join('\n')

const DESK = 'aa:bb:cc:dd:ee:01'

function bindingModel(leases: Lease[] = []): RouterModel {
  return {
    t: 1_700_000_000_000,
    sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
    ifaces: [
      {
        name: 'lan',
        proto: 'static',
        device: 'br-lan',
        l3Device: 'br-lan',
        up: true,
        pending: false,
        autostart: true,
        uptimeSec: 4_000,
        ipv4: { addr: '192.168.1.1', mask: 24 }
      },
      {
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        l3Device: 'eth1',
        up: true,
        pending: false,
        autostart: true,
        uptimeSec: 4_000,
        ipv4: { addr: '198.51.100.2', mask: 24 },
        // The `option ip4table` the sweep reads off /etc/config/network. A WAN
        // with no table of its own can carry no binding rule at all, so without
        // it the reconcile below has nothing to assign the device to.
        ip4Table: 201
      }
    ],
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases,
    rules: [],
    rates: { 'br-lan': { rx: 0, tx: 0 }, eth1: { rx: 0, tx: 0 } }
  }
}

function bindingOver(doc: HostDataDocument): { engine: BindingEngine; store: HostStore } {
  const harness = harnessOverHostData('openwrt', () => ok(), doc)
  harness.exec.mockImplementation(async (command, options) => {
    const stdin = options?.stdin ?? ''
    if (command === 'sh -s' && stdin.includes("echo '===DHCP==='")) return ok(PREPARATION_PROBE)
    return ok()
  })
  const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
  return { engine: new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES }), store }
}

describe('a binding instance after the module is restarted', () => {
  it('is on the document the moment it is created, not ten seconds later', async () => {
    const doc = hostDataDocument()
    const first = bindingOver(doc)
    await first.engine.onSample(bindingModel())

    const report = await first.engine.check({ name: 'Office', lan: 'lan', carrier: 'eth1' })
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(await first.engine.apply({ token: report.token, values: { name: 'Office', lan: 'lan', carrier: 'eth1' } }))
      .toMatchObject({ ok: true })

    // No flush, no dispose: an instance appearing is topology, and the module
    // writes it through rather than waiting out the ten-second debounce. A
    // crash inside that window would otherwise bring the module back believing
    // it owns no LAN while its rules are on the router.
    expect(doc.writes).toBeGreaterThan(0)

    const second = bindingOver(doc)
    expect(second.engine.carriers()).toMatchObject([
      { name: 'Office', carrier: 'eth1', running: true }
    ])
  })

  it('keeps the numbering it was installed under, all six values or none', async () => {
    const doc = hostDataDocument()
    const first = bindingOver(doc)
    await first.engine.onSample(bindingModel())
    const values = { name: 'Office', lan: 'lan', carrier: 'eth1' }
    const report = await first.engine.check(values)
    expect(report.ok).toBe(true)
    if (!report.ok) return
    await first.engine.apply({ token: report.token, values })

    const second = bindingOver(doc)
    // Read back through the store rather than a row builder: the stamp is what
    // every later removal aims at, and a layout that came back half-read would
    // send one command to the recorded table range and the next to whatever the
    // settings now say.
    expect(second.store.read().instances[0]?.layout).toEqual({
      tableBase: DEFAULT_RULES.tableBase,
      rulePrefBase: DEFAULT_RULES.rulePrefBase,
      catchAllPrefBase: DEFAULT_RULES.catchAllPrefBase,
      catchAllTable: DEFAULT_RULES.catchAllTable,
      zoneName: DEFAULT_RULES.zoneName
    })
  })
})

describe('the sticky WAN map after the module is restarted', () => {
  it('survives the write in the packed form, colons and all', async () => {
    const doc = hostDataDocument()
    const first = bindingOver(doc)
    await first.engine.onSample(bindingModel())
    const values = { name: 'Office', lan: 'lan', carrier: 'eth1' }
    const report = await first.engine.check(values)
    expect(report.ok).toBe(true)
    if (!report.ok) return
    await first.engine.apply({ token: report.token, values })

    // A device arrives and the reconcile records which WAN it was given.
    await first.engine.onSample(
      bindingModel([{ expires: 0, mac: DESK, ip: '192.168.1.20', host: 'desk' }])
    )
    const chosen = first.engine.rows(first.engine.carriers()[0]?.id).find((row) => row.mac === DESK)
    expect(chosen?.wan).toBeTruthy()
    // Sticky entries ride the debounce; this is the flush a dispose performs.
    first.store.dispose()

    const second = bindingOver(doc)
    // The map is written as `instance|macwithoutcolons|wan|base36`, so this is
    // also the assertion that the packing is reversible: an entry that came
    // back with the colons in the wrong places would name a device that never
    // asks for a lease again, and the WAN it names would be held forever.
    expect(second.store.read().stickyMap).toEqual([
      [second.engine.carriers()[0]?.id, DESK, chosen?.wan, expect.any(Number)]
    ])
  })
})
