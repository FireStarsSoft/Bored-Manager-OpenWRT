import type { ModuleContext, ModulePoller } from '@shared/modules'
import { shQuote, splitSections } from '@shared/shell'
import type { ConfigStore, OwrtRules } from './config'
import {
  parseDump,
  parseIpRules,
  parseLeases,
  parsePppoeLogErrors,
  parseProcNetDev,
  parseSystemInfo,
  parseUciIp4Tables,
  parseUciPppoeUsers
} from './parse'
import type { HostStore } from './store'
import {
  POOL_RATE_KEY,
  type BindingOverviewTotals,
  type DeviceCounters,
  type IfaceState,
  type Lease,
  type OpenWrtOverview,
  type OpenWrtSeriesPoint,
  type OpenWrtSlowSample,
  type OverviewIface,
  type PoolAggregate,
  type ProcNetDevSnapshot,
  type RouterModel
} from './types'

const EXEC_TIMEOUT_MS = 20_000
const SERIES_WINDOW_MS = 5 * 60 * 1_000
const MAX_PUSH_IFACES = 64
const MAX_OVERVIEW_CHARS = 8 * 1_024
const RULE_FILTER_END = 30_000

export interface FastSweepHooks {
  onSample?(model: RouterModel): void | Promise<void>
  onSlowSample?(sample: OpenWrtSlowSample): void | Promise<void>
  onRouterReboot?(model: RouterModel): void | Promise<void>
  bindingTotals?(): BindingOverviewTotals
  pppoeTotals?(): Pick<
    PoolAggregate,
    'total' | 'up' | 'dialing' | 'error' | 'stopped'
  >
}

const DEV_AWK = [
  `function managed(name, logical, count, specs, i, pair, bounds, prefix, suffix, seq) {`,
  `  if (substr(name, 1, 6) != "pppoe-" || R == "") return 0`,
  `  logical=substr(name, 7)`,
  `  count=split(R, specs, ";")`,
  `  for (i=1; i<=count; i++) {`,
  `    split(specs[i], pair, ":")`,
  `    split(pair[2], bounds, "-")`,
  `    prefix=pair[1]`,
  `    if (substr(logical, 1, length(prefix)) != prefix) continue`,
  `    suffix=substr(logical, length(prefix)+1)`,
  `    if (suffix !~ /^[0-9][0-9][0-9][0-9][0-9]$/) continue`,
  `    seq=suffix+0`,
  `    if (seq >= bounds[1]+0 && seq <= bounds[2]+0) return 1`,
  `  }`,
  `  return 0`,
  `}`,
  `NR > 2 {`,
  `  line=$0`,
  `  sub(/^[ \t]+/, "", line)`,
  `  pos=index(line, ":")`,
  `  if (!pos) next`,
  `  name=substr(line, 1, pos-1)`,
  `  data=substr(line, pos+1)`,
  `  sub(/^[ \t]+/, "", data)`,
  `  fields=split(data, value, /[ \t]+/)`,
  `  if (fields < 9) next`,
  `  rx=value[1]+0`,
  `  tx=value[9]+0`,
  `  if (managed(name)) { poolCount++; poolRx+=rx; poolTx+=tx }`,
  `  else { printf "%s %.0f %.0f\\n", name, rx, tx }`,
  `}`,
  `END { printf "===POOL=== %d %.0f %.0f\\n", poolCount+0, poolRx+0, poolTx+0 }`
].join('\n')

