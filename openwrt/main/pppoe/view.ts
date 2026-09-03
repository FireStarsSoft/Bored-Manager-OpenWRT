/**
 * Everything a surface renders, and the one summary the module emits.
 *
 * Rows and pools come from the daemon's own answers, cached by `refreshCache`,
 * so a page repaints on every tick without an extra round trip - and so the
 * table never loses a row: the daemon builds rows from its record, and a
 * member whose section is missing arrives here already saying `unwritten`.
 */
import { hasPoolDaemon } from '../probe'
import { badge, BADGE, countBadges, statusBadges } from '../badges'
import { poolInfo, poolSessions, type PoolInfoEntry, type PoolRow } from '../agent'
import { agentDeps, emptyCache, type PppoeRuntime } from './runtime'
import type {
  PppoeDisplayRow,
  PppoeLegacyRow,
  PppoePoolRow,
  PppoeSnapshot
} from './types'

/** How old the cache may be before a view-triggered read refetches, ms. */
const CACHE_TTL_MS = 2_000

/**
 * `[0, 101, 102, 103, 200]` -> `"0,101-103,200"`: the multi-mode member text,
 * as the VLANs field takes it back.
 */
export function compressVlans(vlans: readonly number[]): string {
  const sorted = [...vlans].sort((a, b) => a - b)
  const parts: string[] = []
  for (let index = 0; index < sorted.length; index++) {
    let end = index
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++
    parts.push(end > index ? `${sorted[index]}-${sorted[end]}` : `${sorted[index]}`)
    index = end
  }
  return parts.join(',')
}

/** The member editor's prefill: VLAN ranges in multi, `vlan,user,` lines in single. */
function memberText(pool: PoolInfoEntry): string {
  if (pool.mode === 'multi') {
    return compressVlans(pool.memberList.map((member) => member.vlan))
  }
  // The password column is left empty on purpose: an empty password on an
  // existing VLAN means "keep the stored one", so this text can be edited and
  // resubmitted without retyping five hundred secrets.
  return pool.memberList.map((member) => `${member.vlan},${member.username},`).join('\n')
}

function keepaliveParts(keepalive: string): { failure: string; interval: string } {
  const match = keepalive.trim().match(/^([0-9]+)(?:[ ,]([0-9]+))?$/)
  if (!match) return { failure: '', interval: '' }
  return { failure: match[1] ?? '', interval: match[2] ?? '' }
}

function poolBadges(pool: PoolInfoEntry): PppoePoolRow['stateBadges'] {
  if (pool.members > 0 && pool.up === pool.members) return [badge('All up', BADGE.good)]
  const chips = countBadges([
    { label: 'error', count: pool.error, color: BADGE.bad },
    { label: 'unwritten', count: pool.unwritten, color: BADGE.missing },
    { label: 'dialing', count: pool.dialing, color: BADGE.busy },
    { label: 'up', count: pool.up, color: BADGE.good },
    { label: 'stopped', count: pool.stopped },
    { label: 'down', count: pool.down }
  ])
  return chips.length ? chips : [badge('empty')]
}

function poolRow(pool: PoolInfoEntry): PppoePoolRow {
  const keepalive = keepaliveParts(pool.keepalive ?? '')
  return {
    id: pool.id,
    label: pool.label,
    title: pool.label || pool.id,
    mode: pool.mode,
    modeLabel: pool.mode === 'multi' ? 'shared account' : (pool.carrier_mode === 'direct' ? 'per-slot accounts' : 'per-VLAN accounts'),
    prefix: pool.prefix,
    carrier: pool.carrier,
    carrier_mode: pool.carrier_mode === 'direct' ? 'direct' : 'vlan',
    carrierModeLabel: pool.carrier_mode === 'direct' ? 'direct' : 'VLAN',
    mac_mode: pool.mac_mode,
    account: pool.mode === 'multi' ? pool.username : 'one per VLAN',
    username: pool.username,
    table_base: pool.table_base,
    service: pool.service,
    ac: pool.ac,
    ac_mac: pool.ac_mac,
    mtu: pool.mtu ? String(pool.mtu) : '',
    keepalive_failure: keepalive.failure,
    keepalive_interval: keepalive.interval,
    ipv6: pool.ipv6,
    peerdns: pool.peerdns,
    dns: (pool.dns ?? []).join(' '),
    defaultroute: pool.defaultroute,
    host_uniq: pool.host_uniq,
    demand: pool.demand ? String(pool.demand) : '',
    padi_attempts: pool.padi_attempts ? String(pool.padi_attempts) : '',
    padi_timeout: pool.padi_timeout ? String(pool.padi_timeout) : '',
    pppd_options: pool.pppd_options,
    zone: pool.zone,
    masq: pool.masq,
    mtu_fix: pool.mtu_fix,
    lan_forward: pool.lan_forward,
    listText: memberText(pool),
    members: pool.members,
    up: pool.up,
    dialing: pool.dialing,
    down: pool.down,
    error: pool.error,
    stopped: pool.stopped,
    unwritten: pool.unwritten,
    stateBadges: poolBadges(pool),
    rxBps: Math.round(pool.rate?.rxBps ?? 0),
    txBps: Math.round(pool.rate?.txBps ?? 0),
    createdAt: pool.createdAt ? pool.createdAt * 1_000 : 0
  }
}

