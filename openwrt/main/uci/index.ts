/**
 * Everything this module writes to a router, and the names it is allowed to
 * write them under.
 *
 * Four files behind one door: `names.ts` decides what a legal name is,
 * `pppoe-plan.ts` turns accounts into UCI lines, `firewall.ts` does the same
 * for the shared zone, and `batch.ts` is the only one that executes anything.
 * Import this barrel, never a file inside it.
 */
export {
  MAX_PPPOE_CHUNKS,
  MAX_PPPOE_SEQUENCE,
  assertUciName,
  assertZoneValue,
  checkedSections,
  chunkValues,
  effectivePppoeChunkSize,
  execTimeout,
  isManagedSectionName,
  isPppoePrefix,
  isSafeDeviceName,
  isSafeUciValue,
  padPppoeSequence,
  pppoeSectionName,
  pppoeTableId,
  vlanSectionName
} from './names'
export {
  buildDeletePppoeLines,
  buildDeleteVlanLines,
  buildPppoeSections,
  buildPppoeUci,
  buildPppoeUciLines,
  planPppoeChunks,
  type FirewallMode,
  type PppoeAccount,
  type PppoeBuildOptions,
  type PppoeSectionPlan,
  type PppoeUciChunk
} from './pppoe-plan'
export {
  UciCancelledError,
  applyInterfaceWave,
  applyPppoeChunk,
  commandFailure,
  reloadFirewall,
  reloadNetwork,
  runUciBatch,
  type UciPackage,
  waitCancelable,
  type ApplyChunkOptions,
  type ExecContext,
  type InterfaceAction
} from './batch'
export {
  POOL_FORWARDING_SECTION,
  applyFirewallPlan,
  buildFirewallPlan,
  buildZoneTeardownLines,
  verifyFirewall,
  type ApplyFirewallOptions,
  type FirewallApplyResult,
  type FirewallPlan,
  type FirewallPlanOptions,
  type FirewallVerification
} from './firewall'
