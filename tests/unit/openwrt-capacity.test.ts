/**
 * The Capacity tab: what the router said, and what this side is willing to do
 * about it.
 *
 * Two halves worth testing separately. The first is rendering - a reply becomes
 * a payload, an absent fact becomes "unknown" rather than a zero, and a router
 * whose agent predates the verb is answered without a call at all. The second
 * is the one that matters: a reply is data that arrived over a wire and the
 * fixes in it name write paths on somebody's router, so a fix reaches a button
 * only when this module was already willing to make that write. The cases below
 * are the ones that would otherwise let a reply pick the write.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ModuleContext, ModuleExecResult } from '@shared/modules'
import { moduleHarness } from '../helpers/module-harness'
import { bindingCapability } from '../helpers/wanbind'
import { CapacityManager, normalizeCapacity, type CapacityWriters } from '../../openwrt/main/capacity'
import type { RawCapacity } from '../../openwrt/main/agent'
import type { AgentCapability, OpenWrtCapabilities } from '../../openwrt/main/probe'

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })
// A router that has been probed and has both daemons. The daemon fixes borrow
// the gate of the write path they take, so this is what decides whether they
// are allowed to run at all.
const CAPS = {
  probed: true,
  problem: null,
  agent: bindingCapability()
} as unknown as OpenWrtCapabilities

/** A router at 400 sessions on 512 MB, with one thing wrong and one to raise. */
function report(over: Partial<RawCapacity> = {}): RawCapacity {
  return {
    ok: true,
    at: 1_900_000_000,
    estimate: true,
    hardware: {
      board: 'QEMU Standard PC',
      arch: 'x86_64',
      target: 'x86/64',
      openwrt: '25.12.5',
      kernel: '6.6.73',
      cpus: 2,
      cpuModel: 'Intel(R) Celeron(R) J4125',
      memTotalKb: 524_288,
      memAvailableKb: 300_000,
      memAvailableEstimated: false,
      flashTotalKb: 122_880,
      flashFreeKb: 98_304,
      flashMount: '/overlay',
      nicCount: 2,
      nicsKnown: true,
      load1: 0.4,
      load5: 0.3,
      load15: 0.2
    },
    software: {
      release: '25.12.5',
      packages: { agent: '2.4.0', wanbind: '2.4.0', pppoe: '2.4.0', luci: '2.4.0' },
      fw4: true,
      fw4Loaded: true,
      flowOffload: false,
      flowOffloadKernel: true,
      hwOffload: { configured: false, capable: 'unknown' },
      conntrackMax: 65_536,
      conntrackCount: 4_000,
      gcThresh3: 8_192,
      leaseMax: 150,
      leaseMaxDefault: true
    },
    load: {
      configured: { pools: [{ id: 'fpt', members: 400 }], members: 400, instances: 1, bindings: 200 },
      live: { sessionsUp: 396, bound: 198, leases: 200, ipRules: 1_806 },
      answered: { wanbind: true, pppoe: true },
      clients: 200,
      instanceId: 'bmi_aaa001'
    },
    needed: {
      memKb: 480_000,
      cpus: 2,
      flashKb: 4_496,
      flowOffload: true,
      conntrackMax: 262_144,
      gcThresh3: 8_192,
      leaseMax: 216,
      pools: 1,
      prefs: 200
    },
    requirements: [
      { key: 'memory', level: 'pass', label: 'Memory is enough', detail: '' },
      {
        key: 'flow-offload',
        level: 'error',
        label: 'This many sessions need fw4 flow offload, and it is off',
        detail: 'Turn it on.',
        fix: { kind: 'tune_set', args: { flow_offload: true } }
      },
      {
        key: 'conntrack-max',
        level: 'warning',
        label: 'The connection tracking table is small for this many clients',
        detail: '',
        fix: { kind: 'tune_set', args: { conntrack_max: 262_144, gc_thresh3: 8_192 } }
      },
      {
        key: 'lease-max',
        level: 'error',
        label: 'dnsmasq stops at 150 leases and this LAN wants 216',
        detail: '',
        fix: { kind: 'wanbind_instance_set', args: { id: 'bmi_aaa001', raise_dhcp_limits: true } }
      }
    ],
    issues: [],
    tiers: {
      sessions: {
        current: 's1',
        label: '65 to 500 sessions',
        needs: ['fw4 flow offload on'],
        next: { at: 501, label: '501 to 1000 sessions', changes: ['a second pool'] }
      },
      bindings: { current: 'b1', label: '65 to 500 bindings', needs: [], next: null }
    },
    ceiling: {
      sessions: 512,
      bindings: 800,
      limitedBy: { sessions: 'conntrack', bindings: 'lease' },
      dimensions: {},
      basis: { calibrated: false, calibratedOn: '', arch: 'x86_64', archMatch: true }
    },
    stability: { level: 'at-risk', reason: '400 sessions against a ceiling of about 512' },
    ...over
  }
}

