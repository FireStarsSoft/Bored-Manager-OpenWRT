/** Live state parsed from one OpenWRT collection command. */

export interface RouterSystemState {
  uptimeSec: number
  load1: number
  memTotal: number
  memFree: number
}

export interface Ipv4Address {
  addr: string
  mask: number
}

export interface IfaceState {
  /** Logical UCI interface name (`lan`, `wan`, `pd00001`, ...). */
  name: string
  proto: string
  device: string
  l3Device: string
  up: boolean
  pending: boolean
  autostart: boolean
  ipv4?: Ipv4Address
  uptimeSec: number
  errorCode?: string
  /** Present on releases that include it in `network.interface dump`. */
  ip4Table?: number
}

export interface Lease {
  /** Absolute Unix expiry time in seconds. Zero means a static/infinite lease. */
  expires: number
  mac: string
  ip: string
  host: string
}

export interface IpRule {
  pref: number
  /** Usually an IPv4 address or `<address>/32`; `all` is retained for catch-alls. */
  from: string
  table: number
}

export interface DeviceCounters {
  rx: number
  tx: number
}

export interface PoolDeviceCounters extends DeviceCounters {
  count: number
}

export interface ProcNetDevSnapshot {
  devices: Record<string, DeviceCounters>
  poolDev: PoolDeviceCounters
}

export interface RouterModel {
  t: number
  sys: RouterSystemState
  ifaces: IfaceState[]
  poolDev: PoolDeviceCounters
  leases: Lease[]
  rules: IpRule[]
  /** Bytes per second, keyed by Linux netdev. The aggregate pool uses `POOL_RATE_KEY`. */
  rates: Record<string, DeviceCounters>
}

export const POOL_RATE_KEY = '__pool__'

export interface PppoeInputRow {
  user: string
  pass: string
  vlan?: number
}

export interface PppoeParseError {
  line: number
  reason: string
}

export interface PppoeListResult {
  rows: PppoeInputRow[]
  errors: PppoeParseError[]
  /** Usernames occurring more than once, in first-duplicate order. */
  duplicates: string[]
}

export type PppoeErrorCode =
  | 'AUTH_FAILED'
  | 'NO_PADO'
  | 'PEER_TERMINATED'
  | 'LINK_LOST'
  | 'TIMEOUT'
  | 'UNKNOWN'

export interface OpenWrtSlowSample {
  t: number
  log: string
  pppoeErrors: Record<string, PppoeErrorCode>
  /** UCI section -> username, retained in RAM only (passwords are never read). */
  pppoeUsers: Record<string, string>
  /** UCI network section -> numeric routing table. */
  uciTables: Record<string, number>
  model: RouterModel | null
}

export interface OpenWrtSeriesPoint {
  t: number
  rx: number
  tx: number
  wanUp: number
  wanErr: number
  devices: number
}

export interface OpenWrtOverviewCounts {
  ifTotal: number
  wanUp: number
  wanErr: number
  devices: number
  bound: number
  waiting: number
}

export interface PoolAggregate {
  total: number
  up: number
  dialing: number
  error: number
  stopped: number
  rx: number
  tx: number
  /** UI-friendly aliases; values are still bytes per second. */
  rxRate: number
  txRate: number
}

export interface OverviewIface {
  name: string
  proto: string
  device: string
  status: string
  ipv4: string
  uptimeLabel: string
  rxRate: number
  txRate: number
}

export interface OpenWrtOverview {
  t: number
  sys: RouterSystemState & { uptimeLabel: string }
  counts: OpenWrtOverviewCounts
  /** Pool members are omitted and this list is capped before it is pushed. */
  ifaces: OverviewIface[]
  poolAgg: PoolAggregate
}

export interface BindingOverviewTotals {
  bound: number
  waiting: number
}
