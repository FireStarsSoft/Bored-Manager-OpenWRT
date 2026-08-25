import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import type { JobSpec, OpenWrtJob } from '../../openwrt/main/jobs'
import {
  PppoeManager,
  type PppoeRules,
  type PppoeService,
  type PppoeStoreData
} from '../../openwrt/main/pppoe'
import { buildPppoeUci } from '../../openwrt/main/uci'
import type { RouterModel } from '../../openwrt/main/types'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * The guards around a PPPoE pool that only bite in the cases nobody exercises
 * by hand: a carrier typed rather than picked, a session that never finishes
 * dialing, a router nothing has read yet, a watchdog racing a delete, and a
 * credential carrying a byte a config file cannot hold.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const ROUTER_TOOLS = [
  '/sbin/ubus',
  '/sbin/uci',
  '/sbin/ip',
  '/sbin/fw4',
  '/sbin/logread',
  '/usr/sbin/nft',
  '/sbin/netifd',
  '/usr/sbin/pppd'
]

function probeOutput(): string {
  return [
    '===REL===',
    "DISTRIB_ID='OpenWrt'",
    "DISTRIB_RELEASE='25.12.0'",
    '===BOARD===',
    JSON.stringify({ model: 'Test Router', release: { distribution: 'OpenWrt', version: '25.12.0' } }),
    '===TOOLS===',
    ...ROUTER_TOOLS,
    '===PPP===',
    'plugin',
    'kmod',
    '===PKG===',
    'apkdb',
    '===DONE==='
  ].join('\n')
}

function sweepOutput(dump: string | null): string {
  return [
    '===SYS===',
    JSON.stringify({ uptime: 4_000, load: [0, 0, 0], memory: { total: 1, free: 1 } }),
    '===DEV===',
    '===POOL=== 0 0 0',
    '===LEASES===',
    '===RULES===',
    '===RULESOK===',
    '1',
    ...(dump === null ? [] : ['===DUMP===', dump])
  ].join('\n')
}

const BATCH = {
  id: 'b1',
  name: 'Pool',
  prefix: 'pd',
  carrier: 'eth1',
  createdAt: 1,
  count: 2,
  seqFrom: 1,
  seqTo: 2
}

const text = (report: ModuleCheckReport): string =>
  report.findings.map((finding) => `${finding.label} ${finding.detail ?? ''}`).join('\n')

// ---------------------------------------------------------------- standalone

/**
 * PPPoE on its own, through the dependency interfaces the domain declares. The
 * jobs double deliberately never runs an item: a job that stays started is what
 * holds the `deleting` guard open long enough to ask the watchdog about it.
 */
function standalone(options: {
  batches?: PppoeStoreData['batches']
  rules?: Partial<PppoeRules>
  service?: Partial<PppoeService>
  answer?: (command: string) => ModuleExecResult
}): {
  manager: PppoeManager
  started: JobSpec[]
  harness: ReturnType<typeof moduleHarness>
} {
  const harness = moduleHarness('openwrt', options.answer ?? (() => ok()))
  const data: PppoeStoreData = {
    nextSeq: 1,
    batches: options.batches ? [...options.batches] : []
  }
  const started: JobSpec[] = []
  let next = 0
  const manager = new PppoeManager(
    harness.ctx,
    { effectiveRules: () => ({ ...DEFAULT_RULES, ...options.rules }) },
    {
      read: () => data,
      update: <T>(mutate: (value: PppoeStoreData) => T): T => mutate(data)
    },
    {
      start: (spec: JobSpec): OpenWrtJob => {
        started.push(spec)
        next += 1
        return {
          id: `job_${next}`,
          kind: spec.kind,
          label: spec.label,
          state: 'running',
          startedAt: 0,
          total: spec.items.length,
          done: 0,
          failed: 0,
          progressPct: 0,
          items: []
        }
      },
      list: () => []
    },
    {
      model: () => null,
      forceDump: () => {},
      ...options.service
    }
  )
  return { manager, started, harness }
}

