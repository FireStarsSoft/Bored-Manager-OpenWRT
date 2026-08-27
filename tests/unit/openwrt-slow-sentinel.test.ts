import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { ConfigStore } from '../../openwrt/main/config'
import { FastSweep } from '../../openwrt/main/service'
import { HostStore } from '../../openwrt/main/store'
import type { OpenWrtSlowSample } from '../../openwrt/main/types'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * `===UCIMAP===` is where the slow probe puts `uci show network`, and an empty
 * one used to be indistinguishable from a router that has no `option ip4table`
 * anywhere. The routing-table audit acts on exactly that difference: with no
 * observed map it sees every managed WAN as having lost its table - so it
 * offers the whole pool for repair - and it sees no WAN pointing at a table
 * this module did not assign, which is the check that stops it taking a table
 * something else owns. The fast sweep already guards its own rule list with
 * `===RULESOK===` for the same reason.
 */

const ok = (stdout: string, stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const UCI_MAP = [
  "network.pd00001.ip4table='10001'",
  "network.pd00001.username='user1@isp'",
  "network.pd00002.ip4table='10002'"
].join('\n')

const ZONES = [
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan'"
].join('\n')

const SYSCTL = [
  'net.netfilter.nf_conntrack_max=65536',
  'net.netfilter.nf_conntrack_count=1234',
  'net.ipv4.neigh.default.gc_thresh1=128',
  'net.ipv4.neigh.default.gc_thresh2=512',
  'net.ipv4.neigh.default.gc_thresh3=1024',
  'flow_offload=1'
].join('\n')

interface SlowOutput {
  uci?: string
  /** Omitted means the section never arrived - a cut reply, or `uci` gone. */
  uciOk?: '1' | '0' | null
  /** Null leaves the section out entirely, the shape of a cut reply. */
  sysctl?: string | null
}

function slowOutput(options: SlowOutput = {}): string {
  const parts = ['===LOG===', '===UCIMAP===', options.uci ?? UCI_MAP]
  const sentinel = options.uciOk === undefined ? '1' : options.uciOk
  if (sentinel != null) parts.push('===UCIOK===', sentinel)
  parts.push('===FWZONES===', ZONES)
  if (options.sysctl !== null) parts.push('===SYSCTL===', options.sysctl ?? SYSCTL)
  return parts.join('\n')
}

interface Probe {
  runSlow(): Promise<void>
  samples: OpenWrtSlowSample[]
  tables(): Record<string, number>
  sysctl(): Readonly<Record<string, number>>
  flowOffload(): boolean | null
  reply(output: string): void
  command: string
}

function probe(): Probe {
  const samples: OpenWrtSlowSample[] = []
  let output = slowOutput()
  let command = ''
  const harness = moduleHarness(
    'openwrt',
    (sent) => {
      command = sent
      return ok(output)
    },
    { config: sharedModuleConfig(null) }
  )
  const config = new ConfigStore(harness.ctx)
  const store = new HostStore(harness.ctx, () => config.effectiveRules())
  const sweep = new FastSweep(harness.ctx, config, store, {
    onSlowSample(sample) {
      samples.push(sample)
    }
  })
  return {
    samples,
    runSlow: () => sweep.runSlow(),
    tables: () => sweep.uciTables,
    sysctl: () => sweep.sysctl,
    flowOffload: () => sweep.flowOffload,
    reply: (next) => {
      output = next
    },
    get command() {
      return command
    }
  }
}

describe('the slow probe asks for a sentinel', () => {
  it('sends one whether or not uci prints anything', async () => {
    const run = probe()
    await run.runSlow()

    expect(run.command).toContain("echo '===UCIOK==='")
    expect(run.command).toContain('uci -q show network')
  })

  it('asks for the scale limits in the same trip', async () => {
    const run = probe()
    await run.runSlow()

    expect(run.command).toContain("echo '===SYSCTL==='")
    expect(run.command).toContain('net.netfilter.nf_conntrack_max')
    expect(run.command).toContain('net.ipv4.neigh.default.gc_thresh3')
    expect(run.command).toContain('flow_offloading')
  })
})

describe('the scale limits the router answered with', () => {
  it('land on the runtime, flow offload included', async () => {
    const run = probe()

    await run.runSlow()

    expect(run.sysctl()['net.netfilter.nf_conntrack_max']).toBe(65_536)
    expect(run.sysctl()['net.netfilter.nf_conntrack_count']).toBe(1_234)
    expect(run.sysctl()['net.ipv4.neigh.default.gc_thresh3']).toBe(1_024)
    expect(run.flowOffload()).toBe(true)
  })

  it('reads an absent flow_offloading option as off, not unknown', async () => {
    // `uci -q get` of an option that is not set prints nothing, and an absent
    // flow_offloading is fw4's default: off. Unknown is reserved for the
    // section never arriving at all.
    const run = probe()
    run.reply(slowOutput({ sysctl: 'net.netfilter.nf_conntrack_max=65536\nflow_offload=' }))

    await run.runSlow()

    expect(run.flowOffload()).toBe(false)
  })

  it('keeps the last good answer over a tick that lost the section', async () => {
    const run = probe()
    await run.runSlow()
    run.reply(slowOutput({ sysctl: null }))

    await run.runSlow()

    expect(run.sysctl()['net.netfilter.nf_conntrack_max']).toBe(65_536)
    expect(run.flowOffload()).toBe(true)
  })
})

describe('a UCI map the router answered for', () => {
  it('is reconciled against', async () => {
    const run = probe()

    await run.runSlow()

    expect(run.samples[0]?.uciTablesOk).toBe(true)
    expect(run.samples[0]?.uciTables).toEqual({ pd00001: 10_001, pd00002: 10_002 })
  })

  it('is reconciled against when it is legitimately empty', async () => {
    // A router with no `ip4table` set anywhere is a real state, and the one the
    // audit exists to repair. The sentinel is what tells it apart from silence.
    const run = probe()
    run.reply(slowOutput({ uci: '' }))

    await run.runSlow()

    expect(run.samples[0]?.uciTablesOk).toBe(true)
    expect(run.samples[0]?.uciTables).toEqual({})
  })
})

describe('a UCI map that did not arrive', () => {
  it('is never handed on as though the router had answered', async () => {
    const run = probe()
    await run.runSlow()
    run.reply(slowOutput({ uciOk: null }))

    await run.runSlow()

    expect(run.samples[1]?.uciTablesOk).toBe(false)
  })

  it('is not handed on when uci itself failed', async () => {
    const run = probe()
    run.reply(slowOutput({ uci: '', uciOk: '0' }))

    await run.runSlow()

    expect(run.samples[0]?.uciTablesOk).toBe(false)
  })

  it('leaves the last good map in place rather than emptying it', async () => {
    const run = probe()
    await run.runSlow()
    expect(run.tables()).toEqual({ pd00001: 10_001, pd00002: 10_002 })

    run.reply(slowOutput({ uci: '', uciOk: '0' }))
    await run.runSlow()

    // The same rule the firewall zones follow: one empty tick is a hiccup in
    // the pipe, not a router that lost its configuration.
    expect(run.tables()).toEqual({ pd00001: 10_001, pd00002: 10_002 })
    expect(run.samples[1]?.uciTables).toEqual({ pd00001: 10_001, pd00002: 10_002 })
  })
})
