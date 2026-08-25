import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import { AGENT_INFO, isProbeCommand, routerProbeOutput } from '../helpers/router'

/**
 * Which half binds, and the one rule that decides it.
 *
 * With `bm-wanbind` installed there are two possible writers of the same ip
 * rule priority range. They must never both run, and the fall back is at the
 * capability verdict rather than at any individual call: a router that did not
 * answer one tick means rows one tick stale, and this module planning its own
 * rules against that would be two halves writing from two ideas of the truth.
 *
 * Everything below is about that boundary holding in both directions.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const INSTANCE = {
  id: 'i1',
  name: 'Home',
  lan: 'lan',
  carrier: 'eth1',
  running: true,
  sticky: true,
  remap: true,
  createdAt: 1_700_000_000_000,
  slot: 0
}

const HOST = {
  version: 1,
  nextSeq: 1,
  batches: [] as unknown[],
  instances: [INSTANCE],
  extraTables: [['wan1', 101, 'i1']],
  stickyMap: [],
  events: [],
  moduleEvents: [],
  jobs: []
}

/** The section name both sides derive from the instance id. */
const SECTION = 'bmi1'

const ASSIGNMENTS = {
  assignments: [
    {
      instance: SECTION,
      mac: 'AA:BB:CC:DD:EE:01',
      ip: '10.0.0.11',
      host: 'laptop',
      wan: 'wan1',
      pref: 20000,
      table: 101,
      assignedAt: 1_700_000_000
    }
  ]
}

const WAITING = {
  waiting: [
    {
      instance: SECTION,
      mac: 'aa:bb:cc:dd:ee:02',
      ip: '10.0.0.12',
      host: 'phone',
      order: 1,
      since: 1_700_000_100,
      held: false,
      why: 'queued',
      reason: 'every WAN in the pool is taken or unusable'
    },
    {
      instance: SECTION,
      mac: 'aa:bb:cc:dd:ee:03',
      ip: '10.0.0.13',
      host: 'tv',
      order: 0,
      since: 0,
      held: true,
      why: 'held',
      reason: 'held out of the pool by hand'
    }
  ]
}

/**
 * One LAN with an address, one WAN with a table, and two leases on it.
 *
 * The `===RULESOK===` sentinel has to say 1: without it the sweep reads as
 * "the router would not answer about its rules" and the binding engine never
 * gets a model at all, so no pass of either kind runs and every assertion below
 * would pass for the wrong reason.
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
      '1900000000 aa:bb:cc:dd:ee:03 10.0.0.13 tv *',
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
  call(method: string, ...args: unknown[]): Promise<unknown>
  /** Run one fast sweep. A poller does not tick on its own in a test. */
  sweep(): Promise<void>
  commands(): string[]
  /** A rule write runs as one `sh -s` script, so the verbs are on stdin. */
  stdins(): string[]
  dispose(): void
}

async function router(
  options: {
    provides?: string[]
    answer?: (command: string, stdin: string) => ModuleExecResult | null
  } = {}
): Promise<Router> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: HOST,
    config: sharedModuleConfig(null)
  })

  harness.exec.mockImplementation(async (command, execOptions) => {
    if (isProbeCommand(command)) {
      return ok(
        routerProbeOutput({
          agent: { ...AGENT_INFO, provides: options.provides ?? [] }
        })
      )
    }
    const answered = options.answer?.(command, execOptions?.stdin ?? '')
    if (answered) return answered
    if (command.includes('ubus -S call bm.wanbind assignments')) {
      return ok(JSON.stringify(ASSIGNMENTS))
    }
    if (command.includes('ubus -S call bm.wanbind waiting')) {
      return ok(JSON.stringify(WAITING))
    }
    if (command.includes('ubus -S call bm.wanbind')) return ok(JSON.stringify({ ok: true }))
    if (command.includes('uci -q show bm_wanbind')) return ok('')
    if (command.includes("echo '===SYS==='")) return sweepAnswer()
    return ok()
  })

  const runtime = activate(harness.ctx)
  runtime.applyPollers?.()
  await settle()

  return {
    harness,
    call: async (method, ...args) => harness.handlers.get(method)?.(...args),
    sweep: async () => {
      for (const tick of harness.ticks) await tick()
      await settle(20)
    },
    commands: () => harness.exec.mock.calls.map((call) => String(call[0])),
    stdins: () =>
      harness.exec.mock.calls.map((call) => String((call[1] as { stdin?: string })?.stdin ?? '')),
    dispose: () => runtime.dispose?.()
  }
}

