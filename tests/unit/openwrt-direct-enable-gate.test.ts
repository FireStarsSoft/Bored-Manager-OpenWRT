import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import type { DirectRow } from '../../openwrt/main/wanbind'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import {
  BINDING_AGENT_INFO,
  isProbeCommand,
  routerProbeOutput,
  type RouterProbeOptions
} from '../helpers/router'
import { binding, fakeWanbind, type WanbindDaemon } from '../helpers/wanbind'

/**
 * Two doors into one action.
 *
 * A one-to-one binding is switched back on from the row's Enable button, and
 * also from the Enabled checkbox on the row's edit form - and both end the same
 * way, with a rule standing at the same priority for the same address. Only the
 * button was ever gated. So on the router this was first reported from, Enable
 * answered "This router cannot steer traffic by routing table" and told the
 * user what to install, while ticking Enabled and pressing Save answered "Save:
 * done" and then failed somewhere nobody sees.
 *
 * The rule that writes it is the daemon's from packages 2.4.0, so the half of
 * this file that was about a pass this module ran, a record it kept and a rule
 * it wrote is gone with the code: `bind` carries the rename, the down behaviour
 * and the switch in one call, which is why there is no longer a "the rename was
 * saved, the switch-on was not" to word. What is left is what the two doors
 * still share, and it is the part that was actually wrong in the first place:
 * one refusal, in one wording, from one table - and neither door writing a
 * thing when it refuses.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 30): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * Only `Date` is faked, and only so the clock can be moved on by hand.
 *
 * The domain refetches from the daemon at most once every two seconds, which is
 * right on a router and wrong here: two ticks a few milliseconds apart are one
 * fetch, so a row read after a Save would be the row from before it and the
 * idempotence case below would report a change that had in fact landed. Timers
 * stay real because `settle` is built out of them.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

/** The id the daemon answers to, which is the only id this side has. */
const SECTION = 'bmdir_nas'

/** Switched off on the router, and so one tick of a checkbox away from a rule. */
function offBinding(): ReturnType<typeof binding> {
  return binding({
    id: SECTION,
    name: 'NAS',
    ip: '10.0.0.20',
    label: '10.0.0.20',
    wan: 'wan1',
    enabled: false,
    state: 'disabled'
  })
}

/**
 * One LAN with an address, one WAN with a table, and one lease on it.
 *
 * `===RULESOK===` has to say 1 or the sweep reads as "the router would not
 * answer about its rules", no model is produced at all, and the assertions
 * below would pass for the wrong reason.
 */
function sweepAnswer(): ModuleExecResult {
  return ok(
    [
      '===SYS===',
      JSON.stringify({ uptime: 3600, load: [0, 0, 0], memory: { total: 1, free: 1 } }),
      '===DEV===',
      '===POOL=== 0 0 0',
      '===LEASES===',
      '1900000000 aa:bb:cc:dd:ee:01 10.0.0.20 nas *',
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
            proto: 'dhcp',
            device: 'eth1',
            l3_device: 'eth1',
            up: true,
            'ipv4-address': [{ address: '203.0.113.5', mask: 24 }],
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
  /** The row the page draws, so a claim about the binding is read as a person reads it. */
  row(id: string): Promise<DirectRow>
  /** What the job list says went wrong, which is where a mutation reports. */
  lastJobFailure(): string
  commands(): string[]
  /** A rule write would run as one `sh -s` script, so the verbs are on stdin. */
  stdins(): string[]
  /** Ask the router again, the way the fast poller does. */
  sweep(): Promise<void>
  dispose(): void
}

interface RouterOptions extends RouterProbeOptions {
  daemon?: WanbindDaemon
}

async function router(options: RouterOptions = {}): Promise<Router> {
  const { daemon: given, ...probe } = options
  const daemon = given ?? fakeWanbind({ bindings: [offBinding()] })
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: null,
    config: sharedModuleConfig(null)
  })
  harness.exec.mockImplementation(async (command) => {
    if (isProbeCommand(command)) {
      // `agent` defaults to packages 2.4.0 rather than to nothing, because a
      // router with no daemon refuses every case here for one reason and the
      // cases that are about a second reason would never reach it.
      return ok(
        routerProbeOutput({ agent: BINDING_AGENT_INFO, ...probe })
      )
    }
    const answered = daemon.answer(command)
    if (answered) return answered
    if (command.includes("echo '===SYS==='")) return sweepAnswer()
    return ok()
  })

  const runtime = activate(harness.ctx)
  runtime.applyPollers?.()
  await settle()
  const sweep = async (): Promise<void> => {
    vi.setSystemTime(Date.now() + 5_000)
    for (const tick of harness.ticks) await tick()
    await settle()
  }
  // One sweep, so the module is holding this router's bindings. Without one
  // every edit answers "no such one-to-one binding" instead, which is a true
  // sentence about a different situation.
  await sweep()

  return {
    harness,
    daemon,
    call: async (method, ...args) => harness.handlers.get(method)?.(...args),
    row: async (id) => {
      const rows = (await harness.handlers.get('directRows')?.()) as DirectRow[]
      const row = rows.find((entry) => entry.id === id)
      if (!row) throw new Error(`no row for ${id}`)
      return row
    },
    lastJobFailure: () => {
      const payloads = harness.emit.mock.calls
        .filter((call) => call[0] === 'jobs')
        .map((call) => call[1] as { finished?: Array<{ items?: Array<{ message?: string }> }> })
      for (const payload of payloads.reverse()) {
        for (const job of payload.finished ?? []) {
          for (const item of job.items ?? []) {
            if (item.message) return item.message
          }
        }
      }
      return ''
    },
    commands: () => harness.exec.mock.calls.map((call) => String(call[0])),
    stdins: () =>
      harness.exec.mock.calls.map((call) => String((call[1] as { stdin?: string })?.stdin ?? '')),
    sweep,
    dispose: () => runtime.dispose?.()
  }
}

