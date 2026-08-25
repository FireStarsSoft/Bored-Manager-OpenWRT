import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'

/**
 * A module stops using its context once it has been disposed.
 *
 * The host revokes the context the moment `dispose()` returns, and everything
 * the module still has in flight lands after that: an `exec` that was already
 * on the wire, a poller tick, a debounced write. Each of those reaching `ctx`
 * afterwards is a module hitting a machine the app has stopped managing - the
 * exact failure the rule exists to prevent - and the only way to catch it is to
 * revoke, let the work land, and then look at what was touched.
 *
 * `harness.afterStopCalls` records every member touched after `revoke()`, so an
 * empty array is the whole assertion.
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
  '1',
  '===DUMP===',
  JSON.stringify({ interface: [] })
].join('\n')

const SLOW = ['===LOG===', '===UCIMAP===', '===UCIOK===', '1', '===FWZONES===', ''].join('\n')

function gate(): { held: Promise<void>; release: () => void } {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return { held, release }
}

describe('a module the host has stopped', () => {
  it('lets a sweep that was already on the wire land on nothing', async () => {
    // A fast tick awaits one `ctx.exec` that easily outlives the machine it was
    // started against. Publishing its answer afterwards would put one router's
    // numbers on a dashboard the app has moved off - and would emit, add
    // history and write host data on the way.
    const { held, release } = gate()
    const harness = moduleHarness('openwrt', () => ok(), {
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command) => {
      if (command.includes("echo '===REL==='")) return ok(PROBE)
      if (command.includes("echo '===LOG==='")) return ok(SLOW)
      if (command.includes("echo '===SYS==='")) {
        await held
        return ok(FAST)
      }
      return ok()
    })
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()
    // Start a sweep and leave it parked mid-command.
    void harness.handlers.get('sweepNow')?.()
    await settle(5)

    runtime.dispose?.()
    harness.revoke()
    release()
    await settle()

    expect(harness.afterStopCalls).toEqual([])
  })

  it('drops a poller tick that fires between dispose and the host stopping it', async () => {
    // The host stops the pollers it created, but not before the module's own
    // dispose has returned; a tick already scheduled runs in between.
    const harness = moduleHarness('openwrt', () => ok(), { config: sharedModuleConfig(null) })
    harness.exec.mockImplementation(async (command) => {
      if (command.includes("echo '===REL==='")) return ok(PROBE)
      if (command.includes("echo '===LOG==='")) return ok(SLOW)
      if (command.includes("echo '===SYS==='")) return ok(FAST)
      return ok()
    })
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    runtime.dispose?.()
    harness.revoke()
    for (const tick of harness.ticks) await tick()
    await settle()

    expect(harness.afterStopCalls).toEqual([])
  })

  it('does not go back to the router for a create that was still running', async () => {
    // The longest-lived work the module has: a create job parked on a chunk.
    // The runner abandons it on dispose rather than reloading the network,
    // registering the firewall or verifying interfaces on a machine nothing is
    // managing any more.
    const { held, release } = gate()
    const harness = moduleHarness('openwrt', () => ok(), {
      config: sharedModuleConfig({ rules: { uciChunkSize: 1, chunkDelayMs: 0 } })
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command.includes("echo '===REL==='")) return ok(PROBE)
      if (command === 'sh -s' && stdin.includes('===CARRIER===')) {
        return ok('===CARRIER===1\n===NETWORK===\n')
      }
      if (command === 'uci batch' && stdin.includes('set network.pd00002=interface')) {
        await held
      }
      if (command.startsWith('nft list ruleset')) return ok('1 1')
      return ok()
    })
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    const values = {
      name: 'Pool',
      carrier: 'eth1',
      prefix: 'pd',
      listText: ['u1,p1', 'u2,p2', 'u3,p3'].join('\n')
    }
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
    await settle(10)

    runtime.dispose?.()
    harness.revoke()
    release()
    await settle()

    expect(harness.afterStopCalls).toEqual([])
  })
})

describe('the assertion itself', () => {
  it('does catch a module that keeps using its context', () => {
    // Without this, every `afterStopCalls` assertion in the suite would be
    // comparing an empty array against an empty array and proving nothing.
    const harness: ModuleHarness = moduleHarness('openwrt', () => ok())

    harness.revoke()
    harness.ctx.emit('overview', {})
    harness.ctx.log('still here')

    expect(harness.afterStopCalls).toEqual(['emit', 'log'])
  })
})
