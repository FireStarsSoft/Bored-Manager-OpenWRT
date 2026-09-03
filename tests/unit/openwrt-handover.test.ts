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

/** One binding instance, as 3.3.2 left it in the same document. */
const INSTANCE = {
  id: 'bmi_aaa001',
  name: 'Home',
  lan: 'lan',
  carrier: 'wan1',
  enabled: true,
  sticky: true,
  remap: true,
  rangeFrom: '',
  rangeTo: '',
  clientsPerWan: 1,
  slot: 0,
  rulePrefBase: 20_000,
  catchAllPref: 29_900,
  catchAllTable: 29_999,
  createdAt: 1_700_000_000_000
}

function host(
  direct: unknown[] = [RECORD],
  instances: unknown[] = []
): Record<string, unknown> {
  return {
    version: 3,
    instances,
    direct,
    extraTables: [],
    stickyMap: [],
    events: [],
    moduleEvents: [],
    jobs: []
  }
}

describe('the records this module still holds are offered to the router', () => {
  it('tells the instance half about instances, not about one-to-one bindings', async () => {
    // The bug this covers was silent and total: the instance page asked the
    // sentence for the one-to-one kind, so a 3.3.2 user with instances was told
    // nothing at all about them - and a user with both read the one-to-one
    // count on the instance tab. Every word of the instance wording was
    // unreachable.
    const client = wanbindClient({
      hostData: host([], [INSTANCE]),
      capability: bindingCapability({ usable: false, provides: [], features: [] })
    })

    try {
      await client.tick()

      const notice = client.manager.snapshot().notice ?? ''

      expect(notice).toContain('binding instance')
      expect(notice).not.toContain('one-to-one')
      expect(client.store.read().instances).toHaveLength(1)
    } finally {
      client.dispose()
    }
  })

  it('says the rules are being taken off when an older daemon is the one sweeping', async () => {
    // The commonest router in the world for the length of an update: packages
    // 2.3.0 under module 3.4.0. That daemon owns the one-to-one band and
    // removes every rule in it no section claims - which is every rule a 3.3.x
    // module wrote. Telling somebody the rules "still stand exactly as they
    // were" reports health while the bindings go.
    const client = wanbindClient({
      hostData: host(),
      capability: bindingCapability({
        release: '2.3.0',
        provides: ['binding', 'direct'],
        features: [
          { name: 'bm-wanbind', version: '2.3.0', apiVersion: 1, provides: ['binding', 'direct'] }
        ]
      })
    })

    try {
      await client.tick()

      const notice = client.manager.directSnapshot().notice ?? ''

      expect(notice).toContain('taking')
      expect(notice).toContain('Updating the router packages')
      expect(notice).not.toContain('still stand exactly as they were')
    } finally {
      client.dispose()
    }
  })

  it('and says they still stand when there is simply no daemon', async () => {
    const client = wanbindClient({
      hostData: host(),
      capability: bindingCapability({ usable: false, provides: [], features: [] })
    })

    try {
      await client.tick()

      const notice = client.manager.directSnapshot().notice ?? ''

      expect(notice).toContain('still stand exactly as they were')
      expect(notice).toContain('Installing the router packages')
    } finally {
      client.dispose()
    }
  })

  it('offers five hundred records in batches, not five hundred calls', async () => {
    const many = []

    for (let i = 0; i < 450; i += 1) {
      many.push({
        ...RECORD,
        id: `dir_p${String(i).padStart(4, '0')}`,
        name: `Bench ${i}`,
        target: { kind: 'ip', ip: `10.0.${Math.floor(i / 250)}.${10 + (i % 240)}` },
        pref: 19_000 + i
      })
    }

    const client = wanbindClient({ hostData: host(many) })

    try {
      await client.tick()

      // 200 + 200 + 50. Each one used to be its own commit to the router's
      // flash and its own reconcile pass, while the page showed nothing.
      expect(client.daemon.count('bind_many')).toBe(3)
      expect(client.daemon.count('bind')).toBe(0)
      expect(client.store.read().direct).toHaveLength(0)

      for (const payload of client.daemon.payloads('bind_many')) {
        expect((payload.bindings as unknown[]).length).toBeLessThanOrEqual(200)
      }
    } finally {
      client.dispose()
    }
  })

  it('on the refresh every page drives, not only when a test asks', async () => {
    const client = wanbindClient({ hostData: host() })

    try {
      await client.tick()

      // The router was asked to take it, with the numbers the rule on this
      // router was already written against - a binding re-numbered on the way
      // over is a new rule and a moment with none.
      // One call, in the batch form: five hundred records would otherwise be
      // five hundred commits to the router's flash and five hundred passes.
      expect(client.daemon.count('bind_many')).toBe(1)
      expect(client.daemon.count('bind')).toBe(0)

      const batch = client.daemon.payloads('bind_many')[0]?.bindings as Array<Record<string, unknown>>
      const sent = batch?.[0]
      expect(batch).toHaveLength(1)
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
      expect(client.daemon.count('bind_many')).toBe(2)

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
