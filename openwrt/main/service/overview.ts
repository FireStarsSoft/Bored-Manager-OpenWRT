/**
 * The dashboard payload: one `RouterModel` folded down to something small
 * enough to push on every tick.
 *
 * The pool is the reason this is not a straight projection. A managed PPPoE
 * session is never a row - ten thousand of them would be ten thousand rows on
 * every sample - so pool members are counted into `poolAgg` and everything else
 * is listed, capped, and then trimmed again by serialized size.
 */
import { statusBadges } from '../badges'
import type { OwrtRules } from '../config'
import type { HostStore } from '../store'
import type {
  BindingOverviewTotals,
  DeviceCounters,
  IfaceState,
  OpenWrtOverview,
  OverviewIface,
  PoolAggregate,
  RouterModel
} from '../types'
import { POOL_RATE_KEY } from '../types'
import type { ManagedPppoeRange } from './command'
import { collectorHealth } from './health'
import type { SweepRuntime } from './runtime'

const MAX_PUSH_IFACES = 64
const MAX_OVERVIEW_CHARS = 8 * 1_024

function logicalInRanges(logical: string, ranges: readonly ManagedPppoeRange[]): boolean {
  return ranges.some((range) => {
    if (!logical.startsWith(range.prefix)) return false
    const suffix = logical.slice(range.prefix.length)
    // 1-4 digits is a v2 pool member (its VLAN); exactly 5 is a legacy
    // sequence. Both parse as the number the bounds are in.
    if (!/^[0-9]{1,5}$/.test(suffix)) return false
    const seq = Number(suffix)
    return seq >= range.seqFrom && seq <= range.seqTo
  })
}

/** A session this module dialed, by logical name or by its `pppoe-` device. */
function isPoolIface(iface: IfaceState, ranges: readonly ManagedPppoeRange[]): boolean {
  if (logicalInRanges(iface.name, ranges)) return true
  if (
    iface.l3Device.startsWith('pppoe-') &&
    logicalInRanges(iface.l3Device.slice(6), ranges)
  ) {
    return true
  }
  return false
}

function stateOf(iface: IfaceState): 'up' | 'dialing' | 'error' | 'stopped' {
  if (iface.up && iface.ipv4) return 'up'
  if (iface.errorCode) return 'error'
  if (iface.pending || iface.autostart) return 'dialing'
  return 'stopped'
}

function ifaceRate(model: RouterModel, iface: IfaceState): DeviceCounters {
  return (
    model.rates[iface.l3Device] ??
    model.rates[iface.device] ??
    model.rates[iface.name] ?? { rx: 0, tx: 0 }
  )
}

