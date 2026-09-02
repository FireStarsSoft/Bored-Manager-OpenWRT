import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { ConfigStore } from '../../openwrt/main/config'
import { FastSweep } from '../../openwrt/main/service'
import { HostStore } from '../../openwrt/main/store'
import type { Lease } from '../../openwrt/main/types'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * Whose clock a DHCP lease expiry is measured against.
 *
 * `dnsmasq.leases` stores an absolute epoch on the *router's* clock, and both
 * places that read it here compare against `Date.now()` on the app's. The
 * module rebases them using the `localtime` that `ubus call system info`
 * reports - except that a router which has not reached NTP yet does not report
 * one, which is exactly the router most likely to be freshly booted and
 * handing out leases. The raw router epoch was then passed on as though it
 * were ours: a router sitting at 1970 made every lease read "expired", the
 * lease table said so, and every device on it read as a client with no lease.
 *
 * There is no offset to recover in that case, so nothing pretends there is: the
 * flag says the expiry is unreadable rather than passed, and `queries.ts` and
 * `service/overview.ts` render the device table from it.
 *
 * The half of this that used to live below - what the module's own binding
 * planner made of an undatable lease - went to the router with everything else
 * in 3.4.0. `bm-wanbind` reads /tmp/dhcp.leases on the clock that wrote it, so
 * there is no rebasing to get wrong on that side and nothing left here to
 * assert about it.
 */

const ok = (stdout: string): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

const DUMP = JSON.stringify({
  interface: [{ interface: 'pd00001', up: true, proto: 'pppoe', device: 'pppoe-pd00001' }]
})

/** One sweep's worth of output, with or without the router saying what time it is. */
function sweepOutput(options: { localtime?: number; leaseExpires: number }): string {
  const sys: Record<string, unknown> = {
    uptime: 4_000,
    load: [0, 0, 0],
    memory: { total: 1, free: 1 }
  }
  if (options.localtime != null) sys.localtime = options.localtime
  return [
    '===SYS===',
    JSON.stringify(sys),
    '===DEV===',
    'Inter-|   Receive                    |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes',
    '  eth1: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0',
    '===POOL=== 0 0 0',
    '===LEASES===',
    `${options.leaseExpires} 00:11:22:33:44:55 192.168.1.50 laptop 01:00:11:22:33:44:55`,
    '===RULES===',
    '===RULESOK===',
    '1',
    '===DUMP===',
    DUMP
  ].join('\n')
}

async function sweepLeases(options: { localtime?: number; leaseExpires: number }): Promise<Lease[]> {
  const harness = moduleHarness('openwrt', () => ok(sweepOutput(options)), {
    config: sharedModuleConfig(null)
  })
  const config = new ConfigStore(harness.ctx)
  const store = new HostStore(harness.ctx, () => config.effectiveRules())
  const sweep = new FastSweep(harness.ctx, config, store)
  await sweep.run()
  return sweep.latest?.leases ?? []
}

describe('a DHCP lease whose expiry is on the router clock', () => {
  it('is rebased onto ours when the router says what time it thinks it is', async () => {
    const routerNow = 1_700_000_000
    const before = Math.floor(Date.now() / 1_000)

    const [lease] = await sweepLeases({ localtime: routerNow, leaseExpires: routerNow + 3_600 })

    expect(lease.expiresUnknown).toBeUndefined()
    expect(lease.expires).toBeGreaterThanOrEqual(before + 3_600)
    expect(lease.expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000) + 3_600)
  })

  /**
   * The regression: 4000 is the epoch a router that booted 4000 seconds ago
   * and never reached NTP reports, so the lease "expired" in January 1970.
   */
  it('is kept and marked unknown when the router does not, rather than read as expired', async () => {
    const [lease] = await sweepLeases({ leaseExpires: 4_000 })

    expect(lease).toBeDefined()
    expect(lease.expiresUnknown).toBe(true)
    expect(lease.mac).toBe('00:11:22:33:44:55')
  })

  it('still drops a lease that really has expired, when the clocks are comparable', async () => {
    const routerNow = 1_700_000_000

    const leases = await sweepLeases({ localtime: routerNow, leaseExpires: routerNow - 1 })

    expect(leases).toEqual([])
  })

  /** A static lease is `0` on any clock, and was never the problem. */
  it('leaves an infinite lease alone either way', async () => {
    const withClock = await sweepLeases({ localtime: 1_700_000_000, leaseExpires: 0 })
    const without = await sweepLeases({ leaseExpires: 0 })

    expect(withClock[0]).toMatchObject({ expires: 0 })
    expect(withClock[0].expiresUnknown).toBeUndefined()
    expect(without[0]).toMatchObject({ expires: 0 })
    expect(without[0].expiresUnknown).toBeUndefined()
  })
})
