import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ModuleContext, ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { EventLog, type EventStore, type EventStoreData } from '../../openwrt/main/events'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { HostStore, MAX_MODULE_EVENTS } from '../../openwrt/main/store'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * PPPoE and router notices used to reach the app log and nowhere else: a create
 * that half-failed, a firewall rule that never matched, a router that rebooted
 * under a live binding. None of it was visible in the module's own UI, because
 * the hook that carries those events was never wired to anything.
 */

const ok = (stdout: string, stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 10): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function memoryStore(initial: Partial<EventStoreData> = {}): EventStore & { data: EventStoreData } {
  const data: EventStoreData = {
    instances: [],
    events: [],
    moduleEvents: [],
    ...initial
  }
  return {
    data,
    read: () => data,
    update: <TResult>(mutate: (value: EventStoreData) => TResult): TResult => mutate(data)
  }
}

function recorder(): {
  log: EventLog
  store: ReturnType<typeof memoryStore>
  logs: string[]
  emits: Array<[string, unknown]>
} {
  const store = memoryStore()
  const logs: string[] = []
  const emits: Array<[string, unknown]> = []
  const log = new EventLog(
    {
      log: (message: string) => logs.push(message),
      emit: (event: string, payload: unknown) => emits.push([event, payload])
    },
    store
  )
  return { log, store, logs, emits }
}

