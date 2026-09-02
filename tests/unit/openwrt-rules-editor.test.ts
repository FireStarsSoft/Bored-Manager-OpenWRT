import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import {
  ConfigStore,
  DEFAULT_RULES,
  RULE_BOUNDS,
  RulesEditor
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

// `topology` is gone from the editor's constructor and from this signature.
//
// It existed to keep three numbers locked while a binding instance's rules
// stood on the router written against them. The router stamps each section with
// its own numbers now and re-reads them itself, so there is nothing here for a
// rule on any router to have been written against, and nothing to lock.
function editor(stored: unknown = null): Editor {
  const config = sharedModuleConfig(stored)
  const harness = moduleHarness('openwrt', ok, { config })
  const store = new ConfigStore(harness.ctx)
  return {
    rules: new RulesEditor(harness.ctx, store),
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
    const report = editor().rules.check({ stickyCap: '2,000' })

    expect(errors(report)).toEqual(['Sticky mappings kept must be a whole number'])
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

  it('refuses a firewall zone name UCI would not take as a section', () => {
    // The zone name is written as `firewall.<name>=zone`, so anything outside
    // the UCI section grammar produces a batch the router rejects halfway.
    expect(errors(editor().rules.check({ zoneName: 'bm-wan-pool' }))).toEqual([
      'Firewall zone name must start with a lowercase letter and contain only lowercase letters, digits or underscores'
    ])
    expect(errors(editor().rules.check({ zoneName: "lan';reboot;'" }))).toHaveLength(1)
    expect(errors(editor().rules.check({ zoneName: 'bm_wan_pool2' }))).toEqual([])
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
    const report = run.rules.check({ zoneName: 'bm-wan-pool', stickyCap: '2000' })

    expect(report.ok).toBe(false)
    expect(report.token).toBeUndefined()
    // And the good field in the same submission is not saved on its own: the
    // form is checked and applied as one group.
    expect(run.config.effectiveRules().stickyCap).toBe(DEFAULT_RULES.stickyCap)
  })
})

describe('the values that used to say where the binding rules live', () => {
  // The lock is gone, and its going is the point.
  //
  // Three of these numbers - the two priority bases and the catch-all table -
  // were refused while any binding instance existed, because the rules standing
  // on the router had been written against them: move one and the next pass
  // failed to recognise its own work and wrote a second copy of everything. So
  // the editor had to know whether this router had records, and a context that
  // could not say refused outright, which meant the grace periods and the lease
  // file could not be reset either.
  //
  // From 3.4.0 those numbers are not this module's. `bm-wanbind` stamps each
  // section with the band it was created under, keeps it, and re-reads it
  // itself; the defaults for the next one are edited on Connection, under WAN
  // Binding, and reach the router through `settings_set`. There is nothing left
  // here that a rule on any router was written against, so there is nothing to
  // lock and no topology to ask about.
  const ONCE_LOCKED = { catchAllTable: '31000' }

  it('are editable with no router connected at all', () => {
    const run = editor()

    apply(run, ONCE_LOCKED)

    expect(run.config.effectiveRules().catchAllTable).toBe(31_000)
  })

  it('are editable with binding instances on the router', () => {
    // The stored document below is the shape the lock used to read: a machine
    // carrying binding records. It is not consulted any more, and this is the
    // assertion that says so out loud.
    const run = editor({
      version: 3,
      instances: [{ id: 'bmi_home', lan: 'lan', running: true }],
      direct: [],
      extraTables: [],
      stickyMap: [],
      events: [],
      moduleEvents: [],
      jobs: []
    })

    apply(run, ONCE_LOCKED)

    expect(run.config.effectiveRules().catchAllTable).toBe(31_000)
  })

  it('still refuse an arrangement no router could act on', () => {
    // Dropping the lock is not dropping the arithmetic. The client band has to
    // end before the catch-all band starts, whoever owns the numbers, and a
    // reader that let this through would be offering the daemon a setting it
    // would refuse silently on the next create.
    const report = editor().rules.check({
      rulePrefBase: '30000',
      catchAllPrefBase: '20000'
    })

    expect(errors(report)).toContain(
      'Assignment rule priorities must end before the catch-all priority range'
    )
  })

  it('reset every rule now that none of them is held back', () => {
    // The old reset refused wholesale on a router with one record, so the lease
    // file and the grace periods - none of which describe where anything lives
    // - could not be put back without deleting the instance first.
    const run = editor()

    apply(run, { catchAllTable: '31000', releaseGraceSec: '600' })
    expect(run.rules.reset().ok).toBe(true)

    expect(run.config.effectiveRules().catchAllTable).toBe(DEFAULT_RULES.catchAllTable)
    expect(run.config.effectiveRules().releaseGraceSec).toBe(DEFAULT_RULES.releaseGraceSec)
    expect(run.saved().rules).toEqual({})
  })
})

describe('what a save actually writes', () => {
  it('stores only the values that differ from their defaults', () => {
    const run = editor()

    apply(run, { stickyCap: '2000' })

    // The file is hand-editable and the defaults move between releases. A
    // document that copied every default would silently pin this router to the
    // defaults of the build that wrote it.
    expect(run.saved().rules).toEqual({ stickyCap: 2_000 })
  })

  it('drops an override again when the value is set back to its default', () => {
    const run = editor()
    apply(run, { stickyCap: '2000' })
    expect(run.saved().rules).toEqual({ stickyCap: 2_000 })

    apply(run, { stickyCap: String(DEFAULT_RULES.stickyCap) })

    expect(run.saved().rules).toEqual({})
  })

  it('counts what will change and what will be kept, before anything is written', () => {
    const run = editor()
    apply(run, { releaseGraceSec: '600' })

    const report = run.rules.check({ stickyCap: '2000' })

    // Two different counts, and they answer two different questions: what this
    // save moves, and how much of the document is no longer a default.
    expect(pass(report)).toContain('1 rule(s) will change: stickyCap')
    expect(pass(report)).toContain('2 rule override(s) will be saved')
  })

  it('says every rule is a default once the last override goes', () => {
    const run = editor()
    apply(run, { stickyCap: '2000' })

    const report = run.rules.check({ stickyCap: String(DEFAULT_RULES.stickyCap) })

    expect(pass(report)).toContain('Every OpenWRT rule will use its default')
  })
})

describe('a token applied against something other than what was checked', () => {
  it('is refused rather than trusted', () => {
    // The token is bound to the values it was issued for. A save that carried
    // different ones would write a document nothing had validated.
    const run = editor()
    const report = run.rules.check({ stickyCap: '2000' })
    expect(report.ok).toBe(true)
    if (!report.ok) return

    expect(run.rules.apply({ token: report.token, values: { stickyCap: '50000' } })).toMatchObject({
      ok: false,
      error: expect.stringContaining('check again')
    })
    expect(run.config.effectiveRules().stickyCap).toBe(DEFAULT_RULES.stickyCap)
  })

  it('cannot be spent twice', () => {
    const run = editor()
    const report = run.rules.check({ stickyCap: '2000' })
    expect(report.ok).toBe(true)
    if (!report.ok) return

    expect(run.rules.apply({ token: report.token, values: { stickyCap: '2000' } })).toEqual({
      ok: true
    })
    expect(
      run.rules.apply({ token: report.token, values: { stickyCap: '2000' } })
    ).toMatchObject({ ok: false })
  })
})
