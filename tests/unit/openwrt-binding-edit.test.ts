import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OkResult } from '@shared/types'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import { BINDING_AGENT_INFO, isProbeCommand, routerProbeOutput } from '../helpers/router'
import { fakeWanbind, instanceConfig, type WanbindDaemon } from '../helpers/wanbind'

/**
 * An instance could be created, started, stopped and deleted, and never edited.
 * A typo in the name, or a second thought about sticky assignment, meant
 * deleting the instance - which tears every client rule off the router, drops
 * the remembered WAN of every device on it, and hands the LAN back to a
 * fail-closed catch-all until the replacement finishes preparing.
 *
 * From packages 2.4.0 the section being edited is the router's, so a Save is
 * one `instance_set` and nothing else: no rule is planned here, no priority is
 * allocated here, and there is no record on this side for the router's section
 * to disagree with. Two things follow that every case below turns on. The
 * fields the form does not send are omitted rather than blanked, because
 * `instance_set` is create-and-edit in one and an omitted field keeps what the
 * section has. And the LAN and the carrier are resent unaltered from a fresh
 * read of the router - never from the cache, which is up to one tick old, and
 * never from anything remembered here.
 *
 * The LAN and the carrier stay delete-and-recreate on purpose: they are the
 * topology every rule was built from, and the refusals below say so rather than
 * silently accepting a value the router would ignore.
 */

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

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
 * fetch, so a table read after a Save would be the table from before it and
 * every row assertion below would be checking the wrong moment. Timers stay
 * real because `settle` is built out of them.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * One LAN with an address, one WAN with a table, and one lease on it.
 *
 * `===RULESOK===` has to say 1 or the sweep reads as "the router would not
 * answer about its rules" and no sample is produced at all - which is not a
 * detail here, because the tick that fetches the daemon's answers is the same
 * tick, so every case below would run against a module that has never asked.
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

const OFFICE = 'bmi_office'
const GUEST = 'bmi_guest'

/** The two sections the daemon holds, as its configuration reader accepted them. */
function configured(): ReturnType<typeof instanceConfig>[] {
  return [
    instanceConfig({ id: OFFICE, name: 'Office LAN', lan: 'lan', carrier: 'eth1' }),
    instanceConfig({
      id: GUEST,
      name: 'Guest LAN',
      lan: 'guest',
      carrier: 'eth2',
      sticky: false,
      remap: false,
      enabled: false
    })
  ]
}

function manifestMethods(): string[] {
  const manifest = JSON.parse(
    readFileSync(new URL('../../openwrt/module.json', import.meta.url), 'utf8')
  ) as { methods: string[] }
  return manifest.methods
}

interface Module {
  daemon: WanbindDaemon
  /** The object form, which is what these cases are about: what the domain refuses. */
  update(id: unknown, values: Record<string, unknown>): Promise<OkResult>
  /** The shape the page actually sends: one argument per field, in spec order. */
  updateFromForm(id: unknown, name?: unknown, sticky?: unknown, remap?: unknown): Promise<OkResult>
  /** The instance rows a surface renders, which are the router's answer. */
  rows(): Array<Record<string, unknown>>
  /** One instance's own event ring, which is the one thing this side still keeps. */
  events(id: string): Array<{ kind: string; text: string }>
  /** Ask the router again, the way the fast poller does. */
  sweep(): Promise<void>
  methods: Set<string>
  dispose(): void
}

/**
 * The whole module over a faked `bm.wanbind`, with its first sweep already run.
 *
 * The sweep is not a formality: the instances live on the router now, so a
 * module that has not asked yet has no instance to edit and every case here
 * would be asserting against "no such binding instance".
 */
