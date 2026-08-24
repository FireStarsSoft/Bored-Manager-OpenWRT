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
  /** Absolute Unix expiry time in seconds, rebased onto the app's clock. Zero means a static/infinite lease. */
  expires: number
  /**
   * True when the router could not say what time it thinks it is - `ubus call
   * system info` without a `localtime`, which is what a router that has not
   * reached NTP yet answers, and what a freshly booted one answers for the
   * first minute or two. `expires` is then the router's own epoch and cannot
   * be compared with anything here, so nothing does: the lease counts as
   * active and its remaining time reads "unknown" rather than being turned
   * into a number that is wrong by however far the two clocks are apart.
   */
  expiresUnknown?: boolean
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
  /** When the slow probe (UCI tables, PPPoE log) last completed - 0 before the first one. */
  slowAt: number
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
