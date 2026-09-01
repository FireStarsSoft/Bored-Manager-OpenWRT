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
  version: 3,
  instances: [],
  direct: [],
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

/**
 * The WAN port a single address is bound to, which is one UCI interface rather
 * than a device and a pool under it.
 *
 * This list was filtered by device name until it hid the thing it exists to
 * offer: a router whose ISP arrives on a bridged modem port has its uplink on
 * `br-wan`, and every such router was shown a dropdown with no WAN in it. The
 * same guess ran the other way and offered the LAN of every router whose LAN is
 * not a bridge. Nothing is hidden now - a dropdown cannot read /etc/config, and
 * a refusal the operator can read costs less than a control that is empty for
 * reasons nothing on the page explains - so all this owes them is an order that
 * puts the likely answers first and labels that tell the rows apart.
 */
const PORTS: RouterModel = {
  ...MODEL,
  ifaces: [
    {
      name: 'lan',
      proto: 'static',
      device: 'eth0.1',
      l3Device: 'eth0.1',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '192.168.1.1', mask: 24 }
    },
    {
      name: 'wanb',
      proto: 'dhcp',
      device: 'br-wan',
      l3Device: 'br-wan',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '203.0.113.20', mask: 24 }
    },
    {
      name: 'wanp',
      proto: 'pppoe',
      device: 'eth1',
      l3Device: 'pppoe-wanp',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '198.51.100.7', mask: 32 }
    },
    {
      name: 'wans',
      proto: 'static',
      device: 'eth2',
      l3Device: 'eth2',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '192.168.100.2', mask: 24 }
    },
    // A tunnel is not a WAN port a bound address can leave through, and its
    // protocol is what says so - not the shape of its name.
    {
      name: 'vpn',
      proto: 'wireguard',
      device: 'wg0',
      l3Device: 'wg0',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '10.9.0.2', mask: 24 }
    }
  ]
}

describe('the WAN port dropdown', () => {
  it('offers a bridged uplink, which the device-name filter used to hide', () => {
    expect(selectOptions('wan-ports', PORTS, EMPTY).map((option) => option.value)).toContain('wanb')
  })

  it('puts the protocols that mean uplink first and the ambiguous ones last', () => {
    // pppoe and dhcp say the router is a client of the network on the other
    // side; static says nothing, because it is what every LAN runs too - so a
    // LAN is offered rather than hidden, and offered at the bottom.
    expect(selectOptions('wan-ports', PORTS, EMPTY).map((option) => option.value)).toEqual([
      'wanp',
      'wanb',
      'lan',
      'wans'
    ])
  })

  it('names the protocol on every row, since that is what the order rests on', () => {
    const labels = new Map(
      selectOptions('wan-ports', PORTS, EMPTY).map((option) => [option.value, option.label])
    )

    expect(labels.get('wanp')).toBe('wanp — pppoe uplink on pppoe-wanp — 198.51.100.7')
    expect(labels.get('wanb')).toBe('wanb — dhcp uplink on br-wan — 203.0.113.20')
    expect(labels.get('lan')).toBe('lan — static on eth0.1 — 192.168.1.1')
  })

  it('leaves out what could not carry a bound address at all', () => {
    // The one exclusion left, and it is about the protocol rather than the
    // name: a one-to-one binding points at a routing table belonging to a
    // pppoe, dhcp or static interface.
    expect(selectOptions('wan-ports', PORTS, EMPTY).map((option) => option.value)).not.toContain(
      'vpn'
    )
  })
})

/** One managed PPPoE session, dialed over `<carrier>.<vlan>` the way a pool is. */
const session = (seq: number, carrier: string): RouterModel['ifaces'][number] => ({
  name: `pd${String(seq).padStart(5, '0')}`,
  proto: 'pppoe',
  device: `${carrier}.${seq}`,
  l3Device: `pppoe-pd${String(seq).padStart(5, '0')}`,
  up: true,
  pending: false,
  autostart: true,
  uptimeSec: 4_000,
  ipv4: { addr: `100.64.${Math.floor(seq / 256)}.${seq % 256}`, mask: 32 }
})

/**
 * A router carrying a PPPoE pool at its documented maximum, which is the one
 * shape that reaches the cap on this list.
 *
 * `model.ifaces` carries every session - only the dashboard folds them into an
 * aggregate - so before the cap learned to weigh what it drops, five hundred
 * `pd*` rows sorted above everything else and took the whole list: the payment
 * terminal's uplink `wan2` was in the sample and fell off the end of the
 * dropdown, and the field's own hint sent the operator to Refresh now, which
 * puts back a port that was never missing.
 */
const POOLED: RouterModel = {
  ...MODEL,
  ifaces: [
    ...Array.from({ length: 500 }, (_, index) => session(index + 1, 'eth1')),
    // A second session on another port: one row that a pool five hundred deep
    // would bury if the sessions were simply taken in name order.
    { ...session(900, 'eth2'), name: 'wanz', l3Device: 'pppoe-wanz' },
    {
      name: 'wan2',
      proto: 'dhcp',
      device: 'eth2',
      l3Device: 'eth2',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '203.0.113.20', mask: 24 }
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
  ]
}