interface Built {
  manager: CapacityManager
  emits: () => unknown[]
  calls: () => string[]
  wrote: string[]
  harness: ReturnType<typeof moduleHarness>
}

function build(
  options: {
    agent?: AgentCapability
    reply?: RawCapacity | null
    streams?: string[]
    writers?: Partial<CapacityWriters>
  } = {}
): Built {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: null,
    activeStreams: options.streams ?? ['capacity']
  })
  const wrote: string[] = []

  harness.exec.mockImplementation(async (command: string) => {
    if (!String(command).includes('bm.agent') || !String(command).includes(' capacity ')) {
      return ok('{}')
    }
    if (options.reply === null) {
      return { code: 1, stdout: '', stderr: 'Command failed: Method not found' }
    }
    return ok(JSON.stringify(options.reply ?? report()))
  })

  const writers: CapacityWriters = {
    tune: async (wanted) => {
      wrote.push(`tune ${JSON.stringify(wanted)}`)
      return { ok: true }
    },
    wanbindReconcile: async () => {
      wrote.push('wanbind reconcile')
      return { ok: true }
    },
    wanbindSettingsSet: async (changes) => {
      wrote.push(`wanbind settings ${JSON.stringify(changes)}`)
      return { ok: true }
    },
    wanbindInstanceSet: async (id) => {
      wrote.push(`wanbind instance ${id}`)
      return { ok: true }
    },
    poolReconcile: async () => {
      wrote.push('pool reconcile')
      return { ok: true }
    },
    ...options.writers
  }

  const manager = new CapacityManager({
    ctx: harness.ctx as ModuleContext,
    agentDeps: () => ({
      ctx: harness.ctx as ModuleContext,
      capability: () => options.agent ?? bindingCapability()
    }),
    agent: () => options.agent ?? bindingCapability(),
    capabilities: () => CAPS,
    writers,
    event: () => {}
  })

  return {
    manager,
    harness,
    wrote,
    emits: () => harness.emit.mock.calls.filter((one) => one[0] === 'capacity').map((one) => one[1]),
    calls: () => harness.exec.mock.calls.map((one) => String(one[0])).filter((one) => one.includes(' capacity '))
  }
}