function displayRow(row: PoolRow, poolTitle: string, now: number): PppoeDisplayRow {
  return {
    name: row.section,
    poolId: row.pool,
    pool: poolTitle,
    vlan: row.vlan,
    device: row.device,
    username: row.username,
    mac: row.mac,
    status: row.status,
    statusBadges: statusBadges(row.status),
    errorCode: row.errorCode,
    ip: row.ip,
    table: row.table,
    upSince: row.status === 'up' && row.uptime > 0 ? now - row.uptime * 1_000 : 0,
    autostart: row.autostart,
    redials: row.redials,
    rxBps: Math.round(row.rxBps),
    txBps: Math.round(row.txBps)
  }
}

// ---------------------------------------------------------------------------
// The cache refresh.

/**
 * Fetch the daemon's answers, once, whatever the number of callers.
 *
 * Failure keeps the previous answers with `stale` set: a table that goes
 * blank because one poll failed is the single most alarming thing this page
 * could do, and it would be a lie - the pools are still there.
 */
export function refreshCache(runtime: PppoeRuntime, force = false): Promise<void> {
  if (runtime.fetching) return runtime.fetching
  if (!force && Date.now() - runtime.cache.fetchedAt < CACHE_TTL_MS) return Promise.resolve()

  const generation = runtime.generation

  const run = async (): Promise<void> => {
    if (!runtime.ctx.connected) {
      if (runtime.cache.fetchedAt) {
        runtime.cache.stale = true
        runtime.cache.error = 'The router is not connected.'
      }
      return
    }

    const capability = runtime.agent?.()
    if (!capability || !hasPoolDaemon(capability)) {
      // No daemon is not staleness: there is nothing to be stale about. The
      // readiness rows and the create form's own gate say what is missing.
      runtime.cache = emptyCache()
      return
    }

    const deps = agentDeps(runtime)
    const info = await poolInfo(deps)

    if (generation !== runtime.generation) return

    if (!info.ok || !info.data) {
      runtime.cache.stale = true
      runtime.cache.error = info.error ?? 'The router did not answer.'
      return
    }

    // A page of rows per pool, rather than one page for the router.
    //
    // The router's cap is per call: two pools of five hundred are a thousand
    // rows, and one call that stopped at five hundred used to leave the second
    // pool out entirely - with nothing in the reply saying which pool had been
    // cut off. Asked per pool, each one answers about itself and the totals
    // below are of the whole router rather than of whatever fitted.
    const rows: PoolRow[] = []
    const truncated: string[] = []
    let limit = runtime.cache.rowsLimit
    let blind: { since: number; failures: number } | null = null
    let failed = ''

    for (const pool of info.data.pools) {
      const page = await poolSessions(deps, pool.id, 'all', 0)

      if (generation !== runtime.generation) return

      if (!page.ok || !page.data) {
        failed = page.error ?? failed
        continue
      }

      for (const row of page.data.sessions) rows.push(row)

      limit = page.data.limit
      if (page.data.truncated) truncated.push(pool.id)
      if (page.data.blind) blind = page.data.blind
    }

    runtime.cache = {
      info: info.data,
      rows: failed && rows.length === 0 ? runtime.cache.rows : rows,
      rowsLimit: limit,
      truncated,
      blind,
      fetchedAt: Date.now(),
      stale: false,
      error: failed
    }
  }

  const fetching = run()
    .catch((error) => {
      if (generation !== runtime.generation) return
      runtime.cache.stale = true
      runtime.cache.error = error instanceof Error ? error.message : String(error)
    })
    .finally(() => {
      if (runtime.fetching === fetching) runtime.fetching = null
    })

  runtime.fetching = fetching
  return fetching
}

// ---------------------------------------------------------------------------
// What the surfaces read.

export function pools(runtime: PppoeRuntime): PppoePoolRow[] {
  return (runtime.cache.info?.pools ?? []).map(poolRow)
}

export function legacyRows(runtime: PppoeRuntime): PppoeLegacyRow[] {
  return (runtime.cache.info?.legacy ?? []).map((entry) => ({
    id: entry.id,
    prefix: entry.prefix,
    carrier: entry.carrier,
    count: entry.count,
    seqFrom: entry.seqFrom,
    seqTo: entry.seqTo
  }))
}

