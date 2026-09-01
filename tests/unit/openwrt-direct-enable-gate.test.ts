import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import { isProbeCommand, routerProbeOutput, type RouterProbeOptions } from '../helpers/router'

/**
 * Two doors into one action.
 *
 * A one-to-one binding is switched back on from the row's Enable button, and
 * also from the Enabled checkbox on the row's edit form - and both end the same
 * way, with the next pass writing the same rule at the same priority. Only the
 * button was ever gated. So on the router this was reported from, one missing
 * `ip-full`, Enable answered "This router cannot steer traffic by routing
 * table" and told the user what to install, while ticking Enabled and pressing
 * Save answered "Save: done" and then failed inside a reconcile nobody sees.
 *
 * Everything below is about the two doors giving the same answer, and about the
 * edits that reach the router through nothing at all still going through on a
 * router that can do nothing at all.
 *
 * The capability gate closed one half of that: both doors now refuse a router
 * that cannot steer traffic by routing table, in one sentence. The other half is
 * the router that passes every check and still will not take the rule - a WAN
 * section with `option ip4table` deleted by hand, an `ip -4 rule add` that
 * returns non-zero for any of the reasons a probe cannot see. There the button
 * put the flag back and reported the failure while the form said "Save: done"
 * and left a binding switched on with no rule under it, which is the same
 * silence one layer down. The last group below is about that.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 30): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Switched off, and so one tick of a checkbox away from writing a rule. */
const OFF = {
  id: 'dir1',
  name: 'NAS',
  target: { kind: 'ip', ip: '192.168.1.20' },
  wan: 'wan',
  enabled: false,
  whenDown: 'hold',
  pref: 19_000,
  table: 30_001,
  lan: 'lan',
  slot: 0,
  createdAt: 1
}

/** Already on, so a save of the same three fields changes nothing anywhere. */
const ON = {
  ...OFF,
  id: 'dir2',
  name: 'Printer',
  target: { kind: 'ip', ip: '192.168.1.21' },
  enabled: true,
  pref: 19_001,
  table: 30_002,
  slot: 1
}

function hostData(): unknown {
  return {
    version: 3,
    instances: [],
    direct: [OFF, ON],
    extraTables: [
      ['wan', 30_001, 'dir1'],
      ['wan', 30_002, 'dir2']
    ],
    stickyMap: [],
    events: [],
    moduleEvents: [],
    jobs: []
  }
}

interface Router {
  call(method: string, ...args: unknown[]): Promise<unknown>
  /** The row the page draws, so a claim about the record is read the way a person reads it. */
  row(id: string): Promise<{ name: string; enabled: boolean }>
  /** What the job list says went wrong, which is where the Enable button reports. */
  lastJobFailure(): string
  /** Every script this router was actually sent, so a claim about a pass can be checked. */
  scripts(): string[]
  dispose(): void
}

interface RouterOptions extends RouterProbeOptions {
  /**
   * An address whose `ip -4 rule add` this router answers non-zero to, while
   * taking every other command it is given. That is the router no probe can
   * spot: fw4 present, ruleset loaded, `ip` able to do policy routing, netifd
   * running - and the one write that matters still refused.
   */
  refusesRuleFor?: string
  /**
   * A module whose readiness probe has not landed yet, which is every router
   * for the first seconds after it is connected. `===DONE===` is the sentinel
   * that says a router answered at all, so a probe without it leaves every
   * capability unknown and `probed` false - and every switch-on refused with
   * "The router has not been checked yet".
   */
  unprobed?: boolean
}

