/**
 * The monitor at the size the release is about.
 *
 * Five hundred sessions and five hundred bindings is about two thousand rules
 * on the router, which the daemon collapses to about fifteen hundred rows. One
 * `rules` call carries five hundred of them - so a pass that made one call
 * showed a third of the table, and the tile above it said that third was how
 * many rules the router had. Both halves of that are tested here: the pages are
 * walked to the end, and the count the page states is the daemon's count of
 * what the kernel holds rather than this side's count of what it rendered.
 */
import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { moduleHarness } from '../helpers/module-harness'
import { bindingCapability } from '../helpers/wanbind'
import { ScanEngine } from '../../openwrt/main/scan'
import type { OpenWrtCapabilities } from '../../openwrt/main/probe'
import type { ModuleContext } from '@shared/modules'

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const AGENT = bindingCapability()

const CAPS = { probed: true, problem: null } as unknown as OpenWrtCapabilities

/** One collapsed netifd row: three kernel rules, one line on the page. */
function netifd(index: number) {
  const pref = 30_000 + index

  return {
    pref,
    cidr: '',
    dst: '',
    table: 10_001 + index,
    action: 1,
    selector: `3 rules for p${index}`,
    owner: 'netifd' as const,
    id: `p${index}`,
    instance: '',
    count: 3,
    prefs: [pref, pref + 1, pref + 2]
  }
}

function page(offset: number, size: number, count: number, raw: number) {
  const rules = []

  for (let i = offset; i < Math.min(offset + size, count); i += 1) rules.push(netifd(i))

  return {
    ok: true,
    read: true,
    count,
    raw,
    offset,
    capped: offset + rules.length < count,
    limit: size,
    rules,
    bands: { direct: { base: 19_000, top: 19_999 }, instances: [] },
    main: null,
    tables: [{ table: 254, wan: '', role: 'main', hasDefault: true, device: 'eth0', gateway: '10.0.0.1', unreachable: false }]
  }
}

/** A router holding `raw` rules that the daemon reports as `count` rows. */
function engineOver(count: number, raw: number) {
  const harness = moduleHarness('openwrt', () => ok(), { hostData: null })
  const asked: Array<{ limit: number; offset: number }> = []

  harness.exec.mockImplementation(async (command: string) => {
    const text = String(command)

    if (!text.includes('bm.wanbind') || !text.includes(' rules ')) return ok('{}')

    const payload = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
      limit?: number
      offset?: number
    }
    const limit = Number(payload.limit ?? 0)
    const offset = Number(payload.offset ?? 0)

    asked.push({ limit, offset })
    return ok(JSON.stringify(page(offset, limit, count, raw)))
  })

  const engine = new ScanEngine({
    ctx: harness.ctx as ModuleContext,
    rules: () => ({ scanIntervalSec: 60 }),
    agent: () => AGENT,
    capabilities: () => CAPS
  })

  return { engine, asked, harness }
}

describe('the monitor reads the whole rule table, not the first page of it', () => {
  it('walks the pages to the end and asks each one for no sentences', async () => {
    const { engine, asked } = engineOver(1_503, 4_509)

    const result = await engine.scanNow()

    expect(result.ok).toBe(true)
    // 500, 500, 500, 3 - and then it stops, because the offset has reached the
    // count. It used to be one call.
    expect(asked.map((one) => one.offset)).toEqual([0, 500, 1000, 1500])
    expect(engine.snapshot().rows).toHaveLength(1_503)
    engine.dispose()
  })

  it('states the rules the router holds, not the rows it rendered', async () => {
    const { engine } = engineOver(1_503, 4_509)
    await engine.scanNow()

    const summary = engine.snapshot().summary

    // Every row here stands for three rules. A page that showed 1,503 under
    // "rules seen" would be telling somebody their router has a third of the
    // rules it has.
    expect(summary.onRouter).toBe(4_509)
    expect(summary.total).toBe(4_509)
    expect(summary.rulesTruncated).toBe(false)
    engine.dispose()
  })

  it('says so when the table is longer than one pass will walk', async () => {
    // Ten pages of five hundred, and a router with more than that.
    const { engine, asked } = engineOver(9_000, 9_000)
    await engine.scanNow()

    expect(asked).toHaveLength(10)
    expect(engine.snapshot().summary.rulesTruncated).toBe(true)
    engine.dispose()
  })

  it('discards a pass whose later page could not be read', async () => {
    const harness = moduleHarness('openwrt', () => ok(), { hostData: null })
    let calls = 0

    harness.exec.mockImplementation(async (command: string) => {
      const text = String(command)

      if (!text.includes('bm.wanbind') || !text.includes(' rules ')) return ok('{}')

      calls += 1

      // The kernel answered the first dump and refused the second. An empty
      // `rules` beside `read: false` is not a router with no rules, and the
      // rows already collected describe a table that was being read when it
      // stopped being readable.
      if (calls === 1) return ok(JSON.stringify(page(0, 500, 900, 900)))
      return ok(JSON.stringify({ ...page(500, 500, 900, 900), read: false, rules: [] }))
    })

    const engine = new ScanEngine({
      ctx: harness.ctx as ModuleContext,
      rules: () => ({ scanIntervalSec: 60 }),
      agent: () => AGENT,
      capabilities: () => CAPS
    })

    const result = await engine.scanNow()

    expect(result.ok).toBe(false)
    expect(engine.snapshot().rows).toHaveLength(0)
    expect(engine.snapshot().ok).toBe(false)
    engine.dispose()
  })
})

describe('one rule explains itself when somebody opens it', () => {
  it('asks the daemon rather than carrying a paragraph on every row', async () => {
    const harness = moduleHarness('openwrt', () => ok(), { hostData: null })
    const asked: string[] = []

    harness.exec.mockImplementation(async (command: string) => {
      const text = String(command)

      if (text.includes('rule_explain')) {
        asked.push(text)
        return ok(
          JSON.stringify({
            ok: true,
            read: true,
            found: true,
            rule: {
              pref: 19_000,
              cidr: '10.0.0.11/32',
              table: 10_001,
              action: 1,
              selector: 'from 10.0.0.11/32',
              owner: 'manual',
              id: 'bmdir_a1',
              instance: '',
              reason: 'This daemon wrote it.'
            }
          })
        )
      }

      return ok('{}')
    })

    const engine = new ScanEngine({
      ctx: harness.ctx as ModuleContext,
      rules: () => ({ scanIntervalSec: 60 }),
      agent: () => AGENT,
      capabilities: () => CAPS
    })

    const answer = await engine.explain(19_000, '10.0.0.11/32', '', 10_001)

    expect(answer.reason).toBe('This daemon wrote it.')
    expect(asked).toHaveLength(1)
    engine.dispose()
  })

  it('says the rule has gone rather than showing nothing', async () => {
    const harness = moduleHarness('openwrt', () => ok(), { hostData: null })

    harness.exec.mockImplementation(async (command: string) => {
      if (String(command).includes('rule_explain')) {
        return ok(JSON.stringify({ ok: true, read: true, found: false, rule: null }))
      }
      return ok('{}')
    })

    const engine = new ScanEngine({
      ctx: harness.ctx as ModuleContext,
      rules: () => ({ scanIntervalSec: 60 }),
      agent: () => AGENT,
      capabilities: () => CAPS
    })

    const answer = await engine.explain(19_000, '10.0.0.11/32', '', 10_001)

    expect(answer.reason).toMatch(/no longer has this rule/)
    engine.dispose()
  })
})
