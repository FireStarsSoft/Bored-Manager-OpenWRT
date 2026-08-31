import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { emptyCapabilities, type OpenWrtCapabilities } from '../../openwrt/main/probe'
import { classifyScan, parseScanOutput, scanRulesLookWhole } from '../../openwrt/main/scan'
import type { ScanRow } from '../../openwrt/main/scan'
import type { BindingInstanceRecord, DirectBindingRecord } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'

/**
 * The monitor exists because of one sentence in the module's own history: the
 * fast sweep filters `ip -4 rule show` down to the managed preference window on
 * the router, so a rule somebody wrote by hand - the one steering every packet
 * out of a WAN nobody remembers configuring - has never once been visible here.
 *
 * That makes two things the whole feature stands on, and both of them are what
 * this file is for. The parser must not repeat the assumptions the reconcile
 * parser is entitled to make (a numeric table, a `from` selector), because
 * those assumptions are exactly what hides a foreign rule. And the classifier
 * must reach its verdict from evidence the module can actually check, then say
 * it in a sentence somebody can act on - a table of preference numbers explains
 * nothing to the person who needs it.
 */

/**
 * One reply, assembled the way the router assembles it - `===TABLES===`
 * included, because which tables the routes pass ran over is something the
 * router states and nothing this side is allowed to infer.
 *
 * It defaults to the tokens the fixture supplies routes for, which is what a
 * router that reached every table would print. `tables` overrides it for the
 * case the section exists for: the two sets diverging on a router big enough
 * that the rules and the token list were harvested from different amounts of
 * the same file.
 */
const reply = (parts: {
  rules: readonly string[]
  main?: readonly string[]
  routes?: readonly string[]
  tables?: readonly string[]
  ok?: boolean
}): string => {
  const routes = parts.routes ?? []
  const queried = parts.tables ?? [...new Set(routes.map((line) => line.split(/\s+/)[0]))]
  return [
    '===RULES===',
    ...parts.rules,
    '===DEFAULT===',
    ...(parts.main ?? []),
    '===TABLES===',
    ...queried,
    '===ROUTES===',
    ...routes,
    '===SCANOK===',
    parts.ok === false ? '0' : '1'
  ].join('\n')
}

/** The kernel's own three, printed by every router that has ever booted. */
const BASELINE = [
  '0:\tfrom all lookup local',
  '32766:\tfrom all lookup main',
  '32767:\tfrom all lookup default'
]

const MAIN_DEFAULT = ['default via 192.0.2.1 dev eth0 proto static']

const router = (): RouterModel => ({
  t: 1_000,
  sys: { uptimeSec: 100, load1: 0, memTotal: 0, memFree: 0 },
  ifaces: [
    {
      name: 'wan',
      proto: 'dhcp',
      device: 'eth0',
      l3Device: 'eth0',
      up: true,
      pending: false,
      autostart: true,
      ipv4: { addr: '192.0.2.10', mask: 24 },
      uptimeSec: 100
    },
    {
      name: 'wan_bm0',
      proto: 'pppoe',
      device: 'eth1',
      l3Device: 'pppoe-bm0',
      up: true,
      pending: false,
      autostart: true,
      ipv4: { addr: '100.64.3.7', mask: 32 },
      uptimeSec: 100,
      ip4Table: 42
    }
  ],
  poolDev: { count: 0, rx: 0, tx: 0 },
  leases: [],
  rules: [],
  rates: {}
})

const instance = (patch: Partial<BindingInstanceRecord> = {}): BindingInstanceRecord => ({
  id: 'bind_1',
  name: 'Guest LAN',
  lan: 'lan',
  carrier: 'eth1',
  running: true,
  sticky: true,
  remap: true,
  createdAt: 1,
  slot: 0,
  ...patch
})

const direct = (patch: Partial<DirectBindingRecord> = {}): DirectBindingRecord => ({
  id: 'dir_1',
  name: 'Office NAS',
  target: { kind: 'ip', ip: '192.168.1.50' },
  wan: 'wan_bm0',
  enabled: true,
  whenDown: 'hold',
  pref: 19_003,
  table: 42,
  lan: 'lan',
  slot: 0,
  createdAt: 1,
  ...patch
})