function modelWith(ifaces: RouterModel['ifaces']): RouterModel {
  return {
    t: 1_700_000_000_000,
    sys: { uptimeSec: 4_000, load1: 0, memTotal: 1, memFree: 1 },
    ifaces,
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases: [],
    rules: [],
    rates: {}
  }
}

function failedIface(name: string): RouterModel['ifaces'][number] {
  return {
    name,
    proto: 'pppoe',
    device: 'eth1',
    l3Device: `pppoe-${name}`,
    up: false,
    pending: false,
    autostart: true,
    uptimeSec: 0,
    errorCode: 'AUTH_FAILED'
  }
}

// ------------------------------------------------------------------- carrier

describe('the carrier a PPPoE batch is dialed on', () => {
  const CARRIER_ANSWER = (command: string): ModuleExecResult =>
    command === 'sh -s' ? ok('===CARRIER===1\n===NETWORK===\n') : ok()

  it('refuses a tagged carrier that the dropdown would never have offered', async () => {
    // `isSafeDeviceName` allows the dot, on purpose - the binding half carries
    // its uplink on `eth1.835`. Submitted here with a VLAN of its own, this
    // built device `eth1.835.100` under section `bmv100`, a section whose whole
    // job is to say "VLAN 100 on the carrier".
    const { manager } = standalone({ answer: CARRIER_ANSWER })

    const report = await manager.check({
      name: 'Tagged',
      carrier: 'eth1.835',
      prefix: 'pd',
      vlan: '100',
      listText: 'u1,p1'
    })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('eth1.835 is already a tagged VLAN device')
    // The refusal has to say what to do instead, or it reads as "this router
    // does not have that device", which it does.
    expect(text(report)).toContain('Choose eth1 instead')
  })

  it('accepts the device beneath the tag', async () => {
    const { manager } = standalone({ answer: CARRIER_ANSWER })

    const report = await manager.check({
      name: 'Bare',
      carrier: 'eth1',
      prefix: 'pd',
      vlan: '100',
      listText: 'u1,p1'
    })

    expect(report.ok).toBe(true)
  })

  it('still refuses a bridge and a name no device could have', async () => {
    const { manager } = standalone({ answer: CARRIER_ANSWER })

    expect(text(await manager.check({ name: 'A', carrier: 'br-lan', prefix: 'pd', listText: 'u1,p1' })))
      .toContain('is a bridge')
    expect(text(await manager.check({ name: 'B', carrier: 'eth1;reboot', prefix: 'pd', listText: 'u1,p1' })))
      .toContain('Choose a valid carrier interface')
  })
})

// --------------------------------------------------------------- credentials

describe('credentials that a config file cannot hold', () => {
  const CARRIER_ANSWER = (command: string): ModuleExecResult =>
    command === 'sh -s' ? ok('===CARRIER===1\n===NETWORK===\n') : ok()

  it('refuses a control character by row and field without quoting the value', async () => {
    // `uciQuote` quotes, it does not strip, so this reached
    // `/etc/config/network` intact - and came back out on the line `uci batch`
    // echoes when it rejects the command, which is the one output in this
    // module that may never be shown.
    const { manager } = standalone({ answer: CARRIER_ANSWER })

    const report = await manager.check({
      name: 'Dirty',
      carrier: 'eth1',
      prefix: 'pd',
      listText: ['clean,fine', `bob,swordfish${String.fromCharCode(1)}x`].join('\n')
    })

    expect(report.ok).toBe(false)
    const reported = text(report)
    expect(reported).toContain('1 account row(s) contain a control character')
    expect(reported).toContain('row 2 (password)')
    expect(reported).not.toContain('swordfish')
  })

  it('names the username when that is the field carrying it', async () => {
    const { manager } = standalone({ answer: CARRIER_ANSWER })

    const report = await manager.check({
      name: 'Dirty',
      carrier: 'eth1',
      prefix: 'pd',
      listText: `al${String.fromCharCode(127)}ice,secret`
    })

    expect(text(report)).toContain('row 1 (username)')
  })

  it('refuses to build the UCI even if the gate is bypassed', () => {
    // The last gate before a credential becomes a line on `uci batch`'s stdin.
    expect(() =>
      buildPppoeUci([{ user: 'a', pass: `p${String.fromCharCode(10)}q` }], {
        prefix: 'pd',
        carrier: 'eth1',
        seqFrom: 1,
        tableBase: 10_000
      })
    ).toThrow(/account row 1 contains a control character/)
  })
})

