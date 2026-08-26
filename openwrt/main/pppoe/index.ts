/**
 * PPPoE pools, driven entirely through `bm-pppoe-pool` on the router.
 *
 * The daemon owns the record and everything derived from it - interfaces,
 * tagged devices, MACs, routing tables, the firewall zone - and this folder
 * is the client: it parses forms into specs, shows the daemon's findings,
 * caches its answers for the tables, and wraps the mutations in jobs so they
 * leave history. Passwords exist in a frozen spec and in a 0600 file on the
 * router, never in a record, a job label, a stream or an event.
 *
 * `plan.ts` is the gate, `create.ts`/`edit.ts`/`lifecycle.ts` are the
 * mutations, `actions.ts` the per-member ones, `view.ts` everything a surface
 * renders, `manager.ts` the object the module holds and `runtime.ts` the
 * state it carries. Import this barrel, never a file inside it.
 *
 * Nothing here knows the binding half exists: it is reached only through the
 * optional `bindingCarriers` member of `PppoeService`, which `index.ts` fills
 * in. The two domains meet there, not in each other.
 */
export type {
  PppoeConfigStore,
  PppoeDisplayRow,
  PppoeJobs,
  PppoeLegacyRow,
  PppoePoolRow,
  PppoeService,
  PppoeSnapshot
} from './types'
export { compressVlans } from './view'
export { parseMemberLines, parseVlanList } from './plan'
export { PppoeManager } from './manager'
