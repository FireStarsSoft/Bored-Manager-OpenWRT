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
 * router that is not a router, UCI sections a failed create never made.
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

function probeOutput(options: { ppp?: string[]; tools?: string[]; openwrt?: boolean } = {}): string {
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
    ...(options.ppp ?? [])
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
    expect(command).not.toContain('opkg')
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

describe('openwrt PPPoE batch delete after a create that only partly committed', () => {
  const BATCH = {
    id: 'b1',
    name: 'Partial',
    prefix: 'pd',
    carrier: 'eth1',
    createdAt: 1,
    count: 4,
    seqFrom: 1,
    seqTo: 4
  }

  function deleteHarness(present: string[]): {
    harness: ReturnType<typeof moduleHarness>
    uciBatches: string[]
    live: Set<string>
  } {
    const live = new Set(present)
    const uciBatches: string[] = []
    const harness = moduleHarness('openwrt', () => ok(''), {
      hostData: { version: 1, nextSeq: 5, batches: [BATCH] },
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command === 'sh -s' && stdin.startsWith('uci -q show network')) {
        return ok(
          [
            ...[...live].map((name) => `network.${name}=interface`),
            'firewall.bmwanpool=zone'
          ].join('\n')
        )
      }
      if (command === 'uci batch') {
        uciBatches.push(stdin)
        const targets = [...stdin.matchAll(/^delete network\.(\S+)$/gm)].map((match) => match[1])
        // The router keeps going and still exits 0, but prints one error line
        // per section that was not there - which is what used to fail the job.
        const missing = targets.filter((name) => !live.has(name))
        for (const name of targets) live.delete(name)
        return ok('', missing.map(() => 'uci: Entry not found').join('\n'))
      }
      if (command.startsWith('nft list ruleset')) return ok('1')
      return ok('')
    })
    return { harness, uciBatches, live }
  }

  it('removes a record whose interfaces were never all created', async () => {
    // The record is written before the first chunk runs, so a create that was
    // cancelled or failed leaves it claiming sections UCI never got. Deleting
    // them printed `uci: Entry not found`, runUciBatch failed the chunk, the
    // job aborted, and the batch could never be removed on any retry.
    const { harness, uciBatches } = deleteHarness(['pd00001', 'pd00002'])
    const runtime = activate(harness.ctx)

    const started = harness.handlers.get('pppoeBatchDelete')?.('b1') as { ok: boolean }
    expect(started.ok).toBe(true)
    await settle(40)

    expect(harness.handlers.get('pppoeBatches')?.()).toEqual([])
    const deletes = uciBatches.filter((body) => body.includes('delete network.pd'))
    expect(deletes.join('\n')).toContain('delete network.pd00001')
    expect(deletes.join('\n')).toContain('delete network.pd00002')
    expect(deletes.join('\n')).not.toContain('delete network.pd00003')
    runtime.dispose?.()
  })

  it('removes a record whose interfaces are all gone without touching UCI', async () => {
    const { harness, uciBatches } = deleteHarness([])
    const runtime = activate(harness.ctx)

    harness.handlers.get('pppoeBatchDelete')?.('b1')
    await settle(40)

    expect(harness.handlers.get('pppoeBatches')?.()).toEqual([])
    expect(uciBatches.filter((body) => body.includes('delete network.pd'))).toEqual([])
    runtime.dispose?.()
  })
})

describe('openwrt PPPoE batch create that aborts part-way', () => {
  it('shrinks the record to the chunks that reached the router', async () => {
    // The record is written for the whole requested range before the first
    // chunk runs. When a chunk fails the rest are skipped, so the record went
    // on claiming interfaces UCI never got: every phantom row read as an
    // error on the dashboard for good, and Delete had phantom sections to
    // trip over. One session per chunk here makes the boundary exact.
    const uciBatches: string[] = []
    const harness = moduleHarness('openwrt', () => ok(''), {
      config: sharedModuleConfig({ rules: { uciChunkSize: 1, chunkDelayMs: 0 } })
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command.includes("echo '===REL==='")) {
        return ok(probeOutput({ ppp: ['plugin', 'kmod'] }))
      }
      if (command === 'sh -s' && stdin.includes('===CARRIER===')) {
        return ok('===CARRIER===1\n===NETWORK===\n')
      }
      if (command === 'uci batch') {
        uciBatches.push(stdin)
        // The third session is the one that fails; everything before it has
        // already been committed on the router.
        if (stdin.includes('set network.pd00003=interface')) {
          return ok('', 'uci: Invalid argument')
        }
        return ok('')
      }
      if (command.startsWith('nft list ruleset')) return ok('1')
      return ok('')
    })

    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    const values = {
      name: 'Partial',
      carrier: 'eth1',
      prefix: 'pd',
      listText: ['u1,p1', 'u2,p2', 'u3,p3', 'u4,p4'].join('\n')
    }
    const report = (await harness.handlers.get('pppoeBatchCheck')?.(values)) as {
      ok: boolean
      token?: string
    }
    expect(report.ok).toBe(true)

    const applied = (await harness.handlers.get('pppoeBatchApply')?.({
      token: report.token,
      // The account list is `omitOnApply`, so the renderer blanks it before
      // sending the token back and the module signs the blanked form.
      values: { ...values, listFile: '', listText: '' }
    })) as { ok: boolean; error?: string }
    expect(applied).toMatchObject({ ok: true })
    await settle(40)

    const batches = harness.handlers.get('pppoeBatches')?.() as Array<{ count: number }>
    expect(batches).toHaveLength(1)
    expect(batches[0].count).toBe(2)
    expect(uciBatches.some((body) => body.includes('set network.pd00004=interface'))).toBe(false)
    runtime.dispose?.()
  })

  it('drops the record entirely when not one chunk reached the router', async () => {
    const harness = moduleHarness('openwrt', () => ok(''), {
      config: sharedModuleConfig({ rules: { uciChunkSize: 1, chunkDelayMs: 0 } })
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command.includes("echo '===REL==='")) {
        return ok(probeOutput({ ppp: ['plugin', 'kmod'] }))
      }
      if (command === 'sh -s' && stdin.includes('===CARRIER===')) {
        return ok('===CARRIER===1\n===NETWORK===\n')
      }
      if (command === 'uci batch') return ok('', 'uci: Invalid argument')
      if (command.startsWith('nft list ruleset')) return ok('1')
      return ok('')
    })

    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    const values = { name: 'Nothing', carrier: 'eth1', prefix: 'pd', listText: 'u1,p1\nu2,p2' }
    const report = (await harness.handlers.get('pppoeBatchCheck')?.(values)) as {
      ok: boolean
      token?: string
    }
    await harness.handlers.get('pppoeBatchApply')?.({
      token: report.token,
      values: { ...values, listFile: '', listText: '' }
    })
    await settle(40)

    expect(harness.handlers.get('pppoeBatches')?.()).toEqual([])
    runtime.dispose?.()
  })
})
