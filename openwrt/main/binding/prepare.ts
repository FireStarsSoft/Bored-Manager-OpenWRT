/**
 * What an instance installs on the router, and the job that installs it.
 *
 * The check produced a plan; by the time the job runs, minutes may have passed
 * and the router may have moved, so every step revalidates before it writes.
 * The three writes themselves - the scoped firewall forwardings, the routing
 * tables and the fail-closed catch-all - live here together with their removal,
 * because a half-installed instance is the one state nothing else can reason
 * about.
 */
import type { OkResult } from '@shared/types'
import type { JobSpec } from '../jobs'
import { recordLayout } from '../records'
import type { BindingInstanceRecord } from '../store'
import { carrierScopesOverlap, parseCidr, subnetsOverlap } from '../util'
import { recordEvents } from './events'
import { lanCidr } from './pool'
import { applyChange, catchAllCidrs } from './reconcile'
import { MANAGED_PREF_CEILING, catchAllLocalRoute, catchAllRoute } from './rules'
import {
  ENGINE_STOPPED,
  NO_SAMPLE,
  execScript,
  exclusive,
  shellFailure,
  uciWrite
} from './runtime'
import { installScopedForwardings, removeScopedForwardings } from './shared'
import { applyTableChunk, claimExtraTables } from './tables'
import {
  DHCP_SECTION,
  firewallZoneForNetwork,
  networkTables,
  preparationProbe,
  sectionsOfType,
  uciOption
} from './uci-doc'
import type {
  BindingCreatePlan,
  BindingRuntime,
  DhcpPreparation,
  TablePreparation
} from './types'

/**
 * How many `uci set` lines travel in one batch. A fixed number rather than a
 * rule since the PPPoE chunk-size setting left with the SSH path that needed
 * tuning; a hundred lines is about ten kilobytes of stdin.
 */
const UCI_WRITE_CHUNK = 100

