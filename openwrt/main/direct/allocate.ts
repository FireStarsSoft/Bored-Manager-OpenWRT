/**
 * The four numbers and the one interface a new binding is stamped with.
 *
 * They are worked out here rather than inline in the check because each of them
 * has to account for the same three populations at once: the records on disk,
 * the rules the router is already carrying, and the creates that are in flight
 * in another job right now. Miss the third and two Saves a second apart both
 * pass the gate holding the same preference, then the second one's `ip rule
 * add` quietly replaces the first one's binding.
 */
import { lanCidr } from '../binding'
import { DIRECT_PREF_SPAN } from '../records'
import type { DirectBindingRecord } from '../store'
import type { IfaceState, RouterModel } from '../types'
import { parseCidr, subnetContains } from '../util'

export function makeDirectId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `dir_${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
  return `dir_${Date.now().toString(36).slice(-6)}`
}

/**
 * The lowest free preference in the band, or 0 when the band is full.
 *
 * Rules already on the router count as taken even when no record claims them:
 * the band is this module's to write in, but a leftover from a build that
 * crashed between the `ip rule add` and the store write is still a rule, and
 * handing its number to a new binding would make the two indistinguishable.
 */
export function freeDirectPref(
  directPrefBase: number,
  records: readonly DirectBindingRecord[],
  pending: readonly DirectBindingRecord[],
  model: RouterModel
): number {
  const taken = new Set<number>()
  for (const record of [...records, ...pending]) taken.add(record.pref)
  for (const rule of model.rules) {
    if (rule.pref >= directPrefBase && rule.pref < directPrefBase + DIRECT_PREF_SPAN) {
      taken.add(rule.pref)
    }
  }
  for (let pref = directPrefBase; pref < directPrefBase + DIRECT_PREF_SPAN; pref++) {
    if (!taken.has(pref)) return pref
  }
  return 0
}

/** The lowest slot no live or in-flight binding is numbering its sections with. */
export function freeDirectSlot(
  records: readonly DirectBindingRecord[],
  pending: readonly DirectBindingRecord[]
): number {
  const taken = new Set([...records, ...pending].map((record) => record.slot))
  let slot = 0
  while (taken.has(slot)) slot += 1
  return slot
}

/**
 * Which of a set of candidates the address actually sits in, longest prefix
 * first.
 *
 * Longest prefix rather than first match because a router that carries both a
 * /24 and a /25 inside it has two true answers, and the specific one is the
 * interface the device is really on - which is the one whose firewall zone has
 * to be the forwarding source.
 */
export function lanForAddress(
  candidates: readonly IfaceState[],
  address: string
): IfaceState | undefined {
  let best: IfaceState | undefined
  let bestPrefix = -1
  for (const iface of candidates) {
    const cidr = lanCidr(iface)
    const parsed = cidr ? parseCidr(cidr) : null
    if (!parsed || !subnetContains(parsed, address)) continue
    if (parsed.prefix > bestPrefix) {
      best = iface
      bestPrefix = parsed.prefix
    }
  }
  return best
}