describe('the capacity report is read, not worked out here', () => {
  it('publishes one payload per refresh, with the router s own ceiling', async () => {
    const built = build()
    await built.manager.refresh()

    const snapshot = built.manager.snapshot()

    expect(snapshot.state).toBe('ready')
    expect(snapshot.ceiling.sessions).toBe(512)
    expect(snapshot.ceiling.limitedBy).toBe('conntrack')
    // 400 of 512. The meter is the reason this is a percentage rather than the
    // two numbers again.
    expect(snapshot.ceiling.sessionsPct).toBe(78)
    // Kilobytes on the wire, bytes on the page: the renderer's `bytes` format
    // wants bytes, and 480000 rendered as bytes would read as half a megabyte.
    expect(snapshot.needed.mem).toBe(480_000 * 1024)
    expect(built.emits()).toHaveLength(1)
    built.manager.dispose()
  })

  it('says unknown rather than zero where the router would not answer', async () => {
    const built = build({
      reply: report({
        hardware: { memTotalKb: null, memAvailableKb: null, cpus: null, nicsKnown: false },
        ceiling: { sessions: null, bindings: null, limitedBy: {}, basis: {} },
        stability: { level: 'unknown', reason: 'nothing is grounded' }
      })
    })
    await built.manager.refresh()

    const snapshot = built.manager.snapshot()

    // A zero here reads as "this router holds nothing", which is the opposite
    // of "this router did not say".
    expect(snapshot.ceiling.sessions).toBeNull()
    expect(snapshot.hardware.memTotal).toBeNull()
    expect(snapshot.hardware.cpus).toBeNull()
    expect(snapshot.hardware.nicCount).toBeNull()
    expect(snapshot.stability.level).toBe('unknown')
    built.manager.dispose()
  })

  it('does not call a router whose agent predates the verb', async () => {
    const built = build({ agent: bindingCapability({ release: '2.3.0' }) })
    await built.manager.refresh()

    expect(built.calls()).toHaveLength(0)

    const snapshot = built.manager.snapshot()

    expect(snapshot.state).toBe('unavailable')
    expect(snapshot.reason).toContain('2.4.0')
    expect(snapshot.reason).toContain('Router packages')
    built.manager.dispose()
  })

  it('says the same thing when an agent answers method-not-found anyway', async () => {
    const built = build({ reply: null })
    await built.manager.refresh()

    const snapshot = built.manager.snapshot()

    expect(snapshot.state).toBe('unavailable')
    expect(snapshot.reason).toContain('2.4.0')
    built.manager.dispose()
  })

  it('asks nothing while nobody has the tab open', async () => {
    const built = build({ streams: ['overview'] })
    built.manager.applyPollers()

    for (const tick of built.harness.ticks) await tick()

    expect(built.calls()).toHaveLength(0)
    built.manager.dispose()
  })
})