export async function applyBinding(
  runtime: BindingRuntime,
  raw: unknown
): Promise<OkResult> {
  const payload =
    typeof raw === 'object' && raw !== null
      ? (raw as { token?: unknown; values?: unknown })
      : {}
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.checkSession.take(token, payload.values)
  if (!taken) {
    return { ok: false, error: 'that check expired or the form changed - check again' }
  }
  const plan = taken.payload
  const reservationProblem = reservePreparation(runtime, plan)
  if (reservationProblem) return { ok: false, error: reservationProblem }
  const spec = preparationJob(runtime, plan)
  if (runtime.options.jobs) {
    try {
      const job = runtime.options.jobs.start(spec)
      return { ok: true, data: job.id }
    } catch (error) {
      releasePreparation(runtime, plan.instance.id)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
  try {
    for (const item of spec.items) await item.run(() => false)
    return { ok: true, data: plan.instance.id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    releasePreparation(runtime, plan.instance.id)
  }
}

function preparationJob(runtime: BindingRuntime, plan: BindingCreatePlan): JobSpec {
  const rules = runtime.options.rules()
  const timeoutMs = rules.execTimeoutSec * 1000
  const chunks: TablePreparation[][] = []
  for (let index = 0; index < plan.tableAdds.length; index += UCI_WRITE_CHUNK) {
    chunks.push(plan.tableAdds.slice(index, index + UCI_WRITE_CHUNK))
  }
  const items: JobSpec['items'] = [
    {
      name: 'Revalidate LAN, carrier and routing tables',
      run: async () => {
        await exclusive(runtime, () => revalidatePreparation(runtime, plan))
        return 'router state still matches the check'
      }
    }
  ]
  chunks.forEach((chunk, index) => {
    items.push({
      name: `Prepare WAN tables ${index + 1}/${chunks.length}`,
      run: async (cancelled) => {
        if (cancelled()) throw new Error('cancelled')
        await exclusive(runtime, async () => {
          await applyTableChunk(runtime, chunk, timeoutMs, plan.instance.id)
        })
        return `${chunk.length} WAN table(s)`
      }
    })
  })
  if (plan.dhcp) {
    items.push({
      name: 'Raise dnsmasq lease limits',
      run: async (cancelled) => {
        if (cancelled()) throw new Error('cancelled')
        await exclusive(runtime, () => applyDhcpPreparation(runtime, plan.dhcp!, timeoutMs))
        return `${plan.dhcp!.lanLimit}/${plan.dhcp!.globalLimit}`
      }
    })
  }
  items.push({
    name: 'Install safety catch-all and start',
    run: async (cancelled) => {
      if (cancelled()) throw new Error('cancelled')
      await exclusive(runtime, async () => {
        const existing = runtime.store.read().instances
        const plannedSubnet = parseCidr(plan.lanCidr)
        const overlapsExisting = existing.some((entry) => {
          const otherCidr = runtime.latestModel
            ? lanCidr(
                runtime.latestModel.ifaces.find((iface) => iface.name === entry.lan)
              )
            : null
          const otherSubnet = otherCidr ? parseCidr(otherCidr) : null
          return (
            plannedSubnet != null &&
            otherSubnet != null &&
            subnetsOverlap(plannedSubnet, otherSubnet)
          )
        })
        if (existing.some((entry) => entry.id === plan.instance.id)) {
          throw new Error('binding instance already exists')
        }
        if (
          existing.some(
            (entry) =>
              entry.slot === plan.instance.slot ||
              entry.lan === plan.instance.lan ||
              entry.carrier === plan.instance.lan ||
              entry.lan === plan.instance.carrier ||
              carrierScopesOverlap(entry.carrier, plan.instance.carrier)
          )
        ) {
          throw new Error('an interface or catch-all slot was claimed while the job waited')
        }
        if (overlapsExisting) {
          throw new Error('the LAN subnet now overlaps another binding instance')
        }
        await installFirewallForwardings(
          runtime,
          plan.instance,
          plan.lanZone,
          plan.destinationZones
        )
        const cidrs = catchAllCidrs(plan.instance, plan.lanCidr)
        await installCatchAll(runtime, plan.instance, {
          lanCidr: plan.lanCidr,
          cidrs,
          replace: true
        })
        if (runtime.latestModel) {
          const stamped = recordLayout(plan.instance, runtime.options.rules())
          const pref = stamped.catchAllPrefBase + plan.instance.slot
          runtime.latestModel.rules = runtime.latestModel.rules.filter(
            (rule) => rule.pref !== pref
          )
          // One entry per block, from the same derivation the write above used.
          // The next reconcile compares the preference group as a set, so a
          // model carrying only the first block would have it rebuild a group
          // that is already exactly right.
          for (const block of cidrs) {
            runtime.latestModel.rules.push({
              pref,
              from: block,
              table: stamped.catchAllTable
            })
          }
        }
        // Write-through: an instance appearing is topology. The debounce would
        // put ten seconds between the router carrying this instance's rules
        // and the module having any record that it does.
        runtime.store.updateNow((data) => {
          const busy = data.instances.some(
            (entry) =>
              entry.lan === plan.instance.lan ||
              entry.carrier === plan.instance.lan ||
              entry.lan === plan.instance.carrier ||
              carrierScopesOverlap(entry.carrier, plan.instance.carrier)
          )
          if (busy) throw new Error('one of the interfaces was claimed while the job waited')
          data.instances.push({ ...plan.instance })
          claimExtraTables(
            data,
            plan.instance.id,
            plan.tableAdds.map((entry) => entry.wan)
          )
        })
        recordEvents(runtime, plan.instance, [{
          t: Date.now(),
          kind: 'started',
          text: `binding started for ${plan.instance.lan} -> ${plan.instance.carrier}`
        }])
        runtime.options.requestDump?.()
        if (runtime.latestModel) {
          const error = await applyChange(runtime, runtime.latestModel, {
            forceKernel: false,
            rebooted: false
          })
          if (error) throw new Error(error)
        }
      })
      return plan.instance.id
    }
  })
  return {
    kind: 'binding-prepare',
    label: `Prepare binding ${plan.instance.name}`,
    items,
    onError: 'abort',
    onFinished: () => {
      releasePreparation(runtime, plan.instance.id)
    }
  }
}

function reservePreparation(runtime: BindingRuntime, plan: BindingCreatePlan): string | null {
  const plannedSubnet = parseCidr(plan.lanCidr)
  for (const other of runtime.preparations.values()) {
    if (
      other.instance.id === plan.instance.id ||
      other.instance.slot === plan.instance.slot ||
      other.instance.name.toLowerCase() === plan.instance.name.toLowerCase() ||
      other.instance.lan === plan.instance.lan ||
      other.instance.carrier === plan.instance.lan ||
      other.instance.lan === plan.instance.carrier ||
      carrierScopesOverlap(other.instance.carrier, plan.instance.carrier)
    ) {
      // Naming the holder is the whole remedy: the collision clears itself
      // once that job finishes, which the old sentence gave no hint of.
      return `binding preparation "${other.instance.name}" is still running and holds the same name, safety-rule slot or interface - wait for that job to finish, then check again`
    }
    const otherSubnet = parseCidr(other.lanCidr)
    if (
      plannedSubnet &&
      otherSubnet &&
      subnetsOverlap(plannedSubnet, otherSubnet)
    ) {
      return 'another binding preparation already reserved an overlapping LAN subnet'
    }
    const tables = new Map(other.tableAdds.map((entry) => [entry.table, entry.wan]))
    for (const entry of plan.tableAdds) {
      const owner = tables.get(entry.table)
      if (owner && owner !== entry.wan) {
        return `routing table ${entry.table} is reserved by another binding preparation`
      }
    }
  }
  runtime.preparations.set(plan.instance.id, plan)
  return null
}

export function releasePreparation(runtime: BindingRuntime, id: string): void {
  runtime.preparations.delete(id)
}

async function revalidatePreparation(
  runtime: BindingRuntime,
  plan: BindingCreatePlan
): Promise<void> {
  if (runtime.disposed || !runtime.ctx.connected) throw new Error('router disconnected')
  const model = runtime.latestModel
  if (!model) throw new Error(NO_SAMPLE)
  const currentLan = lanCidr(model.ifaces.find((iface) => iface.name === plan.instance.lan))
  if (currentLan !== plan.lanCidr) throw new Error('LAN subnet changed; check the form again')
  const data = runtime.store.read()
  if (
    data.instances.some(
      (entry) =>
        entry.lan === plan.instance.lan ||
        entry.carrier === plan.instance.lan ||
        entry.lan === plan.instance.carrier ||
        carrierScopesOverlap(entry.carrier, plan.instance.carrier)
    )
  ) {
    throw new Error('one of the two interfaces is now owned by another instance')
  }
  const plannedSubnet = parseCidr(plan.lanCidr)
  if (
    plannedSubnet &&
    data.instances.some((entry) => {
      const otherCidr = lanCidr(
        model.ifaces.find((iface) => iface.name === entry.lan)
      )
      const otherSubnet = otherCidr ? parseCidr(otherCidr) : null
      return otherSubnet != null && subnetsOverlap(plannedSubnet, otherSubnet)
    })
  ) {
    throw new Error('the LAN subnet now overlaps another binding instance')
  }
  const probe = await preparationProbe(runtime)
  const currentLanZone = firewallZoneForNetwork(probe.firewall, plan.instance.lan)
  if (currentLanZone !== plan.lanZone) {
    throw new Error('the LAN firewall zone changed; check the form again')
  }
  const knownZones = new Set(
    sectionsOfType(probe.firewall, 'firewall', 'zone').map(
      (section) => uciOption(probe.firewall, 'firewall', section, 'name') || section
    )
  )
  // The module-owned zone is created by this very job, so it is allowed not to
  // exist yet - but it is the one this instance recorded, not whatever the
  // settings now name.
  const stamped = recordLayout(plan.instance, runtime.options.rules())
  for (const zone of plan.destinationZones) {
    if (zone !== stamped.zoneName && !knownZones.has(zone)) {
      throw new Error(`destination firewall zone ${zone} no longer exists`)
    }
  }
  const currentTables = networkTables(probe.network)
  const occupied = new Map<number, string>()
  for (const [wan, table] of currentTables) occupied.set(table, wan)
  for (const entry of plan.tableAdds) {
    if (!probe.network.sectionTypes.has(`network.${entry.wan}`)) {
      throw new Error(`WAN section ${entry.wan} no longer exists`)
    }
    const current = currentTables.get(entry.wan)
    if (current != null && current !== entry.table) {
      throw new Error(`${entry.wan} now uses table ${current}; check again`)
    }
    const owner = occupied.get(entry.table)
    if (owner && owner !== entry.wan) {
      throw new Error(`table ${entry.table} is now used by ${owner}; check again`)
    }
  }
  const pref = stamped.catchAllPrefBase + plan.instance.slot
  if (model.rules.some((rule) => rule.pref === pref)) {
    throw new Error(`catch-all preference ${pref} is no longer free; check again`)
  }
}

async function applyDhcpPreparation(
  runtime: BindingRuntime,
  preparation: DhcpPreparation,
  timeoutMs: number
): Promise<void> {
  if (
    !DHCP_SECTION.test(preparation.section) ||
    !DHCP_SECTION.test(preparation.dnsmasqSection)
  ) {
    // Both names passed this same test during the check, so reaching here
    // means /etc/config/dhcp changed underneath. Say which one, the way the
    // check phase says it, rather than "unsafe DHCP section".
    const bad = DHCP_SECTION.test(preparation.section)
      ? preparation.dnsmasqSection
      : preparation.section
    throw new Error(`DHCP section "${bad}" cannot be prepared safely; check again`)
  }
  // `commit dhcp` travels as a line of the batch: this is the one config the
  // shared runner has no commit name for, and /etc/config/dhcp is not the file
  // `withNetwork` serializes.
  const lines = [
    `set dhcp.${preparation.section}.limit='${preparation.lanLimit}'`,
    `set dhcp.${preparation.dnsmasqSection}.dhcpleasemax='${preparation.globalLimit}'`,
    'commit dhcp'
  ]
  await uciWrite(runtime, 'write dnsmasq limits', lines, [])
  if (runtime.disposed) throw new Error(ENGINE_STOPPED)
  const restarted = await runtime.ctx.exec('sh -s', {
    stdin: 'set -e\nservice dnsmasq restart\n',
    timeoutMs
  })
  if (restarted.code !== 0) throw shellFailure('restart dnsmasq', restarted.code)
  if (runtime.disposed) throw new Error(ENGINE_STOPPED)
}

/**
 * An instance's own forwardings, which are the shared ones under this
 * instance's `bmf<slot>_` band.
 *
 * The layout is resolved here rather than in the shared writer: it is the
 * module-owned zone this instance was created against, so a rename in settings
 * cannot leave the forwardings pointing at a zone that has none of this
 * instance's WANs in it.
 */
async function installFirewallForwardings(
  runtime: BindingRuntime,
  instance: BindingInstanceRecord,
  sourceZone: string,
  destinationZonesRaw: readonly string[]
): Promise<void> {
  const layout = recordLayout(instance, runtime.options.rules())
  await installScopedForwardings(runtime, runtime.store, {
    sectionPrefix: `bmf${instance.slot}_`,
    sourceZone,
    destinationZones: destinationZonesRaw,
    zoneName: layout.zoneName
  })
}

export async function removeFirewallForwardings(
  runtime: BindingRuntime,
  instance: BindingInstanceRecord
): Promise<void> {
  await removeScopedForwardings(runtime, runtime.store, `bmf${instance.slot}_`)
}

/**
 * The connected route that goes into the catch-all table beside the blackhole,
 * or nothing when the LAN's device cannot be read.
 *
 * Nothing rather than a guess: a wrong device name here is a route pointing at
 * the wrong interface, which is worse than the blackhole this is softening. The
 * sweep reads the model every tick and `reconcileCatchAll` writes the pair
 * again, so a device that is briefly unreadable is corrected on the next pass
 * rather than being wrong until somebody notices.
 */
function localRouteFor(
  runtime: BindingRuntime,
  instance: BindingInstanceRecord,
  cidr: string,
  table: number
): string[] {
  const device = runtime.latestModel?.ifaces.find((iface) => iface.name === instance.lan)?.l3Device
  return device ? [catchAllLocalRoute(table, cidr, device)] : []
}

/**
 * `lanCidr` is the whole LAN and `cidrs` is what the rule set selects on, and
 * they are two different things for a range instance.
 *
 * The connected route below is destination-scoped - it is what keeps the router
 * answering on the LAN it is blackholing - so it stays the whole subnet however
 * narrow the bound range is. Handing it the range's blocks instead would take
 * the router off its own network for every address outside them.
 */
export async function installCatchAll(
  runtime: BindingRuntime,
  instance: BindingInstanceRecord,
  options: { lanCidr: string; cidrs: readonly string[]; replace: boolean }
): Promise<void> {
  // The instance's own numbers, so a catch-all installed today is removed
  // tomorrow at the preference it was actually written at.
  const layout = recordLayout(instance, runtime.options.rules())
  const pref = layout.catchAllPrefBase + instance.slot
  if (pref < layout.catchAllPrefBase || pref >= MANAGED_PREF_CEILING) {
    throw new Error(
      `catch-all preference ${pref} (safety-rule base ${layout.catchAllPrefBase} plus slot ${instance.slot}) is outside the managed range ${layout.catchAllPrefBase}-${MANAGED_PREF_CEILING - 1}; lower "Safety-rule priority base" under Module settings, Rules`
    )
  }
  const { lanCidr: cidr, cidrs, replace } = options
  // Refused rather than written as an empty group. A catch-all that selects no
  // address at all is an instance that looks installed and is not fail-closed,
  // which is the one state nothing downstream can detect.
  if (cidrs.length === 0) {
    throw new Error('the catch-all resolved to no source range at all; check again')
  }
  const lines = [
    // `replace` rather than flush-then-add: the flush left the table with no
    // default for as long as the add took, and a client whose rule already
    // pointed here fell through to the next rule - the main table - and left
    // through the router's own WAN in that window. Adding over the entry is
    // one atomic netlink message, so the blackhole never stops existing.
    catchAllRoute(layout.catchAllTable),
    // Before the rule, not after: between the two the router would be selecting
    // this table for its own LAN traffic with nothing in it but `unreachable`.
    ...localRouteFor(runtime, instance, cidr, layout.catchAllTable),
    ...(replace
      ? [`while ip -4 rule del pref ${pref} 2>/dev/null; do :; done`]
      : []),
    // One rule per block, all at the same preference. The kernel carries a
    // same-priority group happily, and the loop above already clears a whole
    // one, so nothing about removal changes when a range needs several.
    ...cidrs.map(
      (block) => `ip -4 rule add from ${block} lookup ${layout.catchAllTable} pref ${pref}`
    )
  ]
  await execScript(runtime, lines, 'install binding catch-all')
}
