import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { OkResult } from '@shared/types'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * An instance could be created, started, stopped and deleted, and never edited.
 * A typo in the name, or a second thought about sticky assignment, meant
 * deleting the instance - which tears every client rule off the router, drops
 * the remembered WAN of every device on it, and hands the LAN back to a
 * fail-closed catch-all until the replacement finishes preparing.
 *
 * The LAN and the carrier stay delete-and-recreate on purpose: they are the
 * topology every rule was built from, and the refusal below says so rather
 * than silently accepting a value it would ignore.
 */

const ok = (): ModuleExecResult => ({ code: 0, stdout: '', stderr: '' })

function hostData(): unknown {
  return {
    version: 1,
    nextSeq: 1,
    batches: [],
    instances: [
      {
        id: 'bind_1',
        name: 'Office LAN',
        lan: 'lan',
        carrier: 'eth1',
        running: true,
        sticky: true,
        remap: true,
        createdAt: 1,
        slot: 0
      },
      {
        id: 'bind_2',
        name: 'Guest LAN',
        lan: 'guest',
        carrier: 'eth2',
        running: false,
        sticky: false,
        remap: false,
        createdAt: 2,
        slot: 1
      }
    ],
    extraTables: [],
    stickyMap: [],
    events: [],
    moduleEvents: [],
    jobs: []
  }
}

interface Module {
  update(id: unknown, values: unknown): OkResult
  rows(): Array<Record<string, unknown>>
  events(): Array<{ kind: string; text: string }>
  methods: Set<string>
  dispose(): void
}

function moduleUnder(): Module {
  const harness = moduleHarness('openwrt', ok, {
    hostData: hostData(),
    config: sharedModuleConfig(null)
  })
  const runtime = activate(harness.ctx)
  const manifest = JSON.parse(
    readFileSync(new URL('../../openwrt/module.json', import.meta.url), 'utf8')
  ) as { methods: string[] }
  return {
    methods: new Set(manifest.methods),
    update: (id, values) =>
      harness.handlers.get('bindingUpdate')?.(id, values) as OkResult,
    // The rows a surface renders, straight off the stream payload the module
    // republishes: an edit has to reach them without waiting for a fast tick.
    rows: () =>
      (runtime.snapshots?.().binding as { rows: Array<Record<string, unknown>> }).rows,
    events: () =>
      harness.handlers.get('eventRows')?.('binding') as Array<{
        kind: string
        text: string
      }>,
    dispose: () => runtime.dispose?.()
  }
}

describe('the method the row form calls', () => {
  it('is registered under the name the manifest declares', () => {
    const module = moduleUnder()

    expect(module.methods.has('bindingUpdate')).toBe(true)
    expect(module.update('bind_1', { name: 'Office LAN' }).ok).toBe(true)

    module.dispose()
  })

  it('has a handler for every method the manifest declares', () => {
    // A name in one list and not the other is a dead button nothing reports.
    const harness = moduleHarness('openwrt', ok, { config: sharedModuleConfig(null) })
    const runtime = activate(harness.ctx)
    const manifest = JSON.parse(
      readFileSync(new URL('../../openwrt/module.json', import.meta.url), 'utf8')
    ) as { methods: string[] }

    expect(manifest.methods.filter((name) => !harness.handlers.has(name))).toEqual([])

    runtime.dispose?.()
  })
})

describe('editing an instance', () => {
  it('renames it, and the row says so before the next sample', () => {
    const module = moduleUnder()

    const result = module.update('bind_1', {
      name: 'Floor 2',
      sticky: false,
      remap: false
    })

    expect(result.ok).toBe(true)
    expect(module.rows()[0]).toMatchObject({
      id: 'bind_1',
      name: 'Floor 2',
      sticky: false,
      remap: false
    })
    module.dispose()
  })

  it('leaves out what the form did not send', () => {
    const module = moduleUnder()

    module.update('bind_1', { sticky: false })

    expect(module.rows()[0]).toMatchObject({
      name: 'Office LAN',
      sticky: false,
      remap: true
    })
    module.dispose()
  })

  it('records what changed', () => {
    const module = moduleUnder()

    module.update('bind_1', { name: 'Floor 2', remap: false })
    const texts = module.events().map((entry) => entry.text)

    expect(texts.some((text) => text.includes('renamed to "Floor 2"'))).toBe(true)
    expect(texts.some((text) => text.includes('error remap off'))).toBe(true)
    module.dispose()
  })

  it('says nothing happened when nothing did', () => {
    const module = moduleUnder()

    const result = module.update('bind_1', {
      name: 'Office LAN',
      sticky: true,
      remap: true
    })

    expect(result).toEqual({ ok: true, data: 'nothing changed' })
    expect(module.events()).toEqual([])
    module.dispose()
  })
})

describe('what editing refuses', () => {
  it('refuses a name another instance already has', () => {
    const module = moduleUnder()

    const result = module.update('bind_1', { name: 'guest lan' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('already exists')
    // Still what it was: re-sending the old name changes nothing.
    expect(module.update('bind_1', { name: 'Office LAN' })).toEqual({
      ok: true,
      data: 'nothing changed'
    })
    module.dispose()
  })

  it('refuses to move the instance to another LAN, and says what to do', () => {
    const module = moduleUnder()

    const result = module.update('bind_1', { lan: 'guest' })

    expect(result.ok).toBe(false)
    // Silently ignoring it would leave the catch-all and every client rule
    // written from a subnet that is no longer behind this instance.
    expect(result.error).toContain('delete this instance')
    expect(result.error).toContain('guest')
    expect(module.update('bind_1', { lan: 'lan' })).toEqual({
      ok: true,
      data: 'nothing changed'
    })
    module.dispose()
  })

  it('refuses to move it to another carrier', () => {
    const module = moduleUnder()

    const result = module.update('bind_1', { carrier: 'eth3' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('WAN carrier')
    module.dispose()
  })

  it('accepts the LAN and carrier it already has', () => {
    // The form does not carry them, but an invoke made by hand may.
    const module = moduleUnder()

    const result = module.update('bind_1', {
      lan: 'lan',
      carrier: 'eth1',
      name: 'Floor 2'
    })

    expect(result.ok).toBe(true)
    module.dispose()
  })

  it('refuses a name the user cleared, and keeps one the form never sent', () => {
    const module = moduleUnder()

    const cleared = module.update('bind_1', { name: '  ', sticky: false })
    expect(cleared.ok).toBe(false)
    expect(cleared.error).toContain('1-80 characters')

    // The flag went nowhere either: a refused edit changes nothing at all.
    expect(module.update('bind_1', { sticky: true })).toEqual({
      ok: true,
      data: 'nothing changed'
    })
    module.dispose()
  })

  it('refuses an instance that is not there', () => {
    const module = moduleUnder()

    expect(module.update('bind_9', { name: 'Nope' })).toEqual({
      ok: false,
      error: 'no such binding instance'
    })
    module.dispose()
  })
})
