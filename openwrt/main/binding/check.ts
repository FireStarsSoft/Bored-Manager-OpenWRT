/**
 * The gate in front of Create: everything that must be true before an instance
 * is allowed to exist, and the plan the apply path is handed if it is.
 *
 * Two interfaces belong to exactly one instance, every WAN in a pool needs its
 * own routing table, and the LAN needs a firewall zone and a DHCP section - so
 * the check both refuses what cannot work and works out what has to be prepared
 * first. It reads the router live rather than the cached sample wherever the
 * answer is about /etc/config, because that is where a stale answer would be a
 * confident, wrong finding.
 */
import {
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import { isBindingCarrier } from '../options'
import { managedLayout } from '../records'
import { isSafeUciValue } from '../uci'
import type { BindingInstanceRecord } from '../store'
import { carrierScopesOverlap, parseCidr, subnetsOverlap, textField } from '../util'
import { planCapacity } from './capacity'
import {
  carrierMatches,
  ifaceScopeKeys,
  isManagedPppoeSection,
  lanCidr,
  poolIfaces
} from './pool'
import { MANAGED_PREF_CEILING } from './rules'
import { currentWanTables } from './runtime'
import { buildWanTableIndex } from './tables'
import {
  FIREWALL_ZONE,
  UCI_SECTION,
  firewallZoneForNetwork,
  firewallZoneMasquerades,
  networkTables,
  preparationProbe
} from './uci-doc'
import type {
  BindingCreatePlan,
  BindingRuntime,
  RouterPreparationProbe,
  TablePreparation
} from './types'

const FAST_INTERVAL_KEY = 'openwrt'

/**
 * Every refusal that a fresh sample would clear says the same thing, and names
 * the control by the label it actually carries on screen. "Run Refresh once"
 * pointed at a button that does not exist under that name.
 */
const REFRESH_HINT = 'Run Refresh now, then check this form again.'

function makeBindingId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `bind_${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
  return `bind_${Date.now().toString(36)}`
}

export async function checkBinding(
  runtime: BindingRuntime,
  raw: unknown
): Promise<ModuleCheckReport> {
  const values =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {}
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
  const model = runtime.latestModel
  if (!model) {
    return {
      ok: false,
      findings: [{
        level: 'error',
        label: 'No router sample is available',
        detail: REFRESH_HINT
      }]
    }
  }

  const name = textField(values, 'name')
  const lan = textField(values, 'lan')
  const carrier = textField(values, 'carrier')
  const rules = runtime.options.rules()
  const sticky =
    typeof values.sticky === 'boolean' ? values.sticky : rules.stickyByMac
  const remap =
    typeof values.remap === 'boolean' ? values.remap : rules.remapOnWanError
  const raiseDhcpLimits = values.raiseDhcpLimits === true
  if (!name || name.length > 80 || !isSafeUciValue(name)) {
    findings.push({
      level: 'error',
      // The value is deliberately not echoed back: this name reaches job
      // labels, event rows and `ctx.log`, and a newline inside it forges a
      // whole log line. The same sieve guards batch names and credentials.
      label: 'Instance name must contain 1-80 characters on one line'
    })
  } else if (
    runtime.store
      .read()
      .instances.some((instance) => instance.name.toLowerCase() === name.toLowerCase())
  ) {
    findings.push({ level: 'error', label: `An instance named "${name}" already exists` })
  }
  if (!lan || !carrier) {
    findings.push({
      level: 'error',
      label: 'Choose exactly one LAN interface and one WAN carrier'
    })
  } else if (lan === carrier) {
    findings.push({
      level: 'error',
      label: 'The LAN logical interface and WAN carrier must be different'
    })
  } else if (!isBindingCarrier(carrier)) {
    // The dropdown cannot offer one of these, but the form is submitted as
    // plain values and a bridge or a tunnel would take the whole pool nowhere.
    findings.push({
      level: 'error',
      label: `Carrier "${carrier}" is not a device an instance can bind to`,
      detail: 'A carrier is a device or a VLAN on one - eth1, eth1.835, br-lan.10 - within the 15 characters Linux allows. A bare bridge, a tunnel or a pppoe- netdev cannot carry a WAN pool.'
    })
  }

  const lanIface = model.ifaces.find((iface) => iface.name === lan)
  const cidr = lanCidr(lanIface)
  if (!lanIface) {
    findings.push({
      level: 'error',
      // "the router model" is what this module calls its cached sample. To a
      // user it reads as a hardware model number.
      label: `LAN interface "${lan}" was not in the latest router sample`,
      detail: REFRESH_HINT
    })
  } else if (!cidr) {
    findings.push({
      level: 'error',
      label: `LAN interface "${lan}" has no usable IPv4 subnet`
    })
  } else {
    findings.push({ level: 'pass', label: `LAN ${lan} is scoped to ${cidr}` })
    const parsed = parseCidr(cidr)
    for (const other of runtime.store.read().instances) {
      const otherCidr = lanCidr(
        model.ifaces.find((iface) => iface.name === other.lan)
      )
      const otherParsed = otherCidr ? parseCidr(otherCidr) : null
      if (parsed && otherParsed && subnetsOverlap(parsed, otherParsed)) {
        findings.push({
          level: 'error',
          label: `${cidr} overlaps ${otherCidr} used by "${other.name}"`,
          detail: 'Source-only IPv4 rules cannot distinguish clients in overlapping LAN subnets.'
        })
      }
    }
  }

  const carrierExists = model.ifaces.some(
    (iface) =>
      iface.device === carrier ||
      iface.l3Device === carrier ||
      carrierMatches(iface.device, carrier)
  ) || Object.prototype.hasOwnProperty.call(model.rates, carrier)
  if (!carrierExists) {
    findings.push({
      level: 'error',
      label: `Carrier "${carrier}" is not used by a router interface`
    })
  }

  if (
    lanIface &&
    carrier &&
    ifaceScopeKeys(lanIface).some((key) => carrierScopesOverlap(key, carrier))
  ) {
    findings.push({
      level: 'error',
      label: 'The LAN physical device and WAN carrier overlap',
      detail: `${lan} uses ${[lanIface.device, lanIface.l3Device].filter(Boolean).join(' / ')}.`
    })
  }

  const clashes = runtime.store.read().instances.filter((instance) => {
    const otherLan = model.ifaces.find((iface) => iface.name === instance.lan)
    return (
      instance.lan === lan ||
      instance.carrier === lan ||
      instance.lan === carrier ||
      carrierScopesOverlap(instance.carrier, carrier) ||
      ifaceScopeKeys(otherLan).some((key) => carrierScopesOverlap(key, carrier)) ||
      ifaceScopeKeys(lanIface).some((key) => carrierScopesOverlap(key, instance.carrier))
    )
  })
  if (clashes.length) {
    findings.push({
      level: 'error',
      label: 'An interface is already owned by another binding instance',
      detail: clashes.map((instance) => `${instance.name}: ${instance.lan} + ${instance.carrier}`).join(', ')
    })
  } else if (lan && carrier) {
    findings.push({
      level: 'pass',
      label: `Exactly two exclusive interfaces: ${lan} + ${carrier}`
    })
  }

  const pool = poolIfaces(model, lan, carrier)
  if (pool.length === 0) {
    findings.push({
      level: 'warning',
      label: `No PPPoE, DHCP or static WAN currently uses ${carrier}`,
      detail: 'The instance can still start; WANs that dial later will enter this carrier-scoped pool.'
    })
  } else {
    findings.push({
      level: 'pass',
      label: `${pool.length} WAN interface(s) are scoped to carrier ${carrier}`
    })
  }

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

  const data = runtime.store.read()
  const externalTables = currentWanTables(runtime)
  const tableIndex = buildWanTableIndex(model, data, rules, externalTables)
  for (const conflict of tableIndex.conflicts) {
    if (!pool.some((iface) => iface.name === conflict.first || iface.name === conflict.second)) {
      continue
    }
    findings.push({
      level: 'error',
      label: `Routing table ${conflict.table} is shared by ${conflict.first} and ${conflict.second}`,
      detail: 'Every WAN in a one-to-one pool needs a unique ip4table.'
    })
  }

  const uciTables = probe ? networkTables(probe.network) : new Map<string, number>()
  const networkTableOwners = new Map<number, string>()
  for (const [wan, table] of uciTables) {
    const owner = networkTableOwners.get(table)
    if (
      owner &&
      owner !== wan &&
      pool.some((iface) => iface.name === owner || iface.name === wan)
    ) {
      findings.push({
        level: 'error',
        label: `Router UCI assigns table ${table} to both ${owner} and ${wan}`,
        detail: 'Correct the duplicate ip4table values before starting one-to-one binding.'
      })
    } else if (!owner) {
      networkTableOwners.set(table, wan)
    }
  }
  const usedTables = new Set<number>([
    ...tableIndex.byTable.keys(),
    ...uciTables.values(),
    rules.catchAllTable
  ])
  const tableAdds: TablePreparation[] = []
  let candidateTable = rules.catchAllTable - 1
  for (const iface of pool) {
    const observed = uciTables.get(iface.name)
    if (observed != null) continue
    if (!UCI_SECTION.test(iface.name)) {
      findings.push({
        level: 'error',
        label: `WAN section "${iface.name}" cannot be prepared safely`,
        detail: 'Its UCI section name contains unsupported characters.'
      })
      continue
    }
    const conventional = tableIndex.byWan.get(iface.name)
    if (
      conventional != null &&
      conventional !== rules.catchAllTable &&
      tableIndex.byTable.get(conventional) === iface.name
    ) {
      tableAdds.push({ wan: iface.name, table: conventional })
      continue
    }
    while (
      candidateTable > rules.tableBase &&
      usedTables.has(candidateTable)
    ) {
      candidateTable -= 1
    }
    if (candidateTable <= rules.tableBase) {
      findings.push({
        level: 'error',
        label: 'No free numeric routing table remains between the PPPoE and catch-all ranges',
        // `usedTables` is router-wide, so splitting the pool into smaller
        // instances frees nothing: widening the range is the only remedy.
        detail: `Tables ${rules.tableBase + 1}-${rules.catchAllTable - 1} are all spoken for and every WAN needs its own. Widen the range with "Routing-table base" or "Unreachable routing table" under Module settings, Rules - both are locked while any batch or binding instance exists.`
      })
      break
    }
    tableAdds.push({ wan: iface.name, table: candidateTable })
    usedTables.add(candidateTable)
    candidateTable -= 1
  }
  if (tableAdds.length) {
    findings.push({
      level: 'info',
      label: `${tableAdds.length} pre-existing WAN(s) need option ip4table`,
      detail: tableAdds
        .slice(0, 12)
        .map((entry) => `${entry.wan} -> ${entry.table}`)
        .join(', ')
        .concat(tableAdds.length > 12 ? `, and ${tableAdds.length - 12} more` : '')
    })
  }

  let lanZone = ''
  const destinationZones = new Set<string>()
  if (probe) {
    lanZone = firewallZoneForNetwork(probe.firewall, lan)
    if (!lanZone) {
      findings.push({
        level: 'error',
        label: `LAN "${lan}" is not assigned to a firewall zone`,
        detail: 'WAN Binding needs the source zone so it can install scoped forwarding without changing unrelated LANs.'
      })
    } else if (!FIREWALL_ZONE.test(lanZone)) {
      findings.push({
        level: 'error',
        label: `LAN firewall zone "${lanZone}" has an unsupported name`
      })
    } else {
      findings.push({
        level: 'pass',
        label: `LAN ${lan} uses firewall zone ${lanZone}`
      })
    }
    for (const iface of pool) {
      const zone = firewallZoneForNetwork(probe.firewall, iface.name)
      if (zone) {
        if (FIREWALL_ZONE.test(zone)) {
          destinationZones.add(zone)
        } else {
          findings.push({
            level: 'error',
            label: `WAN "${iface.name}" uses firewall zone "${zone}" with an unsupported name`
          })
        }
      } else if (
        iface.proto === 'pppoe' &&
        isManagedPppoeSection(iface.name, runtime.store.read().batches)
      ) {
        // Managed PPPoE netdevs are commonly attached to the module zone by
        // its `pppoe-<prefix>+` device wildcard rather than `list network`.
        destinationZones.add(rules.zoneName)
      } else {
        findings.push({
          level: 'error',
          label: `WAN "${iface.name}" is not assigned to a firewall zone`,
          detail: 'Assign the DHCP/static WAN to a masquerading firewall zone before putting it in a one-to-one pool.'
        })
      }
    }
    destinationZones.add(rules.zoneName)
    for (const zone of destinationZones) {
      if (!firewallZoneMasquerades(probe.firewall, zone) && zone !== rules.zoneName) {
        findings.push({
          level: 'warning',
          label: `Firewall zone "${zone}" does not have masquerading enabled`,
          detail: 'One-to-one WAN binding needs SNAT on the selected WAN zone or clients will not reach the internet.'
        })
      }
    }
    // A pool may be empty during preparation and receive managed PPPoE WANs
    // later. Keep its scoped forwarding ready without touching other zones.
    if (destinationZones.size > 32) {
      findings.push({
        level: 'error',
        label: 'The selected pool spans more than 32 firewall zones',
        detail: 'Split it into smaller carrier-scoped binding instances.'
      })
    }
  }

  const dhcp =
    probe && cidr
      ? planCapacity(
          probe,
          { lan, cidr, pool, leases: model.leases, raiseDhcpLimits },
          findings
        )
      : undefined

  if (runtime.ctx.fastIntervalMs(FAST_INTERVAL_KEY) === 0) {
    findings.push({
      level: 'warning',
      label: 'The OpenWRT fast interval is paused',
      detail: 'The binding engine only reconciles on fast samples; new DHCP clients will wait until refresh resumes.'
    })
  }
  findings.push({
    level: 'info',
    label: 'Unassigned clients are blocked by a scoped catch-all',
    detail: `The instance will install an unreachable default in table ${rules.catchAllTable}; LANs and carriers outside this exact pair are untouched.`
  })

  const usedSlots = new Set(data.instances.map((instance) => instance.slot))
  for (const rule of model.rules) {
    if (
      rule.pref >= rules.catchAllPrefBase &&
      rule.pref < MANAGED_PREF_CEILING
    ) {
      usedSlots.add(rule.pref - rules.catchAllPrefBase)
    }
  }
  let slot = 0
  while (usedSlots.has(slot)) slot += 1
  if (rules.catchAllPrefBase + slot >= MANAGED_PREF_CEILING) {
    findings.push({
      level: 'error',
      label: 'No catch-all preference slot remains in the managed range',
      detail: `Each instance claims one ip rule priority from ${rules.catchAllPrefBase} up to ${MANAGED_PREF_CEILING - 1}, and all ${MANAGED_PREF_CEILING - rules.catchAllPrefBase} are taken. Delete a binding instance you no longer need, or lower "Safety-rule priority base" under Module settings, Rules - it has to stay above every client rule.`
    })
  }

  const ok = !hasBlockingFinding(findings)
  if (!ok || !cidr) return { ok: false, findings }
  const instance: BindingInstanceRecord = {
    id: makeBindingId(new Set(data.instances.map((entry) => entry.id))),
    name,
    lan,
    carrier,
    running: true,
    sticky,
    remap,
    createdAt: Date.now(),
    slot,
    // The numbering and the zone this instance is about to be installed under,
    // recorded on the instance. Everything that later removes it - the
    // catch-all, the forwardings, the tables - has to aim at the same numbers,
    // and reading them live meant one config edit re-pointed a running
    // instance at a table nothing had ever been written to.
    layout: managedLayout(rules)
  }
  const plan: BindingCreatePlan = {
    instance,
    lanCidr: cidr,
    lanZone,
    destinationZones: [...destinationZones].sort(),
    tableAdds,
    ...(raiseDhcpLimits && dhcp ? { dhcp } : {})
  }
  findings.push({
    level: 'pass',
    label: `Will prepare and start "${name}"`,
    detail: `${lan} -> ${carrier}; sticky ${sticky ? 'on' : 'off'}, error remap ${remap ? 'on' : 'off'}.`
  })
  return {
    ok: true,
    token: runtime.checkSession.issue(values, plan),
    findings
  }
}
