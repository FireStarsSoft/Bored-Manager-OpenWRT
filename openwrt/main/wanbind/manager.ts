/**
 * The object the container holds, and one method per thing a page can ask for.
 *
 * Nothing is decided here. Every method hands the runtime to the free function
 * that owns that behaviour, which is what keeps this surface stable while the
 * files behind it move - the same arrangement `PppoeManager` has, so the two
 * router-owned domains are wired into the container in the same shape.
 *
 * What is worth saying once, at the front door: **this object never writes to
 * the router.** It asks `bm-wanbind` and it sends changes to `bm-wanbind`. The
 * module that used to write ip rules here shared a priority band with the
 * daemon and the two deleted each other's work every thirty seconds, on a real
 * router, for as long as the app stayed open. There is no fall back to writing
 * if a call fails - a failed call means the rows are one tick stale, which the
 * snapshot says. The only fall back is a level up, at the capability verdict,
 * where no package, an old package and a stopped service all mean the same
 * thing and the pages say so instead of quietly doing a worse job.
 */
import { directRows as viewDirectRows } from './view'
import type { ModuleCheckReport } from '@shared/check'
import type { FormFieldOption } from '@shared/module-ui'
import type { OkResult } from '@shared/types'
import type { ModuleContext } from '@shared/modules'
import type { HostStore } from '../store'
import { queueDeviceAction } from './devices'
import {
  applyBind,
  deleteDirect,
  disableDirect,
  enableDirect,
  updateDirect
} from './direct'
import {
  applyInstance,
  deleteInstance,
  startInstance,
  stopInstance,
  updateInstance
} from './instances'
import { carrierOptions, lanOptions, wanPortOptions } from './options'
import { checkBind, checkInstance } from './plan'
import {
  createBindingRuntime,
  disposeRuntime,
  resetRuntime
} from './runtime'
import { settingsApply, settingsCheck, settingsGet } from './settings'
import {
  bindingSnapshot,
  deviceView,
  directSnapshot,
  directTotals,
  monitorInput,
  onSample,
  refreshCache,
  totals,
  type BindingDeviceView,
  type BindingMonitorInput
} from './view'
import { assignmentRows, instanceRows, waitingRows } from './rows'
import { eventRows } from './events'
import type {
  BindingAgentReader,
  BindingAssignmentRow,
  BindingConfigStore,
  BindingJobs,
  BindingListRow,
  BindingRuntime,
  BindingService,
  BindingSnapshot,
  BindingWaitingRow,
  DirectRow,
  DirectSnapshot,
  DirectTotals
} from './types'

/**
 * Which list of options a form is asking for.
 *
 * Every one of them is built from what the router says about its own
 * interfaces rather than from a device name. The version that read names was
 * true of a stock build and of nothing else: it hid the uplink of every router
 * whose modem port is bridged, and refused every address behind a LAN that was
 * not.
 */
export type BindingOptionKind = 'wan-ports' | 'lan-ifaces' | 'binding-carriers'

export class BindingManager {
  private runtime: BindingRuntime

  constructor(
    ctx: ModuleContext,
    config: BindingConfigStore,
    jobs: BindingJobs,
    service: BindingService,
    store: HostStore,
    agent?: BindingAgentReader
  ) {
    this.runtime = createBindingRuntime(ctx, config, jobs, service, store, agent)
  }

  // --------------------------------------------------------------- lifecycle

  /** Called from the fast tick. Reads the router; writes nothing to it. */
  onSample(): void {
    onSample(this.runtime)
  }

  /** What Refresh presses, and what an apply waits for. */
  async refresh(): Promise<void> {
    await refreshCache(this.runtime, true)
  }

  reset(): void {
    resetRuntime(this.runtime)
  }

  dispose(): void {
    disposeRuntime(this.runtime)
  }

  // ----------------------------------------------------------------- queries

  snapshot(): BindingSnapshot {
    return bindingSnapshot(this.runtime)
  }

