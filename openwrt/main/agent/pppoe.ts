/**
 * Driving `bm-pppoe-pool`, when this router has it.
 *
 * One thing here is unlike anything else in this folder: the account list.
 *
 * Every other call sends its arguments as a JSON document on a `ubus -S call`
 * command line, which is fine for a MAC address and unacceptable for a
 * password - `/proc/<pid>/cmdline` is world-readable, so anything on that line
 * is readable by every process on the router for as long as the call runs. So
 * the accounts go to a file instead: `mktemp` makes it, `umask 077` means only
 * root can read it, the payload arrives on stdin, and the ubus call carries
 * nothing but the path. The daemon reads it and unlinks it before writing a
 * single section.
 *
 * The result is that a password is never an argument to anything, on either
 * side of the connection. It is the same invariant the SSH path already keeps -
 * see `pppoe/create.ts` - reached by the same means.
 *
 * Nothing here is required. A router without the package answers every call
 * with one sentence saying so, and the caller falls back to the chunked UCI
 * path that has been there since 2.0.0.
 */
import { shQuote } from '@shared/shell'
import { objectCall, PPPOE_OBJECT, unwrap, type AgentCallResult, type AgentDeps } from './client'

/** Writing a pool of thousands and reloading netifd is minutes, not seconds. */
const CREATE_TIMEOUT_MS = 600_000

/** Reading a lease-sized reply is fast; a pool delete rewrites config. */
const DELETE_TIMEOUT_MS = 300_000

/** One pool, as the router reports it. */
export interface PoolSummary {
  id: string
  prefix: string
  carrier: string
  count: number
  known: number
  up: number
  dialing: number
  down: number
  error: number
  redials: number
  rate: { rxBps: number; txBps: number }
}

export interface PoolInfo {
  name: string
  release: string
  apiVersion: number
  enabled: boolean
  counterInterval: number
  redialAfter: number
  uptime: number
  pools: PoolSummary[]
}

export interface PoolSession {
  pool: string
  section: string
  seq: number
  state: 'up' | 'dialing' | 'down' | 'error' | 'unknown'
  ipv4: string
  table: number | null
  since: number
  downSince: number
  error: string
}

/** One account, as it is written into the payload file and nowhere else. */
export interface PoolAccount {
  user: string
  pass: string
  vlan?: number
}

export interface PoolPlan {
  id: string
  prefix: string
  carrier: string
  seqFrom: number
  tableBase: number
  vlan?: number
}

/**
 * The name the router knows a batch by.
 *
 * A pool id has to be lower case letters, digits and underscores; this
 * module's batch ids are opaque strings it generated. `bm` plus the id with
 * everything else removed is stable, collision-free for the ids this module
 * makes, and recognisable in `uci show bm_pppoe`.
 */