const pooledPorts = (): string[] =>
  selectOptions('wan-ports', POOLED, EMPTY).map((option) => option.value)

describe('the WAN port dropdown on a router carrying a PPPoE pool', () => {
  it('still offers the DHCP uplink a pool of 500 sessions used to push off the end', () => {
    expect(pooledPorts()).toContain('wan2')
  })

  it('keeps every interface that is not a PPPoE session, however deep the pool', () => {
    // The rows a router has a handful of, and the ones most likely to be the
    // answer. A pool may take what is left of the cap and no more.
    expect(pooledPorts()).toContain('lan')
    expect(pooledPorts().slice(-2)).toEqual(['wan2', 'lan'])
  })

  it('gives a session on another port its turn before the pool empties the list', () => {
    // Round-robin over the port each session dials over, so `wanz` on eth2 is
    // in the list although five hundred `pd*` names sort above it.
    expect(pooledPorts()).toContain('wanz')
  })

  it('holds the list at the cap, since the cap is what keeps a select usable', () => {
    const values = pooledPorts()

    expect(values).toHaveLength(500)
    // Something has to fall off a 503-row router, and it is the tail of the
    // pool - never the only other uplink the router has.
    expect(values).not.toContain('pd00500')
  })
})

/**
 * The router a reviewer wrote down, carried into the other dropdown a pool
 * fills: a full five-hundred-session pool on `eth1`, and beside it the three
 * devices an operator would open Create an instance to pick.
 *
 * The sessions arrive as `eth1.101` through `eth1.600` because that is what the
 * pool form builds, and `isBindingCarrier` accepts a tagged device on purpose -
 * an ISP handing out the uplink tagged is exactly the topology the dot was
 * allowed through for. So this one list takes five hundred rows from one port
 * and then has to decide what else fits, which is the decision a plain
 * truncation never made.
 */
const CARRIER_POOL: RouterModel = {
  ...MODEL,
  ifaces: [
    ...Array.from({ length: 500 }, (_, index) => ({
      ...session(index + 1, 'eth1'),
      device: `eth1.${101 + index}`
    })),
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
    },
    // A bare DSA port, which is the second ISP.
    {
      name: 'wan2',
      proto: 'dhcp',
      device: 'wan',
      l3Device: 'wan',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '203.0.113.20', mask: 24 }
    },
    // The LTE failover the operator came to the form for.
    {
      name: 'lte',
      proto: 'dhcp',
      device: 'wwan0',
      l3Device: 'wwan0',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '10.64.7.9', mask: 30 }
    }
  ],
  rates: {
    eth1: { rx: 0, tx: 0 },
    wan: { rx: 0, tx: 0 },
    wwan0: { rx: 0, tx: 0 },
    'br-lan': { rx: 0, tx: 0 }
  }
}

const pooledCarriers = (): string[] =>
  selectOptions('binding-carriers', CARRIER_POOL, EMPTY).map((option) => option.value)

describe('the WAN carrier dropdown on a router carrying a PPPoE pool', () => {
  it('keeps the ports the pool is not riding on, however deep the pool', () => {
    // Sorted by label, `wan` and `wwan0` fall past `eth1.599` and a plain
    // truncation dropped both - including the LTE failover the operator opened
    // Create an instance to bind out of, with nothing on screen to say why.
    const values = pooledCarriers()

    expect(values).toContain('wwan0')
    expect(values).toContain('wan')
    expect(values).toContain('eth1')
  })

  it('holds the list at the cap and spends what is left on the pool', () => {
    const values = pooledCarriers()

    expect(values).toHaveLength(500)
    // Something has to fall off a 503-row router, and it is the tail of the
    // pool - never one of the three devices the pool is not on.
    expect(values).not.toContain('eth1.600')
  })

  it('still lists the carrier a pool rides on when the pool is all there is', () => {
    const alone: RouterModel = {
      ...CARRIER_POOL,
      ifaces: CARRIER_POOL.ifaces.filter((iface) => iface.proto === 'pppoe'),
      rates: { eth1: { rx: 0, tx: 0 } }
    }
    const values = selectOptions('binding-carriers', alone, EMPTY).map((option) => option.value)

    // The base device is the one row that is not a pool member, so it is kept
    // before any of its own VLANs are - a pool must never crowd out the port
    // it dials over.
    expect(values).toContain('eth1')
    expect(values).toHaveLength(500)
  })

  it('leaves the PPPoE batch form its own list, which no pool can reach', () => {
    // `isPppoeCarrier` refuses a tagged device, so the five hundred session
    // devices never enter this list at all and the cap is never in play.
    expect(selectOptions('carriers', CARRIER_POOL, EMPTY).map((option) => option.value)).toEqual([
      'eth1',
      'wan',
      'wwan0'
    ])
  })
})

