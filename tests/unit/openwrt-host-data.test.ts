import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { Lease, RouterModel } from '../../openwrt/main/types'
import { harnessOverHostData, hostDataDocument, type HostDataDocument } from '../helpers/host-data'
import { sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'

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

const PROBE = [
  '===REL===',
  "DISTRIB_ID='OpenWrt'",
  "DISTRIB_RELEASE='25.12.0'",
  '===BOARD===',
  JSON.stringify({ model: 'Test Router', release: { distribution: 'OpenWrt', version: '25.12.0' } }),
  '===TOOLS===',
  '/sbin/ubus',
  '/sbin/uci',
  '/sbin/ip',
  '/sbin/fw4',
  '/usr/sbin/nft',
  '/usr/sbin/pppd',
  '===PPP===',
  'plugin',
  'kmod',
  '===PKG===',
  'apkdb',
  '===DONE==='
].join('\n')

/** A router that accepts a two-connection create and lists the result. */
function pppoeRouter(doc: HostDataDocument): ModuleHarness {
  const harness = harnessOverHostData('openwrt', () => ok(), doc, {
    config: sharedModuleConfig({ rules: { chunkDelayMs: 0 } })
  })
  harness.exec.mockImplementation(async (command, options) => {
    const stdin = options?.stdin ?? ''
    if (command.includes("echo '===REL==='")) return ok(PROBE)
    if (command === 'sh -s' && stdin.includes('===CARRIER===')) {
      return ok('===CARRIER===1\n===NETWORK===\n')
    }
    if (command === 'ubus -S call network.interface dump') {
      return ok(JSON.stringify({ interface: [{ interface: 'pd00001' }, { interface: 'pd00002' }] }))
    }
    if (command.startsWith('nft list ruleset')) return ok('1 1')
    return ok()
  })
  return harness
}

async function createBatch(harness: ModuleHarness): Promise<void> {
  const values = { name: 'Pool', carrier: 'eth1', prefix: 'pd', listText: 'u1,p1\nu2,p2' }
  const report = (await harness.handlers.get('pppoeBatchCheck')?.(values)) as {
    ok: boolean
    token?: string
  }
  expect(report.ok).toBe(true)
  expect(
    await harness.handlers.get('pppoeBatchApply')?.({
      token: report.token,
      values: { ...values, listFile: '', listText: '' }
    })
  ).toMatchObject({ ok: true })
  await settle()
}

describe('a PPPoE batch record after the module is restarted', () => {
  it('comes back off the document rather than out of the cache it was created in', async () => {
    const doc = hostDataDocument()
    const first = pppoeRouter(doc)
    const running = activate(first.ctx)
    running.applyPollers?.()
    await settle()

    await createBatch(first)
    expect(first.handlers.get('pppoeBatches')?.()).toHaveLength(1)
    running.dispose?.()

    // The positive control: without a write reaching the document, everything
    // below would be asserting that an empty module has no batches.
    expect(doc.writes).toBeGreaterThan(0)

    const second = pppoeRouter(doc)
    const restarted = activate(second.ctx)

    // Nothing has sampled this router and nothing has been created; every field
    // here can only have come out of what the first module wrote.
    const reloaded = second.handlers.get('pppoeBatches')?.() as Array<{ id: string }>
    expect(reloaded).toMatchObject([{ name: 'Pool', prefix: 'pd', carrier: 'eth1', count: 2 }])
    // The sequence range too, read back the only way a surface can see it: the
    // section names are `prefix` plus `seqFrom..seqTo`, and they are what a
    // later delete has to hand to UCI.
    const rows = second.handlers.get('pppoeRows')?.(reloaded[0].id) as Array<{ name: string }>
    expect(rows.map((row) => row.name)).toEqual(['pd00001', 'pd00002'])
    restarted.dispose?.()
  })

  it('brings the job that created it back too', async () => {
    const doc = hostDataDocument()
    const first = pppoeRouter(doc)
    const running = activate(first.ctx)
    running.applyPollers?.()
    await settle()

    await createBatch(first)
    // Job history is written on the ten-second debounce, so the flush that
    // dispose performs is the only thing that can have saved it.
    running.dispose?.()

    const second = pppoeRouter(doc)
    const restarted = activate(second.ctx)
    const jobs = (restarted.snapshots?.() as { jobs: { finished: Array<{ label: string; state: string }> } })
      .jobs

    expect(jobs.finished.map((job) => job.label)).toContain('Create batch Pool (2 connections)')
    expect(jobs.finished[0].state).toBe('done')
    restarted.dispose?.()
  })

  it('does not resurrect a batch on a router whose document is empty', async () => {
    // The other half of the same statement. If the reload above were reading
    // anything but the document, this would find the batch as well.
    const second = pppoeRouter(hostDataDocument())
    const restarted = activate(second.ctx)

    expect(second.handlers.get('pppoeBatches')?.()).toEqual([])
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
      zoneName: DEFAULT_RULES.zoneName,
      zoneMode: DEFAULT_RULES.zoneMode
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
