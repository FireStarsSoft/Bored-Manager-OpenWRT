import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import type { DirectRow, DirectSnapshot } from '../../openwrt/main/wanbind'
import { handoverNotice } from '../../openwrt/main/wanbind'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import { BINDING_AGENT_INFO, isProbeCommand, routerProbeOutput } from '../helpers/router'
import { binding, fakeWanbind, wanbindHandover, type WanbindDaemon } from '../helpers/wanbind'

/**
 * Which half keeps the one-to-one bindings, and what happens to the ones this
 * module wrote before the router could keep any.
 *
 * The answer to the first is now unconditional: **the router keeps them, and
 * this module writes nothing.** There is no SSH half left to fall back to, and
 * that is deliberate rather than unfinished - the two halves shared the
 * one-to-one priority band, the daemon removes every rule in it that no `config
 * direct` section asks for, and this module wrote rules there without ever
 * writing a section. On a real router that was 34 rules deleted every thirty
 * seconds and written back a second later, for ever, with each bound address on
 * the router's default connection for about a second in every thirty and
 * neither half reporting a conflict, because each was doing exactly what it had
 * been told. A fall back to writing is not a safety net here; it is that fault
 * with a nicer name.
 *
 * The second question is the one with teeth. `bm-wanbind` sweeps its own band
 * on every pass, so a router handed packages 2.4.0 while carrying
 * module-written bindings loses every one of those rules within a pass whatever
 * this module decides to do. "Wait and let the operator choose" is therefore
 * not the cautious answer - it is the answer where the records survive and the
 * routing quietly stops. The handover is what makes the changeover survivable,
 * and half of what follows is about it doing so without ever writing a rule of
 * its own.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** One binding this module created, at the priority its rule stands at. */
const RECORD = {
  id: 'dir_a1',
  name: 'Workshop',
  target: { kind: 'ip', ip: '10.0.0.11' },
  wan: 'wan1',
  enabled: true,
  whenDown: 'hold',
  pref: 19_000,
  table: 101,
  lan: 'lan',
  slot: 0,
  createdAt: 1_700_000_000_000
}

/** The name the router knows it by; `bm` plus the record id, as instances are. */
const SECTION = 'bmdir_a1'

function host(direct: unknown[] = [RECORD]): Record<string, unknown> {
  return {
    version: 3,
    instances: [],
    direct,
    extraTables: [['wan1', 101, 'dir_a1']],
    stickyMap: [],
    events: [],
    moduleEvents: [],
    jobs: []
  }
}

/**
 * One LAN with an address, one WAN with a table, and one lease on it.
 *
 * `===RULESOK===` has to say 1 or the sweep reads as "the router would not
 * answer about its rules", no model is produced at all, and every assertion
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
      '1900000000 aa:bb:cc:dd:ee:01 10.0.0.11 workshop *',
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
            proto: 'pppoe',
            device: 'eth1',
            l3_device: 'pppoe-wan1',
            up: true,
            'ipv4-address': [{ address: '203.0.113.5', mask: 32 }],
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
  sweep(): Promise<void>
  commands(): string[]
  /** A rule write would run as one `sh -s` script, so the verbs are on stdin. */
  stdins(): string[]
  rows(): Promise<DirectRow[]>
  snapshot(): DirectSnapshot | undefined
  dispose(): void
}

/** The whole module over a faked `bm.wanbind`, the way the app runs it. */
async function router(
  options: {
    agent?: Record<string, unknown>
    hostData?: Record<string, unknown>
    daemon?: WanbindDaemon
  } = {}
): Promise<Router> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: options.hostData ?? host([]),
    config: sharedModuleConfig(null)
  })
  const daemon = options.daemon ?? fakeWanbind()

  harness.exec.mockImplementation(async (command) => {
    if (isProbeCommand(command)) {
      return ok(routerProbeOutput({ agent: options.agent ?? BINDING_AGENT_INFO }))
    }
    const answered = daemon.answer(command)
    if (answered) return answered
    if (command.includes("echo '===SYS==='")) return sweepAnswer()
    return ok()
  })

  const runtime = activate(harness.ctx)
  runtime.applyPollers?.()
  await settle()

  return {
    harness,
    daemon,
    call: async (method, ...args) => harness.handlers.get(method)?.(...args),
    sweep: async () => {
      for (const tick of harness.ticks) await tick()
      await settle(30)
    },
    commands: () => harness.exec.mock.calls.map((call) => String(call[0])),
    stdins: () =>
      harness.exec.mock.calls.map((call) => String((call[1] as { stdin?: string })?.stdin ?? '')),
    rows: async () => (await harness.handlers.get('directRows')?.()) as DirectRow[],
    snapshot: () => {
      const pushed = harness.emit.mock.calls.filter((call) => call[0] === 'direct')
      return pushed.at(-1)?.[1] as DirectSnapshot | undefined
    },
    dispose: () => runtime.dispose?.()
  }
}

