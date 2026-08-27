/**
 * Driving `bm-pppoe-pool` 2.x - the only way this module touches PPPoE.
 *
 * The daemon owns the pools end to end: it writes the interfaces, the tagged
 * devices and their MACs, the routing tables and the firewall zone, all
 * derived from one record it keeps on the router. This module composes specs,
 * shows findings, and calls ubus; it no longer writes a single UCI line for
 * PPPoE over SSH. A router without the package - or with the 1.x one - gets a
 * readiness row saying to install or update it, and nothing else works, on
 * purpose: there is no SSH fallback to silently disagree with the daemon.
 *
 * Credentials travel one way only. Every spec that may carry a password -
 * check, create, set - is written to a `mktemp` 0600 file over the SSH
 * connection the module already has, and the ubus call names the path. The
 * daemon reads and unlinks it before it validates anything, so a password is
 * never an argument to any process on either side, and a check that fails
 * leaves nothing readable in /tmp.
 */
import { shQuote } from '@shared/shell'
import { objectCall, PPPOE_OBJECT, unwrap, type AgentCallResult, type AgentDeps } from './client'

/** Reconciling 500 members and reloading netifd is seconds; leave slack. */
const MUTATE_TIMEOUT_MS = 300_000

/** One member of a spec. `user`/`pass` only exist in mode `single`. */
export interface PoolSpecMember {
  vlan: number
  user?: string
  pass?: string
}

/**
 * The canonical spec: what pool_check, pool_create and pool_set exchange.
 * Keys are the daemon's own (snake_case); a partial spec keeps stored values
 * for every key it leaves out.
 */
export interface PoolSpec {
  mode?: 'multi' | 'single'
  label?: string
  prefix?: string
  carrier?: string
  carrier_mode?: 'vlan' | 'direct'
  mac_mode?: 'auto' | 'inherit'
  username?: string
  password?: string
  members?: PoolSpecMember[]
  table_base?: number
  service?: string
  ac?: string
  ac_mac?: string
  mtu?: number
  keepalive?: string
  ipv6?: 'auto' | '0' | '1'
  peerdns?: boolean
  dns?: string[]
  defaultroute?: boolean
  host_uniq?: string
  demand?: number
  padi_attempts?: number
  padi_timeout?: number
  pppd_options?: string
  zone?: string
  masq?: boolean
  mtu_fix?: boolean
  lan_forward?: boolean
}

/** A finding, exactly as the daemon words it. Same levels as ModuleCheckFinding. */
export interface PoolFinding {
  level: 'error' | 'warning' | 'info' | 'pass'
  label: string
  detail?: string
}

export interface PoolCheckReply {
  ok: boolean
  findings?: PoolFinding[]
  reason?: string
}

export interface PoolMemberInfo {
  vlan: number
  username: string
}

/** One pool as `info` reports it: the flat spec minus passwords, plus counts. */
export interface PoolInfoEntry {
  id: string
  mode: 'multi' | 'single'
  label: string
  prefix: string
  carrier: string
  carrier_mode?: 'vlan' | 'direct'
  mac_mode: 'auto' | 'inherit'
  username: string
  hasPassword: boolean
  table_base: number
  service: string
  ac: string
  ac_mac: string
  mtu: number
  keepalive: string
  ipv6: string
  peerdns: boolean
  dns: string[]
  defaultroute: boolean
  host_uniq: string
  demand: number
  padi_attempts: number
  padi_timeout: number
  pppd_options: string
  zone: string
  masq: boolean
  mtu_fix: boolean
  lan_forward: boolean
  memberList: PoolMemberInfo[]
  members: number
  up: number
  dialing: number
  down: number
  error: number
  stopped: number
  unwritten: number
  createdAt: number
  rate: { rxBps: number; txBps: number }
}

/** A pool from the old model: listed so it can be deleted, nothing else. */
export interface PoolLegacyEntry {
  id: string
  prefix: string
  carrier: string
  seqFrom: number
  seqTo: number
  count: number
  tableBase: number
}

export interface PoolSettings {
  enabled: boolean
  counter_interval: number
  redial_after: number
  redial_batch: number
}

export interface PoolInfo {
  name: string
  release: string
  apiVersion: number
  settings: PoolSettings
  started: number
  uptime: number
  pools: PoolInfoEntry[]
  legacy: PoolLegacyEntry[]
}

export type PoolRowStatus = 'up' | 'dialing' | 'down' | 'error' | 'stopped' | 'unwritten'

/** One member row, always present whatever the router is doing. */
export interface PoolRow {
  pool: string
  section: string
  vlan: number
  device: string
  username: string
  mac: string
  status: PoolRowStatus
  autostart: boolean
  uptime: number
  ip: string
  table: number
  errorCode: string
  rxBps: number
  txBps: number
  redials: number
}

export type PoolActionName = 'up' | 'down' | 'redial' | 'enable' | 'disable'

export interface PoolCarrier {
  name: string
  up: boolean
  macaddr: string
}