const errorOf = (result: unknown): string => (result as OkResult).error ?? ''

/**
 * The edit form sends one argument per field, in the order it lists them:
 * Binding name, When that WAN is down, Enabled. A field left out is a field the
 * form did not send, and the binding keeps what the router's section has.
 */
const save = (owrt: Router, ...fields: unknown[]): Promise<unknown> =>
  owrt.call('directUpdate', SECTION, ...fields)

/**
 * Nothing anywhere in this module reached the kernel's rule table.
 *
 * Both halves of every call are searched, because a rule write ran as one
 * `sh -s` script with its verbs on stdin - a check that read the command lines
 * alone would have called the very fault this module was rebuilt to remove
 * clean.
 */
function wroteNoRule(owrt: Router): boolean {
  const everything = [...owrt.commands(), ...owrt.stdins()].join('\n')
  return !everything.includes('ip -4 rule add') && !everything.includes('ip -4 rule del')
}

describe('ticking Enabled is the same action as pressing Enable', () => {
  it('refuses the save in the sentence the button would have refused with', async () => {
    const owrt = await router({ agent: null })

    const button = await owrt.call('directEnable', SECTION)
    const form = await save(owrt, 'NAS', 'hold', true)

    expect((form as OkResult).ok).toBe(false)
    // The same words, not merely a refusal of its own: both read the sentence
    // off one entry in the requirements table, so neither can be reworded
    // without the other.
    expect(errorOf(form)).toBe(errorOf(button))
    expect(errorOf(form)).toContain('The binding daemon this module drives is not on this router')
    expect(errorOf(form)).toContain('Install the router packages')
    owrt.dispose()
  })

  it('leaves the binding as the router holds it when it refuses', async () => {
    // A refusal that had gone as far as the call would leave the page showing a
    // binding that is on and a router with no rule under it. There is no record
    // on this side any more, so the proof is that the router was asked nothing.
    const owrt = await router({ agent: null })

    await save(owrt, 'NAS', 'hold', true)
    await settle()

    expect(owrt.daemon.calls).toEqual([])
    expect(wroteNoRule(owrt)).toBe(true)
    owrt.dispose()
  })

  it('goes through as one call on a router whose daemon takes it', async () => {
    const owrt = await router()

    const first = await save(owrt, 'NAS', 'hold', true)
    await settle()
    await owrt.sweep()
    // Proof the switch actually landed rather than being quietly dropped: the
    // same save a second time now finds nothing left to change.
    const second = await save(owrt, 'NAS', 'hold', true)

    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true, data: 'nothing changed' })
    // All three fields in one `bind`, which is why there is no half-saved
    // binding to explain: the router either has the change or it does not.
    expect(owrt.daemon.count('bind')).toBe(1)
    expect(owrt.daemon.payloads('bind')[0]).toMatchObject({
      id: SECTION,
      name: 'NAS',
      when_down: 'hold',
      enabled: true
    })
    // And the priority is not restated. The rule the daemon allocated is not
    // this module's to re-derive, and a guess here is the one way to collide
    // with a binding somebody made at a router shell.
    expect(owrt.daemon.payloads('bind')[0]).not.toHaveProperty('pref')
    expect(await owrt.row(SECTION)).toMatchObject({ enabled: true })
    expect(wroteNoRule(owrt)).toBe(true)
    owrt.dispose()
  })
})

