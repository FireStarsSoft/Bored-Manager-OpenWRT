import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * The catch-all must not blackhole the router that installs it.
 *
 * `ip rule` selects on **source**, and the selector is the LAN's network - which
 * contains the router's own address on that LAN. Pointed at a table holding
 * nothing but `unreachable default`, every packet the router itself sends to one
 * of its own clients came back EHOSTUNREACH: no SSH, no ping, no DNS or DHCP
 * answers from dnsmasq. Adding a fib rule flushes the route cache, so it took
 * the session that installed it with it, and the config is committed, so a
 * reboot brought it straight back.
 *
 * The fix is the LAN's connected route in the same table. What must not change
 * is why the table exists: an unassigned client still has no default and cannot
 * leak out of the router's own WAN. Both halves are asserted here, because a
 * "fix" that quietly opened the blackhole would pass a test that only checked
 * the first.
 */

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

const STAMPED = {
  tableBase: DEFAULT_RULES.tableBase,
  rulePrefBase: DEFAULT_RULES.rulePrefBase,
  catchAllPrefBase: DEFAULT_RULES.catchAllPrefBase,
  catchAllTable: DEFAULT_RULES.catchAllTable,
  zoneName: DEFAULT_RULES.zoneName
}

const MODEL: RouterModel = {
  t: 1_700_000_000_000,
  sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
  ifaces: [
    {
      name: 'lan',
      proto: 'static',
      // Deliberately different from `device`: the connected route has to name
      // the interface that carries IP, which on a bridged LAN is not a port.
      device: 'eth0',
      l3Device: 'br-lan',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '192.168.1.1', mask: 24 }
    },
    {
      name: 'pd00001',
      proto: 'pppoe',
      device: 'eth1',
      l3Device: 'pppoe-pd00001',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 3_000,
      ip4Table: 10_001,
      ipv4: { addr: '198.51.100.1', mask: 32 }
    }
  ],
  poolDev: { count: 1, rx: 0, tx: 0 },
  leases: [{ expires: 0, mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.20', host: 'desk' }],
  rules: [],
  rates: {}
}

function fixture(iface?: Partial<RouterModel['ifaces'][number]>): {
  engine: BindingEngine
  scripts: string[]
  model: RouterModel
} {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 1,
      nextSeq: 2,
      batches: [],
      instances: [
        {
          id: 'bind1',
          name: 'Office LAN',
          lan: 'lan',
          carrier: 'eth1',
          running: true,
          sticky: true,
          remap: true,
          createdAt: 1,
          slot: 0,
          layout: { ...STAMPED }
        }
      ],
      extraTables: [],
      stickyMap: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  const scripts: string[] = []
  harness.exec.mockImplementation(async (command, options) => {
    if (command === 'sh -s') scripts.push(options?.stdin ?? '')
    return ok()
  })
  const rules: OwrtRules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  const model = structuredClone(MODEL)
  if (iface) Object.assign(model.ifaces[0]!, iface)
  return {
    engine: new BindingEngine(harness.ctx, store, { rules: () => rules }),
    scripts,
    model
  }
}

describe('the catch-all table a router has to keep answering from', () => {
  it('carries the LAN connected route beside the blackhole', async () => {
    const run = fixture()

    await run.engine.onSample(run.model)

    const written = run.scripts.join('\n')
    // The blackhole - the reason the table exists at all.
    expect(written).toContain(
      `ip -4 route replace unreachable default table ${DEFAULT_RULES.catchAllTable}`
    )
    // And the route that keeps the router itself reachable on that LAN. The
    // network address, the l3 device, and the same table.
    expect(written).toContain(
      `ip -4 route replace 192.168.1.0/24 dev br-lan scope link table ${DEFAULT_RULES.catchAllTable}`
    )
  })

  it('writes the connected route before the rule that selects the table', async () => {
    // Order is the whole difference between a gap and no gap. Between the rule
    // appearing and the route arriving, the router would be selecting a table
    // holding only `unreachable` for its own traffic - which is the outage,
    // just briefly.
    const run = fixture()

    await run.engine.onSample(run.model)

    const written = run.scripts.join('\n')
    const route = written.indexOf('ip -4 route replace 192.168.1.0/24 dev br-lan')
    const rule = written.indexOf(
      `ip -4 rule add from 192.168.1.0/24 lookup ${DEFAULT_RULES.catchAllTable}`
    )
    expect(route).toBeGreaterThanOrEqual(0)
    expect(rule).toBeGreaterThanOrEqual(0)
    expect(route).toBeLessThan(rule)
  })

  it('still refuses to give an unassigned client a way out', async () => {
    // The property the table exists for. A default route of any kind here -
    // which is what "just make it reachable" would reach for - would send every
    // client with no WAN yet out of the router's own uplink, which is the leak
    // the blackhole prevents.
    const run = fixture()

    await run.engine.onSample(run.model)

    const written = run.scripts.join('\n')
    const table = DEFAULT_RULES.catchAllTable
    expect(written).not.toMatch(
      new RegExp(`route (replace|add) default via [^\\n]* table ${table}`)
    )
    expect(written).not.toContain(`route replace default dev`)
  })

  it('writes no connected route when the LAN has no device to name', async () => {
    // A guessed device is a route pointing at the wrong interface, which is
    // worse than the blackhole it is there to soften. The blackhole still goes
    // in, so the instance stays fail-closed either way.
    const run = fixture({ l3Device: '', device: '' })

    await run.engine.onSample(run.model)

    const written = run.scripts.join('\n')
    expect(written).toContain(
      `ip -4 route replace unreachable default table ${DEFAULT_RULES.catchAllTable}`
    )
    expect(written).not.toContain('scope link table')
  })
})
