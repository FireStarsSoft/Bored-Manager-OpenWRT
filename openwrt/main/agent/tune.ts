/**
 * The router-wide scale limits, driven through the agent.
 *
 * `tune_get`/`tune_set` arrived with packages 2.1.0, and the agent's
 * `apiVersion` deliberately did not move for them: bumping it would make every
 * 3.0.x module in the field read the new agent as unusable and lose the pool
 * daemon with it. So these calls are gated on the agent's *release*, which the
 * probe already carries, and an agent that answers "Method not found" anyway
 * is translated into the sentence that names the fix.
 *
 * What travels is an allowlist mirrored from `bm.tune` on the router:
 * conntrack_max, the three neighbour-cache thresholds, and fw4's flow
 * offload. The daemon validates bounds and ordering again - this side's
 * checks exist so a typo is refused while the person is still looking at the
 * form, not in a notification.
 */
import type { AgentCapability } from '../probe'
import { AGENT_OBJECT, objectCall, type AgentCallResult, type AgentDeps } from './client'

/** The first packages release whose agent publishes tune_get/tune_set. */
export const TUNE_AGENT_RELEASE = '2.1.0'

/** Writing sysctls is instant; the fw4 reload behind flow_offload is not. */
const TUNE_TIMEOUT_MS = 60_000

/**
 * Whether the agent's release is at least `minimum`, part by part. An
 * unparseable part reads as older, because "cannot tell" must never unlock a
 * call the router may not have.
 */
export function agentAtLeast(capability: AgentCapability, minimum: string): boolean {
  if (!capability.usable) return false
  const left = String(capability.release ?? '').split('.')
  const right = minimum.split('.')
  for (let index = 0; index < right.length; index++) {
    const have = Number.parseInt(left[index] ?? '', 10)
    const need = Number.parseInt(right[index] ?? '0', 10)
    if (!Number.isFinite(have)) return false
    if (have > need) return true
    if (have < need) return false
  }
  return true
}

/** What the router holds right now; null where it could not be read. */
export interface TuneValues {
  conntrack_max: number | null
  gc_thresh1: number | null
  gc_thresh2: number | null
  gc_thresh3: number | null
  conntrack_count: number | null
  flow_offload: boolean | null
}

export interface TuneState {
  ok: boolean
  values: TuneValues
  /** What the drop-in pins across reboots, `sysctl name -> value`. */
  persisted: Record<string, number>
  /** Where it pins them: /etc/sysctl.d/60-bm-scale.conf. */
  file: string
}

export interface TuneApplied {
  ok: boolean
  reason?: string
  applied?: Record<string, number>
  persisted?: boolean
  file?: string
  flowOffload?: boolean | null
  reloaded?: boolean
}

/** The subset a caller wants changed. Absent keys are left alone. */
export interface TuneWanted {
  conntrackMax?: number
  gcThresh1?: number
  gcThresh2?: number
  gcThresh3?: number
  flowOffload?: boolean
}

export function tuneGet(deps: AgentDeps): Promise<AgentCallResult<TuneState>> {
  return objectCall<TuneState>(deps, AGENT_OBJECT, 'tune_get')
}

export function tuneSet(deps: AgentDeps, wanted: TuneWanted): Promise<AgentCallResult<TuneApplied>> {
  const args: Record<string, unknown> = {}
  if (typeof wanted.conntrackMax === 'number') args.conntrack_max = Math.trunc(wanted.conntrackMax)
  if (typeof wanted.gcThresh1 === 'number') args.gc_thresh1 = Math.trunc(wanted.gcThresh1)
  if (typeof wanted.gcThresh2 === 'number') args.gc_thresh2 = Math.trunc(wanted.gcThresh2)
  if (typeof wanted.gcThresh3 === 'number') args.gc_thresh3 = Math.trunc(wanted.gcThresh3)
  if (typeof wanted.flowOffload === 'boolean') args.flow_offload = wanted.flowOffload

  return objectCall<TuneApplied>(deps, AGENT_OBJECT, 'tune_set', args, TUNE_TIMEOUT_MS)
}
