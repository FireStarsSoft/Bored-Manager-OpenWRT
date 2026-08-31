/**
 * What a binding names, and which address that is at this moment.
 *
 * A one-to-one binding names either an address or a device. The first is the
 * whole answer on its own; the second has to be resolved through the router's
 * leases on every pass, and the resolution is here rather than in the planner
 * because the create gate has to reach exactly the same answer - a check that
 * resolved a MAC differently from the reconcile would approve a binding for one
 * LAN and then install it against another.
 */
import type { DirectBindingRecord } from '../store'
import type { Lease } from '../types'

/** Lower-cased colon form, which is the spelling `model.leases` carries. */
export const MAC_ADDRESS = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

export function normalizeMac(raw: string): string {
  const text = String(raw ?? '').trim().toLowerCase()
  return MAC_ADDRESS.test(text) ? text : ''
}

/**
 * One address per MAC, taking the lease that runs longest.
 *
 * A device that has moved from one LAN to another leaves both lines in
 * `/tmp/dhcp.leases` until the abandoned one runs out, so "the first line for
 * this MAC" is routinely the address the device stopped using - and a rule
 * written for it steers nothing while looking, on the page, exactly like a
 * binding that is working.
 */
export function leaseAddresses(leases: readonly Lease[]): Map<string, string> {
  const best = new Map<string, { ip: string; expires: number }>()
  for (const lease of leases) {
    const mac = normalizeMac(lease.mac)
    if (!mac || !lease.ip) continue
    const previous = best.get(mac)
    // A static lease carries expiry 0 and never runs out, so it wins outright
    // rather than losing to every dynamic lease by arithmetic.
    const expires = lease.expires === 0 ? Number.POSITIVE_INFINITY : lease.expires
    if (!previous || expires >= previous.expires) best.set(mac, { ip: lease.ip, expires })
  }
  return new Map([...best].map(([mac, entry]) => [mac, entry.ip]))
}

/** The target as it was typed, for a row and for every sentence about it. */
export function targetLabel(target: DirectBindingRecord['target']): string {
  return target.kind === 'ip' ? target.ip : target.mac
}

/**
 * The address a target answers to right now, or empty when a device is not on
 * the network. Deliberately knows nothing about the release grace: that is the
 * planner's decision and it needs the unsoftened answer to make it.
 */
export function resolveTarget(
  target: DirectBindingRecord['target'],
  leaseByMac: ReadonlyMap<string, string>
): string {
  return target.kind === 'ip' ? target.ip : (leaseByMac.get(target.mac) ?? '')
}