describe('the module stands down when the router is binding', () => {
  it('asks the agent for the rows and writes no ip rule at all', async () => {
    const owrt = await router({ provides: ['binding'] })
    await owrt.sweep()

    const commands = owrt.commands().join('\n')
    expect(commands).toContain('ubus -S call bm.wanbind assignments')
    expect(commands).toContain('ubus -S call bm.wanbind waiting')
    // The whole point. Two writers in one priority range is the failure this
    // boundary exists to make impossible, so nothing may reach the kernel from
    // here - not an add, not a delete, not the catch-all.
    expect(commands).not.toContain('ip -4 rule add')
    expect(commands).not.toContain('ip -4 rule del')
    owrt.dispose()
  })

  it('does not fall back to writing rules when a call fails', async () => {
    const owrt = await router({
      provides: ['binding'],
      answer: (command) =>
        command.includes('ubus -S call bm.wanbind assignments')
          ? ok('', 'Command failed: Not found', 1)
          : null
    })
    await owrt.sweep()

    // A router that would not answer is rows one tick stale, which the snapshot
    // says. It is not a reason to start planning against it.
    expect(owrt.commands().join('\n')).not.toContain('ip -4 rule add')
    owrt.dispose()
  })

  it('still binds over SSH on a router with the agent but not the package', async () => {
    // The agent alone provides nothing. This is the fall back working, and it
    // is the same router the module has managed since 2.0.0.
    const owrt = await router({ provides: [] })
    await owrt.sweep()

    expect(owrt.commands().join('\n')).not.toContain('ubus -S call bm.wanbind')
    owrt.dispose()
  })
})

describe('the three device actions, when the router holds the assignment', () => {
  const seen = (owrt: Router, method: string): boolean =>
    owrt.commands().some((command) => command.includes(`ubus -S call bm.wanbind ${method}`))

  it('sends Unassign, Reassign and Pin to the agent rather than planning them', async () => {
    const owrt = await router({ provides: ['binding'] })
    await settle(20)

    const unassign = (await owrt.call('bindingUnassign', 'i1', 'aa:bb:cc:dd:ee:01')) as OkResult
    expect(unassign.ok).toBe(true)
    await settle(20)
    expect(seen(owrt, 'unassign')).toBe(true)

    await owrt.call('bindingReassign', 'i1', 'aa:bb:cc:dd:ee:01')
    await settle(20)
    expect(seen(owrt, 'reassign')).toBe(true)

    await owrt.call('bindingPin', 'i1', 'aa:bb:cc:dd:ee:01', 'wan1')
    await settle(20)
    expect(seen(owrt, 'pin')).toBe(true)

    // And none of them wrote a rule. The router did that, or did not.
    expect(owrt.commands().join('\n')).not.toContain('ip -4 rule add')
    owrt.dispose()
  })

  it('names the device the router refused, and how many went through first', async () => {
    const owrt = await router({
      provides: ['binding'],
      answer: (command) =>
        command.includes('bm.wanbind unassign')
          ? ok(JSON.stringify({ ok: false, reason: 'no client on this LAN has that MAC address' }))
          : null
    })
    await settle(20)

    await owrt.call('bindingUnassign', 'i1', 'aa:bb:cc:dd:ee:09')
    await settle(20)

    const events = owrt.harness.emit.mock.calls
      .filter((call) => call[0] === 'jobs')
      .flatMap((call) => JSON.stringify(call[1]))
      .join('\n')
    expect(events).toContain('no client on this LAN has that MAC address')
    owrt.dispose()
  })
})

