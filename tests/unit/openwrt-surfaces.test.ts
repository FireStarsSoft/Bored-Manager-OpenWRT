import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import { BindingEngine } from '../../openwrt/main/binding'
import { ConfigStore, DEFAULT_RULES } from '../../openwrt/main/config'
import { buildRow, type DirectState } from '../../openwrt/main/direct'
import { FastSweep } from '../../openwrt/main/service'
import { HostStore, type DirectBindingRecord } from '../../openwrt/main/store'
import type { OpenWrtOverview, OpenWrtSeriesPoint } from '../../openwrt/main/types'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import { isProbeCommand, routerProbeOutput } from '../helpers/router'

/**
 * What the four JSON specs promise, checked against what the module can
 * actually answer.
 *
 * A spec is data the renderer walks, so nothing about it fails at build time:
 * a state with no branch renders the whole page against null, a method nobody
 * registered is a button that reports nothing, and a table that polls every
 * row of a five-thousand-account batch does so silently. Each of those was a
 * real fault on these pages, and each one is one assertion here.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// ------------------------------------------------------------------ fixtures

const SPEC_DIRS = ['pages', 'widgets'] as const

type Spec = { file: string; spec: unknown }

function specs(): Spec[] {
  const out: Spec[] = []
  for (const kind of SPEC_DIRS) {
    const dir = new URL(`../../openwrt/ui/${kind}/`, import.meta.url)
    for (const name of readdirSync(dir)) {
      out.push({
        file: `${kind}/${name}`,
        spec: JSON.parse(readFileSync(new URL(name, dir), 'utf8'))
      })
    }
  }
  return out
}

function specNamed(file: string): unknown {
  return specs().find((entry) => entry.file === file)?.spec
}

const manifest = JSON.parse(
  readFileSync(new URL('../../openwrt/module.json', import.meta.url), 'utf8')
) as { methods: string[] }

/** Every object anywhere inside a spec, in no particular order. */
function nodes(value: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const pending: unknown[] = [value]
  while (pending.length) {
    const next = pending.pop()
    if (typeof next !== 'object' || next === null) continue
    if (!Array.isArray(next)) out.push(next as Record<string, unknown>)
    for (const child of Array.isArray(next) ? next : Object.values(next)) pending.push(child)
  }
  return out
}

/** Every method name a spec would call: sources, actions and both check-form halves. */
function methodsIn(spec: unknown): Set<string> {
  const out = new Set<string>()
  for (const node of nodes(spec)) {
    for (const key of ['method', 'checkMethod', 'applyMethod', 'startMethod', 'stopMethod']) {
      const value = node[key]
      if (typeof value === 'string') out.add(value)
    }
  }
  return out
}

/** The `capabilities.state` values a spec has a branch for. */
function branchedStates(spec: unknown): Set<string> {
  const out = new Set<string>()
  for (const node of nodes(spec)) {
    const when = node['when']
    if (typeof when !== 'object' || when === null) continue
    const clause = when as Record<string, unknown>
    const source = clause['source'] as Record<string, unknown> | undefined
    if (
      source?.['kind'] === 'stream' &&
      source['event'] === 'capabilities' &&
      source['path'] === 'state' &&
      typeof clause['value'] === 'string'
    ) {
      out.add(clause['value'])
    }
  }
  return out
}

/** Every `{ event, path }` a spec reads off one of the module's own streams. */
function streamPaths(spec: unknown): Set<string> {
  const out = new Set<string>()
  for (const node of nodes(spec)) {
    if (node['kind'] === 'stream' && typeof node['event'] === 'string') {
      out.add(`${node['event']}.${String(node['path'] ?? '')}`)
    }
  }
  return out
}

/** Every row/column key a spec renders out of one stream path. */
function keysUnder(spec: unknown, event: string, path: string): Set<string> {
  const out = new Set<string>()
  for (const node of nodes(spec)) {
    const source = node['source'] as Record<string, unknown> | undefined
    if (source?.['kind'] !== 'stream' || source['event'] !== event || source['path'] !== path) {
      continue
    }
    for (const entry of [
      ...((node['rows'] as unknown[]) ?? []),
      ...((node['columns'] as unknown[]) ?? [])
    ]) {
      const key = (entry as Record<string, unknown>)?.['key']
      if (typeof key === 'string') out.add(key)
    }
  }
  return out
}

// -------------------------------------------------------- what a page draws

