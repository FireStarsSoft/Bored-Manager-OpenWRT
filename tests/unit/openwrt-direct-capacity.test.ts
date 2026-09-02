import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { MAX_STORED_BINDINGS } from '../../openwrt/main/records'
import { normalize, type DirectBindingRecord } from '../../openwrt/main/store'

/**
 * How many one-to-one bindings the per-router document keeps, asked of the
 * reader that keeps them.
 *
 * The create gate that used to stand beside this is gone with the half that
 * needed it. Until 3.4.0 a binding was a record here and an `ip rule` this
 * module wrote, so a 513th record silently dropped on the next read left its
 * rule, its firewall sections and its `ip4table` claim on the router with no
 * record left that could name them. This module writes no rule now:
 * `wanbind/plan.ts` asks the daemon, which allocates a priority out of its own
 * one-to-one band and refuses when there is none free - "the shipped band
 * starts at 19000", "a band that reaches into the instances is refused", "a
 * free priority was taken out of the band", all proved against the real daemon
 * by `wanbind-config` and `wanbind-service` in `packages/ci/probes/`.
 *
 * The ceiling still matters here for one reason, and it is why this case is not
 * gone with the rest: the records that remain are the ones `wanbind/handover.ts`
 * has yet to offer the router, and a record trimmed away in silence is a
 * binding the daemon will never be told about while its rule goes on standing
 * in a band the daemon sweeps.
 */

/** Bindings that fill the document, each on its own address and priority. */
function existing(count: number): DirectBindingRecord[] {
  const records: DirectBindingRecord[] = []
  for (let index = 0; index < count; index++) {
    records.push({
      id: `dir_${index.toString(36).padStart(6, '0')}`,
      name: `Bound device ${index}`,
      target: { kind: 'ip', ip: `10.${Math.floor(index / 254)}.0.${(index % 254) + 1}` },
      wan: 'wan',
      enabled: true,
      whenDown: 'hold',
      pref: DEFAULT_RULES.directPrefBase + index,
      table: 42,
      lan: 'lan',
      slot: index,
      createdAt: 1
    })
  }
  return records
}

describe('the per-router document on how many bindings fit', () => {
  it('keeps exactly the number of one-to-one bindings it claims to keep', () => {
    const data = normalize({
      version: 3,
      instances: [],
      direct: existing(MAX_STORED_BINDINGS + 40),
      extraTables: [],
      stickyPacked: [],
      events: [],
      moduleEvents: [],
      jobs: []
    })

    expect(data.direct).toHaveLength(MAX_STORED_BINDINGS)
  })
})