const caps = (patch: Partial<OpenWrtCapabilities> = {}): OpenWrtCapabilities => ({
  ...emptyCapabilities(),
  ...patch
})

/** An agent that has bm-wanbind installed and is being driven. */
const withAgent = (): OpenWrtCapabilities => {
  const base = emptyCapabilities()
  return {
    ...base,
    agent: { ...base.agent, installed: true, running: true, usable: true, provides: ['binding'] }
  }
}

const scan = (
  stdout: string,
  patch: Partial<Parameters<typeof classifyScan>[0]> = {}
): ReturnType<typeof classifyScan> =>
  classifyScan({
    readout: parseScanOutput(stdout),
    rules: DEFAULT_RULES,
    model: router(),
    direct: [],
    instances: [],
    assignments: [],
    capabilities: caps(),
    ...patch
  })

const rowAt = (rows: readonly ScanRow[], pref: number): ScanRow => {
  const found = rows.find((row) => row.pref === pref)
  if (!found) throw new Error(`no row at preference ${pref}`)
  return found
}

describe('reading back a rule table the reconcile parser cannot see', () => {
  it('keeps a named-table rule that parseIpRules would have dropped', () => {
    // `lookup vpn` has no numeric table and would fail the reconcile parser's
    // `(?:lookup|table)\s+(\d+)`. It is also the single most likely shape for a
    // rule this module did not write, because a person naming a table in
    // /etc/iproute2/rt_tables is a person configuring something by hand.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      })
    )

    const row = rowAt(rows, 900)
    expect(row.table).toBe('vpn')
    expect(row.tableLabel).toBe('vpn')
    expect(row.ip).toBe('10.0.0.5')
    expect(row.ownerKind).toBe('foreign')
  })

  it('leaves the kernel baseline local/main/default rules out of the table', () => {
    // They are on every Linux machine that has ever booted and steer nothing
    // away from the default connection. Reported as rules written outside this
    // module they would be three permanent false positives sitting at the top
    // of a table whose whole value is that a row in it means something.
    const { rows, summary } = scan(reply({ rules: BASELINE, main: MAIN_DEFAULT }))

    expect(rows).toHaveLength(0)
    expect(summary.total).toBe(0)
    expect(summary.foreign).toBe(0)
  })

  it('still reports a policy rule that happens to name a built-in table', () => {
    // `from all lookup main` at priority 100 is not the kernel's baseline: it
    // is a real way to defeat every policy rule below it, and recognising the
    // baseline by its table name alone would have dismissed it.
    const { rows } = scan(
      reply({ rules: [...BASELINE, '100:\tfrom all lookup main'], main: MAIN_DEFAULT })
    )

    expect(rows.map((row) => row.pref)).toEqual([100])
    expect(rowAt(rows, 100).tableLabel).toBe('main (254)')
  })

  it('says so when the rule table was cut at the cap instead of counting what survived', () => {
    // This module writes one rule per bound client, so a router with more than
    // five hundred policy rules is ordinary rather than exotic. `head` prints
    // the same thing for a table that ends at the cap and one that was cut
    // there, so the script asks for one line more than it keeps: without that
    // extra line the page states "Rules seen: 500" as a fact about a table it
    // only saw the start of - and `ip -4 rule show` prints in ascending
    // preference, so what went missing is everything above the cut, this
    // module's own catch-alls included.
    // No baseline lines in this fixture on purpose: at 32766 and 32767 the
    // kernel's own main and default rules are themselves above the cut, which
    // is the shape of the problem rather than a detail of the fixture.
    const stdout = reply({
      rules: Array.from({ length: 501 }, (_, index) => `${1_000 + index}:\tfrom 10.1.0.9 lookup vpn`),
      main: MAIN_DEFAULT,
      routes: ['vpn default via 10.8.0.1 dev tun0']
    })

    const readout = parseScanOutput(stdout)
    expect(readout.rulesTruncated).toBe(true)
    expect(readout.rules).toHaveLength(500)
    // The extra line is evidence that there was more, not a rule to report:
    // kept, it would be one rule of an unknown remainder shown as if the
    // remainder did not exist.
    expect(readout.rules.some((rule) => rule.pref === 1_500)).toBe(false)

    const { rows, summary } = scan(stdout)
    expect(rows.some((row) => row.pref === 1_500)).toBe(false)
    expect(summary.total).toBe(500)
    expect(summary.rulesTruncated).toBe(true)
    expect(summary.rulesCap).toBe(500)
  })

  it('reports a table that merely ends at the cap as the whole table', () => {
    // The other half of the same test, and the reason the script asks for 501
    // rather than counting the 500 it kept: a router with exactly the cap has
    // nothing hidden, and a monitor that cried truncation at it would teach
    // its reader to ignore the warning.
    const readout = parseScanOutput(
      reply({
        rules: Array.from({ length: 500 }, (_, index) => `${1_000 + index}:\tfrom 10.1.0.9 lookup vpn`),
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      })
    )

    expect(readout.rulesTruncated).toBe(false)
    expect(readout.rules).toHaveLength(500)
  })

  it('discards a scan the router could not complete rather than reporting an empty router', () => {
    // The fail-closed half of the sentinel. "This router has no policy rules"
    // is the one answer the monitor must never give wrongly - it is the exact
    // opposite of what somebody opened the page to find out.
    const readout = parseScanOutput(reply({ rules: [], ok: false }))

    expect(readout.ok).toBe(false)
  })

  it('discards a rule dump with the sentinel set but no kernel baseline in it', () => {
    // The sentinel only says the router's own `ip -4 rule show` exited zero
    // into its temporary file; it cannot say that what came back down the wire
    // is what went into it. Every Linux router alive carries `from all lookup
    // local/main/default`, so a body holding none of those three is a read that
    // went wrong however clean the sentinel looks - and published it would be an
    // empty table under the one sentence this feature must never say wrongly.
    expect(scanRulesLookWhole(parseScanOutput(reply({ rules: [], main: MAIN_DEFAULT })))).toBe(
      false
    )
    expect(
      scanRulesLookWhole(
        parseScanOutput(reply({ rules: ['900:\tfrom 10.0.0.5 lookup vpn'], main: MAIN_DEFAULT }))
      )
    ).toBe(false)
    expect(scanRulesLookWhole(parseScanOutput(reply({ rules: BASELINE })))).toBe(true)
  })

  it('still accepts a dump cut at the cap, where the baseline is exactly what went missing', () => {
    // The other side of that check, and the reason it is not simply "no
    // baseline, no scan": the kernel's own rules sit at 32766 and 32767, so on
    // a router with five hundred rules below them they are precisely what
    // `head` left behind. Refusing that reply would blind the monitor on the
    // busiest routers it exists for, so it is reported as the truncated table
    // it is.
    const readout = parseScanOutput(
      reply({
        rules: Array.from({ length: 501 }, (_, index) => `${1_000 + index}:\tfrom 10.1.0.9 lookup vpn`),
        main: MAIN_DEFAULT
      })
    )

    expect(readout.rulesTruncated).toBe(true)
    expect(scanRulesLookWhole(readout)).toBe(true)
  })

  it('reads an rt_tables name that collides with an Object key as a table name', () => {
    // `/etc/iproute2/rt_tables` is written by whoever administers the router, so
    // a table called `constructor` is a table somebody can create. Looked up in
    // a plain object literal that name does not miss: it resolves through the
    // prototype to a function, sails past the `?? null` meant to catch an
    // unknown name, and the row told its reader the routing table was called
    // `function Object() { [native code] }`.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup constructor'],
        main: MAIN_DEFAULT,
        routes: ['constructor default via 10.8.0.1 dev tun0']
      })
    )

    const row = rowAt(rows, 900)
    expect(row.table).toBe('constructor')
    expect(row.tableLabel).toBe('constructor')
    expect(row.reason).toContain('routing table constructor')
    expect(row.reason).not.toContain('native code')
  })
})

