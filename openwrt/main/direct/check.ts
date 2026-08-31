/**
 * The gate in front of Create: everything that must be true before one address
 * may be nailed to one WAN port, and the plan the apply job is handed if it is.
 *
 * A one-to-one binding is a single `ip rule`, which makes it sound like there
 * is nothing to check. There is: the rule needs a preference nothing else in
 * the band holds, a routing table that belongs to exactly one WAN, a firewall
 * source zone - which is the LAN the address turns out to be on, not something
 * the form asks for - and a band that sits below every priority range the
 * instance half or the router-side daemon writes in. Each of those has its own
 * sentence, because "cannot create binding" is not a thing anybody can act on.
 */
import {
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import { hasFeature } from '../agent'
import {
  allocateWanTables,
  buildWanTableIndex,
  lanCidr,
  networkTables,
  preparationProbe,
  zoneFindings,
  type RouterPreparationProbe,
  type TablePreparation
} from '../binding'
import { DIRECT_PREF_SPAN, recordLayout } from '../records'
import type { DirectBindingRecord } from '../store'
import type { IfaceState } from '../types'
import { isSafeUciValue } from '../uci'
import { ipv4ToInt, textField } from '../util'
import { freeDirectPref, freeDirectSlot, lanCandidates, lanForAddress, makeDirectId } from './allocate'
import { wanbindPrefBases } from './probe'
import { leaseAddresses, normalizeMac, resolveTarget } from './target'
import type { DirectPlan, DirectRuntime } from './types'

/** The protocols a WAN port can be running; anything else cannot carry a bind. */
const WAN_PROTOS = ['pppoe', 'dhcp', 'static']

/** Named by the label the control actually carries on screen. */
const REFRESH_HINT = 'Run Refresh now, then check this form again.'

export async function checkDirect(
  runtime: DirectRuntime,
  raw: unknown
): Promise<ModuleCheckReport> {
  const values = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const findings: ModuleCheckFinding[] = []
  if (!runtime.ctx.connected) {
    return {
      ok: false,
      findings: [{
        level: 'error',
        label: 'The router is not connected',
        detail: 'Connect the machine entry and try again.'
      }]
    }
  }
  const model = runtime.options.latestModel()
  if (!model) {
    return {
      ok: false,
      findings: [{ level: 'error', label: 'No router sample is available', detail: REFRESH_HINT }]
    }
  }

  const rules = runtime.options.rules()
  const data = runtime.store.read()
  const pending = [...runtime.preparations.values()].map((plan) => plan.record)
  const name = textField(values, 'name')
  const targetKind = textField(values, 'targetKind').toLowerCase()
  const address = textField(values, 'address')
  const wan = textField(values, 'wan')
  const whenDown = textField(values, 'whenDown') === 'fallback' ? 'fallback' : 'hold'

  if (!name || name.length > 80 || !isSafeUciValue(name)) {
    // Never echoed back: this name reaches job labels, event rows and
    // `ctx.log`, and a newline inside it forges a whole log line.
    findings.push({ level: 'error', label: 'Binding name must contain 1-80 characters on one line' })
  } else if (
    [...data.direct, ...pending].some((entry) => entry.name.toLowerCase() === name.toLowerCase())
  ) {
    findings.push({ level: 'error', label: `A one-to-one binding named "${name}" already exists` })
  }

  // ------------------------------------------------------------------ target
  let target: DirectBindingRecord['target'] | null = null
  if (targetKind !== 'ip' && targetKind !== 'mac') {
    findings.push({
      level: 'error',
      label: 'Choose whether this binding names an IP address or a MAC address'
    })
  } else if (targetKind === 'ip') {
    if (ipv4ToInt(address) == null) {
      findings.push({
        level: 'error',
        label: 'That is not an IPv4 address',
        detail: 'Four numbers from 0 to 255, separated by dots - 192.168.1.50.'
      })
    } else {
      target = { kind: 'ip', ip: address }
    }
  } else {
    const mac = normalizeMac(address)
    if (!mac) {
      findings.push({
        level: 'error',
        label: 'That is not a MAC address',
        detail: 'Twelve hexadecimal digits in colon form - a4:b1:c2:00:11:22.'
      })
    } else {
      target = { kind: 'mac', mac }
    }
  }

  const leaseByMac = leaseAddresses(model.leases)
  const resolved = target ? resolveTarget(target, leaseByMac) : ''
  if (target?.kind === 'mac' && !resolved) {
    findings.push({
      level: 'warning',
      label: `${target.mac} has no current DHCP lease`,
      detail: 'The device is not on the network right now. The binding is created either way and its rule appears the moment the device takes a lease.'
    })
  }

  // -------------------------------------------------------------------- WAN
  const wanIface = model.ifaces.find((iface) => iface.name === wan)
  if (!wan) {
    findings.push({ level: 'error', label: 'Choose the WAN port this address must leave through' })
  } else if (!wanIface) {
    findings.push({
      level: 'error',
      label: `WAN "${wan}" was not in the latest router sample`,
      detail: REFRESH_HINT
    })
  } else if (!WAN_PROTOS.includes(wanIface.proto)) {
    findings.push({
      level: 'error',
      label: `Interface "${wan}" uses protocol ${wanIface.proto} and cannot carry a bound address`,
      detail: 'A WAN port is a pppoe, dhcp or static interface.'
    })
  } else {
    findings.push({ level: 'pass', label: `${wan} is a ${wanIface.proto} WAN port` })
  }

  // -------------------------------------------------------------------- LAN
  const candidates = lanCandidates(model, wan)
  const lanIface = resolved ? lanForAddress(candidates, resolved) : soleCandidate(candidates)
  const cidr = lanCidr(lanIface)
  // Said only when there is a target to say it about: a form submitted with no
  // address at all already carries that refusal, and a second sentence about
  // LAN subnets underneath it only obscures the one the user has to act on.
  if (!target) {
    // Nothing to add.
  } else if (!lanIface || !cidr) {
    findings.push(lanRefusal(resolved, candidates.length))
  } else {
    findings.push({
      level: resolved ? 'pass' : 'info',
      label: resolved
        ? `${resolved} is on LAN ${lanIface.name} (${cidr})`
        : `The binding will be installed on LAN ${lanIface.name} (${cidr})`,
      detail: 'That LAN supplies the firewall source zone the forwarding is written from.'
    })
    if (resolved && lanIface.ipv4?.addr === resolved) {
      findings.push({
        level: 'error',
        label: `${resolved} is the router's own address on ${lanIface.name}`,
        detail: 'Binding the router itself would send its own replies out one WAN and take it off the LAN it answers on.'
      })
    }
  }

  // ----------------------------------------------------------------- claims
  for (const other of [...data.direct, ...pending]) {
    const clash =
      (target?.kind === 'mac' && other.target.kind === 'mac' && other.target.mac === target.mac) ||
      (target?.kind === 'ip' && other.target.kind === 'ip' && other.target.ip === target.ip) ||
      (resolved !== '' && resolveTarget(other.target, leaseByMac) === resolved)
    if (!clash) continue
    findings.push({
      level: 'error',
      label: `That address is already bound by "${other.name}"`,
      detail: 'One address can only be steered one way; edit or delete that binding instead.'
    })
    break
  }

  // ------------------------------------------- tables, zones and the probe
  let probe: RouterPreparationProbe | null = null
  try {
    probe = await preparationProbe(runtime)
  } catch (error) {
    findings.push({
      level: 'error',
      label: 'Router preparation state could not be read',
      detail: error instanceof Error ? error.message : String(error)
    })
  }
  const tableIndex = buildWanTableIndex(model, data, rules, runtime.options.wanTables?.())
  for (const conflict of tableIndex.conflicts) {
    if (conflict.first !== wan && conflict.second !== wan) continue
    findings.push({
      level: 'error',
      label: `Routing table ${conflict.table} is shared by ${conflict.first} and ${conflict.second}`,
      detail: 'A bound address looks up one table, so that table has to belong to one WAN.'
    })
  }
  const uciTables = probe ? networkTables(probe.network) : new Map<string, number>()
  const tableAdds: TablePreparation[] = wanIface
    ? allocateWanTables({ wans: [wan], uciTables, tableIndex, rules }, findings)
    : []
  const table = uciTables.get(wan) ?? tableAdds[0]?.table ?? 0

  let lanZone = ''
  let destinationZones: string[] = []
  if (probe && lanIface && wanIface) {
    const zones = zoneFindings(
      probe,
      { lan: lanIface.name, wans: [wan], moduleZone: rules.zoneName },
      findings
    )
    lanZone = zones.lanZone
    destinationZones = zones.destinationZones
  }

  // ---------------------------------------------------------- the band itself
  const pref = freeDirectPref(rules.directPrefBase, data.direct, pending, model)
  if (pref === 0) {
    findings.push({
      level: 'error',
      label: 'No free priority remains in the one-to-one band',
      detail: `Every priority from ${rules.directPrefBase} to ${rules.directPrefBase + DIRECT_PREF_SPAN - 1} is claimed by a binding or by a rule already on the router. Delete a binding you no longer need, or move "One-to-one rule priority base" under Module settings, Rules.`
    })
  }
  bandFindings(runtime, findings)
  try {
    for (const base of await wanbindPrefBases(runtime)) {
      if (rules.directPrefBase + DIRECT_PREF_SPAN <= base) continue
      findings.push({
        level: 'error',
        label: `The one-to-one band runs into the router daemon's own priority range`,
        detail: `bm-wanbind is configured with rule_pref_base ${base} and this module writes one-to-one rules from ${rules.directPrefBase} to ${rules.directPrefBase + DIRECT_PREF_SPAN - 1}. Lower "One-to-one rule priority base" under Module settings, Rules, or raise rule_pref_base on the router.`
      })
      break
    }
  } catch (error) {
    findings.push({
      level: 'warning',
      label: 'The router daemon priority range could not be read',
      detail: error instanceof Error ? error.message : String(error)
    })
  }

  if (lanIface) instanceOverlapFinding(runtime, lanIface.name, findings)

  const ok = !hasBlockingFinding(findings)
  if (!ok || !target || !lanIface || !cidr || table <= 0 || pref === 0) {
    return { ok: false, findings }
  }
  const record: DirectBindingRecord = {
    id: makeDirectId(new Set([...data.direct, ...pending].map((entry) => entry.id))),
    name,
    target,
    wan,
    enabled: true,
    whenDown,
    // Stamped, not re-derived: these two are what the reconcile looks for on
    // the router, so a settings edit afterwards must not send it hunting in the
    // wrong band and leave the real rule behind, unowned and still steering.
    pref,
    table,
    lan: lanIface.name,
    slot: freeDirectSlot(data.direct, pending),
    createdAt: Date.now()
  }
  findings.push({
    level: 'pass',
    label: `Will bind ${resolved || (target.kind === 'mac' ? target.mac : target.ip)} to ${wan}`,
    detail: `Priority ${pref}, routing table ${table}; when ${wan} is unusable this address ${whenDown === 'hold' ? `is parked on table ${rules.catchAllTable} and has no way out` : "is re-pointed at the main routing table, which is the router's default connection"}.`
  })
  const plan: DirectPlan = {
    record,
    lanCidr: cidr,
    lanZone,
    destinationZones: [...destinationZones].sort(),
    ...(tableAdds[0] ? { tableAdd: tableAdds[0] } : {})
  }
  return { ok: true, token: runtime.checkSession.issue(values, plan), findings }
}

/**
 * The LAN a device that is not on the network right now must be on: only when
 * the router has exactly one, because anything else would be a guess written
 * into a firewall forwarding.
 */
function soleCandidate(candidates: readonly IfaceState[]): IfaceState | undefined {
  return candidates.length === 1 ? candidates[0] : undefined
}

function lanRefusal(resolved: string, candidateCount: number): ModuleCheckFinding {
  if (resolved) {
    return {
      level: 'error',
      label: `${resolved} is not inside any LAN subnet on this router`,
      detail: "A bound address needs a LAN interface behind it, because that interface's firewall zone is what the forwarding is written from."
    }
  }
  if (candidateCount === 0) {
    return {
      level: 'error',
      label: 'This router has no LAN interface with an IPv4 subnet',
      detail: 'A one-to-one binding forwards from the LAN the address sits on, and there is none to forward from. Give the LAN an address, run Refresh, then check again.'
    }
  }
  return {
    level: 'error',
    label: 'The device has to be seen on the network once before it can be bound',
    detail: `Its MAC has no DHCP lease, and this router has ${candidateCount} LAN interfaces, so there is no way to tell which firewall zone the forwarding belongs in. Connect the device once, then check again.`
  }
}

/**
 * The band has to end below every priority range the instance half writes in -
 * and that is the range each instance was *stamped* with, not the one settings
 * name today. The two drift on purpose: a stamped layout is what keeps a
 * running instance's rules findable after a settings edit.
 */
function bandFindings(runtime: DirectRuntime, findings: ModuleCheckFinding[]): void {
  const rules = runtime.options.rules()
  const top = rules.directPrefBase + DIRECT_PREF_SPAN
  for (const instance of runtime.store.read().instances) {
    const base = recordLayout(instance, rules).rulePrefBase
    if (top <= base) continue
    findings.push({
      level: 'error',
      label: `The one-to-one band runs into binding instance "${instance.name}"`,
      detail: `That instance writes client rules from priority ${base} upwards and this module writes one-to-one rules up to ${top - 1}. Overlapping, the instance planner would adopt a hand-placed binding as one of its own assignments and delete it on the next tick. Lower "One-to-one rule priority base" under Module settings, Rules.`
    })
    break
  }
}

/**
 * A binding instance that already owns this LAN is not a conflict on a router
 * this module drives itself: the one-to-one rule sits at a lower preference and
 * wins, and the instance planner is told to leave the address alone. On a
 * router where `bm-wanbind` owns binding it is worth a warning, because the
 * daemon has no reserved-address list - it will hand the device a pool WAN as
 * well, which it never uses and which every surface will show it bound to.
 */
function instanceOverlapFinding(
  runtime: DirectRuntime,
  lan: string,
  findings: ModuleCheckFinding[]
): void {
  const owner = runtime.store.read().instances.find((instance) => instance.lan === lan)
  if (!owner) return
  const capability = runtime.options.agent?.()
  if (capability && hasFeature(capability, 'binding')) {
    findings.push({
      level: 'warning',
      label: `Binding instance "${owner.name}" also serves ${lan}, and this router binds through bm-wanbind`,
      detail: 'The one-to-one rule wins on priority, so the address does leave through the WAN you chose. But the router-side daemon has no list of addresses to skip, so it will also allocate this device a WAN from the pool - one it never uses, and one the instance page will show it bound to.'
    })
    return
  }
  findings.push({
    level: 'info',
    label: `Binding instance "${owner.name}" also serves ${lan}`,
    detail: 'The one-to-one rule sits at a lower priority and wins, and the instance stops handing this address a WAN of its own.'
  })
}
