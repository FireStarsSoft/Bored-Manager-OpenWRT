import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import type { BindingSnapshot } from '../../openwrt/main/wanbind'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import { AGENT_INFO, BINDING_AGENT_INFO, isProbeCommand, routerProbeOutput } from '../helpers/router'
import {
  assignment,
  fakeWanbind,
  instanceConfig,
  instanceState,
  waiting,
  type WanbindDaemon
} from '../helpers/wanbind'

/**
 * Which half binds, and the answer that stopped being a question in 3.4.0.
 *
 * There used to be two possible writers of one ip rule priority band: this
 * module over SSH, and `bm-wanbind` over netlink. The rule was that they must
 * never both run, and the rule was not enough - the daemon deletes every rule in
 * its band that no section of its own asks for, this module wrote rules there
 * and never wrote the sections, and on a real router that came to thirty-four
 * rules removed every thirty seconds and written back nine tenths of a second
 * later, for ever. Every surface was green throughout, because each half was
 * doing exactly what it had been told.
 *
 * So there is one writer now and it is the router. The whole of the instance
 * half is `ubus -S call bm.wanbind <verb>` over the connection this module
 * already has, and the cases below are about the boundary holding when the
 * daemon answers, when it refuses, when it fails and - the one that used to say
 * the opposite - when there is no daemon on the router at all.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** The id the daemon answers to, which is the only id this side has. */
const SECTION = 'bmi_office'
const LAPTOP = 'aa:bb:cc:dd:ee:01'

/**
 * One instance with a client seated and another queued behind it.
 *
 * `waiting` is a round trip the tick skips when nobody is unseated, so the
 * counters have to say somebody is - otherwise the first case below would be
 * asserting that a call which was never worth making was not made.
 */
function office(): WanbindDaemon {
  return fakeWanbind({
    configured: [instanceConfig({ id: SECTION, name: 'Office LAN' })],
    instances: [instanceState({ id: SECTION, bound: 1, devices: 2, waiting: 1 })],
    assignments: [assignment({ instance: SECTION, mac: LAPTOP })],
    waiting: [waiting({ instance: SECTION })]
  })
}

/**
 * One LAN with an address, one WAN with a table, and two leases on it.
 *
 * The `===RULESOK===` sentinel has to say 1: without it the sweep reads as "the
 * router would not answer about its rules" and no model is produced at all, so
 * half the surfaces below would report a router this module never saw and every
 * assertion would pass for the wrong reason.
 */
function sweepAnswer(): ModuleExecResult {
  return ok(
    [
      '===SYS===',
      JSON.stringify({ uptime: 3600, load: [0, 0, 0], memory: { total: 1, free: 1 } }),
      '===DEV===',
      '===POOL=== 0 0 0',
      '===LEASES===',
      '1900000000 aa:bb:cc:dd:ee:01 10.0.0.11 laptop *',
      '1900000000 aa:bb:cc:dd:ee:02 10.0.0.12 phone *',
      '===RULES===',
      '===RULESOK===',
      '1',
      '===DUMP===',
      JSON.stringify({
        interface: [
          {
            interface: 'lan',
            proto: 'static',
            device: 'br-lan',
            l3_device: 'br-lan',
            up: true,
            'ipv4-address': [{ address: '10.0.0.1', mask: 24 }],
            uptime: 3600
          },
          {
            interface: 'wan1',
            proto: 'pppoe',
            device: 'eth1',
            l3_device: 'pppoe-wan1',
            up: true,
            'ipv4-address': [{ address: '203.0.113.5', mask: 32 }],
            uptime: 3600,
            ip4table: 101
          }
        ]
      })
    ].join('\n')
  )
}

interface Router {
  harness: ModuleHarness
  daemon: WanbindDaemon
  call(method: string, ...args: unknown[]): Promise<unknown>
  /** Run one fast sweep. A poller does not tick on its own in a test. */
  sweep(): Promise<void>
  commands(): string[]
  /** A rule write would run as one `sh -s` script, so the verbs are on stdin. */
  stdins(): string[]
  snapshot(): BindingSnapshot | undefined
  dispose(): void
}

