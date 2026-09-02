/**
 * The binding monitor: every source-routed address on the router, including
 * the ones this module never wrote.
 *
 * Until this folder existed the module could only see its own preference band,
 * so a hand-placed rule steering every packet out of a different WAN was
 * invisible here while being the only thing that mattered on the router. It
 * read the whole table over SSH and classified it here - and that was the last
 * place two halves of one feature could disagree about a rule, because a
 * preference cannot tell an instance's client rule from a hand-written one at
 * the same number.
 *
 * So the reading and the verdict both moved to the daemon, which holds the
 * sections, the bands and the kernel's own dumps at once. What is left is
 * `engine.ts`, the poller and the cache behind the `monitor` stream, and
 * `rows.ts`, which turns one reply into the rows a page renders and adds no
 * opinion of its own.
 *
 * Nothing in here writes to the router. Not one call in this folder changes
 * anything, by design: the rules it is best at finding are the ones whose
 * purpose nobody on this side can know, and the module's answer to those is to
 * explain them and leave them alone.
 *
 * Import this barrel, never a file inside it.
 */
export { ScanEngine, emptyScanSnapshot } from './engine'
export { buildScanRows, emptyScanSummary, tableLabel, type ScanRowsResult } from './rows'
export {
  MANAGED_OWNERS,
  OWNER_LABEL,
  ROUTER_OWNERS,
  type ScanEngineOptions,
  type ScanOwnerKind,
  type ScanRow,
  type ScanRules,
  type ScanSnapshot,
  type ScanSummary
} from './types'
