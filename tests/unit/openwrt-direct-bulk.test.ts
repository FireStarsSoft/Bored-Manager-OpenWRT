/**
 * Deleting a selection of one-to-one bindings.
 *
 * Five hundred deletes used to be five hundred `unbind` calls: five hundred
 * sections written one at a time, five hundred commits to flash, and five
 * hundred passes behind them. The daemon takes two hundred ids in one call and
 * makes each batch one commit and one pass, so what is tested here is that this
 * side actually batches - and that a row an instance seated is refused by name
 * while the rest of the selection still goes.
 */
import { describe, expect, it } from 'vitest'
import { binding, fakeWanbind, wanbindClient } from '../helpers/wanbind'

/** The mutation runs as a job, which answers with its id the instant it starts. */
const settle = () => new Promise((done) => setTimeout(done, 20))

function manyBindings(count: number) {
  const rows = []

  for (let i = 0; i < count; i += 1) {
    rows.push(
      binding({
        id: `bmdir_p${String(i).padStart(4, '0')}`,
        ip: `10.0.${Math.floor(i / 250)}.${10 + (i % 240)}`,
        wan: 'wan1',
        state: 'bound'
      })
    )
  }

  return rows
}

describe('a selection of one-to-one bindings goes in batches', () => {
  it('sends two hundred ids per call rather than one id per call', async () => {
    const daemon = fakeWanbind()
    daemon.state.bindings = manyBindings(450)

    const client = wanbindClient({ daemon })
    await client.tick()

    const ids = daemon.state.bindings.map((one) => one.id)
    const result = await client.manager.directDeleteMany(ids)
    await settle()

    expect(result.ok).toBe(true)
    // 200 + 200 + 50. It used to be 450 `unbind` calls.
    expect(daemon.count('unbind_many')).toBe(3)
    expect(daemon.count('unbind')).toBe(0)
    expect(daemon.state.bindings).toHaveLength(0)

    for (const payload of daemon.payloads('unbind_many')) {
      expect((payload.ids as string[]).length).toBeLessThanOrEqual(200)
    }

    client.dispose()
  })

  it('leaves a seat an instance handed out alone, and says which', async () => {
    const daemon = fakeWanbind()
    daemon.state.bindings = [
      binding({ id: 'bmdir_a1', ip: '10.0.0.11', wan: 'wan1', state: 'bound' }),
      binding({
        id: 'bmdir_a2',
        ip: '10.0.0.12',
        wan: 'wan1',
        state: 'bound',
        source: 'instance',
        name: 'seated by home'
      })
    ]

    const client = wanbindClient({ daemon })
    await client.tick()

    await client.manager.directDeleteMany(['bmdir_a1', 'bmdir_a2'])
    await settle()

    // The hand-placed one went; the seat did not, and nothing asked the router
    // to remove it - a pass would have written it straight back.
    expect(daemon.payloads('unbind_many')[0]?.ids).toEqual(['bmdir_a1'])
    expect(client.jobs[0]?.ok).toBe(true)
    expect(daemon.state.bindings.map((one) => one.id)).toEqual(['bmdir_a2'])

    client.dispose()
  })

  it('refuses a selection that is all seats, by what they are', async () => {
    const daemon = fakeWanbind()
    daemon.state.bindings = [
      binding({
        id: 'bmdir_a2',
        ip: '10.0.0.12',
        wan: 'wan1',
        state: 'bound',
        source: 'instance',
        name: 'seated by home'
      })
    ]

    const client = wanbindClient({ daemon })
    await client.tick()

    const result = await client.manager.directDeleteMany(['bmdir_a2'])

    expect(result.ok).toBe(false)
    expect(result.error).toContain('hand-placed')
    expect(daemon.count('unbind_many')).toBe(0)

    client.dispose()
  })

  it('says how many went when the router keeps one', async () => {
    const daemon = fakeWanbind()
    daemon.state.bindings = manyBindings(3)

    const client = wanbindClient({ daemon })
    await client.tick()

    await client.manager.directDeleteMany([
      ...daemon.state.bindings.map((one) => one.id),
      'bmdir_gone'
    ])
    await settle()

    // Three removed, one the router does not have. The job carries the
    // sentence, and the count is the useful half of it.
    expect(client.jobs[0]?.ok).toBe(false)
    expect(client.jobs[0]?.error).toContain('3 removed')
    expect(client.jobs[0]?.error).toContain('bmdir_gone')

    client.dispose()
  })
})