/** The whole module over a faked `bm.wanbind`, the way the app runs it. */
async function router(
  options: {
    /** Omitted means packages 2.4.0; `AGENT_INFO` is the agent with no daemon. */
    agent?: Record<string, unknown>
    daemon?: WanbindDaemon
  } = {}
): Promise<Router> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: null,
    config: sharedModuleConfig(null)
  })
  const daemon = options.daemon ?? office()

  harness.exec.mockImplementation(async (command) => {
    if (isProbeCommand(command)) {
      return ok(routerProbeOutput({ agent: options.agent ?? BINDING_AGENT_INFO }))
    }
    const answered = daemon.answer(command)
    if (answered) return answered
    if (command.includes("echo '===SYS==='")) return sweepAnswer()
    return ok()
  })

  const runtime = activate(harness.ctx)
  runtime.applyPollers?.()
  await settle()

  return {
    harness,
    daemon,
    call: async (method, ...args) => harness.handlers.get(method)?.(...args),
    sweep: async () => {
      for (const tick of harness.ticks) await tick()
      await settle(20)
    },
    commands: () => harness.exec.mock.calls.map((call) => String(call[0])),
    stdins: () =>
      harness.exec.mock.calls.map((call) => String((call[1] as { stdin?: string })?.stdin ?? '')),
    snapshot: () => {
      const pushed = harness.emit.mock.calls.filter((call) => call[0] === 'binding')
      return pushed.at(-1)?.[1] as BindingSnapshot | undefined
    },
    dispose: () => runtime.dispose?.()
  }
}

/**
 * Nothing anywhere in this module reached the kernel's rule table.
 *
 * Both halves of every call are searched, because a rule write ran as one
 * `sh -s` script with its verbs on stdin - a check that read the command lines
 * alone would have called the very fault this file exists about clean.
 */
function wroteNoRule(owrt: Router): boolean {
  const everything = [...owrt.commands(), ...owrt.stdins()].join('\n')
  return !everything.includes('ip -4 rule add') && !everything.includes('ip -4 rule del')
}

describe('the router holds the instances and this module reads them', () => {
  it('asks the daemon for the seats and the queue, and writes no ip rule at all', async () => {
    const owrt = await router()
    await owrt.sweep()

    expect(owrt.daemon.count('info')).toBeGreaterThan(0)
    expect(owrt.daemon.count('assignments')).toBeGreaterThan(0)
    expect(owrt.daemon.count('waiting')).toBeGreaterThan(0)
    // The whole point. Two writers in one priority band is the failure this
    // boundary exists to make impossible, so nothing may reach the kernel from
    // here - not an add, not a delete, not the catch-all.
    expect(wroteNoRule(owrt)).toBe(true)
    owrt.dispose()
  })

  it('does not fall back to writing rules when a call fails', async () => {
    const daemon = office()
    daemon.on('assignments', () => ok('', 'Command failed: Not found', 1))
    const owrt = await router({ daemon })
    await owrt.sweep()

    // A router that would not answer is rows one tick stale, which the snapshot
    // says. It is not a reason to start planning against it.
    expect(wroteNoRule(owrt)).toBe(true)
    owrt.dispose()
  })

  it('writes nothing at all on a router with the agent but no binding daemon', async () => {
    // The inverted case, and the single most valuable line in this file. It
    // used to assert the opposite - "still plans rules itself when the router
    // has no binding package" - and that fall back is what put thirty-four
    // rules into a band the daemon sweeps. There is deliberately no SSH half
    // left to fall back to: no daemon means every binding surface says so and
    // does nothing, and anybody tempted to restore the fall back should read
    // this case first.
    const owrt = await router({ agent: AGENT_INFO })
    await owrt.sweep()

    await owrt.call('bindingStop', SECTION)
    await settle(40)

    expect(wroteNoRule(owrt)).toBe(true)
    expect(owrt.commands().join('\n')).not.toContain('ubus -S call bm.wanbind')
    expect(owrt.commands()).not.toContain('uci batch')
    // And it says which of the three reasons it is, in the requirement's own
    // words, because an empty table on a router with no daemon and one on a
    // router with no instances are otherwise the same picture.
    expect(owrt.snapshot()?.daemon).toMatchObject({ ready: false })
    expect(owrt.snapshot()?.daemon.problem).toContain('This router has the agent but not bm-wanbind')
    owrt.dispose()
  })
})