async function moduleUnder(daemon: WanbindDaemon = fakeWanbind({ configured: configured() })): Promise<Module> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: null,
    config: sharedModuleConfig(null)
  })
  harness.exec.mockImplementation(async (command) => {
    if (isProbeCommand(command)) return ok(routerProbeOutput({ agent: BINDING_AGENT_INFO }))
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
  await sweep()

  return {
    daemon,
    methods: new Set(manifestMethods()),
    update: async (id, values) => {
      const result = (await harness.handlers.get('bindingUpdate')?.(id, values)) as OkResult
      await settle()
      return result
    },
    updateFromForm: async (id, name, sticky, remap) => {
      const result = (await harness.handlers.get('bindingUpdate')?.(
        id,
        name,
        sticky,
        remap
      )) as OkResult
      await settle()
      return result
    },
    rows: () =>
      (runtime.snapshots?.().binding as { rows: Array<Record<string, unknown>> }).rows,
    events: (id) =>
      harness.handlers.get('bindingEventRows')?.(id) as Array<{ kind: string; text: string }>,
    sweep,
    dispose: () => runtime.dispose?.()
  }
}

/** What one Save actually asked the router to write, or undefined for none. */
const sent = (module: Module): Record<string, unknown> | undefined =>
  module.daemon.payloads('instance_set').at(-1)

describe('the method the row form calls', () => {
  it('is registered under the name the manifest declares', async () => {
    const module = await moduleUnder()

    expect(module.methods.has('bindingUpdate')).toBe(true)
    expect((await module.update(OFFICE, { name: 'Office LAN' })).ok).toBe(true)

    module.dispose()
  })

  it('has a handler for every method the manifest declares', () => {
    // A name in one list and not the other is a dead button nothing reports.
    const harness = moduleHarness('openwrt', ok, { config: sharedModuleConfig(null) })
    const runtime = activate(harness.ctx)

    expect(manifestMethods().filter((name) => !harness.handlers.has(name))).toEqual([])

    runtime.dispose?.()
  })
})

describe('editing an instance', () => {
  it('renames it on the router, and the row says so once the router is asked again', async () => {
    // The row is the daemon's answer rather than a record kept here, so the
    // proof has two halves: the section the router was asked to write, and the
    // row that comes back from it. A test that only read the row would pass on
    // a module that had quietly kept its own copy of the instance, which is the
    // arrangement 3.4.0 exists to remove.
    const module = await moduleUnder()

    const result = await module.update(OFFICE, { name: 'Floor 2', sticky: false, remap: false })
    await module.sweep()

    expect(result.ok).toBe(true)
    expect(sent(module)).toMatchObject({ name: 'Floor 2', sticky: false, remap: false })
    expect(module.rows()[0]).toMatchObject({
      id: OFFICE,
      name: 'Floor 2',
      sticky: false,
      remap: false
    })
    module.dispose()
  })

  it('resends the LAN and the carrier exactly as the router holds them', async () => {
    // Not optional in the call and not this module's to have an opinion about:
    // `instance_set` needs both, and they are read back from the router at the
    // moment of the Save. An instance whose carrier somebody changed at a
    // router shell in the last tick would otherwise be moved back by a Save
    // that was only ever meant to rename it.
    const module = await moduleUnder()

    await module.update(OFFICE, { name: 'Floor 2' })

    expect(sent(module)).toMatchObject({ lan: 'lan', carrier: 'eth1' })
    module.dispose()
  })

  it('leaves out what the form did not send', async () => {
    // An omitted field keeps what the section has, so what matters is what was
    // in the call: sending `remap` here at all would be this module deciding a
    // flag the operator never touched.
    const module = await moduleUnder()

    await module.update(OFFICE, { sticky: false })
    await module.sweep()

    expect(sent(module)).toMatchObject({ name: 'Office LAN', sticky: false, remap: true })
    expect(module.rows()[0]).toMatchObject({
      name: 'Office LAN',
      sticky: false,
      remap: true
    })
    module.dispose()
  })

  it('records what changed', async () => {
    // The event ring is the one thing about binding this side still keeps: the
    // daemon reconciles, it does not remember, so nothing on the router can
    // answer what happened to this instance while nobody was looking.
    const module = await moduleUnder()

    await module.update(OFFICE, { name: 'Floor 2', remap: false })
    const texts = module.events(OFFICE).map((entry) => entry.text)

    expect(texts.some((text) => text.includes('renamed to "Floor 2"'))).toBe(true)
    expect(texts.some((text) => text.includes('error remap off'))).toBe(true)
    module.dispose()
  })

  it('says nothing happened when nothing did, and asks the router for nothing', async () => {
    const module = await moduleUnder()

    const result = await module.update(OFFICE, {
      name: 'Office LAN',
      sticky: true,
      remap: true
    })

    expect(result).toEqual({ ok: true, data: 'nothing changed' })
    expect(module.daemon.count('instance_set')).toBe(0)
    expect(module.events(OFFICE)).toEqual([])
    module.dispose()
  })
})

describe('the shape the page actually sends', () => {
  /**
   * A `form` block sends one argument per field, in the order its spec lists
   * them - not one object, which is what a `checkForm` sends. The handler was
   * written for the object alone, so it received the name string where it
   * expected the whole form and answered "Save: done" having changed nothing:
   * the two flags could never be edited from the page at all.
   */
  it('renames and flips both flags from three positional arguments', async () => {
    const module = await moduleUnder()

    const result = await module.updateFromForm(OFFICE, 'Floor 3', false, false)
    await module.sweep()

    expect(result.ok).toBe(true)
    expect(module.rows()[0]).toMatchObject({
      id: OFFICE,
      name: 'Floor 3',
      sticky: false,
      remap: false
    })
    module.dispose()
  })

  it('leaves a field the form did not send alone', async () => {
    // Three fields, only the middle one carrying a value - an argument that is
    // `undefined` is a field left out, not a field cleared.
    const module = await moduleUnder()

    expect((await module.updateFromForm(OFFICE, undefined, false, undefined)).ok).toBe(true)

    expect(sent(module)).toMatchObject({ name: 'Office LAN', sticky: false, remap: true })
    module.dispose()
  })
})

describe('what editing refuses', () => {
  it('refuses a name another instance already has', async () => {
    // Measured against the list the router last answered with, which is the
    // only list there is: two sections carrying one name make every refusal,
    // job label and event line about either of them ambiguous.
    const module = await moduleUnder()

    const result = await module.update(OFFICE, { name: 'guest lan' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('already exists')
    // Nothing was asked of the router either. A refusal on this side that had
    // gone as far as the call would be the gate not gating.
    expect(module.daemon.count('instance_set')).toBe(0)
    // Still what it was: re-sending the old name changes nothing.
    expect(await module.update(OFFICE, { name: 'Office LAN' })).toEqual({
      ok: true,
      data: 'nothing changed'
    })
    module.dispose()
  })

  it('refuses to move the instance to another LAN, and says what to do', async () => {
    const module = await moduleUnder()

    const result = await module.update(OFFICE, { lan: 'guest' })

    expect(result.ok).toBe(false)
    // Silently ignoring it would leave the catch-all and every client rule
    // installed for a subnet that is no longer behind this instance.
    expect(result.error).toContain('delete this instance')
    expect(result.error).toContain('guest')
    expect(module.daemon.count('instance_set')).toBe(0)
    expect(await module.update(OFFICE, { lan: 'lan' })).toEqual({
      ok: true,
      data: 'nothing changed'
    })
    module.dispose()
  })

  it('refuses to move it to another carrier', async () => {
    const module = await moduleUnder()

    const result = await module.update(OFFICE, { carrier: 'eth3' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('WAN carrier')
    expect(module.daemon.count('instance_set')).toBe(0)
    module.dispose()
  })

  it('accepts the LAN and carrier it already has', async () => {
    // The form does not carry them, but an invoke made by hand may.
    const module = await moduleUnder()

    const result = await module.update(OFFICE, {
      lan: 'lan',
      carrier: 'eth1',
      name: 'Floor 2'
    })

    expect(result.ok).toBe(true)
    module.dispose()
  })

  it('refuses a name the user cleared, and keeps one the form never sent', async () => {
    const module = await moduleUnder()

    const cleared = await module.update(OFFICE, { name: '  ', sticky: false })
    expect(cleared.ok).toBe(false)
    expect(cleared.error).toContain('1-80 characters')

    // The flag went nowhere either: a refused edit changes nothing at all.
    expect(await module.update(OFFICE, { sticky: true })).toEqual({
      ok: true,
      data: 'nothing changed'
    })
    module.dispose()
  })

  it('refuses an instance that is not there', async () => {
    const module = await moduleUnder()

    expect(await module.update('bmi_nope', { name: 'Nope' })).toEqual({
      ok: false,
      error: 'no such binding instance'
    })
    module.dispose()
  })

  it('refuses every edit on a router with no binding daemon, in the requirement\'s words', async () => {
    // The whole domain is a client of `bm-wanbind` and there is deliberately no
    // half left that could write a section over SSH, so a router without the
    // package is refused rather than served worse - and the refusal says which
    // of the three reasons it is and what to do about it.
    const daemon = fakeWanbind({ configured: configured() })
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: null,
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command) => {
      if (isProbeCommand(command)) return ok(routerProbeOutput({ agent: null }))
      return daemon.answer(command) ?? ok()
    })
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    const result = (await harness.handlers.get('bindingUpdate')?.(OFFICE, 'Floor 2')) as OkResult
    await settle()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Install the router packages')
    expect(daemon.calls).toEqual([])
    runtime.dispose?.()
  })
})
