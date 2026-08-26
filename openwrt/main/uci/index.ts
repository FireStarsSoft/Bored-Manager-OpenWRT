/**
 * What this module still writes to a router over SSH, and the names it is
 * allowed to write it under. The PPPoE half of this folder is gone: pools,
 * their sections and their firewall zone are owned by bm-pppoe-pool on the
 * router, and this side only ever calls its ubus object.
 *
 * Import this barrel, never a file inside it.
 */
export { execTimeout, isPppoePrefix, isSafeUciValue } from './names'
export {
  commandFailure,
  runUciBatch,
  type ExecContext,
  type UciPackage
} from './batch'
