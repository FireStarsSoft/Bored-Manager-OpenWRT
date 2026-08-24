import { describe, expect, it } from 'vitest'
import { splitSections } from '@shared/shell'
import {
  buildPoolDevRegex,
  parseDump,
  parseIpRules,
  parseLeases,
  parsePppoeList,
  parseProcNetDev,
  parseSystemInfo,
  uciQuote
} from '../../openwrt/main/parse'
import {
  buildFirewallPlan,
  buildPppoeUci,
  effectivePppoeChunkSize
} from '../../openwrt/main/uci'
import {
  planBindingReconciliation,
  tokenizeUciValues,
  type BindingPlannerMemory,
  type BindingPlannerPolicy,
  type BindingPlannerWan,
  type BindingReconcileInput
} from '../../openwrt/main/binding'
import { findSequenceRange } from '../../openwrt/main/pppoe'
import { buildFastSweepCommand } from '../../openwrt/main/service'
import { selectOptions } from '../../openwrt/main/options'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import type { IpRule, Lease, RouterModel } from '../../openwrt/main/types'

describe('OpenWRT parsers', () => {
  it('parses mixed PPPoE delimiters, comments, CRLF, VLANs and duplicate users', () => {
    const parsed = parsePppoeList(
      [
        '# account export',
        'alice\tsecret\t35',
        'bob,password',
        'carol;pass;4094',
        'dave|word|2',
        'eve  two-words',
        'alice,again,35'
      ].join('\r\n')
    )

    expect(parsed.errors).toEqual([])
    expect(parsed.duplicates).toEqual(['alice'])
    expect(parsed.rows).toEqual([
      { user: 'alice', pass: 'secret', vlan: 35 },
      { user: 'bob', pass: 'password' },
      { user: 'carol', pass: 'pass', vlan: 4094 },
      { user: 'dave', pass: 'word', vlan: 2 },
      { user: 'eve', pass: 'two-words' },
      { user: 'alice', pass: 'again', vlan: 35 }
    ])
  })

  it('parses 5000 PPPoE rows in under 2 seconds', () => {
    const text = Array.from(
      { length: 5_000 },
      (_, index) => `user${String(index).padStart(4, '0')},pass${index}`
    ).join('\n')
    const started = Date.now()
    const parsed = parsePppoeList(text)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(parsed.rows).toHaveLength(5_000)
    expect(parsed.errors).toEqual([])
    expect(parsed.duplicates).toEqual([])
  })

  it('reports malformed PPPoE rows without retaining partial rows', () => {
    const parsed = parsePppoeList('only-user\nuser,pass,0\nuser2,pass2,4095\n,missing')

    expect(parsed.rows).toEqual([])
    expect(parsed.errors.map((entry) => entry.line)).toEqual([1, 2, 3, 4])
    expect(parsed.errors[0]?.reason).toContain('username and password')
    expect(parsed.errors[1]?.reason).toContain('VLAN')
  })

  it('quotes UCI values and produces deterministic PPPoE UCI', () => {
    expect(uciQuote("a'b")).toBe("'a'\\''b'")
    expect(
      buildPppoeUci(
        [{ user: 'account', pass: "pa'ss" }],
        { prefix: 'pd', carrier: 'eth1', seqFrom: 1, tableBase: 10_000 }
      )
    ).toBe(
      [
        'set network.pd00001=interface',
        "set network.pd00001.proto='pppoe'",
        "set network.pd00001.device='eth1'",
        "set network.pd00001.username='account'",
        "set network.pd00001.password='pa'\\''ss'",
        "set network.pd00001.ipv6='0'",
        "set network.pd00001.peerdns='0'",
        "set network.pd00001.defaultroute='1'",
        "set network.pd00001.ip4table='10001'",
        "set network.pd00001.metric='10001'",
        ''
      ].join('\n')
    )
  })

  it('keeps large PPPoE work bounded and builds fw4 wildcard membership', () => {
    expect(effectivePppoeChunkSize(5_000, 100)).toBe(100)
    expect(effectivePppoeChunkSize(5_000, 1)).toBe(50)
    const firewall = buildFirewallPlan({
      zoneName: 'bmwanpool',
      prefix: 'pd',
      prefixes: ['pd', 'isp'],
      mode: 'wildcard',
      networkSections: [],
      chunkSize: 100,
      lanZone: 'lan'
    })
    expect(firewall.membershipChunks).toEqual([])
    expect(firewall.setupLines).toContain(
      "add_list firewall.bmwanpool.device='pppoe-pd+'"
    )
    expect(firewall.setupLines).toContain(
      "add_list firewall.bmwanpool.device='pppoe-isp+'"
    )
  })

  it('scopes router-side rate aggregation to exact managed sequence ranges', () => {
    const command = buildFastSweepCommand(
      DEFAULT_RULES,
      [{ prefix: 'pd', seqFrom: 101, seqTo: 1100 }],
      true
    )
    expect(command).toContain("-v R='pd:101-1100'")
    expect(command).toContain("echo '===DUMP==='")
    expect(
      buildFastSweepCommand(DEFAULT_RULES, [], false)
    ).not.toContain("echo '===DUMP==='")
  })

  it('emits the rules sentinel as a section splitSections can actually read', () => {
    // Written as `===RULES_OK===1` it matched nothing: splitSections only
    // accepts a line that is exactly `===NAME===` with NAME in capitals and
    // no underscore, so the sentinel read false on every tick and the binding
    // engine never received a model.
    const command = buildFastSweepCommand(DEFAULT_RULES, [], false)
    expect(command).toContain("echo '===RULESOK==='")
    expect(command).not.toContain('RULES_OK')

    const ruleLine = `${DEFAULT_RULES.rulePrefBase}: from 192.168.9.44 lookup 200`
    const succeeded = splitSections(
      `===RULES===\n${ruleLine}\n===RULESOK===\n1\n`
    )
    expect(succeeded.get('RULESOK')?.trim()).toBe('1')
    // The sentinel is its own section, so it can no longer leak into the body
    // the rule parser reads.
    expect(parseIpRules(succeeded.get('RULES') ?? '')).toEqual([
      { pref: DEFAULT_RULES.rulePrefBase, from: '192.168.9.44', table: 200 }
    ])

    const failed = splitSections('===RULES===\n===RULESOK===\n0\n')
    expect(failed.get('RULESOK')?.trim()).toBe('0')
    expect(parseIpRules(failed.get('RULES') ?? '')).toEqual([])
  })

  it('offers physical carriers but excludes bridges, VLANs and tunnels', () => {
    const model: RouterModel = {
      t: NOW,
      sys: { uptimeSec: 1, load1: 0, memTotal: 1, memFree: 1 },
      ifaces: [
        {
          name: 'wan',
          proto: 'dhcp',
          device: 'eth1',
          l3Device: 'eth1',
          up: true,
          pending: false,
          autostart: true,
          uptimeSec: 1
        },
        {
          name: 'lan',
          proto: 'static',
          device: 'br-lan',
          l3Device: 'br-lan',
          up: true,
          pending: false,
          autostart: true,
          uptimeSec: 1,
          ipv4: { addr: '192.168.1.1', mask: 24 }
        }
      ],
      poolDev: { count: 0, rx: 0, tx: 0 },
      leases: [],
      rules: [],
      rates: {
        eth1: { rx: 0, tx: 0 },
        'br-lan': { rx: 0, tx: 0 },
        'eth1.35': { rx: 0, tx: 0 },
        tun0: { rx: 0, tx: 0 }
      }
    }
    expect(
      selectOptions('carriers', model, {
        version: 1,
        nextSeq: 1,
        batches: [],
        instances: [],
        extraTables: [],
        stickyMap: [],
        events: [],
        jobs: []
      }).map((option) => option.value)
    ).toEqual(['eth1'])
  })

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
    expect(buildPoolDevRegex(['pd', 'isp+'])).toBe('pppoe-(pd|isp\\+)')
  })
})

