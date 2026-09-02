import { describe, expect, it } from 'vitest'
import type { OkResult } from '@shared/types'
import {
  fakeWanbind,
  instanceConfig,
  instanceState,
  waiting,
  wanbindClient,
  type WanbindClient
} from '../helpers/wanbind'

/**
 * Pinning one device to one named WAN, and the two other buttons the same
 * tables offer beside it.
 *
 * The pass that honours a pin is the router's from packages 2.4.0: `pin` is one
 * ubus call, the daemon decides whether it can seat the client there and says
 * so in its own words. So the planner half of this file - the request that
 * outranks a sticky choice, the request spent on one pass rather than latched -
 * went with the planner, and so did every "put the sticky map back when the
 * pass never reached the router", because there is no map here to put back.
 *
 * What is still decided on this side is what the daemon cannot be asked and
 * what it would answer too late to be useful: a WAN name that is blank, a
 * selection an instance physically cannot seat together, and the one button on
 * the waiting table that would otherwise never work.
 */

const DESK = 'aa:bb:cc:dd:ee:01'
const PHONE = 'aa:bb:cc:dd:ee:02'
const INSTANCE = 'bmi_office'

const settle = async (rounds = 10): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * One instance, seating however many clients per WAN the case is about, with
 * the daemon's answers already read.
 *
 * The tick matters: every refusal below is measured against the section the
 * router last described, and this module keeps no record of an instance for it
 * to be measured against instead.
 */
async function office(
  options: { clientsPerWan?: number; waiting?: ReturnType<typeof waiting>[] } = {}
): Promise<WanbindClient> {
  const client = wanbindClient({
    daemon: fakeWanbind({
      configured: [
        instanceConfig({
          id: INSTANCE,
          name: 'Office LAN',
          clientsPerWan: options.clientsPerWan ?? 1
        })
      ],
      // The queue is the one call the module skips when the daemon's own
      // counters say nobody is unseated, so a held device has to be counted as
      // well as listed or it never reaches this side at all.
      instances: options.waiting?.length
        ? [
            instanceState({
              id: INSTANCE,
              held: options.waiting.length,
              devices: options.waiting.length
            })
          ]
        : undefined,
      waiting: options.waiting ?? []
    })
  })
  await client.tick()
  return client
}

describe('pinning a device from a row action', () => {
  it('names the WAN to the router rather than choosing one for it', async () => {
    const client = await office()

    const result = (await client.manager.pin(INSTANCE, DESK, 'pd00002')) as OkResult
    await settle()

    expect(result.ok).toBe(true)
    expect(client.daemon.payloads('pin')).toEqual([
      { instance: INSTANCE, mac: DESK, wan: 'pd00002' }
    ])
    client.dispose()
  })
})

describe('a pin that cannot be honoured', () => {
  it('refuses an empty WAN name with the column to read one off', async () => {
    const client = await office()

    const result = (await client.manager.pin(INSTANCE, DESK, '   ')) as OkResult

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Name the WAN to pin this device to')
    expect(result.error).toContain('WAN column')
    // Refused here, so nothing was asked of the router at all.
    expect(client.daemon.count('pin')).toBe(0)
    client.dispose()
  })

  it('refuses a whole selection on an instance that seats one client per WAN', async () => {
    // The daemon would seat the last of them and put every other one back in
    // the queue, evicting each in turn - which is a page reporting four
    // successful pins where one device ended up where it was asked to be.
    const client = await office({ clientsPerWan: 1 })

    const result = (await client.manager.pin(
      [`${INSTANCE}|${DESK}`, `${INSTANCE}|${PHONE}`],
      undefined,
      'pd00002'
    )) as OkResult

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Office LAN gives each client a WAN of its own')
    expect(result.error).toContain('Pin them one at a time')
    expect(client.daemon.count('pin')).toBe(0)
    client.dispose()
  })

  it('lets the same selection through on an instance that shares a WAN', async () => {
    // The positive control, and the reason the refusal asks the instance rather
    // than assuming the old rule: above one client per WAN two devices sharing
    // a line is exactly what the section is for, and refusing it would be this
    // module overruling a setting the router holds.
    const client = await office({ clientsPerWan: 4 })

    const result = (await client.manager.pin(
      [`${INSTANCE}|${DESK}`, `${INSTANCE}|${PHONE}`],
      undefined,
      'pd00002'
    )) as OkResult
    await settle()

    expect(result.ok).toBe(true)
    expect(client.daemon.payloads('pin').map((sent) => sent.mac)).toEqual([DESK, PHONE])
    client.dispose()
  })
})

describe('Reassign on a device that is being held', () => {
  it('lets it back into the pool instead of asking to move a WAN it has not got', async () => {
    // `reassign` unbinds the client and asks for anything but the WAN it had,
    // so a device with no WAN is refused with "that client has no WAN to be
    // moved off". Every surface offers Reassign on the waiting table - its own
    // confirmation reads "Release the hold and assign a free WAN when one is
    // available?" - so without this substitution it is the one button on that
    // table that never works.
    const client = await office({
      waiting: [waiting({ instance: INSTANCE, mac: DESK, held: true, why: 'held' })]
    })

    const result = (await client.manager.reassign(INSTANCE, DESK)) as OkResult
    await settle()

    expect(result.ok).toBe(true)
    expect(client.daemon.payloads('release')).toEqual([{ instance: INSTANCE, mac: DESK }])
    expect(client.daemon.count('reassign')).toBe(0)
    client.dispose()
  })

  it('still moves a seated device off the WAN it has', async () => {
    // The other half of the substitution: a device nothing is holding is
    // reassigned, which is the verb the button says it is.
    const client = await office()

    await client.manager.reassign(INSTANCE, DESK)
    await settle()

    expect(client.daemon.payloads('reassign')).toEqual([{ instance: INSTANCE, mac: DESK }])
    expect(client.daemon.count('release')).toBe(0)
    client.dispose()
  })
})
