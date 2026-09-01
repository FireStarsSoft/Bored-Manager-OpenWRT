import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { emptyCapabilities } from '../../openwrt/main/probe'
import { classifyScan, parseScanOutput } from '../../openwrt/main/scan'
import type { ScanRow } from '../../openwrt/main/scan'
import type { DirectBindingRecord } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'

/**
 * The five minutes after a bound laptop is closed.
 *
 * The one-to-one pass keeps a rule installed at the last address it saw for the
 * whole of Lease release grace (s), so that a device asleep for thirty seconds
 * does not lose and regain its WAN. The leases stop answering for that device
 * immediately, and the monitor used to ask only the leases - so for the whole of
 * that window it published a rule this module had written, at a preference in
 * this module's own band, under "outside this module", with a sentence saying
 * this module did not write it. The documented response to a foreign rule in the
 * module's band is to go and remove it, which is how the page came to talk a
 * person into hand-deleting a rule the module owned and was about to withdraw
 * itself.
 *
 * So the question these tests hold down is a narrow one: an address belongs to a
 * binding for exactly as long as a rule for it stands, and not one tick longer.
 * A stranger's rule sharing the preference must still be called what it is.
 */

const reply = (parts: {
  rules: readonly string[]
  main?: readonly string[]
  routes?: readonly string[]
}): string => {
  const routes = parts.routes ?? []
  return [
    '===RULES===',
    ...parts.rules,
    '===DEFAULT===',
    ...(parts.main ?? []),
    '===TABLES===',
    ...new Set(routes.map((line) => line.split(/\s+/)[0])),
    '===ROUTES===',
    ...routes,
    '===SCANOK===',
    '1'
  ].join('\n')
}

/** The kernel's own three, printed by every router that has ever booted. */
const BASELINE = [
  '0:\tfrom all lookup local',
  '32766:\tfrom all lookup main',
  '32767:\tfrom all lookup default'
]

const MAIN_DEFAULT = ['default via 192.0.2.1 dev eth0 proto static']
const BOUND_TABLE = ['42 default via 100.64.3.1 dev pppoe-bm0']

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
  // No lease for the bound MAC anywhere in this file except where a test adds
  // one back: the whole subject here is the window in which there is none.
  leases: [],
  rules: [],
  rates: {}
})

/** A laptop bound by MAC - the only target kind a lease can disappear from. */
const laptop = (patch: Partial<DirectBindingRecord> = {}): DirectBindingRecord => ({
  id: 'dir_1',
  name: 'Nina laptop',
  target: { kind: 'mac', mac: 'aa:bb:cc:dd:ee:ff' },
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
    capabilities: emptyCapabilities(),
    ...patch
  })

const rowAt = (rows: readonly ScanRow[], pref: number): ScanRow => {
  const found = rows.find((row) => row.pref === pref)
  if (!found) throw new Error(`no row at preference ${pref}`)
  return found
}

