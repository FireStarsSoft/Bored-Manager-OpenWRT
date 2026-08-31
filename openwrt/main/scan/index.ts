/**
 * The binding monitor: every source-routed address on the router, including
 * the ones this module never wrote.
 *
 * Until this folder existed the module could only see its own preference band -
 * the fast sweep filters `ip -4 rule show` router-side down to the window it
 * writes in - so a hand-placed rule steering every packet out of a different
 * WAN was invisible here while being the only thing that mattered on the
 * router. `command.ts` reads the whole table in one bounded round trip,
 * `parse.ts` reads it back without the assumptions the reconcile parser is
 * allowed to make, `classify.ts` decides who owns each rule from evidence,
 * `evidence.ts` turns that evidence into a sentence a person can act on, and
 * `engine.ts` is the poller and the cache behind the `monitor` stream.
 *
 * Nothing in here writes to the router. Not one command in this folder changes
 * anything, by design: the rules it is best at finding are the ones whose
 * purpose nobody on this side can know, and the module's answer to those is to
 * explain them and leave them alone.
 *
 * Import this barrel, never a file inside it.
 */
export { SCAN_COMMAND, SCAN_MAX_ROUTES, SCAN_MAX_RULES, SCAN_MAX_TABLES, SCAN_TIMEOUT_MS } from './command'
export {
  KERNEL_BASELINE,
  WELL_KNOWN_TABLES,
  isKernelBaseline,
  parseScanOutput,
  tableLabel,
  tableNumber
} from './parse'
export {
  NO_EXIT,
  buildReason,
  resolveExit,
  routesFor,
  type EvidenceInput,
  type ScanExit
} from './evidence'
export { classifyScan } from './classify'
export { ScanEngine, emptyScanSnapshot, scanRulesLookWhole } from './engine'
export {
  MANAGED_OWNERS,
  OWNER_LABEL,
  type ScanAssignment,
  type ScanClassifyInput,
  type ScanClassifyResult,
  type ScanEngineOptions,
  type ScanOwnerKind,
  type ScanReadout,
  type ScanRow,
  type ScanRuleLine,
  type ScanSnapshot,
  type ScanSummary
} from './types'
