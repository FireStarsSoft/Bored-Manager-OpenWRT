import { describe, expect, it } from 'vitest'
import type { OkResult } from '@shared/types'
import { fakeWanbind, instanceConfig, wanbindClient, type WanbindClient } from '../helpers/wanbind'

/**
 * Unassign and Reassign: the two things an operator does to one device that has
 * already been given a WAN.
 *
 * Until 3.4.0 both wrote into a planner's memory on this side and then ran a
 * pass that rewrote the router's ip rules from it, which is why the file they
 * came from cloned that memory first and put it back when the pass stopped half
 * way: a device left held, or force-reassigned, by work that never reached the
 * router was the failure that code existed to prevent. **There is no planner
 * and no memory now.** Each of these is one ubus call, the daemon holds who is
 * on which WAN, and a call that fails has changed nothing to put back - so the
 * four cases about restoring a clone are not cases any more.
 *
 * What is still decided here, and what these three cases are about, is the
 * selection: a table can send one row's two fields or a whole column of ticked
 * `<instance>|<mac>` keys, the two views of one device have to dedupe against
 * each other, and one unreadable key out of two hundred must not lose the other
 * hundred and ninety-nine. Everything past that is the router's answer, quoted
 * rather than reworded.
 */

const DESK = 'aa:bb:cc:dd:ee:01'
const PHONE = 'aa:bb:cc:dd:ee:02'
const INSTANCE = 'bmi_office'

const settle = async (rounds = 10): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function office(): WanbindClient {
  return wanbindClient({
    daemon: fakeWanbind({
      configured: [instanceConfig({ id: INSTANCE, name: 'Office LAN' })]
    })
  })
}

/** One client, ticked and acted on, with the daemon's answers already read. */
async function ready(): Promise<WanbindClient> {
  const client = office()
  await client.tick()
  return client
}

describe('acting on a selection of devices', () => {
  it('takes a whole selection sent as instance-and-mac keys', async () => {
    // What the bulk toolbar posts, as opposed to the two arguments a row action
    // sends. The MAC is lower-cased on the way in because a router reports
    // `AA:BB:...` in one place and `aa:bb:...` in another, and two spellings of
    // one device would be two calls about one client.
    const client = await ready()

    const result = (await client.manager.unassign(
      [`${INSTANCE}|${DESK}`, `${INSTANCE}|${PHONE.toUpperCase()}`],
      undefined
    )) as OkResult
    await settle()

    expect(result.ok).toBe(true)
    expect(client.daemon.payloads('unassign')).toEqual([
      { instance: INSTANCE, mac: DESK },
      { instance: INSTANCE, mac: PHONE }
    ])
    expect(client.jobs.at(-1)).toMatchObject({ label: 'Unassign 2 devices', ok: true })
    client.dispose()
  })

  it('asks about one device once, however many tables named it', async () => {
    // The drawer's Assignments table and the page-wide one are two views of one
    // row. Asking the daemon twice would report two changes where one happened.
    const client = await ready()

    await client.manager.unassign([`${INSTANCE}|${DESK}`, `${INSTANCE}|${DESK}`], undefined)
    await settle()

    expect(client.daemon.count('unassign')).toBe(1)
    client.dispose()
  })

  it('drops a key it cannot read rather than losing the rest of the selection', async () => {
    const client = await ready()

    await client.manager.unassign(
      [`${INSTANCE}|${DESK}`, 'no-separator-here', `${INSTANCE}|not-a-mac`, `|${PHONE}`],
      undefined
    )
    await settle()

    expect(client.daemon.payloads('unassign')).toEqual([{ instance: INSTANCE, mac: DESK }])
    // And the job says how many are really going, so the count on screen is the
    // count that was sent.
    expect(client.jobs.at(-1)?.label).toBe('Unassign 1 device')
    client.dispose()
  })
})

describe('a device action that names nothing usable', () => {
  it('is refused rather than applied to whatever is first', async () => {
    const client = await ready()

    for (const result of [
      (await client.manager.unassign(INSTANCE, 'not-a-mac')) as OkResult,
      (await client.manager.reassign([], undefined)) as OkResult,
      (await client.manager.unassign([':::'], undefined)) as OkResult
    ]) {
      expect(result).toMatchObject({ ok: false, error: 'no valid device was selected' })
    }
    // Refused here, so the router was never asked to do anything at all.
    expect(client.daemon.count('unassign')).toBe(0)
    expect(client.daemon.count('reassign')).toBe(0)
    client.dispose()
  })

  it('is refused in the router own words when the instance is gone', async () => {
    // The daemon holds the instances, so "there is no such pool" is its
    // sentence and not one this module invents. What this side owes the
    // operator is that the sentence survives the trip and says how much of the
    // selection went through before it stopped - reporting only the failure
    // would have them repeat the ones that worked.
    const client = await ready()
    let seen = 0
    client.daemon.on('unassign', () => {
      seen += 1
      return seen > 1
        ? { ok: false, reason: 'binding instance bmi_gone is not configured' }
        : { ok: true }
    })

    const result = (await client.manager.unassign(
      [`${INSTANCE}|${DESK}`, `bmi_gone|${PHONE}`],
      undefined
    )) as OkResult
    await settle()

    // The call itself starts a job, so the refusal is the job's rather than the
    // return value's - which is where the operator reads it.
    expect(result.ok).toBe(true)
    expect(client.jobs.at(-1)?.ok).toBe(false)
    expect(client.jobs.at(-1)?.error).toContain('bmi_gone is not configured')
    expect(client.jobs.at(-1)?.error).toContain('1 of 2 were done first')
    client.dispose()
  })
})
