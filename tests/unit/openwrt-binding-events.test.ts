/**
 * The per-instance history, which nothing was writing.
 *
 * An instance's log is the account of who was seated where and when it moved -
 * the one record of a WAN failing over that outlives the failure. It is built
 * from the difference between two `assignments` replies, and until this file
 * existed the two functions that build it had no caller: the ring was empty on
 * every router, the live log never emitted, and the store's own reader dropped
 * whatever did reach it.
 */
import { describe, expect, it } from 'vitest'
import { assignment, instanceConfig, instanceState, wanbindClient } from '../helpers/wanbind'
import { fakeWanbind } from '../helpers/wanbind'

function daemonWith(wan: string) {
  const daemon = fakeWanbind()
  daemon.state.configured = [instanceConfig({ id: 'bmi_aaa001' })]
  daemon.state.instances = [instanceState({ id: 'bmi_aaa001' })]
  daemon.state.assignments = [
    assignment({ instance: 'bmi_aaa001', mac: 'aa:bb:cc:dd:ee:01', wan })
  ]
  return daemon
}

describe('an instance keeps an account of what it did', () => {
  it('writes nothing on the first reply, and the move on the second', async () => {
    const daemon = daemonWith('pd00001')
    const client = wanbindClient({ daemon })

    try {
      await client.tick()

      // The empty list a cache carries before its first fetch is not a router
      // with nobody seated on it. Diffing against it would write "assigned"
      // for every client on the router - on every reconnect, every reset, and
      // every switch back to this machine.
      expect(client.store.read().events).toHaveLength(0)

      daemon.state.assignments = [
        assignment({ instance: 'bmi_aaa001', mac: 'aa:bb:cc:dd:ee:01', wan: 'pd00002' })
      ]

      await client.tick()

      const events = client.store.read().events
      expect(events).toHaveLength(1)
      expect(events[0]?.[0]).toBe('bmi_aaa001')
      expect(events[0]?.[2]).toBe('remapped')
      expect(events[0]?.[3]).toContain('moved from pd00001 to pd00002')
    } finally {
      client.dispose()
    }
  })

  it('and the rows a page reads come back out of it', async () => {
    const daemon = daemonWith('pd00001')
    const client = wanbindClient({ daemon })

    try {
      await client.tick()

      daemon.state.assignments = [
        assignment({ instance: 'bmi_aaa001', mac: 'aa:bb:cc:dd:ee:01', wan: 'pd00002' })
      ]

      await client.tick()

      const rows = client.manager.eventRows('bmi_aaa001')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('remapped')
    } finally {
      client.dispose()
    }
  })

  it('and a client that went away is recorded as released', async () => {
    const daemon = daemonWith('pd00001')
    const client = wanbindClient({ daemon })

    try {
      await client.tick()
      daemon.state.assignments = []
      await client.tick()

      const events = client.store.read().events
      expect(events).toHaveLength(1)
      expect(events[0]?.[2]).toBe('released')
    } finally {
      client.dispose()
    }
  })
})