describe('a username this router already dials', () => {
  const CARRIER_ANSWER = (command: string): ModuleExecResult =>
    command === 'sh -s' ? ok('===CARRIER===1\n===NETWORK===\n') : ok()

  it('warns when the pasted list repeats an account already configured', async () => {
    // Checking the list against itself was half the test: two batches made from
    // two exports of one customer list dial the same account twice, and the
    // access concentrator answers by dropping one of the two.
    const { manager } = standalone({
      answer: CARRIER_ANSWER,
      service: { pppoeUsers: () => ({ pd00001: 'alice', pd00002: 'bob' }) }
    })

    const report = await manager.check({
      name: 'Second',
      carrier: 'eth1',
      prefix: 'pd',
      listText: ['alice,other-password', 'carol,secret'].join('\n')
    })

    // A warning, like the in-list duplicate it extends: the operator may be
    // deliberately replacing a session.
    expect(report.ok).toBe(true)
    const reported = text(report)
    expect(reported).toContain('1 username(s) are already configured on this router')
    expect(reported).toContain('alice')
    expect(reported).not.toContain('carol')
  })

  it('says nothing when no account overlaps', async () => {
    const { manager } = standalone({
      answer: CARRIER_ANSWER,
      service: { pppoeUsers: () => ({ pd00001: 'alice' }) }
    })

    const report = await manager.check({
      name: 'Fresh',
      carrier: 'eth1',
      prefix: 'pd',
      listText: 'carol,secret'
    })

    expect(text(report)).not.toContain('already configured on this router')
  })
})

// ---------------------------------------------------------------- watchdog

describe('the automatic redial watchdog', () => {
  const RULES = { autoRedialAfterMin: 1 }
  const NOW = 1_700_000_000_000

  it('leaves a batch that is being deleted alone', async () => {
    // Delete stops its sections wave by wave, and every `ifdown` makes the next
    // slow tick see another error row. The watchdog was the one action path
    // with no `deleting` guard, so it redialed exactly the sessions the delete
    // had just taken down, against UCI being removed under it.
    const { manager, started } = standalone({
      batches: [BATCH],
      rules: RULES,
      service: { model: () => modelWith([failedIface('pd00001'), failedIface('pd00002')]) }
    })

    expect(manager.batchDelete('b1')).toMatchObject({ ok: true })
    expect(started.map((spec) => spec.kind)).toEqual(['pppoe-delete'])

    manager.watchdog(NOW)
    expect(manager.watchdog(NOW + 120_000)).toBeNull()
    expect(started.filter((spec) => spec.kind === 'pppoe-watchdog')).toEqual([])
  })

  it('still redials a batch nothing is doing anything else to', async () => {
    const { manager, started } = standalone({
      batches: [BATCH],
      rules: RULES,
      service: { model: () => modelWith([failedIface('pd00001'), failedIface('pd00002')]) }
    })

    manager.watchdog(NOW)
    expect(manager.watchdog(NOW + 120_000)).toBe('job_1')
    expect(started.map((spec) => spec.kind)).toEqual(['pppoe-watchdog'])
  })
})

// ------------------------------------------------------------ status clocks