function call<T>(
  deps: AgentDeps,
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<AgentCallResult<T>> {
  return objectCall<T>(deps, PPPOE_OBJECT, method, args, timeoutMs)
}

export function poolInfo(deps: AgentDeps): Promise<AgentCallResult<PoolInfo>> {
  return call<PoolInfo>(deps, 'info')
}

export function poolStats(deps: AgentDeps): Promise<AgentCallResult> {
  return call(deps, 'stats')
}

/** Member rows, from the record, so a table never loses a row. */
export function poolSessions(
  deps: AgentDeps,
  id = '',
  scope: 'attention' | 'up' | 'down' | 'all' = 'all'
): Promise<AgentCallResult<{ sessions: PoolRow[]; limit: number }>> {
  return call<{ sessions: PoolRow[]; limit: number }>(deps, 'sessions', { id, scope })
}

/** The devices a pool could dial over, as the router lists them. */
export async function poolCarriers(
  deps: AgentDeps
): Promise<AgentCallResult<{ carriers: PoolCarrier[] }>> {
  return unwrap(await call<{ carriers: PoolCarrier[] }>(deps, 'carriers'))
}

/**
 * Make a `0600` file on the router and put the payload in it.
 *
 * `mktemp` rather than a name this module composed: a guessable path under
 * /tmp can be pre-created as a symlink by anything else on the router and
 * turned into a write somewhere else entirely (CWE-377). `umask 077` before
 * the redirect, not `chmod` after it, because a chmod leaves a window in
 * which the file exists and is readable.
 */
async function pushPayload(
  deps: AgentDeps,
  payload: string
): Promise<{ path: string | null; error: string | null }> {
  const made = await deps.ctx.exec('umask 077; mktemp /tmp/bm-pool.XXXXXX', { timeoutMs: 15_000 })
  const path = (made.stdout || '').trim()

  if (made.code !== 0 || !/^\/tmp\/bm-pool\.[A-Za-z0-9]{6}$/.test(path)) {
    return { path: null, error: 'Could not make a temporary file on the router for the spec.' }
  }

  // The payload goes on stdin, never as an argument. It is the whole point.
  const written = await deps.ctx.exec(`umask 077; cat > ${shQuote(path)}`, {
    stdin: payload,
    timeoutMs: 120_000
  })

  if (written.code !== 0) {
    // Best effort, and unchecked: the file is 0600 in tmpfs, so the worst
    // case is a file that disappears at the next reboot. Failing the call
    // because the cleanup failed would report the wrong problem.
    await deps.ctx.exec(`rm -f ${shQuote(path)}`, { timeoutMs: 15_000 })
    return { path: null, error: 'The spec could not be written to the router.' }
  }

  return { path, error: null }
}

/**
 * One spec-carrying call: push the 0600 file, name its path, and clean up
 * when the call never reached the daemon. The daemon unlinks the file as it
 * reads it, so the rm only matters for a connection that dropped in between.
 */
async function specCall<T>(
  deps: AgentDeps,
  method: 'pool_check' | 'pool_create' | 'pool_set',
  id: string,
  spec: PoolSpec,
  timeoutMs: number
): Promise<AgentCallResult<T>> {
  const pushed = await pushPayload(deps, JSON.stringify(spec))
  if (!pushed.path) {
    return { ok: false, data: null, error: pushed.error }
  }

  const result = await call<T>(deps, method, { id, source: pushed.path }, timeoutMs)

  if (!result.ok) {
    await deps.ctx.exec(`rm -f ${shQuote(pushed.path)}`, { timeoutMs: 15_000 })
  }

  return result
}

/**
 * The one validation gate, run on the router. Nothing is written; the reply
 * carries findings whether or not they block. Deliberately not `unwrap`ed:
 * `ok: false` with findings is the useful answer, not an error.
 */
export function poolCheck(
  deps: AgentDeps,
  id: string,
  spec: PoolSpec
): Promise<AgentCallResult<PoolCheckReply>> {
  return specCall<PoolCheckReply>(deps, 'pool_check', id, spec, 60_000)
}

export async function poolCreate(
  deps: AgentDeps,
  id: string,
  spec: PoolSpec
): Promise<AgentCallResult<{ id: string; created: number }>> {
  return unwrap(
    await specCall<{ id: string; created: number }>(deps, 'pool_create', id, spec, MUTATE_TIMEOUT_MS)
  )
}

export interface PoolSetChange {
  added: number[]
  removed: number[]
  rewritten: number
}

export async function poolSet(
  deps: AgentDeps,
  id: string,
  spec: PoolSpec
): Promise<AgentCallResult<{ id: string; changed: PoolSetChange }>> {
  return unwrap(
    await specCall<{ id: string; changed: PoolSetChange }>(deps, 'pool_set', id, spec, MUTATE_TIMEOUT_MS)
  )
}

/** Remove a pool and everything it derived. Works on legacy pools too. */
export async function poolDelete(
  deps: AgentDeps,
  id: string,
  force = false
): Promise<AgentCallResult<{ id: string; removed: number; legacy?: boolean }>> {
  return unwrap(
    await call<{ id: string; removed: number; legacy?: boolean }>(
      deps,
      'pool_delete',
      { id, force },
      MUTATE_TIMEOUT_MS
    )
  )
}

/** up / down / redial / enable / disable, on sections the daemon owns. */
export async function poolAction(
  deps: AgentDeps,
  action: PoolActionName,
  sections: readonly string[]
): Promise<AgentCallResult<{ action: string; sections: string[] }>> {
  return unwrap(
    await call<{ action: string; sections: string[] }>(
      deps,
      'action',
      { action, sections: [...sections] },
      120_000
    )
  )
}

export async function poolSettingsGet(deps: AgentDeps): Promise<AgentCallResult<PoolSettings>> {
  return call<PoolSettings>(deps, 'settings_get')
}

export async function poolSettingsSet(
  deps: AgentDeps,
  values: Partial<PoolSettings>
): Promise<AgentCallResult<{ settings: PoolSettings }>> {
  return unwrap(await call<{ settings: PoolSettings }>(deps, 'settings_set', { ...values }))
}

/** Read netifd and the counters now. What Refresh presses. */
export async function poolReconcile(deps: AgentDeps): Promise<AgentCallResult> {
  return unwrap(await call(deps, 'reconcile', {}, 60_000))
}
