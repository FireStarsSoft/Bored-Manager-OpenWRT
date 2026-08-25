import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import {
  ConfigStore,
  DEFAULT_RULES,
  RULE_BOUNDS,
  RulesEditor,
  type RulesTopology
} from '../../openwrt/main/config'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * The settings form, on everything it refuses and everything it writes.
 *
 * Every field here ends up interpolated into a command, a UCI section name or a
 * numbering range the router already has objects in, so the check is the only
 * thing between a typed value and a router. Two properties matter: a value the
 * check rejected must never reach the saved document, and the document must
 * hold only what actually differs from the defaults - the file is hand-editable,
 * and a copy of every default in it is a copy that stops tracking them.
 */

const ok = (): ModuleExecResult => ({ code: 0, stdout: '', stderr: '' })

interface Editor {
  rules: RulesEditor
  config: ConfigStore
  /** The document as it was written, rather than the merged effective values. */
  saved(): { rules: Record<string, unknown> }
}

function editor(topology: RulesTopology = 'none', stored: unknown = null): Editor {
  const config = sharedModuleConfig(stored)
  const harness = moduleHarness('openwrt', ok, { config })
  const store = new ConfigStore(harness.ctx)
  return {
    rules: new RulesEditor(harness.ctx, store, () => topology),
    config: store,
    saved: () => (config.get() ?? { rules: {} }) as { rules: Record<string, unknown> }
  }
}

const errors = (report: ModuleCheckReport): string[] =>
  report.findings.filter((finding) => finding.level === 'error').map((finding) => finding.label)

const pass = (report: ModuleCheckReport): string =>
  report.findings
    .filter((finding) => finding.level === 'pass')
    .map((finding) => `${finding.label} ${finding.detail ?? ''}`)
    .join('\n')

const apply = (editorUnderTest: Editor, values: Record<string, unknown>): void => {
  const report = editorUnderTest.rules.check(values)
  expect(errors(report)).toEqual([])
  if (!report.ok) return
  expect(editorUnderTest.rules.apply({ token: report.token, values })).toEqual({ ok: true })
}

describe('a value the form cannot accept', () => {
  it('refuses a number that is not one, and shows what was typed', () => {
    const report = editor().rules.check({ chunkDelayMs: '2,000' })

    expect(errors(report)).toEqual(['Delay between chunks (ms) must be a whole number'])
    // The detail quotes the entry rather than a parsed value, because "you
    // entered 2" would be describing something the user did not type.
    expect(report.findings[0].detail).toContain('"2,000"')
  })

  it('refuses a number outside its range, at either end', () => {
    const low = editor().rules.check({ execTimeoutSec: '5' })
    const high = editor().rules.check({ execTimeoutSec: '6000' })
    const bounds = RULE_BOUNDS.execTimeoutSec

    for (const report of [low, high]) {
      expect(errors(report)).toEqual([
        `${bounds.label} must be between ${bounds.min} and ${bounds.max}`
      ])
    }
    // The bounds are stated, so the user is not left guessing what would fit.
    expect(low.findings[0].label).toContain(String(bounds.min))
    expect(low.findings[0].label).toContain(String(bounds.max))
  })

  it('refuses an interface prefix netifd could not carry', () => {
    // This becomes the first characters of every managed section name, so it
    // has to survive UCI, a shell and netifd's 15-character device limit.
    for (const bad of ['PD', 'p_d', '1pd', 'prefix', 'pd ppp']) {
      expect(editor().rules.check({ ifacePrefix: bad })).toMatchObject({ ok: false })
    }
    expect(errors(editor().rules.check({ ifacePrefix: 'PD' }))).toEqual([
      'Interface prefix must be 1-4 lowercase letters or digits and start with a letter'
    ])
    expect(errors(editor().rules.check({ ifacePrefix: 'wan1' }))).toEqual([])
  })

  it('refuses a firewall zone name UCI would not take as a section', () => {
    // The zone name is written as `firewall.<name>=zone`, so anything outside
    // the UCI section grammar produces a batch the router rejects halfway.
    expect(errors(editor().rules.check({ zoneName: 'bm-wan-pool' }))).toEqual([
      'Firewall zone name must start with a lowercase letter and contain only lowercase letters, digits or underscores'
    ])
    expect(errors(editor().rules.check({ zoneName: "lan';reboot;'" }))).toHaveLength(1)
    expect(errors(editor().rules.check({ zoneName: 'bm_wan_pool2' }))).toEqual([])
  })

  it('refuses a membership mode that is neither of the two', () => {
    expect(errors(editor().rules.check({ zoneMode: 'devices' }))).toEqual([
      'Firewall zone mode must be wildcard or networks'
    ])
  })

  it('refuses a lease file that is not a plain absolute path', () => {
    for (const bad of ['tmp/dhcp.leases', '/tmp/../etc/shadow', '/tmp/a\nb', '/tmp/$(id)']) {
      expect(errors(editor().rules.check({ leaseFile: bad }))).toEqual([
        'Lease file must be a short absolute path without line breaks'
      ])
    }
    expect(errors(editor().rules.check({ leaseFile: '/var/dhcp.leases' }))).toEqual([])
  })

  it('hands out no token, so the bad value cannot be applied anyway', () => {
    const run = editor()
    const report = run.rules.check({ zoneName: 'bm-wan-pool', chunkDelayMs: '2000' })

    expect(report.ok).toBe(false)
    expect(report.token).toBeUndefined()
    // And the good field in the same submission is not saved on its own: the
    // form is checked and applied as one group.
    expect(run.config.effectiveRules().chunkDelayMs).toBe(DEFAULT_RULES.chunkDelayMs)
  })
})