describe('module event log', () => {
  it('persists an event, logs it, and pushes it to a live log panel', () => {
    const { log, store, logs, emits } = recorder()

    log.record('pppoe', 'pppoe-create', 'Batch Home create job done (12 connections)')

    expect(store.data.moduleEvents).toHaveLength(1)
    expect(store.data.moduleEvents[0][0]).toBe('pppoe')
    expect(store.data.moduleEvents[0][2]).toBe('pppoe-create')
    expect(logs[0]).toContain('Batch Home create job done')
    // The `log` block routes by `id`; a bare string is dropped by the renderer,
    // which is exactly how the router-reboot notice used to disappear.
    expect(emits[0][0]).toBe('moduleLog')
    expect(emits[0][1]).toMatchObject({ id: 'pppoe' })
    expect(String((emits[0][1] as { data: string }).data)).toContain('[pppoe]')
  })

  it('keeps a recorded message single-line and bounded', () => {
    const { log, store } = recorder()

    log.record('router', 'reboot', `line one\nline two\r\tpadded${'x'.repeat(900)}`)

    const text = store.data.moduleEvents[0][3]
    expect(text).not.toMatch(/[\r\n\t]/)
    expect(text.length).toBeLessThanOrEqual(500)
  })

  it('merges binding, PPPoE and router events newest first, naming the instance', () => {
    const store = memoryStore({
      instances: [{ id: 'bind1', name: 'Office LAN' }],
      events: [['bind1', 1_000, 'assigned', 'aa:bb went to pd00001']],
      moduleEvents: [
        ['pppoe', 2_000, 'pppoe-create', 'Batch Home created'],
        ['router', 3_000, 'reboot', 'router reboot detected']
      ]
    })
    const log = new EventLog({ log: () => {}, emit: () => {} }, store)

    const rows = log.rows('')

    expect(rows.map((row) => row.kind)).toEqual(['reboot', 'pppoe-create', 'assigned'])
    expect(rows[2]).toMatchObject({ source: 'binding', instance: 'Office LAN' })
    expect(rows[0]).toMatchObject({ source: 'router', instance: '' })
    expect(new Set(rows.map((row) => row.id)).size).toBe(3)
  })

  it('names the origin as its own field, not only inside the rendered line', () => {
    const { log, emits } = recorder()

    log.record('router', 'reboot', 'router reboot detected')

    // The `source` the Events tab filters on. A reader that wanted "PPPoE
    // only" had to parse it back out of `data`, which is the same thing
    // `rows()` takes as an argument and the same three segments it answers in.
    expect(emits[0][1]).toMatchObject({ id: 'router', source: 'router' })
  })

  it('gives each ring its own window so binding churn cannot bury a PPPoE event', () => {
    const store = memoryStore({
      instances: [{ id: 'bind1', name: 'Office LAN' }],
      events: Array.from({ length: 400 }, (_, index): EventStoreData['events'][number] => [
        'bind1',
        2_000 + index,
        'assigned',
        `device ${index} bound`
      ]),
      moduleEvents: [
        ['pppoe', 1_000, 'pppoe-create', 'Batch Home created'],
        ['router', 1_001, 'reboot', 'router reboot detected']
      ]
    })
    const log = new EventLog({ log: () => {}, emit: () => {} }, store)

    const rows = log.rows('')

    // Two rings exist precisely so binding - an entry per device per reconcile
    // - cannot evict the rare PPPoE lifecycle events. One 200-row window over
    // the merged list evicted them exactly as a single ring would have.
    expect(rows.filter((row) => row.source === 'pppoe')).toHaveLength(1)
    expect(rows.filter((row) => row.source === 'router')).toHaveLength(1)
    expect(rows.filter((row) => row.source === 'binding')).toHaveLength(200)
  })

  it('keeps rows recorded in one pass in the order the ring recorded them', () => {
    // Everything one reconcile writes shares a timestamp. Tie-breaking on the
    // row id sorted `binding-10-...` above `binding-9-...`, which is neither
    // the recorded order nor any other order a reader could name.
    const store = memoryStore({
      instances: [{ id: 'bind1', name: 'Office LAN' }],
      events: Array.from({ length: 12 }, (_, index): EventStoreData['events'][number] => [
        'bind1',
        5_000,
        'assigned',
        `device ${index}`
      ])
    })
    const log = new EventLog({ log: () => {}, emit: () => {} }, store)

    expect(log.rows('').map((row) => row.text)).toEqual([
      'device 11', 'device 10', 'device 9', 'device 8', 'device 7', 'device 6',
      'device 5', 'device 4', 'device 3', 'device 2', 'device 1', 'device 0'
    ])
  })

  it('narrows to one origin when asked for one', () => {
    const store = memoryStore({
      instances: [{ id: 'bind1', name: 'Office LAN' }],
      events: [['bind1', 1_000, 'assigned', 'aa:bb went to pd00001']],
      moduleEvents: [['pppoe', 2_000, 'pppoe-create', 'Batch Home created']]
    })
    const log = new EventLog({ log: () => {}, emit: () => {} }, store)

    expect(log.rows('pppoe').map((row) => row.kind)).toEqual(['pppoe-create'])
    expect(log.rows('binding').map((row) => row.kind)).toEqual(['assigned'])
  })

  it('records nothing once disposed', () => {
    const { log, store, logs, emits } = recorder()

    log.dispose()
    log.record('pppoe', 'pppoe-create', 'after the module stopped')

    expect(store.data.moduleEvents).toEqual([])
    expect(logs).toEqual([])
    expect(emits).toEqual([])
  })

  it('survives a flush and reload, and stays capped', () => {
    const harness = moduleHarness('openwrt', () => ok(''))
    // The harness records host-data writes without serving them back; a restart
    // only means anything against a document that persists.
    let saved: unknown = null
    const ctx = harness.ctx as ModuleContext & {
      hostDataGet: () => unknown
      hostDataSet: (value: unknown) => void
    }
    ctx.hostDataSet = (value: unknown) => {
      saved = value
    }
    ctx.hostDataGet = () => saved
    const store = new HostStore(ctx, () => DEFAULT_RULES)
    const log = new EventLog(ctx, store)

    for (let index = 0; index < MAX_MODULE_EVENTS + 25; index++) {
      log.record('pppoe', 'pppoe-create', `event ${index}`)
    }
    store.flush()
    store.reset()

    const kept = store.read().moduleEvents
    expect(kept.length).toBeLessThanOrEqual(MAX_MODULE_EVENTS)
    // Oldest entries are the ones dropped.
    expect(kept[kept.length - 1][3]).toBe(`event ${MAX_MODULE_EVENTS + 24}`)
  })

  it('still loads host data written before this ring existed', () => {
    const harness = moduleHarness('openwrt', () => ok(''), {
      hostData: {
        version: 1,
        nextSeq: 1,
        batches: [],
        instances: [],
        extraTables: [],
        stickyMap: [],
        events: [],
        jobs: []
      }
    })

    expect(new HostStore(harness.ctx, () => DEFAULT_RULES).read().moduleEvents).toEqual([])
  })
})

