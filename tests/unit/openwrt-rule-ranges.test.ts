import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import { ConfigStore, DEFAULT_RULES, RulesEditor } from '../../openwrt/main/config'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * Two ranges are numbered from a configurable base, and each has to end before
 * the catch-all numbering starts: one routing table per WAN, and one ip rule
 * priority per bound device. Only the tables were ever cross-checked. A
 * priority base set close under the catch-all range therefore saved cleanly,
 * and then the pool quietly ran out of preferences: every device past the gap
 * stayed queued behind a fail-closed catch-all - no internet, and no setting
 * anywhere admitting that the numbering was the reason.
 */

const ok = (): { code: number; stdout: string; stderr: string } => ({
  code: 0,
  stdout: '',
  stderr: ''
})

function editor(stored: unknown = null): { check: RulesEditor['check']; apply: RulesEditor['apply'] } {
  const harness = moduleHarness('openwrt', ok, { config: sharedModuleConfig(stored) })
  const config = new ConfigStore(harness.ctx)
  const rules = new RulesEditor(harness.ctx, config, () => 'none')
  return { check: (raw) => rules.check(raw), apply: (raw) => rules.apply(raw) }
}

function stored(overrides: Record<string, number | string>): unknown {
  return { version: 1, rules: overrides, ui: { showHints: true } }
}

const labels = (report: ModuleCheckReport): string[] =>
  report.findings
    .filter((finding) => finding.level === 'error')
    .map((finding) => finding.label)

const OVERLAP = 'The client rule priority range overlaps the catch-all priority range'

describe('the client rule priority range', () => {
  it('is refused when a whole batch would not fit below the catch-all range', () => {
    // 28,000 is a legal base and 29,900 is the default catch-all base, so the
    // two do not collide - but a batch holds 5,000 sessions and every bound
    // device takes one priority from 28,000 upwards.
    const report = editor().check({ rulePrefBase: 28_000 })

    expect(report.ok).toBe(false)
    expect(labels(report)).toContain(OVERLAP)
    expect(
      report.findings.find((finding) => finding.label === OVERLAP)?.detail
    ).toContain('5000')
  })

  it('is accepted when the batch size leaves room for it', () => {
    const report = editor().check({ rulePrefBase: 28_000, maxBatchRows: 1_000 })

    expect(labels(report)).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('is refused when the batch size alone grows into it', () => {
    // A saved layout that fits: 28,000 upwards, with 1,000 sessions per batch.
    // Raising only the batch size is what runs it into the catch-all range, and
    // the form group that does it does not contain the priority base at all.
    const report = editor(stored({ rulePrefBase: 28_000, maxBatchRows: 1_000 }))
      .check({ maxBatchRows: 5_000 })

    expect(labels(report)).toContain(OVERLAP)
  })

  it('is still refused when the base alone is above the catch-all base', () => {
    // The check that was already there. Both are reported; neither replaced.
    const report = editor().check({ catchAllPrefBase: 2_000 })

    expect(labels(report)).toContain(
      'Assignment rule priorities must end before the catch-all priority range'
    )
  })

  it('gets the same treatment the routing tables already got', () => {
    const report = editor().check({ tableBase: 25_000 })

    expect(labels(report)).toContain(
      'The PPPoE routing-table range overlaps the catch-all routing table'
    )
  })
})

describe('saving an overlapping range', () => {
  it('is refused at apply as well as at check', () => {
    const rules = editor()
    // A token from a check that passed, against values that no longer do:
    // `apply` re-derives the blockers rather than trusting the report.
    const good = rules.check({ rulePrefBase: 24_000 })
    expect(good.ok).toBe(true)

    const bad = rules.check({ rulePrefBase: 28_000 })
    expect(bad.ok).toBe(false)
    expect(bad.token).toBeUndefined()

    const applied = rules.apply({
      token: good.token,
      values: { rulePrefBase: 24_000 }
    })
    expect(applied.ok).toBe(true)
  })
})

describe('a stored config that already overlaps', () => {
  it('is not honoured on read', () => {
    const harness = moduleHarness('openwrt', ok, {
      config: sharedModuleConfig(stored({ rulePrefBase: 28_000 }))
    })

    const config = new ConfigStore(harness.ctx)

    // Hand-edited, or written by a build without the cross-check. Loading it
    // would put every priority this module writes inside the catch-all range.
    expect(config.effectiveRules().rulePrefBase).toBe(DEFAULT_RULES.rulePrefBase)
  })

  it('keeps an override that leaves room', () => {
    const harness = moduleHarness('openwrt', ok, {
      config: sharedModuleConfig(stored({ rulePrefBase: 24_000 }))
    })

    const config = new ConfigStore(harness.ctx)

    expect(config.effectiveRules().rulePrefBase).toBe(24_000)
  })
})
