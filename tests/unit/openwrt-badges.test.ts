import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { ValueBadge } from '@shared/module-ui'
import activate from '../../openwrt/main/index'
import { BADGE, countBadges, statusBadges, statusTone } from '../../openwrt/main/badges'
import { ConfigStore, DEFAULT_RULES, RulesEditor } from '../../openwrt/main/config'
import { Jobs, type JobHistoryData, type JobStore } from '../../openwrt/main/jobs'
import type { OpenWrtOverview, OpenWrtSeriesPoint } from '../../openwrt/main/types'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import {
  assignment,
  binding,
  fakeWanbind,
  instanceConfig,
  instanceState,
  routerModel,
  waiting,
  wanbindClient
} from '../helpers/wanbind'

/**
 * Everything a page reads instead of computing for itself.
 *
 * Until now the surfaces got bare status words and had to print them as text,
 * because a JSON spec cannot map `wan-error` to a colour or turn an uptime in
 * seconds into a clock the viewer can read in their own locale. These are the
 * fields that moved that work to the side that knows the answer.
 */

const ok = (stdout: string, stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const labels = (badges: ValueBadge[] | undefined): string[] =>
  (badges ?? []).map((entry) => entry.label)

/** Enough of a router for the probe to call this machine manageable. */
const PROBE_OUTPUT = [
  '===REL===',
  'DISTRIB_ID=OpenWrt',
  'DISTRIB_RELEASE=25.12.5',
  '===BOARD===',
  '{}',
  '===TOOLS===',
  '/bin/ubus',
  '/sbin/uci',
  '/sbin/ip',
  '/sbin/netifd',
  '===PPP===',
  '',
  '===PKG===',
  'apkdb',
  '===DONE==='
].join('\n')

interface SweepOptions {
  uptime?: number
  memTotal?: number
  memFree?: number
  load?: number
  leases?: string[]
  dump?: string | null
}

function sweepOutput(options: SweepOptions = {}): string {
  const {
    uptime = 4_000,
    memTotal = 128 * 1024 * 1024,
    memFree = 32 * 1024 * 1024,
    load = 65_536,
    leases = [],
    dump = null
  } = options
  return [
    '===SYS===',
    JSON.stringify({
      uptime,
      // Without a wall clock from the router there is no offset to rebase a
      // lease expiry by, and every one of them reads "unknown" on purpose.
      localtime: Math.floor(Date.now() / 1_000),
      load: [load, 0, 0],
      memory: { total: memTotal, free: memFree }
    }),
    '===DEV===',
    'Inter-|   Receive                    |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes',
    '  eth1: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0',
    '===POOL=== 0 0 0',
    '===LEASES===',
    ...leases,
    '===RULES===',
    '===RULESOK===',
    '1',
    ...(dump === null ? [] : ['===DUMP===', dump])
  ].join('\n')
}

const LAN_DUMP = {
  interface: 'lan',
  up: true,
  proto: 'static',
  device: 'br-lan',
  l3_device: 'br-lan',
  uptime: 3_600,
  'ipv4-address': [{ address: '192.168.10.1', mask: 24 }]
}

describe('the module status palette', () => {
  it('gives one colour to one meaning, wherever the word appears', () => {
    // A device on a dead WAN, a PPPoE session that failed and a job step that
    // threw are three files and one colour.
    expect(statusBadges('wan-error')[0].color).toBe(BADGE.bad)
    expect(statusBadges('error')[0].color).toBe(BADGE.bad)
    expect(statusBadges('failed')[0].color).toBe(BADGE.bad)
    // Configured here and absent on the router is its own colour: it is not a
    // failure the router reported, it is a record that no longer matches.
    expect(statusBadges('missing')[0].color).toBe(BADGE.missing)
  })

  it('leaves a word with no meaning neutral rather than inventing one', () => {
    expect(statusBadges('stopped')).toEqual([{ label: 'stopped' }])
    expect(statusBadges('unmanaged')).toEqual([{ label: 'unmanaged' }])
    expect(statusTone('unmanaged')).toBe('unknown')
    expect(statusBadges('')).toEqual([])
  })

  it('drops counts that are zero instead of printing them', () => {
    const chips = countBadges([
      { label: 'up', count: 3, color: BADGE.good },
      { label: 'error', count: 0, color: BADGE.bad },
      { label: 'stopped', count: 1 }
    ])

    expect(chips).toEqual([
      { label: '3 up', color: BADGE.good },
      { label: '1 stopped' }
    ])
  })
})

describe('the dashboard payload', () => {
  it('publishes memory and boot time as numbers the renderer can format', async () => {
    const harness = moduleHarness(
      'openwrt',
      (command) =>
        command.includes('===SYS===')
          ? ok(
              sweepOutput({
                uptime: 7_200,
                memTotal: 100,
                memFree: 25,
                dump: JSON.stringify({ interface: [LAN_DUMP] })
              })
            )
          : ok(''),
      { config: sharedModuleConfig(null) }
    )
    const runtime = activate(harness.ctx)

    await harness.ticks[0]()

    const overview = harness.emit.mock.calls
      .filter((call) => call[0] === 'overview')
      .map((call) => call[1] as OpenWrtOverview)
      .at(-1)
    expect(overview?.sys).toMatchObject({ memUsed: 75, memPct: 75 })
    // The router's own epoch is not comparable with ours, so this is derived
    // from the sample instead of read off the router.
    expect(overview?.sys.bootAt).toBe((overview?.t ?? 0) - 7_200_000)

    const lan = overview?.ifaces.find((iface) => iface.name === 'lan')
    expect(labels(lan?.statusBadges)).toEqual(['up'])
    expect(lan?.statusBadges[0].color).toBe(BADGE.good)
    expect(lan?.upSince).toBe((overview?.t ?? 0) - 3_600_000)
    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })

  it('leaves an interface that is not up without a start time to count from', async () => {
    const harness = moduleHarness(
      'openwrt',
      (command) =>
        command.includes('===SYS===')
          ? ok(
              sweepOutput({
                dump: JSON.stringify({
                  interface: [
                    { interface: 'wan', up: false, proto: 'dhcp', uptime: 900, autostart: false }
                  ]
                })
              })
            )
          : ok(''),
      { config: sharedModuleConfig(null) }
    )
    const runtime = activate(harness.ctx)

    await harness.ticks[0]()

    const overview = harness.emit.mock.calls
      .filter((call) => call[0] === 'overview')
      .map((call) => call[1] as OpenWrtOverview)
      .at(-1)
    const wan = overview?.ifaces.find((iface) => iface.name === 'wan')
    // A stale uptime on an interface that dropped would otherwise render as a
    // link that has been up for fifteen minutes.
    expect(wan?.status).toBe('stopped')
    expect(wan?.upSince).toBe(0)
    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })

  it('carries router health alongside the traffic, live and in history', async () => {
    const harness = moduleHarness(
      'openwrt',
      (command) =>
        command.includes('===SYS===')
          ? ok(sweepOutput({ load: 2 * 65_536, memTotal: 200, memFree: 50 }))
          : command.includes('===TOOLS===')
            ? ok(PROBE_OUTPUT)
            : ok(''),
      { config: sharedModuleConfig(null) }
    )
    const history: unknown[] = []
    ;(harness.ctx as unknown as { addHistory: (value: unknown) => void }).addHistory = (
      value: unknown
    ) => {
      history.push(value)
    }
    const runtime = activate(harness.ctx)

    await harness.ticks[0]()
    await runtime.refreshSlow?.('openwrt')

    const point = harness.emit.mock.calls
      .filter((call) => call[0] === 'series')
      .map((call) => call[1] as OpenWrtSeriesPoint)
      .at(-1)
    expect(point).toMatchObject({ load1: 2, memPct: 75 })
    // Without these two the history charts could show throughput stopping and
    // never the router running out of memory that stopped it.
    expect(history.at(-1)).toMatchObject({ load1: 2, memPct: 75 })
    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })

  it('gives a DHCP row its badge, its expiry and the instance that owns it', async () => {
    const now = Math.floor(Date.now() / 1_000)
    const harness = moduleHarness(
      'openwrt',
      (command) =>
        command.includes('===SYS===')
          ? ok(
              sweepOutput({
                leases: [`${now + 3_600} 00:11:22:33:44:55 192.168.10.2 phone *`],
                dump: JSON.stringify({ interface: [LAN_DUMP] })
              })
            )
          : ok(''),
      {
        config: sharedModuleConfig(null),
        hostData: {
          version: 1,
          instances: [
            {
              id: 'bind_1',
              name: 'Office',
              lan: 'lan',
              carrier: 'eth1',
              running: true,
              sticky: true,
              remap: true
            }
          ]
        }
      }
    )
    const runtime = activate(harness.ctx)

    await harness.ticks[0]()

    const [row] = harness.handlers.get('deviceRows')?.() as Array<Record<string, unknown>>
    expect(row).toMatchObject({ ip: '192.168.10.2', bindingStatus: 'waiting' })
    expect(labels(row.bindingBadges as ValueBadge[])).toEqual(['waiting'])
    // Reassign/Unassign both take the instance; without this the only way to
    // reach them was to find the instance on another page first.
    expect(row.instanceId).toBe('bind_1')
    // Rebased onto our clock, not the router's: the raw number is only
    // meaningful next to a wall clock this side has no reason to trust.
    expect(row.expiresAt as number).toBeGreaterThanOrEqual((now + 3_590) * 1_000)
    expect(row.expiresAt as number).toBeLessThanOrEqual((now + 3_610) * 1_000)
    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })
})

// The PPPoE payload surface is exercised in openwrt-hot-path.test.ts and
// openwrt-pppoe-guards.test.ts against the daemon contract; the SSH-era
// describe that lived here tested rows the module no longer builds.

/**
 * The rows the WAN Binding pages render, built from the daemon's answers.
 *
 * Every one of these was a claim about the module's own planner until 3.4.0.
 * The planner is the router's now and is tested there - `wanbind-direct` and
 * `wanbind-generator` in `packages/ci/probes/` drive the real ucode - so what
 * is left on this side, and what these four cases are about, is the same thing
 * the rest of this file is about: what a page reads instead of computing it
 * for itself. A JSON spec cannot turn a state word into a colour, a router
 * second into a moment on this clock, or four counters into the two that are
 * not zero.
 */
describe('the binding payload', () => {
  const INSTANCE = 'bmi_office'
  /** Router seconds, which is what every timestamp in a reply is measured in. */
  const nowSec = (): number => Math.floor(Date.now() / 1_000)

  /** One pool WAN, as the fast sweep sees it - the daemon does not report this. */
  const poolModel = (up: boolean) =>
    routerModel({
      ifaces: [
        {
          name: 'pd00001',
          proto: 'pppoe',
          device: 'eth1',
          l3Device: 'pppoe-pd00001',
          up,
          pending: false,
          autostart: true,
          uptimeSec: up ? 3_600 : 0,
          ip4Table: 10_001,
          ...(up ? { ipv4: { addr: '198.51.100.1', mask: 32 } } : { errorCode: 'LINK_LOST' })
        }
      ]
    })

  async function seated(options: { up?: boolean; agoSec?: number }) {
    const client = wanbindClient({
      model: poolModel(options.up ?? true),
      daemon: fakeWanbind({
        configured: [instanceConfig({ id: INSTANCE })],
        assignments: [
          assignment({
            instance: INSTANCE,
            wan: 'pd00001',
            assignedAt: nowSec() - (options.agoSec ?? 0)
          })
        ]
      })
    })
    await client.tick()
    const rows = client.manager.rows(INSTANCE)
    client.dispose()
    return rows
  }

  it('says when a device was bound, not only how long ago it was at the time', async () => {
    const [row] = await seated({})

    // The router counts in whole seconds on its own wall clock and this side
    // counts in milliseconds on the app's; passed through raw, every seat reads
    // as taken in 1970.
    expect(row?.assignedAt).toBeGreaterThan(1_600_000_000_000)
    expect(labels(row?.wanStatusBadges)).toEqual(['bound'])
    expect(row?.wanStatusBadges[0].color).toBe(BADGE.good)
    // The frozen label stops counting the moment it is emitted; `assignedAt` is
    // what the renderer keeps counting from.
    expect(row?.sinceLabel).toBe('0s')
  })

  it('colours an assignment whose WAN broke under it', async () => {
    // A dead WAN is never handed out in the first place, so the only way a row
    // carries a status other than `bound` is a link that dropped after the
    // device was put on it. The daemon does not report a WAN's live condition -
    // it answers for its own rules - so this comes off the same sweep the
    // Overview reads, which is what stops one page calling a line down while
    // the other calls it up.
    const [row] = await seated({ up: false, agoSec: 5 })

    expect(labels(row?.wanStatusBadges)).toEqual(['error'])
    expect(row?.wanStatusBadges[0].color).toBe(BADGE.bad)
    // Still the moment it was bound, not the moment the WAN failed.
    expect(row?.sinceLabel).toBe('5s')
  })

  it('chips a queued device by whether it is held or simply waiting', async () => {
    const client = wanbindClient({
      daemon: fakeWanbind({
        configured: [instanceConfig({ id: INSTANCE })],
        instances: [instanceState({ id: INSTANCE, waiting: 1, held: 1, devices: 2 })],
        waiting: [
          waiting({ instance: INSTANCE, mac: 'aa:bb:cc:dd:ee:02', why: 'queued' }),
          // A device someone unassigned by hand is held out of the queue; the
          // row used to say so only in a `heldLabel` column nothing rendered.
          waiting({
            instance: INSTANCE,
            mac: 'aa:bb:cc:dd:ee:03',
            order: 0,
            held: true,
            why: 'held'
          })
        ]
      })
    })
    await client.tick()
    const rows = client.manager.waitingRows(INSTANCE)
    client.dispose()

    expect(rows[0]?.held).toBe(false)
    expect(labels(rows[0]?.holdBadges)).toEqual(['waiting'])
    expect(rows[0]?.holdBadges[0].color).toBe(BADGE.warn)

    expect(rows[1]?.held).toBe(true)
    expect(labels(rows[1]?.holdBadges)).toEqual(['held'])
  })

  it('summarises an instance by what is not zero', async () => {
    const running = wanbindClient({
      daemon: fakeWanbind({
        configured: [instanceConfig({ id: INSTANCE })],
        instances: [instanceState({ id: INSTANCE, bound: 2, waiting: 1, devices: 3 })]
      })
    })
    await running.tick()
    // Two counters out of six, because the other four are zero and a chip
    // reading `0 dialing` is a number to read and discard.
    expect(labels(running.manager.list()[0]?.stateBadges)).toEqual(['1 waiting', '2 bound'])
    running.dispose()

    const stopped = wanbindClient({
      daemon: fakeWanbind({ configured: [instanceConfig({ id: INSTANCE, enabled: false })] })
    })
    await stopped.tick()
    // And a section that is switched off says only that: counts of zero beside
    // it would describe a healthy empty instance rather than a stopped one.
    expect(labels(stopped.manager.list()[0]?.stateBadges)).toEqual(['stopped'])
    stopped.dispose()
  })
})

describe('a binding the router is steering nowhere', () => {
  // The silence this chip exists to break.
  //
  // A one-to-one rule is written over netlink and needs no firewall at all, so
  // a binding on a router with no zones gets its rule, is verified in the
  // kernel, and comes back `bound`. The forwarding is the half that is missing,
  // and the daemon does not complain about it: it prepares one only for
  // `missing` and `wrong`, and answers `no-zone` by declining to try - nothing
  // attempted, nothing logged, `reason` empty. The row rendered that as plain
  // green with an empty Why column, which is the exact shape of failure this
  // release exists to abolish: a page agreeing with itself over a router that
  // is dropping the traffic.
  type Forwarding = NonNullable<Parameters<typeof binding>[0]>['forwarding']

  async function rowFor(forwarding: Forwarding, enabled = true, state = 'bound') {
    const client = wanbindClient({
      daemon: fakeWanbind({
        bindings: [
          binding({
            id: 'bmdir_nas',
            name: 'NAS',
            enabled,
            state: state as ReturnType<typeof binding>['state'],
            forwarding
          })
        ]
      })
    })
    await client.tick()
    const [row] = client.manager.directRows()
    client.dispose()
    return row
  }

  it('says so when the router has no firewall zone to forward from', async () => {
    const row = await rowFor('no-zone')

    expect(row?.forwarding).toBe('no-zone')
    expect(labels(row?.stateBadges)).toContain('no firewall zone')
  })

  it('says so when the binding sits behind no LAN', async () => {
    const row = await rowFor('no-lan')

    expect(labels(row?.stateBadges)).toContain('no LAN to forward from')
  })

  it('stays quiet when the router has the path', async () => {
    const row = await rowFor('ok')

    expect(labels(row?.stateBadges)).toEqual(['bound'])
  })

  it('does not nag about a forwarding the next pass is going to write', async () => {
    // `missing` on a binding that is not yet bound is the ordinary state
    // between a create and the pass that prepares it. Chipping that would put a
    // red mark on every new binding for one tick and teach people to ignore it.
    const pending = await rowFor('missing', true, 'waiting')

    expect(labels(pending.stateBadges)).not.toContain('firewall path pending')
  })

  it('does say so when a bound binding is still waiting for one', async () => {
    // Bound and still `missing` means the pass has had its chance and the
    // reload did not take - `applyReloads`' failure only reaches syslog, so
    // this chip is the only place it surfaces at all.
    const stuck = await rowFor('missing', true, 'bound')

    expect(labels(stuck.stateBadges)).toContain('firewall path pending')
  })

  it('says nothing at all about a binding that is switched off', async () => {
    const off = await rowFor('no-zone', false, 'disabled')

    expect(labels(off.stateBadges)).not.toContain('no firewall zone')
  })
})

describe('the jobs payload', () => {
  function jobStore(): JobStore & { data: JobHistoryData } {
    const data: JobHistoryData = { jobs: [] }
    return {
      data,
      read: () => data,
      update: <TResult>(mutate: (value: JobHistoryData) => TResult): TResult => mutate(data)
    }
  }

  it('describes a running job the way a card needs it', async () => {
    const emitted: unknown[] = []
    const jobs = new Jobs({ emit: (_event, payload) => emitted.push(payload), log: () => {} }, jobStore())
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    jobs.start({
      kind: 'pppoe-create',
      label: 'Create batch Home',
      items: [
        { name: 'Apply chunk 1/3', run: async () => {} },
        { name: 'Apply chunk 2/3', run: async () => held },
        { name: 'Apply chunk 3/3', run: async () => {} }
      ]
    })
    await settle(5)

    // `latest` is the last payload actually pushed, and pushes are throttled;
    // this asks what is true now.
    const running = jobs.snapshot().running[0]
    expect(running.health).toBe('unknown')
    expect(running.progressLabel).toBe('1/3')
    // The step in flight is what a user wants named; the rest is arithmetic.
    expect(running.note).toBe('Apply chunk 2/3')
    expect(running.chips).toEqual([
      { label: 'Apply chunk 2/3', status: 'unknown', pinned: true },
      { label: '1 ok', status: 'ok', pinned: false },
      { label: '1 pending', status: 'unknown', pinned: true }
    ])
    expect(running.tookLabel).toBe('')
    release()
    await settle()
    expect(emitted.length).toBeGreaterThan(0)
  })

  it('keeps the chip count bounded however many steps a job has', async () => {
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, jobStore())

    jobs.start({
      kind: 'pppoe-create',
      label: 'Create batch Big',
      items: Array.from({ length: 60 }, (_, idx) => ({
        name: `Apply chunk ${idx + 1}/60`,
        run: async () => {}
      }))
    })
    await settle()

    const [finished] = jobs.snapshot().finished
    // Sixty chunks used to mean sixty chips, and a card taller than the page.
    // Only thirty steps survive the history cap, and the chips say so rather
    // than reporting a sixty-step job as thirty steps that went fine.
    expect(finished.chips).toEqual([
      { label: '30 ok', status: 'ok', pinned: false },
      { label: '30 not kept in history', status: 'unknown', pinned: true }
    ])
    expect(finished.progressLabel).toBe('60/60')
    expect(finished.health).toBe('ok')
    expect(labels(finished.stateBadges)).toEqual(['done'])
    expect(finished.stateBadges[0].color).toBe(BADGE.good)
  })

  it('reports a step that finished but not cleanly as warning, not as green', async () => {
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, jobStore())

    jobs.start({
      kind: 'pppoe-create',
      label: 'Create batch Home',
      items: [
        { name: 'Apply chunk 1/1', run: async () => {} },
        {
          name: 'Configure firewall zone',
          run: async () => ({ warning: 'Firewall reload produced no nft rule' })
        }
      ]
    })
    await settle()

    const [finished] = jobs.snapshot().finished
    expect(finished.health).toBe('warn')
    expect(finished.note).toBe('Firewall reload produced no nft rule')
    expect(finished.chips).toEqual([
      { label: '1 warning', status: 'warn', pinned: true },
      { label: '1 ok', status: 'ok', pinned: false }
    ])
    expect(finished.items[1].statusBadges[0].color).toBe(BADGE.warn)
    expect(finished.tookLabel).toMatch(/^\d+s$/)
  })

  it('says the list is empty when a reset abandons a running job', async () => {
    const emitted: Array<{ running: unknown[]; jobs: unknown[] }> = []
    const jobs = new Jobs(
      {
        emit: (_event, payload) => emitted.push(payload as { running: unknown[]; jobs: unknown[] }),
        log: () => {}
      },
      jobStore()
    )
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    jobs.start({
      kind: 'pppoe-create',
      label: 'Create batch Home',
      items: [
        { name: 'Apply chunk 1/2', run: async () => held },
        { name: 'Apply chunk 2/2', run: async () => {} }
      ]
    })
    await settle(5)
    expect(emitted.at(-1)?.running).toHaveLength(1)

    // A connection reset. Clearing the live list without a final push left the
    // last progress frame - "Apply chunk 1/2, 0%" - on screen for the rest of
    // the session, describing a job nothing was working on any more.
    jobs.reset()

    expect(emitted.at(-1)?.running).toEqual([])
    expect(emitted.at(-1)?.jobs).toEqual([])
    release()
    await settle()
  })

  it('does not put decorations into the history it saves', async () => {
    const store = jobStore()
    const jobs = new Jobs({ emit: () => {}, log: () => {} }, store)

    jobs.start({ kind: 'test', label: 'One step', items: [{ name: 'Step', run: async () => {} }] })
    await settle()

    // The runner hands the live object to `persist`; decorating it in place
    // would write chips into hostData for good, on a 512 KB budget.
    const saved = store.data.jobs[0] as unknown as Record<string, unknown>
    expect(saved.chips).toBeUndefined()
    expect(saved.health).toBeUndefined()
    expect((saved.items as Array<Record<string, unknown>>)[0].statusBadges).toBeUndefined()
    expect(jobs.snapshot().finished[0].chips).toHaveLength(1)
  })
})