/** Exported for fixture/golden tests; it still executes as one remote shell. */
export function buildFastSweepCommand(
  rules: OwrtRules,
  managedRanges: readonly ManagedPppoeRange[],
  includeDump: boolean
): string {
  const rangeSpec = managedRanges
    .map((range) => `${range.prefix}:${range.seqFrom}-${range.seqTo}`)
    .join(';')
  const parts = [
    `echo '===SYS==='; ubus -S call system info 2>/dev/null || true`,
    `echo '===DEV==='; awk -v R=${shQuote(rangeSpec)} ${shQuote(DEV_AWK)} /proc/net/dev 2>/dev/null || true`,
    `echo '===LEASES==='; cat ${shQuote(rules.leaseFile)} 2>/dev/null || true`,
    // RULES_OK is a fail-closed sentinel: a hidden `ip` failure must not look
    // like "zero managed rules" or BindingEngine will re-add every assignment.
    `echo '===RULES==='; if ip -4 rule show >/tmp/.bm-owrt-rules.$$ 2>/dev/null; then awk -F: -v B=${Math.trunc(
      rules.rulePrefBase
    )} -v E=${RULE_FILTER_END} '$1+0 >= B && $1+0 < E' /tmp/.bm-owrt-rules.$$; echo '===RULES_OK===1'; else echo '===RULES_OK===0'; fi; rm -f /tmp/.bm-owrt-rules.$$`
  ]
  if (includeDump) {
    parts.push(
      `echo '===DUMP==='; ubus -S call network.interface dump 2>/dev/null || true`
    )
  }
  return parts.join('; ')
}

const SLOW_COMMAND = [
  `echo '===LOG==='; logread -l 300 2>/dev/null | grep -E 'pppd|netifd' || true`,
  `echo '===UCIMAP==='; uci -q show network 2>/dev/null | grep -E '\\.(ip4table|username)=' || true`
].join('; ')

function validDump(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown
    return (
      Array.isArray(value) ||
      (typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as { interface?: unknown }).interface))
    )
  } catch {
    return false
  }
}

function dumpCadence(ifaceCount: number): number {
  if (ifaceCount <= 500) return 1
  if (ifaceCount <= 2_000) return 2
  return 3
}

export interface ManagedPppoeRange {
  prefix: string
  seqFrom: number
  seqTo: number
}

function managedRanges(store: HostStore): ManagedPppoeRange[] {
  return store
    .read()
    .batches.filter(
      (batch) =>
        /^[a-z][a-z0-9]{0,3}$/.test(batch.prefix) &&
        Number.isInteger(batch.seqFrom) &&
        Number.isInteger(batch.seqTo) &&
        batch.seqFrom >= 1 &&
        batch.seqTo >= batch.seqFrom
    )
    .map((batch) => ({
      prefix: batch.prefix,
      seqFrom: batch.seqFrom,
      seqTo: batch.seqTo
    }))
}

function logicalInRanges(logical: string, ranges: readonly ManagedPppoeRange[]): boolean {
  return ranges.some((range) => {
    if (!logical.startsWith(range.prefix)) return false
    const suffix = logical.slice(range.prefix.length)
    if (!/^\d{5}$/.test(suffix)) return false
    const seq = Number(suffix)
    return seq >= range.seqFrom && seq <= range.seqTo
  })
}

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

function overviewIface(model: RouterModel, iface: IfaceState): OverviewIface {
  const rate = ifaceRate(model, iface)
  return {
    name: iface.name,
    proto: iface.proto,
    device: iface.l3Device || iface.device,
    status: stateOf(iface),
    ipv4: iface.ipv4 ? `${iface.ipv4.addr}/${iface.ipv4.mask}` : '',
    uptimeLabel: uptimeLabel(iface.uptimeSec),
    rxRate: Math.round(rate.rx),
    txRate: Math.round(rate.tx)
  }
}

function defaultBindingTotals(model: RouterModel, rules: OwrtRules, store: HostStore): BindingOverviewTotals {
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
    waiting: running ? Math.max(0, model.leases.length - assigned.size) : 0
  }
}

function routerLocaltime(text: string): number | null {
  try {
    const value = JSON.parse(text) as { localtime?: unknown }
    return typeof value.localtime === 'number' && Number.isFinite(value.localtime)
      ? value.localtime
      : null
  } catch {
    return null
  }
}