/**
 * The LAN offered on Create a WAN Binding instance.
 *
 * This dropdown kept the sibling guess the WAN port list had already given up:
 * it dropped the interface literally named `wan` and nothing else, so a second
 * ISP on `wan2` was offered as one of the router's own networks, and a LAN that
 * takes its own address by DHCP was hidden with nothing on screen to say why.
 * A dropdown cannot read /etc/config, so it lists and `checkBinding` refuses.
 */
const LANS: RouterModel = {
  ...MODEL,
  ifaces: [
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
    },
    // A LAN whose own address comes from a DHCP server further out: a dumb AP,
    // or this router sitting downstream of another one.
    {
      name: 'guest',
      proto: 'dhcp',
      device: 'br-guest',
      l3Device: 'br-guest',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '10.20.0.2', mask: 24 }
    },
    // A second ISP running proto static, which is the name the old filter was
    // one character away from catching and would have been wrong to catch.
    {
      name: 'wan2',
      proto: 'static',
      device: 'eth2',
      l3Device: 'eth2',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '198.51.100.9', mask: 30 }
    },
    {
      name: 'wan',
      proto: 'pppoe',
      device: 'eth1',
      l3Device: 'pppoe-wan',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '198.51.100.7', mask: 32 }
    },
    {
      name: 'loopback',
      proto: 'static',
      device: 'lo',
      l3Device: 'lo',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '127.0.0.1', mask: 8 }
    }
  ]
}

const lanChoices = (): string[] =>
  selectOptions('lan-ifaces', LANS, EMPTY).map((option) => option.value)

describe('the LAN dropdown on Create an instance', () => {
  it('offers a LAN that takes its own address by DHCP, which it used to hide', () => {
    expect(lanChoices()).toContain('guest')
  })

  it('offers an uplink named wan2 rather than pretending the name settled it', () => {
    // It is not hidden and it is not endorsed: the check is what weighs the
    // dnsmasq sections and the firewall zone and refuses this pick.
    expect(lanChoices()).toContain('wan2')
  })

  it('leaves out the loopback and the PPPoE session, which have no LAN behind them', () => {
    expect(lanChoices()).not.toContain('loopback')
    expect(lanChoices()).not.toContain('wan')
  })

  it('names the protocol beside the subnet, now that the list mixes the two', () => {
    const labels = new Map(
      selectOptions('lan-ifaces', LANS, EMPTY).map((option) => [option.value, option.label])
    )

    expect(labels.get('lan')).toBe('lan — static 192.168.1.1/24 on br-lan')
    expect(labels.get('guest')).toBe('guest — dhcp 10.20.0.2/24 on br-guest')
  })
})

// -------------------------------------- a full pool sharing a trunk with an uplink

/**
 * Five hundred PPPoE sessions on `eth1`, and a static second uplink on a VLAN
 * of the same port.
 *
 * The pool is at MEMBER_MAX, so it can fill the list on its own. `eth1.7` is not
 * one of its sessions - it is a separate uplink that happens to share the trunk,
 * which is what an ISP-style handoff actually looks like - but it was counted as
 * pool membership because its base is a base the pool dials over. It then sorted
 * after every `eth1.1xx` and became the row the cap ran out on: absent from the
 * only control that could have named it, on a router where it is the one uplink
 * that is not busy.
 */
function trunkedPool(): RouterModel {
  const ifaces: RouterModel['ifaces'] = [
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
    },
    {
      name: 'wan2',
      proto: 'static',
      device: 'eth1.7',
      l3Device: 'eth1.7',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '203.0.113.2', mask: 30 }
    }
  ]
  const rates: RouterModel['rates'] = {
    eth1: { rx: 0, tx: 0 },
    'eth1.7': { rx: 0, tx: 0 },
    'br-lan': { rx: 0, tx: 0 }
  }
  for (let index = 0; index < 500; index++) {
    const device = `eth1.${101 + index}`
    ifaces.push({
      name: `pd${String(index).padStart(5, '0')}`,
      proto: 'pppoe',
      device,
      l3Device: `pppoe-pd${String(index).padStart(5, '0')}`,
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000
    })
    rates[device] = { rx: 0, tx: 0 }
  }
  return { ...MODEL, ifaces, rates }
}

describe('a WAN carrier list a full pool could fill', () => {
  const choices = (): string[] =>
    selectOptions('binding-carriers', trunkedPool(), EMPTY).map((option) => option.value)

  it('keeps the separate uplink sharing the pool trunk', () => {
    // The whole finding in one assertion: eth1.7 is not a session, so it is a
    // device in its own right and the pool may not push it off the end.
    expect(choices()).toContain('eth1.7')
  })

  it('still offers the trunk itself, which is how the pool is claimed', () => {
    expect(choices()).toContain('eth1')
  })

  it('leaves the PPPoE form its own list of bare devices', () => {
    // The sibling dropdown must not move: it builds `<carrier>.<vid>` itself,
    // so a tagged device there would dial on a VLAN of a VLAN.
    const pppoe = selectOptions('carriers', trunkedPool(), EMPTY).map((option) => option.value)

    expect(pppoe).toContain('eth1')
    expect(pppoe).not.toContain('eth1.7')
  })
})