describe('deciding who wrote a rule', () => {
  const withOwners = (rules: readonly string[], routes: readonly string[]) =>
    scan(reply({ rules: [...BASELINE, ...rules], main: MAIN_DEFAULT, routes }), {
      direct: [direct()],
      instances: [instance()],
      assignments: [{ ip: '192.168.1.11', wan: 'wan_bm0', instance: 'bind_1' }]
    })

  it('names a one-to-one binding from its stamped preference', () => {
    const { rows } = withOwners(
      ['19003:\tfrom 192.168.1.50/32 lookup 42'],
      ['42 default via 100.64.3.1 dev pppoe-bm0']
    )

    const row = rowAt(rows, 19_003)
    expect(row.ownerKind).toBe('direct')
    expect(row.owner).toBe('one-to-one binding')
    expect(row.reason).toContain('the one-to-one binding "Office NAS"')
  })

  it('refuses to credit a one-to-one binding for a rule that only shares its preference', () => {
    // Nothing stops somebody else's rule from being numbered where this module
    // numbers its own, and the preference alone was the whole verdict: a
    // stranger's rule at 19003 came back reported as a binding this module
    // wrote, which is the exact mistake the monitor exists to prevent, made in
    // the module's own voice. The record's address is the second piece of
    // evidence, the way the instance verdict has had two all along.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 10.0.0.9 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      { direct: [direct()] }
    )

    const row = rowAt(rows, 19_003)
    expect(row.ownerKind).toBe('foreign')
    expect(row.reason).toContain('This module did not write this rule.')
    // And the collision is said out loud rather than swallowed: a rule sitting
    // on this module's own priority is the first thing a reader needs to know.
    expect(row.reason).toContain('It does sit at preference 19003')
    expect(row.reason).toContain('that binding is written for 192.168.1.50 and this rule is not')
  })

  it('still owns a MAC-targeted binding, resolved through the same leases the reconcile uses', () => {
    // A one-to-one binding can name a device rather than an address, and the
    // rule on the router is written for whatever that MAC answers to. Comparing
    // the rule against the record's stored target without resolving it would
    // have called every MAC binding on the router foreign.
    const leased = router()
    leased.leases = [{ expires: 0, mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.77', host: 'nas' }]

    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.77/32 lookup 42'],
        main: MAIN_DEFAULT,
        routes: ['42 default via 100.64.3.1 dev pppoe-bm0']
      }),
      { direct: [direct({ target: { kind: 'mac', mac: 'aa:bb:cc:dd:ee:ff' } })], model: leased }
    )

    const row = rowAt(rows, 19_003)
    expect(row.ownerKind).toBe('direct')
    expect(row.reason).toContain('the one-to-one binding "Office NAS"')
  })

  it('names a binding instance from its band and a live assignment', () => {
    const { rows } = withOwners(
      ['20000:\tfrom 192.168.1.11/32 lookup 42'],
      ['42 default via 100.64.3.1 dev pppoe-bm0']
    )

    const row = rowAt(rows, 20_000)
    expect(row.ownerKind).toBe('instance')
    expect(row.reason).toContain('binding instance "Guest LAN" has that address assigned to wan_bm0')
  })

  it('names the safety catch-all at the slot its instance owns', () => {
    const { rows } = withOwners(
      ['29900:\tfrom 192.168.1.0/24 lookup 29999'],
      ['29999 unreachable default']
    )

    const row = rowAt(rows, 29_900)
    expect(row.ownerKind).toBe('catchAll')
    expect(row.reason).toContain('fail-closed catch-all for binding instance "Guest LAN"')
  })

  it('credits the router agent for a rule outside every band this module writes', () => {
    // The daemon numbers its rules from a base this module neither sets nor
    // reads back per-rule, so a cached assignment for the same address is the
    // only evidence there is - and one fast tick of staleness is something a
    // monitor can live with where a reconcile could not.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '5000:\tfrom 192.168.1.11/32 lookup 42'],
        main: MAIN_DEFAULT,
        routes: ['42 default via 100.64.3.1 dev pppoe-bm0']
      }),
      {
        assignments: [{ ip: '192.168.1.11', wan: 'wan_bm0', instance: 'bind_1' }],
        instances: [instance()],
        capabilities: withAgent()
      }
    )

    expect(rowAt(rows, 5_000).ownerKind).toBe('agent')
  })

  it('credits mwan3 on a router that runs it, and refuses to touch the rule', () => {
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '2000:\tfrom all fwmark 0x100/0x3f00 lookup 1'],
        main: MAIN_DEFAULT,
        routes: ['1 default via 192.0.2.1 dev eth0']
      }),
      { capabilities: caps({ mwan3: { config: true, running: true } }) }
    )

    const row = rowAt(rows, 2_000)
    expect(row.ownerKind).toBe('mwan3')
    expect(row.reason).toContain('This module will not touch it.')
  })

  it('still owns a one-to-one rule after the live band moved out from under it', () => {
    // `directPrefBase` stays editable while bindings exist, and the rules on
    // the router keep the numbers they were written with. Requiring the
    // stamped preference to fall inside a band derived from the *current*
    // setting made the page say "This module did not write this rule" about
    // every one-to-one binding at once, the moment somebody saved a new base -
    // the same trap the instance verdict deliberately avoids by reading each
    // record's stamped layout. A stored record at that exact preference is the
    // evidence; the live band cannot add anything to it.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.50/32 lookup 42'],
        main: MAIN_DEFAULT,
        routes: ['42 default via 100.64.3.1 dev pppoe-bm0']
      }),
      {
        direct: [direct()],
        rules: { ...DEFAULT_RULES, directPrefBase: 24_000, rulePrefBase: 25_000 }
      }
    )

    const row = rowAt(rows, 19_003)
    expect(row.ownerKind).toBe('direct')
    expect(row.reason).toContain('the one-to-one binding "Office NAS"')
  })

  it('leaves anything it cannot account for as written outside this module', () => {
    const { rows, summary } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      })
    )

    expect(rowAt(rows, 900).reason).toContain('This module did not write this rule.')
    expect(summary.byOwner['outside this module']).toBe(1)
    expect(summary.foreign).toBe(1)
  })
})