function activeLeases(
  leases: readonly Lease[],
  at: number,
  routerNowSec: number | null
): Lease[] {
  const byMac = new Map<string, Lease>()
  for (const lease of leases) {
    let normalized = lease
    if (lease.expires !== 0 && routerNowSec != null) {
      const remaining = lease.expires - routerNowSec
      if (remaining <= 0) continue
      normalized = {
        ...lease,
        // Keep expiry comparable with the app-clock model timestamp even when
        // the router has not synchronized its wall clock yet.
        expires: Math.floor(at / 1_000) + remaining
      }
    }
    const old = byMac.get(normalized.mac)
    const rank =
      normalized.expires === 0 ? Number.MAX_SAFE_INTEGER : normalized.expires
    const oldRank =
      old == null
        ? -1
        : old.expires === 0
          ? Number.MAX_SAFE_INTEGER
          : old.expires
    if (rank >= oldRank) byMac.set(normalized.mac, normalized)
  }
  return [...byMac.values()]
}

/**
 * Fast model collector plus the slow self-heal probe. Every collector tick is
 * one bounded command; large tables remain in `latest` and are never streamed.
 */
export class FastSweep {
  readonly fastPoller: ModulePoller
  readonly slowPoller: ModulePoller
  latest: RouterModel | null = null
  overview: OpenWrtOverview | null = null
  series: OpenWrtSeriesPoint[] = []
  uciTables: Record<string, number> = {}
  pppoeUsers: Record<string, string> = {}

  private previousAt = 0
  private previousDev: ProcNetDevSnapshot | null = null
  private previousUptime = 0
  private historyModelAt = 0
  private cachedIfaces: IfaceState[] = []
  private pppoeErrors: OpenWrtSlowSample['pppoeErrors'] = {}
  private ticksSinceDump = Number.MAX_SAFE_INTEGER
  private dumpNextTick = true
  private generation = 0
  private stopped = false
  private fastFlight: Promise<void> | null = null
  private slowFlight: Promise<void> | null = null
  private fastFailed = false
  private slowFailed = false
  private hookFailed = false

  constructor(
    private ctx: ModuleContext,
    private config: ConfigStore,
    private store: HostStore,
    private hooks: FastSweepHooks = {}
  ) {
    this.fastPoller = ctx.createPoller('openwrt:fast', () => this.run())
    this.slowPoller = ctx.createPoller('openwrt:slow', () => this.runSlow())
  }

  forceDumpNextTick(): void {
    this.dumpNextTick = true
  }

  pppoeErrorSnapshot(): Readonly<Record<string, string>> {
    return this.pppoeErrors
  }

  pppoeUserSnapshot(): Readonly<Record<string, string>> {
    return this.pppoeUsers
  }

  run(): Promise<void> {
    if (this.fastFlight) return this.fastFlight
    const generation = this.generation
    const pending = this.sample(generation).finally(() => {
      if (this.fastFlight === pending) this.fastFlight = null
    })
    this.fastFlight = pending
    return pending
  }

  runSlow(): Promise<void> {
    if (this.slowFlight) return this.slowFlight
    const generation = this.generation
    const pending = this.slowSample(generation).finally(() => {
      if (this.slowFlight === pending) this.slowFlight = null
    })
    this.slowFlight = pending
    return pending
  }

  reset(): void {
    this.generation += 1
    this.fastPoller.stop()
    this.slowPoller.stop()
    this.latest = null
    this.overview = null
    this.series = []
    this.uciTables = {}
    this.pppoeUsers = {}
    this.previousAt = 0
    this.previousDev = null
    this.previousUptime = 0
    this.historyModelAt = 0
    this.cachedIfaces = []
    this.pppoeErrors = {}
    this.ticksSinceDump = Number.MAX_SAFE_INTEGER
    this.dumpNextTick = true
    this.fastFailed = false
    this.slowFailed = false
    this.hookFailed = false
  }

  dispose(): void {
    this.stopped = true
    this.generation += 1
    this.fastPoller.stop()
    this.slowPoller.stop()
  }

  private active(generation: number): boolean {
    return !this.stopped && generation === this.generation && this.ctx.connected
  }

