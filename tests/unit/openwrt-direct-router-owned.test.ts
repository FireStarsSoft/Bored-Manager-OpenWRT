import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import type { DirectRow, DirectSnapshot } from '../../openwrt/main/direct'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import { AGENT_INFO, isProbeCommand, routerProbeOutput } from '../helpers/router'

/**
 * Which half keeps the one-to-one bindings, and what happens to the ones this
 * module wrote before the router could keep any.
 *
 * The boundary is `binding/router.ts`'s, one folder over, with one difference
 * the owner chose: for instances the module keeps the records and the daemon
 * keeps the assignment, and for one-to-one bindings **the router keeps the
 * binding itself**. So the tests below are about three things - that this
 * module writes nothing at all on a router that owns them, that it goes on
 * working exactly as it always did on a router that does not, and that a
 * binding created before the changeover survives it.
 *
 * That last one is the part with teeth. `bm-wanbind` reads back every ip rule
 * in its own one-to-one band on every pass and removes the ones no `config
 * direct` section asks for - and it ships with the band this module ships with.
 * So a router handed the new package while carrying module-written bindings
 * loses every one of them within a pass, whatever this module decides to do.
 * "Wait and let the operator choose" is therefore not the cautious answer here;
 * it is the answer where the records survive and the routing quietly stops. The
 * handover is what makes the changeover survivable, and half of what follows is
 * about it doing so without ever writing a rule of its own.
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

/** bm-wanbind 2.3.0: it owns instances, and now the one-to-one bindings too. */
const DIRECT_AGENT: Record<string, unknown> = {
  ...AGENT_INFO,
  release: '2.3.0',
  schema: 2,
  dataSchema: 2,
  provides: ['binding', 'direct'],
  features: [
    { name: 'bm-wanbind', version: '2.3.0', apiVersion: 1, provides: ['binding', 'direct'] }
  ]
}

/** The release before it, which owns instances and nothing else. */
const OLD_AGENT: Record<string, unknown> = {
  ...AGENT_INFO,
  release: '2.2.0',
  schema: 2,
  dataSchema: 2,
  provides: ['binding'],
  features: [{ name: 'bm-wanbind', version: '2.2.0', apiVersion: 1, provides: ['binding'] }]
}

const BAND = { base: 19_000, span: 1_000, top: 19_999, reason: null, usable: true }

/**
 * The /etc/config the create gate reads: a bridged LAN that serves DHCP, one
 * uplink that switches its own dnsmasq section off, and a masquerading wan
 * zone. Stock OpenWrt, so the classifier settles both interfaces outright and
 * nothing below is refused for a reason this file is not about.
 */
const PREPARATION = [
  '===DHCP===',
  'dhcp.lan=dhcp',
  "dhcp.lan.interface='lan'",
  "dhcp.lan.limit='150'",
  'dhcp.wan1=dhcp',
  "dhcp.wan1.interface='wan1'",
  "dhcp.wan1.ignore='1'",
  '===NETWORK===',
  'network.lan=interface',
  "network.lan.ip6assign='60'",
  'network.wan1=interface',
  "network.wan1.ip4table='101'",
  '===FIREWALL===',
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan'",
  'firewall.@zone[1]=zone',
  "firewall.@zone[1].name='wan'",
  "firewall.@zone[1].network='wan1'",
  "firewall.@zone[1].masq='1'",
  '===SYSCTL===',
  'net.netfilter.nf_conntrack_max=65536'
].join('\n')

/** One binding as the daemon reports it, with the fields a row is built from. */
function reported(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SECTION,
    name: 'Workshop',
    enabled: true,
    usable: true,
    targetKind: 'ip',
    label: '10.0.0.11',
    wan: 'wan1',
    lan: 'lan',
    lanCidr: '10.0.0.0/24',
    lanZone: 'lan',
    wanZone: 'wan',
    whenDown: 'hold',
    pref: 19_000,
    table: 101,
    stampedTable: 101,
    wanTable: 101,
    state: 'bound',
    ip: '10.0.0.11',
    since: 1_700_000_000,
    reason: '',
    shadowedBy: '',
    forwarding: 'ok',
    needsForwarding: false,
    needsTable: false,
    evidence: '',
    ...overrides
  }
}