describe('the readiness states a page can be shown in', () => {
  // `checking` is the window between "connected over SSH" and "the probe
  // answered". It had no branch anywhere, so a router nobody had probed yet
  // fell through to the ready layout and drew every tile against null - and
  // stayed there, because nothing about an unprobed router resolves on its own.
  const REQUIRED = ['blocked', 'connecting', 'checking', 'attention']

  for (const file of ['pages/dashboard.json', 'pages/connection.json', 'widgets/summary.json']) {
    it(`has its own branch on ${file}`, () => {
      const states = branchedStates(specNamed(file))
      expect([...REQUIRED].filter((state) => !states.has(state))).toEqual([])
    })
  }
})

describe('the collector health a page shows', () => {
  // A failed interface dump latches: the module keeps the last list it could
  // parse and retries every few ticks. Only `fastOk` was ever rendered, so the
  // interface table and the WAN counts froze with no banner at all, and the
  // Connection page - which is where the consequences show - read no health.
  for (const file of ['pages/dashboard.json', 'pages/connection.json']) {
    it(`reads fastOk, dumpOk and the reason on ${file}`, () => {
      const spec = specNamed(file)
      const paths = streamPaths(spec)
      expect(paths.has('overview.health.fastOk')).toBe(true)
      expect(paths.has('overview.health.dumpOk')).toBe(true)
      expect(keysUnder(spec, 'overview', 'health').has('lastError')).toBe(true)
    })
  }
})

describe('the two binding counters', () => {
  it('are charted on the dashboard from the module history', () => {
    const charted = new Set<string>()
    for (const node of nodes(specNamed('pages/dashboard.json'))) {
      if (node['kind'] !== 'history') continue
      for (const key of (node['keys'] as string[]) ?? []) charted.add(key)
    }
    expect(charted.has('bound')).toBe(true)
    expect(charted.has('waiting')).toBe(true)
  })
})

describe('every method a spec names', () => {
  it('is declared in the manifest and registered by the module', () => {
    const harness = moduleHarness('openwrt', () => ok(), { config: sharedModuleConfig(null) })
    const runtime = activate(harness.ctx)

    const declared = new Set(manifest.methods)
    const missing: string[] = []
    for (const entry of specs()) {
      for (const method of methodsIn(entry.spec)) {
        if (!declared.has(method)) missing.push(`${entry.file}: "${method}" is not in manifest.methods`)
        else if (!harness.handlers.has(method)) {
          missing.push(`${entry.file}: "${method}" has no handler`)
        }
      }
    }
    expect(missing).toEqual([])

    runtime.dispose?.()
  })
})

describe('the router shell the copy keeps pointing at', () => {
  it('is offered as a terminal rather than only described', () => {
    const terminals = specs().flatMap((entry) =>
      nodes(entry.spec)
        .filter((node) => node['type'] === 'terminal')
        .map((node) => ({ file: entry.file, command: node['commandTemplate'] }))
    )
    // Two places tell the user to go to a shell and mean it: the packages that
    // cannot be installed from here, and the router-wide sysctls a large
    // binding pool needs. Both now open one.
    expect(terminals.map((entry) => entry.file).sort()).toEqual([
      'pages/connection.json',
      'pages/settings.json'
    ])
    for (const entry of terminals) expect(entry.command).toBe('sh')
  })
})