  directSnapshot(): DirectSnapshot {
    return directSnapshot(this.runtime)
  }

  /**
   * The instance rows, refused and switched-off ones included.
   *
   * A section the daemon will not accept binds nobody and appears in no other
   * list at all, so a page that showed only the live ones would leave out
   * exactly the rows somebody opened it to fix.
   */
  list(): BindingListRow[] {
    const cache = this.runtime.cache
    return instanceRows(cache.info, this.runtime.service.latestModel(), cache.assignments)
  }

  rows(id?: unknown, scope?: unknown): BindingAssignmentRow[] {
    const cache = this.runtime.cache
    const rows = assignmentRows(
      cache.info,
      this.runtime.service.latestModel(),
      cache.assignments,
      Date.now()
    )
    const wanted = typeof id === 'string' ? id : ''
    const only = typeof scope === 'string' ? scope : ''
    return rows.filter(
      (row) =>
        (!wanted || row.instanceId === wanted) &&
        (only !== 'attention' || row.wanStatus !== 'bound')
    )
  }

  waitingRows(id?: unknown): BindingWaitingRow[] {
    const wanted = typeof id === 'string' ? id : ''
    const rows = waitingRows(this.runtime.cache.waiting, Date.now())
    return wanted ? rows.filter((row) => row.instanceId === wanted) : rows
  }

  /**
   * Whether the daemon has answered at all, and therefore whether the two
   * readers below are describing this router or nothing.
   *
   * A page that could not tell "nobody is seated" from "nobody has asked yet"
   * would report an unread router as an empty one, which for the device table
   * means every client on the LAN drawn as unmanaged.
   */
  answered(): boolean {
    return this.runtime.cache.fetchedAt > 0 && this.runtime.cache.info != null
  }

  /** Addresses an instance is holding out of its pool by hand. */
  heldKeys(): Set<string> {
    const out = new Set<string>()

    for (const row of this.runtime.cache.waiting) {
      if (row.held && row.ip) out.add(row.ip)
    }

    return out
  }

  /** Every instance the router has, by the LAN it serves. */
  instanceLans(): Map<string, { id: string; running: boolean }> {
    const out = new Map<string, { id: string; running: boolean }>()
    const info = this.runtime.cache.info

    if (!info) return out

    const running = new Set(info.instances.filter((one) => one.ready).map((one) => one.id))

    for (const config of info.configured) {
      if (!config.lan || out.has(config.lan)) continue
      out.set(config.lan, { id: config.id, running: running.has(config.id) })
    }

    return out
  }

  directRows(): DirectRow[] {
    return viewDirectRows(this.runtime)
  }

  /** Counts for the overview and its history. */
  totals() {
    return totals(this.runtime)
  }

  directTotals(): DirectTotals {
    return directTotals(this.runtime)
  }

  /** Who is on which WAN, for the dashboard's device table. */
  deviceView(): Map<string, BindingDeviceView> {
    return deviceView(this.runtime)
  }

  /** What the rule monitor needs to tell this daemon's rules from anyone's. */
  monitorInput(): BindingMonitorInput {
    return monitorInput(this.runtime)
  }

  /**
   * The carriers instances are currently using.
   *
   * The one place the two automations meet: a binding instance on a carrier is
   * handing that pool's WANs out behind a fail-closed catch-all, so deleting
   * the PPPoE pool underneath would take the LAN down. The PPPoE side cannot
   * know that without asking.
   */
  carriers(): Array<{ id: string; name: string; carrier: string; running: boolean }> {
    return this.list().map((row) => ({
      id: row.id,
      name: row.name,
      carrier: row.carrier,
      running: row.running
    }))
  }

  /** Instance ids to names, for the event ring's own labels. */
  instanceNames(): ReadonlyMap<string, string> {
    const names = new Map<string, string>()
    for (const row of this.list()) names.set(row.id, row.name)
    return names
  }