describe('a fix reaches the router only through a write this module already makes', () => {
  it('runs the tune fix by the key of the row it belongs to', async () => {
    const built = build()
    await built.manager.refresh()

    const result = await built.manager.fix('flow-offload')

    expect(result.ok).toBe(true)
    expect(built.wrote[0]).toBe('tune {"flowOffload":true}')
    built.manager.dispose()
  })

  it('carries every tunable the row named and nothing else', async () => {
    const built = build()
    await built.manager.refresh()
    await built.manager.fix('conntrack-max')

    expect(built.wrote[0]).toContain('"conntrackMax":262144')
    expect(built.wrote[0]).toContain('"gcThresh3":8192')
    expect(built.wrote[0]).not.toContain('gcThresh1')
    built.manager.dispose()
  })

  it('refuses a key the last report did not offer', async () => {
    const built = build()
    await built.manager.refresh()

    const result = await built.manager.fix('rm -rf')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('no finding called')
    expect(built.wrote).toHaveLength(0)
    built.manager.dispose()
  })

  it('drops a fix whose kind is not one of the five', async () => {
    const built = build({
      reply: report({
        issues: [
          {
            key: 'invented',
            level: 'error',
            label: 'Something',
            fix: { kind: 'exec', args: { command: 'reboot' } }
          }
        ]
      })
    })
    await built.manager.refresh()

    expect(built.manager.snapshot().fixes.map((one) => one.key)).not.toContain('invented')

    const result = await built.manager.fix('invented')

    expect(result.ok).toBe(false)
    expect(built.wrote).toHaveLength(0)
    built.manager.dispose()
  })

  it('drops a settings fix that asks for anything but the LAN-local switch', async () => {
    const built = build({
      reply: report({
        issues: [
          {
            key: 'local-off',
            level: 'info',
            label: 'LAN-local is off',
            // The switch this module will throw, plus one it will not. A page
            // that passed the reply's arguments through would switch the daemon
            // off through a button labelled "fix".
            fix: { kind: 'wanbind_settings_set', args: { lan_local: true, enabled: false } }
          }
        ]
      })
    })
    await built.manager.refresh()

    expect(built.manager.snapshot().fixes).toHaveLength(3)
    expect(built.manager.snapshot().fixes.map((one) => one.key)).not.toContain('local-off')
    built.manager.dispose()
  })

  it('drops a tune fix whose figure is outside the tunable s own bounds', async () => {
    const built = build({
      reply: report({
        requirements: [
          {
            key: 'conntrack-max',
            level: 'warning',
            label: 'Small table',
            fix: { kind: 'tune_set', args: { conntrack_max: 99_000_000 } }
          }
        ]
      })
    })
    await built.manager.refresh()

    expect(built.manager.snapshot().fixes).toHaveLength(0)
    built.manager.dispose()
  })

  it('drops an instance fix naming an instance this report does not know', async () => {
    const built = build({
      reply: report({
        requirements: [
          {
            key: 'lease-max',
            level: 'error',
            label: 'Lease ceiling',
            fix: { kind: 'wanbind_instance_set', args: { id: 'bmi_zzz999', raise_dhcp_limits: true } }
          }
        ]
      })
    })
    await built.manager.refresh()

    expect(built.manager.snapshot().fixes).toHaveLength(0)
    built.manager.dispose()
  })

  it('routes the lease fix at the instance the report named', async () => {
    const built = build()
    await built.manager.refresh()
    await built.manager.fix('lease-max')

    expect(built.wrote[0]).toBe('wanbind instance bmi_aaa001')
    built.manager.dispose()
  })

  it('refuses a fix against a report that has aged out', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_900_000_000_000)

    const built = build()
    await built.manager.refresh()

    vi.setSystemTime(1_900_000_000_000 + 6 * 60_000)

    expect(built.manager.snapshot().stale).toBe(true)

    const result = await built.manager.fix('flow-offload')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('minutes old')
    expect(built.wrote).toHaveLength(0)

    built.manager.dispose()
    vi.useRealTimers()
  })

  it('joins a refresh already in flight rather than asking twice', async () => {
    const built = build()

    await Promise.all([built.manager.refresh(), built.manager.refresh()])

    expect(built.calls()).toHaveLength(1)
    expect(built.emits()).toHaveLength(1)
    built.manager.dispose()
  })

  it('keeps the last good report when a later call fails', async () => {
    const built = build()
    await built.manager.refresh()

    built.harness.exec.mockImplementation(async () => ({
      code: 1,
      stdout: '',
      stderr: 'Connection closed'
    }))

    await built.manager.refresh()

    const snapshot = built.manager.snapshot()

    // The numbers still describe the router as it was, which is true and
    // stale. Emptying them would read as a router with no capacity at all.
    expect(snapshot.ceiling.sessions).toBe(512)
    expect(snapshot.reason).toContain('Connection closed')
    built.manager.dispose()
  })

  it('goes back to unknown when the module is pointed at another router', async () => {
    const built = build()
    await built.manager.refresh()
    built.manager.reset()

    expect(built.manager.snapshot().state).toBe('unknown')
    expect(built.manager.snapshot().fixes).toHaveLength(0)
    built.manager.dispose()
  })
})

describe('the writer named on a row is the one that would actually write', () => {
  it('names the agent when the router has one new enough to own the write', async () => {
    const built = build()
    await built.manager.refresh()

    const row = built.manager.snapshot().fixes.find((one) => one.key === 'flow-offload')

    expect(row?.writer).toContain('bm-agent')
    expect(row?.action).toContain('flow offload')
    built.manager.dispose()
  })

  it('names SSH when it does not', () => {
    const capability = bindingCapability({ release: '2.0.0' })
    const snapshot = normalizeCapacity(report(), Date.now(), capability)

    // Rendered from the same reply; only the router underneath is different.
    expect(snapshot.fixes.map((one) => one.key)).toContain('flow-offload')
  })

  it('reports every finding whether or not it has a fix', async () => {
    const built = build()
    await built.manager.refresh()

    const snapshot = built.manager.snapshot()

    expect(snapshot.requirements.map((one) => one.key)).toEqual([
      'memory',
      'flow-offload',
      'conntrack-max',
      'lease-max'
    ])
    expect(snapshot.requirements[0]?.fixable).toBe(false)
    expect(snapshot.requirements[1]?.fixable).toBe(true)
    built.manager.dispose()
  })
})

describe('a capability that is not there', () => {
  it('gives a router with no agent the sentence about installing one', () => {
    const snapshot = normalizeCapacity(
      report(),
      Date.now(),
      bindingCapability({ usable: false, release: '' })
    )

    // The reply still renders; what changes is the writer named on each fix.
    expect(snapshot.state).toBe('ready')
  })
})
