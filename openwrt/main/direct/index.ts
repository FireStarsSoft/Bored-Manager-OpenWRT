/**
 * Binding 1-1: one address, one WAN port, chosen by hand.
 *
 * Where the folder next door hands every DHCP client on a LAN a WAN of its own,
 * this one takes a single address - or a single device, followed by its MAC -
 * and nails it to a port somebody picked. It is one `ip rule` per binding, in a
 * preference band that ends below every band the instance half writes in, which
 * is what makes a hand-placed binding beat an instance assignment for the same
 * address and stay invisible to the instance planner at the same time.
 *
 * The interesting decision is what happens when that port goes down. A rule
 * whose table has no route does not fail - the kernel walks on to the next rule
 * and out the main table, which is the router's default connection. So holding
 * is an explicit re-point onto the module's blackhole table rather than a rule
 * left where it was, and `reconcile.ts` is the pure pass that decides it.
 *
 * `reconcile.ts` is that pass, `pass.ts` is the I/O around it, and between them
 * sit the files each behaviour lives in - the create gate, the preparation job,
 * the actions, and the rows every surface renders. Import this barrel, never a
 * file inside it.
 */
export { DirectEngine } from './engine'
export { planDirectReconciliation, directWans } from './reconcile'
export { freeDirectPref, freeDirectSlot, lanForAddress } from './allocate'
// The one place that decides what an interface is. Published because the
// regression net for that decision is a test file rather than another folder,
// and because a name-based guess is exactly what it replaced.
//
// The two refusals leave the folder for a second reason: the instance half next
// door asks the same question from both ends - is the LAN its form was given
// really an uplink, and is any member of the pool really one of the router's own
// LANs - and the sentences it says have to be these. Said twice in two files,
// the halves of one decision drift, and the operator gets two different accounts
// of why the router will not do what they asked.
export {
  chooseLan,
  lanCandidates,
  lanIsUplinkRefusal,
  routerLayout,
  wanIsLanRefusal
} from './layout'
export { directPolicy } from './pass'
export { buildRow, countTotals, durationLabel } from './view'
export { leaseAddresses, normalizeMac, resolveTarget, targetLabel, MAC_ADDRESS } from './target'
export type {
  DirectDesiredRule,
  DirectEngineOptions,
  DirectMemoryEntry,
  DirectPlan,
  DirectPlannerEvent,
  DirectPlannerResult,
  DirectPolicy,
  DirectReconcileInput,
  DirectRow,
  DirectSnapshot,
  DirectState,
  DirectTotals,
  IfaceRole,
  IfaceVerdict,
  LanSearch,
  RouterLayout
} from './types'
