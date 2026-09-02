import { describe, expect, it } from 'vitest'
import {
  parseDump,
  parseIpRules,
  parseLeases,
  parseProcNetDev,
  parseSystemInfo,
  // Read from the file that declares it rather than through `binding/`, which
  // only ever re-exported it: that folder was the SSH half and is gone, and the
  // tokenizer is UCI parsing that outlives it.
  tokenizeUciValues
} from '../../openwrt/main/parse'

/**
 * The pure readers: what this module makes of the bytes a router prints at it.
 *
 * The one-to-one binding planner used to sit below them, nine cases of it, and
 * the WAN dropdown it fed sat beside them. Both are the router's from packages
 * 2.4.0 - `bm-wanbind` decides every assignment, writes every rule and says
 * which interfaces are ways out - and both are tested there, against the real
 * ucode under the real compiler, by the `wanbind-direct`, `wanbind-generator`
 * and `wanbind-layout` probes in `packages/ci/probes/`. What this module now
 * does with those answers is `openwrt-binding-options` and the rest of the
 * `openwrt-binding-*` files. Nothing on this side plans a rule or classifies an
 * interface to have an opinion about any more.
 */

describe('OpenWRT parsers', () => {

  it('parses ubus interface and system snapshots defensively', () => {
    expect(
      parseDump(
        JSON.stringify({
          interface: [
            {
              interface: 'pd00001',
              proto: 'pppoe',
              device: 'eth1',
              l3_device: 'pppoe-pd00001',
              up: true,
              pending: false,
              autostart: true,
              uptime: 123,
              ip4table: 10001,
              'ipv4-address': [{ address: '198.51.100.10', mask: 32 }]
            },
            {
              interface: 'broken',
              errors: [{ subsystem: 'pppoe', code: 'CONNECT_FAILED' }]
            }
          ]
        })
      )
    ).toEqual([
      {
        name: 'pd00001',
        proto: 'pppoe',
        device: 'eth1',
        l3Device: 'pppoe-pd00001',
        up: true,
        pending: false,
        autostart: true,
        ipv4: { addr: '198.51.100.10', mask: 32 },
        uptimeSec: 123,
        errorCode: undefined,
        ip4Table: 10001
      },
      {
        name: 'broken',
        proto: '',
        device: '',
        l3Device: '',
        up: false,
        pending: false,
        autostart: true,
        ipv4: undefined,
        uptimeSec: 0,
        errorCode: 'CONNECT_FAILED',
        ip4Table: undefined
      }
    ])

    expect(
      parseSystemInfo(
        JSON.stringify({
          uptime: 3600,
          localtime: 1_700_000_000,
          load: [65_536, 0, 0],
          memory: { total: 1_073_741_824, free: 100, available: 200 }
        })
      )
    ).toEqual({
      uptimeSec: 3600,
      load1: 1,
      memTotal: 1_073_741_824,
      memFree: 200
    })
  })

  it('parses leases, managed rules and compact device counters', () => {
    expect(
      parseLeases(
        '1700000100 AA:BB:CC:DD:EE:FF 192.168.10.2 phone *\n' +
          '0 00:11:22:33:44:55 192.168.10.3 * *\n' +
          'bad row'
      )
    ).toEqual([
      {
        expires: 1_700_000_100,
        mac: 'aa:bb:cc:dd:ee:ff',
        ip: '192.168.10.2',
        host: 'phone'
      },
      {
        expires: 0,
        mac: '00:11:22:33:44:55',
        ip: '192.168.10.3',
        host: ''
      }
    ])

    expect(
      parseIpRules(
        '20000: from 192.168.10.2 lookup 10001\n' +
          '20001: from 192.168.10.3/32 table 10002\n' +
          'not a rule'
      )
    ).toEqual([
      { pref: 20_000, from: '192.168.10.2', table: 10_001 },
      { pref: 20_001, from: '192.168.10.3/32', table: 10_002 }
    ])

    expect(
      parseProcNetDev('eth0 1000 2000\n===POOL=== 1000 5000000 7000000\n')
    ).toEqual({
      devices: { eth0: { rx: 1000, tx: 2000 } },
      poolDev: { count: 1000, rx: 5_000_000, tx: 7_000_000 }
    })
  })
})

describe('OpenWRT safety helpers', () => {
  it('tokenizes UCI list options into individual values', () => {
    expect(tokenizeUciValues("'lan' 'guest'")).toEqual(['lan', 'guest'])
    expect(tokenizeUciValues("'lan'")).toEqual(['lan'])
    expect(tokenizeUciValues("lan")).toEqual(['lan'])
  })
})
