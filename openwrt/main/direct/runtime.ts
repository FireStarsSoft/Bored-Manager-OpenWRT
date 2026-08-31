/**
 * The mutable state one-to-one binding carries between passes, and the two
 * things every path does with it: run one at a time, and check it is still ours
 * to touch.
 *
 * These are the instance half's `exclusive()` and `current()` written again
 * rather than shared. They are three lines each and they close over a runtime
 * of this folder's own shape; publishing them from the binding barrel would
 * have made the serialization queue of one automation reachable from the other,
 * which is the one thing a per-engine queue must not be.
 *
 * Work is serialized because a pass awaits SSH for seconds, and an Enable
 * arriving in that window would plan against rules the other half is still
 * writing. `workGeneration` is what makes a reset or a disconnect abandon that
 * queue instead of letting it land on a router nobody is looking at any more.
 */
import { createCheckSession } from '@shared/check'
import type { OkResult } from '@shared/types'
import { ENGINE_STOPPED } from '../binding'
import type { DirectEngineOptions, DirectPlan, DirectRuntime, DirectSnapshot } from './types'

export function createDirectRuntime(options: DirectEngineOptions): DirectRuntime {
  return {
    ctx: options.ctx,
    store: options.store,
    options,
    checkSession: createCheckSession<DirectPlan>(),
    latestPayload: emptyDirectSnapshot(),
    memory: new Map(),
    preparations: new Map(),
    serial: Promise.resolve(),
    workGeneration: 0,
    disposed: false
  }
}

/** Nothing sampled yet, which is not the same statement as a failed pass. */
export function emptyDirectSnapshot(): DirectSnapshot {
  return {
    t: 0,
    hookOk: true,
    lastError: '',
    rows: [],
    totals: { ok: 0, held: 0, total: 0 }
  }
}

export function current(runtime: DirectRuntime, generation: number): boolean {
  return !runtime.disposed && generation === runtime.workGeneration && runtime.ctx.connected
}

export function exclusive<T>(runtime: DirectRuntime, run: () => Promise<T>): Promise<T> {
  const generation = runtime.workGeneration
  const guarded = (): Promise<T> =>
    current(runtime, generation) ? run() : Promise.reject(new Error(ENGINE_STOPPED))
  const pending = runtime.serial.then(guarded, guarded)
  runtime.serial = pending.then(
    () => undefined,
    () => undefined
  )
  return pending
}

/**
 * Every operator-triggered mutation becomes a job so the failure is visible in
 * the job list rather than only in a returned error nobody reads.
 */
export async function runMutationJob(
  runtime: DirectRuntime,
  kind: string,
  label: string,
  work: () => Promise<OkResult>
): Promise<OkResult> {
  if (!runtime.options.jobs) return work()
  try {
    const job = runtime.options.jobs.start({
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
      onError: 'abort'
    })
    return { ok: true, data: job.id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