const NOW = 1_700_000_000_000
const INSTANCE = {
  id: 'bind_1',
  running: true,
  sticky: true,
  remap: true
}
const POLICY: BindingPlannerPolicy = {
  rulePrefBase: 20_000,
  catchAllPrefBase: 29_900,
  ruleChunkLines: 500,
  wanErrorGraceSec: 30,
  wanWarnUptimeSec: 0,
  releaseGraceSec: 300,
  remapOnWanError: true,
  stickyByMac: true,
  maxEvents: 200
}

function lease(
  mac = '00:11:22:33:44:55',
  ip = '192.168.10.2',
  host = 'phone'
): Lease {
  return { mac, ip, host, expires: Math.floor(NOW / 1000) + 3600 }
}

function wan(
  name: string,
  table: number,
  overrides: Partial<BindingPlannerWan> = {}
): BindingPlannerWan {
  return {
    name,
    table,
    up: true,
    pending: false,
    ipv4: `198.51.100.${table % 250}`,
    uptimeSec: 3600,
    ...overrides
  }
}

function input(overrides: Partial<BindingReconcileInput> = {}): BindingReconcileInput {
  return {
    now: NOW,
    instance: INSTANCE,
    lanCidr: '192.168.10.0/24',
    leases: [lease()],
    rules: [],
    wans: [wan('pd00001', 10_001)],
    tableToWan: [[10_001, 'pd00001']],
    sticky: [],
    policy: POLICY,
    randomSeed: 7,
    ...overrides
  }
}

