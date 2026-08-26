/**
 * The mutable state every free function in this folder takes as its first
 * argument, plus the guard each of them opens with.
 *
 * `generation` is what makes a host change abandon a tick already in flight. A
 * sweep awaits one `ctx.exec` that can easily outlive the machine it was
 * started against; publishing its answer afterwards would put one router's
 * numbers on another router's dashboard. `FastSweep` owns exactly one runtime
 * and decides nothing itself.
 */
import type { ModuleContext } from '@shared/modules'
import type { ConfigStore } from '../config'
import type { FirewallZone } from '../parse'
import type { HostStore } from '../store'
import type {
  BindingOverviewTotals,
  IfaceState,
  OpenWrtOverview,
  OpenWrtSeriesPoint,
  OpenWrtSlowSample,
  PoolAggregate,
  ProcNetDevSnapshot,
  RouterModel
} from '../types'
import type { ManagedPppoeRange } from './command'

export interface FastSweepHooks {
  onSample?(model: RouterModel): void | Promise<void>
  onSlowSample?(sample: OpenWrtSlowSample): void | Promise<void>
  onRouterReboot?(model: RouterModel): void | Promise<void>
  bindingTotals?(): BindingOverviewTotals
  pppoeTotals?(): Pick<
    PoolAggregate,
    'total' | 'up' | 'dialing' | 'error' | 'stopped'
  >
  /**
   * The name ranges the router-side awk counts as the managed pool. Read from
   * the pool cache on every tick, because the pools live on the router now
   * and this side only mirrors them.
   */
  pppoeRanges?(): ManagedPppoeRange[]
}

export interface SweepRuntime {
  ctx: ModuleContext
  config: ConfigStore
  store: HostStore
  hooks: FastSweepHooks

  latest: RouterModel | null
  overview: OpenWrtOverview | null
  slowAt: number
  series: OpenWrtSeriesPoint[]
  uciTables: Record<string, number>
  pppoeUsers: Record<string, string>
  firewallZones: FirewallZone[]

  previousAt: number
  previousDev: ProcNetDevSnapshot | null
  previousUptime: number
  historyModelAt: number
  /** When the last history point was written, so the sample interval can be paced. */
  historyAt: number
  cachedIfaces: IfaceState[]
  pppoeErrors: OpenWrtSlowSample['pppoeErrors']
  ticksSinceDump: number
  dumpNextTick: boolean
  dumpBackoff: number
  dumpFailed: boolean
  generation: number
  stopped: boolean
  fastFlight: Promise<void> | null
  slowFlight: Promise<void> | null
  fastFailed: boolean
  slowFailed: boolean
  hookFailed: boolean
  lastFastT: number
  lastError: string
}

export function createSweepRuntime(
  ctx: ModuleContext,
  config: ConfigStore,
  store: HostStore,
  hooks: FastSweepHooks
): SweepRuntime {
  return {
    ctx,
    config,
    store,
    hooks,
    latest: null,
    overview: null,
    slowAt: 0,
    series: [],
    uciTables: {},
    pppoeUsers: {},
    firewallZones: [],
    previousAt: 0,
    previousDev: null,
    previousUptime: 0,
    historyModelAt: 0,
    historyAt: 0,
    cachedIfaces: [],
    pppoeErrors: {},
    ticksSinceDump: Number.MAX_SAFE_INTEGER,
    dumpNextTick: true,
    dumpBackoff: 0,
    dumpFailed: false,
    generation: 0,
    stopped: false,
    fastFlight: null,
    slowFlight: null,
    fastFailed: false,
    slowFailed: false,
    hookFailed: false,
    lastFastT: 0,
    lastError: ''
  }
}

export function resetRuntime(runtime: SweepRuntime): void {
  runtime.generation += 1
  runtime.latest = null
  runtime.overview = null
  runtime.slowAt = 0
  runtime.series = []
  runtime.uciTables = {}
  runtime.pppoeUsers = {}
  runtime.firewallZones = []
  runtime.previousAt = 0
  runtime.previousDev = null
  runtime.previousUptime = 0
  runtime.historyModelAt = 0
  runtime.historyAt = 0
  runtime.cachedIfaces = []
  runtime.pppoeErrors = {}
  runtime.ticksSinceDump = Number.MAX_SAFE_INTEGER
  runtime.dumpNextTick = true
  runtime.dumpBackoff = 0
  runtime.dumpFailed = false
  runtime.fastFailed = false
  runtime.slowFailed = false
  runtime.hookFailed = false
  runtime.lastFastT = 0
  runtime.lastError = ''
}

/**
 * Whether the tick that started at `generation` may still touch anything. It is
 * re-asked after every await, not just at the top: disposal and a host change
 * both land while a command is in flight.
 */
export function isCurrent(runtime: SweepRuntime, generation: number): boolean {
  return !runtime.stopped && generation === runtime.generation && runtime.ctx.connected
}
