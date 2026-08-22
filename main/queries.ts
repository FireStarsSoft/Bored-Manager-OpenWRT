import type { ConfigStore } from './config'
import type { HostStore, PppoeBatchRecord } from './store'
import type { IfaceState, IpRule, RouterModel } from './types'

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet < 0 || octet > 255) return null
    value = (value * 256 + octet) >>> 0
  }
  return value
}

function subnetContains(address: string, mask: number, candidate: string): boolean {
  const left = ipv4ToInt(address)
  const right = ipv4ToInt(candidate)
  if (left == null || right == null || mask < 0 || mask > 32) return false
  const bits = mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0
  return (left & bits) === (right & bits)
}

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

function conventionalWan(table: number, tableBase: number, batches: PppoeBatchRecord[]): string {
  const seq = table - tableBase
  if (!Number.isInteger(seq) || seq < 1) return ''
  const batch = batches.find((entry) => seq >= entry.seqFrom && seq <= entry.seqTo)
  return batch ? `${batch.prefix}${String(seq).padStart(5, '0')}` : ''
}

function expiryLabel(expires: number, nowSec: number): string {
  if (expires === 0) return 'never'
  const remaining = expires - nowSec
  if (remaining <= 0) return 'expired'
  if (remaining < 60) return `${remaining}s`
  if (remaining < 3_600) return `${Math.ceil(remaining / 60)}m`
  return `${Math.ceil(remaining / 3_600)}h`
}

function uptimeLabel(secondsRaw: number): string {
  let seconds = Math.max(0, Math.floor(secondsRaw))
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3_600)
  seconds %= 3_600
  const minutes = Math.floor(seconds / 60)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m`
  return `${seconds}s`
}

/** Builders for potentially-thousands-row invoke tables; every source is RAM. */
export class Queries {
  constructor(
    private model: () => RouterModel | null,
    private uciTables: () => Record<string, number>,
    private config: ConfigStore,
    private store: HostStore
  ) {}

  interfaceRows(): Array<Record<string, unknown>> {
    const model = this.model()
    if (!model) return []
    return [...model.ifaces]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((iface) => {
        const rate =
          model.rates[iface.l3Device] ??
          model.rates[iface.device] ??
          model.rates[iface.name] ?? { rx: 0, tx: 0 }
        return {
          id: iface.name,
          name: iface.name,
          proto: iface.proto,
          device: iface.device,
          l3Device: iface.l3Device,
          status: ifaceStatus(iface),
          ipv4: iface.ipv4 ? `${iface.ipv4.addr}/${iface.ipv4.mask}` : '',
          uptime: Math.round(iface.uptimeSec),
          rx: Math.round(rate.rx),
          tx: Math.round(rate.tx),
          uptimeLabel: uptimeLabel(iface.uptimeSec),
          rxRate: Math.round(rate.rx),
          txRate: Math.round(rate.tx),
          table: iface.ip4Table ?? '',
          error: iface.errorCode ?? ''
        }
      })
  }

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
      const wan =
        tableToWan.get(rule.table) ||
        conventionalWan(rule.table, rules.tableBase, data.batches)
      if (!wan) continue
      const current = assignmentByIp.get(ip)
      if (!current || rule.pref < current.pref) {
        assignmentByIp.set(ip, { wan, pref: rule.pref, table: rule.table })
      }
    }

    const byName = new Map(model.ifaces.map((iface) => [iface.name, iface]))
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
            subnetContains(iface.ipv4.addr, iface.ipv4.mask, lease.ip)
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
        expires: expiryLabel(lease.expires, nowSec),
        wan,
        bindingStatus: status
      }
    })
  }
}