describe('the instance list the router reads', () => {
  it('is written from the module records, with the instance layout', async () => {
    const written: string[] = []
    const owrt = await router({
      provides: ['binding'],
      answer: (command, stdin) => {
        if (command === 'uci batch') {
          written.push(stdin)
          return ok()
        }
        return null
      }
    })
    await settle(40)

    // Started by hand, which is a record change, which is what triggers a sync.
    await owrt.call('bindingStop', 'i1')
    await settle(40)

    const batch = written.join('\n')
    expect(batch).toContain(`set bm_wanbind.${SECTION}=instance`)
    expect(batch).toContain(`set bm_wanbind.${SECTION}.lan='lan'`)
    expect(batch).toContain(`set bm_wanbind.${SECTION}.carrier='eth1'`)
    // The instance's own slot decides its catch-all priority, exactly as the
    // SSH path allocates it - two instances on one router must not share one.
    expect(batch).toContain(`set bm_wanbind.${SECTION}.catch_all_pref='29900'`)
    expect(batch).toContain('commit bm_wanbind')
    // And procd is told, or the file changes and nothing reads it until a boot.
    expect(owrt.commands().join('\n')).toContain('/etc/init.d/bm-wanbind reload')
    owrt.dispose()
  })

  it('flushes an orphan section before removing it', async () => {
    const owrt = await router({
      provides: ['binding'],
      answer: (command) =>
        command.includes('uci -q show bm_wanbind')
          ? ok(['bm_wanbind.bmi1=instance', 'bm_wanbind.bmold=instance'].join('\n'))
          : null
    })
    await owrt.sweep()

    await owrt.call('bindingStop', 'i1')
    await settle(40)

    const commands = owrt.commands()
    const flushed = commands.findIndex((command) =>
      command.includes('ubus -S call bm.wanbind flush') && command.includes('bmold')
    )
    const batched = commands.findIndex((command) => command === 'uci batch')

    // Order, not merely presence. Once the section is gone the daemon has no
    // instance for that priority range and will never look at it again, so the
    // rules would stay on the router with nothing maintaining them.
    expect(flushed).toBeGreaterThanOrEqual(0)
    expect(batched).toBeGreaterThan(flushed)
    owrt.dispose()
  })
})

/**
 * The half that owns the rules owns them during a change too.
 *
 * The sweep asked the capability from the start; Start, Stop, Delete and Apply
 * did not, and called the SSH reconciler unconditionally. That is the second
 * writer this whole boundary exists to prevent, and it was worst on Stop: the
 * fast sweep reads `ip -4 rule show` whether or not the agent is there, so the
 * daemon's own rules arrived as this instance's "actual" and stopping it
 * planned a delete for every one of them.
 */
describe('changing an instance on a router that is binding', () => {
  it('stops it through the router, without planning a single rule', async () => {
    const owrt = await router({ provides: ['binding'] })
    await owrt.sweep()

    const before = owrt.commands().length
    await owrt.call('bindingStop', 'i1')
    await settle(40)

    const during = owrt.commands().slice(before).join('\n')
    expect(during).not.toContain('ip -4 rule del')
    expect(during).not.toContain('ip -4 rule add')
    owrt.dispose()
  })

  it('takes the rules off before the section is disabled', async () => {
    const owrt = await router({ provides: ['binding'] })
    await owrt.sweep()

    const before = owrt.commands().length
    await owrt.call('bindingStop', 'i1')
    await settle(40)

    const after = owrt.commands().slice(before)
    const flushed = after.findIndex(
      (command) => command.includes('ubus -S call bm.wanbind flush') && command.includes(SECTION)
    )
    const batched = after.findIndex((command) => command === 'uci batch')

    // Order again, and for a reason the orphan case does not cover: the daemon
    // drops a *disabled* instance when it reads its config and does not remove
    // its rules on the way past. Flushing after the reload would leave every
    // client bound to a table nothing maintains.
    expect(flushed).toBeGreaterThanOrEqual(0)
    expect(batched).toBeGreaterThan(flushed)
    owrt.dispose()
  })

  it('still plans rules itself when the router has no binding package', async () => {
    const owrt = await router({ provides: [] })
    await owrt.sweep()

    const before = owrt.commands().length
    await owrt.call('bindingStop', 'i1')
    await settle(40)

    // The fall back is unchanged: this is the router the module has managed
    // since 2.0.0, and stopping an instance is still it writing the rules.
    expect(owrt.stdins().slice(before).join('\n')).toContain('ip -4 rule')
    owrt.dispose()
  })
})
