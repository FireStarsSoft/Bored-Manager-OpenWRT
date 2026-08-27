import { describe, expect, it, vi } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { ModuleCheckReport } from '@shared/check'
import type { OkResult } from '@shared/types'
import { agentAtLeast } from '../../openwrt/main/agent'
import { LimitsManager, LIMITS_FILE, recommendLimits } from '../../openwrt/main/limits'
import { emptyFacts, type OpenWrtCapabilities } from '../../openwrt/main/probe'
import { moduleHarness } from '../helpers/module-harness'

/**
 * The scale limits: the two kernel tables that overflow first at thousands of
 * sessions, finally writable instead of merely advised about.
 *
 * What must never happen here decides most of these tests. A value below the
 * connections in use right now would drop live traffic the moment it applied;
 * an inverted threshold trio silently disables one of the ARP cache's stages;
 * and the write has to go to whichever half owns it - the agent when it is new
 * enough, SSH when it is not - without the two ever writing different files.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const LIVE = {
  'net.netfilter.nf_conntrack_max': 65_536,
  'net.netfilter.nf_conntrack_count': 1_234,
  'net.ipv4.neigh.default.gc_thresh1': 128,
  'net.ipv4.neigh.default.gc_thresh2': 512,
  'net.ipv4.neigh.default.gc_thresh3': 1_024
}

type Agent = OpenWrtCapabilities['agent']

function agentOn(release: string): Agent {
  return {
    ...emptyFacts().agent,
    installed: true,
    running: true,
    release,
    apiVersion: 3,
    usable: true,
    problem: null,
    canGuard: true,
    canUpdate: true
  }
}

const NO_AGENT: Agent = {
  ...emptyFacts().agent,
  usable: false,
  problem: null,
  canGuard: false,
  canUpdate: false
}

interface Fixture {
  limits: LimitsManager
  sent: Array<{ command: string; stdin: string }>
  refreshed: () => number
}

function fixture(options: {
  agent?: Agent
  sysctl?: Record<string, number>
  flowOffload?: boolean | null
  clients?: number
  sessions?: number
  answer?: (command: string) => ModuleExecResult
} = {}): Fixture {
  const sent: Array<{ command: string; stdin: string }> = []
  const refreshes = vi.fn()
  const harness = moduleHarness('openwrt', () => ok())
  harness.exec.mockImplementation(async (command: string, opts?: { stdin?: string }) => {
    sent.push({ command, stdin: opts?.stdin ?? '' })
    return options.answer ? options.answer(command) : ok()
  })

  const limits = new LimitsManager({
    ctx: harness.ctx,
    agentDeps: { ctx: harness.ctx, capability: () => options.agent ?? NO_AGENT },
    current: () => ({
      sysctl: options.sysctl ?? LIVE,
      flowOffload: options.flowOffload === undefined ? false : options.flowOffload
    }),
    scale: () => ({ clients: options.clients ?? 100, sessions: options.sessions ?? 10 }),
    afterApply: refreshes
  })

  return { limits, sent, refreshed: () => refreshes.mock.calls.length }
}

const labels = (report: ModuleCheckReport): string[] =>
  report.findings.map((finding) => finding.label)

describe('the recommendation is sized from the router, with a floor', () => {
  it('never tells an idle router to shrink anything', () => {
    const idle = recommendLimits(0, 0)
    expect(idle.conntrackMax).toBe(262_144)
    expect(idle.gcThresh3).toBe(8_192)
    expect(idle.gcThresh2).toBe(4_096)
    expect(idle.gcThresh1).toBe(2_048)
  })

  it('grows in whole powers of two as the router does', () => {
    const big = recommendLimits(4_000, 1_000)
    // 5,000 flows round up to 8,192, ARP staging to four times the clients.
    expect(big.conntrackMax).toBe(1_048_576)
    expect(big.gcThresh3).toBe(16_384)
    expect(big.gcThresh2).toBe(8_192)
    expect(big.gcThresh1).toBe(4_096)
  })

  it('stays inside the same bounds the router-side allowlist enforces', () => {
    const huge = recommendLimits(1_000_000, 1_000_000)
    expect(huge.conntrackMax).toBeLessThanOrEqual(4_194_304)
    expect(huge.gcThresh3).toBeLessThanOrEqual(1_048_576)
  })
})

describe('what the check refuses', () => {
  it('a value outside the allowlisted bounds, by name', () => {
    const run = fixture()
    const report = run.limits.check({ conntrackMax: '3' })

    expect(report.ok).toBe(false)
    expect(labels(report).join('\n')).toContain('conntrack max must be between 16384 and 4194304')
  })

  it('a conntrack max below what is in use right now', () => {
    // 20,000 is a legal value and would still drop live connections on the
    // spot on a router holding 30,000 - the bound cannot catch that, only the
    // live count can.
    const run = fixture({
      sysctl: { ...LIVE, 'net.netfilter.nf_conntrack_count': 30_000 }
    })
    const report = run.limits.check({ conntrackMax: '20000' })

    expect(report.ok).toBe(false)
    expect(labels(report).join('\n')).toContain('below the 30000 entries in use')
  })

  it('an inverted threshold trio, merged against what the router holds', () => {
    // Only thresh1 was typed; the router's own thresh2 of 512 is what it
    // inverts against. Checking the typed fields alone would have passed it.
    const run = fixture()
    const report = run.limits.check({ gcThresh1: '9000' })

    expect(report.ok).toBe(false)
    expect(labels(report)).toContain('gc_thresh1 cannot be above gc_thresh2')
  })

  it('a form that changes nothing, so an accidental apply cannot no-op silently', () => {
    const run = fixture()
    const report = run.limits.check({})

    expect(report.ok).toBe(false)
    expect(labels(report)).toContain('Nothing here changes anything')
  })

  it('a router whose limits have not been read yet', () => {
    const run = fixture({ sysctl: {} })
    const report = run.limits.check({ conntrackMax: '262144' })

    expect(report.ok).toBe(false)
    expect(labels(report).join('\n')).toContain('has not reported its limits yet')
  })
})

describe('what the report says before anything is applied', () => {
  it('carries the usage, the recommendation, and who will write', () => {
    const run = fixture({ clients: 1_000, sessions: 500 })
    const report = run.limits.check({ conntrackMax: '262144' })

    expect(report.ok).toBe(true)
    expect(report.token).toBeTruthy()
    const text = report.findings.map((f) => `${f.label} ${f.detail ?? ''}`).join('\n')
    expect(text).toContain('Conntrack holds 1234 of 65536 entries')
    expect(text).toContain('1000 client(s), 500 session(s)')
    expect(text).toContain('Applied over SSH')
    expect(text).toContain(LIMITS_FILE)
  })

  it('names the agent as the writer once the packages are new enough', () => {
    const run = fixture({ agent: agentOn('2.1.0') })
    const report = run.limits.check({ conntrackMax: '262144' })

    expect(report.ok).toBe(true)
    const text = report.findings.map((f) => f.detail ?? '').join('\n')
    expect(text).toContain("router's own bm-agent")
  })
})

describe('applying over SSH, on a router whose agent predates tune_set', () => {
  it('writes the same file the agent would, then every sysctl', async () => {
    const run = fixture()
    const report = run.limits.check({ conntrackMax: '262144', gcThresh3: '8192' })
    expect(report.ok).toBe(true)

    const result = (await run.limits.apply({
      token: report.token,
      values: { conntrackMax: '262144', gcThresh3: '8192' }
    })) as OkResult

    expect(result.ok).toBe(true)
    const script = run.sent.find((call) => call.command === 'sh -s')?.stdin ?? ''
    expect(script).toContain(`} > ${LIMITS_FILE}`)
    expect(script).toContain('sysctl -w net.netfilter.nf_conntrack_max=262144')
    expect(script).toContain('sysctl -w net.ipv4.neigh.default.gc_thresh3=8192')
    // Untouched keys are pinned at their live values, so the file is the
    // whole reboot story rather than a fragment of it.
    expect(script).toContain('net.ipv4.neigh.default.gc_thresh1=128')
    // Flow offload was not changed, so the firewall is not reloaded.
    expect(script).not.toContain('flow_offloading')
    expect(run.refreshed()).toBe(1)
  })

  it('reloads the firewall only when flow offload actually changes', async () => {
    const run = fixture({ flowOffload: false })
    const report = run.limits.check({ flowOffload: true })
    expect(report.ok).toBe(true)

    await run.limits.apply({ token: report.token, values: { flowOffload: true } })

    const script = run.sent.find((call) => call.command === 'sh -s')?.stdin ?? ''
    expect(script).toContain("uci set firewall.@defaults[0].flow_offloading='1'")
    expect(script).toContain('/etc/init.d/firewall reload')
  })

  it('reports the router refusing the write instead of pretending', async () => {
    const run = fixture({
      answer: () => ok('', 'sysctl: error setting key', 1)
    })
    const report = run.limits.check({ conntrackMax: '262144' })

    const result = (await run.limits.apply({
      token: report.token,
      values: { conntrackMax: '262144' }
    })) as OkResult

    expect(result.ok).toBe(false)
    expect(result.error).toContain('refused the write')
    expect(run.refreshed()).toBe(0)
  })

  it('refuses a spent or drifted token with the way out', async () => {
    const run = fixture()
    const result = (await run.limits.apply({ token: 'stale', values: {} })) as OkResult

    expect(result.ok).toBe(false)
    expect(result.error).toContain('check again')
  })
})

describe('applying through the agent, once it owns the write', () => {
  it('sends one tune_set and touches no shell of its own', async () => {
    const run = fixture({
      agent: agentOn('2.1.0'),
      answer: (command) =>
        command.includes('tune_set')
          ? ok(JSON.stringify({ ok: true, applied: { conntrack_max: 262144 }, persisted: true }))
          : ok()
    })
    const report = run.limits.check({ conntrackMax: '262144' })

    const result = (await run.limits.apply({
      token: report.token,
      values: { conntrackMax: '262144' }
    })) as OkResult

    expect(result.ok).toBe(true)
    const call = run.sent.find((sent) => sent.command.includes('tune_set'))
    expect(call?.command).toContain('ubus -S call bm.agent tune_set')
    expect(call?.command).toContain('"conntrack_max":262144')
    expect(run.sent.some((sent) => sent.command === 'sh -s')).toBe(false)
    expect(run.refreshed()).toBe(1)
  })

  it('translates Method not found into the packages update it means', async () => {
    // The capability says 2.1.0 but the router was downgraded between the
    // check and the apply - the one caller objectCall's raw stderr would
    // reach, and the one reader who needs a sentence rather than a ubus code.
    const run = fixture({
      agent: agentOn('2.1.0'),
      answer: (command) => (command.includes('tune_set') ? ok('', 'Method not found', 2) : ok())
    })
    const report = run.limits.check({ conntrackMax: '262144' })

    const result = (await run.limits.apply({
      token: report.token,
      values: { conntrackMax: '262144' }
    })) as OkResult

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Update the router packages to 2.1.0 or newer')
  })
})

describe('which half owns the write', () => {
  it('is decided by release, not by the agent merely existing', () => {
    expect(agentAtLeast(agentOn('2.1.0'), '2.1.0')).toBe(true)
    expect(agentAtLeast(agentOn('2.10.3'), '2.1.0')).toBe(true)
    expect(agentAtLeast(agentOn('3.0.0'), '2.1.0')).toBe(true)
    expect(agentAtLeast(agentOn('2.0.1'), '2.1.0')).toBe(false)
    expect(agentAtLeast(agentOn('SNAPSHOT'), '2.1.0')).toBe(false)
    expect(agentAtLeast(NO_AGENT, '2.1.0')).toBe(false)
  })
})
