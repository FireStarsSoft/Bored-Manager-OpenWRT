import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { ConfigStore } from '../../openwrt/main/config'
import { probeOpenWrt } from '../../openwrt/main/probe'
import { FastSweep } from '../../openwrt/main/service'
import { HostStore } from '../../openwrt/main/store'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * These drive the module through its real context rather than calling parsers,
 * because every bug here is about what the module does with an answer it did
 * not expect: a package manager it has never heard of, a truncated command, a
 * router that is not a router.
 *
 * The PPPoE flows that used to live below - chunked creates that abort part
 * way, delete waves against half-written records - are gone with the SSH path
 * itself: pools are owned by bm-pppoe-pool on the router, whose lifecycle is
 * proved by the ucode probes in packages/ci, and the module's half of the
 * contract is proved in openwrt-pppoe-guards.test.ts.
 */

const ok = (stdout: string, stderr = '', code = 0): ModuleExecResult => ({
  code,
  stdout,
  stderr
})

/** Lets pending exec promises and the job runner settle between assertions. */
const settle = async (rounds = 10): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const ROUTER_TOOLS = [
  '/sbin/ubus',
  '/sbin/uci',
  '/sbin/ip',
  '/sbin/fw4',
  '/sbin/logread',
  '/usr/sbin/nft',
  '/sbin/netifd',
  '/usr/sbin/pppd'
]

function probeOutput(
  options: { ppp?: string[]; tools?: string[]; openwrt?: boolean; pkg?: string[] } = {}
): string {
  const openwrt = options.openwrt ?? true
  return [
    '===REL===',
    ...(openwrt ? ["DISTRIB_ID='OpenWrt'", "DISTRIB_RELEASE='25.12.0'"] : []),
    '===BOARD===',
    openwrt
      ? JSON.stringify({
          model: 'Test Router',
          release: { distribution: 'OpenWrt', version: '25.12.0' }
        })
      : '',
    '===TOOLS===',
    ...(options.tools ?? ROUTER_TOOLS),
    '===PPP===',
    ...(options.ppp ?? []),
    '===PKG===',
    ...(options.pkg ?? ['apkdb']),
    // The sentinel the probe requires before it believes any of the above.
    '===DONE==='
  ].join('\n')
}

describe('openwrt capability probe: PPPoE support on an apk release', () => {
  it('reads PPPoE support off installed files, so no package manager has to be present', async () => {
    // OpenWRT 25.12 and every main snapshot since late 2024 ship apk instead of
    // opkg. Gated on `opkg list-installed`, the probe reported no PPPoE support
    // on a router that had ppp, ppp-mod-pppoe and kmod-pppoe installed, and
    // PPPoE Dialer -> Check answered "install packages that are already there".
    const harness = moduleHarness('openwrt', () => ok(probeOutput({ ppp: ['plugin', 'kmod'] })))

    const capabilities = await probeOpenWrt(harness.ctx)

    expect(capabilities.hasPppoe).toBe(true)
    expect(capabilities.problem).toBeNull()
    const command = harness.exec.mock.calls[0]?.[0] ?? ''
    // The probe does look for a package manager now - to offer an install, not
    // to decide what is installed. Nothing here asks a manager what it has.
    expect(command).not.toContain('list-installed')
    expect(command).not.toContain('apk info')
    expect(command).toContain('/usr/lib/pppd/*/*pppoe.so')
    // A pppoe driver compiled into the kernel is in no package list at all.
    expect(command).toContain('modules.builtin')
  })

  it('still reports missing PPPoE support when neither the plugin nor the driver is there', async () => {
    const harness = moduleHarness('openwrt', () => ok(probeOutput({ ppp: [] })))

    const capabilities = await probeOpenWrt(harness.ctx)

    expect(capabilities.hasPppoe).toBe(false)
    expect(capabilities.problem).toBeNull()
  })

  it('needs both the pppd plugin and kernel support, not either one', async () => {
    const plugin = moduleHarness('openwrt', () => ok(probeOutput({ ppp: ['plugin'] })))
    const kmod = moduleHarness('openwrt', () => ok(probeOutput({ ppp: ['kmod'] })))

    expect((await probeOpenWrt(plugin.ctx)).hasPppoe).toBe(false)
    expect((await probeOpenWrt(kmod.ctx)).hasPppoe).toBe(false)
  })

  it('marks an answer it never got as unprobed so the caller can retry it', async () => {
    const answered = moduleHarness('openwrt', () => ok(probeOutput({ openwrt: false })))
    const silent = moduleHarness('openwrt', () => ok('', 'ssh: connect failed', 255))

    const verdict = await probeOpenWrt(answered.ctx)
    const nothing = await probeOpenWrt(silent.ctx)

    expect(verdict.probed).toBe(true)
    expect(verdict.problem).toContain('not an OpenWRT router')
    expect(nothing.probed).toBe(false)
    expect(nothing.problem).toBeTruthy()
  })
})

