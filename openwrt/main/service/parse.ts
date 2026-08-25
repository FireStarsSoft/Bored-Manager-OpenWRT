/**
 * The last step between a sweep section and the model, for the three sections
 * that need more than `../parse.ts` gives them.
 *
 * That file is the shared library of text readers and stays pure: section in,
 * structure out. What is left here needs context it cannot have - whether a
 * section is worth parsing at all, and which of the two clocks in play a lease
 * is counted against.
 */
import type { Lease } from '../types'

/**
 * Whether the DUMP section is a whole `network.interface dump` rather than the
 * front half of one. `parseDump` is tolerant by design and answers `[]` for
 * both, which is exactly the case the caller has to tell apart: an empty list
 * would silently erase every interface the module knows about.
 */
export function validDump(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown
    return (
      Array.isArray(value) ||
      (typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as { interface?: unknown }).interface))
    )
  } catch {
    return false
  }
}

/** The router's own wall clock out of the SYS section, or null if it gave none. */
export function routerLocaltime(text: string): number | null {
  try {
    const value = JSON.parse(text) as { localtime?: unknown }
    return typeof value.localtime === 'number' && Number.isFinite(value.localtime)
      ? value.localtime
      : null
  } catch {
    return null
  }
}

/**
 * The leases still worth showing, one per MAC, with expiry moved onto our clock.
 */
export function activeLeases(
  leases: readonly Lease[],
  at: number,
  routerNowSec: number | null
): Lease[] {
  const byMac = new Map<string, Lease>()
  for (const lease of leases) {
    let normalized = lease
    if (lease.expires !== 0) {
      if (routerNowSec != null) {
        const remaining = lease.expires - routerNowSec
        if (remaining <= 0) continue
        normalized = {
          ...lease,
          // Keep expiry comparable with the app-clock model timestamp even when
          // the router has not synchronized its wall clock yet.
          expires: Math.floor(at / 1_000) + remaining
        }
      } else {
        // No `localtime` in `ubus call system info`, so there is no offset to
        // rebase by. The raw router epoch used to be handed on as though it
        // were ours, and both places that read it compare against Date.now():
        // a router still waiting for NTP reports 1970, so every lease showed
        // as expired and the binding automation skipped every one of them.
        // Saying "unknown" keeps the lease and keeps the table honest.
        normalized = { ...lease, expiresUnknown: true }
      }
    }
    const old = byMac.get(normalized.mac)
    const rank =
      normalized.expires === 0 ? Number.MAX_SAFE_INTEGER : normalized.expires
    const oldRank =
      old == null
        ? -1
        : old.expires === 0
          ? Number.MAX_SAFE_INTEGER
          : old.expires
    if (rank >= oldRank) byMac.set(normalized.mac, normalized)
  }
  return [...byMac.values()]
}
