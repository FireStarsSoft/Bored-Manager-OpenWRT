/**
 * The fast sweep: one command, one model, one pushed overview.
 *
 * Only the cheap sections run every tick. `network.interface dump` is the
 * expensive one and is asked for on a cadence that widens with the size of the
 * pool, on demand after a mutation or a reboot, and never again for a few ticks
 * once it has come back unreadable - a heavy command that cannot succeed is
 * worse than no command at all. Whatever the dump does, the last good interface
 * list survives it.
 */
import { splitSections } from '@shared/shell'
import {
  parseDump,
  parseIpRules,
  parseLeases,
  parseProcNetDev,
  parseSystemInfo
} from '../parse'
import {
  POOL_RATE_KEY,
  type DeviceCounters,
  type OpenWrtSeriesPoint,
  type ProcNetDevSnapshot,
  type RouterModel
} from '../types'
import {
  EXEC_TIMEOUT_MS,
  buildFastSweepCommand,
  isManagedRange,
  type ManagedPppoeRange
} from './command'
import { noteError, reportHealth } from './health'
import { sampleHistory } from './history'
import { buildOverview } from './overview'
import { activeLeases, routerLocaltime, validDump } from './parse'
import { isCurrent, type SweepRuntime } from './runtime'

/**
 * Ticks to wait before asking for the heavy interface dump again after one
 * came back unusable - unparseable on its own, or big enough to push the whole
 * sweep past the executor's output cap. Retrying it every tick costs a
 * `network.interface dump` per tick for as long as the condition lasts, and the
 * conditions that cause it do not clear on their own.
 */
const DUMP_RETRY_TICKS = 5
const SERIES_WINDOW_MS = 5 * 60 * 1_000

/** How many ticks a router this size may go between interface dumps. */
function dumpCadence(ifaceCount: number): number {
  if (ifaceCount <= 500) return 1
  if (ifaceCount <= 2_000) return 2
  return 3
}

export function forceDumpNextTick(runtime: SweepRuntime): void {
  runtime.dumpNextTick = true
  // An explicit request - a mutation, a reboot, a manual Sweep - outranks a
  // back-off that only exists to stop the module retrying on its own.
  runtime.dumpBackoff = 0
}

function calculateRates(
  runtime: SweepRuntime,
  current: ProcNetDevSnapshot,
  at: number
): Record<string, DeviceCounters> {
  const rates: Record<string, DeviceCounters> = Object.create(null) as Record<
    string,
    DeviceCounters
  >
  const deltaSec = runtime.previousAt ? (at - runtime.previousAt) / 1_000 : 0
  const elapsed = deltaSec > 0 ? Math.max(deltaSec, 0.001) : 0
  const rate = (now: number, before: number | undefined): number =>
    elapsed > 0 && before != null ? Math.max(0, (now - before) / elapsed) : 0
  for (const [name, counters] of Object.entries(current.devices)) {
    const previous = runtime.previousDev?.devices[name]
    rates[name] = {
      rx: rate(counters.rx, previous?.rx),
      tx: rate(counters.tx, previous?.tx)
    }
  }
  rates[POOL_RATE_KEY] = {
    rx: rate(current.poolDev.rx, runtime.previousDev?.poolDev.rx),
    tx: rate(current.poolDev.tx, runtime.previousDev?.poolDev.tx)
  }
  runtime.previousAt = at
  runtime.previousDev = current
  return rates
}

function publish(
  runtime: SweepRuntime,
  model: RouterModel,
  ranges: readonly ManagedPppoeRange[]
): void {
  runtime.lastFastT = model.t
  const overview = buildOverview(runtime, model, ranges)
  runtime.overview = overview
  const point: OpenWrtSeriesPoint = {
    t: model.t,
    rx: overview.poolAgg.rx,
    tx: overview.poolAgg.tx,
    wanUp: overview.counts.wanUp,
    wanErr: overview.counts.wanErr,
    devices: overview.counts.devices,
    bound: overview.counts.bound,
    waiting: overview.counts.waiting,
    load1: model.sys.load1,
    memPct: overview.sys.memPct
  }
  runtime.series.push(point)
  const cutoff = point.t - SERIES_WINDOW_MS
  while (runtime.series.length && runtime.series[0].t < cutoff) runtime.series.shift()
  runtime.ctx.emit('overview', overview)
  runtime.ctx.emit('series', point)
  // The archive behind the charts, paced by `historySampleSec` rather than by
  // whichever tick happens to be running. The live tail the chart draws on top
  // of it is the `series` point above.
  sampleHistory(runtime, point.t)
}