  /** The names an uninstall has to say out loud before it removes anything. */
  runningInstanceNames(): string[] {
    return this.list()
      .filter((row) => row.running)
      .map((row) => row.name)
  }

  directNames(): string[] {
    return this.directRows()
      .filter((row) => row.source === 'manual')
      .map((row) => row.name)
  }

  instanceCount(): number {
    return this.list().length
  }

  /**
   * The daemon's own numbers.
   *
   * Its shipped defaults when it has not answered yet, rather than null: the
   * capability probe reads two of these to work out which ip rules on the
   * router are this module's, and a probe that got nothing would report the
   * daemon's own rules as somebody else's competing ones.
   */
  settings() {
    return settingsGet(this.runtime)
  }

  // ------------------------------------------------------------ check/apply

  createCheck(values: unknown): Promise<ModuleCheckReport> {
    return checkInstance(this.runtime, values)
  }

  createApply(payload: unknown): Promise<OkResult> {
    return applyInstance(this.runtime, payload)
  }

  bindCheck(values: unknown): Promise<ModuleCheckReport> {
    return checkBind(this.runtime, values)
  }

  bindApply(payload: unknown): Promise<OkResult> {
    return applyBind(this.runtime, payload)
  }

  settingsGet() {
    return settingsGet(this.runtime)
  }

  settingsCheck(values: unknown): ModuleCheckReport {
    return settingsCheck(this.runtime, values)
  }

  settingsApply(payload: unknown): Promise<OkResult> {
    return settingsApply(this.runtime, payload)
  }

  // ----------------------------------------------------------------- actions

  update(id: unknown, values: unknown): Promise<OkResult> {
    return updateInstance(this.runtime, id, values)
  }

  start(id: unknown): Promise<OkResult> {
    return startInstance(this.runtime, id)
  }

  stop(id: unknown): Promise<OkResult> {
    return stopInstance(this.runtime, id)
  }

  delete(id: unknown): Promise<OkResult> {
    return deleteInstance(this.runtime, id)
  }

  /**
   * `enableRefusal` is `directEnable`'s own sentence, rendered by the caller.
   *
   * Passed through rather than looked up, because this half deliberately holds
   * no opinion about what a router can do - see the parameter's own note in
   * `wanbind/direct.ts`.
   */
  directUpdate(id: unknown, values: unknown, enableRefusal?: string): Promise<OkResult> {
    return updateDirect(this.runtime, id, values, enableRefusal)
  }

  directEnable(id: unknown): Promise<OkResult> {
    return enableDirect(this.runtime, id)
  }

  directDisable(id: unknown): Promise<OkResult> {
    return disableDirect(this.runtime, id)
  }

  directDelete(id: unknown): Promise<OkResult> {
    return deleteDirect(this.runtime, id)
  }

  unassign(id: unknown, mac: unknown): Promise<OkResult> {
    return queueDeviceAction(this.runtime, id, mac, 'unassign')
  }

  reassign(id: unknown, mac: unknown): Promise<OkResult> {
    return queueDeviceAction(this.runtime, id, mac, 'reassign')
  }

  pin(id: unknown, mac: unknown, wan: unknown): Promise<OkResult> {
    return queueDeviceAction(this.runtime, id, mac, 'pin', wan)
  }

  // ----------------------------------------------------------------- options

  /**
   * Asked of the router, and empty rather than guessed when it will not answer.
   *
   * A form offering a list this module invented would be offering choices the
   * router has never agreed to - and the create it leads to would be refused
   * afterwards, by which point somebody has typed the rest of the form.
   */
  options(kind: unknown): Promise<FormFieldOption[]> {
    if (kind === 'wan-ports') return wanPortOptions(this.runtime)
    if (kind === 'lan-ifaces') return lanOptions(this.runtime)
    if (kind === 'binding-carriers') return carrierOptions(this.runtime)
    return Promise.resolve([])
  }

  /** The per-instance event ring a drawer reads. */
  eventRows(id: unknown) {
    return eventRows(this.runtime, id)
  }
}