/** Nothing anywhere in this module wrote to the kernel's rule table. */
function wroteNoRule(owrt: Router): boolean {
  const everything = [...owrt.commands(), ...owrt.stdins()].join('\n')
  return !everything.includes('ip -4 rule add') && !everything.includes('ip -4 rule del')
}

describe('a router that keeps its own one-to-one bindings', () => {
  it('reads them over ubus and writes no ip rule at all', async () => {
    const owrt = await router({ daemon: fakeWanbind({ bindings: [binding()] }) })
    await owrt.sweep()

    expect(owrt.daemon.count('bindings')).toBeGreaterThan(0)
    // The whole point. The daemon owns every priority in the band and sweeps
    // what no section of its own asks for, so a single rule written from here
    // is two writers deleting each other's work on two timers.
    expect(wroteNoRule(owrt)).toBe(true)
    owrt.dispose()
  })

  it("shows the router's own bindings, with the daemon's reasoning on the row", async () => {
    const owrt = await router({
      daemon: fakeWanbind({
        bindings: [
          binding({
            id: SECTION,
            state: 'held',
            table: 29_999,
            parkedBy: 'catch-all',
            reason: 'wan1 has been down for 4 minutes and this binding holds when its WAN is down'
          })
        ]
      })
    })
    await owrt.sweep()

    const rows = await owrt.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(SECTION)
    expect(rows[0]?.state).toBe('held')
    // The stamped table in the column, the live one in the rule - the two can
    // differ here, because the daemon re-points a WAN that changed table and
    // this module never could.
    expect(rows[0]?.table).toBe(101)
    expect(rows[0]?.rule).toBe('from 10.0.0.11/32 lookup 29999 pref 19000')
    expect(rows[0]?.reason).toContain('holds when its WAN is down')
    // Prose, and prose only: the chips come from `state`, which is a code.
    expect(rows[0]?.stateBadges.map((chip) => chip.label)).toEqual(['held', 'no way out'])
    owrt.dispose()
  })

  it('does not fall back to writing rules when the router will not answer', async () => {
    const daemon = fakeWanbind()
    daemon.on('bindings', () => ok('', 'Command failed: Not found', 1))
    const owrt = await router({ daemon })
    await owrt.sweep()

    // Rows one tick stale, which the snapshot says, and nothing else. Falling
    // back would be the second writer this boundary exists to prevent.
    expect(wroteNoRule(owrt)).toBe(true)
    const snapshot = owrt.snapshot()
    expect(snapshot?.hookOk).toBe(false)
    expect(snapshot?.lastError).not.toBe('')
    owrt.dispose()
  })

  it('deletes through the daemon, and never with an ip rule del', async () => {
    const owrt = await router({ daemon: fakeWanbind({ bindings: [binding({ id: SECTION })] }) })
    await owrt.sweep()

    const result = (await owrt.call('directDelete', SECTION)) as OkResult
    expect(result.ok).toBe(true)
    await settle(30)

    expect(owrt.daemon.payloads('unbind')[0]).toEqual({ id: SECTION })
    expect(wroteNoRule(owrt)).toBe(true)
    owrt.dispose()
  })

  it('switches one off by writing the section again, not by removing a rule', async () => {
    const owrt = await router({ daemon: fakeWanbind({ bindings: [binding({ id: SECTION })] }) })
    await owrt.sweep()

    await owrt.call('directDisable', SECTION)
    await settle(30)

    const sent = owrt.daemon.payloads('bind').at(-1)
    expect(sent?.enabled).toBe(false)
    // The fields that identify the binding come back from the router's own
    // answer, because the router is the one that knows what the binding is.
    expect(sent?.ip).toBe('10.0.0.11')
    expect(sent?.wan).toBe('wan1')
    // And nothing is stamped on the way past: the priority the rule already
    // stands at is not this module's to re-derive.
    expect(sent).not.toHaveProperty('pref')
    expect(wroteNoRule(owrt)).toBe(true)
    owrt.dispose()
  })
})

