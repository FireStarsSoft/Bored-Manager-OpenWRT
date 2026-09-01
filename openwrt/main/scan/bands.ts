/**
 * Everything derived once per scan, before a single rule is looked at.
 *
 * Split out of `classify.ts` when that file reached the size limit, and along
 * the seam it already had: this half turns records into the bands and claims
 * the per-rule pass compares against, and knows nothing about rules. The pass
 * next door reads it and never rebuilds it, which is what keeps classifying
 * five hundred rules against a router with five thousand interfaces from
 * walking the records once per rule.
 */
import { lanCidr } from '../binding'
import type { OwrtRules } from '../config'
import { leaseAddresses, resolveTarget } from '../direct'
import { MANAGED_PREF_CEILING, recordLayout } from '../records'
import type { BindingInstanceRecord } from '../store'
import { ifaceIndex, parseCidr, type ParsedSubnet } from '../util'
import type { ScanAssignment, ScanClassifyInput } from './types'

export interface PrefBand {
  from: number
  to: number
}

/** One stored one-to-one binding, with every address a rule for it may name. */
export interface DirectClaim {
  name: string
  wan: string
  /**
   * The record's target resolved against the leases, so a MAC-targeted binding
   * can be compared with a rule at all. Empty when the device is not on the
   * network, which is emphatically not the same statement as "no rule for it
   * stands on this router" - see `installed`.
   */
  ip: string
  /**
   * The address the one-to-one pass last actually wrote a rule for.
   *
   * The two answers are allowed to disagree, and during the disagreement it is
   * this one that describes the router. `resolveTarget` returns '' the instant a
   * MAC's lease disappears, while the pass keeps that binding's rule installed at
   * the last address it saw for the whole of Lease release grace (s) - five
   * minutes by default. Judged on the live address alone, the monitor published a
   * rule this module wrote, at a preference in this module's own band, as
   * "written outside this module" for that entire window - and the page's own
   * advice about a foreign rule sitting in the module's band is to go and remove
   * it, so a person following it deleted a rule the module owned and would have
   * withdrawn by itself. `reservedIps` unions the same two answers for the same
   * reason: an address belongs to a binding for exactly as long as a rule for it
   * stands.
   */
  installed: string
}

/** One instance's catch-all preference, with what the rule there should say. */
export interface CatchAllClaim {
  record: BindingInstanceRecord
  /**
   * The table that instance's catch-all was stamped to point at. Held beside
   * the record because the record may have been written under an older layout,
   * and re-deriving it from the rules in force is how this module comes to call
   * its own work foreign the moment somebody moves a base.
   */
  table: number
  /**
   * The subnet of that instance's LAN as the router states it now, or null when
   * the router does not state it - a LAN with no IPv4 address, a LAN that is
   * not in this sample, or no sample at all. Null means the fact is unavailable
   * rather than false, and an unavailable fact contradicts nothing.
   */
  lan: ParsedSubnet | null
}

/** Everything derived once from the records, so the per-rule pass stays cheap. */
export interface Bands {
  /** The assignment bands: the live one plus every stamped instance layout. */
  instance: PrefBand[]
  /** Catch-all preference -> the instance that owns it. */
  catchAll: Map<number, CatchAllClaim>
  /** The lowest preference this module writes anywhere on this router. */
  lowestManaged: number
  instanceById: Map<string, BindingInstanceRecord>
  assignmentByIp: Map<string, ScanAssignment>
  directByPref: Map<number, DirectClaim>
  /** Whether this module writes any rule at all on this router. */
  writesRules: boolean
  /** Every address this module has a rule for, one-to-one bindings included. */
  managedIps: string[]
}

