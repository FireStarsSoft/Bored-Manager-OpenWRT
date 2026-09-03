/**
 * The upgrade path from the release before the router owned any of this.
 *
 * A machine on 3.3.2 kept its one-to-one bindings and its instances in the
 * per-router document and wrote their ip rules itself. This release writes
 * nothing: the daemon owns the priority band and sweeps everything in it that
 * no section asks for. So on the first tick after that upgrade, every binding
 * in that document is a rule the daemon removes within thirty seconds and a
 * section nothing will ever create - unless something offers them to it.
 *
 * `handoverPending` is what offers them, and until this file existed nothing
 * called it outside a test. That is the whole subject here: not whether the
 * handover works when it is called, which the tests next door cover, but that
 * the refresh every page drives actually calls it.
 */
import { describe, expect, it } from 'vitest'
import { bindingCapability, wanbindClient } from '../helpers/wanbind'

/** One binding, as 3.3.2 left it in the document. */
const RECORD = {
  id: 'dir_a1',
  name: 'Workshop',
  target: { kind: 'ip', ip: '10.0.0.11' },
  wan: 'wan1',
  enabled: true,
  whenDown: 'hold',
  pref: 19_000,
  table: 101,
  lan: 'lan',
  slot: 0,
  createdAt: 1_700_000_000_000
}

function host(direct: unknown[] = [RECORD]): Record<string, unknown> {
  return {
    version: 3,
    instances: [],
    direct,
    extraTables: [],
    stickyMap: [],
    events: [],
    moduleEvents: [],
    jobs: []
  }
}

describe('the records this module still holds are offered to the router', () => {
  it('on the refresh every page drives, not only when a test asks', async () => {
    const client = wanbindClient({ hostData: host() })

    try {
      await client.tick()

      // The router was asked to take it, with the numbers the rule on this
      // router was already written against - a binding re-numbered on the way
      // over is a new rule and a moment with none.
      expect(client.daemon.count('bind')).toBe(1)

      const sent = client.daemon.payloads('bind')[0]
      expect(sent?.id).toBe('bmdir_a1')
      expect(sent?.pref).toBe(19_000)
      expect(sent?.table).toBe(101)

      // And forgotten, because the router now keeps it. A record left behind
      // would be offered again on every tick for the life of the machine.
      expect(client.store.read().direct).toHaveLength(0)
    } finally {
      client.dispose()
    }
  })

  it('and a router that refuses one keeps the record and says so', async () => {
    const client = wanbindClient({ hostData: host() })

    // The router will not have it. What the reason is does not matter here;
    // that the record survives and the page says so does.
    client.daemon.on('bind', () => ({
      code: 0,
      stdout: JSON.stringify({ ok: false, reason: 'pref 19000 is already taken by binding bmdir_z9' }),
      stderr: ''
    }))

    try {
      await client.tick()
      await client.tick()

      // Retried rather than dropped: the reason is somebody's to fix, and the
      // record is the only description of the binding left.
      expect(client.daemon.count('bind')).toBe(2)

      // Kept, because nothing was taken.
      expect(client.store.read().direct).toHaveLength(1)

      const notice = client.manager.directSnapshot().notice
      expect(notice).toContain('Workshop')
      expect(notice).toContain('nothing on either side is maintaining')
    } finally {
      client.dispose()
    }
  })

  it('and a router with no daemon says that instead of saying nothing', async () => {
    const client = wanbindClient({
      hostData: host(),
      capability: bindingCapability({ usable: false, provides: [], features: [] })
    })

    try {
      await client.tick()

      // Nothing was offered, because there is nothing to offer it to.
      expect(client.daemon.calls).toHaveLength(0)

      // But the page says why. This is the one router where every other
      // sentence on that page is empty - no daemon, no rows, no error - so a
      // handover notice that did not survive the cleared cache would leave
      // somebody looking at an empty table with rules still on their router.
      const notice = client.manager.directSnapshot().notice
      expect(notice).toContain('still holds')
      expect(notice).toContain('Installing the router packages')
    } finally {
      client.dispose()
    }
  })
})
