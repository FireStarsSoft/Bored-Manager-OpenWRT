/**
 * The daemon's own settings: the counter pass and the watchdog. Read for the
 * form's initial values, checked against the same bounds the daemon holds,
 * applied over ubus and re-armed there immediately.
 */
import {
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { OkResult } from '@shared/types'
import { poolSettingsSet, type PoolSettings } from '../agent'
import { agentDeps, recordEvent, type PppoeRuntime } from './runtime'
import { asRecord } from './parse'
import { refreshCache } from './view'

interface Bound {
  key: keyof Omit<PoolSettings, 'enabled'>
  label: string
  min: number
  max: number
}

/** The same numbers config.uc enforces; two gates, one truth each side shows. */
const BOUNDS: readonly Bound[] = [
  { key: 'counter_interval', label: 'Counter interval', min: 1, max: 300 },
  { key: 'redial_after', label: 'Redial after', min: 0, max: 86_400 },
  { key: 'redial_batch', label: 'Redial batch', min: 1, max: 500 }
]

export function settingsGet(runtime: PppoeRuntime): PoolSettings {
  return (
    runtime.cache.info?.settings ?? {
      enabled: true,
      counter_interval: 5,
      redial_after: 120,
      redial_batch: 20
    }
  )
}

export function settingsCheck(runtime: PppoeRuntime, raw: unknown): ModuleCheckReport {
  const values = asRecord(raw)
  const findings: ModuleCheckFinding[] = []
  const entered: Partial<PoolSettings> = {}

  for (const bound of BOUNDS) {
    const raw = values[bound.key]
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
    if (!text) continue
    const value = Number(text)
    if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
      findings.push({
        level: 'error',
        label: `${bound.label} must be a whole number ${bound.min}-${bound.max}`
      })
      continue
    }
    entered[bound.key] = value
  }

  if (!Object.keys(entered).length && !hasBlockingFinding(findings)) {
    findings.push({
      level: 'error',
      label: 'Nothing was entered',
      detail: 'A blank field keeps the value in force; fill in at least one.'
    })
  }

  if (!hasBlockingFinding(findings)) {
    const current = settingsGet(runtime)
    const changed = (Object.keys(entered) as Array<keyof typeof entered>).filter(
      (key) => entered[key] !== current[key]
    )
    findings.push({
      level: changed.length ? 'pass' : 'info',
      label: changed.length
        ? `${changed.length} setting(s) change: ${changed.join(', ')}`
        : 'Every value entered is already in force',
      detail:
        'Applied on the router immediately: the counter timer is re-armed and the watchdog uses the new numbers on its next pass.'
    })
  }

  const ok = !hasBlockingFinding(findings)
  return ok
    ? { ok: true, token: runtime.settingsSession.issue(values, entered), findings }
    : { ok: false, findings }
}

export async function settingsApply(runtime: PppoeRuntime, raw: unknown): Promise<OkResult> {
  const payload = asRecord(raw)
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.settingsSession.take(token, payload.values)
  if (!taken) return { ok: false, error: 'that check expired or the form changed - check again' }
  if (!runtime.ctx.connected) return { ok: false, error: 'the router is not connected' }

  const result = await poolSettingsSet(agentDeps(runtime), taken.payload)
  if (!result.ok) return { ok: false, error: result.error ?? 'the router refused' }

  await refreshCache(runtime, true)
  recordEvent(runtime, 'pppoe-settings', 'Daemon settings applied')
  return { ok: true }
}