describe('the settings rules form', () => {
  function editor(): { rules: RulesEditor; config: ConfigStore } {
    const harness = moduleHarness('openwrt', () => ok(''), { config: sharedModuleConfig(null) })
    const config = new ConfigStore(harness.ctx)
    return { rules: new RulesEditor(harness.ctx, config), config }
  }

  const apply = (rules: RulesEditor, values: Record<string, unknown>): void => {
    const report = rules.check(values)
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(rules.apply({ token: report.token, values })).toEqual({ ok: true })
  }

  it('keeps one group of overrides when another group is saved', () => {
    const { rules, config } = editor()

    apply(rules, { stickyCap: '2000' })
    // A different group of the same form, carrying only its own fields. Merging
    // over the defaults instead of over what is in force made this a silent
    // reset of everything the user had set elsewhere.
    apply(rules, { releaseGraceSec: '600' })

    expect(config.effectiveRules()).toMatchObject({ stickyCap: 2_000, releaseGraceSec: 600 })
  })

  it('treats a blank field as leave this alone', () => {
    const { rules, config } = editor()

    apply(rules, { stickyCap: '2000' })
    apply(rules, { stickyCap: '' })

    expect(config.effectiveRules().stickyCap).toBe(2_000)
    // And Reset every rule is still how a user goes back to the defaults.
    expect(rules.reset()).toEqual({ ok: true })
    expect(config.effectiveRules().stickyCap).toBe(DEFAULT_RULES.stickyCap)
  })

  it('says what changes, and says so when nothing does', () => {
    const { rules } = editor()

    apply(rules, { stickyCap: '2000' })
    const report = rules.check({ stickyCap: '2000' })

    expect(report.ok).toBe(true)
    expect(report.findings.some((finding) => finding.label.includes('Nothing changes'))).toBe(true)
  })

  it('saves a checkbox turned off, which carries no text for a blank test to catch', () => {
    const { rules, config } = editor()

    // Unlike every numeric field, a false boolean has to survive the "blank
    // means leave this alone" rule - it is exactly the value a user submits to
    // stop the module writing to /etc/config/network on its own.
    apply(rules, { autoRepairTables: false })
    expect(config.effectiveRules().autoRepairTables).toBe(false)

    apply(rules, { releaseGraceSec: '600' })
    expect(config.effectiveRules().autoRepairTables).toBe(false)

    apply(rules, { autoRepairTables: true })
    expect(config.effectiveRules().autoRepairTables).toBe(true)
  })

  it('puts every rule back on reset, with nothing held over', () => {
    // Three numbers here used to be locked while a record existed on the
    // router, because the rules standing there had been written against them.
    // The router stamps each section with the band it was created under and
    // re-reads them itself from packages 2.4.0, so there is nothing left on any
    // router this could contradict - and the lock's cost was real: one record
    // and "Reset every rule" did nothing at all, so the grace periods and the
    // lease file could not be reset without deleting the instance first.
    const { rules, config } = editor()
    apply(rules, { catchAllTable: '31000', releaseGraceSec: '600' })

    expect(rules.reset()).toEqual({ ok: true })
    expect(config.effectiveRules().catchAllTable).toBe(DEFAULT_RULES.catchAllTable)
    expect(config.effectiveRules().releaseGraceSec).toBe(DEFAULT_RULES.releaseGraceSec)
  })

  it('re-derives at apply time instead of writing the checked snapshot', () => {
    // The token used to carry the whole merged document, so a save made ten
    // minutes later reverted every override written in between.
    const { rules, config } = editor()

    const report = rules.check({ stickyCap: '2000' })
    expect(report.ok).toBe(true)
    if (!report.ok) return
    // Another group is saved while the first check's token is still valid.
    apply(rules, { releaseGraceSec: '600' })
    expect(rules.apply({ token: report.token, values: { stickyCap: '2000' } })).toEqual({
      ok: true
    })

    expect(config.effectiveRules()).toMatchObject({ stickyCap: 2_000, releaseGraceSec: 600 })
  })

})

