import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'
import { parseCidr, rangeToCidrs, subnetContains } from '../../openwrt/main/util'
import { moduleHarness } from '../helpers/module-harness'

/**
 * An instance scoped to an address range rather than to its whole LAN.
 *
 * A range changes exactly two things, and the second one is the dangerous half.
 * The planner sees only the leases inside the range - that part is arithmetic -
 * and the fail-closed catch-all has to be written as the covering CIDR blocks
 * of that range instead of the single whole-LAN rule. Left whole-LAN, creating
 * one range instance would blackhole every other device on that LAN: they match
 * the catch-all, and the planner never gives them an assignment rule to lift
 * them back out. Written as a set but compared as a single rule, the per-tick
 * repair would tear the group down and write it again for ever.
 *
 * So the tests below assert both halves, plus the refusals that keep a range
 * that cannot mean anything from ever reaching the router.
 */

const ok = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

const STAMPED = {
  tableBase: DEFAULT_RULES.tableBase,
  rulePrefBase: DEFAULT_RULES.rulePrefBase,
  catchAllPrefBase: DEFAULT_RULES.catchAllPrefBase,
  catchAllTable: DEFAULT_RULES.catchAllTable,
  zoneName: DEFAULT_RULES.zoneName
}

const CATCH_PREF = DEFAULT_RULES.catchAllPrefBase
const RANGE = { from: '192.168.1.50', to: '192.168.1.99' }