describe('the drawers that used to poll every row', () => {
  /** The `invoke` sources inside one subnav item, by the args they send. */
  function tabArgs(spec: unknown, method: string): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {}
    for (const node of nodes(spec)) {
      if (node['type'] !== 'subnav') continue
      for (const item of (node['items'] as Array<Record<string, unknown>>) ?? []) {
        for (const inner of nodes(item['blocks'])) {
          if (inner['kind'] === 'invoke' && inner['method'] === method) {
            out[String(item['id'])] = (inner['args'] as unknown[]) ?? []
          }
        }
      }
    }
    return out
  }

  /** The tab a drawer opens on, found by the item ids rather than by nesting. */
  function initialOf(spec: unknown, method: string): string {
    for (const node of nodes(spec)) {
      if (node['type'] !== 'subnav') continue
      const items = (node['items'] as Array<Record<string, unknown>>) ?? []
      if (!items.some((item) => item['id'] === 'attention')) continue
      if (nodes(items).some((inner) => inner['method'] === method)) {
        return String(node['initial'] ?? '')
      }
    }
    return ''
  }

  // The binding drawer sat on a plain `invoke`, so opening one instance
  // pushed every assignment on every interval for as long as the drawer
  // stayed open. A subnav only polls the tab that is showing, and the tab
  // that shows first asks for the short list.
  it('opens bindingRows on the narrow tab', () => {
    const spec = specNamed('pages/connection.json')
    expect(initialOf(spec, 'bindingRows')).toBe('attention')
    const args = tabArgs(spec, 'bindingRows')
    expect(args['attention']).toEqual(['$row.id', 'attention'])
    expect(args['all']).toEqual(['$row.id'])
  })

  it('scopes pppoeRows to the open pool', () => {
    // A pool holds at most 500 members and the daemon caps the reply the same
    // way, so the interfaces table is deliberately always-complete: a member
    // whose section is missing must be a visible row, not a filtered one.
    const spec = specNamed('pages/connection.json')
    const scoped = nodes(spec).some((node) => {
      const source = node['source'] as Record<string, unknown> | undefined
      return (
        source?.['method'] === 'pppoeRows' &&
        Array.isArray(source['args']) &&
        source['args'][0] === '$row.id'
      )
    })
    expect(scoped).toBe(true)
  })
})

describe('the Cancel button on a job card', () => {
  it('is only ever offered on jobs that are still running', () => {
    const offered: string[] = []
    for (const entry of specs()) {
      for (const node of nodes(entry.spec)) {
        const actions = [
          ...((node['rowActions'] as unknown[]) ?? []),
          ...((node['bulkActions'] as unknown[]) ?? [])
        ]
        if (!actions.some((action) => (action as Record<string, unknown>)['method'] === 'jobCancel')) {
          continue
        }
        const source = node['source'] as Record<string, unknown> | undefined
        offered.push(`${entry.file}: ${String(source?.['path'])}`)
      }
    }
    // `jobs.jobs` is running and finished together, so the settings page put a
    // red Cancel on cards that had finished hours earlier.
    expect(offered.every((where) => where.endsWith(': running'))).toBe(true)
    expect(offered.length).toBeGreaterThan(0)
  })
})

describe('the PPPoE stat row', () => {
  it('shows every state a member can be in, so the counts add up to Interfaces', () => {
    const shown = new Set<string>()
    for (const node of nodes(specNamed('pages/connection.json'))) {
      if (node['type'] !== 'stat') continue
      const source = node['source'] as Record<string, unknown> | undefined
      if (source?.['event'] === 'pppoe') shown.add(String(source['path']))
    }
    // Disabling a member moved it out of every tile on the page, so the
    // states stopped adding up and nothing said where the difference went.
    for (const key of ['interfaces', 'up', 'dialing', 'down', 'error', 'stopped', 'unwritten']) {
      expect(shown.has(key)).toBe(true)
    }
  })
})

describe('the create form table base', () => {
  it('opens on the base this module is configured to offer', () => {
    const froms: Array<Record<string, unknown> | undefined> = []
    for (const node of nodes(specNamed('pages/connection.json'))) {
      // `input` is what makes it a form field rather than a table column
      // carrying the same key.
      if (node['key'] !== 'table_base' || node['input'] == null) continue
      if (node['initialFromScope'] != null) continue
      froms.push(node['initialFrom'] as Record<string, unknown>)
    }
    // Both create tabs offer it; a hardcoded number would mean the tableBase
    // rule on the settings page never reached the form.
    expect(froms.length).toBeGreaterThan(0)
    for (const from of froms) {
      expect(from).toMatchObject({ kind: 'invoke', method: 'rulesEffective', path: 'tableBase' })
    }
  })
})

// ----------------------------------------------------------- what a handler answers

const ROUTER_TOOLS = [
  '/sbin/ubus',
  '/sbin/uci',
  '/sbin/ip',
  '/sbin/fw4',
  '/sbin/logread',
  '/usr/sbin/nft',
  '/sbin/netifd',
  '/usr/sbin/pppd',
  '/usr/sbin/dnsmasq'
]

function probeOutput(): string {
  return [
    '===REL===',
    "DISTRIB_ID='OpenWrt'",
    "DISTRIB_RELEASE='25.12.0'",
    '===BOARD===',
    JSON.stringify({
      model: 'Test Router',
      release: { distribution: 'OpenWrt', version: '25.12.0' }
    }),
    '===TOOLS===',
    ...ROUTER_TOOLS,
    '===PPP===',
    'plugin',
    'kmod',
    '===PKG===',
    'apkdb',
    '===DONE==='
  ].join('\n')
}

