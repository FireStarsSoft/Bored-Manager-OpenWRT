/**
 * WAN Binding, as a client of the router's own `bm-wanbind`.
 *
 * One address nailed to one WAN port by hand, and instances that hand a LAN's
 * clients out across a pool of WANs - a line each, several to a line, or all of
 * them on one - optionally scoped to an address range. All of it decided and
 * written on the router: the sections, the routing tables, the firewall paths,
 * the fail-closed catch-all and every ip rule.
 *
 * **This folder writes nothing to the router.** That is the whole reason it
 * exists. The half it replaces wrote ip rules over SSH into the same priority
 * band the daemon owns, without ever writing the sections that would have made
 * them the router's - so on a real router the daemon removed thirty-four rules
 * every thirty seconds and this module wrote them back a second later, for
 * ever, with every surface green and each bound address on the router's default
 * connection for about a second in every thirty. Neither half reported a
 * conflict, because each was doing exactly what it had been told.
 *
 * So there is no fall back to writing here and there must never be one. A call
 * that fails means the rows are one tick stale, which the snapshot says. The
 * only fall back is a level up at the capability verdict, where no package, a
 * package too old to drive and a stopped service all mean the same thing, and
 * the pages say so rather than quietly doing a worse job of it.
 *
 * Import this barrel, never a file inside it.
 */
export { BindingManager, type BindingOptionKind } from './manager'
export { handoverNotice } from './handover-notice'
export { durationLabel } from './clock'
export { daemonProblem, daemonReady } from './runtime'
export type {
  BindingAgentReader,
  BindingAssignmentRow,
  BindingConfigStore,
  BindingDeviceSummary,
  BindingEventRow,
  BindingJobs,
  BindingListRow,
  BindingRules,
  BindingService,
  BindingSnapshot,
  BindingWaitingRow,
  BindingWanAggregate,
  BindingWanSummary,
  DirectRow,
  DirectSnapshot,
  DirectTotals
} from './types'
export type { BindingDeviceView, BindingMonitorInput } from './view'