describe('a one-to-one rule standing through the lease release grace', () => {
  it('credits the binding for a rule whose device has no lease any more', () => {
    const { rows, summary } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.77/32 lookup 42'],
        main: MAIN_DEFAULT,
        routes: BOUND_TABLE
      }),
      {
        direct: [laptop()],
        installed: [{ id: 'dir_1', ip: '192.168.1.77' }]
      }
    )

    const row = rowAt(rows, 19_003)
    expect(row.ownerKind).toBe('direct')
    expect(row.owner).toBe('one-to-one binding')
    expect(row.reason).toContain('the one-to-one binding "Nina laptop"')
    expect(row.reason).not.toContain('This module did not write this rule')
    // And the row says why an address nothing answers to has a rule at all,
    // naming the setting that ends it, so nobody goes looking for the culprit.
    expect(row.reason).toContain('Lease release grace (s)')
    expect(summary.foreign).toBe(0)
    expect(summary.byOwner['outside this module']).toBe(0)
    expect(summary.byOwner['one-to-one binding']).toBe(1)
  })

  it('still refuses a stranger sitting on that preference while the grace runs', () => {
    // The other half, and the reason the address is asked about at all: the
    // remembered address widens what this module will own by exactly one
    // address, and not by the preference.
    const { rows, summary } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 10.0.0.9 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      {
        direct: [laptop()],
        installed: [{ id: 'dir_1', ip: '192.168.1.77' }]
      }
    )

    const row = rowAt(rows, 19_003)
    expect(row.ownerKind).toBe('foreign')
    expect(row.reason).toContain('This module did not write this rule.')
    expect(row.reason).toContain('It does sit at preference 19003')
    expect(row.reason).toContain(
      'that binding is written for 192.168.1.77 and this rule is not'
    )
    expect(summary.foreign).toBe(1)
  })

  it('leaves a rule at a neighbouring preference in the band foreign', () => {
    // 19004 is inside the one-to-one band and no record was ever stamped with
    // it. The band is where this module writes, which has never been evidence
    // that it wrote - and a grace-held binding three numbers away changes
    // nothing about that.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19004:\tfrom 192.168.1.90/32 lookup 42'],
        main: MAIN_DEFAULT,
        routes: BOUND_TABLE
      }),
      {
        direct: [laptop()],
        installed: [{ id: 'dir_1', ip: '192.168.1.77' }]
      }
    )

    const row = rowAt(rows, 19_004)
    expect(row.ownerKind).toBe('foreign')
    expect(row.reason).toContain('This module did not write this rule.')
  })

  it('names both addresses when a binding has moved and its old rule still stands', () => {
    // The device came back on a different address before the grace ran out, so
    // the binding answers to one address and its rule is written for another.
    // A refusal naming only one of them would be contradicted by the very next
    // row of the same table.
    const leased = router()
    leased.leases = [{ expires: 0, mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.80', host: 'nina' }]

    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 10.0.0.9 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      {
        model: leased,
        direct: [laptop()],
        installed: [{ id: 'dir_1', ip: '192.168.1.77' }]
      }
    )

    const row = rowAt(rows, 19_003)
    expect(row.ownerKind).toBe('foreign')
    expect(row.reason).toContain(
      'that binding is written for 192.168.1.80, its own rule still stands for 192.168.1.77, and this rule names neither'
    )
  })

  it('owns the old rule too while both of them are on the router', () => {
    // Same moment, read from the other side. Both rules are this module's: the
    // one it has just written for the new address, and the one it is about to
    // take away.
    const leased = router()
    leased.leases = [{ expires: 0, mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.80', host: 'nina' }]

    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.77/32 lookup 42'],
        main: MAIN_DEFAULT,
        routes: BOUND_TABLE
      }),
      {
        model: leased,
        direct: [laptop()],
        installed: [{ id: 'dir_1', ip: '192.168.1.77' }]
      }
    )

    const row = rowAt(rows, 19_003)
    expect(row.ownerKind).toBe('direct')
    expect(row.reason).toContain('That binding answers to 192.168.1.80 now')
  })

  it('counts the held address when deciding whether a low rule outranks this module', () => {
    // The accusation asks whether a rule numbered below the module's bands
    // could take traffic from one of them. A rule standing through the grace is
    // a rule this module wrote, so the address it names is one this module has
    // placed - and reading only the leases made the warning go quiet for
    // exactly the window in which that address is hardest to account for.
    const { rows } = scan(
      reply({
        rules: [...BASELINE, '900:\tfrom 192.168.1.0/24 lookup vpn'],
        main: MAIN_DEFAULT,
        routes: ['vpn default via 10.8.0.1 dev tun0']
      }),
      {
        direct: [laptop()],
        installed: [{ id: 'dir_1', ip: '192.168.1.77' }]
      }
    )

    const row = rowAt(rows, 900)
    expect(row.outranksModule).toBe(true)
    expect(row.ownerBadges.some((chip) => chip.label === 'outranks module')).toBe(true)
  })

  it('still owns a rule on the leases alone when no memory came with the scan', () => {
    // The memory widens the answer; it never replaces it. A scan classified
    // before the one-to-one pass has run - or by a caller that has no memory to
    // hand - must still credit a binding whose device is on the network.
    const leased = router()
    leased.leases = [{ expires: 0, mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.77', host: 'nina' }]

    const { rows } = scan(
      reply({
        rules: [...BASELINE, '19003:\tfrom 192.168.1.77/32 lookup 42'],
        main: MAIN_DEFAULT,
        routes: BOUND_TABLE
      }),
      { model: leased, direct: [laptop()] }
    )

    const row = rowAt(rows, 19_003)
    expect(row.ownerKind).toBe('direct')
    expect(row.reason).toContain('the one-to-one binding "Nina laptop"')
    // Nothing about a grace, because nothing here is inside one.
    expect(row.reason).not.toContain('Lease release grace (s)')
  })
})
