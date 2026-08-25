/**
 * Which interfaces an instance owns, and which of its WANs can take a client
 * right now.
 *
 * An instance is one LAN plus one carrier, and the carrier names a physical
 * device and every VLAN sub-device under it. Everything that has to answer
 * "is this WAN in the pool" or "may this WAN be handed out" asks here, so the
 * check gate, the reconcile pass and the pure planner all agree.
 */
import type { OwrtRules } from '../config'
import type { ManagedLayout } from '../records'
import type { BindingInstanceRecord } from '../store'
import type { IfaceState, RouterModel } from '../types'
import { parseCidr } from '../util'
import type {
  BindingPlannerPolicy,
  BindingPlannerWan,
  WanTableIndex
} from './types'

export function lanCidr(iface: IfaceState | undefined): string | null {
  if (!iface?.ipv4) return null
  const prefix = Math.trunc(iface.ipv4.mask)
  if (prefix < 0 || prefix > 32) return null
  const parsed = parseCidr(`${iface.ipv4.addr}/${prefix}`)
  return parsed?.cidr ?? null
}

export function carrierMatches(device: string, carrier: string): boolean {
  return device === carrier || device.startsWith(`${carrier}.`)
}

export function poolIfaces(model: RouterModel, lan: string, carrier: string): IfaceState[] {
  const seen = new Set<string>()
  const result: IfaceState[] = []
  for (const iface of model.ifaces) {
    if (
      iface.name === lan ||
      iface.name === 'loopback' ||
      !['pppoe', 'dhcp', 'static'].includes(iface.proto) ||
      !carrierMatches(iface.device, carrier) ||
      seen.has(iface.name)
    ) {
      continue
    }
    seen.add(iface.name)
    result.push(iface)
  }
  return result
}

export function ifaceScopeKeys(iface: IfaceState | undefined): string[] {
  if (!iface) return []
  return [iface.name, iface.device, iface.l3Device].filter(Boolean)
}

export function isManagedPppoeSection(
  name: string,
  batches: ReadonlyArray<{ prefix: string }>
): boolean {
  return batches.some((batch) => {
    if (!name.startsWith(batch.prefix)) return false
    const seq = name.slice(batch.prefix.length)
    return /^\d{5}$/.test(seq)
  })
}

export function plannerWans(
  model: RouterModel,
  instance: BindingInstanceRecord,
  tables: WanTableIndex
): BindingPlannerWan[] {
  return poolIfaces(model, instance.lan, instance.carrier).map((iface) => ({
    name: iface.name,
    table: tables.byWan.get(iface.name) ?? null,
    up: iface.up,
    pending: iface.pending,
    ...(iface.ipv4?.addr ? { ipv4: iface.ipv4.addr } : {}),
    uptimeSec: iface.uptimeSec,
    ...(iface.errorCode ? { errorCode: iface.errorCode } : {})
  }))
}

/**
 * The two preference bounds come from the instance's own recorded layout, not
 * from config: they decide which of the router's rules this instance owns, and
 * a config edit that moved them under a running instance would make the
 * reconciler stop recognising every assignment it had already written and add a
 * second copy of each at the new numbers.
 *
 * `rules.stickyByMac` and `rules.remapOnWanError` are deliberately not copied
 * here. They are the defaults the create form offers; what an instance does is
 * its own `sticky` / `remap`, which is what the planner reads and what the row
 * form edits. Passing the module-wide values alongside them only invited the
 * two to disagree.
 */
export function plannerPolicy(rules: OwrtRules, layout: ManagedLayout): BindingPlannerPolicy {
  return {
    rulePrefBase: layout.rulePrefBase,
    catchAllPrefBase: layout.catchAllPrefBase,
    ruleChunkLines: rules.ruleChunkLines,
    wanErrorGraceSec: rules.wanErrorGraceSec,
    wanWarnUptimeSec: rules.wanWarnUptimeSec,
    releaseGraceSec: rules.releaseGraceSec,
    maxEvents: rules.maxEvents
  }
}

export function wanUsable(wan: BindingPlannerWan, warnUptimeSec: number): boolean {
  return (
    wan.table != null &&
    wan.up &&
    !wan.pending &&
    Boolean(wan.ipv4) &&
    !wan.errorCode &&
    wan.uptimeSec >= warnUptimeSec
  )
}

export function wanState(wan: BindingPlannerWan, warnUptimeSec: number): string {
  if (wan.pending) return 'dialing'
  if (!wan.up || wan.errorCode) return 'error'
  if (!wan.ipv4 || wan.table == null || wan.uptimeSec < warnUptimeSec) return 'warning'
  return 'available'
}

export class SeededRandom {
  private state: number

  constructor(seedRaw: number) {
    this.state = (Math.trunc(seedRaw) >>> 0) || 0x9e3779b9
  }

  next(): number {
    let value = this.state
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    this.state = value >>> 0
    return this.state / 0x1_0000_0000
  }
}

export class FreeWanPool {
  private values: BindingPlannerWan[]
  private positions = new Map<string, number>()

  constructor(values: readonly BindingPlannerWan[]) {
    this.values = [...values]
    this.values.forEach((wan, index) => this.positions.set(wan.name, index))
  }

  has(name: string): boolean {
    return this.positions.has(name)
  }

  takeNamed(name: string): BindingPlannerWan | null {
    const index = this.positions.get(name)
    return index == null ? null : this.takeAt(index)
  }

  takeRandom(random: SeededRandom, avoid?: string): BindingPlannerWan | null {
    if (this.values.length === 0) return null
    let index = Math.min(
      this.values.length - 1,
      Math.floor(random.next() * this.values.length)
    )
    if (avoid && this.values.length > 1 && this.values[index]?.name === avoid) {
      index = (index + 1) % this.values.length
    }
    return this.takeAt(index)
  }

  private takeAt(index: number): BindingPlannerWan | null {
    const selected = this.values[index]
    if (!selected) return null
    const last = this.values.pop()
    this.positions.delete(selected.name)
    if (last && index < this.values.length) {
      this.values[index] = last
      this.positions.set(last.name, index)
    }
    return selected
  }
}
