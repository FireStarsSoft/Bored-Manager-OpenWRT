import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine, type WanTableSource } from '../../openwrt/main/binding'
import { DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * The slow tick audits `option ip4table` on every managed WAN, and it used to
 * repair whatever was missing without asking and without saying so anywhere a
 * user could see: `uci set`, `commit network` and `/etc/init.d/network reload`
 * on a production router, reported to the app log alone. `autoRepairTables`
 * makes the write the operator's decision; either way the audit now speaks
 * through the module's own event trail.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const MODEL: RouterModel = {
  t: 1_700_000_000_000,
  sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
  ifaces: [
    {
      name: 'lan',
      proto: 'static',
      device: 'br-lan',
      l3Device: 'br-lan',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '192.168.1.1', mask: 24 }
    },
    // Not managed by any batch, but it shares the carrier, so it is in the pool
    // the audit walks. Nothing may ever be written to it.
    {
      name: 'wan',
      proto: 'dhcp',
      device: 'eth1',
      l3Device: 'eth1',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '10.0.0.2', mask: 24 }
    },
    {
      name: 'pd00001',
      proto: 'pppoe',
      device: 'eth1',
      l3Device: 'pppoe-pd00001',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 3_000,
      ipv4: { addr: '198.51.100.1', mask: 32 }
    },
    {
      name: 'pd00002',
      proto: 'pppoe',
      device: 'eth1',
      l3Device: 'pppoe-pd00002',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 3_000,
      ipv4: { addr: '198.51.100.2', mask: 32 }
    }
  ],
  poolDev: { count: 2, rx: 0, tx: 0 },
  leases: [{ expires: 0, mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.20', host: 'desk' }],
  rules: [],
  rates: {}
}

function hostData(): unknown {
  return {
    version: 1,
    nextSeq: 3,
    batches: [
      {
        id: 'b1',
        name: 'Home',
        prefix: 'pd',
        carrier: 'eth1',
        createdAt: 1,
        count: 2,
        seqFrom: 1,
        seqTo: 2
      }
    ],
    instances: [
      {
        id: 'bind1',
        name: 'Office LAN',
        lan: 'lan',
        carrier: 'eth1',
        // The audit is not gated on a running instance, and a stopped one is
        // the case where a silent rewrite would surprise someone the most.
        running: false,
        sticky: true,
        remap: true,
        createdAt: 1,
        slot: 0
      }
    ],
    extraTables: [],
    stickyMap: [],
    events: [],
    moduleEvents: [],
    jobs: []
  }
}

/** `tableBase` is 10 000, so batch sequence 1 and 2 own tables 10001 and 10002. */
const BOTH: Array<[string, number]> = [
  ['pd00001', 10_001],
  ['pd00002', 10_002]
]
const SECOND_LOST: Array<[string, number]> = [['pd00001', 10_001]]
const BOTH_LOST: Array<[string, number]> = []

interface Audited {
  audit(source: WanTableSource): Promise<void>
  events: Array<{ kind: string; text: string }>
  commands: string[]
  /** The stdin of every `uci` batch the audit sent. */
  writes: string[]
  failNextWrite(): void
  /** The next batch exits 0 and prints the line UCI refused, as `uci -q` does. */
  rejectNextWrite(): void
  /** The same store the engine holds, so a test can take its network lock. */
  store: HostStore
}

function auditor(overrides: Partial<OwrtRules> = {}): Audited {
  const events: Array<{ kind: string; text: string }> = []
  const commands: string[] = []
  const writes: string[] = []
  let failNext = false
  let rejectNext = false
  const harness = moduleHarness('openwrt', () => ok(), { hostData: hostData() })
  harness.exec.mockImplementation(async (command, execOptions) => {
    commands.push(command)
    // Matched loosely on purpose: which `uci` invocation the audit uses is
    // exactly what one of the tests below is about.
    if (command.startsWith('uci') && command.includes('batch')) {
      writes.push(execOptions?.stdin ?? '')
      if (failNext) {
        failNext = false
        // What `uci batch` really does on a bad line: it echoes the line back.
        // Nothing built from this may reach a user-visible string.
        return ok('', "uci: Parse error: network.pd00002.password='hunter2'", 1)
      }
      if (rejectNext) {
        rejectNext = false
        // `-q` swallows the per-command failure and the batch still exits 0.
        return ok('', "uci: Parse error: network.pd00002.password='hunter2'", 0)
      }
    }
    return ok()
  })
  const rules: OwrtRules = { ...DEFAULT_RULES, ...overrides }
  const store = new HostStore(harness.ctx, () => rules)
  const engine = new BindingEngine(harness.ctx, store, {
    rules: () => rules,
    event: (kind, text) => events.push({ kind, text })
  })
  let primed = false
  return {
    events,
    commands,
    writes,
    store,
    failNextWrite: () => {
      failNext = true
    },
    rejectNextWrite: () => {
      rejectNext = true
    },
    audit: async (source) => {
      if (!primed) {
        primed = true
        await engine.onSample(MODEL)
        commands.length = 0
      }
      await engine.reconcileWanTables(source)
    }
  }
}

/** Let every pending microtask - and every awaited exec - run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const kinds = (events: Array<{ kind: string }>): string[] => events.map((event) => event.kind)

describe('repairing a lost ip4table with the rule on', () => {
  it('writes only the WAN that lost it, reloads, and says so', async () => {
    const run = auditor()

    await run.audit(SECOND_LOST)

    expect(run.writes).toEqual(["set network.pd00002.ip4table='10002'\ncommit network\n"])
    expect(run.commands).toContain('/etc/init.d/network reload')
    // pd00001 still has its option and `wan` was never managed by a batch.
    expect(run.writes.join('')).not.toContain('network.pd00001')
    expect(run.writes.join('')).not.toContain('network.wan.')

    expect(run.events).toEqual([
      {
        kind: 'wan-table-repaired',
        text: 'Restored option ip4table on 1 WAN(s) and reloaded the network (pd00002)'
      }
    ])
  })

  it('names at most three WANs, however many were repaired', async () => {
    const run = auditor()

    await run.audit(BOTH_LOST)

    expect(run.events[0]?.text).toContain('on 2 WAN(s)')
    expect(run.events[0]?.text).toContain('(pd00001, pd00002)')
  })

  it('stops writing after a bounded number of attempts at the same set', async () => {
    const run = auditor()

    // A router that keeps losing the option: every slow tick reports the same
    // WAN missing however many times it has just been written. The audit used
    // to latch on having emitted an event, so the event was said once and the
    // `uci set` + `commit network` + `network reload` behind it ran on every
    // one of these ticks, unbounded, for as long as the router stayed this way.
    for (let tick = 0; tick < 6; tick++) await run.audit(SECOND_LOST)

    expect(run.writes).toHaveLength(3)
    expect(run.commands.filter((command) => command === '/etc/init.d/network reload'))
      .toHaveLength(3)
    expect(kinds(run.events)).toEqual([
      'wan-table-repaired',
      'wan-table-repaired',
      'wan-table-repaired',
      // Said once, and only once, when it gives up.
      'wan-table-repair-stopped'
    ])
    expect(run.events[3]?.text).toContain('did not stay on 1 WAN(s)')
  })

  it('gives a different set its own attempts', async () => {
    const run = auditor()

    for (let tick = 0; tick < 4; tick++) await run.audit(SECOND_LOST)
    const spent = run.writes.length
    await run.audit(BOTH_LOST)

    expect(run.writes).toHaveLength(spent + 1)
    expect(run.writes[spent]).toContain('network.pd00001.ip4table')
  })

  it('waits for the network config lock instead of racing a PPPoE commit', async () => {
    const run = auditor()
    await run.audit(BOTH)

    // Stand in for a PPPoE create holding /etc/config/network. Two `uci batch`
    // runs committing that file at once lose one of the two outright: whichever
    // commits second read the file before the first wrote it, and writes its
    // own copy back over everything.
    let release = (): void => {}
    const holding = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = run.store.withNetwork(() => holding)

    const audit = run.audit(SECOND_LOST)
    await settle()
    expect(run.writes).toEqual([])

    release()
    await held
    await audit
    expect(run.writes).toHaveLength(1)
  })
})

describe('the same rule switched off', () => {
  it('reports what it found and writes nothing at all', async () => {
    const run = auditor({ autoRepairTables: false })

    await run.audit(SECOND_LOST)

    expect(run.writes).toEqual([])
    expect(run.commands).toEqual([])
    expect(run.events).toEqual([
      {
        kind: 'wan-table-missing',
        text: '1 WAN(s) have lost option ip4table and automatic repair is switched off; their assignments stop routing once netifd drops the running table (pd00002)'
      }
    ])
  })

  it('says it once, not once per slow tick', async () => {
    const run = auditor({ autoRepairTables: false })

    await run.audit(SECOND_LOST)
    await run.audit(SECOND_LOST)
    await run.audit(SECOND_LOST)

    expect(run.events).toHaveLength(1)
  })

  it('speaks up again when a different WAN joins the list', async () => {
    const run = auditor({ autoRepairTables: false })

    await run.audit(SECOND_LOST)
    await run.audit(BOTH_LOST)

    expect(kinds(run.events)).toEqual(['wan-table-missing', 'wan-table-missing'])
    expect(run.events[1]?.text).toContain('2 WAN(s)')
  })

  it('speaks up again when the same WAN loses it a second time', async () => {
    const run = auditor({ autoRepairTables: false })

    await run.audit(SECOND_LOST)
    // Someone put the option back by hand: the audit comes back clean, so the
    // next loss is news rather than a repeat of a notice already on screen.
    await run.audit(BOTH)
    await run.audit(SECOND_LOST)

    expect(kinds(run.events)).toEqual(['wan-table-missing', 'wan-table-missing'])
  })
})

describe('a table another owner already claimed', () => {
  it('is reported and never overwritten, whatever the rule says', async () => {
    for (const autoRepairTables of [true, false]) {
      const run = auditor({ autoRepairTables })

      await run.audit([
        ['pd00001', 10_001],
        ['pd00002', 20_002]
      ])

      expect(run.writes).toEqual([])
      expect(run.events).toEqual([
        {
          kind: 'wan-table-conflict',
          text: '1 WAN(s) point at a routing table this module did not assign, so option ip4table is left alone (pd00002: expected 10002, found 20002)'
        }
      ])
    }
  })
})

describe('a repair that did not land', () => {
  it('reports nothing, keeps the router error to itself, and retries', async () => {
    const run = auditor()
    run.failNextWrite()

    await expect(run.audit(SECOND_LOST)).rejects.toThrow(
      'repair WAN routing tables failed (exit 1)'
    )
    expect(run.events).toEqual([])

    // The latch is only closed by a repair that finished, so the next slow tick
    // still tries - and still reports when it works.
    await run.audit(SECOND_LOST)
    expect(kinds(run.events)).toEqual(['wan-table-repaired'])
  })

  it('never lets uci echo a PPPoE password into a message', async () => {
    const run = auditor()
    run.failNextWrite()

    const failure = await run.audit(SECOND_LOST).catch((error: unknown) => error)

    expect(String(failure)).not.toContain('hunter2')
    expect(String(failure)).not.toContain('Parse error')
  })

  it('fails a batch UCI refused, however the exit code reads', async () => {
    const run = auditor()
    run.rejectNextWrite()

    // `uci -q batch` exits 0 whether or not it applied anything, so a write
    // judged on its exit code alone reported success for a batch UCI had
    // rejected outright - and the audit announced "Restored option ip4table"
    // for a WAN whose configuration it had not changed.
    await expect(run.audit(SECOND_LOST)).rejects.toThrow(
      'repair WAN routing tables failed'
    )
    expect(run.events).toEqual([])
    expect(run.commands).not.toContain('/etc/init.d/network reload')
  })

  it('sends its writes through the one runner that reads the error line', async () => {
    const run = auditor()

    await run.audit(SECOND_LOST)

    // `uci -q batch` is the form that hides the error line. Nothing in this
    // folder may use it.
    expect(run.commands.filter((command) => command.startsWith('uci'))).toEqual([
      'uci batch'
    ])
  })
})
