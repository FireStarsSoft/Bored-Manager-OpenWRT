/**
 * The four pieces of one-to-one binding that are not about instances at all:
 * scoped firewall forwardings, the firewall-zone verdicts, and the numeric
 * routing-table allocator.
 *
 * They were inline in `prepare.ts` and `checkBinding` until a second automation
 * needed exactly the same answers for a single address rather than a whole LAN.
 * Two copies of "which table is still free" or of the sentence explaining an
 * unsupported zone name would drift within a release, and the two would then
 * refuse different routers for the same reason - so each one lives here once,
 * taking the prefix, the zone and the WAN list it works on rather than reading
 * them off an instance record it should never have known about.
 */
import type { ModuleCheckFinding } from '@shared/check'
import { shQuote } from '@shared/shell'
import type { OwrtRules } from '../config'
import type { HostStore } from '../store'
import { ENGINE_STOPPED, shellFailure, uciWrite } from './runtime'
import {
  FIREWALL_ZONE,
  UCI_SECTION,
  firewallZoneForNetwork,
  firewallZoneMasquerades
} from './uci-doc'
import type {
  ExecDeps,
  RouterPreparationProbe,
  TablePreparation,
  WanTableIndex
} from './types'

/**
 * The forwardings that let one source zone reach a set of WAN zones, written
 * under a caller-chosen section prefix.
 *
 * The prefix is what scopes the write: everything numbered under it is deleted
 * and rebuilt, and nothing else in /etc/config/firewall is read or touched. Two
 * automations can therefore own disjoint bands of sections in the same file
 * without either one having to know the other exists.
 */
export async function installScopedForwardings(
  deps: ExecDeps,
  store: HostStore,
  options: {
    sectionPrefix: string
    sourceZone: string
    destinationZones: readonly string[]
    zoneName: string
  }
): Promise<void> {
  const rules = deps.options.rules()
  const { sourceZone, zoneName } = options
  if (!FIREWALL_ZONE.test(sourceZone)) {
    throw new Error(
      `LAN firewall zone "${sourceZone}" has an unsupported name; use 1-32 letters, digits, hyphens or underscores, then check again`
    )
  }
  const destinationZones = [...new Set(options.destinationZones)]
  // One message used to cover all three, and identified none of them. This
  // surfaces on a failed job item, where the whole value of the text is
  // telling the operator which of the three they are looking at.
  if (destinationZones.length === 0) {
    throw new Error('the WAN pool resolved to no firewall zone at all; check again')
  }
  if (destinationZones.length > 32) {
    throw new Error(
      `the WAN pool spans ${destinationZones.length} firewall zones and at most 32 can be forwarded; split it into smaller carrier-scoped binding instances`
    )
  }
  const badZone = destinationZones.find((zone) => !FIREWALL_ZONE.test(zone))
  if (badZone != null) {
    throw new Error(
      `WAN firewall zone "${badZone}" has an unsupported name; use 1-32 letters, digits, hyphens or underscores`
    )
  }
  const prefix = options.sectionPrefix
  const lines = [
    // The module-owned masquerading zone, named by the caller from what it
    // stamped at creation rather than from what settings now say - a rename
    // must not re-point forwardings at a zone holding none of these WANs.
    // Existing DHCP/static WAN zones are left untouched, and so is the zone's
    // own membership: when it is the pool zone, bm-pppoe-pool owns the
    // `list network` entries and rebuilds them on every pool change - the old
    // `pppoe-<prefix>+` device wildcard this path used to claim is gone with
    // the model that needed it.
    `set firewall.${zoneName}=zone`,
    `set firewall.${zoneName}.name=${shQuote(zoneName)}`,
    `set firewall.${zoneName}.input='REJECT'`,
    `set firewall.${zoneName}.output='ACCEPT'`,
    `set firewall.${zoneName}.forward='REJECT'`,
    `set firewall.${zoneName}.masq='1'`,
    `set firewall.${zoneName}.mtu_fix='1'`
  ]
  const cleanup: string[] = []
  for (let index = 0; index < 32; index++) {
    cleanup.push(`uci -q delete firewall.${prefix}${index} 2>/dev/null || true`)
  }
  destinationZones.forEach((zone, index) => {
    const section = `${prefix}${index}`
    lines.push(
      `set firewall.${section}=forwarding`,
      `set firewall.${section}.src=${shQuote(sourceZone)}`,
      `set firewall.${section}.dest=${shQuote(zone)}`
    )
  })
  await store.withFirewall(async () => {
    const cleaned = await deps.ctx.exec('sh -s', {
      stdin: `${cleanup.join('\n')}\n`,
      timeoutMs: rules.execTimeoutSec * 1000
    })
    if (cleaned.code !== 0) throw shellFailure('clean old binding firewall forwarding', cleaned.code)
    await uciWrite(deps, 'write binding firewall forwarding', lines, ['firewall'])
    const reloaded = await deps.ctx.exec('service firewall reload', {
      timeoutMs: rules.execTimeoutSec * 1000
    })
    if (reloaded.code !== 0) throw shellFailure('reload binding firewall', reloaded.code)
    if (deps.disposed) throw new Error(ENGINE_STOPPED)
  })
}