interface SweepShape {
  dump?: string | null
  leases?: string
}

function sweepOutput(shape: SweepShape = {}): string {
  const { dump = null, leases = '' } = shape
  return [
    '===SYS===',
    JSON.stringify({ uptime: 4_000, load: [0, 0, 0], memory: { total: 1_000, free: 400 } }),
    '===DEV===',
    '===POOL=== 0 0 0',
    '===LEASES===',
    leases,
    '===RULES===',
    '===RULESOK===',
    '1',
    ...(dump === null ? [] : ['===DUMP===', dump])
  ].join('\n')
}

const BATCH = {
  id: 'b1',
  name: 'Pool',
  prefix: 'pd',
  carrier: 'eth1',
  createdAt: 1,
  count: 2,
  seqFrom: 1,
  seqTo: 2
}

function instance(id: string, name: string, lan: string, slot: number): unknown {
  return {
    id,
    name,
    lan,
    carrier: 'eth1',
    running: true,
    sticky: true,
    remap: true,
    createdAt: 1,
    slot
  }
}

function lanIface(name: string, third: number): unknown {
  return {
    interface: name,
    up: true,
    pending: false,
    proto: 'static',
    device: `br-${name}`,
    'ipv4-address': [{ address: `192.168.${third}.1`, mask: 24 }]
  }
}

/** A live router with two LANs, four leases and not one WAN to hand out. */
function waitingHarness(): ReturnType<typeof moduleHarness> {
  const dump = JSON.stringify({ interface: [lanIface('lan', 1), lanIface('lan2', 2)] })
  const leases = [
    '0 aa:bb:cc:dd:ee:01 192.168.1.20 desk *',
    '0 aa:bb:cc:dd:ee:02 192.168.1.21 phone *',
    '0 aa:bb:cc:dd:ee:03 192.168.2.20 till *',
    '0 aa:bb:cc:dd:ee:04 192.168.2.21 kiosk *'
  ].join('\n')
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 1,
      nextSeq: 3,
      batches: [BATCH],
      instances: [instance('bind1', 'Front of house', 'lan', 0), instance('bind2', 'Back office', 'lan2', 1)],
      extraTables: [],
      stickyMap: [],
      events: [],
      moduleEvents: [],
      jobs: []
    },
    config: sharedModuleConfig(null)
  })
  harness.exec.mockImplementation(async (command) => {
    if (command.includes("echo '===REL==='")) return ok(probeOutput())
    if (command.includes("echo '===SYS==='")) return ok(sweepOutput({ dump, leases }))
    return ok()
  })
  return harness
}

// The member rows themselves come from the pool daemon now - the scope
// narrowing and the always-visible `unwritten` row are proved against its
// contract in openwrt-hot-path.test.ts and openwrt-pppoe-guards.test.ts.

describe('the assignments a binding drawer asks for', () => {
  it('narrows to the devices whose WAN stopped working', async () => {
    const wan = (up: boolean): unknown => ({
      interface: 'pd00001',
      up,
      pending: false,
      proto: 'pppoe',
      device: 'eth1',
      l3_device: 'pppoe-pd00001',
      ip4table: 10_001,
      uptime: 3_000,
      'ipv4-address': [{ address: '198.51.100.1', mask: 32 }]
    })
    let healthy = true
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: {
        version: 1,
        nextSeq: 3,
        batches: [BATCH],
        instances: [instance('bind1', 'Front of house', 'lan', 0)],
        extraTables: [],
        stickyMap: [],
        events: [],
        moduleEvents: [],
        jobs: []
      },
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command) => {
      if (command.includes("echo '===REL==='")) return ok(probeOutput())
      if (command.includes("echo '===SYS==='")) {
        const sections = sweepOutput({
          dump: JSON.stringify({ interface: [lanIface('lan', 1), wan(healthy)] }),
          leases: '0 aa:bb:cc:dd:ee:01 192.168.1.20 desk *'
        })
        // Once the rule is on the router the reconcile recognises its own
        // assignment and keeps it, which is what leaves a bound device sitting
        // on a WAN that has since failed.
        return ok(
          healthy
            ? sections
            : sections.replace(
                '===RULES===',
                '===RULES===\n20000:\tfrom 192.168.1.20/32 lookup 10001'
              )
        )
      }
      return ok()
    })
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
    await settle()

    const rows = (scope?: string): Array<{ host: string; wanStatus: string }> =>
      harness.handlers.get('bindingRows')?.('bind1', scope) as Array<{
        host: string
        wanStatus: string
      }>

    expect(rows().map((row) => row.wanStatus)).toEqual(['bound'])
    expect(rows('attention')).toEqual([])

    healthy = false
    expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
    await settle()

    expect(rows().map((row) => row.wanStatus)).toEqual(['error'])
    expect(rows('attention').map((row) => row.host)).toEqual(['desk'])

    runtime.dispose?.()
  })
})