describe('the hints flag', () => {
  it('sets what the checkbox asked for instead of flipping what is stored', () => {
    const config = sharedModuleConfig(null)
    const harness = moduleHarness('openwrt', () => ok(''), { config })
    const runtime = activate(harness.ctx)
    const uiOn = (): boolean =>
      (harness.emit.mock.calls
        .filter((call) => call[0] === 'ui')
        .map((call) => call[1] as { hintsOn: boolean })
        .at(-1)?.hintsOn) ?? true

    harness.handlers.get('hintsSet')?.(false)
    expect(uiOn()).toBe(false)
    // A second surface submitting the same form does not turn them back on.
    harness.handlers.get('hintsSet')?.(false)
    expect(uiOn()).toBe(false)

    harness.handlers.get('hintsSet')?.(true)
    expect(uiOn()).toBe(true)
    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })

  it('reads the flag out of a form submission, which sends its whole values object', () => {
    const config = sharedModuleConfig(null)
    const harness = moduleHarness('openwrt', () => ok(''), { config })
    const runtime = activate(harness.ctx)
    const uiOn = (): boolean =>
      (harness.emit.mock.calls
        .filter((call) => call[0] === 'ui')
        .map((call) => call[1] as { hintsOn: boolean })
        .at(-1)?.hintsOn) ?? true

    // What the `form` block actually posts - not a bare boolean.
    harness.handlers.get('hintsSet')?.({ hintsOn: false })
    expect(uiOn()).toBe(false)
    harness.handlers.get('hintsSet')?.({ hintsOn: true })
    expect(uiOn()).toBe(true)

    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })
})
