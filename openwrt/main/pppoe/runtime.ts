/**
 * The mutable state the free functions in this folder take as their first
 * argument, plus the four things nearly every path does with it: read the
 * cached model, poke the sampler, write a sanitized line to the log, and
 * serialize firewall edits against the rest of the module.
 *
 * `generation` is what makes a host change abandon work already in flight. A
 * create job holds closures over the store it started against; once the module
 * is reset that store describes another router, and a write from the old job
 * would land in the wrong document. `PppoeManager` owns exactly one runtime and
 * decides nothing itself.
 */
import { createCheckSession, type CheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { AgentCapability } from '../probe'
import type { RouterModel } from '../types'
import type {
  FrozenBatchPlan,
  PppoeConfigStore,
  PppoeHostStore,
  PppoeJobs,
  PppoeRow,
  PppoeRules,
  PppoeService,
  PppoeSnapshot,
  PppoeStoreData
} from './types'

/**
 * What one `rowsByBatch()` build produced, and what it is still true for.
 *
 * Four surfaces ask for the same rows on the same tick - the summary the module
 * emits, the batch table, the open batch's row detail, and the attention table
 * - and a fifth, the watchdog, asks on the slow one. Each of them rebuilt every
 * row of every batch from scratch: on a five-thousand-account pool, twenty
 * thousand row objects a tick out of inputs that had not moved.
 */
export interface PppoeRowCache {
  key: PppoeRowKey
  rows: Map<string, PppoeRow[]>
  /** The clock this was built against; see `nextChangeAt`. */
  builtAt: number
  /**
   * The first moment the dialing clock could turn one of these rows into a
   * timeout - Infinity when none of them is dialing. Everything else in a row
   * comes from the sample, but `dialing` becomes `error` on the wall clock
   * alone, so the cache is only good for the window `[builtAt, nextChangeAt)`.
   */
  nextChangeAt: number
}

/** Everything outside the wall clock that a built row depends on. */
export interface PppoeRowKey {
  model: unknown
  t: number
  revision: number
  errors: unknown
  users: unknown
  stopped: number
}

export interface PppoeRuntime {
  ctx: ModuleContext
  config: PppoeConfigStore
  store: PppoeHostStore<PppoeStoreData>
  jobs: PppoeJobs
  service: PppoeService
  /**
   * The router-side capability verdict, read per operation and never captured.
   *
   * When it says this router provides `pppoe`, the sections a pool is made of
   * are written by `bm-pppoe-pool` in one call instead of by fifty round trips
   * of `uci batch` - and, more to the point, the credentials never travel as
   * arguments to anything. Everything else about a create is unchanged: the
   * firewall zone, the record, the verify step are this module's either way.
   */
  agent?: () => AgentCapability
  session: CheckSession<FrozenBatchPlan>
  sample: RouterModel | null
  /** Renderer-visible username cache only; never written to HostStore. */
  usernames: Map<string, string>
  manuallyStopped: Set<string>
  deleting: Set<string>
  /**
   * Batches whose create job is still running. The delete path inspects the
   * router once, at the top of its own job, and then works from that snapshot -
   * so a delete started while a create is mid-flight deletes what existed at
   * that instant and leaves every later chunk behind as an interface no record
   * covers. `deleting` already stops the reverse order; this is its twin.
   */
  creating: Set<string>
  errorSince: Map<string, number>
  /**
   * App-clock time each session was first seen dialing, so `dialing` can stop
   * being a state a row sits in forever. Filled and cleared by the row builder,
   * which is the only place that knows what a session currently looks like.
   */
  dialingSince: Map<string, number>
  /** See `PppoeRowCache`. Cleared by `onSample` and by anything that stops a session. */
  rowCache: PppoeRowCache | null
  watchdogJobId: string | null
  latestPayload: PppoeSnapshot
  generation: number
}

export function emptySnapshot(): PppoeSnapshot {
  return {
    t: 0,
    batchCount: 0,
    total: 0,
    up: 0,
    dialing: 0,
    error: 0,
    stopped: 0,
    missing: 0,
    unknown: 0,
    attention: 0
  }
}

export function createPppoeRuntime<TData extends PppoeStoreData>(
  ctx: ModuleContext,
  config: PppoeConfigStore,
  store: PppoeHostStore<TData>,
  jobs: PppoeJobs,
  service: PppoeService,
  agent?: () => AgentCapability
): PppoeRuntime {
  return {
    ctx,
    config,
    store,
    jobs,
    service,
    ...(agent ? { agent } : {}),
    session: createCheckSession<FrozenBatchPlan>(),
    sample: null,
    usernames: new Map(),
    manuallyStopped: new Set(),
    deleting: new Set(),
    creating: new Set(),
    errorSince: new Map(),
    dialingSince: new Map(),
    rowCache: null,
    watchdogJobId: null,
    latestPayload: emptySnapshot(),
    generation: 0
  }
}

export function resetRuntime(runtime: PppoeRuntime): void {
  runtime.generation += 1
  runtime.session.clear()
  runtime.sample = null
  runtime.usernames.clear()
  runtime.manuallyStopped.clear()
  runtime.deleting.clear()
  runtime.creating.clear()
  runtime.errorSince.clear()
  runtime.dialingSince.clear()
  runtime.rowCache = null
  runtime.watchdogJobId = null
  runtime.latestPayload = emptySnapshot()
}

/**
 * Throw the built rows away. The cache key covers the sample and the store, so
 * this is for the one input it cannot watch: `manuallyStopped`, which an action
 * wave edits between ticks and whose size can come back to where it started.
 */
export function clearRowCache(runtime: PppoeRuntime): void {
  runtime.rowCache = null
}

export function timeoutMs(rules: PppoeRules): number {
  return Math.max(5_000, Math.trunc(rules.execTimeoutSec) * 1_000)
}

export function currentModel(runtime: PppoeRuntime): RouterModel | null {
  return runtime.service.model() ?? runtime.sample
}

export function forceDump(runtime: PppoeRuntime): void {
  runtime.service.forceDump()
}

export function recordEvent(runtime: PppoeRuntime, kind: string, message: string): void {
  const safe = message.replace(/[\r\n]+/g, ' ').slice(0, 500)
  runtime.ctx.log(`openwrt: ${safe}`)
  runtime.service.event?.(kind, safe)
}

export function runFirewall<T>(runtime: PppoeRuntime, run: () => Promise<T>): Promise<T> {
  return runtime.store.withFirewall ? runtime.store.withFirewall(run) : run()
}

/**
 * Every write this domain makes to `/etc/config/network`, queued behind the
 * binding half's writes to the same file. `uci` has no locking of its own: a
 * binding preparation setting `ip4table` on a WAN while a create is committing
 * a chunk reads the file, applies its own change and writes the whole thing
 * back - and the hundred sections the chunk had just committed are gone, with
 * no error anywhere.
 */
export function runNetwork<T>(runtime: PppoeRuntime, run: () => Promise<T>): Promise<T> {
  return runtime.store.withNetwork ? runtime.store.withNetwork(run) : run()
}

/**
 * A batch record appearing or disappearing, written without waiting out the
 * store's ten-second debounce. A crash in that window does not lose some
 * history: it loses the only record that five thousand PPPoE sections on the
 * router belong to this module at all.
 */
export function writeThrough<T>(
  runtime: PppoeRuntime,
  mutate: (data: PppoeStoreData) => T
): T {
  const store = runtime.store
  return store.updateNow ? store.updateNow(mutate) : store.update(mutate)
}