describe('what a session reads as before the router has answered', () => {
  it('says unknown rather than stopped when no interface list was ever fetched', () => {
    // `stopped` is a claim: it says somebody took these sessions down. Said of
    // a router nothing has read yet, a freshly connected pool of live sessions
    // read as a pool somebody had stopped.
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: { version: 1, nextSeq: 3, batches: [BATCH] },
      config: sharedModuleConfig(null)
    })
    const runtime = activate(harness.ctx)

    const rows = harness.handlers.get('pppoeRows')?.('b1') as Array<{ status: string }>
    expect(rows.map((row) => row.status)).toEqual(['unknown', 'unknown'])
    const [batch] = harness.handlers.get('pppoeBatches')?.() as Array<{
      stopped: number
      unknown: number
      missing: number
    }>
    expect(batch).toMatchObject({ stopped: 0, unknown: 2, missing: 0 })
    runtime.dispose?.()
  })
})

describe('a session that never finishes dialing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function dialingHarness(): ReturnType<typeof moduleHarness> {
    // Listed by netifd, not up, nothing pending, no error code: the catch-all
    // that `statusFor` calls `dialing`.
    const dump = JSON.stringify({
      interface: [
        { interface: 'pd00001', up: false, pending: false, proto: 'pppoe', device: 'pppoe-pd00001' },
        { interface: 'pd00002', up: false, pending: false, proto: 'pppoe', device: 'pppoe-pd00002' }
      ]
    })
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: { version: 1, nextSeq: 3, batches: [BATCH] },
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command) => {
      if (command.includes("echo '===REL==='")) return ok(probeOutput())
      if (command.includes("echo '===SYS==='")) return ok(sweepOutput(dump))
      return ok()
    })
    return harness
  }

  it('turns into an error once the dial has had long enough', async () => {
    const clock = vi.spyOn(Date, 'now')
    const started = 1_700_000_000_000
    clock.mockReturnValue(started)
    const harness = dialingHarness()
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
    await settle()

    const status = (): string[] =>
      (harness.handlers.get('pppoeRows')?.('b1') as Array<{ status: string }>).map(
        (row) => row.status
      )
    expect(status()).toEqual(['dialing', 'dialing'])

    // Four minutes in it is still a session that might yet come up.
    clock.mockReturnValue(started + 4 * 60_000)
    expect(status()).toEqual(['dialing', 'dialing'])

    clock.mockReturnValue(started + 6 * 60_000)
    expect(status()).toEqual(['error', 'error'])
    const rows = harness.handlers.get('pppoeRows')?.('b1') as Array<{ errorCode: string }>
    expect(rows[0].errorCode).toBe('DIAL_TIMEOUT')
    const [batch] = harness.handlers.get('pppoeBatches')?.() as Array<{
      dialing: number
      error: number
    }>
    expect(batch).toMatchObject({ dialing: 0, error: 2 })
    // The point of the clock: these rows are now what the attention table and
    // the watchdog look at, instead of a green chip nothing ever revisits.
    expect(harness.handlers.get('pppoeAttentionRows')?.()).toHaveLength(2)
    runtime.dispose?.()
  })

  it('starts the clock again when a session drops back into dialing', async () => {
    const clock = vi.spyOn(Date, 'now')
    const started = 1_700_000_000_000
    clock.mockReturnValue(started)
    const harness = dialingHarness()
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
    await settle()

    const status = (): string =>
      (harness.handlers.get('pppoeRows')?.('b1') as Array<{ status: string }>)[0].status
    expect(status()).toBe('dialing')

    // A stop and a start inside the window: the second attempt gets the whole
    // window rather than inheriting the age of the first.
    clock.mockReturnValue(started + 4 * 60_000)
    expect(harness.handlers.get('pppoeConnAction')?.(['pd00001'], 'stop')).toMatchObject({
      ok: true
    })
    await settle()
    expect(status()).toBe('stopped')
    expect(harness.handlers.get('pppoeConnAction')?.(['pd00001'], 'start')).toMatchObject({
      ok: true
    })
    await settle()

    clock.mockReturnValue(started + 8 * 60_000)
    expect(status()).toBe('dialing')
    clock.mockReturnValue(started + 14 * 60_000)
    expect(status()).toBe('error')
    runtime.dispose?.()
  })
})

