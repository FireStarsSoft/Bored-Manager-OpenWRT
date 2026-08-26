/**
 * The one place a point is appended to the metrics history the dashboard's
 * charts read back.
 *
 * It used to live at the end of the slow tick, which made the charts one point
 * per minute whatever the fast sweep was doing: the live tiles moved every two
 * seconds and the graph under them was a staircase. The sample is paced by
 * `historySampleSec` instead, and both ticks offer one - the fast tick because
 * that is where a fresh overview comes from, the slow tick because it is the
 * floor that keeps a router with a stalled fast sweep on the chart at all.
 */
import type { SweepRuntime } from './runtime'

/**
 * Write one history point if the configured interval has elapsed.
 *
 * Two guards, and they answer different questions. `historyModelAt` is "has the
 * sweep produced anything new" - without it a slow tick on a router whose fast
 * sweep has stopped would archive the same numbers forever, and the chart would
 * show a flat line rather than the gap that is the truth. `historyAt` is "is it
 * time yet", which is the setting.
 *
 * Returns whether a point was written, which is only of interest to a test.
 */
export function sampleHistory(runtime: SweepRuntime, at: number): boolean {
  const overview = runtime.overview
  if (!overview || overview.t === runtime.historyModelAt) return false
  const everyMs = Math.max(1, runtime.config.effectiveRules().historySampleSec) * 1_000
  // `>=` rather than `>`, so a router configured at the same cadence as its
  // sweep does not silently drop every other point to timer jitter.
  if (runtime.historyAt !== 0 && at - runtime.historyAt < everyMs) return false
  runtime.historyModelAt = overview.t
  runtime.historyAt = at
  runtime.ctx.addHistory({
    t: at,
    wanUp: overview.counts.wanUp,
    wanErr: overview.counts.wanErr,
    devices: overview.counts.devices,
    // Kept next to the device count on purpose: "40 devices" says nothing on
    // its own, and reading it against how many of them held a WAN is the only
    // way to see a pool that ran out overnight.
    bound: overview.counts.bound,
    waiting: overview.counts.waiting,
    rx: overview.poolAgg.rx,
    tx: overview.poolAgg.tx,
    // Persisted alongside the traffic so the history charts can show a router
    // that ran out of memory next to the throughput that stopped.
    load1: overview.sys.load1,
    memPct: overview.sys.memPct
  })
  return true
}
