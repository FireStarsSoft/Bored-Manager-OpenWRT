/**
 * What the per-instance event ring is told, and how it gets there.
 *
 * The planner decides what is worth saying about a pass; this file is where
 * that judgement lives, next to the writer that puts it in the bounded ring and
 * mirrors the tail to the live log. Both halves are here because the ring is
 * small: an event that repeats every tick would bury everything else, so most
 * of the code below exists to say a thing once.
 */
import type { BindingInstanceRecord } from '../store'
import { normalizedMac } from './memory'
import type {
  BindingDesiredAssignment,
  BindingDeviceMemory,
  BindingPlannerEvent,
  BindingPlannerPolicy,
  BindingRuntime,
  BindingWaitingMemory,
  CurrentLease,
  WorkingActual
} from './types'

export interface BindingEventContext {
  now: number
  policy: BindingPlannerPolicy
  running: boolean
  releaseGraceMs: number
  /** True when the previous pass had already reported an exhausted range. */
  prefsExhausted: boolean
  previousWaiting: readonly BindingWaitingMemory[]
  currentLeases: ReadonlyMap<string, CurrentLease>
  previousDevices: ReadonlyMap<string, BindingDeviceMemory>
  desiredByMac: ReadonlyMap<string, BindingDesiredAssignment>
  actualByMac: ReadonlyMap<string, WorkingActual>
  observedWanByMac: ReadonlyMap<string, string>
  held: ReadonlySet<string>
  unallocatable: ReadonlySet<string>
}

export function planBindingEvents(context: BindingEventContext): BindingPlannerEvent[] {
  const { now, policy } = context
  const events: BindingPlannerEvent[] = []
  const eventKeys = new Set<string>()
  const pushEvent = (kind: string, text: string, key: string): void => {
    if (eventKeys.has(key) || events.length >= Math.max(1, policy.maxEvents)) return
    eventKeys.add(key)
    events.push({ t: now, kind, text })
  }
  if (!context.running) return events

  // Only on the way in. Running out of preferences is a configuration limit,
  // not an incident: it stays true every tick until someone widens the
  // range, and one notice per tick would bury everything else in the ring.
  if (context.unallocatable.size > 0 && !context.prefsExhausted) {
    pushEvent(
      'exhausted',
      `${context.unallocatable.size} device(s) have a WAN but no free ip rule preference left between ${policy.rulePrefBase} and ${policy.catchAllPrefBase - 1}; they stay queued until that range is widened`,
      'exhausted'
    )
  }
  const oldWaiting = new Set(context.previousWaiting.map((entry) => normalizedMac(entry.mac)))
  for (const [mac, current] of context.currentLeases) {
    const previous = context.previousDevices.get(mac)
    const assignment = context.desiredByMac.get(mac)
    const actualEntry = context.actualByMac.get(mac)
    const oldWan = previous?.wan ?? context.observedWanByMac.get(mac)
    if (assignment) {
      if (oldWan && oldWan !== assignment.wan) {
        pushEvent(
          'remapped',
          `${mac} (${current.lease.ip}) moved from ${oldWan} to ${assignment.wan}`,
          `remap:${mac}:${assignment.wan}`
        )
      } else if (!oldWan && actualEntry?.wan !== assignment.wan) {
        pushEvent(
          'assigned',
          `${mac} (${current.lease.ip}) assigned to ${assignment.wan}`,
          `assign:${mac}:${assignment.wan}`
        )
      }
      if (
        previous?.wan === assignment.wan &&
        previous.ip !== current.lease.ip
      ) {
        pushEvent(
          'ip-change',
          `${mac} kept ${assignment.wan} after IP changed from ${previous.ip} to ${current.lease.ip}`,
          `ip:${mac}:${current.lease.ip}`
        )
      }
    } else if (previous?.wan) {
      pushEvent(
        context.held.has(mac) ? 'unassigned' : 'waiting',
        `${mac} (${current.lease.ip}) released ${previous.wan} and is waiting`,
        `release:${mac}`
      )
    }
    if (!assignment && !oldWaiting.has(mac)) {
      pushEvent(
        'waiting',
        `${mac} (${current.lease.ip}) entered the WAN queue`,
        `wait:${mac}`
      )
    }
  }
  for (const [mac, previous] of context.previousDevices) {
    if (
      context.currentLeases.has(mac) ||
      now - previous.lastSeenAt < context.releaseGraceMs ||
      !previous.wan
    ) {
      continue
    }
    pushEvent(
      'released',
      `${mac} lease grace expired; ${previous.wan} returned to the pool`,
      `expired:${mac}`
    )
  }
  return events
}

export function recordEvents(
  runtime: BindingRuntime,
  instance: BindingInstanceRecord,
  events: readonly BindingPlannerEvent[]
): void {
  if (runtime.disposed || events.length === 0) return
  runtime.store.update((data) => {
    for (const event of events) {
      data.events.push([
        instance.id,
        event.t,
        event.kind,
        event.text.slice(0, 500)
      ])
    }
  })
  const emitLimit = 8
  if (events.length > emitLimit) {
    runtime.ctx.emit('bindingLog', {
      id: instance.id,
      data: `${new Date().toISOString()} [${instance.name}] ${events.length - emitLimit} earlier event(s) omitted from the live log`
    })
  }
  for (const event of events.slice(-emitLimit)) {
    runtime.ctx.emit(
      'bindingLog',
      {
        id: instance.id,
        data: `${new Date(event.t).toISOString()} [${instance.name}] ${event.text}`
      }
    )
  }
}
