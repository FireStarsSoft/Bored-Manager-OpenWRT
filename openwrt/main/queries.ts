import { statusBadges } from './badges'
import type { ConfigStore } from './config'
import type { HostStore } from './store'
import type { IfaceState, IpRule, Lease, RouterModel } from './types'
import { ifaceIndex, ipv4ToInt, sameSubnet } from './util'

function ifaceStatus(iface: IfaceState): string {
  if (iface.up && iface.ipv4) return 'up'
  if (iface.errorCode) return 'error'
  if (iface.pending || iface.autostart) return 'dialing'
  return 'stopped'
}

function fromAddress(rule: IpRule): string | null {
  if (rule.from === 'all') return null
  const address = rule.from.replace(/\/32$/, '')
  return ipv4ToInt(address) == null ? null : address
}

function expiryLabel(lease: Lease, nowSec: number): string {
  if (lease.expires === 0) return 'never'
  // The router's clock is not ours to subtract from; see Lease.expiresUnknown.
  if (lease.expiresUnknown) return 'unknown'
  const expires = lease.expires
  const remaining = expires - nowSec
  if (remaining <= 0) return 'expired'
  if (remaining < 60) return `${remaining}s`
  if (remaining < 3_600) return `${Math.ceil(remaining / 60)}m`
  return `${Math.ceil(remaining / 3_600)}h`
}

/**
 * The same expiry as an absolute time the renderer can print in the viewer's
 * own locale - 0 whenever there is no such moment to print. That covers both a
 * static lease, which never expires, and one whose expiry could not be rebased
 * onto our clock; `expires` still carries the word for those two cases.
 */
function expiresAt(lease: Lease): number {
  if (lease.expires === 0 || lease.expiresUnknown) return 0
  return lease.expires * 1_000
}

/** Builders for potentially-thousands-row invoke tables; every source is RAM. */
export class Queries {
  constructor(
    private model: () => RouterModel | null,
    private uciTables: () => Record<string, number>,
    private config: ConfigStore,
    private store: HostStore
  ) {}


  deviceRows(): Array<Record<string, unknown>> {
    const model = this.model()
    if (!model) return []
    const rules = this.config.effectiveRules()
    const data = this.store.read()
    const tableToWan = new Map<number, string>()
    for (const [section, table] of Object.entries(this.uciTables())) {
      if (table > 0 && !tableToWan.has(table)) tableToWan.set(table, section)
    }
    for (const iface of model.ifaces) {
      if (iface.ip4Table && !tableToWan.has(iface.ip4Table)) {
        tableToWan.set(iface.ip4Table, iface.name)
      }
    }
    for (const [wan, table] of data.extraTables) {
      if (!tableToWan.has(table)) tableToWan.set(table, wan)
    }

    const assignmentByIp = new Map<string, { wan: string; pref: number; table: number }>()
    for (const rule of model.rules) {
      if (rule.pref < rules.rulePrefBase || rule.pref >= rules.catchAllPrefBase) continue
      const ip = fromAddress(rule)
      if (!ip) continue
      // Pool members carry their table in the dump (`ip4Table`), so the
      // table-to-WAN map above already names them; the old naming-convention
      // fallback went with the batch records.
      const wan = tableToWan.get(rule.table)
      if (!wan) continue
      const current = assignmentByIp.get(ip)
      if (!current || rule.pref < current.pref) {
        assignmentByIp.set(ip, { wan, pref: rule.pref, table: rule.table })
      }
    }

    const byName = ifaceIndex(model)
    const configuredLans = new Set(data.instances.map((instance) => instance.lan))
    const lanIfaces = model.ifaces
      .filter(
        (iface) =>
          iface.ipv4 &&
          iface.name !== 'loopback' &&
          (configuredLans.has(iface.name) || iface.proto === 'static')
      )
      .sort(
        (a, b) =>
          Number(configuredLans.has(b.name)) - Number(configuredLans.has(a.name)) ||
          (b.ipv4?.mask ?? 0) - (a.ipv4?.mask ?? 0)
      )
    const nowSec = Math.floor(Date.now() / 1_000)
    return model.leases.map((lease) => {
      const lan =
        lanIfaces.find(
          (iface) =>
            iface.ipv4 != null &&
            sameSubnet(iface.ipv4.addr, lease.ip, iface.ipv4.mask)
        )?.name ?? ''
      const instance = data.instances.find((entry) => entry.lan === lan)
      const assignment = assignmentByIp.get(lease.ip)
      const wan = assignment?.wan ?? ''
      const wanIface = wan ? byName.get(wan) : undefined
      const status = assignment
        ? !wanIface || ifaceStatus(wanIface) !== 'up'
          ? 'wan-error'
          : 'bound'
        : instance?.running
          ? 'waiting'
          : 'unmanaged'
      return {
        host: lease.host,
        mac: lease.mac,
        ip: lease.ip,
        lan,
        expires: expiryLabel(lease, nowSec),
        expiresAt: expiresAt(lease),
        wan,
        bindingStatus: status,
        bindingBadges: statusBadges(status),
        // Carried so the table can offer Reassign/Unassign on the row itself:
        // both take the instance the device belongs to, and until now the only
        // way to reach them was to find that instance on the Automation page.
        instanceId: instance?.id ?? ''
      }
    })
  }
}
