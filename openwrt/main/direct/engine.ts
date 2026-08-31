/**
 * The object the container holds: one runtime, and a method per thing a page or
 * a handler can ask for.
 *
 * Nothing is decided here. Every method hands the runtime to the free function
 * that owns that behaviour, which is what keeps this surface stable while the
 * files behind it move - the same arrangement `BindingEngine` has, so the two
 * automations are wired into the container in the same shape.
 */
import type { ModuleCheckReport } from '@shared/check'
import type { OkResult } from '@shared/types'
import type { RouterModel } from '../types'
import { checkDirect } from './check'
import {
  deleteDirect,
  disableDirect,
  dispose,
  enableDirect,
  reset,
  updateDirect
} from './lifecycle'
import { runDirectPass } from './pass'
import { applyDirect } from './prepare'
import { createDirectRuntime, exclusive } from './runtime'
import { countTotals, directRows, reservedIps } from './view'
import type {
  DirectEngineOptions,
  DirectRow,
  DirectRuntime,
  DirectSnapshot,
  DirectTotals
} from './types'

export class DirectEngine {
  private runtime: DirectRuntime

  constructor(options: DirectEngineOptions) {
    this.runtime = createDirectRuntime(options)
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * Called from the fast tick after the binding engine's own pass.
   *
   * After, not before: the instance half folds its diff into `model.rules`
   * first, so this one plans against a snapshot that already reflects it. The
   * two bands are disjoint, so the order is about freshness rather than about
   * either half writing over the other.
   */
  async onSample(model: RouterModel): Promise<void> {
    if (this.runtime.disposed) return
    await exclusive(this.runtime, async () => {
      if (this.runtime.disposed) return
      const failed = await runDirectPass(this.runtime, model)
      if (failed && !this.runtime.disposed) {
        this.runtime.ctx.log(`openwrt: one-to-one binding pass failed: ${failed}`)
      }
    })
  }

  reset(): void {
    reset(this.runtime)
  }

  dispose(): void {
    dispose(this.runtime)
  }

  // ----------------------------------------------------------------- queries

  snapshot(): DirectSnapshot {
    return this.runtime.latestPayload
  }

  rows(): DirectRow[] {
    return directRows(this.runtime)
  }

  /** Counts for the overview and its history: on the WAN, versus parked. */
  totals(): DirectTotals {
    return countTotals(directRows(this.runtime))
  }

  /** Addresses the instance planner must leave alone; see `reservedIps`. */
  reservedIps(model: RouterModel): string[] {
    return reservedIps(this.runtime, model)
  }

  // ------------------------------------------------------------ check/apply

  async check(values: unknown): Promise<ModuleCheckReport> {
    return checkDirect(this.runtime, values)
  }

  async apply(payload: unknown): Promise<OkResult> {
    return applyDirect(this.runtime, payload)
  }

  // ----------------------------------------------------------------- actions

  async update(id: unknown, values: unknown): Promise<OkResult> {
    return updateDirect(this.runtime, id, values)
  }

  async enable(id: unknown): Promise<OkResult> {
    return enableDirect(this.runtime, id)
  }

  async disable(id: unknown): Promise<OkResult> {
    return disableDirect(this.runtime, id)
  }

  async delete(id: unknown): Promise<OkResult> {
    return deleteDirect(this.runtime, id)
  }
}