/**
 * One LAN with an address, one WAN with a table, and one lease on it.
 *
 * `===RULESOK===` has to say 1 or the sweep reads as "the router would not
 * answer about its rules", no model is produced at all, and every assertion
 * below would pass for the wrong reason.
 */
function sweepAnswer(rules: readonly string[] = []): ModuleExecResult {
  return ok(
    [
      '===SYS===',
      JSON.stringify({ uptime: 3600, load: [0, 0, 0], memory: { total: 1, free: 1 } }),
      '===DEV===',
      '===POOL=== 0 0 0',
      '===LEASES===',
      '1900000000 aa:bb:cc:dd:ee:01 10.0.0.11 workshop *',
      '===RULES===',
      ...rules,
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
  call(method: string, ...args: unknown[]): Promise<unknown>
  sweep(): Promise<void>
  commands(): string[]
  /** A rule write runs as one `sh -s` script, so the verbs are on stdin. */
  stdins(): string[]
  /** The JSON argument of every `ubus call bm.wanbind <method>` seen. */
  payloads(method: string): Array<Record<string, unknown>>
  rows(): Promise<DirectRow[]>
  snapshot(): DirectSnapshot | undefined
  /** Every host document this module wrote, oldest first. */
  written: Array<Record<string, unknown>>
  dispose(): void
}

async function router(
  options: {
    agent?: Record<string, unknown>
    hostData?: Record<string, unknown>
    /** The daemon's binding list, which the fixtures mutate as calls land. */
    bindings?: Array<Record<string, unknown>>
    band?: Record<string, unknown>
    answer?: (command: string, stdin: string) => ModuleExecResult | null
  } = {}
): Promise<Router> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: options.hostData ?? host(),
    config: sharedModuleConfig(null)
  })

  // The module's own writes to the per-router document, which is the only way
  // to see a record being forgotten - the harness records the call but does not
  // publish it.
  const written: Array<Record<string, unknown>> = []
  const context = harness.ctx as unknown as { hostDataSet(value: unknown): void }
  const realSet = context.hostDataSet.bind(harness.ctx)
  context.hostDataSet = (value: unknown) => {
    written.push(value as Record<string, unknown>)
    realSet(value)
  }

  const bindings = options.bindings ?? []
  const band = options.band ?? BAND

  harness.exec.mockImplementation(async (command, execOptions) => {
    if (isProbeCommand(command)) {
      return ok(routerProbeOutput({ agent: options.agent ?? DIRECT_AGENT }))
    }
    const stdin = execOptions?.stdin ?? ''
    const answered = options.answer?.(command, stdin)
    if (answered) return answered
    if (stdin.includes("echo '===DHCP==='")) return ok(PREPARATION)
    if (command.includes('ubus -S call bm.wanbind bindings')) {
      return ok(JSON.stringify({ bindings, band }))
    }
    if (command.includes('ubus -S call bm.wanbind bind ')) {
      const sent = payload(command)
      const row = reported({
        id: String(sent.id ?? ''),
        name: String(sent.name ?? ''),
        pref: Number(sent.pref ?? BAND.base),
        table: Number(sent.table ?? 0),
        stampedTable: Number(sent.table ?? 0),
        enabled: sent.enabled !== false,
        state: sent.enabled === false ? 'disabled' : 'bound',
        whenDown: String(sent.when_down ?? 'hold'),
        ...(sent.mac ? { targetKind: 'mac', label: String(sent.mac) } : {}),
        ...(sent.ip ? { targetKind: 'ip', label: String(sent.ip) } : {})
      })
      const at = bindings.findIndex((entry) => entry.id === row.id)
      if (at >= 0) bindings[at] = row
      else bindings.push(row)
      return ok(JSON.stringify({ ok: true, binding: row }))
    }
    if (command.includes('ubus -S call bm.wanbind unbind')) {
      const sent = payload(command)
      const at = bindings.findIndex((entry) => entry.id === sent.id)
      if (at >= 0) bindings.splice(at, 1)
      return ok(JSON.stringify({ ok: true, id: sent.id, removed: 1, swept: 0, reason: null }))
    }
    if (command.includes('ubus -S call bm.wanbind assignments')) {
      return ok(JSON.stringify({ assignments: [] }))
    }
    if (command.includes('ubus -S call bm.wanbind waiting')) {
      return ok(JSON.stringify({ waiting: [] }))
    }
    if (command.includes('ubus -S call bm.wanbind')) return ok(JSON.stringify({ ok: true }))
    if (command.includes('uci -q show bm_wanbind')) return ok('')
    if (command.includes("echo '===SYS==='")) return sweepAnswer()
    return ok()
  })

  const runtime = activate(harness.ctx)
  runtime.applyPollers?.()
  await settle()

  const commands = (): string[] => harness.exec.mock.calls.map((call) => String(call[0]))

  return {
    harness,
    written,
    call: async (method, ...args) => harness.handlers.get(method)?.(...args),
    sweep: async () => {
      for (const tick of harness.ticks) await tick()
      await settle(30)
    },
    commands,
    stdins: () =>
      harness.exec.mock.calls.map((call) => String((call[1] as { stdin?: string })?.stdin ?? '')),
    payloads: (method) =>
      commands()
        .filter((command) => command.includes(`ubus -S call bm.wanbind ${method} `))
        .map(payload),
    rows: async () => (await harness.handlers.get('directRows')?.()) as DirectRow[],
    snapshot: () => {
      const pushed = harness.emit.mock.calls.filter((call) => call[0] === 'direct')
      return pushed.at(-1)?.[1] as DirectSnapshot | undefined
    },
    dispose: () => runtime.dispose?.()
  }
}

