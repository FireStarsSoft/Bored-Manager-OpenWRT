/**
 * Wrapping a change in the router's own undo.
 *
 * `bmctl config guard` takes a snapshot, writes a deadline and starts a timer
 * that is a separate process from anything the module is doing. So:
 *
 *   arm  ->  apply  ->  ask the router a trivial question  ->  confirm
 *
 * The trivial question is the whole point. If the change took the connection
 * down, that question does not come back, the confirm never happens, and the
 * router puts itself right two minutes later with nobody watching. There is no
 * way to write that check on this side of the connection: a module that has
 * lost the router cannot tell it anything, including "undo".
 *
 * Everything degrades rather than refuses. A router with no agent has no guard,
 * and it also has no way to get one without installing packages - so the apply
 * runs anyway and the caller is told it ran unguarded. That is how the module
 * behaved for its whole life before any of this existed; the safety net is an
 * improvement on it, not a precondition for it.
 */
import { agentCall, unwrap, type AgentDeps } from './client'

/** What the router reports back when a guard is armed. */
interface ArmReply {
  ok?: boolean
  reason?: string
  snapshot?: string
  deadline?: number
  timeout?: number
}

export interface GuardState {
  /** A countdown is running, so the change below can undo itself. */
  armed: boolean
  /** The snapshot it would restore. Empty when nothing is armed. */
  snapshot: string
  /** Seconds the router will wait before restoring. */
  timeout: number
  /**
   * Why there is no guard, when there is none. Null when one is armed - and
   * also null when the router has no agent at all, because that is not a fault
   * to report on every apply, it is the compatibility mode the surfaces already
   * carry a banner for.
   */
  note: string | null
}

const UNGUARDED: GuardState = { armed: false, snapshot: '', timeout: 0, note: null }

export async function armGuard(
  deps: AgentDeps,
  reason: string,
  timeoutSec?: number
): Promise<GuardState> {
  const capability = deps.capability()

  // No agent, or one too old to have the call. Neither is worth a warning on
  // every apply: the readiness card says it once, in the right place.
  if (!capability.usable || !capability.canGuard) return UNGUARDED

  const args: Record<string, unknown> = { reason }
  if (typeof timeoutSec === 'number' && timeoutSec > 0) args.timeout = Math.trunc(timeoutSec)

  const result = unwrap(await agentCall<ArmReply>(deps, 'guard_arm', args))

  if (!result.ok || !result.data) {
    // The agent is there and would not arm. Worth saying, because the user is
    // about to change something with no way back and the reason may be one they
    // can fix - a guard already armed by another surface, most often.
    return { ...UNGUARDED, note: result.error ?? 'The agent would not arm a guard.' }
  }

  return {
    armed: true,
    snapshot: typeof result.data.snapshot === 'string' ? result.data.snapshot : '',
    timeout: typeof result.data.timeout === 'number' ? result.data.timeout : 0,
    note: null
  }
}

/**
 * Keep the change - but only after the router has answered something.
 *
 * The question is deliberately the cheapest one there is. What is being tested
 * is not the router's health, it is whether this connection still carries a
 * command; a heavier check would fail for reasons that have nothing to do with
 * the change and undo something that was fine.
 */
export async function confirmGuard(deps: AgentDeps, guard: GuardState): Promise<boolean> {
  if (!guard.armed) return false

  try {
    const alive = await deps.ctx.exec('true', { timeoutMs: 10_000 })
    if (alive.code !== 0) return false
  } catch {
    // The connection is gone. Saying nothing is exactly right: the timer on the
    // router is still counting, and it is now the only thing that can help.
    return false
  }

  const result = unwrap(await agentCall(deps, 'guard_confirm'))
  return result.ok
}

/**
 * Put it back now rather than in two minutes.
 *
 * Called when an apply failed on this side: the router may be half changed, the
 * connection is evidently still up, and waiting out the deadline would leave it
 * that way for no reason.
 */
export async function cancelGuard(deps: AgentDeps, guard: GuardState): Promise<boolean> {
  if (!guard.armed) return false
  const result = unwrap(await agentCall(deps, 'guard_cancel'))
  return result.ok
}

/**
 * The whole cycle around one change.
 *
 * `run` is the change. Whatever it returns comes back untouched, with the guard
 * state beside it so a caller can tell the user which of the two things
 * happened: applied with a net under it, or applied without one.
 */
export async function underGuard<T>(
  deps: AgentDeps,
  reason: string,
  run: () => Promise<T>,
  options: { timeoutSec?: number } = {}
): Promise<{ result: T; guard: GuardState; confirmed: boolean }> {
  const guard = await armGuard(deps, reason, options.timeoutSec)

  let result: T
  try {
    result = await run()
  } catch (error) {
    await cancelGuard(deps, guard)
    throw error
  }

  const confirmed = await confirmGuard(deps, guard)
  return { result, guard, confirmed }
}