describe('the bindings this module wrote, on the day the router learns to keep them', () => {
  /** The one-to-one records still in the document, by the id the module gave them. */
  const kept = (run: ReturnType<typeof wanbindHandover>): string[] =>
    run.store.read().direct.map((entry) => entry.id)

  it('hands each one over at the priority its rule already stands at', async () => {
    const run = wanbindHandover({ hostData: host() })

    const outcome = await run.run()

    expect(outcome).toMatchObject({ wrote: 1, dropped: 1, stranded: [] })
    const sent = (run.daemon.payloads('bind_many')[0]?.bindings ?? []) as Array<
      Record<string, unknown>
    >
    expect(sent).toHaveLength(1)
    expect(sent[0]?.id).toBe(SECTION)
    // Stamped, not allocated. The rule on the router right now was written at
    // 19000, and sending the number is what makes the daemon adopt that rule
    // rather than write a second one somewhere else.
    expect(sent[0]?.pref).toBe(19_000)
    expect(sent[0]?.table).toBe(101)
    expect(sent[0]?.ip).toBe('10.0.0.11')
    expect(sent[0]?.wan).toBe('wan1')
    expect(sent[0]?.lan).toBe('lan')
    expect(sent[0]?.when_down).toBe('hold')
    // Handing over is not writing: every command it sent was a ubus call.
    expect(
      run.harness.exec.mock.calls
        .map((call) => String(call[0]))
        .every((command) => command.startsWith('ubus -S call bm.wanbind '))
    ).toBe(true)
    run.dispose()
  })

  it('forgets the record once the router confirms it, and does not send it twice', async () => {
    const run = wanbindHandover({ hostData: host() })

    await run.run()
    await run.run()

    expect(run.daemon.count('bind_many')).toBe(1)
    expect(kept(run)).toEqual([])
    // The claim on the WAN's routing table goes with it. The `option ip4table`
    // stays on the router - the daemon never takes one back either - but which
    // record may remove it is no longer a question this module answers.
    expect(run.store.read().extraTables).toEqual([])
    run.dispose()
  })

  it('keeps the record, and says why, when the router will not take it', async () => {
    const daemon = fakeWanbind()
    daemon.on('bind', () => ({
      ok: false,
      reason: 'pref 19000 is not below binding instance bmi1, which numbers its clients from 19000'
    }))
    const run = wanbindHandover({ hostData: host(), daemon })

    const outcome = await run.run()

    // The record survives, because it is the only description there is of a
    // binding the operator created - and the next pass offers it again, so
    // fixing the reason is all that is needed.
    expect(kept(run)).toEqual(['dir_a1'])
    expect(outcome.dropped).toBe(0)
    expect(outcome.stranded).toEqual([
      {
        kind: 'binding',
        id: SECTION,
        name: 'Workshop',
        reason: expect.stringContaining('not below binding instance')
      }
    ])

    const notice = handoverNotice(outcome, 'binding')
    expect(notice).toContain('Workshop')
    // The sentence has to say what has happened to the traffic, not only that
    // something went wrong.
    expect(notice).toContain('nothing on either side is maintaining it')
    run.dispose()
  })

  it('keeps it too when the router took the section and then refused to read it', async () => {
    // The other half of a refusal, and the one that produces two ids for one
    // binding if it is got wrong: the write succeeded, so the daemon has a row
    // for it - and that row says its own configuration reader threw the section
    // out, which installs no rule and seats nobody.
    const daemon = fakeWanbind()
    daemon.on('bind', (args) => ({
      ok: true,
      binding: binding({
        id: String(args.id ?? ''),
        usable: false,
        state: 'refused',
        table: 0,
        ip: '',
        reason: 'table 101 is the catch-all table of binding instance bmi1'
      })
    }))
    const run = wanbindHandover({ hostData: host(), daemon })

    const outcome = await run.run()

    expect(kept(run)).toEqual(['dir_a1'])
    expect(outcome.stranded[0]?.reason).toContain('catch-all table')
    expect(handoverNotice(outcome, 'binding')).toContain('Workshop')
    run.dispose()
  })

  it('writes no rule for a binding the router refused, however many passes it takes', async () => {
    const daemon = fakeWanbind()
    daemon.on('bind', () => ({
      ok: false,
      reason: "the WAN it names is one of this router's own LANs"
    }))
    const run = wanbindHandover({ hostData: host(), daemon })

    await run.run()
    await run.run()

    // The temptation is to keep steering the address from here until the router
    // takes it. It is the wrong answer: the daemon sweeps this band, so the
    // rule would be removed under us and re-added on our next tick, for ever.
    const everything = run.harness.exec.mock.calls.map((call) => String(call[0])).join('\n')
    expect(everything).not.toContain('ip -4 rule add')
    expect(kept(run)).toEqual(['dir_a1'])
    run.dispose()
  })

  it('says nothing is being maintained on a router with no daemon to hand them to', async () => {
    // Not a refusal and not a failed call: this router simply has not been given
    // the packages. The rules it was left with are still standing and still
    // steering traffic - what has stopped is anything reacting to a change.
    const run = wanbindHandover({
      hostData: host(),
      capability: {
        installed: false,
        running: false,
        release: '',
        apiVersion: 0,
        schema: 0,
        dataSchema: null,
        provides: [],
        features: [],
        guard: null,
        usable: false,
        problem: null,
        canGuard: false,
        canUpdate: false
      }
    })

    const outcome = await run.run()

    expect(run.daemon.calls).toEqual([])
    expect(outcome.stalled).toEqual({ instances: 0, bindings: 1 })
    expect(kept(run)).toEqual(['dir_a1'])
    const notice = handoverNotice(outcome, 'binding')
    expect(notice).toContain('The ip rules it was given still stand exactly as they were')
    expect(notice).toContain('Installing the router packages hands it over by itself')
    run.dispose()
  })

  it('says the band is unusable rather than offering a form nothing can satisfy', async () => {
    const daemon = fakeWanbind({
      band: {
        base: 19_000,
        span: 1_000,
        top: 19_999,
        reason:
          'the band reaches into binding instance bmi1, which numbers its clients from 19500',
        usable: false
      }
    })
    // The daemon refuses the create for the same reason, and its sentence is
    // shown rather than argued with - a check that disagreed with the apply
    // would be worse than no check at all.
    daemon.on('bind_check', () => ({
      ok: false,
      findings: [
        {
          level: 'error',
          label: 'The router will not allocate a rule priority for this binding',
          detail: 'the band reaches into binding instance bmi1'
        }
      ]
    }))
    const owrt = await router({ daemon })
    await owrt.sweep()

    expect(owrt.snapshot()?.notice).toContain('will not allocate one-to-one rule priorities')

    const report = (await owrt.call('directCheck', {
      name: 'Bench',
      targetKind: 'ip',
      address: '10.0.0.12',
      wan: 'wan1',
      whenDown: 'hold'
    })) as { ok: boolean; findings: Array<{ level: string; label: string }> }

    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (finding) =>
          finding.level === 'error' && finding.label.includes('will not allocate a rule priority')
      )
    ).toBe(true)
    owrt.dispose()
  })
})

