import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'

/**
 * The whole distance between the two halves of one bug.
 *
 * The slow probe discovers what the router calls its LAN firewall zone, and the
 * PPPoE create writes a forwarding from that zone into the pool's own. Both
 * ends have tests. What has none is the single line joining them - the
 * `lanFirewallZone` adapter in `runtime/container.ts` - and the fallback under
 * it is `|| 'lan'`, so cutting the thread produces no error anywhere: every
 * session in the pool dials, comes up, and carries no client traffic at all,
 * because the forwarding was installed from a zone that does not exist.
 *
 * These drive the module end to end for that reason. A router whose LAN zone is
 * called `lan` cannot tell the two states apart, so the fixture calls it
 * something else.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

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
  '/sbin/logread',
  '/sbin/netifd',
  '/usr/sbin/nft',
  '/usr/sbin/pppd',
  '===PPP===',
  'plugin',
  'kmod',
  '===PKG===',
  'apkdb',
  '===DONE==='
].join('\n')

const FAST = [
  '===SYS===',
  JSON.stringify({ uptime: 4_000, load: [0, 0, 0], memory: { total: 1, free: 1 } }),
  '===DEV===',
  'Inter-|   Receive                    |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes',
  '  eth1: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0',
  '===POOL=== 0 0 0',
  '===LEASES===',
  '===RULES===',
  '===RULESOK===',
  '1'
].join('\n')

/** A router whose LAN zone is called `trusted`, which OpenWRT permits. */
const SLOW = [
  '===LOG===',
  '===UCIMAP===',
  '===UCIOK===',
  '1',
  '===FWZONES===',
  'firewall.lz=zone',
  "firewall.lz.name='trusted'",
  "firewall.lz.network='lan'"
].join('\n')

interface Router {
  harness: ModuleHarness
  /** Every `uci batch` body the module sent, in order. */
  uciBatches: string[]
}

function router(): Router {
  const uciBatches: string[] = []
  const harness = moduleHarness('openwrt', () => ok(), {
    config: sharedModuleConfig({ rules: { chunkDelayMs: 0 } })
  })
  harness.exec.mockImplementation(async (command, options) => {
    const stdin = options?.stdin ?? ''
    if (command.includes("echo '===REL==='")) return ok(PROBE)
    if (command.includes("echo '===LOG==='")) return ok(SLOW)
    if (command.includes("echo '===SYS==='")) return ok(FAST)
    if (command === 'sh -s' && stdin.includes('===CARRIER===')) {
      return ok('===CARRIER===1\n===NETWORK===\n')
    }
    if (command === 'uci batch') {
      uciBatches.push(stdin)
      return ok()
    }
    if (command === 'ubus -S call network.interface dump') {
      return ok(JSON.stringify({ interface: [{ interface: 'pd00001' }, { interface: 'pd00002' }] }))
    }
    if (command.startsWith('nft list ruleset')) return ok('1 1')
    return ok()
  })
  return { harness, uciBatches }
}

async function createPool(harness: ModuleHarness): Promise<ModuleCheckReport> {
  const values = { name: 'Pool', carrier: 'eth1', prefix: 'pd', listText: 'u1,p1\nu2,p2' }
  const report = (await harness.handlers.get('pppoeBatchCheck')?.(values)) as ModuleCheckReport
  expect(report.ok).toBe(true)
  if (!report.ok) return report
  expect(
    await harness.handlers.get('pppoeBatchApply')?.({
      token: report.token,
      values: { ...values, listFile: '', listText: '' }
    })
  ).toMatchObject({ ok: true })
  await settle()
  return report
}

describe('the LAN firewall zone the slow probe discovered', () => {
  it('is the zone the PPPoE create forwards from', async () => {
    const { harness, uciBatches } = router()
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()
    // One real sweep, so the slow probe has read /etc/config/firewall.
    expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
    await settle()

    await createPool(harness)

    // The zone preparation is the first `uci batch` a create sends, and this is
    // the line that decides whether the pool carries traffic.
    expect(uciBatches[0]).toContain("set firewall.bmfwd.src='trusted'")
    expect(uciBatches.join('\n')).not.toContain("set firewall.bmfwd.src='lan'")
    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })

  it('is named in the check report before anything is written', async () => {
    // The second reader of the same adapter, and the only place the user is
    // told which zone the job is about to forward from.
    const { harness } = router()
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()
    expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
    await settle()

    const values = { name: 'Pool', carrier: 'eth1', prefix: 'pd', listText: 'u1,p1\nu2,p2' }
    const report = (await harness.handlers.get('pppoeBatchCheck')?.(values)) as ModuleCheckReport
    const text = report.findings.map((finding) => `${finding.label} ${finding.detail ?? ''}`).join('\n')

    expect(text).toContain('firewall zone trusted')
    expect(text).toContain('trusted → bmwanpool')
    runtime.dispose?.()
  })

  it('is only assumed to be lan when no sweep has read one', async () => {
    // The other side of the fallback, so the assertion above is a statement
    // about what was discovered rather than about the default.
    const { harness, uciBatches } = router()
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    await createPool(harness)

    expect(uciBatches[0]).toContain("set firewall.bmfwd.src='lan'")
    runtime.dispose?.()
  })
})