export async function sampleFast(runtime: SweepRuntime, generation: number): Promise<void> {
  if (!isCurrent(runtime, generation)) return
  const rules = runtime.config.effectiveRules()
  // From the pool cache - the router is the record - and filtered before the
  // spec is interpolated into a command: a range whose bounds make no sense
  // would match either everything or nothing.
  const ranges = (runtime.hooks.pppoeRanges?.() ?? []).filter(isManagedRange)
  runtime.ticksSinceDump += 1
  if (runtime.dumpBackoff > 0) runtime.dumpBackoff -= 1
  const cadence = dumpCadence(runtime.cachedIfaces.length)
  const includeDump =
    runtime.dumpBackoff === 0 &&
    (runtime.dumpNextTick ||
      runtime.cachedIfaces.length === 0 ||
      runtime.ticksSinceDump >= cadence)
  if (includeDump) runtime.dumpNextTick = false

  let result
  try {
    result = await runtime.ctx.exec(buildFastSweepCommand(rules, ranges, includeDump), {
      timeoutMs: EXEC_TIMEOUT_MS
    })
  } catch (error) {
    if (isCurrent(runtime, generation) && !runtime.fastFailed) {
      runtime.fastFailed = true
      const message = `fast sweep failed (${error instanceof Error ? error.message : String(error)})`
      runtime.ctx.log(`openwrt: ${message}`)
      noteError(runtime, message)
      reportHealth(runtime)
    }
    return
  }
  if (!isCurrent(runtime, generation)) return
  if (result.code === 125 || result.stderr.includes('[overflow]')) {
    // The executor truncated stdout at its output cap, so the tail sections
    // (RULESOK, DUMP) are simply gone. Parsing what arrived would read as
    // "ip rule failed" plus an unparseable dump on every tick, with nothing
    // in the log to explain why the dashboard reports zero interfaces.
    //
    // The interface dump is the only section that grows with the router - the
    // others are aggregated or filtered router-side - so it is the one to drop.
    // Without this back-off every following tick asked for it again and
    // overflowed again, which is why the message used to tell the user to
    // dismantle a pool that works: nothing else ever got through.
    runtime.dumpNextTick = false
    runtime.dumpBackoff = DUMP_RETRY_TICKS
    if (!runtime.fastFailed) {
      runtime.fastFailed = true
      const message =
        'fast sweep output exceeded the command output limit; the interface dump is skipped for the next few ticks so the rest of the sample gets through, and the dashboard keeps the last interface list it could read'
      runtime.ctx.log(`openwrt: ${message}`)
      noteError(runtime, message)
      reportHealth(runtime)
    }
    return
  }
  if (result.code !== 0 && !result.stdout.trim()) {
    if (!runtime.fastFailed) {
      runtime.fastFailed = true
      const message = `fast sweep returned no data (exit ${result.code})`
      runtime.ctx.log(
        `openwrt: fast sweep returned no data (${(result.stderr || `exit ${result.code}`).trim().slice(0, 200)})`
      )
      noteError(runtime, message)
      reportHealth(runtime)
    }
    return
  }
  runtime.fastFailed = false

  const sections = splitSections(result.stdout)
  const rulesOk = (sections.get('RULESOK') ?? '').trim() === '1'
  if (!rulesOk && isCurrent(runtime, generation)) {
    runtime.ctx.log('openwrt: ip -4 rule show failed; skipping binding reconcile')
  }
  const systemText = sections.get('SYS') ?? ''
  const system = parseSystemInfo(systemText)
  const rebooted =
    runtime.previousUptime > 0 &&
    system.uptimeSec > 0 &&
    system.uptimeSec + 5 < runtime.previousUptime
  if (rebooted) {
    runtime.previousAt = 0
    runtime.previousDev = null
    forceDumpNextTick(runtime)
    // The notice is recorded through `onRouterReboot` below, which logs it
    // and puts it in the module's own event trail. It used to be emitted
    // here as a bare string on `bindingLog`; the `log` block routes by
    // `{ id, data }`, so the renderer dropped it and the reboot showed up
    // nowhere a user could see.
  }
  runtime.previousUptime = system.uptimeSec

  if (includeDump) {
    const dump = sections.get('DUMP') ?? ''
    if (validDump(dump)) {
      runtime.cachedIfaces = parseDump(dump)
      runtime.ticksSinceDump = 0
      runtime.dumpFailed = false
    } else {
      // A failed heavy section must not erase the last good model. Asking
      // for it again straight away only helps when it was a one-off; when
      // the dump itself cannot come back whole - past ubus's own message
      // limit, or truncated on the way here - that is one wasted heavy
      // command every single tick, silently, forever.
      runtime.dumpNextTick = true
      runtime.dumpBackoff = DUMP_RETRY_TICKS
      if (!runtime.dumpFailed) {
        runtime.dumpFailed = true
        const message = `interface dump unparseable (${dump.length} bytes); keeping the last known interface list`
        runtime.ctx.log(`openwrt: ${message}`)
        // No re-emit here: this tick still publishes, health and all.
        noteError(runtime, message)
      }
    }
  }
  const ifaces = runtime.cachedIfaces.map((iface) => ({
    ...iface,
    errorCode:
      iface.errorCode || (!iface.up ? runtime.pppoeErrors[iface.name] : undefined)
  }))
  const dev = parseProcNetDev(sections.get('DEV') ?? '')
  const at = Date.now()
  const model: RouterModel = {
    t: at,
    sys: system,
    ifaces,
    poolDev: dev.poolDev,
    leases: activeLeases(
      parseLeases(sections.get('LEASES') ?? ''),
      at,
      routerLocaltime(systemText)
    ),
    rules: rulesOk
      ? parseIpRules(sections.get('RULES') ?? '')
      : (runtime.latest?.rules ?? []),
    rates: calculateRates(runtime, dev, at)
  }
  runtime.latest = model

  try {
    // A reboot is worth reporting whether or not `ip rule` answered - the
    // reconcile is what needs the rule list, not the notice. Gating the two
    // together meant the one sample that most needs explaining, a router
    // that came back up with its rules gone, said nothing at all.
    if (rebooted) await runtime.hooks.onRouterReboot?.(model)
    if (rulesOk) await runtime.hooks.onSample?.(model)
    runtime.hookFailed = false
  } catch (error) {
    if (isCurrent(runtime, generation) && !runtime.hookFailed) {
      runtime.hookFailed = true
      const message = `automation reconcile failed (${error instanceof Error ? error.message : String(error)})`
      runtime.ctx.log(`openwrt: ${message}`)
      // The publish below carries the flag; no separate emit.
      noteError(runtime, message)
    }
  }
  if (!isCurrent(runtime, generation)) return
  publish(runtime, model, ranges)
}
