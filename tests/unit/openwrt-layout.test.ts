import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { BindingEngine } from '../../openwrt/main/binding'
import { ConfigStore, DEFAULT_RULES, type OwrtRules } from '../../openwrt/main/config'
import { Queries } from '../../openwrt/main/queries'
import {
  MANAGED_PREF_CEILING,
  recordLayout,
  type ManagedLayout
} from '../../openwrt/main/records'
import { buildFastSweepCommand } from '../../openwrt/main/service'
import { HostStore } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'
import { textField } from '../../openwrt/main/util'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * Where this module's objects live is a property of the records, not of the
 * config file.
 *
 * The lock in `RulesEditor` was the only thing standing between a running pool
 * and an edit to `catchAllPrefBase`, and a lock is not a guarantee: it opens
 * whenever the last record is deleted, it opens on a machine that has no
 * records of its own, and it never covered a config file edited by hand. The
 * six values are stamped onto every batch and every instance instead.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

/** The layout every record below was created under. */
const STAMPED: ManagedLayout = {
  tableBase: DEFAULT_RULES.tableBase,
  rulePrefBase: DEFAULT_RULES.rulePrefBase,
  catchAllPrefBase: DEFAULT_RULES.catchAllPrefBase,
  catchAllTable: DEFAULT_RULES.catchAllTable,
  zoneName: DEFAULT_RULES.zoneName
}

const MODEL: RouterModel = {
  t: 1_700_000_000_000,
  sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
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
    {
      name: 'pd00001',
      proto: 'pppoe',
      device: 'eth1',
      l3Device: 'pppoe-pd00001',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 3_000,
      ip4Table: 10_001,
      ipv4: { addr: '198.51.100.1', mask: 32 }
    }
  ],
  poolDev: { count: 1, rx: 0, tx: 0 },
  leases: [{ expires: 0, mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.20', host: 'desk' }],
  rules: [],
  rates: {}
}

/**
 * A router carrying one instance created under the default layout, and a
 * config that has since been edited to a different one.
 */
function fixture(edited: Partial<OwrtRules>): {
  engine: BindingEngine
  scripts: string[]
  model: RouterModel
} {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 1,
      nextSeq: 2,
      batches: [
        {
          id: 'b1',
          name: 'Home',
          prefix: 'pd',
          carrier: 'eth1',
          createdAt: 1,
          count: 1,
          seqFrom: 1,
          seqTo: 1,
          layout: { ...STAMPED }
        }
      ],
      instances: [
        {
          id: 'bind1',
          name: 'Office LAN',
          lan: 'lan',
          carrier: 'eth1',
          running: true,
          sticky: true,
          remap: true,
          createdAt: 1,
          slot: 0,
          layout: { ...STAMPED }
        }
      ],
      extraTables: [],
      stickyMap: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  const scripts: string[] = []
  harness.exec.mockImplementation(async (command, options) => {
    if (command === 'sh -s') scripts.push(options?.stdin ?? '')
    return ok()
  })
  const rules: OwrtRules = { ...DEFAULT_RULES, ...edited }
  const store = new HostStore(harness.ctx, () => rules)
  return {
    engine: new BindingEngine(harness.ctx, store, { rules: () => rules }),
    scripts,
    model: structuredClone(MODEL)
  }
}

describe('a rule change under a running router', () => {
  it('keeps writing an instance catch-all at the numbers it was created with', async () => {
    // The whole layout moved after this instance was installed: a different
    // safety-rule base and a different unreachable table. Read live, the next
    // reconcile would add a second catch-all at 25000 and leave the real one
    // at 29900 in place - two rules, and nothing that ever removes either.
    const run = fixture({ catchAllPrefBase: 25_000, catchAllTable: 25_500 })

    await run.engine.onSample(run.model)

    const written = run.scripts.join('\n')
    expect(written).toContain(`pref ${DEFAULT_RULES.catchAllPrefBase}`)
    expect(written).toContain(`lookup ${DEFAULT_RULES.catchAllTable}`)
    expect(written).not.toContain('pref 25000')
    expect(written).not.toContain('lookup 25500')
  })

  it('names a pool session from the table the dump reports, whatever the rules say', () => {
    // The table base rule was edited to 12000 after this pool member was
    // created against 10000. Its table arrives with the dump (`ip4Table`),
    // written and owned by bm-pppoe-pool, so the device table still names it
    // - there is no module-side naming convention left to go stale.
    const harness = moduleHarness('openwrt', () => ok(), {
      config: sharedModuleConfig({ version: 1, rules: { tableBase: 12_000 }, ui: {} })
    })
    const config = new ConfigStore(harness.ctx)
    const store = new HostStore(harness.ctx, () => config.effectiveRules())
    const model = structuredClone(MODEL)
    model.rules = [{ pref: DEFAULT_RULES.rulePrefBase, from: '192.168.1.20/32', table: 10_001 }]
    const queries = new Queries(() => model, () => ({}), config, store)

    expect(config.effectiveRules().tableBase).toBe(12_000)
    expect(queries.deviceRows()[0]).toMatchObject({ ip: '192.168.1.20', wan: 'pd00001' })
  })

  it('falls back to the live rules for a record written before this existed', () => {
    // Records from an earlier build carry no layout at all, and the rules in
    // force are the only answer available for them - which is what that build
    // used on every single use anyway.
    expect(recordLayout({}, DEFAULT_RULES)).toMatchObject({
      catchAllTable: DEFAULT_RULES.catchAllTable,
      zoneName: DEFAULT_RULES.zoneName
    })
    expect(recordLayout(undefined, DEFAULT_RULES).tableBase).toBe(DEFAULT_RULES.tableBase)
  })

  it('reads a stamped layout back off a stored record', () => {
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: {
        version: 1,
        nextSeq: 2,
        instances: [
          {
            id: 'bind1',
            name: 'Office LAN',
            lan: 'lan',
            carrier: 'eth1',
            running: false,
            sticky: true,
            remap: true,
            createdAt: 1,
            slot: 0,
            layout: {
              tableBase: 9_000,
              rulePrefBase: 19_000,
              catchAllPrefBase: 28_000,
              catchAllTable: 28_999,
              zoneName: 'oldpool',
              // Written by an earlier build; ignored on the way back in.
              zoneMode: 'networks'
            }
          }
        ],
        extraTables: [],
        stickyMap: [],
        events: [],
        moduleEvents: [],
        jobs: []
      }
    })
    const instance = new HostStore(harness.ctx, () => DEFAULT_RULES).read().instances[0]

    expect(recordLayout(instance, DEFAULT_RULES)).toEqual({
      tableBase: 9_000,
      rulePrefBase: 19_000,
      catchAllPrefBase: 28_000,
      catchAllTable: 28_999,
      zoneName: 'oldpool'
    })
  })
})