  private calculateRates(current: ProcNetDevSnapshot, at: number): Record<string, DeviceCounters> {
    const rates: Record<string, DeviceCounters> = Object.create(null) as Record<
      string,
      DeviceCounters
    >
    const deltaSec = this.previousAt ? (at - this.previousAt) / 1_000 : 0
    const elapsed = deltaSec > 0 ? Math.max(deltaSec, 0.001) : 0
    const rate = (now: number, before: number | undefined): number =>
      elapsed > 0 && before != null ? Math.max(0, (now - before) / elapsed) : 0
    for (const [name, counters] of Object.entries(current.devices)) {
      const previous = this.previousDev?.devices[name]
      rates[name] = {
        rx: rate(counters.rx, previous?.rx),
        tx: rate(counters.tx, previous?.tx)
      }
    }
    rates[POOL_RATE_KEY] = {
      rx: rate(current.poolDev.rx, this.previousDev?.poolDev.rx),
      tx: rate(current.poolDev.tx, this.previousDev?.poolDev.tx)
    }
    this.previousAt = at
    this.previousDev = current
    return rates
  }

  private publish(model: RouterModel, ranges: readonly ManagedPppoeRange[]): void {
    const poolIfaces = model.ifaces.filter((iface) => isPoolIface(iface, ranges))
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
      const managed = this.hooks.pppoeTotals?.()
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

    let binding: BindingOverviewTotals
    try {
      binding =
        this.hooks.bindingTotals?.() ??
        defaultBindingTotals(model, this.config.effectiveRules(), this.store)
    } catch {
      binding = defaultBindingTotals(model, this.config.effectiveRules(), this.store)
    }
    const nonPool = model.ifaces
      .filter((iface) => !isPoolIface(iface, ranges))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_PUSH_IFACES)
      .map((iface) => overviewIface(model, iface))
    const overview: OpenWrtOverview = {
      t: model.t,
      sys: { ...model.sys, uptimeLabel: uptimeLabel(model.sys.uptimeSec) },
      counts: {
        ifTotal: model.ifaces.length,
        wanUp: poolAgg.up,
        wanErr: poolAgg.error,
        devices: model.leases.length,
        bound: Math.max(0, binding.bound),
        waiting: Math.max(0, binding.waiting)
      },
      ifaces: nonPool,
      poolAgg
    }
    // Keep the latest stream inside its explicit per-tick budget even when
    // interface names/addresses are unusually long.
    while (
      overview.ifaces.length > 0 &&
      JSON.stringify(overview).length > MAX_OVERVIEW_CHARS
    ) {
      overview.ifaces.pop()
    }
    this.overview = overview
    const point: OpenWrtSeriesPoint = {
      t: model.t,
      rx: poolAgg.rx,
      tx: poolAgg.tx,
      wanUp: overview.counts.wanUp,
      wanErr: overview.counts.wanErr,
      devices: overview.counts.devices
    }
    this.series.push(point)
    const cutoff = point.t - SERIES_WINDOW_MS
    while (this.series.length && this.series[0].t < cutoff) this.series.shift()
    this.ctx.emit('overview', overview)
    this.ctx.emit('series', point)
  }

  private async sample(generation: number): Promise<void> {
    if (!this.active(generation)) return
    const rules = this.config.effectiveRules()
    const ranges = managedRanges(this.store)
    this.ticksSinceDump += 1
    const cadence = dumpCadence(this.cachedIfaces.length)
    const includeDump =
      this.dumpNextTick || this.cachedIfaces.length === 0 || this.ticksSinceDump >= cadence
    if (includeDump) this.dumpNextTick = false

    let result
    try {
      result = await this.ctx.exec(
        buildFastSweepCommand(rules, ranges, includeDump),
        { timeoutMs: EXEC_TIMEOUT_MS }
      )
    } catch (error) {
      if (this.active(generation) && !this.fastFailed) {
        this.fastFailed = true
        this.ctx.log(
          `openwrt: fast sweep failed (${error instanceof Error ? error.message : String(error)})`
        )
      }
      return
    }
    if (!this.active(generation)) return
    if (result.code !== 0 && !result.stdout.trim()) {
      if (!this.fastFailed) {
        this.fastFailed = true
        this.ctx.log(
          `openwrt: fast sweep returned no data (${(result.stderr || `exit ${result.code}`).trim().slice(0, 200)})`
        )
      }
      return
    }
    this.fastFailed = false

    const sections = splitSections(result.stdout)
    const rulesOk = (sections.get('RULES_OK') ?? '').trim() === '1'
    if (!rulesOk && this.active(generation)) {
      this.ctx.log('openwrt: ip -4 rule show failed; skipping binding reconcile')
    }
    const systemText = sections.get('SYS') ?? ''
    const system = parseSystemInfo(systemText)
    const rebooted =
      this.previousUptime > 0 &&
      system.uptimeSec > 0 &&
      system.uptimeSec + 5 < this.previousUptime
    if (rebooted) {
      this.previousAt = 0
      this.previousDev = null
      this.forceDumpNextTick()
      this.ctx.log('openwrt: router reboot detected; bindings will be reapplied')
      this.ctx.emit(
        'bindingLog',
        `${new Date().toISOString()} [router] reboot detected; reapplying bindings`
      )
    }
    this.previousUptime = system.uptimeSec

    if (includeDump) {
      const dump = sections.get('DUMP') ?? ''
      if (validDump(dump)) {
        this.cachedIfaces = parseDump(dump)
        this.ticksSinceDump = 0
      } else {
        // A failed heavy section must not erase the last good model.
        this.forceDumpNextTick()
      }
    }
    const ifaces = this.cachedIfaces.map((iface) => ({
      ...iface,
      errorCode:
        iface.errorCode ||
        (!iface.up ? this.pppoeErrors[iface.name] : undefined)
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
        : (this.latest?.rules ?? []),
      rates: this.calculateRates(dev, at)
    }
    this.latest = model

    try {
      if (rulesOk) {
        if (rebooted) await this.hooks.onRouterReboot?.(model)
        await this.hooks.onSample?.(model)
      }
      this.hookFailed = false
    } catch (error) {
      if (this.active(generation) && !this.hookFailed) {
        this.hookFailed = true
        this.ctx.log(
          `openwrt: automation reconcile failed (${error instanceof Error ? error.message : String(error)})`
        )
      }
    }
    if (!this.active(generation)) return
    this.publish(model, ranges)
  }

  private async slowSample(generation: number): Promise<void> {
    if (!this.active(generation)) return
    let result
    try {
      result = await this.ctx.exec(SLOW_COMMAND, { timeoutMs: EXEC_TIMEOUT_MS })
    } catch (error) {
      if (this.active(generation) && !this.slowFailed) {
        this.slowFailed = true
        this.ctx.log(
          `openwrt: slow probe failed (${error instanceof Error ? error.message : String(error)})`
        )
      }
      return
    }
    if (!this.active(generation)) return
    if (result.code !== 0 && !result.stdout.trim()) {
      if (!this.slowFailed) {
        this.slowFailed = true
        this.ctx.log(
          `openwrt: slow probe returned no data (${(result.stderr || `exit ${result.code}`).trim().slice(0, 200)})`
        )
      }
      return
    }
    this.slowFailed = false
    const sections = splitSections(result.stdout)
    const log = sections.get('LOG') ?? ''
    this.pppoeErrors = parsePppoeLogErrors(log)
    const uci = sections.get('UCIMAP') ?? ''
    this.uciTables = parseUciIp4Tables(uci)
    this.pppoeUsers = parseUciPppoeUsers(uci)
    const sample: OpenWrtSlowSample = {
      t: Date.now(),
      log,
      pppoeErrors: { ...this.pppoeErrors },
      pppoeUsers: { ...this.pppoeUsers },
      uciTables: { ...this.uciTables },
      model: this.latest
    }
    try {
      await this.hooks.onSlowSample?.(sample)
    } catch (error) {
      if (this.active(generation)) {
        this.ctx.log(
          `openwrt: slow self-heal failed (${error instanceof Error ? error.message : String(error)})`
        )
      }
    }
    if (!this.active(generation)) return
    const overview = this.overview
    if (overview && overview.t !== this.historyModelAt) {
      this.historyModelAt = overview.t
      this.ctx.addHistory({
        t: sample.t,
        wanUp: overview.counts.wanUp,
        wanErr: overview.counts.wanErr,
        devices: overview.counts.devices,
        rx: overview.poolAgg.rx,
        tx: overview.poolAgg.tx
      })
    }
  }
}
