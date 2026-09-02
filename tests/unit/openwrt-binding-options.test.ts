/**
 * The three dropdowns on the binding forms, filled by the router.
 *
 * This is what `openwrt-carrier-options` used to be, and the difference is the
 * whole of 3.4.0. That file handed a `RouterModel` and a store document to a
 * pure function and checked which device names came back: the module read a
 * `ubus network.interface dump` it had fetched over SSH, decided for itself
 * which interfaces were LANs and which were ways out, and offered the answer.
 *
 * It cannot do that any more, and should never have: the router is the half
 * that knows. So the lists come from `wans` and `layout`, and what this module
 * does with them is *order* them - likeliest first, with the daemon's own
 * evidence in the label - rather than decide which ones a person is allowed to
 * see. That distinction is most of what is asserted below: a LAN offered as a
 * WAN port sits last with the reason attached, and is not silently missing,
 * because a router this module has misread is a router somebody still has to be
 * able to drive.
 */
import { describe, expect, it } from 'vitest'
import type { WanbindVerdict } from '../../openwrt/main/agent'
import { fakeWanbind, wan, wanbindClient } from '../helpers/wanbind'

function verdict(over: Partial<WanbindVerdict> = {}): WanbindVerdict {
  return {
    name: 'lan',
    role: 'lan',
    cidr: '12.10.1.0/24',
    device: 'eth1',
    zone: 'lan',
    zoneMasquerades: false,
    lanEvidence: ['it hands out DHCP leases'],
    uplinkEvidence: [],
    ...over
  }
}

describe('the binding form dropdowns', () => {
  it('puts the ways out of the router first and its own LANs last', async () => {
    const client = wanbindClient({
      daemon: fakeWanbind({
        wans: [
          wan({ name: 'lan', role: 'lan', device: 'eth1', up: true }),
          wan({ name: 'WAN0', role: 'uplink', device: 'eth2', table: 10000, up: true })
        ]
      })
    })

    const ports = await client.manager.options('wan-ports')

    expect(ports.map((one) => one.value)).toEqual(['WAN0', 'lan'])
    client.dispose()
  })

  it('says of the LAN why it is last, rather than leaving it out', async () => {
    // Leaving it out is the tempting version and the wrong one. If the router
    // has misread an interface - a second modem behind a switch reads as a LAN
    // on plenty of real boxes - then a list that hides it is a list somebody
    // cannot use to fix anything, and nothing on screen says why.
    const client = wanbindClient({
      daemon: fakeWanbind({
        wans: [
          wan({
            name: 'lan',
            role: 'lan',
            device: 'eth1',
            up: true,
            evidence: ['it hands out DHCP leases on 12.10.1.0/24']
          })
        ]
      })
    })

    const [only] = await client.manager.options('wan-ports')

    expect(only.value).toBe('lan')
    expect(only.label).toMatch(/DHCP leases/)
    client.dispose()
  })

  it('reads the LAN list off layout, LANs first', async () => {
    const daemon = fakeWanbind()
    daemon.on('layout', () => ({
      ok: true,
      stated: true,
      interfaces: [
        verdict({ name: 'WAN0', role: 'uplink', device: 'eth2', cidr: '192.168.1.0/24', zone: 'wan' }),
        verdict({ name: 'lan', role: 'lan', device: 'eth1' }),
        verdict({ name: 'LAN_WIRED', role: 'lan', device: 'eth0', cidr: '12.10.10.0/24' })
      ]
    }))

    const client = wanbindClient({ daemon })
    const lans = await client.manager.options('lan-ifaces')

    expect(lans.map((one) => one.value)).toEqual(['lan', 'LAN_WIRED', 'WAN0'])
    expect(lans[0].label).toContain('12.10.1.0/24')
    client.dispose()
  })

  it('offers one carrier per device, whatever is riding on it', async () => {
    // The reason this list exists at all. A pool is chosen by the device its
    // WANs share, so thirty-two PPPoE sessions over eth1 are one choice and not
    // thirty-two - and a dropdown that listed them one by one would be asking
    // somebody to pick a session when the question is which port.
    const daemon = fakeWanbind()
    daemon.on('wans', () => ({
      ok: true,
      wans: [],
      carriers: [
        { device: 'eth1', up: true, wans: ['pd00001', 'pd00002', 'pd00003', 'pd00004'] },
        { device: 'eth2', up: false, wans: ['WAN0'] }
      ]
    }))

    const client = wanbindClient({ daemon })
    const carriers = await client.manager.options('binding-carriers')

    expect(carriers.map((one) => one.value)).toEqual(['eth1', 'eth2'])
    expect(carriers[0].label).toMatch(/4 interfaces/)
    expect(carriers[0].label).toMatch(/and 1 more/)
    expect(carriers[1].label).toMatch(/\(down\)/)
    client.dispose()
  })

  it('offers nothing at all when the router will not answer', async () => {
    // Not a shorter list: no list. Everything this module could put here would
    // be invented, and a form filled from an invention is a create the daemon
    // refuses after somebody has typed the rest of it.
    const daemon = fakeWanbind()
    daemon.on('wans', () => ({ code: 1, stdout: '', stderr: 'Command failed: Not found' }))
    daemon.on('layout', () => ({ code: 1, stdout: '', stderr: 'Command failed: Not found' }))

    const client = wanbindClient({ daemon })

    expect(await client.manager.options('wan-ports')).toEqual([])
    expect(await client.manager.options('binding-carriers')).toEqual([])
    expect(await client.manager.options('lan-ifaces')).toEqual([])
    client.dispose()
  })

  it('offers nothing for a list it has never heard of', async () => {
    const client = wanbindClient()

    expect(await client.manager.options('something-else')).toEqual([])
    expect(await client.manager.options(undefined)).toEqual([])
    client.dispose()
  })
})
