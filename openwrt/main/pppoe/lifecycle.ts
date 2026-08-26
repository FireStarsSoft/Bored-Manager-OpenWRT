/**
 * Deleting a pool: the one operation that works on legacy pools too.
 *
 * The daemon does the removal - interfaces down, sections and devices gone,
 * zone memberships dropped and the zone with them when nothing else keeps it,
 * record last. What this side adds is the binding gate: the daemon refuses
 * over a *configured* bm-wanbind instance, but only this side knows whether a
 * binding instance is actually running and distributing clients across the
 * pool's carrier right now, which is the state a delete would strand.
 */
import type { OkResult } from '@shared/types'
import { poolDelete } from '../agent'
import { agentDeps, recordEvent, type PppoeRuntime } from './runtime'
import { emitSummary, refreshCache } from './view'

/** `eth1.835` -> `eth1`: the device under whatever VLANs ride on it. */
function baseOf(device: string): string {
  const dot = device.indexOf('.')
  return dot >= 0 ? device.slice(0, dot) : device
}

export async function deletePool(
  runtime: PppoeRuntime,
  idRaw: unknown,
  forceRaw?: unknown
): Promise<OkResult> {
  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  if (!id) return { ok: false, error: 'no pool was named' }
  if (!runtime.ctx.connected) return { ok: false, error: 'the router is not connected' }
  if (runtime.deleting.has(id)) {
    return { ok: false, error: `pool ${id} is already being deleted` }
  }

  const force = forceRaw === true || forceRaw === 'true'
  const info = runtime.cache.info
  const carrier =
    info?.pools.find((pool) => pool.id === id)?.carrier ??
    info?.legacy.find((pool) => pool.id === id)?.carrier ??
    ''

  if (carrier && !force) {
    const binder = (runtime.service.bindingCarriers?.() ?? []).find(
      (instance) => instance.running && baseOf(instance.carrier) === baseOf(carrier)
    )
    if (binder) {
      return {
        ok: false,
        error:
          `binding instance "${binder.name}" is running on ${binder.carrier} and distributing ` +
          `LAN clients across this pool's sessions. Stop it first, on the WAN Binding tab - ` +
          'deleting the pool under it would leave those clients behind a fail-closed catch-all.'
      }
    }
  }

  const generation = runtime.generation
  runtime.deleting.add(id)

  let job
  try {
    job = runtime.jobs.start({
      kind: 'pppoe-delete',
      label: `Delete pool ${id}`,
      items: [
        {
          name: `Delete pool ${id} on the router`,
          run: async () => {
            const result = await poolDelete(agentDeps(runtime), id, force)
            if (!result.ok) {
              throw new Error(result.error ?? 'the router refused to delete the pool')
            }
          }
        },
        {
          name: 'Verify it is gone',
          run: async () => {
            runtime.service.forceDump()
            await refreshCache(runtime, true)
            if (generation !== runtime.generation) return
            const still =
              (runtime.cache.info?.pools ?? []).some((pool) => pool.id === id) ||
              (runtime.cache.info?.legacy ?? []).some((pool) => pool.id === id)
            if (still) throw new Error(`the router still lists pool ${id}`)
          }
        }
      ],
      onError: 'abort',
      onFinished: async (finished) => {
        runtime.deleting.delete(id)
        if (generation !== runtime.generation) return
        await refreshCache(runtime, true)
        emitSummary(runtime)
        recordEvent(runtime, 'pppoe-delete', `Pool ${id} delete job ${finished.state}`)
      }
    })
  } catch (error) {
    runtime.deleting.delete(id)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return { ok: true, data: job.id }
}
