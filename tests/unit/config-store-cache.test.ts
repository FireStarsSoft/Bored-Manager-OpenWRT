import { describe, expect, it } from 'vitest'
import { moduleHarness, sharedModuleConfig, type SharedModuleConfig } from '../helpers/module-harness'
import { ConfigStore } from '../../openwrt/main/config'

/**
 * module-openwrt#8: the store re-read and re-validated its whole config
 * document on every call - once per rule number, per batch and per table poll.
 * It read it fresh for a reason (the document is shared by every connected
 * machine's instance of the module, so a stale copy could overwrite somebody
 * else's edit), which is what `onConfigChange` is for: keep the parsed
 * document until any instance writes.
 */

function counting(seed: unknown): { config: SharedModuleConfig; reads: () => number } {
  const inner = sharedModuleConfig(seed)
  let reads = 0
  return {
    reads: () => reads,
    config: {
      ...inner,
      get: () => {
        reads++
        return inner.get()
      }
    }
  }
}

describe('OpenWRT config store', () => {
  it('resolves the effective rules once per document', () => {
    const { config, reads } = counting({ version: 1, rules: { maxEvents: 123 }, ui: { showHints: true } })
    const harness = moduleHarness('openwrt', () => ({ stdout: '', stderr: '', code: 0 }), { config })
    const store = new ConfigStore(harness.ctx)

    expect(store.effectiveRules().maxEvents).toBe(123)
    // Defaults still fill in everything the document does not override.
    expect(store.effectiveRules().tableBase).toBe(10_000)
    store.effectiveRules()

    expect(reads()).toBe(1)
  })

  it('re-resolves them after another router instance changes them', () => {
    const { config, reads } = counting({ version: 1, rules: {}, ui: { showHints: true } })
    const harness = moduleHarness('openwrt', () => ({ stdout: '', stderr: '', code: 0 }), { config })
    const store = new ConfigStore(harness.ctx)
    expect(store.effectiveRules().maxEvents).toBe(200)

    config.set({ version: 1, rules: { maxEvents: 400 }, ui: { showHints: true } })

    expect(store.effectiveRules().maxEvents).toBe(400)
    expect(reads()).toBe(2)
    store.dispose()
  })

  it('reflects its own write without going back to the file', () => {
    const { config, reads } = counting({ version: 1, rules: {}, ui: { showHints: true } })
    const harness = moduleHarness('openwrt', () => ({ stdout: '', stderr: '', code: 0 }), { config })
    const store = new ConfigStore(harness.ctx)
    store.effectiveRules()

    store.setRules({ maxEvents: 300 })

    expect(store.effectiveRules().maxEvents).toBe(300)
    expect(reads()).toBe(1)
  })
})
