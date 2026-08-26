/**
 * Turning a frozen spec into a pool on the router.
 *
 * One call does the work: the daemon validates the same spec again, writes
 * the record, reconciles the network sections and the firewall, and reloads
 * both - record first, so a create interrupted anywhere leaves something its
 * own delete can clean. What is left for this side is the job that gives the
 * operation a history entry, and the verify step that reads the pool back.
 *
 * The passwords live in the frozen spec and in the 0600 file the client
 * writes on the router - never in the record here, a job label, or an event.
 */
import type { OkResult } from '@shared/types'
import { poolCreate } from '../agent'
import { agentDeps, recordEvent, type PppoeRuntime } from './runtime'
import { asRecord } from './parse'
import { emitSummary, refreshCache } from './view'

export async function applyPool(runtime: PppoeRuntime, raw: unknown): Promise<OkResult> {
  const payload = asRecord(raw)
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.session.take(token, payload.values)
  if (!taken) return { ok: false, error: 'that check expired or the form changed - check again' }
  if (!runtime.ctx.connected) return { ok: false, error: 'the router disconnected after the check' }
  if (!taken.payload.creating) {
    return { ok: false, error: 'that token belongs to an edit - check again' }
  }

  const { id, spec } = taken.payload
  const wanted = spec.members?.length ?? 0
  const generation = runtime.generation

  let job
  try {
    job = runtime.jobs.start({
      kind: 'pppoe-create',
      label: `Create pool ${id} (${wanted} interface${wanted === 1 ? '' : 's'})`,
      items: [
        {
          name: `Create pool ${id} on the router`,
          run: async () => {
            const result = await poolCreate(agentDeps(runtime), id, { ...spec })
            if (!result.ok) {
              throw new Error(result.error ?? 'the router refused to create the pool')
            }
          }
        },
        {
          name: 'Verify the pool against the router',
          run: async () => {
            runtime.service.forceDump()
            await refreshCache(runtime, true)
            if (generation !== runtime.generation) return
            const pool = (runtime.cache.info?.pools ?? []).find((entry) => entry.id === id)
            if (!pool) {
              throw new Error(`the router does not list pool ${id} after the create`)
            }
            if (pool.members !== wanted) {
              throw new Error(
                `the router lists ${pool.members} member(s) where ${wanted} were sent`
              )
            }
            if (pool.unwritten > 0) {
              return {
                warning: `${pool.unwritten} member(s) are recorded but not written - edit the pool to repair them`
              }
            }
          }
        }
      ],
      onError: 'abort',
      onFinished: async (finished) => {
        if (generation !== runtime.generation) return
        await refreshCache(runtime, true)
        emitSummary(runtime)
        recordEvent(
          runtime,
          'pppoe-create',
          `Pool ${id} create job ${finished.state} (${wanted} interface(s))`
        )
      }
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return { ok: true, data: job.id }
}