export function routerPoolId(batchId: string): string {
  return `bm${batchId.toLowerCase().replace(/[^a-z0-9_]/g, '')}`
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

/**
 * Session rows. `scope` defaults to what needs attention on the router side,
 * which is the same default the module's own table opens on and for the same
 * reason: five thousand rows of "up" is not something anybody reads.
 */
export function poolSessions(
  deps: AgentDeps,
  id = '',
  scope: 'attention' | 'up' | 'down' | 'all' = 'attention'
): Promise<AgentCallResult<{ sessions: PoolSession[]; limit: number }>> {
  return call<{ sessions: PoolSession[]; limit: number }>(deps, 'sessions', { id, scope })
}

/** Start, stop or redial named sessions. Only ones the router says it owns. */
export async function poolAction(
  deps: AgentDeps,
  action: 'up' | 'down' | 'redial',
  sections: readonly string[]
): Promise<AgentCallResult> {
  return unwrap(await call(deps, 'action', { action, sections: [...sections] }))
}

/**
 * Make a `0600` file on the router and put the payload in it.
 *
 * `mktemp` rather than a name this module composed: a guessable path under
 * /tmp can be pre-created as a symlink by anything else on the router and
 * turned into a write somewhere else entirely (CWE-377). `umask 077` before
 * the redirect, not `chmod` after it, because a chmod leaves a window in which
 * the file exists and is readable.
 *
 * Returns the path, or null. The caller must not retry with a path of its own.
 */
async function pushPayload(
  deps: AgentDeps,
  payload: string
): Promise<{ path: string | null; error: string | null }> {
  const made = await deps.ctx.exec('umask 077; mktemp /tmp/bm-pool.XXXXXX', { timeoutMs: 15_000 })
  const path = (made.stdout || '').trim()

  if (made.code !== 0 || !/^\/tmp\/bm-pool\.[A-Za-z0-9]{6}$/.test(path)) {
    return { path: null, error: 'Could not make a temporary file on the router for the accounts.' }
  }

  // The payload goes on stdin, never as an argument. It is the whole point.
  const written = await deps.ctx.exec(`umask 077; cat > ${shQuote(path)}`, {
    stdin: payload,
    timeoutMs: 120_000
  })

  if (written.code !== 0) {
    // Best effort, and unchecked: the file is 0600 in tmpfs and the daemon
    // unlinks it when it reads it, so the worst case is a file that disappears
    // at the next reboot. Failing the create because the cleanup failed would
    // report the wrong problem.
    await deps.ctx.exec(`rm -f ${shQuote(path)}`, { timeoutMs: 15_000 })
    return { path: null, error: 'The account list could not be written to the router.' }
  }

  return { path, error: null }
}

/**
 * Create a pool.
 *
 * The accounts never touch a command line on either side, and never touch this
 * module's own store or event log either - `plan` is what is remembered, and it
 * holds no credential at all.
 */
export async function poolCreate(
  deps: AgentDeps,
  plan: PoolPlan,
  accounts: readonly PoolAccount[]
): Promise<AgentCallResult<{ id: string; created: number; seqFrom: number; seqTo: number }>> {
  if (!accounts.length) {
    return { ok: false, data: null, error: 'There are no accounts to create.' }
  }

  const payload = JSON.stringify({
    prefix: plan.prefix,
    carrier: plan.carrier,
    seqFrom: plan.seqFrom,
    tableBase: plan.tableBase,
    ...(plan.vlan === undefined ? {} : { vlan: plan.vlan }),
    accounts: accounts.map((one) => ({
      user: one.user,
      pass: one.pass,
      ...(one.vlan === undefined ? {} : { vlan: one.vlan })
    }))
  })

  const pushed = await pushPayload(deps, payload)
  if (!pushed.path) {
    return { ok: false, data: null, error: pushed.error }
  }

  const result = await call<{ id: string; created: number; seqFrom: number; seqTo: number }>(
    deps,
    'pool_create',
    { id: plan.id, source: pushed.path },
    CREATE_TIMEOUT_MS
  )

  // The daemon unlinks the file as it reads it, so this only ever matters when
  // the call never reached it - a disconnection, a package removed between the
  // two steps. An account list left readable in tmpfs is not something to leave
  // to chance.
  if (!result.ok) {
    await deps.ctx.exec(`rm -f ${shQuote(pushed.path)}`, { timeoutMs: 15_000 })
  }

  return unwrap(result)
}

/** Remove a pool and every section it owns. */
export async function poolDelete(
  deps: AgentDeps,
  id: string
): Promise<AgentCallResult<{ id: string; removed: number }>> {
  return unwrap(
    await call<{ id: string; removed: number }>(deps, 'pool_delete', { id }, DELETE_TIMEOUT_MS)
  )
}

/** Read netifd and the counters now. What Refresh presses. */
export async function poolReconcile(deps: AgentDeps): Promise<AgentCallResult> {
  return unwrap(await call(deps, 'reconcile', {}, 60_000))
}