function rulesFromDesired(
  desired: ReadonlyArray<{ pref: number; ip: string; table: number }>
): IpRule[] {
  return desired.map((entry) => ({
    pref: entry.pref,
    from: `${entry.ip}/32`,
    table: entry.table
  }))
}

describe('OpenWRT one-to-one binding planner', () => {
  it('assigns a new DHCP client to one free WAN and emits only one add', () => {
    const result = planBindingReconciliation(input())

    expect(result.devices).toEqual({ total: 1, bound: 1, waiting: 0 })
    expect(result.wan).toEqual({
      total: 1,
      available: 0,
      bound: 1,
      error: 0,
      warning: 0,
      dialing: 0
    })
    expect(result.desired[0]).toMatchObject({
      ip: '192.168.10.2',
      table: 10_001,
      wan: 'pd00001',
      mac: '00:11:22:33:44:55'
    })
    expect(result.ruleDiff.delete).toEqual([])
    expect(result.ruleDiff.add).toHaveLength(1)
  })

  it('queues a device when no WAN is free', () => {
    const result = planBindingReconciliation(input({ wans: [], tableToWan: [] }))

    expect(result.devices).toEqual({ total: 1, bound: 0, waiting: 1 })
    expect(result.waiting[0]).toMatchObject({
      mac: '00:11:22:33:44:55',
      ip: '192.168.10.2',
      position: 1
    })
    expect(result.ruleDiff.lines).toEqual([])
  })

  it('produces an empty diff for an already-correct assignment', () => {
    const first = planBindingReconciliation(input())
    const second = planBindingReconciliation(
      input({
        rules: rulesFromDesired(first.desired),
        memory: first.memory,
        sticky: first.stickyUpdates
      })
    )

    expect(second.desired).toEqual(first.desired)
    expect(second.ruleDiff.lines).toEqual([])
  })

  it('treats per-instance sticky choice as authoritative', () => {
    const result = planBindingReconciliation(
      input({
        wans: [wan('pd00001', 10_001), wan('pd00002', 10_002)],
        tableToWan: [
          [10_001, 'pd00001'],
          [10_002, 'pd00002']
        ],
        sticky: [{
          mac: '00:11:22:33:44:55',
          wan: 'pd00002',
          lastSeenAt: NOW - 1000
        }],
        policy: { ...POLICY, stickyByMac: false },
        randomSeed: 7
      })
    )
    expect(result.desired[0]?.wan).toBe('pd00002')
  })

  it('keeps the WAN but replaces the source rule when a lease IP changes', () => {
    const first = planBindingReconciliation(input())
    const changed = planBindingReconciliation(
      input({
        leases: [lease('00:11:22:33:44:55', '192.168.10.9')],
        rules: rulesFromDesired(first.desired),
        memory: first.memory,
        sticky: first.stickyUpdates
      })
    )

    expect(changed.desired[0]).toMatchObject({
      ip: '192.168.10.9',
      wan: 'pd00001',
      table: 10_001
    })
    expect(changed.ruleDiff.delete).toHaveLength(1)
    expect(changed.ruleDiff.add).toHaveLength(1)
  })

  it('remaps a client after its WAN exceeds the error grace period', () => {
    const memory: BindingPlannerMemory = {
      devices: [{
        mac: '00:11:22:33:44:55',
        ip: '192.168.10.2',
        host: 'phone',
        lastSeenAt: NOW - 1000,
        assignedAt: NOW - 60_000,
        wan: 'pd00001'
      }],
      waiting: [],
      wanErrors: [{ wan: 'pd00001', since: NOW - 31_000 }],
      orphans: [],
      heldMacs: [],
      forceReassign: [],
      nextOrder: 1
    }
    const result = planBindingReconciliation(
      input({
        rules: [{ pref: 20_000, from: '192.168.10.2/32', table: 10_001 }],
        wans: [
          wan('pd00001', 10_001, { up: false, ipv4: undefined, errorCode: 'LINK_LOST' }),
          wan('pd00002', 10_002)
        ],
        tableToWan: [
          [10_001, 'pd00001'],
          [10_002, 'pd00002']
        ],
        sticky: [{ mac: '00:11:22:33:44:55', wan: 'pd00001', lastSeenAt: NOW - 1000 }],
        memory,
        policy: { ...POLICY, remapOnWanError: false }
      })
    )

    expect(result.desired[0]).toMatchObject({ wan: 'pd00002', table: 10_002 })
    expect(result.events.some((event) => event.kind === 'remapped')).toBe(true)
    expect(result.ruleDiff.delete).toHaveLength(1)
    expect(result.ruleDiff.add).toHaveLength(1)
  })

  it('reports a WAN without IPv4 as warning without remapping it', () => {
    const memory: BindingPlannerMemory = {
      devices: [{
        mac: '00:11:22:33:44:55',
        ip: '192.168.10.2',
        host: 'phone',
        lastSeenAt: NOW - 1000,
        assignedAt: NOW - 60_000,
        wan: 'pd00001'
      }],
      waiting: [],
      wanErrors: [{ wan: 'pd00001', since: NOW - 60_000 }],
      orphans: [],
      heldMacs: [],
      forceReassign: [],
      nextOrder: 1
    }
    const result = planBindingReconciliation(
      input({
        rules: [{ pref: 20_000, from: '192.168.10.2/32', table: 10_001 }],
        wans: [
          wan('pd00001', 10_001, { ipv4: undefined }),
          wan('pd00002', 10_002)
        ],
        tableToWan: [
          [10_001, 'pd00001'],
          [10_002, 'pd00002']
        ],
        memory
      })
    )
    expect(result.desired[0]?.wan).toBe('pd00001')
    expect(result.wan.warning).toBe(1)
    expect(result.events.some((event) => event.kind === 'remapped')).toBe(false)
  })

  it('reapplies a sticky assignment after router rules disappear on reboot', () => {
    const previous = planBindingReconciliation(input())
    const reboot = planBindingReconciliation(
      input({
        rules: [],
        memory: previous.memory,
        sticky: previous.stickyUpdates,
        rebooted: true
      })
    )

    expect(reboot.desired[0]?.wan).toBe('pd00001')
    expect(reboot.ruleDiff.delete).toEqual([])
    expect(reboot.ruleDiff.add).toHaveLength(1)
  })

  it('retains a missing lease during release grace then releases its WAN', () => {
    const previous = planBindingReconciliation(input())
    const baseMemory = {
      ...previous.memory,
      devices: previous.memory.devices.map((device) => ({
        ...device,
        lastSeenAt: NOW
      }))
    }
    const duringGrace = planBindingReconciliation(
      input({
        now: NOW + 60_000,
        leases: [],
        rules: rulesFromDesired(previous.desired),
        memory: baseMemory,
        sticky: previous.stickyUpdates
      })
    )
    expect(duringGrace.desired).toHaveLength(1)

    const afterGrace = planBindingReconciliation(
      input({
        now: NOW + 301_000,
        leases: [],
        rules: rulesFromDesired(previous.desired),
        memory: baseMemory,
        sticky: previous.stickyUpdates
      })
    )
    expect(afterGrace.desired).toEqual([])
    expect(afterGrace.ruleDiff.delete).toHaveLength(1)
  })

  it('plans 5,000 one-to-one assignments without creating per-device jobs', () => {
    const leases = Array.from({ length: 5_000 }, (_, index) => {
      const third = Math.floor(index / 250)
      const fourth = (index % 250) + 1
      const mac = `02:${(index >>> 24).toString(16).padStart(2, '0')}:${(
        (index >>> 16) &
        255
      )
        .toString(16)
        .padStart(2, '0')}:${((index >>> 8) & 255)
        .toString(16)
        .padStart(2, '0')}:${(index & 255).toString(16).padStart(2, '0')}:01`
      return lease(mac, `10.20.${third}.${fourth}`, `client-${index}`)
    })
    const wans = Array.from({ length: 5_000 }, (_, index) =>
      wan(`pd${String(index + 1).padStart(5, '0')}`, 10_001 + index)
    )
    const result = planBindingReconciliation(
      input({
        lanCidr: '10.20.0.0/16',
        leases,
        wans,
        tableToWan: wans.map((entry) => [entry.table!, entry.name] as const)
      })
    )

    expect(result.devices).toEqual({ total: 5_000, bound: 5_000, waiting: 0 })
    expect(result.ruleDiff.add).toHaveLength(5_000)
    expect(result.ruleDiff.chunks).toHaveLength(10)
  })
})

describe('OpenWRT safety helpers', () => {
  it('tokenizes UCI list options into individual values', () => {
    expect(tokenizeUciValues("'lan' 'guest'")).toEqual(['lan', 'guest'])
    expect(tokenizeUciValues("'lan'")).toEqual(['lan'])
    expect(tokenizeUciValues("lan")).toEqual(['lan'])
  })

  it('reuses freed PPPoE sequence ranges after nextSeq is exhausted', () => {
    const limit = DEFAULT_RULES.catchAllTable - DEFAULT_RULES.tableBase - 1
    const range = findSequenceRange(
      2,
      'pd',
      DEFAULT_RULES,
      { nextSeq: limit, batches: [] },
      { carrierExists: true, sections: new Set(), tables: new Set(), vlanDevices: new Map() }
    )
    expect(range).toEqual({ from: 1, to: 2 })
  })
})
