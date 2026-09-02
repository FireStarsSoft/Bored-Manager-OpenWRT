import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import { FEATURES } from '../../openwrt/main/requirements'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import {
  BINDING_AGENT_INFO,
  isProbeCommand,
  routerProbeOutput,
  type RouterProbeOptions
} from '../helpers/router'

/**
 * One gate, in front of every method.
 *
 * The module used to check capabilities in two places: the PPPoE create form
 * and the binding create form, each with its own hand-written `if` chain. So
 * `pppoeBatchApply` would apply a plan the check had refused, `bindingStart` on
 * an instance created months ago never asked again whether `ip rule` still
 * worked, and a method added tomorrow arrived with no gate at all. Everything
 * below is about that gate being one gate.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 30): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const INSTANCE = {
  id: 'bind_1',
  name: 'Office LAN',
  lan: 'lan',
  carrier: 'eth1',
  running: false,
  sticky: true,
  remap: true,
  createdAt: 1,
  slot: 0
}

function hostData(): unknown {
  return {
    version: 2,
    instances: [INSTANCE],
    extraTables: [],
    stickyMap: [],
    events: [],
    moduleEvents: [],
    jobs: []
  }
}

interface Router {
  call(method: string, ...args: unknown[]): Promise<unknown>
  /** Answer the next probe differently, then run one. */
  reprobe(options: RouterProbeOptions): Promise<void>
  dispose(): void
}

async function router(options: RouterProbeOptions = {}): Promise<Router> {
  let shape = options
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: hostData(),
    config: sharedModuleConfig(null)
  })
  harness.exec.mockImplementation(async (command) =>
    isProbeCommand(command) ? ok(routerProbeOutput(shape)) : ok()
  )
  const runtime = activate(harness.ctx)
  runtime.applyPollers?.()
  await settle()
  return {
    call: async (method, ...args) => harness.handlers.get(method)?.(...args),
    reprobe: async (next) => {
      shape = next
      await harness.handlers.get('sweepNow')?.()
      await settle()
    },
    dispose: () => runtime.dispose?.()
  }
}

const errorOf = (result: unknown): string => (result as OkResult).error ?? ''
const report = (result: unknown): ModuleCheckReport => result as ModuleCheckReport
const text = (result: unknown): string =>
  report(result)
    .findings.map((finding) => `${finding.level} ${finding.label} ${finding.detail ?? ''}`)
    .join('\n')

describe('the registry and the manifest are the same list', () => {
  it('has an entry for every method the manifest declares, and no others', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../openwrt/module.json', import.meta.url), 'utf8')
    ) as { methods: string[] }

    // This is the unit-test half of `scripts/check-requirements.mjs`. Both
    // exist: the script also reads what `handlers.ts` registers, which is the
    // half a type cannot see.
    expect([...Object.keys(FEATURES)].sort()).toEqual([...manifest.methods].sort())
  })

  it('spells out the read-only methods rather than leaving them absent', () => {
    // `null` is a statement - "this reads and needs nothing" - and it is what
    // makes a method somebody forgot distinguishable from one deliberately
    // left open.
    expect(FEATURES.deviceRows).toBeNull()
    expect(FEATURES.eventRows).toBeNull()
    expect(FEATURES.poolCreateApply?.requires.length).toBeGreaterThan(0)
  })
})