const MODEL: RouterModel = {
  t: 1_700_000_000_000,
  sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
  ifaces: [
    {
      name: 'lan',
      proto: 'static',
      device: 'eth0',
      l3Device: 'br-lan',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '192.168.1.1', mask: 24 }
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
      ip4Table: 10_001,
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
      ip4Table: 10_002,
      ipv4: { addr: '198.51.100.2', mask: 32 }
    }
  ],
  poolDev: { count: 2, rx: 0, tx: 0 },
  leases: [
    // One address inside the range and one outside it, on the same LAN.
    { expires: 0, mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.60', host: 'inside' },
    { expires: 0, mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.1.200', host: 'outside' }
  ],
  rules: [],
  rates: {}
}

function fixture(source?: { kind: 'range'; from: string; to: string }): {
  engine: BindingEngine
  scripts: string[]
  model: RouterModel
} {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 1,
      nextSeq: 2,
      batches: [],
      instances: [
        {
          id: 'bind1',
          name: 'Office LAN',
          lan: 'lan',
          carrier: 'eth1',
          running: true,
          sticky: true,
          remap: true,
          createdAt: 1,
          slot: 0,
          layout: { ...STAMPED },
          ...(source ? { source } : {})
        }
      ],
      extraTables: [],
      stickyMap: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  const scripts: string[] = []
  harness.exec.mockImplementation(async (command, options) => {
    if (command === 'sh -s') scripts.push(options?.stdin ?? '')
    return ok()
  })
  const rules: OwrtRules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  return {
    engine: new BindingEngine(harness.ctx, store, { rules: () => rules }),
    scripts,
    model: structuredClone(MODEL)
  }
}

/** The rules the sweep would read back on the next tick. */
function nextTick(model: RouterModel): RouterModel {
  return {
    ...structuredClone(model),
    t: model.t + 5_000,
    sys: { ...model.sys, uptimeSec: model.sys.uptimeSec + 5 }
  }
}

describe('decomposing a range into the blocks a rule set can select on', () => {
  it('returns the single block when the range is already one', () => {
    expect(rangeToCidrs('192.168.1.0', '192.168.1.255')).toEqual(['192.168.1.0/24'])
    expect(rangeToCidrs('10.0.0.0', '10.0.0.3')).toEqual(['10.0.0.0/30'])
    // One address is a /32, which is the same statement the client rules make.
    expect(rangeToCidrs('192.168.1.7', '192.168.1.7')).toEqual(['192.168.1.7/32'])
  })

  it('walks an arbitrary range into the fewest blocks that cover it exactly', () => {
    // Neither endpoint is aligned, so this is the shape a person actually types
    // into a DHCP range field and the one a single-rule catch-all cannot express.
    expect(rangeToCidrs('192.168.1.50', '192.168.1.99')).toEqual([
      '192.168.1.50/31',
      '192.168.1.52/30',
      '192.168.1.56/29',
      '192.168.1.64/27',
      '192.168.1.96/30'
    ])
  })

  it('covers every address in the range and not one address outside it', () => {
    // The property the whole design rests on: what is not covered keeps the
    // router's default connection, and what is covered is fail-closed.
    const blocks = rangeToCidrs(RANGE.from, RANGE.to).map((block) => parseCidr(block)!)
    const covered = (ip: string): boolean =>
      blocks.some((block) => subnetContains(block, ip))

    expect(covered('192.168.1.50')).toBe(true)
    expect(covered('192.168.1.60')).toBe(true)
    expect(covered('192.168.1.99')).toBe(true)
    expect(covered('192.168.1.49')).toBe(false)
    expect(covered('192.168.1.100')).toBe(false)
    expect(covered('192.168.1.200')).toBe(false)
  })

  it('refuses a range it cannot express rather than returning a wider one', () => {
    expect(rangeToCidrs('192.168.1.99', '192.168.1.50')).toEqual([])
    expect(rangeToCidrs('not-an-address', '192.168.1.50')).toEqual([])
  })
})

describe('the catch-all a range instance installs', () => {
  it('writes one rule per block, all at the instance safety preference', async () => {
    const run = fixture({ kind: 'range', ...RANGE })

    await run.engine.onSample(run.model)

    const written = run.scripts.join('\n')
    for (const block of rangeToCidrs(RANGE.from, RANGE.to)) {
      expect(written).toContain(
        `ip -4 rule add from ${block} lookup ${DEFAULT_RULES.catchAllTable} pref ${CATCH_PREF}`
      )
    }
    // And nothing selecting the whole LAN: that single rule is exactly what
    // would blackhole every device outside the range.
    expect(written).not.toContain(
      `ip -4 rule add from 192.168.1.0/24 lookup ${DEFAULT_RULES.catchAllTable}`
    )
  })

  it('keeps the connected route on the whole LAN, not on the range', async () => {
    // Router reachability is destination-scoped and has nothing to do with
    // which sources are bound. Narrowed to the range, the router would stop
    // answering on its own LAN for every address outside it.
    const run = fixture({ kind: 'range', ...RANGE })

    await run.engine.onSample(run.model)

    expect(run.scripts.join('\n')).toContain(
      `ip -4 route replace 192.168.1.0/24 dev br-lan scope link table ${DEFAULT_RULES.catchAllTable}`
    )
  })

  it('does not rewrite the group on the next tick when it already matches', async () => {
    // The group is compared as a set, so a router handing the same five rules
    // back - in whatever order - is left alone. Compared as "exactly one rule
    // with from == the LAN CIDR", every tick would have torn it down again.
    const run = fixture({ kind: 'range', ...RANGE })
    await run.engine.onSample(run.model)

    const second = nextTick(run.model)
    // The kernel is under no obligation to preserve the write order.
    second.rules.reverse()
    run.scripts.length = 0
    await run.engine.onSample(second)

    const written = run.scripts.join('\n')
    expect(written).not.toContain(`ip -4 rule del pref ${CATCH_PREF}`)
    expect(written).not.toContain(`lookup ${DEFAULT_RULES.catchAllTable} pref ${CATCH_PREF}`)
  })

  it('leaves it alone when the kernel printed a /32 block without its prefix', async () => {
    /**
     * `ip rule show` drops the prefix from a single-address selector: a rule
     * written as `from 192.168.1.150/32` reads back as
     * `29900:\tfrom 192.168.1.150 lookup 200`, and the sweep keeps `from`
     * exactly as printed. Read with `parseCidr`, which requires a slash, that
     * last rule was nothing at all - so the group never matched what it had
     * been written with and the repair deleted and re-added the whole
     * catch-all on every single fast sample, for ever, leaking every
     * unassigned in-range device out of the router's own WAN in the gap
     * between the deletes and the adds. Ordinary ranges end in a /32 all the
     * time; the range above happens not to, which is why this went unseen.
     */
    const ending = { from: '192.168.1.100', to: '192.168.1.150' }
    expect(rangeToCidrs(ending.from, ending.to)).toContain('192.168.1.150/32')
    const run = fixture({ kind: 'range', ...ending })
    await run.engine.onSample(run.model)

    const second = nextTick(run.model)
    // The router's own spelling, which is what the next sweep really parses.
    second.rules = second.rules.map((rule) =>
      rule.from.endsWith('/32') ? { ...rule, from: rule.from.slice(0, -3) } : rule
    )
    run.scripts.length = 0
    await run.engine.onSample(second)

    const written = run.scripts.join('\n')
    expect(written).not.toContain(`ip -4 rule del pref ${CATCH_PREF}`)
    expect(written).not.toContain(`lookup ${DEFAULT_RULES.catchAllTable} pref ${CATCH_PREF}`)
  })

  it('rebuilds the whole group when one block has gone missing', async () => {
    const run = fixture({ kind: 'range', ...RANGE })
    await run.engine.onSample(run.model)

    const second = nextTick(run.model)
    second.rules = second.rules.filter(
      (rule) => !(rule.pref === CATCH_PREF && rule.from === '192.168.1.64/27')
    )
    run.scripts.length = 0
    await run.engine.onSample(second)

    const written = run.scripts.join('\n')
    expect(written).toContain(`ip -4 rule del pref ${CATCH_PREF}`)
    for (const block of rangeToCidrs(RANGE.from, RANGE.to)) {
      expect(written).toContain(
        `ip -4 rule add from ${block} lookup ${DEFAULT_RULES.catchAllTable} pref ${CATCH_PREF}`
      )
    }
  })

  it('still writes the single whole-LAN rule for an instance with no range', async () => {
    // The positive control for every instance that existed before ranges did.
    const run = fixture()

    await run.engine.onSample(run.model)

    expect(run.scripts.join('\n')).toContain(
      `ip -4 rule add from 192.168.1.0/24 lookup ${DEFAULT_RULES.catchAllTable} pref ${CATCH_PREF}`
    )
  })
})

// ------------------------------------------- one repair, one round trip each

/**
 * The widest range a /24 can hold, which is also the one that decomposes into
 * the most blocks - fourteen. Two instances repairing fourteen blocks each is
 * more lines than the narrowest command this module will send, which is what
 * makes the chunking below observable at all.
 */
const WIDE_ONE = { kind: 'range', from: '192.168.1.1', to: '192.168.1.254' } as const
const WIDE_TWO = { kind: 'range', from: '192.168.2.1', to: '192.168.2.254' } as const

/** The floor the rules editor allows for `ruleChunkLines`. */
const NARROW_CHUNK = 50

/**
 * Two ranged instances, on two LANs, with no leases anywhere: the only lines
 * this fixture can produce are catch-all lines, so a script that removes a
 * preference and a script that re-adds it are the whole subject.
 */
function twoRangedInstances(): {
  engine: BindingEngine
  scripts: string[]
  model: RouterModel
} {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 1,
      nextSeq: 3,
      batches: [],
      instances: [
        {
          id: 'bind1',
          name: 'First LAN',
          lan: 'lan',
          carrier: 'eth1',
          running: true,
          sticky: true,
          remap: true,
          createdAt: 1,
          slot: 0,
          layout: { ...STAMPED },
          source: WIDE_ONE
        },
        {
          id: 'bind2',
          name: 'Second LAN',
          lan: 'lan2',
          carrier: 'eth1',
          running: true,
          sticky: true,
          remap: true,
          createdAt: 2,
          slot: 1,
          layout: { ...STAMPED },
          source: WIDE_TWO
        }
      ],
      extraTables: [],
      stickyMap: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  const scripts: string[] = []
  harness.exec.mockImplementation(async (command, options) => {
    if (command === 'sh -s') scripts.push(options?.stdin ?? '')
    return ok()
  })
  const rules: OwrtRules = { ...DEFAULT_RULES, ruleChunkLines: NARROW_CHUNK }
  const store = new HostStore(harness.ctx, () => rules)
  const model = structuredClone(MODEL)
  model.leases = []
  model.ifaces.push({
    name: 'lan2',
    proto: 'static',
    device: 'eth0',
    l3Device: 'br-lan2',
    up: true,
    pending: false,
    autostart: true,
    uptimeSec: 4_000,
    ipv4: { addr: '192.168.2.1', mask: 24 }
  })
  return {
    engine: new BindingEngine(harness.ctx, store, { rules: () => rules }),
    scripts,
    model
  }
}

describe('a catch-all repair too long for one command', () => {
  it("keeps each instance's deletes and its own adds inside the same command", async () => {
    /**
     * Every chunk is its own `execScript`, so a chunk boundary is a round trip
     * to the router. Collected as one flat deletes-then-adds list across all
     * instances, the boundary could fall between an instance's deletes and its
     * adds - and for as long as that round trip was in flight that instance had
     * no catch-all standing, so its unassigned clients leaked out of the
     * router's default WAN, which is the single property the catch-all exists
     * to hold. Grouped per instance, a boundary can only ever fall between two
     * instances, where nothing is half-written.
     */
    const run = twoRangedInstances()
    await run.engine.onSample(run.model)

    // Lose one block from each group, which is what turns the next tick into a
    // full delete-and-rewrite of both preferences rather than an install.
    const second = nextTick(run.model)
    second.rules = second.rules.filter(
      (rule) => rule.from !== '192.168.1.64/26' && rule.from !== '192.168.2.64/26'
    )
    run.scripts.length = 0
    await run.engine.onSample(second)

    // The premise, asserted rather than assumed: one instance's repair fits in
    // a command and the two together do not. Without both halves this test
    // would pass just as well on the flat list it exists to rule out.
    const blocks = rangeToCidrs(WIDE_ONE.from, WIDE_ONE.to).length
    expect(2 * blocks - 1).toBeLessThanOrEqual(NARROW_CHUNK)
    expect(2 * (2 * blocks - 1)).toBeGreaterThan(NARROW_CHUNK)

    for (const [pref, range] of [
      [CATCH_PREF, WIDE_ONE],
      [CATCH_PREF + 1, WIDE_TWO]
    ] as const) {
      const removing = run.scripts.filter((script) =>
        script.includes(`ip -4 rule del pref ${pref}`)
      )
      expect(removing.length).toBeGreaterThan(0)
      for (const script of removing) {
        for (const block of rangeToCidrs(range.from, range.to)) {
          expect(script).toContain(
            `ip -4 rule add from ${block} lookup ${DEFAULT_RULES.catchAllTable} pref ${pref}`
          )
        }
      }
    }
  })
})

describe('which leases a range instance is allowed to see', () => {
  it('binds the address inside the range and leaves the one outside it alone', async () => {
    const run = fixture({ kind: 'range', ...RANGE })

    await run.engine.onSample(run.model)

    const bound = run.engine.rows('bind1').map((row) => row.ip)
    expect(bound).toEqual(['192.168.1.60'])
    // Not waiting either: an address outside the range is not this instance's
    // business at all, so it appears on neither table.
    expect(run.engine.waitingRows('bind1')).toEqual([])
    // Which of the two WANs it landed on is a random draw; that it landed on
    // one of them at the client preference base is not.
    expect(run.scripts.join('\n')).toMatch(
      /ip -4 rule add from 192\.168\.1\.60\/32 lookup 1000[12] pref 20000/
    )
    expect(run.scripts.join('\n')).not.toContain('from 192.168.1.200/32')
  })

  it('leaves the out-of-range device matching no catch-all block at all', async () => {
    // The whole point of decomposing the range. This device has no assignment
    // rule and must therefore fall through to the main table - the router's
    // default connection - rather than into the blackhole.
    const run = fixture({ kind: 'range', ...RANGE })

    await run.engine.onSample(run.model)

    const installed = run.model.rules
      .filter((rule) => rule.pref === CATCH_PREF)
      .map((rule) => parseCidr(rule.from)!)
    expect(installed.length).toBeGreaterThan(1)
    expect(installed.some((block) => subnetContains(block, '192.168.1.200'))).toBe(false)
    expect(installed.some((block) => subnetContains(block, '192.168.1.60'))).toBe(true)
  })

  it('binds both addresses when the instance has no range', async () => {
    const run = fixture()

    await run.engine.onSample(run.model)

    expect(run.engine.rows('bind1').map((row) => row.ip).sort()).toEqual([
      '192.168.1.200',
      '192.168.1.60'
    ])
  })
})

// ------------------------------------------------------------- the create gate

const text = (report: ModuleCheckReport): string =>
  report.findings.map((finding) => `${finding.label} ${finding.detail ?? ''}`).join('\n')

/** Enough of `uci show` for the create gate to reach its own verdict. */
const PREPARATION_PROBE = [
  '===DHCP===',
  'dhcp.@dnsmasq[0]=dnsmasq',
  "dhcp.@dnsmasq[0].dhcpleasemax='150'",
  'dhcp.lan=dhcp',
  "dhcp.lan.interface='lan'",
  "dhcp.lan.limit='150'",
  '===NETWORK===',
  'network.lan=interface',
  "network.lan.device='br-lan'",
  'network.pd00001=interface',
  "network.pd00001.ip4table='10001'",
  'network.pd00002=interface',
  "network.pd00002.ip4table='10002'",
  '===FIREWALL===',
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan'",
  'firewall.@zone[1]=zone',
  "firewall.@zone[1].name='wan'",
  "firewall.@zone[1].network='pd00001'",
  "firewall.@zone[1].network='pd00002'",
  "firewall.@zone[1].masq='1'",
  '===SYSCTL===',
  'net.netfilter.nf_conntrack_max=65536'
].join('\n')

/**
 * No instance in the store: the create gate is what is under test here, and an
 * instance already owning `lan` would refuse every form on that ground before
 * it ever looked at the range.
 */
function emptyRouter(): { engine: BindingEngine; store: HostStore; scripts: string[] } {
  const harness = moduleHarness('openwrt', () => ok())
  const scripts: string[] = []
  harness.exec.mockImplementation(async (command, options) => {
    const stdin = options?.stdin ?? ''
    if (command === 'sh -s' && stdin.includes("echo '===DHCP==='")) return ok(PREPARATION_PROBE)
    if (command === 'sh -s') scripts.push(stdin)
    return ok()
  })
  const rules: OwrtRules = { ...DEFAULT_RULES }
  const store = new HostStore(harness.ctx, () => rules)
  return {
    engine: new BindingEngine(harness.ctx, store, { rules: () => rules }),
    store,
    scripts
  }
}

async function checkRange(values: Record<string, unknown>): Promise<ModuleCheckReport> {
  const run = emptyRouter()
  await run.engine.onSample(structuredClone(MODEL))
  const report = await run.engine.check({
    name: 'Ranged',
    lan: 'lan',
    carrier: 'eth1',
    ...values
  })
  run.engine.dispose()
  return report
}

describe('a range the router could never act on is refused', () => {
  it('refuses a range that reaches outside the LAN subnet', async () => {
    // Every rule this instance writes selects a source behind its own LAN, so
    // an endpoint outside it names addresses no rule could ever match.
    const report = await checkRange({
      source: 'range',
      from: '192.168.1.50',
      to: '192.168.2.50'
    })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('is not inside 192.168.1.0/24')
  })

  it('refuses an inverted range', async () => {
    const report = await checkRange({
      source: 'range',
      from: '192.168.1.99',
      to: '192.168.1.50'
    })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('runs backwards')
  })

  it('refuses an endpoint that is not an address', async () => {
    const report = await checkRange({ source: 'range', from: '192.168.1.5o', to: '192.168.1.99' })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('must both be IPv4 addresses')
    // The unparsed value is deliberately not quoted back into the report.
    expect(text(report)).not.toContain('192.168.1.5o')
  })

  it('accepts a range inside the LAN and says what it will and will not touch', async () => {
    const report = await checkRange({ source: 'range', from: RANGE.from, to: RANGE.to })

    expect(report.ok).toBe(true)
    expect(text(report)).toContain('Only 192.168.1.50 - 192.168.1.99 will be bound, as 5 catch-all block(s)')
    expect(text(report)).toContain("outside that range are left alone and keep the router's default connection")
  })

  it('accepts a whole-LAN instance without mentioning ranges at all', async () => {
    const report = await checkRange({})

    expect(report.ok).toBe(true)
    expect(text(report)).not.toContain('will be bound, as')
  })

  it('carries an accepted range into the record and into the rules it installs', async () => {
    // The whole chain in one pass: the form is stamped onto the record, and the
    // catch-all the job writes is derived from that record rather than from the
    // LAN. A break anywhere between the two is what would leave an instance
    // stored as ranged and installed as whole-LAN.
    const run = emptyRouter()
    await run.engine.onSample(structuredClone(MODEL))
    const values = {
      name: 'Ranged',
      lan: 'lan',
      carrier: 'eth1',
      source: 'range',
      from: RANGE.from,
      to: RANGE.to
    }
    const report = await run.engine.check(values)
    expect(report.ok).toBe(true)
    if (!report.ok) return

    expect(await run.engine.apply({ token: report.token, values })).toMatchObject({ ok: true })

    expect(run.store.read().instances[0]?.source).toEqual({ kind: 'range', ...RANGE })
    const written = run.scripts.join('\n')
    for (const block of rangeToCidrs(RANGE.from, RANGE.to)) {
      expect(written).toContain(
        `ip -4 rule add from ${block} lookup ${DEFAULT_RULES.catchAllTable} pref ${CATCH_PREF}`
      )
    }
    expect(written).not.toContain(
      `ip -4 rule add from 192.168.1.0/24 lookup ${DEFAULT_RULES.catchAllTable}`
    )
  })
})

// ---------------------------------------------------------------- immutability

describe('the range of an instance that already exists', () => {
  it('cannot be edited, and the refusal names delete-and-recreate', async () => {
    // The catch-all standing on the router right now was written from the range
    // this instance was created with. Narrow it and every device that fell out
    // keeps matching a blackholed block with nothing coming to lift it back out.
    const run = fixture({ kind: 'range', ...RANGE })
    await run.engine.onSample(run.model)

    expect(run.engine.update('bind1', { from: '192.168.1.50', to: '192.168.1.80' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('delete this instance and create one with the range you want')
    })
    expect(run.engine.update('bind1', { source: 'lan' })).toMatchObject({ ok: false })
  })

  it('refuses turning a whole-LAN instance into a ranged one', async () => {
    const run = fixture()
    await run.engine.onSample(run.model)

    expect(
      run.engine.update('bind1', { source: 'range', from: RANGE.from, to: RANGE.to })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('the whole of lan')
    })
  })

  it('still lets the name and the two flags change on a ranged instance', async () => {
    // The positive control: the refusal must not have swallowed the edit form.
    const run = fixture({ kind: 'range', ...RANGE })
    await run.engine.onSample(run.model)

    expect(
      run.engine.update('bind1', {
        name: 'Renamed',
        source: 'range',
        from: RANGE.from,
        to: RANGE.to,
        sticky: false
      })
    ).toMatchObject({ ok: true })
    expect(run.engine.list()[0]?.name).toBe('Renamed')
  })

  it('cannot be renamed onto a second line', async () => {
    // The create gate refuses a control character in a name because that name
    // goes on to be a job label, an event row and a `ctx.log` line, where a
    // newline forges a whole line of its own. Checking only the length on the
    // edit path made a rename the way around the gate: create the instance
    // under a clean name, then edit it into a dirty one.
    const run = fixture({ kind: 'range', ...RANGE })
    await run.engine.onSample(run.model)

    const refused = run.engine.update('bind1', { name: 'Office\nbinding instance deleted' })

    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('on one line')
    // The offending value is not quoted back either - the refusal itself is a
    // string this module logs.
    expect(refused.error).not.toContain('binding instance deleted')
    expect(run.engine.list()[0]?.name).toBe('Office LAN')
  })
})
