/**
 * The five per-member actions, and the three per-pool bulk ones.
 *
 * All of them are one daemon call. `enable` and `disable` write configuration
 * on the router - `option auto '0'`, the one per-member state there is - and
 * the daemon owns that write like every other. The old module-side watchdog
 * is gone with the rest: the daemon redials what stays down, on the settings
 * the Daemon settings form edits.
 */
import type { FormFieldOption } from '@shared/module-ui'
import type { OkResult } from '@shared/types'
import { poolAction, poolCarriers, poolReconcile, type PoolActionName } from '../agent'
import { agentDeps, recordEvent, type PppoeRuntime } from './runtime'
import { emitSummary, poolSections, refreshCache } from './view'

const ACTIONS: readonly PoolActionName[] = ['up', 'down', 'redial', 'enable', 'disable']
const ACTION_LIMIT = 500

function actionOf(raw: unknown): PoolActionName | null {
  return typeof raw === 'string' && (ACTIONS as readonly string[]).includes(raw)
    ? (raw as PoolActionName)
    : null
}

async function runAction(
  runtime: PppoeRuntime,
  action: PoolActionName,
  sections: string[]
): Promise<OkResult> {
  if (!runtime.ctx.connected) return { ok: false, error: 'the router is not connected' }
  if (!sections.length) return { ok: false, error: 'no interface was named' }
  if (sections.length > ACTION_LIMIT) {
    return { ok: false, error: `at most ${ACTION_LIMIT} interfaces in one call` }
  }

  const result = await poolAction(agentDeps(runtime), action, sections)
  if (!result.ok) return { ok: false, error: result.error ?? 'the router refused' }

  runtime.service.forceDump()
  await refreshCache(runtime, true)
  emitSummary(runtime)
  recordEvent(
    runtime,
    'pppoe-action',
    `${action} on ${result.data?.sections.length ?? sections.length} interface(s)`
  )
  return { ok: true }
}

/**
 * Rows send a single name (`argsFromRow`), bulk toolbars send the ticked
 * list; both land here.
 */
export function connAction(
  runtime: PppoeRuntime,
  namesRaw: unknown,
  actionRaw: unknown
): Promise<OkResult> {
  const action = actionOf(actionRaw)
  if (!action) {
    return Promise.resolve({
      ok: false,
      error: 'the action has to be up, down, redial, enable or disable'
    })
  }

  const names = (Array.isArray(namesRaw) ? namesRaw : [namesRaw])
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter(Boolean)

  return runAction(runtime, action, names)
}

/** Start all / Stop all / Redial all on one pool: its member list, one call. */
export function bulkPoolAction(
  runtime: PppoeRuntime,
  idRaw: unknown,
  actionRaw: unknown
): Promise<OkResult> {
  const action = actionOf(actionRaw)
  if (!action) {
    return Promise.resolve({
      ok: false,
      error: 'the action has to be up, down, redial, enable or disable'
    })
  }

  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  const sections = poolSections(runtime, id)
  if (!sections.length) {
    return Promise.resolve({
      ok: false,
      error: id ? `no rows are known for pool ${id} yet - refresh first` : 'no pool was named'
    })
  }

  return runAction(runtime, action, sections)
}

/**
 * The devices a pool could dial over, as the create form's select wants
 * them. Empty on any failure: a select with no options and a help line under
 * it beats a form that refuses to open.
 */
export async function carrierOptions(runtime: PppoeRuntime): Promise<FormFieldOption[]> {
  if (!runtime.ctx.connected) return []

  const result = await poolCarriers(agentDeps(runtime))
  if (!result.ok || !result.data) return []

  return result.data.carriers.map((carrier) => ({
    value: carrier.name,
    label: `${carrier.name}${carrier.up ? '' : ' (down)'}${carrier.macaddr ? ` — ${carrier.macaddr}` : ''}`
  }))
}

/** What Refresh now presses: the daemon re-reads netifd and the counters. */
export async function sweepPools(runtime: PppoeRuntime): Promise<OkResult> {
  if (!runtime.ctx.connected) return { ok: false, error: 'the router is not connected' }

  const result = await poolReconcile(agentDeps(runtime))
  if (!result.ok) return { ok: false, error: result.error ?? 'the router refused' }

  await refreshCache(runtime, true)
  emitSummary(runtime)
  return { ok: true }
}