describe('what the gate stops', () => {
  it('refuses bindingStart with a sentence rather than a shell error', async () => {
    // This used to be about `ip-full`: the instance was created on a router
    // that had it and has since lost it, nothing asked again, the reconcile
    // called `ip rule`, and the user got whatever BusyBox prints when a
    // subcommand does not exist.
    //
    // The binary is not on this path any more - the daemon writes rules over
    // netlink and this module writes none - so the missing thing a person now
    // has to be told about is the daemon itself. The shape of the obligation is
    // unchanged and is the point of the case: a sentence naming what is missing
    // and where to get it, rather than a failure somewhere the user cannot see.
    const owrt = await router({ agent: null })

    const result = await owrt.call('bindingStart', 'bind_1')

    expect((result as OkResult).ok).toBe(false)
    expect(errorOf(result)).toContain('binding daemon')
    expect(errorOf(result)).toContain('Router packages')
    owrt.dispose()
  })

  it('does not hold binding to the ip binary when the router binds itself', async () => {
    // With bm-wanbind installed, the module never writes an ip rule of its
    // own - every bind is a ubus call and the daemon writes netlink. So a
    // router whose `ip` binary fails the numeric-table test (BusyBox, or a
    // probe misreading) must not have its daemon-driven binding refused over
    // a binary nothing on this path uses.
    const owrt = await router({ without: ['ip-full'], agent: BINDING_AGENT_INFO })

    const result = await owrt.call('bindingStart', 'bind_1')

    expect(errorOf(result)).not.toContain('steer traffic by routing table')
    owrt.dispose()
  })

  it('refuses an apply whose capability disappeared after the check passed', async () => {
    // The gap the registry was written for. A token is issued by a check, and
    // the apply that spends it used to trust the token alone. The gate sits in
    // front of the token handling, so a router that lost the dialing stack
    // refuses before any token is even looked at.
    const owrt = await router()
    await owrt.reprobe({ without: ['pppd'] })

    const applied = await owrt.call('poolCreateApply', {
      token: 'issued-before-the-router-changed',
      values: { mode: 'multi', id: 'home', carrier: 'eth1', vlans: '101' }
    })

    expect((applied as OkResult).ok).toBe(false)
    expect(errorOf(applied)).toContain('PPPoE support is missing on this router')
    owrt.dispose()
  })

  it('refuses on a service that stopped, naming the service and not a package', async () => {
    // With the daemon: this case is about a service, and a router missing the
    // package would answer about the package instead.
    const owrt = await router({
      agent: BINDING_AGENT_INFO,
      service: ['pidof', 'netifd', 'nftok', 'fw4']
    })

    const result = await owrt.call('bindingCheck', {
      name: 'Office',
      lan: 'lan',
      carrier: 'eth1'
    })

    expect(report(result).ok).toBe(false)
    expect(text(result)).toContain('dnsmasq is installed but not running')
    expect(text(result)).toContain('service dnsmasq start')
    // Not an install: the package is right there.
    expect(text(result)).not.toContain('Install missing packages')
    owrt.dispose()
  })

  it('never refuses over a service state nobody could read', async () => {
    // No pidof on this router, so "is dnsmasq running" has no answer. Treating
    // that as "no" would invent a fault out of a missing BusyBox applet.
    const owrt = await router({ service: ['nftok', 'fw4'] })

    const result = await owrt.call('bindingCheck', {
      name: 'Office',
      lan: 'lan',
      carrier: 'eth1'
    })

    expect(text(result)).not.toContain('not running')
    owrt.dispose()
  })
})

