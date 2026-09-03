/**
 * What the router has, against what its configuration needs.
 *
 * `types.ts` is the payload the page renders; `normalize.ts` turns one reply
 * into it and is the only place that decides what an absent fact looks like;
 * `fixes.ts` writes the two sentences on a Fix row; `manager.ts` is the object
 * the container holds.
 *
 * Import this barrel, never a file inside it.
 */
export { CapacityManager, type CapacityDeps, type CapacityWriters } from './manager'
export { describeFix, describeFixes, translateTune } from './fixes'
export {
  CAPACITY_INTERVAL_MS,
  CAPACITY_REPORT_MAX_AGE_MS,
  capacityAvailable,
  capacityNeedsUpdate,
  emptyCapacitySnapshot,
  normalizeCapacity,
  unavailableCapacity,
  withStaleness
} from './normalize'
export type {
  CapacityFinding,
  CapacityFixKind,
  CapacityFixRow,
  CapacitySnapshot,
  CapacityState,
  CapacityTierRow,
  StabilityLevel
} from './types'