function uptimeLabel(secondsRaw: number): string {
  let seconds = Math.max(0, Math.floor(secondsRaw))
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3_600)
  seconds %= 3_600
  const minutes = Math.floor(seconds / 60)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m`
  return `${seconds}s`
}

/**
 * When a thing that has been up for `uptimeSec` started, on our clock.
 *
 * The router's own epoch is not comparable with ours (see `Lease.expiresUnknown`),
 * so this is derived from the sample time rather than read from the router: the
 * renderer needs an absolute start to count from, and this is the only one that
 * means anything here.
 */
function startedAtFrom(sampleT: number, uptimeSec: number): number {
  return uptimeSec > 0 ? sampleT - Math.floor(uptimeSec) * 1_000 : 0
}

/** Whole percent of RAM in use; 0 on a router that reported no total. */
function memPercent(total: number, free: number): number {
  if (!(total > 0)) return 0
  const used = Math.max(0, Math.min(total, total - free))
  return Math.round((used / total) * 100)
}

function overviewIface(model: RouterModel, iface: IfaceState): OverviewIface {
  const rate = ifaceRate(model, iface)
  const status = stateOf(iface)
  return {
    name: iface.name,
    proto: iface.proto,
    device: iface.l3Device || iface.device,
    status,
    statusBadges: statusBadges(status),
    ipv4: iface.ipv4 ? `${iface.ipv4.addr}/${iface.ipv4.mask}` : '',
    upSince: status === 'up' ? startedAtFrom(model.t, iface.uptimeSec) : 0,
    uptimeLabel: uptimeLabel(iface.uptimeSec),
    rxRate: Math.round(rate.rx),
    txRate: Math.round(rate.tx)
  }
}

/**
 * What the binding half would report, reconstructed from `ip rule` alone. Used
 * during activation and whenever that half throws, so the two counters on the
 * dashboard keep meaning something rather than dropping to zero.
 */
function defaultBindingTotals(
  model: RouterModel,
  rules: OwrtRules,
  store: HostStore
): BindingOverviewTotals {
  const assigned = new Set(
    model.rules
      .filter(
        (rule) =>
          rule.pref >= rules.rulePrefBase &&
          rule.pref < rules.catchAllPrefBase &&
          rule.from !== 'all'
      )
      .map((rule) => rule.from.replace(/\/32$/, ''))
  )
  const running = store.read().instances.some((instance) => instance.running)
  return {
    bound: assigned.size,
    waiting: running ? Math.max(0, model.leases.length - assigned.size) : 0,
    // Not reconstructible from `ip rule` alone: which WANs are in which pool
    // and which of them are healthy is the binding half's own judgement. Zero
    // is the honest answer during activation, and it is a chosen answer rather
    // than a stumbled-into one - a free-WAN count invented here would be read
    // as "the pool is full" on exactly the ticks nothing knows yet.
    wanFree: 0,
    wanErrBound: 0
  }
}

/**
 * The one-to-one totals, or zeroes.
 *
 * Same rule as `bindingTotals` below: a hook that throws during activation
 * must not take the whole overview with it, and the fallback has to be a
 * number a chart can draw rather than a gap.
 */
function directTotals(runtime: SweepRuntime): { ok: number; held: number } {
  try {
    return runtime.hooks.directTotals?.() ?? { ok: 0, held: 0 }
  } catch {
    return { ok: 0, held: 0 }
  }
}

function poolAggregate(
  runtime: SweepRuntime,
  model: RouterModel,
  poolIfaces: readonly IfaceState[]
): PoolAggregate {
  const poolAgg: PoolAggregate = {
    total: Math.max(model.poolDev.count, poolIfaces.length),
    up: 0,
    dialing: 0,
    error: 0,
    stopped: 0,
    rx: Math.round(model.rates[POOL_RATE_KEY]?.rx ?? 0),
    tx: Math.round(model.rates[POOL_RATE_KEY]?.tx ?? 0),
    rxRate: Math.round(model.rates[POOL_RATE_KEY]?.rx ?? 0),
    txRate: Math.round(model.rates[POOL_RATE_KEY]?.tx ?? 0)
  }
  for (const iface of poolIfaces) poolAgg[stateOf(iface)] += 1
  const unclassified =
    poolAgg.total - poolAgg.up - poolAgg.dialing - poolAgg.error - poolAgg.stopped
  if (unclassified > 0) poolAgg.dialing += unclassified
  try {
    const managed = runtime.hooks.pppoeTotals?.()
    if (managed) {
      poolAgg.total = Math.max(0, managed.total)
      poolAgg.up = Math.max(0, managed.up)
      poolAgg.dialing = Math.max(0, managed.dialing)
      poolAgg.error = Math.max(0, managed.error)
      poolAgg.stopped = Math.max(0, managed.stopped)
    }
  } catch {
    // The dump-derived aggregate above is a safe fallback during activation.
  }
  return poolAgg
}

function bindingTotals(runtime: SweepRuntime, model: RouterModel): BindingOverviewTotals {
  try {
    return (
      runtime.hooks.bindingTotals?.() ??
      defaultBindingTotals(model, runtime.config.effectiveRules(), runtime.store)
    )
  } catch {
    return defaultBindingTotals(model, runtime.config.effectiveRules(), runtime.store)
  }
}

export function buildOverview(
  runtime: SweepRuntime,
  model: RouterModel,
  ranges: readonly ManagedPppoeRange[]
): OpenWrtOverview {
  const poolIfaces = model.ifaces.filter((iface) => isPoolIface(iface, ranges))
  const poolAgg = poolAggregate(runtime, model, poolIfaces)
  const binding = bindingTotals(runtime, model)
  const direct = directTotals(runtime)
  const nonPool = model.ifaces
    .filter((iface) => !isPoolIface(iface, ranges))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PUSH_IFACES)
    .map((iface) => overviewIface(model, iface))
  const overview: OpenWrtOverview = {
    t: model.t,
    slowAt: runtime.slowAt,
    sys: {
      ...model.sys,
      uptimeLabel: uptimeLabel(model.sys.uptimeSec),
      bootAt: startedAtFrom(model.t, model.sys.uptimeSec),
      memUsed: Math.max(0, model.sys.memTotal - model.sys.memFree),
      memPct: memPercent(model.sys.memTotal, model.sys.memFree)
    },
    counts: {
      ifTotal: model.ifaces.length,
      // Seeded with the cap's own answer so the budget loop below weighs a
      // realistic number rather than a single zero, then corrected once that
      // loop has stopped popping rows off.
      ifOmitted: model.ifaces.length - nonPool.length,
      wanUp: poolAgg.up,
      wanErr: poolAgg.error,
      devices: model.leases.length,
      bound: Math.max(0, binding.bound),
      waiting: Math.max(0, binding.waiting),
      wanFree: Math.max(0, binding.wanFree),
      wanErrBound: Math.max(0, binding.wanErrBound),
      // `wanUp` and `wanErr` above are already this pool's up and error
      // counts; only the dialling one had nowhere to go, and a chart of
      // sessions that omits it reads as though a redialling pool were down.
      pppDial: Math.max(0, poolAgg.dialing),
      directOk: Math.max(0, direct.ok),
      directHeld: Math.max(0, direct.held)
    },
    ifaces: nonPool,
    poolAgg,
    health: collectorHealth(runtime)
  }
  // Keep the latest stream inside its explicit per-tick budget even when
  // interface names/addresses are unusually long.
  while (
    overview.ifaces.length > 0 &&
    JSON.stringify(overview).length > MAX_OVERVIEW_CHARS
  ) {
    overview.ifaces.pop()
  }
  // Counted last, because the loop above is the second of the two cuts and
  // neither was visible anywhere: a router with a five-thousand-session pool
  // drew a table of sixty-four interfaces that read as the whole router.
  overview.counts.ifOmitted = model.ifaces.length - overview.ifaces.length
  return overview
}