export function buildBands(input: ScanClassifyInput): Bands {
  const rules: OwrtRules = input.rules
  const instance: PrefBand[] = [
    { from: rules.rulePrefBase, to: rules.catchAllPrefBase }
  ]
  const catchAll = new Map<number, CatchAllClaim>()
  const instanceById = new Map<string, BindingInstanceRecord>()
  let lowestManaged = Math.min(rules.directPrefBase, rules.rulePrefBase)
  // The same index the fast surfaces share, so classifying five hundred rules
  // against a router with five thousand interfaces does not walk the array once
  // per instance to find one LAN.
  const ifaces = ifaceIndex(input.model)

  for (const record of input.instances) {
    instanceById.set(record.id, record)
    // The layout the instance was created under, not the one in force now.
    // A record written before the Rules editor was touched still has its rules
    // sitting at the old numbers, and re-deriving the band from the current
    // settings is how the module would come to call its own assignments
    // foreign the moment somebody moved a base.
    const layout = recordLayout(record, rules)
    instance.push({ from: layout.rulePrefBase, to: layout.catchAllPrefBase })
    const pref = layout.catchAllPrefBase + record.slot
    if (pref >= layout.catchAllPrefBase && pref < MANAGED_PREF_CEILING) {
      catchAll.set(pref, {
        record,
        table: layout.catchAllTable,
        lan: parseCidr(lanCidr(ifaces.get(record.lan)) ?? '')
      })
    }
    lowestManaged = Math.min(lowestManaged, layout.rulePrefBase)
  }

  // Keyed by the preference stamped on the record, and deliberately not
  // checked against the live one-to-one band afterwards. `directPrefBase` can
  // be edited while bindings exist, and the rules on the router keep the
  // numbers they were written with; a band derived from the current setting is
  // how this module came to say "this module did not write this rule" about a
  // rule it wrote, on every one-to-one binding at once, the moment somebody
  // saved a new base. The instance verdict above refuses the same trap by
  // using each record's stamped layout, and this is the same refusal.
  //
  // The address each record answers to is resolved here, through the same
  // leases the one-to-one half resolves against, because the preference alone
  // is not evidence of anything: see `decide`.
  const leaseByMac = leaseAddresses(input.model?.leases ?? [])
  const installedById = new Map<string, string>()
  for (const entry of input.installed ?? []) {
    if (entry.ip) installedById.set(entry.id, entry.ip)
  }
  const directByPref = new Map<number, DirectClaim>()
  for (const record of input.direct) {
    directByPref.set(record.pref, {
      name: record.name,
      wan: record.wan,
      ip: resolveTarget(record.target, leaseByMac),
      installed: installedById.get(record.id) ?? ''
    })
    lowestManaged = Math.min(lowestManaged, record.pref)
  }
  // The bindings a router keeps for itself, which this module holds no record
  // of - the handover deletes them once the daemon confirms, on purpose. Read
  // from the rows instead, because those are answered by whichever half is
  // holding. Without this the Monitor put every rule bm-wanbind wrote under
  // "written outside this module" and told the operator to remove it, in the
  // module's own voice, about rules the module's own daemon had just written.
  for (const claim of input.routerHeld ?? []) {
    if (claim.pref <= 0 || directByPref.has(claim.pref)) continue
    directByPref.set(claim.pref, {
      name: claim.name,
      wan: claim.wan,
      ip: claim.ip,
      installed: claim.ip
    })
    lowestManaged = Math.min(lowestManaged, claim.pref)
  }

  const assignmentByIp = new Map<string, ScanAssignment>()
  for (const entry of input.assignments) {
    if (entry.ip) assignmentByIp.set(entry.ip, entry)
  }

  return {
    instance,
    catchAll,
    lowestManaged,
    instanceById,
    assignmentByIp,
    directByPref,
    writesRules:
      input.direct.length > 0 ||
      input.instances.length > 0 ||
      (input.routerHeld ?? []).length > 0,
    // Both answers again, and for the reason the union exists at all: the
    // "outranks module" accusation asks whether a low rule could take traffic
    // from one this module wrote, and a rule standing through the release grace
    // is a rule this module wrote. Counting only the live address made the
    // warning go quiet for exactly the five minutes in which the address it
    // covers is hardest to account for.
    managedIps: [
      ...assignmentByIp.keys(),
      ...[...directByPref.values()].flatMap((claim) => [claim.ip, claim.installed]).filter(Boolean)
    ]
  }
}

export function inBand(pref: number, band: PrefBand): boolean {
  return pref >= band.from && pref < band.to
}

/**
 * Whether a rule's source is a block the catch-all for that LAN could have been
 * written from.
 *
 * Containment rather than overlap, and the prefix as well as the address.
 * Every block this module writes there is either the LAN itself or one of the
 * covering blocks of a range that `binding/check.ts` already refused to create
 * unless it sat inside the LAN - so a selector wider than the LAN is one this
 * module could not have produced, however much of the LAN it happens to cover.
 */