// ------------------------------------------------------------ zone teardown

describe('the shared firewall zone when the last batch goes', () => {
  function deleteHarness(batches: unknown[]): {
    harness: ReturnType<typeof moduleHarness>
    uciBatches: string[]
  } {
    const uciBatches: string[] = []
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: { version: 1, nextSeq: 9, batches },
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command === 'sh -s' && stdin.startsWith('uci -q show network')) {
        return ok(
          [
            'network.pd00001=interface',
            'network.pd00002=interface',
            'network.is00001=interface',
            'firewall.bmwanpool=zone',
            'firewall.bmfwd=forwarding'
          ].join('\n')
        )
      }
      if (command === 'uci batch') {
        uciBatches.push(stdin)
        return ok()
      }
      return ok()
    })
    return { harness, uciBatches }
  }

  const OTHER = { ...BATCH, id: 'b2', name: 'Other', prefix: 'is', count: 1, seqFrom: 1, seqTo: 1 }

  it('removes the zone and the LAN forwarding instead of rebuilding them empty', async () => {
    // The zone exists to carry this module's sessions. Rebuilt with none left,
    // it kept masquerading, kept being forwarded to from the LAN, and in
    // wildcard mode kept claiming `pppoe-pd+` for a prefix nothing uses.
    const { harness, uciBatches } = deleteHarness([BATCH])
    const runtime = activate(harness.ctx)

    expect(harness.handlers.get('pppoeBatchDelete')?.('b1')).toMatchObject({ ok: true })
    await settle(40)

    const written = uciBatches.join('\n')
    expect(written).toContain('delete firewall.bmfwd')
    expect(written).toContain('delete firewall.bmwanpool')
    // The forwarding names the zone as its destination, and fw4 refuses to load
    // one whose destination does not exist.
    expect(written.indexOf('delete firewall.bmfwd')).toBeLessThan(
      written.indexOf('delete firewall.bmwanpool')
    )
    expect(written).not.toContain('set firewall.bmwanpool=zone')
    expect(harness.handlers.get('pppoeBatches')?.()).toEqual([])
    runtime.dispose?.()
  })

  it('rebuilds the zone while any other batch still needs it', async () => {
    const { harness, uciBatches } = deleteHarness([BATCH, OTHER])
    const runtime = activate(harness.ctx)

    expect(harness.handlers.get('pppoeBatchDelete')?.('b1')).toMatchObject({ ok: true })
    await settle(40)

    const written = uciBatches.join('\n')
    expect(written).toContain('set firewall.bmwanpool=zone')
    expect(written).toContain("add_list firewall.bmwanpool.device='pppoe-is+'")
    expect(written).not.toContain("add_list firewall.bmwanpool.device='pppoe-pd+'")
    expect(written).not.toContain('delete firewall.bmwanpool\n')
    runtime.dispose?.()
  })

  it('leaves a zone the router does not have alone', async () => {
    // A create that failed before it wrote the zone leaves a record and no
    // zone; `uci delete` on a section that is not there fails the whole batch.
    const uciBatches: string[] = []
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: { version: 1, nextSeq: 9, batches: [BATCH] },
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command === 'sh -s' && stdin.startsWith('uci -q show network')) {
        return ok('network.pd00001=interface')
      }
      if (command === 'uci batch') {
        uciBatches.push(stdin)
        return ok()
      }
      return ok()
    })
    const runtime = activate(harness.ctx)

    expect(harness.handlers.get('pppoeBatchDelete')?.('b1')).toMatchObject({ ok: true })
    await settle(40)

    const written = uciBatches.join('\n')
    expect(written).not.toContain('delete firewall.')
    expect(harness.handlers.get('pppoeBatches')?.()).toEqual([])
    runtime.dispose?.()
  })
})
