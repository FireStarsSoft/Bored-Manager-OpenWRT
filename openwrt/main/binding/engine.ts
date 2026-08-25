/**
 * The object the rest of the module holds: one runtime, and a method per thing
 * a page or a handler can ask for.
 *
 * Nothing is decided here. Every method hands the runtime to the free function
 * that owns that behaviour, which is what keeps the surface stable while the
 * files behind it move. The `binding*`-prefixed methods are the names the UI
 * specs call and the short ones are what the module's own code uses; both are
 * kept because both are in use.
 */
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import type { HostStore } from '../store'
import type { RouterModel } from '../types'
import { checkBinding } from './check'
import { queueDeviceAction } from './devices'
import { updateInstance } from './edit'
import {
  deleteInstance,
  dispose,
  reset,
  startInstance,
  stopInstance
} from './lifecycle'
import { applyBinding } from './prepare'
import { onSample } from './reconcile'
import { createBindingRuntime } from './runtime'
import { reconcileWanTables } from './tables'
import {
  assignmentRows,
  eventRows,
  listRows,
  snapshot,
  waitingRows
} from './view'
import type {
  BindingAssignmentRow,
  BindingEngineOptions,
  BindingEventRow,
  BindingListRow,
  BindingRuntime,
  BindingSnapshot,
  BindingWaitingRow,
  WanTableSource
} from './types'

export class BindingEngine {
  private runtime: BindingRuntime

  constructor(ctx: ModuleContext, store: HostStore, options: BindingEngineOptions) {
    this.runtime = createBindingRuntime(ctx, store, options)
  }

  // ---------------------------------------------------------------- queries

  snapshot(): BindingSnapshot {
    return snapshot(this.runtime)
  }

  /**
   * Which carrier each instance owns, read from the records rather than the
   * summary cache so it is right before the first reconcile has run.
   *
   * The PPPoE side needs this to answer one question before it deletes a pool:
   * is a running instance distributing LAN clients across it? A running
   * instance installs a fail-closed catch-all - `unreachable default` in its
   * own table - precisely so a client can never leak onto the wrong WAN. Delete
   * the pool underneath it and that catch-all is all that is left: every bound
   * client loses the internet, and nothing in either half reports why.
   */
  carriers(): Array<{ id: string; name: string; carrier: string; running: boolean }> {
    return this.runtime.store.read().instances.map((instance) => ({
      id: instance.id,
      name: instance.name,
      carrier: instance.carrier,
      running: instance.running
    }))
  }

  list(): BindingListRow[] {
    return listRows(this.runtime)
  }

  bindingRows(idRaw: unknown, scopeRaw?: unknown): BindingAssignmentRow[] {
    return this.rows(idRaw, scopeRaw)
  }

  /** `scopeRaw` is the drawer's open tab; see `assignmentRows` in `view.ts`. */
  rows(idRaw: unknown, scopeRaw?: unknown): BindingAssignmentRow[] {
    return assignmentRows(this.runtime, idRaw, scopeRaw)
  }

  bindingWaitingRows(idRaw: unknown): BindingWaitingRow[] {
    return this.waitingRows(idRaw)
  }

  waitingRows(idRaw: unknown): BindingWaitingRow[] {
    return waitingRows(this.runtime, idRaw)
  }

  bindingEventRows(idRaw: unknown): BindingEventRow[] {
    return this.eventRows(idRaw)
  }

  eventRows(idRaw: unknown): BindingEventRow[] {
    return eventRows(this.runtime, idRaw)
  }

  async reconcileWanTables(source: WanTableSource): Promise<void> {
    return reconcileWanTables(this.runtime, source)
  }

  // ------------------------------------------------------------- check/apply

  async bindingCheck(raw: unknown): Promise<ModuleCheckReport> {
    return this.check(raw)
  }

  async check(raw: unknown): Promise<ModuleCheckReport> {
    return checkBinding(this.runtime, raw)
  }

  async bindingApply(raw: unknown): Promise<OkResult> {
    return this.apply(raw)
  }

  async apply(raw: unknown): Promise<OkResult> {
    return applyBinding(this.runtime, raw)
  }

  // --------------------------------------------------------------- lifecycle

  async onSample(model: RouterModel, forceKernel = false): Promise<void> {
    return onSample(this.runtime, model, forceKernel)
  }

  reset(): void {
    reset(this.runtime)
  }

  dispose(): void {
    dispose(this.runtime)
  }

  // --------------------------------------------------------------- actions

  async bindingStart(idRaw: unknown): Promise<OkResult> {
    return this.start(idRaw)
  }

  async start(idRaw: unknown): Promise<OkResult> {
    return startInstance(this.runtime, idRaw)
  }

  async bindingStop(idRaw: unknown): Promise<OkResult> {
    return this.stop(idRaw)
  }

  async stop(idRaw: unknown): Promise<OkResult> {
    return stopInstance(this.runtime, idRaw)
  }

  bindingUpdate(idRaw: unknown, valuesRaw: unknown): OkResult {
    return this.update(idRaw, valuesRaw)
  }

  /**
   * Rename an instance or change its two behaviour flags. The LAN and the
   * carrier are refused: see `edit.ts`.
   */
  update(idRaw: unknown, valuesRaw: unknown): OkResult {
    return updateInstance(this.runtime, idRaw, valuesRaw)
  }

  async bindingDelete(idRaw: unknown): Promise<OkResult> {
    return this.delete(idRaw)
  }

  async delete(idRaw: unknown): Promise<OkResult> {
    return deleteInstance(this.runtime, idRaw)
  }

  async bindingUnassign(idOrKeys: unknown, macRaw?: unknown): Promise<OkResult> {
    return this.unassign(idOrKeys, macRaw)
  }

  async unassign(idOrKeys: unknown, macRaw?: unknown): Promise<OkResult> {
    return queueDeviceAction(this.runtime, idOrKeys, macRaw, 'unassign')
  }

  async bindingReassign(idOrKeys: unknown, macRaw?: unknown): Promise<OkResult> {
    return this.reassign(idOrKeys, macRaw)
  }

  async reassign(idOrKeys: unknown, macRaw?: unknown): Promise<OkResult> {
    return queueDeviceAction(this.runtime, idOrKeys, macRaw, 'reassign')
  }

  async bindingPin(idRaw: unknown, macRaw: unknown, wanRaw: unknown): Promise<OkResult> {
    return this.pin(idRaw, macRaw, wanRaw)
  }

  /**
   * Put one device on one named WAN and keep it there. Unlike Reassign, which
   * only says "not the one you have", this is refused rather than approximated
   * when the WAN cannot take the device; see `pinRefusal` in `devices.ts`.
   */
  async pin(idRaw: unknown, macRaw: unknown, wanRaw: unknown): Promise<OkResult> {
    return queueDeviceAction(this.runtime, idRaw, macRaw, 'pin', wanRaw)
  }
}
