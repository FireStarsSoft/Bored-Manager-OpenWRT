/**
 * PPPoE automation orchestration.
 *
 * Passwords exist only in a one-use check-session payload and in the closures
 * of the running create job. Batch records, job labels/messages, streams and
 * renderer rows never contain them.
 *
 * `plan.ts` is the gate a create has to pass and `create.ts` is the job that
 * follows it; around them sit the files each remaining behaviour lives in - the
 * range allocator, the action waves and their watchdog, the delete, the three
 * router inspections, and the rows every surface renders. `manager.ts` is the
 * object the module holds and `runtime.ts` is the state it carries. Import this
 * barrel, never a file inside it.
 *
 * Nothing here knows the binding half exists: it is reached only through the
 * optional `bindingCarriers` member of `PppoeService`, which `index.ts` fills
 * in. The two domains meet there, not in each other.
 */
export type {
  PppoeBatchSummary,
  PppoeConfigStore,
  PppoeDisplayRow,
  PppoeHostStore,
  PppoeJobs,
  PppoeRow,
  PppoeRules,
  PppoeService,
  PppoeSnapshot,
  PppoeStatus,
  PppoeStoreData,
  RouterInventory
} from './types'
export { findSequenceRange } from './range'
export { PppoeManager } from './manager'