/**
 * Whether the record survived every write of the per-router document.
 *
 * The last write is not enough on its own: a record dropped and something else
 * saved afterwards would leave the same final shape as one that was never
 * dropped at all, so every document this module wrote has to still describe it.
 */
function kept(owrt: Router): boolean {
  return owrt.written.every((document) => (document.direct as unknown[]).length === 1)
}

/** The one JSON document a ubus call carries, unquoted. */
function payload(command: string): Record<string, unknown> {
  const opened = command.indexOf("'")
  const closed = command.lastIndexOf("'")
  if (opened < 0 || closed <= opened) return {}
  return JSON.parse(command.slice(opened + 1, closed)) as Record<string, unknown>
}

describe('a router that keeps its own one-to-one bindings', () => {
  it('reads them over ubus and writes no ip rule at all', async () => {
    const owrt = await router({ hostData: host([]), bindings: [reported()] })
    await owrt.sweep()

    expect(owrt.commands().join('\n')).toContain('ubus -S call bm.wanbind bindings')
    // The whole point. The daemon owns every priority in the band and sweeps
    // what no section of its own asks for, so a single rule written from here
    // is two writers deleting each other's work on two timers.
    expect(owrt.stdins().join('\n')).not.toContain('ip -4 rule add')
    expect(owrt.stdins().join('\n')).not.toContain('ip -4 rule del')
    owrt.dispose()
  })

  it('shows the router\'s own bindings, with the daemon\'s reasoning on the row', async () => {
    const owrt = await router({
      hostData: host([]),
      bindings: [
        reported({
          state: 'held',
          table: 29_999,
          reason: 'wan1 has been down for 4 minutes and this binding holds when its WAN is down'
        })
      ]
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
    expect(owrt.snapshot()?.routerOwned).toBe(true)
    owrt.dispose()
  })

  it('does not fall back to writing rules when the router will not answer', async () => {
    const owrt = await router({
      answer: (command) =>
        command.includes('ubus -S call bm.wanbind bindings')
          ? ok('', 'Command failed: Not found', 1)
          : null
    })
    await owrt.sweep()

    // Rows one tick stale, which the snapshot says, and nothing else. Falling
    // back would be the second writer this boundary exists to prevent.
    expect(owrt.stdins().join('\n')).not.toContain('ip -4 rule add')
    const snapshot = owrt.snapshot()
    expect(snapshot?.hookOk).toBe(false)
    expect(snapshot?.lastError).not.toBe('')
    owrt.dispose()
  })

  it('deletes through the daemon, and never with an ip rule del', async () => {
    const owrt = await router({ hostData: host([]), bindings: [reported()] })
    await owrt.sweep()

    const result = (await owrt.call('directDelete', SECTION)) as OkResult
    expect(result.ok).toBe(true)
    await settle(30)

    expect(owrt.payloads('unbind')[0]).toEqual({ id: SECTION })
    expect(owrt.stdins().join('\n')).not.toContain('ip -4 rule del')
    owrt.dispose()
  })

  it('switches one off by writing the section again, not by removing a rule', async () => {
    const owrt = await router({ hostData: host([]), bindings: [reported()] })
    await owrt.sweep()

    await owrt.call('directDisable', SECTION)
    await settle(30)

    const sent = owrt.payloads('bind').at(-1)
    expect(sent?.enabled).toBe(false)
    // The fields that identify the binding come back from the router's own
    // answer, because the router is the one that knows what the binding is.
    expect(sent?.ip).toBe('10.0.0.11')
    expect(sent?.wan).toBe('wan1')
    // And nothing is stamped on the way past: the priority the rule already
    // stands at is not this module's to re-derive.
    expect(sent).not.toHaveProperty('pref')
    // `ip -4 rule show` is the fast sweep reading the router and runs either
    // way; a write is what may not happen here.
    expect(owrt.stdins().join('\n')).not.toContain('ip -4 rule add')
    expect(owrt.stdins().join('\n')).not.toContain('ip -4 rule del')
    owrt.dispose()
  })
})

describe('a router whose package cannot keep them', () => {
  it('binds over SSH exactly as it always did', async () => {
    // The agent is there and owns instances; one-to-one bindings are a release
    // newer. A router that has not been updated must not lose the feature.
    const owrt = await router({ agent: OLD_AGENT })
    await owrt.sweep()

    expect(owrt.commands().join('\n')).not.toContain('ubus -S call bm.wanbind bindings')
    expect(owrt.stdins().join('\n')).toContain('ip -4 rule add from 10.0.0.11/32')
    const rows = await owrt.rows()
    expect(rows.map((row) => row.id)).toEqual(['dir_a1'])
    expect(owrt.snapshot()?.routerOwned).toBe(false)
    owrt.dispose()
  })
})

describe('the bindings this module wrote, on the day the router learns to keep them', () => {
  it('hands each one over at the priority its rule already stands at', async () => {
    const owrt = await router()
    await owrt.sweep()

    const sent = owrt.payloads('bind')
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
    // Handing over is not writing: the module still puts nothing in the band.
    expect(owrt.stdins().join('\n')).not.toContain('ip -4 rule add')
    owrt.dispose()
  })

  it('forgets the record once the router confirms it, and does not send it twice', async () => {
    const owrt = await router()
    await owrt.sweep()
    await owrt.sweep()

    expect(owrt.payloads('bind')).toHaveLength(1)
    const last = owrt.written.at(-1)
    expect(last).toBeTruthy()
    expect(last?.direct).toEqual([])
    // The claim on the WAN's routing table goes with it. The `option ip4table`
    // stays on the router - the daemon never takes one back either - but which
    // record may remove it is no longer a question this module answers.
    expect(last?.extraTables).toEqual([])

    const rows = await owrt.rows()
    expect(rows.map((row) => row.id)).toEqual([SECTION])
    // Omitted rather than empty: the page tests for it with `exists`, which an
    // empty string would pass, and a note with a blank reason is worse than none.
    expect(owrt.snapshot()?.notice).toBeUndefined()
    owrt.dispose()
  })

  it('keeps the binding visible, and says why, when the router refuses it', async () => {
    const owrt = await router({
      answer: (command) =>
        command.includes('ubus -S call bm.wanbind bind ')
          ? ok(
              JSON.stringify({
                ok: false,
                reason:
                  'pref 19000 is not below binding instance bmi1, which numbers its clients from 19000'
              })
            )
          : null
    })
    await owrt.sweep()

    const rows = await owrt.rows()
    // Drawn from the record, because the router has no section for it and this
    // is the only description of a binding the operator created.
    expect(rows.map((row) => row.id)).toEqual(['dir_a1'])
    expect(rows[0]?.state).toBe('refused')
    expect(rows[0]?.rule).toBe('')
    expect(rows[0]?.reason).toContain('not below binding instance')

    // And the record survives every write, so the next pass tries again.
    expect(kept(owrt)).toBe(true)

    const notice = owrt.snapshot()?.notice ?? ''
    expect(notice).toContain('Workshop')
    // The sentence has to say what has happened to the traffic, not only that
    // something went wrong.
    expect(notice).toContain("on the router's default connection")
    owrt.dispose()
  })

  it('leaves the record alone while the router holds the section and refuses it', async () => {
    // The other half of a refusal, and the one that produces two ids for one
    // binding if it is got wrong: the section exists, so the daemon has a row
    // for it with its own sentence on it.
    const owrt = await router({
      bindings: [
        reported({
          usable: false,
          state: 'refused',
          table: 0,
          ip: '',
          reason: 'table 101 is the catch-all table of binding instance bmi1'
        })
      ]
    })
    await owrt.sweep()
    await owrt.sweep()

    // No attempt to write it again. The section is there and the daemon has
    // read it; rewriting it every tick would be this module arguing with the
    // router's own configuration reader once a second.
    expect(owrt.payloads('bind')).toHaveLength(0)

    const rows = await owrt.rows()
    // One row - the router's, with the daemon's reason - and not a second one
    // drawn from the record that no Delete could reach.
    expect(rows.map((row) => row.id)).toEqual([SECTION])
    expect(rows[0]?.state).toBe('refused')
    expect(rows[0]?.reason).toContain('catch-all table')

    // The record stays, because it is the only thing that could put this
    // binding back if the package were removed again.
    expect(kept(owrt)).toBe(true)
    expect(owrt.snapshot()?.notice).toContain('Workshop')
    owrt.dispose()
  })

  it('does not write a rule for a binding the router refused', async () => {
    const owrt = await router({
      answer: (command) =>
        command.includes('ubus -S call bm.wanbind bind ')
          ? ok(JSON.stringify({ ok: false, reason: 'the WAN it names is one of this router\'s own LANs' }))
          : null
    })
    await owrt.sweep()
    await owrt.sweep()

    // The temptation is to keep steering the address from here until the router
    // takes it. It is the wrong answer: the daemon sweeps this band, so the
    // rule would be removed under us and re-added on our next tick, for ever.
    expect(owrt.stdins().join('\n')).not.toContain('ip -4 rule add')
    owrt.dispose()
  })

  it('says the band is unusable rather than offering a form nothing can satisfy', async () => {
    const owrt = await router({
      hostData: host([]),
      band: {
        base: 19_000,
        span: 1_000,
        top: 19_999,
        reason:
          'the band reaches into binding instance bmi1, which numbers its clients from 19500',
        usable: false
      }
    })
    await owrt.sweep()

    expect(owrt.snapshot()?.notice).toContain('will not allocate rule priorities')

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
    const owrt = await router({ hostData: host([]) })
    await owrt.sweep()

    const report = (await owrt.call('directCheck', {
      name: 'Bench',
      targetKind: 'ip',
      address: '10.0.0.12',
      wan: 'wan1',
      whenDown: 'fallback'
    })) as { ok: boolean; token?: string; findings: Array<{ label: string; detail?: string }> }

    expect(report.ok).toBe(true)
    // The report has to say which half will hold it: on this router the binding
    // outlives the app, and that is the difference worth knowing before saving.
    expect(report.findings.some((finding) => finding.label.includes('keeps its own'))).toBe(true)

    await owrt.call('directApply', { token: report.token, values: {
      name: 'Bench',
      targetKind: 'ip',
      address: '10.0.0.12',
      wan: 'wan1',
      whenDown: 'fallback'
    } })
    await settle(40)

    const sent = owrt.payloads('bind').at(-1)
    expect(sent?.ip).toBe('10.0.0.12')
    expect(sent?.wan).toBe('wan1')
    expect(sent?.when_down).toBe('fallback')
    // A create has no rule standing anywhere for a number to have to match, and
    // the daemon allocates from a band this module cannot see - so a guess here
    // is the one way to collide with a binding made at a router shell.
    expect(sent).not.toHaveProperty('pref')
    expect(sent).not.toHaveProperty('table')

    // Nothing was recorded on this side, and nothing was written to the kernel
    // or to /etc/config/network from here.
    expect(owrt.written.at(-1)?.direct ?? []).toEqual([])
    expect(owrt.stdins().join('\n')).not.toContain('ip -4 rule add')
    // The daemon writes `option ip4table` itself, from netifd's live answer, so
    // nothing here goes near /etc/config/network. Two writers of one option are
    // two numbers that do not have to agree.
    expect(owrt.commands()).not.toContain('uci batch')
    owrt.dispose()
  })
})
