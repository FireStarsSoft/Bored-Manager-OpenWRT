import { describe, expect, it, vi } from 'vitest'
import type { ModuleContext } from '@shared/modules'
import { HostStore, type BindingInstanceRecord } from '../../openwrt/main/store'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { moduleHarness } from '../helpers/module-harness'

/**
 * The 512 KB host-data cap is enforced by the app, and the module decides how
 * much to keep by estimating the size of what it is about to write. Those two
 * have to be measuring the same document: the estimate used the compact form
 * while the raw object went to disk, so with a few thousand sticky WAN
 * assignments every flush was refused, `dirty` stayed set, and every batch or
 * binding created afterwards existed only in memory until the next restart
 * threw it away.
 */

const CAP_BYTES = 512 * 1024

/** A ctx whose host-data store enforces the cap the same way the app does. */
function storeHarness(): {
  store: HostStore
  written: () => unknown
  logs: string[]
} {
  const harness = moduleHarness('openwrt', () => ({ stdout: '', stderr: '', code: 0 }))
  let saved: unknown = null
  const logs: string[] = []
  const ctx = harness.ctx as ModuleContext & {
    hostDataGet: () => unknown
    hostDataSet: (value: unknown) => void
    log: (message: string) => void
  }
  ctx.hostDataSet = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2)).length
    if (bytes > CAP_BYTES) throw new Error(`payload is ${bytes} bytes, over the 512 KB limit`)
    saved = value
  }
  ctx.hostDataGet = () => saved
  ctx.log = (message: string) => logs.push(message)
  return { store: new HostStore(ctx, () => DEFAULT_RULES), written: () => saved, logs }
}

/** The one binding instance the sticky entries below belong to. */
function instance(): BindingInstanceRecord {
  return {
    id: 'bind1',
    name: 'binding',
    lan: 'lan',
    carrier: 'pd',
    running: true,
    sticky: true,
    remap: false,
    createdAt: 1,
    slot: 1
  }
}

function mac(index: number): string {
  const hex = index.toString(16).padStart(8, '0')
  return `aa:bb:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}`
}

describe('openwrt host data', () => {
  it('writes the same shape it measured, so a full sticky map still fits', () => {
    const { store, written, logs } = storeHarness()

    store.update((data) => {
      data.instances.push(instance())
      for (let i = 0; i < 6_000; i++) {
        data.stickyMap.push(['bind1', mac(i), `pd${i}`, 1_700_000_000 + i])
      }
    })
    store.flush()

    expect(logs.filter((line) => line.includes('could not be saved'))).toEqual([])
    const payload = written() as { stickyPacked?: unknown[] }
    expect(payload).toBeTruthy()
    expect(payload.stickyPacked).toHaveLength(6_000)
  })

  it('reads its own writes back, entry for entry', () => {
    const { store } = storeHarness()
    store.update((data) => {
      data.instances.push(instance())
      data.stickyMap.push(['bind1', 'aa:bb:cc:dd:ee:ff', 'pd7', 1_700_000_123])
    })
    store.flush()

    // A fresh store over the same host data is what a restart looks like.
    store.reset()

    expect(store.read().stickyMap).toEqual([
      ['bind1', 'aa:bb:cc:dd:ee:ff', 'pd7', 1_700_000_123]
    ])
  })

  it('still loads a file an older build wrote in the unpacked shape', () => {
    const harness = moduleHarness('openwrt', () => ({ stdout: '', stderr: '', code: 0 }), {
      hostData: {
        version: 1,
        nextSeq: 1,
        batches: [],
        instances: [instance()],
        extraTables: [],
        stickyMap: [['bind1', 'aa:bb:cc:dd:ee:ff', 'pd7', 1_700_000_123]],
        events: [],
        jobs: []
      }
    })
    const store = new HostStore(harness.ctx, () => DEFAULT_RULES)

    expect(store.read().stickyMap).toEqual([
      ['bind1', 'aa:bb:cc:dd:ee:ff', 'pd7', 1_700_000_123]
    ])
  })

  it('logs and keeps the change in memory when even a trimmed write will not fit', () => {
    const harness = moduleHarness('openwrt', () => ({ stdout: '', stderr: '', code: 0 }))
    const logs: string[] = []
    const ctx = harness.ctx as ModuleContext & {
      hostDataSet: (value: unknown) => void
      log: (message: string) => void
    }
    ctx.hostDataSet = vi.fn(() => {
      throw new Error('payload is over the 512 KB limit')
    })
    ctx.log = (message: string) => logs.push(message)
    const store = new HostStore(ctx, () => DEFAULT_RULES)

    store.update((data) => {
      data.extraTables.push(['wan1', 10_042])
    })
    store.flush()

    expect(logs.some((line) => line.includes('could not be saved'))).toBe(true)
    expect(store.read().extraTables).toEqual([['wan1', 10_042]])
  })
})
