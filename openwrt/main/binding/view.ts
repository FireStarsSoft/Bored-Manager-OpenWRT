/**
 * Everything a surface renders: the two device tables, the instance list, the
 * event log and the counts behind their chips.
 *
 * Nothing here decides anything. The planner hands over the assignment it
 * arrived at and the engine hands over its cache; this file only turns them
 * into rows, and it is the only place that knows what a row looks like.
 */
import type { ValueBadge } from '@shared/module-ui'
import { BADGE, badge, countBadges, statusBadges } from '../badges'
import { wanState } from './pool'
import type {
  BindingAssignmentRow,
  BindingWanAggregate,
  BindingDesiredAssignment,
  BindingDeviceMemory,
  BindingDeviceSummary,
  BindingEventRow,
  BindingListRow,
  BindingPlannerWan,
  BindingRuntime,
  BindingSnapshot,
  BindingSummaryInstance,
  BindingWaitingMemory,
  BindingWaitingRow,
  BindingWanSummary,
  CurrentLease
} from './types'

export function durationLabel(msRaw: number): string {
  const seconds = Math.max(0, Math.floor(msRaw / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function emptyWanSummary(): BindingWanSummary {
  return { total: 0, available: 0, bound: 0, error: 0, warning: 0, dialing: 0 }
}

/**
 * Every instance's pool folded into one set of counts.
 *
 * A page spec can neither sum a column nor divide two of them, so a donut of
 * "what is the whole pool doing" and a meter of "how full is it" have to
 * arrive already computed or not at all.
 */
function aggregateWans(
  instances: readonly BindingSummaryInstance[]
): BindingWanAggregate {
  const total = instances.reduce(
    (sum, instance) => ({
      total: sum.total + instance.wan.total,
      available: sum.available + instance.wan.available,
      bound: sum.bound + instance.wan.bound,
      error: sum.error + instance.wan.error,
      warning: sum.warning + instance.wan.warning,
      dialing: sum.dialing + instance.wan.dialing
    }),
    emptyWanSummary()
  )
  return {
    ...total,
    // Zero rather than a division by nothing. A router with no instance has an
    // empty pool, and "0% of nothing is bound" is the true reading of it.
    boundPct: total.total > 0 ? Math.round((total.bound / total.total) * 100) : 0
  }
}

export function emptyDeviceSummary(): BindingDeviceSummary {
  return { total: 0, bound: 0, waiting: 0 }
}

/**
 * A stopped instance says only that; a running one says what it is doing and,
 * more importantly, what it is failing to do. `running` on its own is the
 * fallback for the instant after a start, before the first reconcile has
 * anything to count.
 */
function instanceStateBadges(running: boolean, summary: BindingSummaryInstance): ValueBadge[] {
  if (!running) return [badge('stopped')]
  const chips = countBadges([
    { label: 'WAN error', count: summary.wan.error, color: BADGE.bad },
    { label: 'waiting', count: summary.devices.waiting, color: BADGE.warn },
    { label: 'dialing', count: summary.wan.dialing, color: BADGE.busy },
    { label: 'bound', count: summary.devices.bound, color: BADGE.good }
  ])
  return chips.length ? chips : [badge('running', BADGE.good)]
}

export function plannerWaitingRows(context: {
  instanceId: string
  now: number
  queue: readonly BindingWaitingMemory[]
  currentLeases: ReadonlyMap<string, CurrentLease>
  previousDevices: ReadonlyMap<string, BindingDeviceMemory>
  held: ReadonlySet<string>
  unallocatable: ReadonlySet<string>
  /**
   * Addresses a one-to-one binding owns. Optional because the router-owned half
   * builds these rows from the daemon's own answer, and `bm-wanbind` has no
   * reserved-address list to report - so there the field is absent rather than
   * empty, which is the honest statement of "this half cannot know".
   */
  reservedIps?: ReadonlySet<string>
}): BindingWaitingRow[] {
  return context.queue.map((entry, index) => {
    const lease = context.currentLeases.get(entry.mac)?.lease
    const isHeld = context.held.has(entry.mac)
    const ip = lease?.ip ?? context.previousDevices.get(entry.mac)?.ip ?? ''
    return {
      key: `${context.instanceId}|${entry.mac}`,
      instanceId: context.instanceId,
      mac: entry.mac,
      host: lease?.host ?? context.previousDevices.get(entry.mac)?.host ?? '',
      ip,
      position: index + 1,
      waitingSince: entry.enqueuedAt,
      waitingFor: durationLabel(context.now - entry.enqueuedAt),
      // Every row used to read as though a free WAN were the only thing
      // missing. For a held device that is untrue, and for one the preference
      // range could not seat it is unactionable: no WAN coming free will help.
      //
      // A one-to-one binding is checked first of the four because it outranks
      // the other three as an explanation: the address already has a WAN, from
      // the other automation, and no action on this page - releasing a hold,
      // widening the preference range, freeing a WAN - will ever move it.
      reason: context.reservedIps?.has(ip)
        ? 'bound one-to-one'
        : isHeld
          ? 'unassigned by hand'
          : context.unallocatable.has(entry.mac)
            ? 'preferences exhausted'
            : 'waiting for a free WAN',
      held: isHeld,
      heldLabel: isHeld ? 'Held' : 'Waiting',
      holdBadges: statusBadges(isHeld ? 'held' : 'waiting')
    }
  })
}

export function plannerAssignmentRows(context: {
  instanceId: string
  now: number
  warnUptimeSec: number
  desired: readonly BindingDesiredAssignment[]
  devicesByMac: ReadonlyMap<string, BindingDeviceMemory>
  poolByName: ReadonlyMap<string, BindingPlannerWan>
}): BindingAssignmentRow[] {
  return context.desired
    .filter(
      (entry): entry is BindingDesiredAssignment & { mac: string } =>
        entry.mac != null
    )
    .map((entry) => {
      const device = context.devicesByMac.get(entry.mac)
      const wan = context.poolByName.get(entry.wan)
      const state = wan ? wanState(wan, context.warnUptimeSec) : 'missing'
      const wanStatus = state === 'available' ? 'bound' : state
      return {
        key: `${context.instanceId}|${entry.mac}`,
        instanceId: context.instanceId,
        host: device?.host ?? '',
        mac: entry.mac,
        ip: entry.ip,
        wan: entry.wan,
        wanIp: wan?.ipv4 ?? '',
        wanStatus,
        wanStatusBadges: statusBadges(wanStatus),
        assignedAt: entry.assignedAt,
        sinceLabel: durationLabel(context.now - entry.assignedAt)
      }
    })
}

export function summarizeWans(
  wans: readonly BindingPlannerWan[],
  warnUptimeSec: number,
  usedWanNames: ReadonlySet<string>
): BindingWanSummary {
  const summary: BindingWanSummary = {
    total: wans.length,
    available: 0,
    bound: 0,
    error: 0,
    warning: 0,
    dialing: 0
  }
  for (const wan of wans) {
    const state = wanState(wan, warnUptimeSec)
    if (state === 'dialing') summary.dialing += 1
    else if (state === 'error') summary.error += 1
    else if (state === 'warning') summary.warning += 1
    else if (usedWanNames.has(wan.name)) summary.bound += 1
    else summary.available += 1
  }
  return summary
}

// ---------------------------------------------------------------- engine side

export function snapshot(runtime: BindingRuntime): BindingSnapshot {
  return runtime.latestPayload
}

function instanceSummary(
  runtime: BindingRuntime,
  instance: { id: string; name: string; lan: string; carrier: string; running: boolean }
): BindingSummaryInstance {
  return (
    runtime.cache.get(instance.id)?.summary ?? {
      id: instance.id,
      name: instance.name,
      lan: instance.lan,
      carrier: instance.carrier,
      running: instance.running,
      wan: emptyWanSummary(),
      devices: emptyDeviceSummary()
    }
  )
}

export function listRows(runtime: BindingRuntime): BindingListRow[] {
  return runtime.store.read().instances.map((instance) => {
    const summary = instanceSummary(runtime, instance)
    return {
      ...summary,
      runningLabel: instance.running ? 'running' : 'stopped',
      // From the record rather than the cached summary: the row's own edit
      // form opens on these, and the cache is only refreshed by a reconcile.
      sticky: instance.sticky,
      remap: instance.remap,
      stateBadges: instanceStateBadges(instance.running, summary),
      wanTotal: summary.wan.total,
      wanAvailable: summary.wan.available,
      wanBound: summary.wan.bound,
      wanError: summary.wan.error,
      wanWarning: summary.wan.warning,
      wanDialing: summary.wan.dialing,
      deviceTotal: summary.devices.total,
      deviceBound: summary.devices.bound,
      deviceWaiting: summary.devices.waiting
    }
  })
}

/**
 * The scope an instance drawer asks for when it is showing its "Needs
 * attention" tab rather than every assignment. The same split the PPPoE drawer
 * makes, and for the same reason: the table re-polls on the fast interval for
 * as long as the drawer is open.
 */
const ATTENTION = 'attention'

export function assignmentRows(
  runtime: BindingRuntime,
  idRaw: unknown,
  scopeRaw?: unknown
): BindingAssignmentRow[] {
  const rows = runtime.cache.get(String(idRaw ?? ''))?.assignments ?? []
  // A device sitting happily on a healthy WAN is not what an operator opened
  // this table to find; `bound` is the only status that says it is.
  return scopeRaw === ATTENTION ? rows.filter((row) => row.wanStatus !== 'bound') : [...rows]
}

export function waitingRows(runtime: BindingRuntime, idRaw: unknown): BindingWaitingRow[] {
  return [...(runtime.cache.get(String(idRaw ?? ''))?.waiting ?? [])]
}

export function eventRows(runtime: BindingRuntime, idRaw: unknown): BindingEventRow[] {
  const id = String(idRaw ?? '')
  return runtime.store
    .read()
    .events.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry[0] === id)
    .reverse()
    .map(({ entry, index }) => ({
      id: `${entry[1]}-${index}`,
      when: new Date(entry[1]).toISOString(),
      t: entry[1],
      kind: entry[2],
      text: entry[3]
    }))
}

/**
 * Push the rows every surface renders. `error` is the message of a reconcile
 * that failed; the rows are still published - a page with nothing on it says
 * less than stale rows that admit they are stale - but they keep the timestamp
 * of the last pass that actually reached the router, and carry what went
 * wrong so a surface can say it.
 */
export function emitSnapshot(
  runtime: BindingRuntime,
  t: number,
  error: string | null = null
): void {
  if (runtime.disposed) return
  const instances = runtime.store
    .read()
    .instances.map((instance) => instanceSummary(runtime, instance))
  runtime.latestPayload = {
    t: error == null ? t : runtime.latestPayload.t,
    hookOk: error == null,
    lastError: error ?? '',
    instances,
    rows: listRows(runtime),
    wans: aggregateWans(instances)
  }
  runtime.ctx.emit('binding', runtime.latestPayload)
}

/**
 * Re-push the rows after something that changed them without going near the
 * router. It claims neither a new sample nor a new verdict: a rename must not
 * make a reconcile that is still failing look like it recovered.
 */
export function republishSnapshot(runtime: BindingRuntime): void {
  emitSnapshot(
    runtime,
    runtime.latestPayload.t,
    runtime.latestPayload.hookOk ? null : runtime.latestPayload.lastError
  )
}