describe('the six values that say where this module objects live', () => {
  const LOCKED = { tableBase: '11000' }

  it('may be changed on a router with no records of its own', () => {
    const run = editor('none')

    apply(run, LOCKED)

    expect(run.config.effectiveRules().tableBase).toBe(11_000)
  })

  it('are refused while batches or binding instances exist, and say what to delete', () => {
    const report = editor('present').rules.check(LOCKED)

    expect(errors(report)).toEqual([
      'Numbering and firewall-layout rules cannot change while batches or binding instances exist'
    ])
    expect(report.findings.find((finding) => finding.level === 'error')?.detail).toContain(
      'tableBase'
    )
  })

  it('are refused when nothing can say whether this router has records', () => {
    // The records are per-machine and the rules are global, so "no records"
    // read off a disconnected context is not evidence. Answering `none` there
    // unlocked the table range of a router carrying a hundred live sessions.
    const report = editor('unknown').rules.check(LOCKED)

    expect(errors(report)).toEqual([
      'Numbering and firewall-layout rules cannot change while no router is connected'
    ])
    expect(report.findings.find((finding) => finding.level === 'error')?.detail).toContain(
      'Connect the router'
    )
  })

  it('lock nothing when the submission leaves them where they are', () => {
    // The lock is measured against what is in force, not against the presence
    // of the field: every group of this form posts its own fields whether or
    // not the user touched them.
    for (const topology of ['none', 'present', 'unknown'] as RulesTopology[]) {
      const report = editor(topology).rules.check({
        tableBase: String(DEFAULT_RULES.tableBase),
        chunkDelayMs: '2000'
      })
      expect(errors(report)).toEqual([])
    }
  })

  it('are not writable through a rule that is not locked', () => {
    // A sanity check on the list itself: the unlocked rules stay editable on a
    // router that is carrying records, which is the whole reason the lock is
    // six values rather than all of them.
    const run = editor('present')

    apply(run, { chunkDelayMs: '2000', releaseGraceSec: '600' })

    expect(run.config.effectiveRules()).toMatchObject({ chunkDelayMs: 2_000, releaseGraceSec: 600 })
  })
})

describe('what a save actually writes', () => {
  it('stores only the values that differ from their defaults', () => {
    const run = editor()

    apply(run, { chunkDelayMs: '2000' })

    // The file is hand-editable and the defaults move between releases. A
    // document that copied every default would silently pin this router to the
    // defaults of the build that wrote it.
    expect(run.saved().rules).toEqual({ chunkDelayMs: 2_000 })
  })

  it('drops an override again when the value is set back to its default', () => {
    const run = editor()
    apply(run, { chunkDelayMs: '2000' })
    expect(run.saved().rules).toEqual({ chunkDelayMs: 2_000 })

    apply(run, { chunkDelayMs: String(DEFAULT_RULES.chunkDelayMs) })

    expect(run.saved().rules).toEqual({})
  })

  it('counts what will change and what will be kept, before anything is written', () => {
    const run = editor()
    apply(run, { releaseGraceSec: '600' })

    const report = run.rules.check({ chunkDelayMs: '2000' })

    // Two different counts, and they answer two different questions: what this
    // save moves, and how much of the document is no longer a default.
    expect(pass(report)).toContain('1 rule(s) will change: chunkDelayMs')
    expect(pass(report)).toContain('2 rule override(s) will be saved')
  })

  it('says every rule is a default once the last override goes', () => {
    const run = editor()
    apply(run, { chunkDelayMs: '2000' })

    const report = run.rules.check({ chunkDelayMs: String(DEFAULT_RULES.chunkDelayMs) })

    expect(pass(report)).toContain('Every OpenWRT rule will use its default')
  })
})

describe('a token applied against something other than what was checked', () => {
  it('is refused rather than trusted', () => {
    // The token is bound to the values it was issued for. A save that carried
    // different ones would write a document nothing had validated.
    const run = editor()
    const report = run.rules.check({ chunkDelayMs: '2000' })
    expect(report.ok).toBe(true)
    if (!report.ok) return

    expect(run.rules.apply({ token: report.token, values: { chunkDelayMs: '50000' } })).toMatchObject({
      ok: false,
      error: expect.stringContaining('check again')
    })
    expect(run.config.effectiveRules().chunkDelayMs).toBe(DEFAULT_RULES.chunkDelayMs)
  })

  it('cannot be spent twice', () => {
    const run = editor()
    const report = run.rules.check({ chunkDelayMs: '2000' })
    expect(report.ok).toBe(true)
    if (!report.ok) return

    expect(run.rules.apply({ token: report.token, values: { chunkDelayMs: '2000' } })).toEqual({
      ok: true
    })
    expect(
      run.rules.apply({ token: report.token, values: { chunkDelayMs: '2000' } })
    ).toMatchObject({ ok: false })
  })
})
