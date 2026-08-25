/**
 * The module's event trail.
 *
 * PPPoE and router notices used to reach `data/app.log` and nowhere else, so a
 * create that half-failed or a firewall rule that never matched left no trace a
 * user could see. They are recorded here instead, alongside the per-instance
 * binding events the reconciler already wrote, and read back as one list.
 *
 * Messages are sanitized on the way in: single-line, bounded, and - like every
 * other user-visible string in this module - never carrying command output,
 * because `uci batch` echoes the lines it rejected and those may hold PPPoE
 * passwords.
 */
import type { ModuleContext } from '@shared/modules'
import type { ModuleEventScope } from './store'

export type ModuleEventSource = ModuleEventScope | 'binding'

export interface ModuleEventRow {
  id: string
  t: number
  source: ModuleEventSource
  /** Binding instance name; empty for module-wide events. */
  instance: string
  kind: string
  text: string
}

/** The part of OwrtHostData used here; other fields are left untouched. */
export interface EventStoreData {
  instances: Array<{ id: string; name: string }>
  events: Array<[instanceId: string, t: number, kind: string, text: string]>
  moduleEvents: Array<[scope: ModuleEventScope, t: number, kind: string, text: string]>
}

/** HostStore satisfies this structurally, without a runtime import cycle. */
export interface EventStore<TData extends EventStoreData = EventStoreData> {
  read(): TData
  update<TResult>(mutate: (data: TData) => TResult): TResult
}

const DEFAULT_ROW_LIMIT = 200
const MAX_TEXT = 500

export function sanitizeEventText(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TEXT)
}

/** The newest `limit` rows of one ring, turned newest-first. Rings are appended. */
function newest(rows: readonly ModuleEventRow[], limit: number): ModuleEventRow[] {
  return rows.slice(-limit).reverse()
}

/**
 * Newest first, and nothing else. `Array.prototype.sort` is stable, so rows
 * sharing a timestamp - everything one reconcile pass recorded shares one -
 * keep the order their ring recorded them in. Tie-breaking on the row id
 * instead sorted `binding-10-...` above `binding-9-...`, which reversed the
 * only ordering the ring actually carries.
 */
function byNewest(a: ModuleEventRow, b: ModuleEventRow): number {
  return b.t - a.t
}

export class EventLog<TData extends EventStoreData = EventStoreData> {
  private disposed = false

  constructor(
    private ctx: Pick<ModuleContext, 'emit' | 'log'>,
    private store: EventStore<TData>
  ) {}

  /**
   * Persist one event, log it, and push it to any live log panel. Emitting uses
   * the `{ id, data }` shape the `log` block routes by scope; a bare string
   * would be dropped by the renderer.
   */
  record(scope: ModuleEventScope, kind: string, text: string): void {
    if (this.disposed) return
    const safe = sanitizeEventText(text)
    const cleanKind = sanitizeEventText(kind).slice(0, 64)
    if (!safe || !cleanKind) return
    const t = Date.now()
    this.store.update((data) => {
      data.moduleEvents.push([scope, t, cleanKind, safe])
    })
    this.ctx.log(`openwrt: ${safe}`)
    // `source` is the segment the Events tab filters on, carried as its own
    // field rather than only as the `[scope]` prefix inside `data`. A reader
    // that wants "PPPoE only" had to parse the rendered line to get it, which
    // is the same reason `rows()` takes the origin as an argument.
    this.ctx.emit('moduleLog', {
      id: scope,
      source: scope satisfies ModuleEventSource,
      data: `${new Date(t).toISOString()} [${scope}] ${safe}`
    })
  }

  /**
   * Newest first. `source` narrows to one origin; anything else (including the
   * empty string the Events table passes) returns every origin merged.
   *
   * The window is applied to each ring before they are merged, not to the
   * merged list. The two rings exist so that binding's churn - an entry per
   * device per reconcile - cannot evict the rare PPPoE lifecycle events, and
   * one window over the merge evicted them exactly as a single ring would
   * have: two hundred binding rows from the last minute, and nothing at all
   * about the pool that was created this morning.
   */
  rows(sourceRaw?: unknown, limitRaw?: unknown): ModuleEventRow[] {
    const source = typeof sourceRaw === 'string' ? sourceRaw : ''
    const limit =
      typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.trunc(limitRaw), DEFAULT_ROW_LIMIT)
        : DEFAULT_ROW_LIMIT
    const data = this.store.read()
    const names = new Map(data.instances.map((instance) => [instance.id, instance.name]))
    const binding: ModuleEventRow[] = []
    const module: ModuleEventRow[] = []

    if (source === '' || source === 'binding') {
      for (const [index, entry] of data.events.entries()) {
        binding.push({
          id: `binding-${index}-${entry[1]}`,
          t: entry[1],
          source: 'binding',
          instance: names.get(entry[0]) ?? entry[0],
          kind: entry[2],
          text: entry[3]
        })
      }
    }
    for (const [index, entry] of data.moduleEvents.entries()) {
      if (source !== '' && source !== entry[0]) continue
      module.push({
        id: `${entry[0]}-${index}-${entry[1]}`,
        t: entry[1],
        source: entry[0],
        instance: '',
        kind: entry[2],
        text: entry[3]
      })
    }

    return [...newest(binding, limit), ...newest(module, limit)]
      .sort(byNewest)
      .slice(0, limit * 2)
  }

  dispose(): void {
    this.disposed = true
  }
}
