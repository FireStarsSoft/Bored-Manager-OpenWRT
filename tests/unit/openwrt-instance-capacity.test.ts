import { describe, expect, it } from 'vitest'
import { MAX_STORED_BINDINGS } from '../../openwrt/main/records'
import { normalize } from '../../openwrt/main/store'

/**
 * How many binding instances the per-router document keeps, asked of the reader
 * that keeps them.
 *
 * The create gate that used to stand beside this is gone with the half that
 * needed it. Until 3.4.0 an instance was a record here and a set of ip rules
 * this module wrote, so a 513th record silently dropped on the next read left
 * its client rules, its fail-closed catch-all and its firewall sections on the
 * router with nothing left that could name them, let alone remove them. There
 * is no record of an instance any more: `wanbind/plan.ts` asks the daemon,
 * which allocates each section's numbers out of its own bands and refuses a
 * section that collides with one already taken - "two catch-alls at one
 * priority is refused", proved against the real daemon by `wanbind-range` in
 * `packages/ci/probes/`, beside the priority-range floor `wanbind-config`
 * refuses on.
 *
 * The ceiling still matters here for one reason, and it is why this case is not
 * gone with the rest: the records that remain are the ones `wanbind/handover.ts`
 * has yet to hand over, and a record trimmed away in silence is an instance the
 * router will never be told about while its rules go on standing.
 */

/**
 * Instances that fill the document. Their slots run from 0 upwards and their
 * LANs are names no router has, because nothing here is about what any of them
 * would do - only about how many survive being read back.
 */
function existing(count: number): unknown[] {
  const records: unknown[] = []
  for (let index = 0; index < count; index++) {
    records.push({
      id: `bind_${index.toString(36).padStart(6, '0')}`,
      name: `Site ${index}`,
      lan: `held${index}`,
      carrier: `heldeth${index}`,
      running: false,
      sticky: true,
      remap: true,
      createdAt: 1,
      slot: index
    })
  }
  return records
}

describe('the per-router document on how many instances fit', () => {
  it('keeps exactly the number of binding instances it claims to keep', () => {
    const data = normalize({
      version: 3,
      instances: existing(MAX_STORED_BINDINGS + 40),
      direct: [],
      extraTables: [],
      stickyPacked: [],
      events: [],
      moduleEvents: [],
      jobs: []
    })

    expect(data.instances).toHaveLength(MAX_STORED_BINDINGS)
  })
})
