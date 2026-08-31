/**
 * One-to-one DHCP client -> WAN policy routing.
 *
 * The router remains the source of truth. Every fast sample reconstructs the
 * actual assignment from `ip rule`, DHCP leases and the table/WAN map, then the
 * pure planner returns only the lines needed to reach the desired state. RAM is
 * used only for grace timers, FIFO order and action holds; only instance
 * configuration, extra tables, sticky choices and the bounded event ring are
 * written through HostStore.
 *
 * `planner.ts` is that pure pass and `engine.ts` is the object the module
 * holds; between them sit the files each behaviour lives in - the check gate,
 * the preparation job, the reconcile pass, the routing-table audit, the device
 * actions, the lifecycle and the rows every surface renders. Import this
 * barrel, never a file inside it.
 *
 * The second half of the exports below is published for the sibling
 * one-to-one automation, which binds a single address the same way this folder
 * binds a whole LAN and must reach these writers, verdicts and allocators
 * through the barrel rather than by reaching past it.
 */
// One tokenizer for `uci show` values, shared with the slow probe's firewall
// zone reader. Re-exported because this is where it was first published.
export { tokenizeUciValues } from '../parse'
export type {
  BindingActualAssignment,
  BindingAssignmentRow,
  BindingDesiredAssignment,
  BindingDeviceMemory,
  BindingDeviceSummary,
  BindingEngineOptions,
  BindingEventRow,
  BindingForcedReassign,
  BindingJobRunner,
  BindingListRow,
  BindingOrphanMemory,
  BindingPlannerEvent,
  BindingPlannerInstance,
  BindingPlannerMemory,
  BindingPlannerPolicy,
  BindingPlannerResult,
  BindingPlannerWan,
  BindingReconcileInput,
  BindingRuleChange,
  BindingRuleDiff,
  BindingSnapshot,
  BindingStickyChoice,
  BindingSummaryInstance,
  BindingWanAggregate,
  BindingTableToWan,
  BindingWaitingMemory,
  BindingWaitingRow,
  BindingWanErrorMemory,
  BindingWanSummary,
  ExecDeps,
  RouterPreparationProbe,
  TablePreparation,
  UciDocument,
  WanTableIndex,
  WanTableSource
} from './types'
export { chunkRuleCommands } from './rules'
export { planBindingReconciliation } from './planner'
// The one derivation of an instance's catch-all source set, published because
// the installer, the per-tick repair and anything that has to reason about what
// this module wrote at a catch-all preference all have to agree on it.
export { catchAllCidrs } from './reconcile'
export { BindingEngine } from './engine'
export { ENGINE_STOPPED, NO_SAMPLE, execScript, shellFailure, uciWrite } from './runtime'
export {
  allocateWanTables,
  installScopedForwardings,
  removeScopedForwardings,
  zoneFindings
} from './shared'
export { buildWanTableIndex, claimExtraTables, writeWanTables } from './tables'
export { lanCidr, wanState, wanUsable } from './pool'
export {
  FIREWALL_ZONE,
  UCI_SECTION,
  firewallZoneForNetwork,
  networkTables,
  preparationProbe
} from './uci-doc'
export { applyRuleDiffInMemory, catchAllRoute, ruleIp } from './rules'