async function router(options: RouterOptions = {}): Promise<Router> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: hostData(),
    config: sharedModuleConfig(null)
  })
  const refused = options.refusesRuleFor ?? ''
  const scripts: string[] = []
  harness.exec.mockImplementation(async (command, execOptions) => {
    if (isProbeCommand(command)) {
      const answer = routerProbeOutput(options)
      return ok(options.unprobed ? answer.replace('===DONE===', '') : answer)
    }
    const stdin = execOptions?.stdin ?? ''
    scripts.push(stdin)
    if (refused && stdin.includes(`rule add from ${refused}/32`)) {
      return ok('', 'RTNETLINK answers: Invalid argument', 2)
    }
    return ok()
  })
  const runtime = activate(harness.ctx)
  runtime.applyPollers?.()
  await settle()
  // One sweep, so the module is holding a sample of this router. Without one
  // every path that runs a pass answers "no router sample is available yet"
  // instead, which is a true sentence about a different situation.
  for (const tick of harness.ticks) await tick()
  await settle()
  return {
    call: async (method, ...args) => harness.handlers.get(method)?.(...args),
    row: async (id) => {
      const rows = (await harness.handlers.get('directRows')?.()) as Array<{
        id: string
        name: string
        enabled: boolean
      }>
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
    scripts: () => [...scripts],
    dispose: () => runtime.dispose?.()
  }
}

const errorOf = (result: unknown): string => (result as OkResult).error ?? ''

/**
 * The edit form sends one argument per field, in the order it lists them:
 * Binding name, When that WAN is down, Enabled. A field left out is a field the
 * form did not send, and the binding keeps what it has.
 */
const save = (owrt: Router, ...fields: unknown[]): Promise<unknown> =>
  owrt.call('directUpdate', 'dir1', ...fields)

describe('ticking Enabled is the same action as pressing Enable', () => {
  it('refuses the save in the sentence the button would have refused with', async () => {
    const owrt = await router({ without: ['ip-full'] })

    const button = await owrt.call('directEnable', 'dir1')
    const form = await save(owrt, 'NAS', 'hold', true)

    expect((form as OkResult).ok).toBe(false)
    // The same words, not merely a refusal of its own: both read the sentence
    // off one entry in the requirements table, so neither can be reworded
    // without the other.
    expect(errorOf(form)).toBe(errorOf(button))
    expect(errorOf(form)).toContain('This router cannot steer traffic by routing table')
    expect(errorOf(form)).toContain('Install missing packages')
    owrt.dispose()
  })

  it('leaves the binding switched off when it refuses', async () => {
    // A refusal that had already written the record would leave the page
    // showing a binding that is on and a router carrying no rule for it.
    const owrt = await router({ without: ['ip-full'] })

    await save(owrt, 'NAS', 'hold', true)
    const again = await save(owrt, 'NAS', 'hold', true)

    expect(errorOf(again)).toContain('This router cannot steer traffic by routing table')
    owrt.dispose()
  })

  it('goes through on a router that can write the rule', async () => {
    const owrt = await router()

    const first = await save(owrt, 'NAS', 'hold', true)
    // Proof the flag actually landed rather than being quietly dropped: the
    // same save a second time now finds nothing left to change.
    const second = await save(owrt, 'NAS', 'hold', true)

    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true, data: 'nothing changed' })
    owrt.dispose()
  })
})

