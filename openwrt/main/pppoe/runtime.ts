/**
 * The mutable state the free functions in this folder take as their first
 * argument: the daemon-answer cache, the check-token session, and the
 * generation counter that makes a host change abandon work in flight.
 *
 * The cache is the whole trick of this domain. Every surface - the pools
 * table, the row tables, the stream payload - reads it synchronously, and one
 * fetch per fast tick refreshes it from `bm.pppoe` over the connection the
 * module already has. A router that stops answering keeps its last answers
 * with `stale` set, which is a table a person can still read rather than one
 * that went blank.
 */
import { createCheckSession, type CheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { AgentDeps, PoolInfo, PoolRow, PoolSettings } from '../agent'
import type { AgentCapability } from '../probe'
import type {
  FrozenPoolChange,
  PppoeAgentReader,
  PppoeConfigStore,
  PppoeJobs,
  PppoeService,
  PppoeSnapshot
} from './types'

export interface PppoeCache {
  info: PoolInfo | null
  rows: PoolRow[]
  rowsLimit: number
  /** App-clock ms of the last successful fetch; 0 before the first. */
  fetchedAt: number
  /** The last fetch failed, so everything above is the previous answer. */
  stale: boolean
  /** Why, in a sentence, when `stale` is true. */
  error: string
}

export interface PppoeRuntime {
  ctx: ModuleContext
  config: PppoeConfigStore
  jobs: PppoeJobs
  service: PppoeService
  agent?: PppoeAgentReader
  session: CheckSession<FrozenPoolChange>
  /** Its own session: a settings token is not a pool token. */
  settingsSession: CheckSession<Partial<PoolSettings>>
  cache: PppoeCache
  /** The in-flight refresh, so two ticks never race two fetches. */
  fetching: Promise<void> | null
  /** Pools whose delete job is still running; a second delete is refused. */
  deleting: Set<string>
  latestPayload: PppoeSnapshot
  generation: number
}

export function emptyCache(): PppoeCache {
  return { info: null, rows: [], rowsLimit: 0, fetchedAt: 0, stale: false, error: '' }
}

export function emptySnapshot(): PppoeSnapshot {
  return {
    t: 0,
    pools: 0,
    interfaces: 0,
    up: 0,
    dialing: 0,
    down: 0,
    error: 0,
    stopped: 0,
    unwritten: 0,
    attention: 0,
    legacyCount: 0,
    stale: false
  }
}

export function createPppoeRuntime(
  ctx: ModuleContext,
  config: PppoeConfigStore,
  jobs: PppoeJobs,
  service: PppoeService,
  agent?: PppoeAgentReader
): PppoeRuntime {
  return {
    ctx,
    config,
    jobs,
    service,
    ...(agent ? { agent } : {}),
    session: createCheckSession<FrozenPoolChange>(),
    settingsSession: createCheckSession<Partial<PoolSettings>>(),
    cache: emptyCache(),
    fetching: null,
    deleting: new Set(),
    latestPayload: emptySnapshot(),
    generation: 0
  }
}

export function resetRuntime(runtime: PppoeRuntime): void {
  runtime.generation += 1
  runtime.session.clear()
  runtime.settingsSession.clear()
  runtime.cache = emptyCache()
  runtime.fetching = null
  runtime.deleting.clear()
  runtime.latestPayload = emptySnapshot()
}

/**
 * The dependency object every client call takes. The capability is read per
 * call, never captured: an `apk del` on the router lands between two
 * readiness cycles, and a call built on a stale yes fails as a shell error
 * instead of a sentence.
 */
export function agentDeps(runtime: PppoeRuntime): AgentDeps {
  return {
    ctx: runtime.ctx,
    capability: (): AgentCapability => {
      const read = runtime.agent
      if (read) return read()
      return {
        installed: false,
        running: false,
        release: '',
        apiVersion: 0,
        schema: 0,
        dataSchema: null,
        provides: [],
        features: [],
        guard: null,
        usable: false,
        problem: 'There is no Bored Manager agent on this router.',
        canGuard: false,
        canUpdate: false
      }
    }
  }
}

export function recordEvent(runtime: PppoeRuntime, kind: string, message: string): void {
  const safe = message.replace(/[\r\n]+/g, ' ').slice(0, 500)
  runtime.ctx.log(`openwrt: ${safe}`)
  runtime.service.event?.(kind, safe)
}