describe('the three device actions, when the router holds the assignment', () => {
  it('sends Unassign, Reassign and Pin to the daemon rather than planning them', async () => {
    const owrt = await router()
    await owrt.sweep()

    const unassign = (await owrt.call('bindingUnassign', SECTION, LAPTOP)) as OkResult
    expect(unassign.ok).toBe(true)
    await settle(20)

    await owrt.call('bindingReassign', SECTION, LAPTOP)
    await settle(20)
    await owrt.call('bindingPin', SECTION, LAPTOP, 'wan1')
    await settle(20)

    expect(owrt.daemon.payloads('unassign')).toEqual([{ instance: SECTION, mac: LAPTOP }])
    expect(owrt.daemon.payloads('reassign')).toEqual([{ instance: SECTION, mac: LAPTOP }])
    expect(owrt.daemon.payloads('pin')).toEqual([
      { instance: SECTION, mac: LAPTOP, wan: 'wan1' }
    ])
    // And none of them wrote a rule. The router did that, or did not.
    expect(wroteNoRule(owrt)).toBe(true)
    owrt.dispose()
  })

  it('files the sentence the router refused with, rather than one of its own', async () => {
    const daemon = office()
    daemon.on('unassign', () => ({
      ok: false,
      reason: 'no client on this LAN has that MAC address'
    }))
    const owrt = await router({ daemon })
    await owrt.sweep()

    await owrt.call('bindingUnassign', SECTION, 'aa:bb:cc:dd:ee:09')
    await settle(20)

    const events = owrt.harness.emit.mock.calls
      .filter((call) => call[0] === 'jobs')
      .map((call) => JSON.stringify(call[1]))
      .join('\n')
    expect(events).toContain('no client on this LAN has that MAC address')
    owrt.dispose()
  })
})

/**
 * The half that owns the rules owns them during a change too.
 *
 * Start, Stop, Delete and Apply used to call an SSH reconciler unconditionally,
 * and it was worst on Stop: the fast sweep reads `ip -4 rule show` whether or
 * not the daemon is there, so the daemon's own rules arrived as this instance's
 * "actual" and stopping it planned a delete for every one of them. Each of the
 * four is now one `instance_set` or `instance_delete`, and the flush ordering
 * that used to be sequenced from here - rules off before the section goes - is
 * inside that one call, where `wanbind-service.uc` in `packages/ci/probes/`
 * proves it against the real daemon.
 */
describe('changing an instance on a router that keeps its own', () => {
  it('stops it through the daemon, without planning a single rule', async () => {
    const owrt = await router()
    await owrt.sweep()

    const result = (await owrt.call('bindingStop', SECTION)) as OkResult
    expect(result.ok).toBe(true)
    await settle(40)

    const sent = owrt.daemon.payloads('instance_set').at(-1)
    expect(sent?.id).toBe(SECTION)
    expect(sent?.enabled).toBe(false)
    // The two fields that name the instance come back from the router's own
    // section rather than from anything remembered here, because the cache is
    // up to one tick old and a carrier somebody changed at a router shell
    // inside that window would be quietly moved back by this very call.
    expect(sent?.lan).toBe('lan')
    expect(sent?.carrier).toBe('eth1')
    expect(wroteNoRule(owrt)).toBe(true)
    // Nor through UCI. The daemon writes its own sections; two writers of one
    // config file are two ideas of what the instance is.
    expect(owrt.commands()).not.toContain('uci batch')
    owrt.dispose()
  })

  it('deletes it through the daemon, and never with an ip rule del', async () => {
    const owrt = await router()
    await owrt.sweep()

    await owrt.call('bindingDelete', SECTION)
    await settle(40)

    expect(owrt.daemon.payloads('instance_delete')).toEqual([{ id: SECTION }])
    expect(owrt.daemon.state.configured).toEqual([])
    expect(wroteNoRule(owrt)).toBe(true)
    owrt.dispose()
  })
})