describe('PPPoE lifecycle events reaching the module UI', () => {
  it('records a delete through the wired hook and serves it to the Events table', async () => {
    const harness = moduleHarness('openwrt', () => ok(''), {
      hostData: {
        version: 1,
        nextSeq: 5,
        batches: [
          {
            id: 'b1',
            name: 'Home',
            prefix: 'pd',
            carrier: 'eth1',
            createdAt: 1,
            count: 1,
            seqFrom: 1,
            seqTo: 1
          }
        ]
      },
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command === 'sh -s' && stdin.startsWith('uci -q show network')) {
        return ok('network.pd00001=interface\nfirewall.bmwanpool=zone')
      }
      if (command.startsWith('nft list ruleset')) return ok('1')
      return ok('')
    })
    const runtime = activate(harness.ctx)

    harness.handlers.get('pppoeBatchDelete')?.('b1')
    await settle(40)

    const rows = harness.handlers.get('eventRows')?.('pppoe') as Array<{
      kind: string
      text: string
      source: string
    }>
    expect(rows.some((row) => row.kind === 'pppoe-delete')).toBe(true)
    expect(rows[0].source).toBe('pppoe')
    expect(rows[0].text).toContain('Home')
    runtime.dispose?.()
    harness.revoke()
    expect(harness.afterStopCalls).toEqual([])
  })

  it('emits nothing the specs do not read', async () => {
    const harness = moduleHarness('openwrt', () => ok(''), {
      hostData: {
        version: 1,
        nextSeq: 5,
        batches: [
          {
            id: 'b1',
            name: 'Home',
            prefix: 'pd',
            carrier: 'eth1',
            createdAt: 1,
            count: 1,
            seqFrom: 1,
            seqTo: 1
          }
        ]
      },
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command, options) => {
      const stdin = options?.stdin ?? ''
      if (command === 'sh -s' && stdin.startsWith('uci -q show network')) {
        return ok('network.pd00001=interface\nfirewall.bmwanpool=zone')
      }
      if (command.startsWith('nft list ruleset')) return ok('1')
      return ok('')
    })
    const runtime = activate(harness.ctx)
    harness.handlers.get('pppoeBatchDelete')?.('b1')
    await settle(40)
    runtime.dispose?.()

    const emitted = new Set(harness.emit.mock.calls.map((call) => call[0] as string))
    expect(emitted.has('moduleLog')).toBe(true)
    // `moduleLog` carried every PPPoE lifecycle notice and every router notice
    // to a renderer that had nothing listening for them. A `log` block is a
    // live-tailed event rather than a declared stream, so the reader belongs
    // in a page spec, not in `manifest.streams`.
    expect([...emitted].filter((event) => !readers().has(event))).toEqual([])
  })
})

/** Every event name a spec reads: declared streams, plus `log` block events. */
function readers(): Set<string> {
  const covered = new Set<string>()
  const manifest = JSON.parse(
    readFileSync(new URL('../../openwrt/module.json', import.meta.url), 'utf8')
  ) as { streams?: Array<{ event: string }> }
  for (const stream of manifest.streams ?? []) covered.add(stream.event)

  const pages = new URL('../../openwrt/ui/pages/', import.meta.url)
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) collect(entry)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const block = node as Record<string, unknown>
    if (block.type === 'log' && typeof block.event === 'string') covered.add(block.event)
    for (const value of Object.values(block)) collect(value)
  }
  for (const name of readdirSync(pages)) {
    collect(JSON.parse(readFileSync(new URL(name, pages), 'utf8')))
  }
  return covered
}
