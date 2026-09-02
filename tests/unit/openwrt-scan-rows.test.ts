/**
 * The binding monitor, now that it asks the router instead of working it out.
 *
 * This replaces `openwrt-scan-classify`, `openwrt-scan-grace` and
 * `openwrt-scan-layouts`, which together were about a thousand lines of one
 * question: given the text of `ip -4 rule show` and a guess at which priority
 * bands this module owned, whose rule is this? From packages 2.4.0 that
 * question is answered by `bm-wanbind`, because it is the half that knows which
 * sections exist and which bands each was stamped with - and two classifiers
 * would be two answers about one rule. The classification itself is tested
 * against the real ucode by the `wanbind-rules` probe.
 *
 * What is left on this side, and what is tested here, is what the page does
 * with those answers: the kernel's own baseline is dropped, netifd's rules are
 * named rather than accused, a rule pointing at a table with no way out is
 * called parked rather than bound, and a truncated list says so.
 */
import { describe, expect, it } from 'vitest'
import type { WanbindRulesReply } from '../../openwrt/main/agent'

type WanbindRuleRow = WanbindRulesReply['rules'][number]
type WanbindRuleOwner = WanbindRuleRow['owner']
type WanbindTableRow = WanbindRulesReply['tables'][number]
import { buildScanRows, tableLabel } from '../../openwrt/main/scan'

function rule(over: Partial<WanbindRuleRow> & { owner: WanbindRuleOwner }): WanbindRuleRow {
  return {
    pref: 19000,
    cidr: '12.10.10.10/32',
    table: 10001,
    action: 1,
    selector: 'from 12.10.10.10/32',
    id: '',
    instance: '',
    reason: '',
    ...over
  }
}

function table(over: Partial<WanbindTableRow> & { table: number }): WanbindTableRow {
  return {
    wan: '',
    role: '',
    hasDefault: true,
    device: '',
    gateway: '',
    unreachable: false,
    ...over
  }
}

function reply(over: Partial<WanbindRulesReply> = {}): WanbindRulesReply {
  return {
    ok: true,
    read: true,
    count: 0,
    capped: false,
    limit: 2000,
    rules: [],
    bands: { direct: { base: 19000, top: 19999 }, instances: [] },
    main: { device: 'eth2', gateway: '192.168.1.1' },
    tables: [],
    ...over
  }
}

describe('the rows the monitor page draws', () => {
  it('drops the kernel baseline instead of putting three permanent rows on top', () => {
    const built = buildScanRows(
      reply({
        rules: [
          rule({ owner: 'kernel', pref: 0, cidr: '', selector: 'from all lookup local', table: 255 }),
          rule({ owner: 'kernel', pref: 32766, cidr: '', selector: 'from all lookup main', table: 254 }),
          rule({ owner: 'manual', pref: 19000, id: 'desk' })
        ]
      })
    )

    expect(built.rows).toHaveLength(1)
    expect(built.rows[0].pref).toBe(19000)
    expect(built.summary.total).toBe(1)
  })

  it('names netifd rather than accusing it, and leaves it out of the count to act on', () => {
    // The number this fixes. A router dialling thirty-two PPPoE sessions gets
    // three rules per interface from netifd without anybody asking, and the
    // module used to call all ninety-six a stranger's - ninety-six alarming
    // rows burying the handful worth reading.
    const netifd: WanbindRuleRow[] = []
    for (let i = 0; i < 96; i += 1) {
      netifd.push(rule({ owner: 'netifd', pref: 10000 + i, cidr: '', selector: '', table: 10001 + i }))
    }

    const built = buildScanRows(
      reply({
        rules: [...netifd, rule({ owner: 'foreign', pref: 5000, cidr: '10.0.0.9/32', table: 900 })]
      })
    )

    expect(built.summary.foreign).toBe(1)
    expect(built.summary.byOwner['outside this module']).toBe(1)
    expect(built.summary.byOwner['the router routing itself']).toBe(96)
  })

  it('tells an address parked on purpose from a table that is simply broken', () => {
    // Two different things a person has to do something different about, and
    // the row says which. A hold table answers `unreachable` because somebody
    // chose fail-closed for that binding while its WAN is down; a table with no
    // default at all is a WAN that never got one, and the address on it is
    // going nowhere for a reason nobody chose.
    const parked = buildScanRows(
      reply({
        rules: [rule({ owner: 'manual', pref: 19000, table: 253, id: 'desk' })],
        tables: [table({ table: 253, role: 'hold', unreachable: true, hasDefault: true })]
      })
    )

    expect(parked.rows[0].ownerBadges.map((chip) => chip.label)).toContain('parked')
    expect(parked.rows[0].unreachable).toBe(false)
    expect(parked.summary.unreachable).toBe(0)

    const broken = buildScanRows(
      reply({
        rules: [rule({ owner: 'manual', pref: 19000, table: 10001, id: 'desk' })],
        tables: [table({ table: 10001, role: 'wan', wan: 'f01', hasDefault: false })]
      })
    )

    expect(broken.rows[0].unreachable).toBe(true)
    expect(broken.rows[0].ownerBadges.map((chip) => chip.label)).toContain('no way out')
    expect(broken.summary.unreachable).toBe(1)
  })

  it('names the WAN a table actually leaves through', () => {
    const built = buildScanRows(
      reply({
        rules: [rule({ owner: 'manual', pref: 19000, table: 10001, id: 'desk' })],
        tables: [
          table({
            table: 10001,
            wan: 'f01',
            role: 'wan',
            device: 'pppoe-f01',
            gateway: '100.123.0.150'
          })
        ]
      })
    )

    expect(built.rows[0].wan).toBe('f01')
    expect(built.rows[0].wanIp).toBe('100.123.0.150')
    expect(built.rows[0].unreachable).toBe(false)
  })

  it('says when the list was cut short, so an empty tail is not read as an empty router', () => {
    const built = buildScanRows(
      reply({
        capped: true,
        limit: 3,
        count: 900,
        rules: [rule({ owner: 'foreign', pref: 5000, cidr: '10.0.0.9/32', table: 900 })]
      })
    )

    expect(built.summary.rulesTruncated).toBe(true)
    expect(built.summary.cap).toBe(3)
  })

  it('gives every table its well-known name', () => {
    expect(tableLabel(254)).toContain('main')
    expect(tableLabel(255)).toContain('local')
    expect(tableLabel(10001)).toContain('10001')
    expect(tableLabel(0)).toMatch(/no table/i)
  })
})
