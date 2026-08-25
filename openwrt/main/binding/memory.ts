/**
 * The memory one reconciliation hands to the next, and the MAC keys it is
 * indexed by.
 *
 * Every map in the planner is keyed on a normalized MAC, so a router that
 * reports `AA:BB:...` in one command and `aa:bb:...` in another cannot end up
 * with two entries for the same device. Copies are always deep: the planner is
 * pure, so it must never write through to the memory it was handed, and the
 * device-action path keeps an untouched backup to restore if the pass fails.
 */
import type { BindingPlannerMemory } from './types'

const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/

export function normalizedMac(value: unknown): string {
  const mac = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return MAC.test(mac) ? mac : ''
}

export function emptyPlannerMemory(): BindingPlannerMemory {
  return {
    devices: [],
    waiting: [],
    wanErrors: [],
    orphans: [],
    heldMacs: [],
    forceReassign: [],
    nextOrder: 1,
    prefsExhausted: false
  }
}

export function clonePlannerMemory(memory?: BindingPlannerMemory): BindingPlannerMemory {
  const source = memory ?? emptyPlannerMemory()
  return {
    devices: (source.devices ?? []).map((entry) => ({ ...entry })),
    waiting: (source.waiting ?? []).map((entry) => ({ ...entry })),
    wanErrors: (source.wanErrors ?? []).map((entry) => ({ ...entry })),
    orphans: (source.orphans ?? []).map((entry) => ({ ...entry })),
    heldMacs: [...(source.heldMacs ?? [])],
    forceReassign: (source.forceReassign ?? []).map((entry) => ({ ...entry })),
    nextOrder: Math.max(1, Math.trunc(source.nextOrder) || 1),
    prefsExhausted: source.prefsExhausted === true
  }
}