/**
 * The mirror of the install: every section under the prefix, gone, whether or
 * not this build ever wrote all 32 of them.
 */
export async function removeScopedForwardings(
  deps: ExecDeps,
  store: HostStore,
  sectionPrefix: string
): Promise<void> {
  const rules = deps.options.rules()
  const prefix = sectionPrefix
  const lines: string[] = ['set -e']
  for (let index = 0; index < 32; index++) {
    lines.push(`uci -q delete firewall.${prefix}${index} 2>/dev/null || true`)
  }
  lines.push('uci commit firewall')
  await store.withFirewall(async () => {
    const written = await deps.ctx.exec('sh -s', {
      stdin: `${lines.join('\n')}\n`,
      timeoutMs: rules.execTimeoutSec * 1000
    })
    if (written.code !== 0) throw shellFailure('remove binding firewall forwarding', written.code)
    const reloaded = await deps.ctx.exec('service firewall reload', {
      timeoutMs: rules.execTimeoutSec * 1000
    })
    if (reloaded.code !== 0) throw shellFailure('reload binding firewall', reloaded.code)
    if (deps.disposed) throw new Error(ENGINE_STOPPED)
  })
}

/**
 * The firewall half of a create gate: which zone the LAN sits in, which zones
 * its WANs sit in, and every reason those answers stop a create.
 *
 * The zones are returned as well as reported because the apply path has to
 * write forwardings for exactly the set the check passed on - re-reading the
 * firewall between the two is how a zone renamed in that window ends up
 * forwarded from a source zone that no longer exists.
 */
export function zoneFindings(
  probe: RouterPreparationProbe,
  options: { lan: string; wans: readonly string[]; moduleZone: string },
  findings: ModuleCheckFinding[]
): { lanZone: string; destinationZones: string[] } {
  const { lan, moduleZone } = options
  const destinationZones = new Set<string>()
  const lanZone = firewallZoneForNetwork(probe.firewall, lan)
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
  for (const wan of options.wans) {
    const zone = firewallZoneForNetwork(probe.firewall, wan)
    if (zone) {
      if (FIREWALL_ZONE.test(zone)) {
        destinationZones.add(zone)
      } else {
        findings.push({
          level: 'error',
          label: `WAN "${wan}" uses firewall zone "${zone}" with an unsupported name`
        })
      }
    } else {
      // A managed pool member is always in its pool's zone by explicit
      // `list network` - bm-pppoe-pool writes the membership in the same
      // breath as the interface - so a PPPoE WAN with no zone here is a
      // real gap, not the old wildcard-device arrangement.
      findings.push({
        level: 'error',
        label: `WAN "${wan}" is not assigned to a firewall zone`,
        detail: 'Assign the WAN to a masquerading firewall zone before putting it in a one-to-one pool.'
      })
    }
  }
  destinationZones.add(moduleZone)
  for (const zone of destinationZones) {
    if (!firewallZoneMasquerades(probe.firewall, zone) && zone !== moduleZone) {
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
  return { lanZone, destinationZones: [...destinationZones] }
}

/**
 * A numeric routing table for every named WAN that does not already have one,
 * taken from the band between the routing-table base and the catch-all table.
 *
 * The walk goes downwards from just under the catch-all table and never reuses
 * a number the index, the router's own UCI or the catch-all already holds,
 * because the map from table to WAN is the single fact every binding rule rests
 * on: hand the same number to two WANs and the rules pointing at it stop
 * meaning anything. A WAN that already sits at a conventional number of its own
 * keeps it - moving it would strand assignments written against the old one.
 */
export function allocateWanTables(
  options: {
    wans: readonly string[]
    uciTables: ReadonlyMap<string, number>
    tableIndex: WanTableIndex
    rules: OwrtRules
  },
  findings: ModuleCheckFinding[]
): TablePreparation[] {
  const { uciTables, tableIndex, rules } = options
  const usedTables = new Set<number>([
    ...tableIndex.byTable.keys(),
    ...uciTables.values(),
    rules.catchAllTable
  ])
  const tableAdds: TablePreparation[] = []
  let candidateTable = rules.catchAllTable - 1
  for (const wan of options.wans) {
    const observed = uciTables.get(wan)
    if (observed != null) continue
    if (!UCI_SECTION.test(wan)) {
      findings.push({
        level: 'error',
        label: `WAN section "${wan}" cannot be prepared safely`,
        detail: 'Its UCI section name contains unsupported characters.'
      })
      continue
    }
    const conventional = tableIndex.byWan.get(wan)
    if (
      conventional != null &&
      conventional !== rules.catchAllTable &&
      tableIndex.byTable.get(conventional) === wan
    ) {
      tableAdds.push({ wan, table: conventional })
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
        detail: `Tables ${rules.tableBase + 1}-${rules.catchAllTable - 1} are all spoken for and every WAN needs its own. Widen the range with "Routing-table base" or "Unreachable routing table" under Module settings, Rules - the second is locked while any binding instance exists.`
      })
      break
    }
    tableAdds.push({ wan, table: candidateTable })
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
  return tableAdds
}
