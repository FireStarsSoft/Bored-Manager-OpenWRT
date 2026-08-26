/**
 * Applying a frozen partial spec to a pool that exists: one `pool_set`, which
 * rewrites exactly the difference across every member and reloads what
 * changed. Inline rather than a job - the call is one round trip, and the
 * outcome lands in the event ring either way.
 */
import type { OkResult } from '@shared/types'
import { poolSet } from '../agent'
import { agentDeps, recordEvent, type PppoeRuntime } from './runtime'
import { asRecord } from './parse'
import { emitSummary, refreshCache } from './view'

export async function applyPoolSet(
  runtime: PppoeRuntime,
  idRaw: unknown,
  raw: unknown
): Promise<OkResult> {
  const payload = asRecord(raw)
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.session.take(token, payload.values)
  if (!taken) return { ok: false, error: 'that check expired or the form changed - check again' }
  if (!runtime.ctx.connected) return { ok: false, error: 'the router disconnected after the check' }

  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  if (taken.payload.creating || taken.payload.id !== id) {
    return { ok: false, error: 'that token belongs to another form - check again' }
  }

  const result = await poolSet(agentDeps(runtime), id, { ...taken.payload.spec })
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'the router refused the change' }
  }

  const changed = result.data?.changed
  const summary = changed
    ? `${changed.added.length} added, ${changed.removed.length} removed, ${changed.rewritten} rewritten`
    : 'applied'

  runtime.service.forceDump()
  await refreshCache(runtime, true)
  emitSummary(runtime)
  recordEvent(runtime, 'pppoe-set', `Pool ${id} updated: ${summary}`)

  return { ok: true, data: `Pool ${id}: ${summary}` }
}