describe('constants that were declared twice', () => {
  /** Every .ts file under openwrt/main/, as [repo-relative path, source]. */
  function mainSources(): Array<[string, string]> {
    const root = new URL('../../openwrt/main/', import.meta.url)
    const out: Array<[string, string]> = []
    const walk = (dir: URL, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
        else if (entry.name.endsWith('.ts')) {
          out.push([`${prefix}${entry.name}`, readFileSync(new URL(entry.name, dir), 'utf8')])
        }
      }
    }
    walk(root, '')
    return out
  }

  it('declares the managed preference ceiling exactly once', () => {
    // `binding/rules` called it MANAGED_PREF_CEILING and `service/command`
    // called it RULE_FILTER_END: two plain numbers with the same value and
    // different names, where raising one and not the other makes the collector
    // hide rules the binding engine still believes it owns.
    // A duration that happens to be 30000 milliseconds is not this number;
    // anything else spelled 30_000 in the main half is.
    const declarations = mainSources()
      .filter(([, source]) =>
        [...source.matchAll(/const (\w+)\s*=\s*30_?000\b/g)].some(
          (match) => !match[1]!.endsWith('_MS')
        )
      )
      .map(([path]) => path)

    expect(declarations).toEqual(['records.ts'])
    expect(buildFastSweepCommand(DEFAULT_RULES, [], false)).toContain(
      `-v E=${MANAGED_PREF_CEILING}`
    )
  })

  it('declares the form-field reader exactly once', () => {
    // Three copies with two different bodies - `config.ts`, `binding/check.ts`
    // and `pppoe/parse.ts` - and one of the three did not trim what it made
    // out of a non-string, so "blank means leave this alone" meant something
    // slightly different on one of the three forms.
    const declarations = mainSources()
      .filter(([, source]) => /function (textField|text)\(\s*values/.test(source))
      .map(([path]) => path)

    expect(declarations).toEqual(['util.ts'])
    expect(textField({ name: '  Office  ' }, 'name')).toBe('Office')
    expect(textField({ vlan: 835 }, 'vlan')).toBe('835')
    expect(textField({}, 'missing')).toBe('')
    expect(textField({ name: null }, 'name')).toBe('')
  })
})

describe('a refusal a user can act on', () => {
  it('tells a disconnected user what to do about Refresh now', async () => {
    const harness = moduleHarness('openwrt', () => ok())
    Object.defineProperty(harness.ctx, 'connected', { value: false, configurable: true })
    const runtime = activate(harness.ctx)

    const result = (await harness.handlers.get('sweepNow')?.()) as {
      ok: boolean
      error?: string
    }

    expect(result.ok).toBe(false)
    // Every other refusal in the module ends with a next step; this one was
    // four words and a dead end.
    expect(result.error).toMatch(/connect this machine entry/)
    runtime.dispose?.()
  })
})
