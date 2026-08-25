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
  BindingTableToWan,
  BindingWaitingMemory,
  BindingWaitingRow,
  BindingWanErrorMemory,
  BindingWanSummary,
  WanTableSource
} from './types'
export { chunkRuleCommands } from './rules'
export { planBindingReconciliation } from './planner'
export { BindingEngine } from './engine'