describe('openwrt poller startup on a machine that is not a router', () => {
  it('probes once however many times applyPollers is called', async () => {
    // applyPollers() runs on connect, on every settings change, on every tab
    // and machine switch in every browser, and on every module toggle. With no
    // key recorded for a machine that answered "not a router", each of those
    // paid for another PROBE_COMMAND over SSH, forever.
    const harness = moduleHarness('openwrt', () => ok(probeOutput({ openwrt: false })), {
      config: sharedModuleConfig(null)
    })
    const runtime = activate(harness.ctx)

    runtime.applyPollers?.()
    await settle()
    runtime.applyPollers?.()
    runtime.applyPollers?.()
    await settle()

    expect(harness.exec).toHaveBeenCalledTimes(1)
    expect(harness.pollers.every((poller) => poller.start.mock.calls.length === 0)).toBe(true)
    runtime.dispose?.()
  })

  it('keeps retrying when the probe itself failed rather than the router answering', async () => {
    // An SSH hiccup looks exactly like "not an OpenWRT router" from here, and
    // latching that verdict would leave the module dark until a reconnect.
    const harness = moduleHarness('openwrt', () => ok('', 'ssh: connection closed', 255), {
      config: sharedModuleConfig(null)
    })
    const runtime = activate(harness.ctx)

    runtime.applyPollers?.()
    await settle()
    runtime.applyPollers?.()
    await settle()

    expect(harness.exec).toHaveBeenCalledTimes(2)
    runtime.dispose?.()
  })
})

function sweepOutput(dump: string | null): string {
  return [
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
    ...(dump === null ? [] : ['===DUMP===', dump])
  ].join('\n')
}

const GOOD_DUMP = JSON.stringify({
  interface: [
    { interface: 'pd00001', up: true, proto: 'pppoe', device: 'pppoe-pd00001' }
  ]
})

function newSweep(
  answer: (command: string) => ModuleExecResult
): { sweep: FastSweep; harness: ReturnType<typeof moduleHarness> } {
  const harness = moduleHarness('openwrt', answer, { config: sharedModuleConfig(null) })
  const config = new ConfigStore(harness.ctx)
  const store = new HostStore(harness.ctx, () => config.effectiveRules())
  return { sweep: new FastSweep(harness.ctx, config, store), harness }
}

describe('openwrt fast sweep against output the executor could not carry', () => {
  it('treats a truncated sweep as a failure instead of parsing what survived', async () => {
    // Past roughly ten thousand interfaces the combined output crosses the
    // executor's cap: stdout is cut and the run comes back 125/[overflow]. The
    // tail sections are simply gone, so parsing it read as "ip rule failed"
    // plus an unparseable dump on every single tick, with nothing logged.
    const { sweep, harness } = newSweep(() =>
      ok(sweepOutput(GOOD_DUMP).slice(0, 120), '[overflow] output limit reached', 125)
    )

    await sweep.run()

    expect(sweep.latest).toBeNull()
    expect(harness.emit).not.toHaveBeenCalled()
  })

  it('drops the section that overflowed rather than asking for it again forever', async () => {
    // The dump is the only section that grows with the router; the others are
    // aggregated or filtered router-side. Without a back-off every following
    // tick asked for it again and overflowed again, so nothing ever got
    // through - which is why the message used to tell the user to dismantle a
    // pool that works.
    const commands: string[] = []
    const { sweep, harness } = newSweep((command) => {
      commands.push(command)
      return command.includes('network.interface dump')
        ? ok(sweepOutput(GOOD_DUMP).slice(0, 120), '[overflow] output limit reached', 125)
        : ok(sweepOutput(null))
    })

    for (let tick = 0; tick < 3; tick++) await sweep.run()

    expect(commands.filter((command) => command.includes('network.interface dump'))).toHaveLength(1)
    // The cheap sections landed on the ticks that followed, so the dashboard
    // keeps moving on the last interface list it could read.
    expect(sweep.latest).not.toBeNull()
    expect(harness.emit.mock.calls.some((call) => call[0] === 'overview')).toBe(true)
  })

  it('backs off instead of asking for an unparseable interface dump every tick', async () => {
    const commands: string[] = []
    const { sweep } = newSweep((command) => {
      commands.push(command)
      // Truncated JSON: exactly what a dump past ubus's own message limit
      // looks like by the time it reaches the module.
      return ok(sweepOutput('{"interface":[{"interface":"pd0'))
    })

    for (let tick = 0; tick < 6; tick++) await sweep.run()

    const asked = commands.filter((command) => command.includes('network.interface dump'))
    expect(commands).toHaveLength(6)
    // Once on the first tick, then not again until the back-off expires.
    expect(asked).toHaveLength(2)
    expect(commands[0]).toContain('network.interface dump')
    expect(commands[1]).not.toContain('network.interface dump')
    expect(commands[5]).toContain('network.interface dump')
  })

  it('goes back to the normal cadence once a dump parses again', async () => {
    let dump = '{"interface":[{"interface":"pd0'
    const commands: string[] = []
    const { sweep } = newSweep((command) => {
      commands.push(command)
      return ok(sweepOutput(dump))
    })

    await sweep.run()
    dump = GOOD_DUMP
    // An explicit request - a mutation, a reboot, a manual Sweep - outranks the
    // back-off, so the recovery does not have to wait it out.
    sweep.forceDumpNextTick()
    await sweep.run()

    expect(commands[1]).toContain('network.interface dump')
    expect(sweep.latest?.ifaces.map((iface) => iface.name)).toEqual(['pd00001'])
  })
})
