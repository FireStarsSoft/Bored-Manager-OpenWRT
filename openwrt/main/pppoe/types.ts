/**
 * The vocabulary of this domain: the narrow slices it needs from the rest of
 * the module, and the shapes every surface renders.
 *
 * The pool of record lives on the router - `bm-pppoe-pool` keeps it, derives
 * everything from it, and answers for it over ubus. What stays on this side is
 * a cache of the daemon's answers, the check-token session, and the parsers
 * that turn form fields into a spec. Nothing here describes UCI: this half no
 * longer writes any.
 */
import type { ValueBadge } from '@shared/module-ui'
import type { AgentCapability } from '../probe'
import type { PoolSpec } from '../agent'
import type { JobSpec, OpenWrtJob } from '../jobs'

/** Only the rules consumed here; ConfigStore.effectiveRules() returns more. */
export interface PppoeRules {
  execTimeoutSec: number
  /** The create form's default numbering base; the pool records its own. */
  tableBase: number
}

/** The part of ConfigStore used by this manager. */
export interface PppoeConfigStore {
  effectiveRules(): PppoeRules
}

export interface PppoeJobs {
  start(spec: JobSpec): OpenWrtJob
  list(): OpenWrtJob[]
}

/**
 * Adapter over the module's shared services. `forceDump` pokes the fast sweep
 * so the next model reflects what a mutation just changed; `event` writes the
 * module event ring; `bindingCarriers` is how the delete gate learns which
 * carriers a running binding instance is distributing clients across - the
 * two domains meet there, not in each other.
 */
export interface PppoeService {
  forceDump(): void
  refreshNow?(): Promise<void>
  event?(kind: string, text: string): void
  bindingCarriers?(): ReadonlyArray<{
    id: string
    name: string
    carrier: string
    running: boolean
  }>
}

/** The capability verdict, read per operation and never captured. */
export type PppoeAgentReader = () => AgentCapability

/**
 * What the check froze behind its one-use token: the exact spec that was
 * validated - credentials included - and which operation it belongs to.
 * Nothing may be re-read at apply time, or the findings the user approved
 * stop describing what is about to happen.
 */
export interface FrozenPoolChange {
  id: string
  spec: Readonly<PoolSpec>
  creating: boolean
}

/** The `pppoe` stream payload: totals over every pool, plus staleness. */
export interface PppoeSnapshot {
  t: number
  pools: number
  interfaces: number
  up: number
  dialing: number
  down: number
  error: number
  stopped: number
  unwritten: number
  /** error + unwritten: the rows a person would act on. */
  attention: number
  legacyCount: number
  /** True when the router stopped answering and these are the last numbers. */
  stale: boolean
  /**
   * What is wrong with the rows below, in a sentence, or ''.
   *
   * Two things can be, and both look like nothing being wrong: a pool whose
   * members did not all fit in one page, and a router whose netifd has stopped
   * answering - where every row goes on reading exactly as it did at the last
   * good pass.
   */
  notice: string
}

/**
 * One pool as the Pools table renders it: the daemon's flat spec verbatim -
 * snake_case keys, so a row drawer's form fields can prefill straight from
 * the row - plus counts, badges and the prefilled member text.
 */
export interface PppoePoolRow {
  id: string
  label: string
  /** The label when there is one, else the id: what the column shows. */
  title: string
  mode: 'multi' | 'single'
  modeLabel: string
  prefix: string
  carrier: string
  carrier_mode: 'vlan' | 'direct'
  carrierModeLabel: string
  mac_mode: 'auto' | 'inherit'
  /** The shared username in multi; a per-VLAN note in single. */
  account: string
  username: string
  table_base: number
  service: string
  ac: string
  ac_mac: string
  /** '' when unset, so a form field prefills empty rather than 0. */
  mtu: string
  keepalive_failure: string
  keepalive_interval: string
  ipv6: string
  peerdns: boolean
  dns: string
  defaultroute: boolean
  host_uniq: string
  demand: string
  padi_attempts: string
  padi_timeout: string
  pppd_options: string
  zone: string
  masq: boolean
  mtu_fix: boolean
  lan_forward: boolean
  /** The member list in the form the members editor takes. */
  listText: string
  members: number
  up: number
  dialing: number
  down: number
  error: number
  stopped: number
  unwritten: number
  stateBadges: ValueBadge[]
  rxBps: number
  txBps: number
  createdAt: number
}

/** One legacy pool: shown so it can be deleted, nothing else. */
export interface PppoeLegacyRow {
  id: string
  prefix: string
  carrier: string
  count: number
  seqFrom: number
  seqTo: number
}

/** One member row, as every table renders it. */
export interface PppoeDisplayRow {
  name: string
  poolId: string
  pool: string
  vlan: number
  device: string
  username: string
  mac: string
  status: string
  statusBadges: ValueBadge[]
  errorCode: string
  ip: string
  table: number
  /** App-clock ms the session came up, or 0 when it is not up. */
  upSince: number
  autostart: boolean
  redials: number
  rxBps: number
  txBps: number
}