describe('a device no binding instance manages', () => {
  it('is refused by name, with the thing to do next', async () => {
    const harness = moduleHarness(
      'openwrt',
      (command) => (isProbeCommand(command) ? ok(routerProbeOutput()) : ok()),
      { config: sharedModuleConfig(null) }
    )
    const runtime = activate(harness.ctx)
    // All three write an ip rule, so the requirements gate wants the router read
    // first. It is read here, and passes - which is what leaves the refusal below
    // free to be about the device rather than about the router.
    runtime.applyPollers?.()
    await settle()

    // The dashboard offers these buttons on every DHCP lease it can see, and an
    // unmanaged device carries an empty instance id. The engine answered "no
    // valid device was selected", which names nothing and suggests nothing.
    for (const method of ['bindingUnassign', 'bindingReassign', 'bindingPin']) {
      const result = (await harness.handlers
        .get(method)
        ?.('', 'aa:bb:cc:dd:ee:01', 'pd00001')) as OkResult
      expect(result.ok).toBe(false)
      expect(result.error).toContain('No WAN Binding instance manages this device')
      expect(result.error).toContain('under WAN Binding')
    }

    runtime.dispose?.()
  })
})

describe('the waiting queue on the dashboard', () => {
  it('answers for every instance at once, and says which one each device is in', async () => {
    const harness = waitingHarness()
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
    await settle()

    const rows = harness.handlers.get('bindingWaitingRows')?.('') as Array<{
      instance: string
      host: string
      reason: string
    }>

    // Why a device is waiting was computed on every pass and readable only by
    // opening the right instance's drawer on the Connection page.
    expect(rows.map((row) => row.host).sort()).toEqual(['desk', 'kiosk', 'phone', 'till'])
    expect(new Set(rows.map((row) => row.instance))).toEqual(
      new Set(['Front of house', 'Back office'])
    )
    for (const row of rows) expect(row.reason).toBe('waiting for a free WAN')

    // One instance at a time still answers for that instance alone.
    const one = harness.handlers.get('bindingWaitingRows')?.('bind2') as Array<{ host: string }>
    expect(one.map((row) => row.host).sort()).toEqual(['kiosk', 'till'])

    runtime.dispose?.()
  })
})

describe('why an install is not offered', () => {
  it('answers with the one condition that applies, not a list of three', () => {
    const harness = moduleHarness('openwrt', () => ok(), { config: sharedModuleConfig(null) })
    const runtime = activate(harness.ctx)

    // Nothing has been read off this router, which is one of the three reasons
    // the settings page used to recite together and leave the user to sort out.
    const answer = harness.handlers.get('installHint')?.() as { hint: string }
    expect(answer.hint).toBe(
      'Open Module settings and run Check again first, so this page can see what the router actually has.'
    )

    runtime.dispose?.()
  })
})

