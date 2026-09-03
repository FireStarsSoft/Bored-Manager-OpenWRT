/**
 * The mutable state the free functions in this folder take as their first
 * argument, and the four things every path does with it: build the dependency
 * object a daemon call needs, ask whether this router has a daemon at all, put
 * a line in the event trail, and wrap a mutation in a job.
 *
 * Everything here is state on *this* side. The instances, the bindings and the
 * rules are the router's, so a reset drops a cache and some tokens and nothing
 * else - there is no half-written change on the router to undo, which is the
 * whole point of the arrangement this folder was written for.
 */
import { NOTHING_HANDED_OVER } from './handover'
import { createCheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { hasBindingDaemon, type AgentDeps } from '../agent'
import type { AgentCapability } from '../probe'
import { bindingDaemonProblem } from '../requirements'
import type { HostStore } from '../store'
import type {
  BindingAgentReader,
  BindingCache,
  BindingConfigStore,
  BindingJobs,
  BindingRuntime,
  BindingService,
  BindingSnapshot,
  DirectSnapshot
} from './types'

/** Nothing fetched yet, which is not the same statement as a failed fetch. */
export function emptyCache(): BindingCache {
  return {
    info: null,
    assignments: [],
    waiting: [],
    bindings: null,
    fetchedAt: 0,
    stale: false,
    error: ''
  }
}

export function emptyBindingSnapshot(): BindingSnapshot {
  return {
    t: 0,
    hookOk: true,
    lastError: '',
    rows: [],
    wans: { total: 0, available: 0, bound: 0, error: 0, warning: 0, dialing: 0, boundPct: 0 },
    // Not `ready: false`: before the first readiness cycle this module has not
    // looked, and a page that opened on "this router has no binding daemon"
    // would be stating a fact about a router nobody has asked yet. The empty
    // problem is what tells the two apart.
    daemon: { ready: false, problem: '' }
  }
}

export function emptyDirectSnapshot(): DirectSnapshot {
  return { t: 0, hookOk: true, lastError: '', rows: [], totals: { total: 0, ok: 0, held: 0 } }
}

export function createBindingRuntime(
  ctx: ModuleContext,
  config: BindingConfigStore,
  jobs: BindingJobs,
  service: BindingService,
  store: HostStore,
  /** The router-side capability verdict, read per operation, never captured. */
  agent?: BindingAgentReader
): BindingRuntime {
  return {
    ctx,
    config,
    jobs,
    service,
    ...(agent ? { agent } : {}),
    store,
    handover: NOTHING_HANDED_OVER,
    instanceSession: createCheckSession(),
    bindSession: createCheckSession(),
    settingsSession: createCheckSession(),
    cache: emptyCache(),
    fetching: null,
    busy: new Set(),
    latestBinding: emptyBindingSnapshot(),
    latestDirect: emptyDirectSnapshot(),
    generation: 0
  }
}

/**
 * The machine changed, or the module was reset.
 *
 * The cache goes rather than being marked stale, and that is the one place the
 * two are not interchangeable: stale rows are the previous answer *from this
 * router*, and showing them against a different one would put another router's
 * bindings on the page under this router's name.
 */
export function resetRuntime(runtime: BindingRuntime): void {
  runtime.generation += 1
  runtime.instanceSession.clear()
  runtime.bindSession.clear()
  runtime.settingsSession.clear()
  runtime.cache = emptyCache()
  runtime.fetching = null
  runtime.busy.clear()
  runtime.latestBinding = emptyBindingSnapshot()
  runtime.latestDirect = emptyDirectSnapshot()
  // A different router has different records to hand over, and this one's
  // verdict says nothing about it.
  runtime.handover = NOTHING_HANDED_OVER
}

/**
 * The module is going away.
 *
 * The same work, under the name of the hook that drives it. This half holds
 * nothing on the router and no subscription to it, so there is nothing to
 * release that a reset does not already drop - and the day there is, it has an
 * obvious place to go that a shared name would not have given it.
 */
export function disposeRuntime(runtime: BindingRuntime): void {
  resetRuntime(runtime)
}

/** What a call is answered with when there is no agent to ask. */
const NO_AGENT: AgentCapability = {
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

function capability(runtime: BindingRuntime): AgentCapability {
  const read = runtime.agent
  return read ? read() : NO_AGENT
}

/**
 * The dependency object every daemon call takes.
 *
 * The capability is read inside the closure rather than captured when the
 * object is built, and that is what makes the changeover a tick rather than a
 * reconnect: an `apk add` or an `apk del` on the router lands between two
 * readiness cycles, and a call built on a verdict that was true a moment ago
 * fails as a shell error rather than as a sentence somebody can act on.
 */
export function agentDeps(runtime: BindingRuntime): AgentDeps {
  return {
    ctx: runtime.ctx,
    capability: () => capability(runtime)
  }
}

/**
 * Whether this router keeps its own WAN Binding and this module can drive it.
 *
 * Three facts in one answer - the agent is usable, `bm-wanbind` is installed,
 * and it speaks the contract this module was written against - because every
 * surface asks the same question and only `daemonProblem` needs them apart.
 */
export function daemonReady(runtime: BindingRuntime): boolean {
  return hasBindingDaemon(capability(runtime))
}

/** Why not, in the requirement's own sentence, or '' when it is ready. */
export function daemonProblem(runtime: BindingRuntime): string {
  return bindingDaemonProblem(capability(runtime))
}

/**
 * One line in the event trail: the per-instance ring when it belongs to an
 * instance, the module-wide one when it does not.
 *
 * Sanitized on the way in, like every other user-visible string this module
 * writes: single line and bounded, because a router's own output may be quoted
 * into one of these and a ring entry is kept.
 */
export function recordEvent(
  runtime: BindingRuntime,
  kind: string,
  message: string,
  instanceId = ''
): void {
  const safe = message.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500)
  if (!safe) return
  runtime.ctx.log(`openwrt: ${safe}`)
  if (!instanceId) {
    runtime.service.event?.(kind, safe)
    return
  }
  runtime.store.update((data) => data.events.push([instanceId, Date.now(), kind, safe]))
}

/**
 * Every operator-triggered mutation becomes a job, so a failure is visible in
 * the job list rather than only in a returned error nobody reads.
 *
 * `id` is the section the change is against, and giving it is what stops two
 * changes racing on one: both calls are create-and-edit in one, so the loser
 * would not fail - it would land second and silently undo the winner. The
 * refusal names the id rather than saying "busy", because the operator pressing
 * a row's Save has no way to know which of the two things they started is still
 * running.
 */
export async function runMutationJob(
  runtime: BindingRuntime,
  kind: string,
  label: string,
  work: () => Promise<OkResult>,
  id = ''
): Promise<OkResult> {
  if (id && runtime.busy.has(id)) {
    return { ok: false, error: `${id} already has a change running - wait for it to finish` }
  }
  if (id) runtime.busy.add(id)
  try {
    const job = runtime.jobs.start({
      kind,
      label,
      items: [
        {
          name: label,
          run: async () => {
            const result = await work()
            if (!result.ok) throw new Error(result.error || `${label} failed`)
            return result.data || 'done'
          }
        }
      ],
      onError: 'abort',
      // Cleared whatever the job did and whatever generation it belongs to: a
      // reset that emptied the set while this was in flight must not have the
      // id put back into it, and a failed job that left the id set would lock
      // the row out until the module restarted.
      onFinished: () => {
        if (id) runtime.busy.delete(id)
      }
    })
    return { ok: true, data: job.id }
  } catch (error) {
    if (id) runtime.busy.delete(id)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
