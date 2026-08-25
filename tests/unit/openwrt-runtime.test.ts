import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { ConfigStore } from '../../openwrt/main/config'
import type { JobsSnapshot } from '../../openwrt/main/jobs'
import { probeOpenWrt } from '../../openwrt/main/probe'
import { FastSweep } from '../../openwrt/main/service'
import { HostStore } from '../../openwrt/main/store'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'

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

/** The last jobs payload the module pushed. */
function lastJobs(harness: ModuleHarness): JobsSnapshot {
  const pushes = harness.emit.mock.calls.filter((call) => call[0] === 'jobs')
  return pushes[pushes.length - 1]?.[1] as JobsSnapshot
}

/**
 * `uci batch` reads its commands from stdin and echoes back any line it
 * rejects. For this module those lines carry PPPoE passwords, so a failure
 * fixture that returns clean stderr proves nothing: the assertions that matter
 * only bite when the fixture answers the way the real binary does.
 */
const UCI_ECHOES_A_PASSWORD =
  "uci: Parse error (invalid command) at line 4, byte 31\nset network.pd00003.password='hunter2'"

/**
 * Watch the two retained surfaces the harness does not expose - the app log and
 * the host-data document - by wrapping them on the context before `activate`.
 * `retained()` then reads all three at once, so "can a password reach anything
 * the module keeps?" is a single assertion rather than three partial ones.
 */
interface Watched {
  logged: string[]
  saved: unknown[]
}

function watch(harness: ModuleHarness): Watched {
  const seen: Watched = { logged: [], saved: [] }
  const ctx = harness.ctx as unknown as {
    log: (message: string) => void
    hostDataSet: (value: unknown) => void
  }
  const realLog = ctx.log
  const realSet = ctx.hostDataSet
  ctx.log = (message) => {
    seen.logged.push(message)
    realLog(message)
  }
  ctx.hostDataSet = (value) => {
    seen.saved.push(value)
    realSet(value)
  }
  return seen
}

/** Everything the module kept, as one searchable string. */
function retained(harness: ModuleHarness, seen: Watched): string {
  return JSON.stringify({ emitted: harness.emit.mock.calls, ...seen })
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

describe('openwrt PPPoE batch delete under a running WAN binding', () => {
  /**
   * The two automations only ever meet here. A running binding instance puts a
   * fail-closed catch-all - `ip -4 route add unreachable default` in its own
   * table - under every LAN client it manages, on purpose: a client must never
   * leak onto a WAN it was not bound to. Delete the PPPoE pool those WANs came
   * from and the catch-all is all that is left. Every bound client loses the
   * internet at once, and neither half of the module says why.
   */
  const BATCH = {
    id: 'b1',
    name: 'Pool',
    prefix: 'pd',
    carrier: 'eth1',
    createdAt: 1,
    count: 2,
    seqFrom: 1,
    seqTo: 2
  }

  const instance = (over: Partial<{ carrier: string; running: boolean }>) => ({
    id: 'i1',
    name: 'Office',
    lan: 'lan',
    carrier: 'eth1',
    running: true,
    sticky: false,
    remap: false,
    createdAt: 1,
    slot: 1,
    ...over
  })

  function deleteUnder(instances: unknown[]): ReturnType<typeof moduleHarness> {
    const harness = moduleHarness('openwrt', () => ok(''), {
      hostData: { version: 1, nextSeq: 3, batches: [BATCH], instances },
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command === 'sh -s' && stdin.startsWith('uci -q show network')) {
        return ok('network.pd00001=interface\nnetwork.pd00002=interface\nfirewall.bmwanpool=zone')
      }
      if (command.startsWith('nft list ruleset')) return ok('1 1')
      return ok('')
    })
    return harness
  }

  it('refuses while an instance on the same carrier is running, and names it', async () => {
    const harness = deleteUnder([instance({})])
    const runtime = activate(harness.ctx)

    expect(harness.handlers.get('pppoeBatchDelete')?.('b1')).toMatchObject({
      ok: false,
      error: expect.stringContaining('"Office"')
    })
    await settle(20)
    // Nothing was started, so the record is still there to delete later.
    expect(harness.handlers.get('pppoeBatches')?.()).toHaveLength(1)
    runtime.dispose?.()
  })

  it('refuses when the instance carrier is a VLAN under the pool carrier', async () => {
    // `eth1.835` lives inside `eth1`'s scope, so the pool still carries it.
    const harness = deleteUnder([instance({ carrier: 'eth1.835' })])
    const runtime = activate(harness.ctx)

    expect(harness.handlers.get('pppoeBatchDelete')?.('b1')).toMatchObject({ ok: false })
    runtime.dispose?.()
  })

  it('allows the delete once the instance is stopped', async () => {
    // Stopping an instance removes its catch-all, so there is no blackhole left
    // to fall into and no reason to stand in the way.
    const harness = deleteUnder([instance({ running: false })])
    const runtime = activate(harness.ctx)

    expect(harness.handlers.get('pppoeBatchDelete')?.('b1')).toMatchObject({ ok: true })
    await settle(40)
    expect(harness.handlers.get('pppoeBatches')?.()).toEqual([])
    runtime.dispose?.()
  })

  it('allows the delete when the running instance is on a different carrier', async () => {
    const harness = deleteUnder([instance({ carrier: 'eth2' })])
    const runtime = activate(harness.ctx)

    expect(harness.handlers.get('pppoeBatchDelete')?.('b1')).toMatchObject({ ok: true })
    await settle(40)
    expect(harness.handlers.get('pppoeBatches')?.()).toEqual([])
    runtime.dispose?.()
  })
})