describe('the interfaces the dashboard table cannot list', () => {
  it('counts them instead of stopping mid-list in silence', async () => {
    // Two cuts happen to this list and neither used to be visible anywhere: a
    // flat cap on how many rows are pushed, and a byte budget that pops more
    // off after it. A router with a large pool drew a table of sixty-odd
    // interfaces that read as the whole router.
    const many = Array.from({ length: 90 }, (_, index) => ({
      interface: `lan${String(index).padStart(3, '0')}`,
      up: true,
      pending: false,
      proto: 'static',
      device: `br-lan${index}`,
      'ipv4-address': [{ address: `10.${index}.0.1`, mask: 24 }]
    }))
    const harness = moduleHarness(
      'openwrt',
      () => ok(sweepOutput({ dump: JSON.stringify({ interface: many }) })),
      { config: sharedModuleConfig(null) }
    )
    const config = new ConfigStore(harness.ctx)
    const store = new HostStore(harness.ctx, () => config.effectiveRules())
    const sweep = new FastSweep(harness.ctx, config, store, {})

    await sweep.run()

    const overview = harness.emit.mock.calls
      .filter((call) => call[0] === 'overview')
      .map((call) => call[1] as OpenWrtOverview)
      .at(-1)
    expect(overview?.counts.ifTotal).toBe(90)
    expect(overview?.ifaces.length).toBeLessThan(90)
    expect(overview?.counts.ifOmitted).toBe(90 - (overview?.ifaces.length ?? 0))
    expect(overview?.counts.ifOmitted).toBeGreaterThan(0)

    sweep.dispose()
  })

  it('renders the two counts beside the table that does the cutting', () => {
    const keys = keysUnder(specNamed('pages/dashboard.json'), 'overview', 'counts')
    // `ifTotal` was published and drawn nowhere, so the number the table is a
    // fraction of never reached a screen either.
    expect(keys.has('ifTotal')).toBe(true)
    expect(keys.has('ifOmitted')).toBe(true)
  })
})

describe('the columns the two binding tables name', () => {
  /** One one-to-one row, built by the only builder either side of the module uses. */
  function directRow(): Record<string, unknown> {
    const record: DirectBindingRecord = {
      id: 'dir_000001',
      name: 'Till at the front counter',
      target: { kind: 'ip', ip: '192.168.1.50' },
      wan: 'wan',
      enabled: true,
      whenDown: 'hold',
      pref: DEFAULT_RULES.directPrefBase,
      table: 42,
      lan: 'lan',
      slot: 0,
      createdAt: 1
    }
    const entry = {
      id: record.id,
      ip: '192.168.1.50',
      missingSince: 0,
      state: 'bound' as const,
      since: 1
    }
    return buildRow(record, entry, 2, DEFAULT_RULES.catchAllTable) as unknown as Record<
      string,
      unknown
    >
  }

  /** One instance row, from a store holding one instance and nothing else. */
  function instanceRow(): Record<string, unknown> {
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: {
        version: 3,
        instances: [instance('bind1', 'Front of house', 'lan', 0)],
        direct: [],
        extraTables: [],
        stickyMap: [],
        events: [],
        moduleEvents: [],
        jobs: []
      },
      config: sharedModuleConfig(null)
    })
    const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
    const binding = new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES })
    const row = binding.list()[0] as unknown as Record<string, unknown>
    binding.dispose()
    return row
  }

  // A column naming a key the row does not carry renders an empty cell and
  // nothing anywhere says why - which is how the When down column printed a
  // raw `hold` for months and how the scope of a range instance reached no
  // surface at all. Both directions are covered: the spec may not name a key
  // the row has stopped publishing, and this fails on the day it does.
  /** The column keys of every table drawn from one source, however it is fed. */
  function columnKeys(match: (source: Record<string, unknown>) => boolean): string[] {
    const out = new Set<string>()
    for (const node of nodes(specNamed('pages/connection.json'))) {
      if (node['type'] !== 'table') continue
      const source = node['source'] as Record<string, unknown> | undefined
      if (!source || !match(source)) continue
      for (const column of (node['columns'] as Array<Record<string, unknown>>) ?? []) {
        if (typeof column['key'] === 'string') out.add(column['key'])
      }
    }
    return [...out]
  }

  it('are keys the one-to-one row actually publishes', () => {
    const row = directRow()
    const named = columnKeys((source) => source['method'] === 'directRows')
    expect(named.filter((key) => !(key in row))).toEqual([])
    expect(named.length).toBeGreaterThan(0)
  })

  it('are keys the instance row actually publishes', () => {
    const row = instanceRow()
    const named = columnKeys(
      (source) => source['event'] === 'binding' && source['path'] === 'rows'
    )
    expect(named.filter((key) => !(key in row))).toEqual([])
    expect(named.length).toBeGreaterThan(0)
  })

  it('opens the When that WAN is down select on the stored value, not on its label', () => {
    // The row's edit form is initialised from a key on the row. Pointing it at
    // the human wording would leave the select matching none of its own
    // options, so it would open blank and a Save would rewrite the choice the
    // user never touched. The column renders the wording under another key.
    const row = directRow()
    const selects = nodes(specNamed('pages/connection.json')).filter(
      (node) => node['key'] === 'whenDown' && node['input'] === 'select'
    )
    const opened = selects.filter((node) => typeof node['initialFromScope'] === 'string')
    expect(opened.length).toBeGreaterThan(0)
    for (const node of opened) {
      const values = ((node['options'] as Array<Record<string, unknown>>) ?? []).map(
        (option) => option['value']
      )
      expect(values).toContain(row[String(node['initialFromScope'])])
    }
  })
})

