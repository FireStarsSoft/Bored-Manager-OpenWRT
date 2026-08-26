import { describe, expect, it } from 'vitest'
import { selectOptions } from '../../openwrt/main/options'
import type { OwrtHostData } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'

/**
 * What each Carrier dropdown offers, which is not the same list twice.
 *
 * WAN Binding claims a carrier and every VLAN under it, so a tagged uplink is
 * a carrier in its own right there - and until the dot was allowed through, the
 * one topology plenty of ISPs insist on could not be selected at all. The PPPoE
 * batch form takes a VLAN of its own and builds `<carrier>.<vid>` itself, so it
 * must keep seeing bare devices only: handed `eth1.835` it would dial on
 * `eth1.835.100`.
 */
const MODEL: RouterModel = {
  t: 1_700_000_000_000,
  sys: { uptimeSec: 4_000, load1: 0, memTotal: 512_000, memFree: 200_000 },
  ifaces: [
    {
      name: 'wan835',
      proto: 'dhcp',
      device: 'eth1.835',
      l3Device: 'eth1.835',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000
    },
    {
      name: 'lan',
      proto: 'static',
      device: 'br-lan',
      l3Device: 'br-lan',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '192.168.1.1', mask: 24 }
    }
  ],
  poolDev: { count: 0, rx: 0, tx: 0 },
  leases: [],
  rules: [],
  rates: {
    eth1: { rx: 0, tx: 0 },
    'eth1.835': { rx: 0, tx: 0 },
    'eth1.836': { rx: 0, tx: 0 },
    'br-lan': { rx: 0, tx: 0 },
    'br-lan.10': { rx: 0, tx: 0 },
    'tun0.10': { rx: 0, tx: 0 },
    'pppoe-pd00001': { rx: 0, tx: 0 },
    // 16 characters: netifd would truncate it, and the instance would bind to
    // a device that is not the one named here.
    'eth1234567890.10': { rx: 0, tx: 0 }
  }
}

const EMPTY: OwrtHostData = {
  version: 2,
  instances: [],
  extraTables: [],
  stickyMap: [],
  events: [],
  moduleEvents: [],
  jobs: []
}

const offered = (kind: string): string[] =>
  selectOptions(kind, MODEL, EMPTY).map((option) => option.value)

describe('the two Carrier dropdowns', () => {
  it('offers WAN Binding the tagged uplinks as well as the devices', () => {
    expect(offered('binding-carriers')).toEqual([
      // A VLAN on a bridge is a WAN uplink; the bridge under it is not.
      'br-lan.10',
      'eth1',
      'eth1.835',
      'eth1.836'
    ])
  })

  it('keeps the PPPoE batch form on bare devices', () => {
    expect(offered('carriers')).toEqual(['eth1'])
  })
})
