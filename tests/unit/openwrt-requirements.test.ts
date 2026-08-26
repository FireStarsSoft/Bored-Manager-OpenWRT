import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import { FEATURES } from '../../openwrt/main/requirements'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import { isProbeCommand, routerProbeOutput, type RouterProbeOptions } from '../helpers/router'

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

const BATCH = {
  id: 'b1',
  name: 'Home',
  prefix: 'pd',
  seqFrom: 1,
  seqTo: 2,
  count: 2,
  carrier: 'eth1',
  createdAt: 1
}

function hostData(): unknown {
  return {
    version: 1,
    nextSeq: 3,
    batches: [BATCH],
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
    expect(FEATURES.pppoeBatchApply?.requires.length).toBeGreaterThan(0)
  })
})

describe('what the gate stops', () => {
  it('refuses bindingStart with a sentence rather than a shell error', async () => {
    // The instance was created on a router that had ip-full and has since lost
    // it. Nothing asked again: the start ran, the reconcile called `ip rule`,
    // and the user got whatever BusyBox prints when a subcommand does not exist.
    const owrt = await router({ without: ['ip-full'] })

    const result = await owrt.call('bindingStart', 'bind_1')

    expect((result as OkResult).ok).toBe(false)
    expect(errorOf(result)).toContain('steer traffic by routing table')
    expect(errorOf(result)).toContain('Install missing packages')
    owrt.dispose()
  })

  it('refuses an apply whose capability disappeared after the check passed', async () => {
    // The gap the registry was written for. A token is issued by a check, and
    // the apply that spends it used to trust the token alone.
    const owrt = await router()
    const checked = report(
      await owrt.call('pppoeBatchCheck', {
        name: 'Home',
        carrier: 'eth1',
        count: 2,
        user: 'a@isp',
        pass: 'x'
      })
    )

    await owrt.reprobe({ without: ['pppd'] })
    const applied = await owrt.call('pppoeBatchApply', {
      token: checked.token,
      values: { name: 'Home', carrier: 'eth1', count: 2, user: 'a@isp', pass: 'x' }
    })

    expect((applied as OkResult).ok).toBe(false)
    expect(errorOf(applied)).toContain('PPPoE support is missing on this router')
    owrt.dispose()
  })

  it('refuses on a service that stopped, naming the service and not a package', async () => {
    const owrt = await router({ service: ['pidof', 'netifd', 'nftok', 'fw4'] })

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
  it('never traps a user with a pool or an instance they cannot remove', async () => {
    // A router that has lost everything. Stop and delete are the way out of
    // that, so refusing them would leave the user with records they can see,
    // cannot act on, and cannot get rid of.
    const owrt = await router({ without: ['pppd', 'dnsmasq', 'fw4', 'nft', 'ip-full'] })

    for (const [method, args] of [
      ['bindingStop', ['bind_1']],
      ['bindingDelete', ['bind_1']],
      ['pppoeBatchDelete', ['b1']]
    ] as Array<[string, unknown[]]>) {
      const result = (await owrt.call(method, ...args)) as OkResult
      expect(errorOf(result)).not.toContain('missing on this router')
      expect(errorOf(result)).not.toContain('has not been checked yet')
    }
    owrt.dispose()
  })

  it('leaves the install flow and the re-check path open on a hopeless router', async () => {
    const owrt = await router({ without: ['pppd', 'dnsmasq', 'fw4', 'nft', 'ip-full'] })

    // Gating the installer on the packages it exists to install is a loop with
    // no way out, and `sweepNow` is the only way out of a stale verdict.
    const setup = report(await owrt.call('setupCheck', { pppoe: true }))
    expect(text(setup)).not.toContain('missing on this router')
    expect((await owrt.call('sweepNow')) as OkResult).toMatchObject({ ok: true })
    // Renaming an instance touches nothing on the router at all.
    expect(errorOf(await owrt.call('bindingUpdate', 'bind_1', { name: 'Renamed' }))).toBe('')
    owrt.dispose()
  })

  it('keeps every read answering, whatever the router cannot do', async () => {
    const owrt = await router({ without: ['pppd', 'dnsmasq', 'fw4', 'nft', 'ip-full'] })

    // A table that refuses to render is strictly worse than an empty one that
    // says why - and the sentence saying why is itself one of these reads.
    expect(await owrt.call('deviceRows')).toEqual([])
    expect(await owrt.call('pppoeBatches')).toHaveLength(1)
    expect((await owrt.call('installHint')) as { hint: string }).toHaveProperty('hint')
    owrt.dispose()
  })
})

describe('a rule that outranks everything this module writes', () => {
  it('warns on the binding check without refusing it', async () => {
    const owrt = await router({
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
