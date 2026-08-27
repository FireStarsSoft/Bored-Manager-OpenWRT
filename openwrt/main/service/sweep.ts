import type { ModuleContext, ModulePoller } from '@shared/modules'
import type { ConfigStore } from '../config'
import type { FirewallZone } from '../parse'
import type { HostStore } from '../store'
import type { OpenWrtOverview, OpenWrtSeriesPoint, RouterModel } from '../types'
import { forceDumpNextTick, sampleFast } from './fast'
import {
  createSweepRuntime,
  resetRuntime,
  type FastSweepHooks,
  type SweepRuntime
} from './runtime'
import { lanZone, sampleSlow } from './slow'

/**
 * Fast model collector plus the slow self-heal probe. Every collector tick is
 * one bounded command; large tables remain in `latest` and are never streamed.
 *
 * The object is a facade over one `SweepRuntime`: it owns the two pollers, it
 * refuses to start a tick while the previous one is still in flight, and it
 * hands everything else to the free functions in this folder.
 */
export class FastSweep {
  readonly fastPoller: ModulePoller
  readonly slowPoller: ModulePoller

  private runtime: SweepRuntime

  constructor(
    ctx: ModuleContext,
    config: ConfigStore,
    store: HostStore,
    hooks: FastSweepHooks = {}
  ) {
    this.runtime = createSweepRuntime(ctx, config, store, hooks)
    this.fastPoller = ctx.createPoller('openwrt:fast', () => this.run())
    this.slowPoller = ctx.createPoller('openwrt:slow', () => this.runSlow())
  }

  get latest(): RouterModel | null {
    return this.runtime.latest
  }

  get overview(): OpenWrtOverview | null {
    return this.runtime.overview
  }

  get slowAt(): number {
    return this.runtime.slowAt
  }

  get series(): OpenWrtSeriesPoint[] {
    return this.runtime.series
  }

  get uciTables(): Record<string, number> {
    return this.runtime.uciTables
  }

  get pppoeUsers(): Record<string, string> {
    return this.runtime.pppoeUsers
  }

  get firewallZones(): FirewallZone[] {
    return this.runtime.firewallZones
  }

  /** The scale limits as the last slow sweep read them; {} before the first. */
  get sysctl(): Readonly<Record<string, number>> {
    return this.runtime.sysctl
  }

  /** fw4's flow_offloading flag; null until a slow sweep has answered. */
  get flowOffload(): boolean | null {
    return this.runtime.flowOffload
  }

  forceDumpNextTick(): void {
    forceDumpNextTick(this.runtime)
  }

  pppoeErrorSnapshot(): Readonly<Record<string, string>> {
    return this.runtime.pppoeErrors
  }

  pppoeUserSnapshot(): Readonly<Record<string, string>> {
    return this.runtime.pppoeUsers
  }

  /**
   * The router's own LAN firewall zone, or `''` before the first slow sweep has
   * read one. Callers fall back to `lan` themselves; this deliberately does not,
   * so "not discovered yet" stays distinguishable from "discovered, called lan".
   */
  lanZone(): string {
    return lanZone(this.runtime)
  }

  run(): Promise<void> {
    if (this.runtime.fastFlight) return this.runtime.fastFlight
    const generation = this.runtime.generation
    const pending = sampleFast(this.runtime, generation).finally(() => {
      if (this.runtime.fastFlight === pending) this.runtime.fastFlight = null
    })
    this.runtime.fastFlight = pending
    return pending
  }

  runSlow(): Promise<void> {
    if (this.runtime.slowFlight) return this.runtime.slowFlight
    const generation = this.runtime.generation
    const pending = sampleSlow(this.runtime, generation).finally(() => {
      if (this.runtime.slowFlight === pending) this.runtime.slowFlight = null
    })
    this.runtime.slowFlight = pending
    return pending
  }

  reset(): void {
    resetRuntime(this.runtime)
    this.fastPoller.stop()
    this.slowPoller.stop()
  }

  dispose(): void {
    this.runtime.stopped = true
    this.runtime.generation += 1
    this.fastPoller.stop()
    this.slowPoller.stop()
  }
}