describe('the sentence each row carries', () => {
  it('builds the worked example: priority, table, exit interface and the contrast', () => {
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.50/32 lookup 42'],
        main: MAIN_DEFAULT,
        routes: ['42 default via 100.64.3.1 dev pppoe-bm0']
      }),
      { direct: [] }
    )

    const row = rowAt(rows, 19_003)
    expect(row.wan).toBe('wan_bm0')
    expect(row.wanIp).toBe('100.64.3.7')
    expect(row.reason).toBe(
      '192.168.1.50 has a priority-19003 policy rule that sends its traffic to routing table 42 before the main table is consulted. ' +
        "Table 42's default route leaves through pppoe-bm0 (wan_bm0, 100.64.3.7); the main table's default leaves through wan. " +
        "So this address does not use the router's default connection - it is bound to wan_bm0. " +
        'This module did not write this rule.'
    )
  })

  it('refuses to name a WAN when a shared carrier could be any session in the pool', () => {
    // Every PPPoE session in a pool carries the same carrier as its `device`,
    // so a default route leaving through the raw carrier matched whichever
    // session happened to sit first in the model - and the row then named a
    // WAN the traffic has nothing to do with, inside a sentence written to be
    // believed. The bare netdev is less than the reader wanted, and true.
    const pool = router()
    pool.ifaces.push({
      name: 'wan_bm1',
      proto: 'pppoe',
      device: 'eth1',
      l3Device: 'pppoe-bm1',
      up: true,
      pending: false,
      autostart: true,
      ipv4: { addr: '100.64.3.8', mask: 32 },
      uptimeSec: 100,
      ip4Table: 43
    })

    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 100.64.3.1 dev eth1']
      }),
      { model: pool }
    )

    const row = rowAt(rows, 900)
    expect(row.wan).toBe('')
    expect(row.wanIp).toBe('')
    expect(row.reason).toContain("Table vpn's default route leaves through eth1;")
    expect(row.reason).not.toContain('wan_bm0')
  })

  it('still resolves a carrier only one interface could be using', () => {
    // The fallback itself is not the problem - a static WAN's `device` is its
    // own netdev, and a lone session over a carrier nothing else shares is not
    // ambiguous. Only a pool is, and only the ambiguous case gives up.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 100.64.3.1 dev eth1']
      })
    )

    expect(rowAt(rows, 900).wan).toBe('wan_bm0')
  })

  it('says plainly when the table a rule points at has no way out', () => {
    // A rule pointing at a table with no default route is not a small problem
    // dressed up as a routing detail: the address it names cannot reach
    // anything at all, and every other surface in this module would show it as
    // perfectly bound.
    const { rows, summary } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn 10.8.0.0/24 dev tun0 scope link']
      })
    )

    const row = rowAt(rows, 900)
    expect(row.unreachable).toBe(true)
    expect(row.wan).toBe('')
    expect(row.reason).toContain(
      'Table vpn currently has no default route, so this traffic has no way out while the rule stands.'
    )
    // And no consequence sentence claiming a WAN it plainly does not have.
    expect(row.reason).not.toContain('it is bound to')
    expect(summary.unreachable).toBe(1)
    expect(row.ownerBadges.some((chip) => chip.label === 'no way out')).toBe(true)
  })

  it('reads a table the routes pass never queried as unknown rather than as no way out', () => {
    // The router harvests its table tokens with awk over the *whole* rule file
    // and cuts them lexicographically, while the rules it prints stop at the
    // cap - so on a busy router it can spend every one of its sixty-four slots
    // on tokens that only the unprinted rules named. Deciding "we looked at
    // this table" from the rules this side could see put a red "no way out" on
    // an address whose table had a perfectly good default route, and a
    // sentence saying it could not reach anything.
    const { rows, summary } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
        main: MAIN_DEFAULT,
        tables: ['aaa', 'bbb'],
        routes: ['aaa default via 10.9.0.1 dev tun9']
      })
    )

    const row = rowAt(rows, 900)
    expect(row.unreachable).toBe(false)
    expect(row.ownerBadges.some((chip) => chip.label === 'no way out')).toBe(false)
    expect(row.reason).toContain(
      "Table vpn's routes could not be read in this scan, so where it leads is not known."
    )
    expect(summary.unreachable).toBe(0)
  })

  it('does say no way out for a table the routes pass queried and found empty', () => {
    // The other side of the same test. Membership of the router's list is the
    // question, not whether any route came back: a table that was asked and
    // answered nothing is the real fault the "no way out" badge exists for,
    // and a fix that made the badge unreachable would be no fix at all.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
        main: MAIN_DEFAULT,
        tables: ['vpn'],
        routes: []
      })
    )

    expect(rowAt(rows, 900).unreachable).toBe(true)
  })

  it('tells a held one-to-one binding apart from a table nobody finished', () => {
    // Hold parks the address on the module's own blackhole table on purpose.
    // Read as "no way out" it would look like a fault; read as a working WAN it
    // would be the silent default-route leak hold exists to prevent.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.50/32 lookup 29999'],
        main: MAIN_DEFAULT,
        routes: ['29999 unreachable default']
      }),
      { direct: [direct()] }
    )

    const row = rowAt(rows, 19_003)
    expect(row.unreachable).toBe(false)
    expect(row.reason).toContain('answers unreachable for its default route')
    expect(row.reason).toContain('rather than quietly falling back to the default connection')
    expect(row.ownerBadges.some((chip) => chip.label === 'held')).toBe(true)
  })

  it('warns when a foreign rule outranks rules this module really did write', () => {
    // The lowest preference wins, so a rule at 900 is consulted before the
    // one-to-one band at 19000 and the assignment band at 20000. Every binding
    // the module reports as applied is then a statement about a rule the kernel
    // never reaches for these addresses - and the bound address here is inside
    // the /24 the foreign rule claims, so the sentence is true of this router.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 192.168.1.0/24 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      { direct: [direct()] }
    )

    const row = rowAt(rows, 900)
    expect(row.outranksModule).toBe(true)
    expect(row.reason).toContain(
      'This rule outranks every rule this module writes, so a binding shown as applied is not where the traffic actually goes.'
    )
    expect(row.ownerBadges.some((chip) => chip.label === 'outranks module')).toBe(true)
  })

  it('reports the preference without the accusation where this module writes nothing', () => {
    // Same rule, on a router carrying no binding of any kind. There is no
    // binding shown as applied for it to be wrong about, so the red chip and
    // the sentence were an accusation over a rule doing nothing to anybody -
    // and a warning that fires on every router teaches its reader to skip it.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 192.168.1.0/24 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      })
    )

    const row = rowAt(rows, 900)
    expect(row.outranksModule).toBe(false)
    expect(row.ownerBadges.some((chip) => chip.label === 'outranks module')).toBe(false)
    // The preference is still a fact, and still reported as one.
    expect(row.reason).toContain(
      'This rule is numbered below every preference this module writes at, so the kernel consults it before any of them.'
    )
    expect(row.reason).not.toContain('is not where the traffic actually goes')
  })

  it('keeps quiet about a low rule whose source cannot cover a managed address', () => {
    // The module does write here, but this rule selects on 10.0.0.0/8 and the
    // only address it has placed is 192.168.1.50. A preference outranks
    // something only when there is something underneath it.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.0/8 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      { direct: [direct()] }
    )

    const row = rowAt(rows, 900)
    expect(row.outranksModule).toBe(false)
    expect(row.reason).not.toContain('is not where the traffic actually goes')
  })

  it('does not deny the main table a default route the router plainly has', () => {
    // `ip route show table main` prints a load-balanced default across several
    // lines, and the router's own `grep '^default'` keeps the first of them, so
    // the route arrives naming no `dev` at all. Read as "no device, therefore no
    // default route" it told the reader their router had no way out while the
    // router was busy using two of them.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
        main: ['default proto static'],
        routes: ['vpn default via 10.8.0.1 dev tun0']
      })
    )

    const row = rowAt(rows, 900)
    expect(row.reason).toContain("the main table's own default names no single interface")
    expect(row.reason).not.toContain('the main table has no default route')
  })

  it('keeps the no-default-route wording for a main table that really has none', () => {
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 10.0.0.5 lookup vpn'],
        routes: ['vpn default via 10.8.0.1 dev tun0']
      })
    )

    expect(rowAt(rows, 900).reason).toContain('the main table has no default route of its own')
  })

  it('reports a from-less selector without attributing it to an address', () => {
    // fwmark, iif and oif rules are real and common, and the reconcile parser
    // drops all of them. Reported here, but never given a source address it
    // does not name - that attribution would be invented.
    const { rows, summary } = scan(
      reply({
        rules: [...BASELINE, '100:\tfrom all fwmark 0x1 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      })
    )

    const row = rowAt(rows, 100)
    expect(row.sourceRouted).toBe(false)
    expect(row.ip).toBe('fwmark 0x1')
    expect(row.reason).toContain(
      'A priority-100 policy rule selecting on fwmark 0x1 sends matching traffic to routing table vpn'
    )
    expect(row.reason).toContain('it is not attributed to one here')
    expect(summary.selectors).toBe(1)
  })

  it('carries the rule text and the table routes for the detail panel', () => {
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.50/32 lookup 42'],
        main: MAIN_DEFAULT,
        routes: ['42 default via 100.64.3.1 dev pppoe-bm0', '42 100.64.3.0/24 dev pppoe-bm0 scope link']
      })
    )

    const row = rowAt(rows, 19_003)
    expect(row.rule).toBe('19003:\tfrom 192.168.1.50/32 lookup 42')
    expect(row.routes).toHaveLength(2)
    expect(row.mainDefault).toBe(MAIN_DEFAULT[0])
  })
})
