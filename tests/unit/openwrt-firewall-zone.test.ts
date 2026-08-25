import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { ConfigStore } from '../../openwrt/main/config'
import { parseFirewallZones, pickLanZone } from '../../openwrt/main/parse'
import { FastSweep } from '../../openwrt/main/service'
import { HostStore } from '../../openwrt/main/store'
import { applyFirewallPlan, buildFirewallPlan } from '../../openwrt/main/uci'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * The LAN firewall zone used to be the literal string `lan`. A router that
 * calls its LAN zone anything else - and OpenWRT does not require that name -
 * got a forwarding from a zone that does not exist, so every session in the
 * pool dialed, came up, and carried no client traffic whatsoever.
 */

const ok = (stdout: string): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

function slowOutput(zones: string): string {
  return ['===LOG===', '===UCIMAP===', '===FWZONES===', zones].join('\n')
}

function newSweep(answer: (command: string) => ModuleExecResult): {
  sweep: FastSweep
  commands: string[]
} {
  const commands: string[] = []
  const harness = moduleHarness(
    'openwrt',
    (command) => {
      commands.push(command)
      return answer(command)
    },
    { config: sharedModuleConfig(null) }
  )
  const config = new ConfigStore(harness.ctx)
  const store = new HostStore(harness.ctx, () => config.effectiveRules())
  return { sweep: new FastSweep(harness.ctx, config, store), commands }
}

describe('firewall zone discovery', () => {
  it('reads anonymous zone sections and their networks', () => {
    const zones = parseFirewallZones(
      [
        'firewall.@zone[0]=zone',
        "firewall.@zone[0].name='lan'",
        "firewall.@zone[0].network='lan'",
        'firewall.@zone[1]=zone',
        "firewall.@zone[1].name='wan'",
        "firewall.@zone[1].network='wan' 'wan6'"
      ].join('\n')
    )
    expect(zones).toEqual([
      { section: '@zone[0]', name: 'lan', networks: ['lan'] },
      { section: '@zone[1]', name: 'wan', networks: ['wan', 'wan6'] }
    ])
  })

  it('collects a list written one value per line', () => {
    const zones = parseFirewallZones(
      [
        'firewall.lanzone=zone',
        "firewall.lanzone.name='lan-guest'",
        "firewall.lanzone.network='lan'",
        "firewall.lanzone.network='guest'"
      ].join('\n')
    )
    expect(zones).toEqual([
      { section: 'lanzone', name: 'lan-guest', networks: ['lan', 'guest'] }
    ])
  })

  it('falls back to the section id when a zone has no name option', () => {
    expect(parseFirewallZones('firewall.wan6=zone')).toEqual([
      { section: 'wan6', name: 'wan6', networks: [] }
    ])
  })

  it('ignores the name of a section that is not a zone', () => {
    // The router-side filter is a grep, so a rule's `.name=` arrives too. Only
    // sections the output declared as `=zone` may become zones.
    const zones = parseFirewallZones(
      [
        "firewall.@rule[3].name='Allow-DHCP-Renew'",
        'firewall.@zone[0]=zone',
        "firewall.@zone[0].name='lan'",
        "firewall.@zone[0].network='lan'",
        "network.lan.name='br-lan'"
      ].join('\n')
    )
    expect(zones).toEqual([{ section: '@zone[0]', name: 'lan', networks: ['lan'] }])
  })

  it('prefers the zone that owns network lan over one merely called lan', () => {
    const zones = parseFirewallZones(
      [
        'firewall.@zone[0]=zone',
        "firewall.@zone[0].name='lan'",
        'firewall.@zone[1]=zone',
        "firewall.@zone[1].name='trusted'",
        "firewall.@zone[1].network='lan'"
      ].join('\n')
    )
    expect(pickLanZone(zones)).toBe('trusted')
  })

  it('accepts a zone called lan that lists nothing', () => {
    expect(pickLanZone([{ section: '@zone[0]', name: 'lan', networks: [] }])).toBe('lan')
  })

  it('answers with an empty string rather than guessing a different zone', () => {
    expect(
      pickLanZone([{ section: '@zone[0]', name: 'wan', networks: ['wan'] }])
    ).toBe('')
    expect(pickLanZone([])).toBe('')
  })

  it('refuses a zone name that could not be written back safely', () => {
    expect(
      pickLanZone([{ section: '@zone[0]', name: "lan';reboot;'", networks: ['lan'] }])
    ).toBe('')
  })
})

describe('FastSweep.lanZone', () => {
  it('asks the router for its zones on the slow probe', async () => {
    const { sweep, commands } = newSweep(() => ok(slowOutput('')))
    await sweep.runSlow()
    expect(commands[0]).toContain("echo '===FWZONES==='")
    expect(commands[0]).toContain('uci -q show firewall')
  })

  it('reports the discovered zone, not the assumed one', async () => {
    const { sweep } = newSweep(() =>
      ok(
        slowOutput(
          ['firewall.lz=zone', "firewall.lz.name='lan-guest'", "firewall.lz.network='lan'"].join(
            '\n'
          )
        )
      )
    )
    expect(sweep.lanZone()).toBe('')
    await sweep.runSlow()
    expect(sweep.lanZone()).toBe('lan-guest')
  })

  it('keeps the last good answer when one sweep comes back with no zones', async () => {
    let zones = ['firewall.lz=zone', "firewall.lz.name='trusted'", "firewall.lz.network='lan'"].join(
      '\n'
    )
    const { sweep } = newSweep(() => ok(slowOutput(zones)))
    await sweep.runSlow()
    zones = ''
    await sweep.runSlow()
    expect(sweep.lanZone()).toBe('trusted')
  })

  it('forgets the zone when the host behind the context changes', async () => {
    const { sweep } = newSweep(() =>
      ok(slowOutput(['firewall.lz=zone', "firewall.lz.name='trusted'", "firewall.lz.network='lan'"].join('\n')))
    )
    await sweep.runSlow()
    sweep.reset()
    expect(sweep.lanZone()).toBe('')
  })
})

