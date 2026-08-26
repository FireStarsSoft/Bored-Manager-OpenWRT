/**
 * The object the rest of the module holds: one runtime, and a method per
 * thing a page or a handler can ask for. Nothing is decided here - every
 * method hands the runtime to the free function that owns that behaviour.
 */
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { FormFieldOption } from '@shared/module-ui'
import type { OkResult } from '@shared/types'
import type { PoolSettings } from '../agent'
import { bulkPoolAction, carrierOptions, connAction, sweepPools } from './actions'
import { applyPool } from './create'
import { applyPoolSet } from './edit'
import { deletePool } from './lifecycle'
import { checkPool, checkPoolEdit } from './plan'
import { createPppoeRuntime, resetRuntime, type PppoeRuntime } from './runtime'
import { settingsApply, settingsCheck, settingsGet } from './settings'
import type {
  PppoeAgentReader,
  PppoeConfigStore,
  PppoeDisplayRow,
  PppoeJobs,
  PppoeLegacyRow,
  PppoePoolRow,
  PppoeService,
  PppoeSnapshot
} from './types'
import {
  legacyRows,
  managedRanges,
  onSample,
  pools,
  refreshCache,
  rows,
  snapshot
} from './view'

export class PppoeManager {
  private runtime: PppoeRuntime

  constructor(
    ctx: ModuleContext,
    config: PppoeConfigStore,
    jobs: PppoeJobs,
    service: PppoeService,
    /** The router-side capability verdict, read per operation, never captured. */
    agent?: PppoeAgentReader
  ) {
    this.runtime = createPppoeRuntime(ctx, config, jobs, service, agent)
  }

  // ------------------------------------------------------------ check/apply

  createCheck(values: unknown): Promise<ModuleCheckReport> {
    return checkPool(this.runtime, values)
  }

  createApply(payload: unknown): Promise<OkResult> {
    return applyPool(this.runtime, payload)
  }

  setCheck(id: unknown, values: unknown): Promise<ModuleCheckReport> {
    return checkPoolEdit(this.runtime, id, values)
  }

  setApply(id: unknown, payload: unknown): Promise<OkResult> {
    return applyPoolSet(this.runtime, id, payload)
  }

  settingsGet(): PoolSettings {
    return settingsGet(this.runtime)
  }

  settingsCheck(values: unknown): ModuleCheckReport {
    return settingsCheck(this.runtime, values)
  }

  settingsApply(payload: unknown): Promise<OkResult> {
    return settingsApply(this.runtime, payload)
  }

  // ---------------------------------------------------------------- queries

  pools(): PppoePoolRow[] {
    return pools(this.runtime)
  }

  rows(poolId: unknown, scope?: unknown): PppoeDisplayRow[] {
    return rows(this.runtime, poolId, scope)
  }

  legacyRows(): PppoeLegacyRow[] {
    return legacyRows(this.runtime)
  }

  carrierOptions(): Promise<FormFieldOption[]> {
    return carrierOptions(this.runtime)
  }

  /** The pool names the uninstall gate reports as blockers. */
  poolNames(): string[] {
    return (this.runtime.cache.info?.pools ?? []).map((pool) => pool.label || pool.id)
  }

  poolCount(): number {
    const info = this.runtime.cache.info
    return info ? info.pools.length + info.legacy.length : 0
  }

  /** The name ranges the fast sweep's awk counts as the managed pool. */
  managedRanges(): Array<{ prefix: string; seqFrom: number; seqTo: number }> {
    return managedRanges(this.runtime)
  }

  snapshot(): PppoeSnapshot {
    return snapshot(this.runtime)
  }

  get latest(): PppoeSnapshot {
    return this.runtime.latestPayload.t ? this.runtime.latestPayload : this.snapshot()
  }

  // ---------------------------------------------------------------- actions

  connAction(names: unknown, action: unknown): Promise<OkResult> {
    return connAction(this.runtime, names, action)
  }

  poolAction(id: unknown, action: unknown): Promise<OkResult> {
    return bulkPoolAction(this.runtime, id, action)
  }

  delete(id: unknown, force?: unknown): Promise<OkResult> {
    return deletePool(this.runtime, id, force)
  }

  sweep(): Promise<OkResult> {
    return sweepPools(this.runtime)
  }

  // -------------------------------------------------------------- lifecycle

  /** Called after FastSweep has replaced its model cache. */
  onSample(): void {
    onSample(this.runtime)
  }

  /** One forced fetch, for the paths that just changed the router. */
  refresh(): Promise<void> {
    return refreshCache(this.runtime, true)
  }

  reset(): void {
    resetRuntime(this.runtime)
  }

  dispose(): void {
    this.reset()
  }
}
