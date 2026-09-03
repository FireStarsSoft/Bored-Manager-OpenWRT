import { describe, expect, it } from 'vitest'
import type { DirectRow } from '../../openwrt/main/wanbind'
import {
  binding,
  fakeWanbind,
  instanceConfig,
  wanbindClient,
  type RouterBinding
} from '../helpers/wanbind'

/**
 * What the tables and the tiles actually publish about a condition they were
 * written to show.
 *
 * All three assertions below started as the same fault seen from three sides: a
 * surface that reads one narrow spelling of a fact - the state word `held`, the
 * stored value `hold`, the interface name - and then says nothing about the
 * other spellings the router is equally entitled to be in. A number that reads
 * zero, a cell that prints an internal word, and a column that shows two very
 * different instances as identical are all the same kind of silence.
 *
 * The router decides all three now, and none of that changed the question: the
 * daemon reports a state, a stored `when_down` and a scope, and this module
 * still has to turn each of them into something a person can read without
 * quietly collapsing two conditions into one word.
 */

/** The unreachable table the daemon parks an address on; `ip rule` shows it as a number. */
const BLACKHOLE = 29_999
/** The kernel's main table, which `ip rule` prints as a word. */
const MAIN = 254

/**
 * One one-to-one binding as the daemon reports it, and the row this module
 * makes of it.
 *
 * Read back through the manager rather than from a builder, because the tile
 * is counted from the rows and the row is what the table draws: a builder
 * called directly would let the two disagree without anything failing.
 */
async function rowFor(over: Partial<RouterBinding>): Promise<DirectRow> {
  const rows = await directRows([binding({ id: 'bmdir_1', ...over })])
  return rows[0]!
}

async function directRows(bindings: RouterBinding[]): Promise<DirectRow[]> {
  const client = wanbindClient({ daemon: fakeWanbind({ bindings }) })
  await client.tick()
  const rows = client.manager.directRows()
  client.dispose()
  return rows
}

async function totalsFor(
  bindings: RouterBinding[]
): Promise<{ total: number; ok: number; held: number }> {
  const client = wanbindClient({ daemon: fakeWanbind({ bindings }) })
  await client.tick()
  const snapshot = client.manager.directSnapshot()
  client.dispose()
  return { total: snapshot.totals.total, ok: snapshot.totals.ok, held: snapshot.totals.held }
}

// -------------------------------------------------------- the Overview tile

describe('the Held with no way out tile', () => {
  it('counts a parked stranded binding, because its rule is on the blackhole too', async () => {
    // The till roamed onto the guest VLAN overnight. The daemon writes it
    // exactly the rule a hold gets - the unreachable table - the device is
    // offline, and the tile used to report nothing detained at all.
    const stranded = await rowFor({
      ip: '192.168.1.50',
      state: 'stranded',
      whenDown: 'hold',
      table: BLACKHOLE,
      parkedBy: 'catch-all'
    })

    expect(stranded.rule).toBe(`from 192.168.1.50/32 lookup ${BLACKHOLE} pref 19000`)
    expect(await totalsFor([binding({ state: 'stranded', whenDown: 'hold', table: BLACKHOLE })]))
      .toEqual({ total: 1, ok: 0, held: 1 })
  })

  it('leaves a stranded binding whose owner chose the default connection out of it', async () => {
    // That one is on the main table. It is not detained, it is out through a
    // route nobody picked - which is a different sentence and a different tile.
    const stranded = await rowFor({ state: 'stranded', whenDown: 'fallback', table: MAIN })

    expect(stranded.rule).toContain('lookup main')
    expect(await totalsFor([binding({ state: 'stranded', whenDown: 'fallback', table: MAIN })]))
      .toEqual({ total: 1, ok: 0, held: 0 })
  })

  it('still counts held and bound the way it always did', async () => {
    const totals = await totalsFor([
      binding({ id: 'bmdir_1', state: 'bound' }),
      binding({ id: 'bmdir_2', state: 'held', table: BLACKHOLE }),
      binding({ id: 'bmdir_3', state: 'fallback', table: MAIN }),
      binding({ id: 'bmdir_4', state: 'shadowed', table: 0 })
    ])

    expect(totals).toEqual({ total: 4, ok: 1, held: 1 })
  })
})

// ------------------------------------------------------ the When down column

describe('the When down cell on a one-to-one binding', () => {
  it('names the option the user picked rather than the value behind it', async () => {
    expect((await rowFor({ whenDown: 'hold' })).whenDownLabel).toBe('Keep it off the internet')
    expect((await rowFor({ whenDown: 'fallback' })).whenDownLabel).toBe(
      'Let it use the default connection'
    )
  })

  it('keeps the stored value, which is what the row edit form opens on', async () => {
    // The row detail's own `When that WAN is down` select is initialised from
    // this key. A label here would match none of its options, so the form would
    // open on nothing and a Save would silently rewrite the choice.
    expect((await rowFor({ whenDown: 'fallback' })).whenDown).toBe('fallback')
  })

  it('does not print the word the State chips use for a WAN that is down', async () => {
    // One table carrying `fallback` for a setting and `fallback` for a
    // condition is two meanings in one row and no way to tell them apart.
    const cell = await rowFor({ whenDown: 'fallback', state: 'fallback', table: MAIN })
    expect(cell.whenDownLabel).not.toBe(cell.state)
  })
})

// --------------------------------------------------------- the Instances table

describe('a range-scoped binding instance', () => {
  const SCOPED = instanceConfig({
    id: 'bind1',
    name: 'Front of house',
    lan: 'lan',
    rangeFrom: '192.168.1.100',
    rangeTo: '192.168.1.199'
  })
  const WHOLE = instanceConfig({ id: 'bind2', name: 'Back office', lan: 'lan2', slot: 1 })

  async function rows(
    seed: Parameters<typeof fakeWanbind>[0]
  ): Promise<Array<{ name: string; lan: string; scope: string }>> {
    const client = wanbindClient({ daemon: fakeWanbind(seed) })
    await client.tick()
    const list = client.manager
      .list()
      .map((entry) => ({ name: entry.name, lan: entry.lan, scope: entry.scope }))
    client.dispose()
    return list
  }

  it('says which addresses it covers, so it is not read as the whole bridge', async () => {
    // Two instances, and the LAN column alone made them the same row: a device
    // at 192.168.1.20 gets no WAN from the scoped one because it was never
    // inside the window, which reads as a lost assignment and not as a scope.
    expect(await rows({ configured: [SCOPED, WHOLE] })).toEqual([
      { name: 'Front of house', lan: 'lan', scope: '192.168.1.100 - 192.168.1.199' },
      { name: 'Back office', lan: 'lan2', scope: 'whole LAN' }
    ])
  })

  it('says so from the configuration, before any pass has reported state', async () => {
    // The scope is a field of the section, and a section the daemon has read
    // but not yet run a pass over has no running state at all - so the row is
    // built from `configured` rather than from `instances`. Built the other way
    // round, an instance created a moment ago would be on no table anywhere.
    const list = await rows({ configured: [SCOPED, WHOLE], instances: [] })

    expect(list[0]?.scope).toBe('192.168.1.100 - 192.168.1.199')
    expect(list.map((entry) => entry.name)).toEqual(['Front of house', 'Back office'])
  })
})