describe('buildFirewallPlan with a discovered zone', () => {
  it('forwards from the zone it was given', () => {
    const plan = buildFirewallPlan({
      zoneName: 'bmwanpool',
      prefix: 'bm',
      mode: 'wildcard',
      networkSections: [],
      chunkSize: 40,
      lanZone: 'lan-guest'
    })
    expect(plan.setupLines).toContain("set firewall.bmfwd.src='lan-guest'")
    expect(plan.setupLines).toContain("set firewall.bmfwd.dest='bmwanpool'")
  })

  it('falls back to lan when nothing was discovered', () => {
    const plan = buildFirewallPlan({
      zoneName: 'bmwanpool',
      prefix: 'bm',
      mode: 'wildcard',
      networkSections: [],
      chunkSize: 40,
      lanZone: ''
    })
    expect(plan.setupLines).toContain("set firewall.bmfwd.src='lan'")
  })

  it('still refuses a zone name it cannot write as a value', () => {
    expect(() =>
      buildFirewallPlan({
        zoneName: 'bmwanpool',
        prefix: 'bm',
        mode: 'wildcard',
        networkSections: [],
        chunkSize: 40,
        lanZone: "lan' 'wan"
      })
    ).toThrow(/firewall zone name/)
  })
})

/**
 * The other half of the same failure. Discovering the LAN zone is only useful
 * if something checks that the forwarding it produced actually loaded: the way
 * this goes wrong is a `src` zone fw4 has never heard of, which fw4 drops
 * silently while leaving the pool's own zone - and every rule naming its
 * devices - exactly as healthy as a working router's.
 */
describe('verifying that the LAN can reach the pool', () => {
  const PLAN = (lanZone: string) =>
    buildFirewallPlan({
      zoneName: 'bmwanpool',
      prefix: 'pd',
      mode: 'wildcard',
      networkSections: [],
      chunkSize: 40,
      lanZone
    })

  /** `<forwarding> <devices>`, the two counts the verification asks awk for. */
  function verifying(counts: string): {
    harness: ReturnType<typeof moduleHarness>
    commands: string[]
  } {
    const commands: string[] = []
    const harness = moduleHarness('openwrt', () => ({ code: 0, stdout: '', stderr: '' }))
    harness.exec.mockImplementation(async (command) => {
      commands.push(command)
      return command.startsWith('nft list ruleset') ? ok(counts) : ok('')
    })
    return { harness, commands }
  }

  it('asks the LAN zone chain about the pool zone, not the ruleset about the prefix', async () => {
    const { harness, commands } = verifying('1 6')

    await applyFirewallPlan(harness.ctx, PLAN('lan-guest'), { timeoutMs: 60_000 })

    const verify = commands.find((command) => command.startsWith('nft list ruleset')) ?? ''
    expect(verify).toContain("chain forward_lan-guest {")
    expect(verify).toContain("-v D='bmwanpool'")
  })

  it('warns when the pool has rules but nothing in the LAN chain reaches it', async () => {
    // Six rules naming `pppoe-pd` and no way in: the exact shape of a router
    // whose LAN zone is not called what the forwarding said it was. The old
    // count-by-prefix check passed this without a word.
    const { harness } = verifying('0 6')

    const result = await applyFirewallPlan(harness.ctx, PLAN('lan'), { timeoutMs: 60_000 })

    expect(result.ok).toBe(false)
    expect(result.warning).toContain('no rule letting lan reach bmwanpool')
    expect(result.warning).toContain('carry no client traffic')
  })

  it('reports a healthy pool as healthy', async () => {
    const { harness } = verifying('2 6')

    const result = await applyFirewallPlan(harness.ctx, PLAN('lan'), { timeoutMs: 60_000 })

    expect(result).toMatchObject({ ok: true, matches: 6 })
    expect(result.warning).toBeUndefined()
  })

  it('still names the membership mode when the pool has no rules at all', async () => {
    // A ruleset that mentions the pool nowhere has no zone to forward into, so
    // pointing the user at the LAN zone would be the wrong half of a firewall
    // that never materialized.
    const { harness } = verifying('0 0')

    const result = await applyFirewallPlan(harness.ctx, PLAN('lan'), { timeoutMs: 60_000 })

    expect(result.ok).toBe(false)
    expect(result.warning).toContain('Firewall membership mode')
  })

  it('measures nothing, and claims nothing, when asked not to verify', async () => {
    const { harness, commands } = verifying('0 0')

    const result = await applyFirewallPlan(harness.ctx, PLAN('lan'), {
      timeoutMs: 60_000,
      verify: false
    })

    expect(result).toMatchObject({ ok: true, matches: 0 })
    expect(commands.some((command) => command.startsWith('nft list ruleset'))).toBe(false)
  })
})
