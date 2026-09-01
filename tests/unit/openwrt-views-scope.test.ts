import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { buildRow, countTotals, type DirectMemoryEntry } from '../../openwrt/main/direct'
import { HostStore, type DirectBindingRecord } from '../../openwrt/main/store'
import { moduleHarness } from '../helpers/module-harness'

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
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const T0 = 1_700_000_000_000
const BLACKHOLE = DEFAULT_RULES.catchAllTable

function record(over: Partial<DirectBindingRecord> = {}): DirectBindingRecord {
  return {
    id: 'dir_000001',
    name: 'Till at the front counter',
    target: { kind: 'mac', mac: 'a4:b1:c2:00:11:22' },
    wan: 'wan',
    enabled: true,
    whenDown: 'hold',
    pref: DEFAULT_RULES.directPrefBase,
    table: 42,
    lan: 'lan',
    slot: 0,
    createdAt: 1,
    ...over
  }
}

function memory(over: Partial<DirectMemoryEntry> = {}): DirectMemoryEntry {
  return {
    id: 'dir_000001',
    ip: '192.168.1.50',
    missingSince: 0,
    state: 'bound',
    since: T0,
    ...over
  }
}

const row = (
  over: Partial<DirectBindingRecord>,
  entry: Partial<DirectMemoryEntry>
): ReturnType<typeof buildRow> =>
  buildRow(record(over), memory(entry), T0, BLACKHOLE)

// -------------------------------------------------------- the Overview tile

describe('the Held with no way out tile', () => {
  it('counts a parked stranded binding, because its rule is on the blackhole too', () => {
    // The till roamed onto the guest VLAN overnight. Its rule was rewritten to
    // the unreachable table exactly as a hold is, the device is offline, and
    // the tile used to report nothing detained at all.
    const stranded = row({ whenDown: 'hold' }, { state: 'stranded' })

    expect(stranded.rule).toBe(
      `from 192.168.1.50/32 lookup ${BLACKHOLE} pref ${DEFAULT_RULES.directPrefBase}`
    )
    expect(countTotals([stranded])).toEqual({ ok: 0, held: 1 })
  })

  it('leaves a stranded binding whose owner chose the default connection out of it', () => {
    // That one is on the main table. It is not detained, it is out through a
    // route nobody picked - which is a different sentence and a different tile.
    const stranded = row({ whenDown: 'fallback' }, { state: 'stranded' })

    expect(stranded.rule).toContain('lookup main')
    expect(countTotals([stranded])).toEqual({ ok: 0, held: 0 })
  })

  it('still counts held and bound the way it always did', () => {
    const totals = countTotals([
      row({}, { state: 'bound' }),
      row({}, { state: 'held' }),
      row({}, { state: 'fallback' }),
      row({}, { state: 'shadowed' })
    ])

    expect(totals).toEqual({ ok: 1, held: 1 })
  })
})

// ------------------------------------------------------ the When down column

describe('the When down cell on a one-to-one binding', () => {
  it('names the option the user picked rather than the value behind it', () => {
    expect(row({ whenDown: 'hold' }, {}).whenDownLabel).toBe('Keep it off the internet')
    expect(row({ whenDown: 'fallback' }, {}).whenDownLabel).toBe(
      'Let it use the default connection'
    )
  })

  it('keeps the stored value, which is what the row edit form opens on', () => {
    // The row detail's own `When that WAN is down` select is initialised from
    // this key. A label here would match none of its options, so the form would
    // open on nothing and a Save would silently rewrite the choice.
    expect(row({ whenDown: 'fallback' }, {}).whenDown).toBe('fallback')
  })

  it('does not print the word the State chips use for a WAN that is down', () => {
    // One table carrying `fallback` for a setting and `fallback` for a
    // condition is two meanings in one row and no way to tell them apart.
    const cell = row({ whenDown: 'fallback' }, { state: 'fallback' })
    expect(cell.whenDownLabel).not.toBe(cell.state)
  })
})

// --------------------------------------------------------- the Instances table

describe('a range-scoped binding instance', () => {
  function instance(id: string, name: string, lan: string, slot: number, source?: unknown): unknown {
    return {
      id,
      name,
      lan,
      carrier: 'eth1',
      running: true,
      sticky: true,
      remap: true,
      createdAt: 1,
      slot,
      ...(source ? { source } : {})
    }
  }

  function rows(): Array<{ name: string; lan: string; scope: string }> {
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: {
        version: 3,
        instances: [
          instance('bind1', 'Front of house', 'lan', 0, {
            kind: 'range',
            from: '192.168.1.100',
            to: '192.168.1.199'
          }),
          instance('bind2', 'Back office', 'lan2', 1)
        ],
        direct: [],
        extraTables: [],
        stickyMap: [],
        events: [],
        moduleEvents: [],
        jobs: []
      }
    })
    const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
    const binding = new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES })
    const list = binding.list().map((entry) => ({
      name: entry.name,
      lan: entry.lan,
      scope: entry.scope
    }))
    binding.dispose()
    return list
  }

  it('says which addresses it covers, so it is not read as the whole bridge', () => {
    // Two instances, and the LAN column alone made them the same row: a device
    // at 192.168.1.20 gets no WAN from the scoped one because it was never
    // inside the window, which reads as a lost assignment and not as a scope.
    expect(rows()).toEqual([
      { name: 'Front of house', lan: 'lan', scope: '192.168.1.100 - 192.168.1.199' },
      { name: 'Back office', lan: 'lan2', scope: 'whole LAN' }
    ])
  })

  it('says so before the first reconcile has run', () => {
    // The scope is stamped at creation and never edited, so a row for an
    // instance no pass has reached yet still has to be able to say it - which
    // is why it is read off the record and not off the summary cache.
    expect(rows()[0]?.scope).toBe('192.168.1.100 - 192.168.1.199')
  })
})
