import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { ConfigStore, DEFAULT_RULES } from '../../openwrt/main/config'
import { Queries } from '../../openwrt/main/queries'
import { MANAGED_PREF_CEILING } from '../../openwrt/main/records'
import { buildFastSweepCommand } from '../../openwrt/main/service'
import { HostStore, normalize, type BindingInstanceRecord } from '../../openwrt/main/store'
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
 * layout is stamped onto the record instead.
 *
 * From packages 2.4.0 nothing here writes a rule at those numbers: the daemon
 * owns every one of them and reads each section's own stamped priorities back
 * out of `/etc/config/bm_wanbind` on every pass, which `wanbind-config` in
 * `packages/ci/probes/` checks against the real daemon.
 * The stamp still matters on this side for exactly one reason, and it is why
 * the two cases below stay - `wanbind/handover.ts` reads `record.layout` to
 * tell the daemon which priorities the rules already standing were written at,
 * and a stamp that came back half-read would have it adopt one number and
 * allocate the other: two copies of every rule, and the first set left with no
 * owner.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

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

/** One instance record, with whatever the case under test wants stamped on it. */
function instanceRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bind1',
    name: 'Office LAN',
    lan: 'lan',
    carrier: 'eth1',
    running: false,
    sticky: true,
    remap: true,
    createdAt: 1,
    slot: 0,
    ...over
  }
}

/** That record after a round trip through the reader every caller goes via. */
function stored(record: Record<string, unknown>): BindingInstanceRecord {
  const data = normalize({
    version: 3,
    instances: [record],
    direct: [],
    extraTables: [],
    stickyMap: [],
    events: [],
    moduleEvents: [],
    jobs: []
  })
  return data.instances[0]!
}

describe('a rule change under a running router', () => {
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
    // No daemon in this fixture: the table falls back to what the rules say,
    // which is what it does on a router that has not answered yet.
    const queries = new Queries(() => model, () => ({}), config, store, {
      answered: () => false,
      deviceView: () => new Map(),
      heldKeys: () => new Set<string>(),
      instanceLans: () => new Map()
    })

    expect(config.effectiveRules().tableBase).toBe(12_000)
    expect(queries.deviceRows()[0]).toMatchObject({ ip: '192.168.1.20', wan: 'pd00001' })
  })

  it('carries no layout at all for a record written before this existed', () => {
    // Records from an earlier build have no stamp, and a half-written one is
    // treated exactly the same way: all five values or none. There is nothing
    // left on this side to fall back to - the handover simply sends no numbers
    // and lets the daemon allocate, which is the only honest answer once no
    // priority band is this module's to derive.
    expect(stored(instanceRecord()).layout).toBeUndefined()
    expect(
      stored(
        instanceRecord({
          layout: {
            tableBase: 9_000,
            rulePrefBase: 19_000,
            catchAllPrefBase: 28_000,
            catchAllTable: 28_999
          }
        })
      ).layout
    ).toBeUndefined()
  })

  it('reads a stamped layout back off a stored record', () => {
    // What the handover sends the daemon: the numbers the rules already on this
    // router were written at, whatever the settings say today. Read through the
    // store rather than off the document, because the store is what the
    // handover reads and it is where a value can be dropped in silence.
    const instance = stored(
      instanceRecord({
        layout: {
          tableBase: 9_000,
          rulePrefBase: 19_000,
          catchAllPrefBase: 28_000,
          catchAllTable: 28_999,
          zoneName: 'oldpool',
          // Written by an earlier build; ignored on the way back in.
          zoneMode: 'networks'
        }
      })
    )

    expect(instance.layout).toEqual({
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