describe('what the gate must not stop', () => {
  /** Everything gone but the daemon, which is the router this form is opened on. */
  const HOPELESS: RouterProbeOptions = { without: ['dnsmasq', 'fw4', 'nft', 'ip-full'] }

  it('renames a binding on a router that can do nothing else at all', async () => {
    // A rename changes no rule, no table and no firewall path, and the edit
    // form is a page a user reaches precisely when something is already wrong.
    const owrt = await router(HOPELESS)

    const result = await save(owrt, 'Media box')
    await settle()

    expect(result).toMatchObject({ ok: true })
    expect(errorOf(result)).toBe('')
    expect(owrt.daemon.payloads('bind').at(-1)).toMatchObject({ name: 'Media box' })
    owrt.dispose()
  })

  it('changes When that WAN is down on the same hopeless router', async () => {
    const owrt = await router(HOPELESS)

    const result = await save(owrt, 'NAS', 'fallback')
    await settle()

    expect(result).toMatchObject({ ok: true })
    expect(owrt.daemon.payloads('bind').at(-1)).toMatchObject({ when_down: 'fallback' })
    owrt.dispose()
  })

  it('switches one off from the form on a router the Enable button refuses', async () => {
    // Off is not the mirror of on, and the difference is on purpose. Switching
    // off is how a person stops the router steering an address, this form is
    // the surface they have open when they want that, and the checkbox may not
    // be stricter than the button: a router with no firewall to write a
    // forwarding into cannot be switched on, and must still be switchable off.
    const owrt = await router({
      without: ['fw4'],
      daemon: fakeWanbind({ bindings: [binding({ id: SECTION, name: 'NAS', enabled: true })] })
    })

    const button = await owrt.call('directEnable', SECTION)
    const form = await owrt.call('directUpdate', SECTION, 'NAS', 'hold', false)
    await settle()

    expect((button as OkResult).ok).toBe(false)
    expect(errorOf(button)).toContain('Firewall4 is required')
    expect(form).toMatchObject({ ok: true })
    expect(owrt.daemon.payloads('bind').at(-1)).toMatchObject({ enabled: false })
    owrt.dispose()
  })
})

/**
 * The router that takes the call and will not take the change.
 *
 * Everything DIRECT_CREATE asks for is here and the daemon is answering, and
 * the section is still refused - because the priority it would need is inside
 * an instance's band, because the WAN it names is one of this router's own
 * LANs, or for any of the reasons only the half that owns the rules can see.
 * Both doors have to end in the same place: the binding as it was, nothing
 * written from here, and the daemon's own sentence carried rather than reworded
 * into one of this module's.
 */
describe('a daemon that answers, and still will not take the change', () => {
  const REFUSING = (): WanbindDaemon => {
    const daemon = fakeWanbind({ bindings: [offBinding()] })
    daemon.on('bind', () => ({
      ok: false,
      reason: 'pref 19000 is not below binding instance bmi_office, which numbers its clients from 19000'
    }))
    return daemon
  }

  it('files what the router said, and leaves the binding switched off', async () => {
    const owrt = await router({ daemon: REFUSING() })

    const result = await save(owrt, 'NAS', 'hold', true)
    await settle()
    await owrt.sweep()

    // The submission itself succeeds, because it became a job the instant the
    // job started - which is why the sentence has to reach the job list, and
    // why a test that only read the return value would prove nothing at all.
    expect(result).toMatchObject({ ok: true })
    expect(owrt.lastJobFailure()).toContain('not below binding instance')
    expect(await owrt.row(SECTION)).toMatchObject({ enabled: false })
    owrt.dispose()
  })

  it('carries the same sentence whichever door it came through', async () => {
    const owrt = await router({ daemon: REFUSING() })

    await owrt.call('directEnable', SECTION)
    await settle()
    const button = owrt.lastJobFailure()
    await save(owrt, 'NAS', 'hold', true)
    await settle()

    // Not merely a refusal of its own: both doors send the same `bind` and both
    // quote the answer, rather than one of them writing a flag and leaving
    // something later to find out.
    expect(button).toContain('not below binding instance')
    expect(owrt.lastJobFailure()).toBe(button)
    owrt.dispose()
  })

  it('never writes an ip rule for the binding it could not get taken', async () => {
    // The temptation is to steer the address from here until the router takes
    // the section. It is the wrong answer and it is the whole of the 3.4.0
    // changeover: the daemon sweeps this priority band on every pass, so a rule
    // written from here is removed thirty seconds later and put back on the
    // next tick, for ever, with every surface green. Nothing in this module may
    // write one - not on a create, not on an edit, not on a delete.
    const owrt = await router({ daemon: REFUSING() })

    await save(owrt, 'NAS', 'hold', true)
    await settle()
    await owrt.call('directEnable', SECTION)
    await settle()
    await owrt.call('directDelete', SECTION)
    await settle()

    expect(wroteNoRule(owrt)).toBe(true)
    // Nor through UCI: the daemon writes its own sections and its own
    // `option ip4table`, and two writers of one option are two numbers that do
    // not have to agree.
    expect(owrt.commands()).not.toContain('uci batch')
    owrt.dispose()
  })
})