/**
 * Member rows for one pool - or, with no id, for every pool. `scope` narrows
 * on this side of the stream: `attention` is errors plus unwritten, `down` is
 * anything not up.
 */
export function rows(
  runtime: PppoeRuntime,
  poolIdRaw: unknown,
  scopeRaw?: unknown
): PppoeDisplayRow[] {
  const poolId = typeof poolIdRaw === 'string' ? poolIdRaw.trim() : ''
  const scope = typeof scopeRaw === 'string' ? scopeRaw : 'all'
  const now = Date.now()

  const titles = new Map<string, string>()
  for (const pool of runtime.cache.info?.pools ?? []) {
    titles.set(pool.id, pool.label || pool.id)
  }

  return runtime.cache.rows
    .filter((row) => !poolId || row.pool === poolId)
    .filter((row) => {
      if (scope === 'attention') return row.status === 'error' || row.status === 'unwritten'
      if (scope === 'up') return row.status === 'up'
      if (scope === 'down') return row.status !== 'up'
      return true
    })
    .map((row) => displayRow(row, titles.get(row.pool) ?? row.pool, now))
}

/** The member section names of one pool, for the per-pool bulk actions. */
export function poolSections(runtime: PppoeRuntime, poolId: string): string[] {
  return runtime.cache.rows
    .filter((row) => row.pool === poolId)
    .map((row) => row.section)
}

/**
 * The name ranges the fast sweep's router-side awk counts as the managed
 * pool. A v2 pool is its prefix over the whole VLAN space; a legacy pool
 * still carries the sequence range it was created with.
 */
export function managedRanges(
  runtime: PppoeRuntime
): Array<{ prefix: string; seqFrom: number; seqTo: number }> {
  const info = runtime.cache.info
  if (!info) return []
  return [
    ...info.pools.map((pool) => ({ prefix: pool.prefix, seqFrom: 0, seqTo: 4094 })),
    ...info.legacy.map((pool) => ({
      prefix: pool.prefix,
      seqFrom: pool.seqFrom,
      seqTo: pool.seqTo
    }))
  ]
}

export function snapshot(runtime: PppoeRuntime, now = Date.now()): PppoeSnapshot {
  const list = runtime.cache.info?.pools ?? []
  const sum = (read: (pool: (typeof list)[number]) => number): number =>
    list.reduce((total, pool) => total + read(pool), 0)

  const error = sum((pool) => pool.error)
  const unwritten = sum((pool) => pool.unwritten)

  runtime.latestPayload = {
    t: now,
    pools: list.length,
    interfaces: sum((pool) => pool.members),
    up: sum((pool) => pool.up),
    dialing: sum((pool) => pool.dialing),
    down: sum((pool) => pool.down),
    error,
    stopped: sum((pool) => pool.stopped),
    unwritten,
    attention: error + unwritten,
    legacyCount: runtime.cache.info?.legacy.length ?? 0,
    stale: runtime.cache.stale,
    notice: notice(runtime)
  }
  return runtime.latestPayload
}

/**
 * What is wrong with the rows, when something is and nothing else would say so.
 *
 * Both cases here look exactly like a healthy router from the table alone: a
 * pool whose rows were cut off shows fewer members than it has, and a router
 * whose netifd has gone quiet shows every row exactly as it was at the last
 * good pass - a session that dropped since still reading up, with the address
 * it had.
 */
function notice(runtime: PppoeRuntime): string {
  const parts: string[] = []
  const cut = runtime.cache.truncated

  if (cut.length === 1) {
    parts.push(
      `The router listed only the first ${runtime.cache.rowsLimit} members of pool ${cut[0]}; ` +
        'the rest are counted in its row and not listed below.'
    )
  } else if (cut.length > 1) {
    parts.push(
      `The router listed only the first ${runtime.cache.rowsLimit} members of ${cut.length} pools ` +
        `(${cut.join(', ')}); the rest are counted in their rows and not listed below.`
    )
  }

  const blind = runtime.cache.blind

  if (blind) {
    const seconds = Math.max(0, Math.round(Date.now() / 1000 - blind.since))
    parts.push(
      `The router is not answering about its own interfaces (for ${seconds}s, ` +
        `${blind.failures} attempt(s)). The states below are the last it saw, so a session ` +
        'that has dropped since would still read up here.'
    )
  }

  return parts.join(' ')
}

export function emitSummary(runtime: PppoeRuntime): void {
  runtime.ctx.emit('pppoe', snapshot(runtime))
}

/**
 * Called after FastSweep replaced its model cache: refresh from the daemon in
 * the background and emit when it lands. The emit below goes out immediately
 * as well, so a `stale` flip is never held back by a fetch that hangs.
 */
export function onSample(runtime: PppoeRuntime): void {
  void refreshCache(runtime).then(() => emitSummary(runtime))
  emitSummary(runtime)
}