describe('the two stranded rows on the one-to-one table', () => {
  /**
   * One one-to-one binding in a given state, with `When that WAN is down` set
   * either way and everything else held identical - which is the whole point:
   * these two rows differ by one stored word and by nothing else a person can
   * see, so whatever the State column says about them has to carry it.
   */
  function stateRow(state: DirectState, whenDown: 'hold' | 'fallback'): ReturnType<typeof buildRow> {
    const record: DirectBindingRecord = {
      id: 'dir_000001',
      name: 'Till at the front counter',
      target: { kind: 'ip', ip: '192.168.1.50' },
      wan: 'wan',
      enabled: true,
      whenDown,
      pref: DEFAULT_RULES.directPrefBase,
      table: 42,
      lan: 'lan',
      slot: 0,
      createdAt: 1
    }
    return buildRow(
      record,
      {
        id: record.id,
        ip: '192.168.1.50',
        missingSince: 0,
        state,
        since: 1
      },
      2,
      DEFAULT_RULES.catchAllTable
    )
  }

  /** The State column as it is actually read: a row of words, left to right. */
  const chips = (row: ReturnType<typeof buildRow>): string[] =>
    row.stateBadges.map((badge) => badge.label)

  it('do not look alike, because they are opposites', () => {
    // Parked, the device is off the internet. Fallen back, it is on the
    // internet through the router's ordinary WAN - which for a device pinned
    // to a metered or whitelisted line is exactly what its owner was paying to
    // prevent. The row used to print the same two red chips for both.
    expect(chips(stateRow('stranded', 'hold'))).not.toEqual(
      chips(stateRow('stranded', 'fallback'))
    )
  })

  it('say `no way out` for the parked one, in the words the held row uses', () => {
    expect(chips(stateRow('stranded', 'hold'))).toEqual(['moved off its LAN', 'no way out'])
    expect(chips(stateRow('held', 'hold'))).toContain('no way out')
  })

  it('say `on the main table` for the other, in the words the fallback row uses', () => {
    expect(chips(stateRow('stranded', 'fallback'))).toEqual([
      'moved off its LAN',
      'on the main table'
    ])
    expect(chips(stateRow('fallback', 'fallback'))).toContain('on the main table')
    // The chip that would be read as "this device is offline" must not be on
    // the row of a device that is very much online.
    expect(chips(stateRow('stranded', 'fallback'))).not.toContain('no way out')
  })

  it('name the table their own Table cell names, so the two cells cannot drift', () => {
    const parked = stateRow('stranded', 'hold')
    expect(parked.rule).toContain(`lookup ${DEFAULT_RULES.catchAllTable}`)
    expect(chips(parked)).toContain('no way out')

    const fellBack = stateRow('stranded', 'fallback')
    expect(fellBack.rule).toContain('lookup main')
    expect(chips(fellBack)).toContain('on the main table')
  })
})

describe('bound and waiting over time', () => {
  it('reach the series point and the history the charts read back', async () => {
    const harness = moduleHarness('openwrt', () => ok(sweepOutput({ dump: '[]' })), {
      config: sharedModuleConfig(null)
    })
    const points: unknown[] = []
    ;(harness.ctx as unknown as { addHistory: (value: unknown) => void }).addHistory = (
      value: unknown
    ): void => {
      points.push(value)
    }
    const config = new ConfigStore(harness.ctx)
    const store = new HostStore(harness.ctx, () => config.effectiveRules())
    const sweep = new FastSweep(harness.ctx, config, store, {
      bindingTotals: () => ({ bound: 7, waiting: 3, wanFree: 2, wanErrBound: 1 })
    })

    await sweep.run()
    await sweep.runSlow()

    const series = harness.emit.mock.calls
      .filter((call) => call[0] === 'series')
      .map((call) => call[1] as OpenWrtSeriesPoint)
    expect(series.at(-1)).toMatchObject({ bound: 7, waiting: 3 })
    expect(points.at(-1)).toMatchObject({ bound: 7, waiting: 3 })

    sweep.dispose()
  })
})
