/**
 * Whether the collector itself is still working, and how that reaches a screen.
 *
 * Every failure here is latched, so the reason is recorded once per streak
 * rather than on every tick. The text is always ours: router stdout and stderr
 * never enter it, because the slow probe reads `uci show network` and the fast
 * one shares its executor with the paths that carry PPPoE passwords.
 */
import type { CollectorHealth, OpenWrtOverview } from '../types'
import type { SweepRuntime } from './runtime'

export function collectorHealth(runtime: SweepRuntime): CollectorHealth {
  return {
    fastOk: !runtime.fastFailed,
    slowOk: !runtime.slowFailed,
    dumpOk: !runtime.dumpFailed,
    hookOk: !runtime.hookFailed,
    lastFastT: runtime.lastFastT,
    lastSlowT: runtime.slowAt,
    lastError: runtime.lastError
  }
}

/**
 * Failures are latched, so this records the reason once per streak rather
 * than on every tick. The text is ours, never the router's stderr.
 */
export function noteError(runtime: SweepRuntime, message: string): void {
  runtime.lastError = message.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300)
}

/**
 * Re-push the last overview carrying fresh health. Used only by the paths
 * that give up on a tick before `publish` runs - otherwise the numbers on
 * screen stay put with nothing to say they stopped moving. Nothing is sent
 * before the first successful sample: an invented payload would read as a
 * router reporting zero of everything.
 */
export function reportHealth(runtime: SweepRuntime): void {
  const previous = runtime.overview
  if (!previous) return
  // A copy, not a mutation: the payload already pushed for this sample is
  // the one a surface may still be holding.
  const overview: OpenWrtOverview = { ...previous, health: collectorHealth(runtime) }
  runtime.overview = overview
  runtime.ctx.emit('overview', overview)
}