describe('creating a binding on a router that keeps its own', () => {
  it('asks the daemon for it, and stamps neither the priority nor the table', async () => {
    const daemon = fakeWanbind()
    daemon.on('bind_check', () => ({
      ok: true,
      findings: [
        { level: 'pass', label: '10.0.0.12 is on LAN lan (10.0.0.0/24)' },
        { level: 'pass', label: 'wan1 has routing table 101' }
      ]
    }))
    const owrt = await router({ daemon })
    await owrt.sweep()

    const values = {
      name: 'Bench',
      targetKind: 'ip',
      address: '10.0.0.12',
      wan: 'wan1',
      whenDown: 'fallback'
    }
    const report = (await owrt.call('directCheck', values)) as {
      ok: boolean
      token?: string
      findings: Array<{ label: string; detail?: string }>
    }

    expect(report.ok).toBe(true)
    // The router's own reading of itself, shown as the report's own findings.
    expect(report.findings.map((finding) => finding.label)).toContain(
      '10.0.0.12 is on LAN lan (10.0.0.0/24)'
    )

    await owrt.call('directApply', { token: report.token, values })
    await settle(40)

    const sent = owrt.daemon.payloads('bind').at(-1)
    expect(sent?.ip).toBe('10.0.0.12')
    expect(sent?.wan).toBe('wan1')
    expect(sent?.when_down).toBe('fallback')
    // A create has no rule standing anywhere for a number to have to match, and
    // the daemon allocates from a band this module cannot see - so a guess here
    // is the one way to collide with a binding made at a router shell.
    expect(sent).not.toHaveProperty('pref')
    expect(sent).not.toHaveProperty('table')

    // Nothing was written to the kernel or to /etc/config/network from here.
    // The daemon writes `option ip4table` itself, from netifd's live answer;
    // two writers of one option are two numbers that do not have to agree.
    expect(wroteNoRule(owrt)).toBe(true)
    expect(owrt.commands()).not.toContain('uci batch')
    owrt.dispose()
  })
})