describe('what the gate must not stop', () => {
  it('renames a binding on a router that can do nothing at all', async () => {
    // A rename reaches the router through nothing, and the edit form is a page
    // a user reaches precisely when something is already wrong.
    const owrt = await router({ without: ['dnsmasq', 'fw4', 'nft', 'ip-full'] })

    const result = await save(owrt, 'Media box')

    expect(result).toMatchObject({ ok: true })
    expect(errorOf(result)).toBe('')
    owrt.dispose()
  })

  it('changes When that WAN is down on the same hopeless router', async () => {
    const owrt = await router({ without: ['dnsmasq', 'fw4', 'nft', 'ip-full'] })

    const result = await save(owrt, 'NAS', 'fallback')

    expect(result).toMatchObject({ ok: true })
    owrt.dispose()
  })

  it('saves a binding that was already on without calling it an enable', async () => {
    // Enabled arrives ticked on every save of a running binding, because that
    // is what the checkbox is showing. Only the off-to-on transition is the
    // action the gate exists for.
    const owrt = await router({ without: ['ip-full'] })

    const result = await owrt.call('directUpdate', 'dir2', 'Printer 2', 'hold', true)

    expect(result).toMatchObject({ ok: true })
    expect(errorOf(result)).toBe('')
    owrt.dispose()
  })

  it('switches a binding off from the form on a router that refuses the rule', async () => {
    // Off is not the mirror of on, and the difference is on purpose. Switching
    // off is how a person stops the module managing an address, this form is
    // the surface they have open when they want that, and the record going off
    // is self-correcting: every following pass sees a rule in the band with no
    // enabled record behind it and takes it off again.
    const owrt = await router({ refusesRuleFor: '192.168.1.21' })

    const result = await owrt.call('directUpdate', 'dir2', 'Printer', 'hold', false)

    expect(result).toMatchObject({ ok: true })
    expect(await owrt.row('dir2')).toMatchObject({ enabled: false })
    owrt.dispose()
  })

  it('still lets a binding be switched off from the form', async () => {
    // Off is the way out of a broken state, and `directDisable` is refused by
    // nothing for that reason; the checkbox may not be stricter than the button.
    const owrt = await router({ without: ['ip-full'] })

    const result = await owrt.call('directUpdate', 'dir2', 'Printer', 'hold', false)

    expect(result).toMatchObject({ ok: true })
    owrt.dispose()
  })
})

/**
 * The rest of the submission, when it is the capability gate that refuses.
 *
 * The group above is one save carrying one field, so the two doors can be held
 * side by side and compared word for word. A real save carries three, and the
 * two refusals a switch-on can meet - this router cannot do it at all, and this
 * router would not take the rule - used to treat the other two fields
 * completely differently: the failed pass saved them and said so, while the
 * capability verdict was returned before the domain ran at all and wrote
 * nothing. The row detail promises the first behaviour under the Enabled line,
 * unconditionally, so the second was the page telling the truth about half of
 * its own form.
 */
describe('a save the router cannot do, with a rename beside it', () => {
  it('keeps the rename, refuses the switch-on, and says both', async () => {
    const owrt = await router({ without: ['ip-full'] })

    const result = await save(owrt, 'Till at the front counter', 'hold', true)

    expect((result as OkResult).ok).toBe(false)
    // The verdict first, because it is the reason, and word for word the one
    // the Enable button gives.
    expect(errorOf(result)).toContain('This router cannot steer traffic by routing table')
    expect(errorOf(result)).toContain('Enabled is still off and no rule was written')
    expect(errorOf(result)).toContain('Binding name was saved')
    expect(await owrt.row('dir1')).toMatchObject({
      name: 'Till at the front counter',
      enabled: false
    })
    // In the record, not only in the sentence: the same submission with the box
    // cleared now finds nothing left to change.
    expect(await save(owrt, 'Till at the front counter', 'hold', false)).toMatchObject({
      ok: true,
      data: 'nothing changed'
    })
    owrt.dispose()
  })

  it('keeps it on a module that has not finished probing the router', async () => {
    // The likeliest way anyone meets this: a router connected seconds ago, no
    // verdict yet, and every switch-on refused until there is one. A rename
    // lost there is a rename lost for no reason at all - the router may well
    // turn out to be perfectly capable.
    const owrt = await router({ unprobed: true })

    const result = await save(owrt, 'Till at the front counter', 'fallback', true)

    expect((result as OkResult).ok).toBe(false)
    expect(errorOf(result)).toContain('The router has not been checked yet')
    expect(errorOf(result)).toContain('Enabled is still off and no rule was written')
    expect(errorOf(result)).toContain('Binding name and When that WAN is down were saved')
    expect(await owrt.row('dir1')).toMatchObject({
      name: 'Till at the front counter',
      whenDown: 'fallback',
      enabled: false
    })
    owrt.dispose()
  })

  it('writes no rule for the binding it refused', async () => {
    // The saved half reaches the router through nothing whatsoever, and the
    // refused half must reach it through nothing either: a capability refusal
    // that had gone as far as the pass would be the gate not gating.
    const owrt = await router({ without: ['ip-full'] })

    await save(owrt, 'Till at the front counter', 'hold', true)

    expect(owrt.scripts().filter((script) => script.includes('rule add from 192.168.1.20/32'))).toHaveLength(0)
    owrt.dispose()
  })
})

