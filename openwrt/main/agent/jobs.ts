/**
 * Putting the router's safety net around every job that writes to it - without
 * any of those jobs knowing.
 *
 * This wraps the `jobs` object the domains are handed, not the domains
 * themselves. PPPoE and binding go on constructing their own work exactly as
 * they did; what changes is that a spec whose `kind` is on the list below gains
 * an item at each end:
 *
 *   arm      snapshot the router and start its countdown
 *   ...      the domain's own items, untouched
 *   confirm  the change stands
 *
 * The middle is why it works at all. `onError: 'abort'` stops a job at the
 * first failed item, so a failure means the confirm item never runs, nobody
 * ever confirms, and the router puts itself back on its own. The failure path
 * needs no code because it is the *absence* of code - which is precisely the
 * property that makes it survive the connection dying half way through.
 */
import type { JobSpec, OpenWrtJob } from '../jobs'
import { agentCall, unwrap, type AgentDeps } from './client'

/**
 * The `jobs` shape a domain is handed.
 *
 * Structural, and deliberately the union of what the two domains ask for -
 * PPPoE reads the list, the agent domain reads `busy` - so that one wrapper
 * can stand in for the real `Jobs` wherever it is passed. Everything not
 * touched here is forwarded unchanged.
 */
export interface JobStarter {
  readonly busy: boolean
  start(spec: JobSpec): OpenWrtJob
  list(): OpenWrtJob[]
}

/**
 * Job kinds that change the router's network configuration, and so are worth
 * arming for.
 *
 * A list rather than "everything": the install and uninstall jobs arm their own
 * guards where it makes sense, a PPPoE start/stop wave changes no configuration
 * at all, and a countdown around work that cannot break the connection is a
 * countdown that only ever gets in the way.
 */
const GUARDED_KINDS = new Set([
  'pppoe-create',
  'pppoe-delete',
  'binding-prepare',
  'binding-start',
  'binding-stop',
  'binding-delete',
  'binding-unassign',
  'binding-reassign',
  'binding-pin'
])

/**
 * How long the router should wait before undoing an unconfirmed change.
 *
 * Scaled by the amount of work, because the countdown has to outlast the job it
 * is wrapped around: a five-thousand-session pool is written in chunks and
 * takes minutes, and a guard that expired in the middle of one would undo the
 * very change it exists to protect. The item count is the only measure of size
 * available before the work starts, and it tracks it well enough - each chunk
 * is one item.
 *
 * The floor is the agent's own default and the ceiling is what it will accept.
 */
function timeoutFor(items: number): number {
  return Math.min(3_600, Math.max(120, 120 + items * 30))
}

/**
 * Wrap a job starter so that risky kinds run under the router's guard.
 *
 * A router with no agent, or one too old to have the call, is handed straight
 * through: no extra items, no warning, nothing to notice. That is the module as
 * it has always worked, and it is a compatibility mode the surfaces already
 * carry a banner for - repeating it on every job would be noise, not news.
 */
export function guardedJobs(inner: JobStarter, deps: AgentDeps): JobStarter {
  return {
    get busy(): boolean {
      return inner.busy
    },

    list(): OpenWrtJob[] {
      return inner.list()
    },

    start(spec: JobSpec): OpenWrtJob {
      const capability = deps.capability()
      if (!capability.usable || !capability.canGuard || !GUARDED_KINDS.has(spec.kind)) {
        return inner.start(spec)
      }

      // The confirm item only means anything under `abort`. A job that carries
      // on past a failed item would reach it having half applied something, and
      // confirming that is the opposite of what the guard is for - so a spec
      // that asked to continue is handed through unwrapped rather than quietly
      // given different semantics.
      if ((spec.onError ?? 'abort') !== 'abort') return inner.start(spec)

      // Closed over rather than read back from the agent: what has to be
      // confirmed is the guard this job armed, and a second surface arming one
      // in between must not be confirmed by this job's success.
      let armed = false

      const items = [
        {
          name: 'Arm the safety net',
          run: async (): Promise<void | { warning: string }> => {
            const result = unwrap(
              await agentCall(deps, 'guard_arm', {
                reason: spec.kind,
                timeout: timeoutFor(spec.items.length)
              })
            )

            if (!result.ok) {
              // A warning, not a failure. The module wrote to routers without
              // any of this for its whole life; refusing to do the thing the
              // user asked for because the safety net could not be set up
              // would be a new way to fail rather than a safer one.
              return {
                warning: `no safety net for this change: ${result.error ?? 'the agent would not arm a guard'}`
              }
            }

            armed = true
          }
        },
        ...spec.items,
        {
          name: 'Confirm the change',
          run: async (): Promise<void | { warning: string }> => {
            if (!armed) return

            // Reaching this item at all is the proof that matters: every item
            // before it succeeded, over a connection that is evidently still
            // carrying commands.
            const result = unwrap(await agentCall(deps, 'guard_confirm'))
            if (!result.ok) {
              return {
                warning: `the change was applied but not confirmed, so this router will undo it: ${result.error ?? 'the agent did not answer'}`
              }
            }
          }
        }
      ]

      return inner.start({ ...spec, items })
    }
  }
}
