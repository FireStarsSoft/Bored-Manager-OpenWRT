/**
 * The object the rest of the module holds: one runtime, and a method per thing
 * a page or a handler can ask for.
 *
 * Nothing is decided here. Every method hands the runtime to the free function
 * that owns that behaviour, which is what keeps the surface stable while the
 * files behind it move. The `batch*` aliases are the names the UI specs call
 * and the short ones are what the module's own code uses; both are kept because
 * both are in use.
 */
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { AgentCapability } from '../probe'
import type { OkResult } from '@shared/types'
import type { RouterModel } from '../types'
import { batchAction, connAction, watchdog } from './actions'
import { applyPppoe } from './create'
import { batchDelete } from './lifecycle'
import { checkPppoe } from './plan'
import { createPppoeRuntime, resetRuntime, type PppoeRuntime } from './runtime'
import type {
  PppoeBatchSummary,
  PppoeConfigStore,
  PppoeDisplayRow,
  PppoeHostStore,
  PppoeJobs,
  PppoeService,
  PppoeSnapshot,
  PppoeStoreData
} from './types'
import { attentionRows, batches, onSample, rows, snapshot } from './view'

export class PppoeManager<TData extends PppoeStoreData = PppoeStoreData> {
  private runtime: PppoeRuntime

  constructor(
    ctx: ModuleContext,
    config: PppoeConfigStore,
    store: PppoeHostStore<TData>,
    jobs: PppoeJobs,
    service: PppoeService,
    /**
     * The router-side capability verdict. When it says this router provides
     * `pppoe`, a create writes its sections through `bm-pppoe-pool` in one call
     * instead of one round trip per chunk - and the credentials never become
     * arguments to anything on either side.
     */
    agent?: () => AgentCapability
  ) {
    this.runtime = createPppoeRuntime(ctx, config, store, jobs, service, agent)
  }

  // ------------------------------------------------------------- check/apply

  check(raw: unknown): Promise<ModuleCheckReport> {
    return checkPppoe(this.runtime, raw)
  }

  apply(raw: unknown): Promise<OkResult> {
    return applyPppoe(this.runtime, raw)
  }

  // UI-handler-friendly aliases.
  batchCheck(raw: unknown): Promise<ModuleCheckReport> {
    return this.check(raw)
  }

  batchApply(raw: unknown): Promise<OkResult> {
    return this.apply(raw)
  }

  // ---------------------------------------------------------------- queries

  batches(): PppoeBatchSummary[] {
    return batches(this.runtime)
  }

  /** `scopeRaw` is the batch drawer's open tab; see `rows` in `view.ts`. */
  rows(batchIdRaw: unknown, scopeRaw?: unknown): PppoeDisplayRow[] {
    return rows(this.runtime, batchIdRaw, scopeRaw)
  }

  attentionRows(): PppoeDisplayRow[] {
    return attentionRows(this.runtime)
  }

  snapshot(): PppoeSnapshot {
    return snapshot(this.runtime)
  }

  get latest(): PppoeSnapshot {
    return this.runtime.latestPayload.t ? this.runtime.latestPayload : this.snapshot()
  }

  // ---------------------------------------------------------------- actions

  batchAction(idRaw: unknown, actionRaw: unknown): OkResult {
    return batchAction(this.runtime, idRaw, actionRaw)
  }

  connAction(namesRaw: unknown, actionRaw: unknown): OkResult {
    return connAction(this.runtime, namesRaw, actionRaw)
  }

  batchDelete(idRaw: unknown): OkResult {
    return batchDelete(this.runtime, idRaw)
  }

  // --------------------------------------------------------------- lifecycle

  /** Called after FastSweep has replaced its model cache. */
  onSample(model?: RouterModel): void {
    onSample(this.runtime, model)
  }

  watchdog(now = Date.now()): string | null {
    return watchdog(this.runtime, now)
  }

  slowTick(now = Date.now()): string | null {
    return this.watchdog(now)
  }

  reset(): void {
    resetRuntime(this.runtime)
  }

  dispose(): void {
    this.reset()
  }
}
