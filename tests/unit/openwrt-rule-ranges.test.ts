import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import { ConfigStore, DEFAULT_RULES, RulesEditor } from '../../openwrt/main/config'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * Two ranges are numbered from a configurable base, and each has to end before
 * the catch-all numbering starts: one routing table per WAN, and one ip rule
 * priority per bound device. The floor is the router half's own: `bm-wanbind`
 * refuses an instance whose priority span is narrower than its minimum, and it
 * refuses it silently - so the form has to say it here, where a person can
 * still act on it. The 5,000-row batch arithmetic that used to live in these
 * checks left with the batches themselves: pools carry their own numbering on
 * the router now.
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

const NARROW = 'The client rule priority range is too narrow'

describe('the client rule priority range', () => {
  it('is refused when it is narrower than the router half will run', () => {
    // Both bases are legal on their own and the two do not collide - but
    // forty priorities between them is below the floor bm-wanbind holds, and
    // it refuses such an instance by leaving it out of its own list, silently.
    const report = editor().check({ rulePrefBase: '28960', catchAllPrefBase: '29000' })

    expect(report.ok).toBe(false)
    expect(labels(report)).toContain(NARROW)
    expect(report.findings.find((finding) => finding.label === NARROW)?.detail).toContain(
      'refuses it silently'
    )
  })

  it('is accepted when the span leaves room', () => {
    const report = editor().check({ rulePrefBase: '28000' })

    expect(labels(report)).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('is still refused when the base alone is above the catch-all base', () => {
    // The check that was already there. Both are reported; neither replaced.
    const report = editor().check({ catchAllPrefBase: '2000' })

    expect(labels(report)).toContain(
      'Assignment rule priorities must end before the catch-all priority range'
    )
  })

  it('gets the same treatment the routing tables already got', () => {
    const report = editor().check({ catchAllTable: '10050' })

    expect(labels(report)).toContain(
      'The WAN routing-table range overlaps the catch-all routing table'
    )
  })
})

describe('saving an overlapping range', () => {
  it('is refused at apply as well as at check', () => {
    const rules = editor()
    // A token from a check that passed, against values that no longer do:
    // `apply` re-derives the blockers rather than trusting the report.
    const good = rules.check({ rulePrefBase: '24000' })
    expect(good.ok).toBe(true)

    const bad = rules.check({ rulePrefBase: '29850' })
    expect(bad.ok).toBe(false)
    expect(bad.token).toBeUndefined()

    const applied = rules.apply({
      token: good.token,
      values: { rulePrefBase: '24000' }
    })
    expect(applied.ok).toBe(true)
  })
})

describe('a stored config that already overlaps', () => {
  it('is not honoured on read', () => {
    const harness = moduleHarness('openwrt', ok, {
      config: sharedModuleConfig(stored({ rulePrefBase: 29_850 }))
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