describe('openwrt PPPoE action waves against a record the router only half has', () => {
  /**
   * A wave is one `sh` script. Under `set -e` the first `ifdown` on a section
   * netifd does not have stopped the script where it stood - so the healthy
   * sessions earlier in the same wave were taken down and never reached their
   * `ifup`. Redial, the action whose whole job is to bring sessions back, was
   * the one most likely to trigger it: it targets exactly the rows a partly
   * committed create leaves behind.
   */
  const BATCH = {
    id: 'b1',
    name: 'Half',
    prefix: 'pd',
    carrier: 'eth1',
    createdAt: 1,
    count: 4,
    seqFrom: 1,
    seqTo: 4
  }

  function waveHarness(): { harness: ReturnType<typeof moduleHarness>; scripts: string[] } {
    const scripts: string[] = []
    // Only the first two of the four recorded sections exist on the router.
    const dump = JSON.stringify({
      interface: [
        { interface: 'pd00001', up: false, proto: 'pppoe', device: 'pppoe-pd00001' },
        { interface: 'pd00002', up: false, proto: 'pppoe', device: 'pppoe-pd00002' }
      ]
    })
    const harness = moduleHarness('openwrt', () => ok(''), {
      hostData: { version: 1, nextSeq: 5, batches: [BATCH] },
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command.includes("echo '===REL==='")) {
        return ok(probeOutput({ ppp: ['plugin', 'kmod'] }))
      }
      if (command.includes("echo '===SYS==='")) return ok(sweepOutput(dump))
      if (command === 'sh -s' && /^(ifdown|ifup) /m.test(stdin)) {
        scripts.push(stdin)
        return ok('')
      }
      return ok('')
    })
    return { harness, scripts }
  }

  it('leaves absent sections out of the script and says so', async () => {
    const { harness, scripts } = waveHarness()
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    // One real sweep, so the model lists what the router actually has.
    expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
    await settle(20)

    expect(harness.handlers.get('pppoeBatchAction')?.('b1','redial')).toMatchObject({ ok: true })
    await settle(40)

    const script = scripts.join('\n')
    expect(script).toContain("ifdown 'pd00001'")
    expect(script).toContain("ifup 'pd00002'")
    expect(script).not.toContain('pd00003')
    expect(script).not.toContain('pd00004')
    // Best-effort, so one interface refusing to come up cannot abandon the
    // rest of the wave part-way through.
    expect(script).toContain('|| true')
    expect(script).not.toContain('set -e')

    const job = lastJobs(harness).finished[0]
    const skip = job?.items.find((item) => item.status === 'warning')
    expect(skip?.message).toContain('pd00003')
    expect(skip?.message).toContain('not on the router')
    runtime.dispose?.()
  })

  it('keeps stop strict once the absent sections are filtered out', async () => {
    const { harness, scripts } = waveHarness()
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    // One real sweep, so the model lists what the router actually has.
    expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
    await settle(20)

    expect(harness.handlers.get('pppoeBatchAction')?.('b1','stop')).toMatchObject({ ok: true })
    await settle(40)

    const script = scripts.join('\n')
    expect(script).toContain('set -e')
    expect(script).toContain("ifdown 'pd00001'")
    expect(script).not.toContain('pd00003')
    runtime.dispose?.()
  })

  it('acts on the whole selection when no sample has been read yet', async () => {
    // Failing open matters: before the first sweep the model lists nothing, and
    // filtering against it then would refuse every action on a router that is
    // merely still being read.
    const scripts: string[] = []
    const harness = moduleHarness('openwrt', () => ok(''), {
      hostData: { version: 1, nextSeq: 5, batches: [BATCH] },
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command.includes("echo '===REL==='")) {
        return ok(probeOutput({ ppp: ['plugin', 'kmod'] }))
      }
      if (command === 'sh -s' && /^(ifdown|ifup) /m.test(stdin)) {
        scripts.push(stdin)
        return ok('')
      }
      return ok('')
    })

    const runtime = activate(harness.ctx)
    expect(harness.handlers.get('pppoeBatchAction')?.('b1', 'stop')).toMatchObject({ ok: true })
    await settle(40)

    expect(scripts.join('\n')).toContain("ifdown 'pd00004'")
    runtime.dispose?.()
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
      if (command.startsWith('nft list ruleset')) return ok('1 1')
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

  it('keeps a rejected UCI line out of the failed delete job', async () => {
    // Delete never sends a password, but it shares `runUciBatch` with create -
    // so if the guard that strips UCI's output ever moves to the caller, this
    // is the second place it has to be put back.
    const { harness } = deleteHarness(['pd00001', 'pd00002'])
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command === 'sh -s' && stdin.startsWith('uci -q show network')) {
        return ok('network.pd00001=interface\nfirewall.bmwanpool=zone')
      }
      if (command === 'uci batch') return ok('', UCI_ECHOES_A_PASSWORD, 1)
      if (command.startsWith('nft list ruleset')) return ok('1 1')
      return ok('')
    })
    const seen = watch(harness)
    const runtime = activate(harness.ctx)

    harness.handlers.get('pppoeBatchDelete')?.('b1')
    await settle(40)

    const kept = retained(harness, seen)
    expect(kept).toContain('Delete UCI chunk')
    expect(kept).not.toContain('hunter2')
    expect(kept).not.toContain('Parse error')
    // The record survives a failed delete, so the user can try again.
    expect(harness.handlers.get('pppoeBatches')?.()).toHaveLength(1)
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
          // What the real binary prints: the rejected input line, verbatim.
          // The credentials arrive on stdin, so the line it echoes back is the
          // one carrying the password - which is why nothing in this module
          // may put UCI's own output into a job, an event or a log.
          return ok('', UCI_ECHOES_A_PASSWORD, 1)
        }
        return ok('')
      }
      if (command.startsWith('nft list ruleset')) return ok('1 1')
      return ok('')
    })

    const seen = watch(harness)
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

    // The failure that shrank the record is also the failure that carried a
    // password back out of the router. Nothing the module kept may contain it,
    // or UCI's diagnostic either - that string is where the password lives.
    const kept = retained(harness, seen)
    // Positive control first: without it the two assertions below would still
    // pass on an empty string and prove nothing at all.
    expect(kept).toContain('Apply PPPoE chunk 3/4')
    expect(kept).not.toContain('hunter2')
    expect(kept).not.toContain('Parse error')
    // The failure still has to be reported, just without quoting the router.
    const failed = lastJobs(harness).finished[0]?.items.find((item) => item.status === 'error')
    expect(failed?.message).toContain('UCI batch failed')
    expect(failed?.message).toContain('exit 1')
    runtime.dispose?.()
  })

  it('refuses delete and actions while the create job is still running', async () => {
    // Delete inspects the router once, at the top of its own job, and works
    // from that snapshot. Run it against a create that is on chunk 2 of 4 and
    // it removes the two sections it saw while the create writes the other
    // two - which then survive with no record covering them, dialing with
    // credentials nothing in the module can reach any more.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
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
      // Park the job on the second chunk until the assertions below have run.
      if (command === 'uci batch' && stdin.includes('set network.pd00002=interface')) {
        await held
      }
      if (command.startsWith('nft list ruleset')) return ok('1 1')
      return ok('')
    })

    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    const values = {
      name: 'InFlight',
      carrier: 'eth1',
      prefix: 'pd',
      listText: ['u1,p1', 'u2,p2', 'u3,p3', 'u4,p4'].join('\n')
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
    await settle(20)

    const [batch] = harness.handlers.get('pppoeBatches')?.() as Array<{ id: string }>
    expect(batch).toBeDefined()
    expect(harness.handlers.get('pppoeBatchDelete')?.(batch.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('still being created')
    })
    expect(harness.handlers.get('pppoeBatchAction')?.(batch.id, 'stop')).toMatchObject({
      ok: false,
      error: expect.stringContaining('still being created')
    })
    expect(harness.handlers.get('pppoeConnAction')?.(['pd00001'], 'stop')).toMatchObject({
      ok: false,
      error: expect.stringContaining('still being created')
    })

    // Once the create is finished the guard lifts and delete works normally.
    release()
    await settle(40)
    expect(harness.handlers.get('pppoeBatchDelete')?.(batch.id)).toMatchObject({ ok: true })
    runtime.dispose?.()
  })

  it('keeps the chunk that committed and then failed to reload', async () => {
    // The dangerous half of the same boundary. `uci commit network` put the
    // sections on the router; only `/etc/init.d/network reload` afterwards
    // failed. Reading "committed" off the job item status called that chunk a
    // failure and cut it out of the record - leaving live PPPoE sections, with
    // their passwords, that the module could no longer see, stop or delete.
    let reloads = 0
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
      if (command === 'uci batch') return ok('')
      if (command === '/etc/init.d/network reload') {
        reloads += 1
        // Chunk 3 of 4: committed, then netifd refused to come back.
        return reloads === 3 ? ok('', 'reload failed', 1) : ok('')
      }
      if (command.startsWith('nft list ruleset')) return ok('1 1')
      return ok('')
    })

    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    const values = {
      name: 'Reload',
      carrier: 'eth1',
      prefix: 'pd',
      listText: ['u1,p1', 'u2,p2', 'u3,p3', 'u4,p4'].join('\n')
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
    await settle(40)

    const batches = harness.handlers.get('pppoeBatches')?.() as Array<{ count: number }>
    expect(batches).toHaveLength(1)
    // Three, not two: the third chunk is on the router whatever the reload did.
    expect(batches[0].count).toBe(3)
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
      if (command.startsWith('nft list ruleset')) return ok('1 1')
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

describe('openwrt PPPoE create: the firewall zone comes first', () => {
  /**
   * The zone, its masquerading and the LAN forwarding used to be configured
   * after every chunk had run. A create that was cancelled, or that failed on
   * chunk 7 of 10, therefore left every session it had already dialed in no
   * zone at all: up, addressed, and unable to carry one client packet.
   */
  interface RunOptions {
    zoneMode?: 'wildcard' | 'networks'
    /** A `uci batch` body containing this is rejected, standing in for a bad chunk. */
    failOn?: string
  }

  function harnessFor(options: RunOptions = {}): {
    harness: ReturnType<typeof moduleHarness>
    uciBatches: string[]
    commands: string[]
  } {
    const uciBatches: string[] = []
    const commands: string[] = []
    const harness = moduleHarness('openwrt', () => ok(''), {
      config: sharedModuleConfig({
        rules: {
          uciChunkSize: 1,
          chunkDelayMs: 0,
          ...(options.zoneMode ? { zoneMode: options.zoneMode } : {})
        }
      })
    })
    harness.exec.mockImplementation(async (command, execOptions) => {
      const stdin = execOptions?.stdin ?? ''
      if (command.includes("echo '===REL==='")) {
        return ok(probeOutput({ ppp: ['plugin', 'kmod'] }))
      }
      if (command === 'sh -s' && stdin.includes('===CARRIER===')) {
        return ok('===CARRIER===1\n===NETWORK===\n')
      }
      if (command === 'uci batch') {
        uciBatches.push(stdin)
        commands.push(`uci batch ${stdin.replace(/\n/g, ' ')}`)
        if (options.failOn && stdin.includes(options.failOn)) {
          return ok('', 'uci: Invalid argument')
        }
        return ok('')
      }
      commands.push(command)
      if (command === 'ubus -S call network.interface dump') {
        return ok(
          JSON.stringify({ interface: [{ interface: 'pd00001' }, { interface: 'pd00002' }] })
        )
      }
      if (command.startsWith('nft list ruleset')) return ok('1 1')
      return ok('')
    })
    return { harness, uciBatches, commands }
  }

  async function createTwo(harness: ReturnType<typeof moduleHarness>): Promise<void> {
    const values = { name: 'Pool', carrier: 'eth1', prefix: 'pd', listText: 'u1,p1\nu2,p2' }
    const report = (await harness.handlers.get('pppoeBatchCheck')?.(values)) as {
      ok: boolean
      token?: string
    }
    expect(report.ok).toBe(true)
    await harness.handlers.get('pppoeBatchApply')?.({
      token: report.token,
      values: { ...values, listFile: '', listText: '' }
    })
    await settle(40)
  }

  const membership = (section: string): string =>
    `add_list firewall.bmwanpool.network='${section}'`

  it('installs the zone and the LAN forwarding before the first interface', async () => {
    const { harness, uciBatches } = harnessFor()
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()
    await createTwo(harness)

    const zoneAt = uciBatches.findIndex((body) => body.includes('set firewall.bmwanpool=zone'))
    const ifaceAt = uciBatches.findIndex((body) => body.includes('set network.pd00001=interface'))
    expect(zoneAt).toBe(0)
    expect(ifaceAt).toBeGreaterThan(zoneAt)
    expect(uciBatches[0]).toContain("set firewall.bmfwd.src='lan'")
    expect(uciBatches[0]).toContain("set firewall.bmfwd.dest='bmwanpool'")
    runtime.dispose?.()
  })

  it('checks nft only after the interfaces it is meant to match exist', async () => {
    // In wildcard mode the zone matches the pool with `pppoe-pd+`, which
    // matches nothing before the first interface is created. Verifying in the
    // preparation step would report every healthy create as broken.
    const { harness, commands } = harnessFor()
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()
    await createTwo(harness)

    const nftAt = commands.findIndex((command) => command.startsWith('nft list ruleset'))
    const ifaceAt = commands.findIndex((command) =>
      command.includes('set network.pd00001=interface')
    )
    expect(ifaceAt).toBeGreaterThanOrEqual(0)
    expect(nftAt).toBeGreaterThan(ifaceAt)
    runtime.dispose?.()
  })

  it('leaves the new sections out of the preparation pass in networks mode', async () => {
    // Membership is rebuilt from scratch rather than appended to, so the pass
    // that runs first must list exactly what is on the router: naming sections
    // the chunks have not created yet is how a batch created earlier would
    // lose its zone for the length of this job.
    const { harness, uciBatches } = harnessFor({ zoneMode: 'networks' })
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()
    await createTwo(harness)

    expect(uciBatches[0]).toContain('delete firewall.bmwanpool.network')
    expect(uciBatches[0]).not.toContain(membership('pd00001'))
    expect(uciBatches.some((body) => body.includes(membership('pd00001')))).toBe(true)
    expect(uciBatches.some((body) => body.includes(membership('pd00002')))).toBe(true)
    runtime.dispose?.()
  })

  it('registers the sessions that survived an aborted create in networks mode', async () => {
    const { harness, uciBatches } = harnessFor({
      zoneMode: 'networks',
      failOn: 'set network.pd00002=interface'
    })
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()
    await createTwo(harness)

    // The registration step never ran. Without the repair in the completion
    // hook, pd00001 exists, dials, and belongs to no zone.
    expect(uciBatches.some((body) => body.includes(membership('pd00001')))).toBe(true)
    expect(uciBatches.some((body) => body.includes(membership('pd00002')))).toBe(false)
    const batches = harness.handlers.get('pppoeBatches')?.() as Array<{ count: number }>
    expect(batches).toHaveLength(1)
    expect(batches[0].count).toBe(1)
    runtime.dispose?.()
  })

  it('needs no repair in wildcard mode, where the device glob already covers them', async () => {
    const { harness, uciBatches } = harnessFor({ failOn: 'set network.pd00002=interface' })
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()
    await createTwo(harness)

    expect(uciBatches[0]).toContain("add_list firewall.bmwanpool.device='pppoe-pd+'")
    expect(uciBatches.some((body) => body.includes('add_list firewall.bmwanpool.network='))).toBe(
      false
    )
    runtime.dispose?.()
  })
})