describe('what the gate deliberately lets through', () => {
  it('never traps a user with an instance they cannot remove', async () => {
    // A router that has lost everything. Stop and delete are the way out of
    // that, so refusing them would leave the user with records they can see,
    // cannot act on, and cannot get rid of.
    const owrt = await router({ without: ['pppd', 'dnsmasq', 'fw4', 'nft', 'ip-full'] })

    for (const [method, args] of [
      ['bindingStop', ['bind_1']],
      ['bindingDelete', ['bind_1']]
    ] as Array<[string, unknown[]]>) {
      const result = (await owrt.call(method, ...args)) as OkResult
      expect(errorOf(result)).not.toContain('missing on this router')
      expect(errorOf(result)).not.toContain('has not been checked yet')
    }
    owrt.dispose()
  })

  it('sends a pool delete without its daemon to the page that restores it', async () => {
    // Pools live on the router and only bm-pppoe-pool can take one apart -
    // there is no SSH deleter left to fall back to. What the gate owes the
    // user is the way back: the page that installs or updates the package.
    const owrt = await router({ without: ['pppd', 'dnsmasq', 'fw4', 'nft', 'ip-full'] })

    const result = (await owrt.call('poolDelete', 'fpt1')) as OkResult

    expect(result.ok).toBe(false)
    expect(errorOf(result)).toContain('Router packages')
    owrt.dispose()
  })

  it('leaves the install flow and the re-check path open on a hopeless router', async () => {
    const owrt = await router({ without: ['pppd', 'dnsmasq', 'fw4', 'nft', 'ip-full'] })

    // Gating the installer on the packages it exists to install is a loop with
    // no way out, and `sweepNow` is the only way out of a stale verdict.
    const setup = report(await owrt.call('setupCheck', { pppoe: true }))
    expect(text(setup)).not.toContain('missing on this router')
    expect((await owrt.call('sweepNow')) as OkResult).toMatchObject({ ok: true })
    owrt.dispose()
  })

  it('still refuses a rename, because a rename is now a write to the router', async () => {
    // This case used to assert the opposite, and it was right to at the time:
    // an instance's name lived in this module's own records, so renaming one
    // touched nothing and refusing it would have been a gate for its own sake.
    //
    // From 3.4.0 there are no records here. The name is an option on a section
    // in /etc/config/bm_wanbind, and setting it is one `instance_set` call - so
    // a router with no daemon genuinely cannot do it, and saying so beats a
    // rename that appears to work and is gone at the next tick.
    const owrt = await router({ agent: null })

    const refusal = errorOf(await owrt.call('bindingUpdate', 'bind_1', { name: 'Renamed' }))

    expect(refusal).toContain('binding daemon')
    owrt.dispose()
  })

  it('keeps every read answering, whatever the router cannot do', async () => {
    const owrt = await router({ without: ['pppd', 'dnsmasq', 'fw4', 'nft', 'ip-full'] })

    // A table that refuses to render is strictly worse than an empty one that
    // says why - and the sentence saying why is itself one of these reads.
    expect(await owrt.call('deviceRows')).toEqual([])
    expect(await owrt.call('pppoePools')).toEqual([])
    expect(await owrt.call('pppoeLegacyRows')).toEqual([])
    expect((await owrt.call('installHint')) as { hint: string }).toHaveProperty('hint')
    owrt.dispose()
  })
})

describe('a rule that outranks everything this module writes', () => {
  it('warns on the binding check without refusing it', async () => {
    // With the daemon, so that the gate passes and the check gets as far as
    // looking at the router's other rules. Without it the only finding would be
    // the missing package, which is a different case tested above.
    const owrt = await router({
      agent: BINDING_AGENT_INFO,
      conflict: ['rule 100: from 192.168.9.0/24 lookup 42', 'total 4']
    })

    const result = await owrt.call('bindingCheck', {
      name: 'Office',
      lan: 'lan',
      carrier: 'eth1'
    })

    // A warning, first, because it is about the router rather than the values:
    // the plan below it may not be what actually happens.
    const [first] = report(result).findings
    expect(first.level).toBe('warning')
    expect(first.label).toContain('4 ip rule(s) outrank')
    expect(first.detail).toContain('100: from 192.168.9.0/24 lookup 42')
    expect(first.detail).toContain('and 3 more')
    owrt.dispose()
  })

  it('names mwan3 instead, when that is what is doing it', async () => {
    const owrt = await router({
      agent: BINDING_AGENT_INFO,
      conflict: ['mwan3conf', 'mwan3run', 'rule 1001: from all fwmark 0x100 lookup 1', 'total 1']
    })

    const result = await owrt.call('bindingCheck', {
      name: 'Office',
      lan: 'lan',
      carrier: 'eth1'
    })

    expect(text(result)).toContain('mwan3 is installed on this router and running')
    expect(text(result)).toContain('Run one or the other, not both')
    owrt.dispose()
  })

  it('says nothing at all on a router with neither', async () => {
    const owrt = await router()

    const result = await owrt.call('bindingCheck', {
      name: 'Office',
      lan: 'lan',
      carrier: 'eth1'
    })

    expect(text(result)).not.toContain('outrank')
    expect(text(result)).not.toContain('mwan3')
    owrt.dispose()
  })
})