/**
 * The router the capability gate cannot see.
 *
 * Everything DIRECT_CREATE asks for is here - fw4, a loaded ruleset, an `ip`
 * that does policy routing, netifd running - and the one write that matters is
 * still refused, because somebody deleted `option ip4table` from the WAN
 * section by hand or the kernel simply said no. Both doors have to end in the
 * same place: the binding switched off, nothing on the router, and a sentence
 * carrying what the router said.
 */
describe('a router that can steer traffic, and still will not take the rule', () => {
  const REFUSING: RouterOptions = { refusesRuleFor: '192.168.1.20' }

  it('leaves the binding switched off and hands back what the router said', async () => {
    const owrt = await router(REFUSING)

    const result = await save(owrt, 'NAS', 'hold', true)

    expect((result as OkResult).ok).toBe(false)
    expect(errorOf(result)).toContain('reconcile one-to-one binding rules failed')
    // Named by the label on the checkbox, and stated as the position it is
    // actually in - the whole failure here is a form that said "done" while the
    // record and the router disagreed about that one word.
    expect(errorOf(result)).toContain('Enabled is still off and no rule was written')
    expect(await owrt.row('dir1')).toMatchObject({ enabled: false })
    owrt.dispose()
  })

  it('carries the same sentence the Enable button files in the job list', async () => {
    const owrt = await router(REFUSING)

    await owrt.call('directEnable', 'dir1')
    await settle()
    const button = owrt.lastJobFailure()
    const form = await save(owrt, 'NAS', 'hold', true)

    // Not merely a refusal of its own: the button runs the pass and reports
    // what stopped it, and the form now runs the same pass rather than writing
    // the flag and leaving a later reconcile to find out.
    expect(button).toContain('reconcile one-to-one binding rules failed')
    expect(errorOf(form)).toContain(button)
    // And the button left it off too, which is the state the two have to agree
    // on before the sentence is worth comparing.
    expect(await owrt.row('dir1')).toMatchObject({ enabled: false })
    owrt.dispose()
  })

  it('keeps the fields it could save and says which ones those were', async () => {
    // Deliberate. Both of the others reach the router through nothing at all,
    // and undoing a rename because an `ip rule` would not write would be a
    // second surprise stacked on the first - so they are saved, the switch-on
    // is all-or-nothing, and the refusal says which was which.
    const owrt = await router(REFUSING)

    const result = await save(owrt, 'Media box', 'fallback', true)

    expect(errorOf(result)).toContain(
      'Binding name and When that WAN is down were saved'
    )
    expect(await owrt.row('dir1')).toMatchObject({ name: 'Media box', enabled: false })
    // In the record, not only in the sentence: the same submission with the box
    // cleared now finds nothing left to change.
    expect(await save(owrt, 'Media box', 'fallback', false)).toMatchObject({
      ok: true,
      data: 'nothing changed'
    })
    owrt.dispose()
  })

  it('writes the rule during the save, not in some later reconcile', async () => {
    // The proof that the save is the pass and not a flag write: no tick runs
    // between the submission and the assertion, so the rule that is on this
    // router got there because Save put it there.
    const owrt = await router()

    const before = owrt.scripts().filter((script) => script.includes('rule add from 192.168.1.20/32'))
    const result = await save(owrt, 'NAS', 'hold', true)
    const after = owrt.scripts().filter((script) => script.includes('rule add from 192.168.1.20/32'))

    expect(before).toHaveLength(0)
    expect(after).toHaveLength(1)
    expect(result).toMatchObject({ ok: true })
    expect(await owrt.row('dir1')).toMatchObject({ enabled: true })
    owrt.dispose()
  })
})
