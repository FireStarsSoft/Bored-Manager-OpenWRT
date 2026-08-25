/**
 * Everything a surface renders, and the one summary the module emits.
 *
 * Nothing here talks to the router. Rows are built from the batch records plus
 * whatever the last sample left in the model cache, which is what lets a page
 * repaint on every tick without a single extra SSH round trip - and what makes
 * `missing` meaningful: a record with no interface behind it in a sample that
 * did list interfaces.
 */
import type { ValueBadge } from '@shared/module-ui'
import { BADGE, badge, countBadges, statusBadges } from '../badges'
import { pppoeSectionName } from '../uci'
import type { IfaceState, RouterModel } from '../types'
import { ifaceIndex } from '../util'
import { batchSequences } from './names'
import { clearRowCache, currentModel, type PppoeRowKey, type PppoeRuntime } from './runtime'
import type {
  PppoeBatchSummary,
  PppoeDisplayRow,
  PppoeRow,
  PppoeSnapshot,
  PppoeStatus
} from './types'

/**
 * How long a session may sit in `dialing` before it is called a failure.
 *
 * `dialing` is the catch-all of `statusFor`: netifd lists the section, it is
 * not up, nothing is pending and no error code reached us. That is what a
 * session dialing right now looks like - and also what one whose pppd has been
 * retrying PADO for a week looks like, because netifd stops reporting an error
 * for it. Without a clock the row stayed a green chip forever, the batch
 * summary counted it as busy rather than broken, and the watchdog - which only
 * redials `error` rows - never touched it.
 *
 * Five minutes is far past any real PPPoE negotiation and past the inter-chunk
 * delays of the largest create this module will run.
 */
const DIALING_TIMEOUT_MS = 5 * 60_000

/** The code a session that never finished dialing is reported under. */
export const DIAL_TIMEOUT_CODE = 'DIAL_TIMEOUT'

type PppoeStatusCounts = Record<PppoeStatus, number>

/**
 * One object rather than a fresh `{}` per call: the row cache keys on the
 * identity of these two snapshots, and a service that supplies neither - a unit
 * test, or the module before its first slow sweep - would otherwise present a
 * different pair of inputs on every single call and never be cached against.
 */
const NO_STRINGS: Readonly<Record<string, string>> = {}

/**
 * `hasIfaces` says whether the current model carries an interface list at all.
 * Without it there is no way to tell an interface the router does not have
 * from one nobody has looked for yet, and every row would read `missing` for
 * the first tick after a connect - or, before this returned `unknown`,
 * `stopped`, which is the word a deliberate Stop produces and therefore a
 * claim about a router nothing has read yet.
 */
function statusFor(
  name: string,
  iface: IfaceState | undefined,
  externalError: string | undefined,
  manuallyStopped: ReadonlySet<string>,
  hasIfaces: boolean
): { status: PppoeStatus; error: string } {
  if (manuallyStopped.has(name)) return { status: 'stopped', error: '' }
  if (iface?.up && iface.ipv4?.addr) return { status: 'up', error: '' }
  const error = externalError || iface?.errorCode || ''
  if (error) return { status: 'error', error }
  if (iface?.pending) return { status: 'dialing', error: '' }
  if (!iface) return { status: hasIfaces ? 'missing' : 'unknown', error: '' }
  if (iface.autostart === false) return { status: 'stopped', error: '' }
  return { status: 'dialing', error: '' }
}

/**
 * The clock `dialing` did not have.
 *
 * The first sighting starts it and anything else clears it, so a session that
 * dials, drops and dials again gets the full window each time rather than
 * inheriting the age of an attempt that already failed.
 */
function withDialingClock(
  runtime: PppoeRuntime,
  name: string,
  state: { status: PppoeStatus; error: string },
  now: number
): { status: PppoeStatus; error: string } {
  if (state.status !== 'dialing') {
    runtime.dialingSince.delete(name)
    return state
  }
  const since = runtime.dialingSince.get(name)
  if (since === undefined) {
    runtime.dialingSince.set(name, now)
    return state
  }
  if (now - since < DIALING_TIMEOUT_MS) return state
  return { status: 'error', error: DIAL_TIMEOUT_CODE }
}

function displayRow(row: PppoeRow): PppoeDisplayRow {
  return {
    name: row.name,
    batch: row.batch,
    username: row.username,
    status: row.status,
    statusBadges: statusBadges(row.status),
    errorCode: row.errorCode,
    ip: row.ip,
    upSince: row.upSince
  }
}

/**
 * A batch in one glance. The healthy case collapses to a single chip on
 * purpose: a page listing twenty batches is unreadable if each one spells out
 * five counts, and the counts that matter are the ones that are not zero.
 */
function batchStateBadges(count: number, counts: PppoeStatusCounts): ValueBadge[] {
  if (count > 0 && counts.up === count) return [badge('All up', BADGE.good)]
  const chips = countBadges([
    { label: 'error', count: counts.error, color: BADGE.bad },
    { label: 'missing', count: counts.missing, color: BADGE.missing },
    { label: 'dialing', count: counts.dialing, color: BADGE.busy },
    { label: 'up', count: counts.up, color: BADGE.good },
    { label: 'stopped', count: counts.stopped },
    // Uncoloured on purpose: nothing is known yet, which is neither healthy
    // nor wrong. `statusBadges` gives the row chip the same neutral treatment.
    { label: 'unknown', count: counts.unknown }
  ])
  return chips.length ? chips : [badge('empty')]
}

function sameRowKey(left: PppoeRowKey, right: PppoeRowKey): boolean {
  return (
    left.model === right.model &&
    left.t === right.t &&
    // NaN, from a store that cannot report a revision, never equals itself, so
    // such a store is simply never cached against.
    left.revision === right.revision &&
    left.errors === right.errors &&
    left.users === right.users &&
    left.stopped === right.stopped
  )
}

/**
 * Every managed session, by batch, from the last sample and the batch records.
 *
 * Rebuilt at most once per set of inputs; see `PppoeRowCache` for why, and for
 * the one input - the dialing clock - that is time rather than state and so is
 * carried as a window rather than a key.
 */
export function rowsByBatch(runtime: PppoeRuntime, now = Date.now()): Map<string, PppoeRow[]> {
  const model = currentModel(runtime)
  const externalErrors = runtime.service.pppoeErrors?.() ?? NO_STRINGS
  const externalUsers = runtime.service.pppoeUsers?.() ?? NO_STRINGS
  const key: PppoeRowKey = {
    model,
    t: model?.t ?? 0,
    revision: runtime.store.revision?.() ?? Number.NaN,
    errors: externalErrors,
    users: externalUsers,
    stopped: runtime.manuallyStopped.size
  }
  const cached = runtime.rowCache
  if (
    cached &&
    now >= cached.builtAt &&
    now < cached.nextChangeAt &&
    sameRowKey(cached.key, key)
  ) {
    return cached.rows
  }

  const ifaces = ifaceIndex(model)
  const hasIfaces = ifaces.size > 0
  const out = new Map<string, PppoeRow[]>()
  let nextChangeAt = Number.POSITIVE_INFINITY

  for (const batch of runtime.store.read().batches) {
    const rows: PppoeRow[] = []
    for (const seq of batchSequences(batch)) {
      const name = pppoeSectionName(batch.prefix, seq)
      const iface = ifaces.get(name)
      const state = withDialingClock(
        runtime,
        name,
        statusFor(name, iface, externalErrors[name], runtime.manuallyStopped, hasIfaces),
        now
      )
      // A session still inside its dialing window is the only row whose answer
      // changes without an input changing, and it changes at a moment that is
      // already known. The earliest of those is how long these rows are good
      // for; one that has already timed out reads `error` from here on and
      // constrains nothing.
      if (state.status === 'dialing') {
        const since = runtime.dialingSince.get(name)
        if (since !== undefined) nextChangeAt = Math.min(nextChangeAt, since + DIALING_TIMEOUT_MS)
      }
      const extended = iface as (IfaceState & { username?: unknown; user?: unknown }) | undefined
      const cachedUser =
        typeof extended?.username === 'string'
          ? extended.username
          : typeof extended?.user === 'string'
            ? extended.user
            : externalUsers[name] ?? runtime.usernames.get(name) ?? ''
      rows.push({
        id: name,
        name,
        batchId: batch.id,
        batch: batch.name,
        username: cachedUser,
        status: state.status,
        errorCode: state.error,
        ip: iface?.ipv4?.addr ?? '',
        // Only a session that is actually up gets a start time to count from;
        // a stale `uptimeSec` on an interface that dropped would otherwise
        // render as a session that has been up for hours.
        upSince:
          state.status === 'up' && model && iface?.uptimeSec
            ? model.t - Math.floor(iface.uptimeSec) * 1_000
            : 0
      })
    }
    out.set(batch.id, rows)
  }
  runtime.rowCache = { key, rows: out, builtAt: now, nextChangeAt }
  return out
}

export function batches(runtime: PppoeRuntime, now = Date.now()): PppoeBatchSummary[] {
  const rows = rowsByBatch(runtime, now)
  return runtime.store.read().batches.map((batch) => {
    const counts: PppoeStatusCounts = {
      up: 0,
      dialing: 0,
      error: 0,
      stopped: 0,
      missing: 0,
      unknown: 0
    }
    for (const row of rows.get(batch.id) ?? []) counts[row.status] += 1
    return {
      id: batch.id,
      name: batch.name,
      carrier: batch.carrier,
      prefix: batch.prefix,
      ...(batch.vlan === undefined ? {} : { vlan: batch.vlan }),
      count: batch.count,
      ...counts,
      stateBadges: batchStateBadges(batch.count, counts),
      createdAt: batch.createdAt
    }
  })
}

/**
 * The scope a batch drawer asks for when it is showing its "Needs attention"
 * tab rather than the whole list. A 5,000-account batch is about a megabyte of
 * rows and the drawer re-polls on the fast interval for as long as it is open,
 * so the narrow tab has to be narrow before the rows leave this file.
 */
const ATTENTION = 'attention'

/** Failed, or configured here and absent from the router. See `PppoeStatus`. */
function needsAttention(row: PppoeRow): boolean {
  return row.status === 'error' || row.status === 'missing'
}

export function rows(
  runtime: PppoeRuntime,
  batchIdRaw: unknown,
  scopeRaw?: unknown
): PppoeDisplayRow[] {
  const id = typeof batchIdRaw === 'string' ? batchIdRaw : ''
  const byBatch = rowsByBatch(runtime)
  const all =
    id === 'errors'
      ? [...byBatch.values()].flat().filter((row) => row.status === 'error')
      : byBatch.get(id) ?? []
  return (scopeRaw === ATTENTION ? all.filter(needsAttention) : all).map(displayRow)
}

/**
 * Every session worth acting on, across all batches: the ones that failed and
 * the ones the router has no interface for. The page used to ask for these
 * with `pppoeRows("errors")`, a magic batch id that no batch could ever have
 * and that silently returned nothing if it were mistyped.
 */
export function attentionRows(runtime: PppoeRuntime): PppoeDisplayRow[] {
  return [...rowsByBatch(runtime).values()].flat().filter(needsAttention).map(displayRow)
}

export function snapshot(runtime: PppoeRuntime, now = Date.now()): PppoeSnapshot {
  const summaries = batches(runtime, now)
  const error = summaries.reduce((sum, batch) => sum + batch.error, 0)
  const missing = summaries.reduce((sum, batch) => sum + batch.missing, 0)
  runtime.latestPayload = {
    t: now,
    batchCount: summaries.length,
    total: summaries.reduce((sum, batch) => sum + batch.count, 0),
    up: summaries.reduce((sum, batch) => sum + batch.up, 0),
    dialing: summaries.reduce((sum, batch) => sum + batch.dialing, 0),
    error,
    stopped: summaries.reduce((sum, batch) => sum + batch.stopped, 0),
    missing,
    unknown: summaries.reduce((sum, batch) => sum + batch.unknown, 0),
    attention: error + missing
  }
  return runtime.latestPayload
}

export function emitSummary(runtime: PppoeRuntime): void {
  const payload = snapshot(runtime)
  runtime.ctx.emit('pppoe', payload)
}

/** Called after FastSweep has replaced its model cache. */
export function onSample(runtime: PppoeRuntime, model?: RouterModel): void {
  if (model) runtime.sample = model
  pruneManualStops(runtime)
  // The sample the rows were built from is gone, so nothing built from it may
  // outlive this line - `emitSummary` below is the first of the tick's readers.
  clearRowCache(runtime)
  emitSummary(runtime)
}

function pruneManualStops(runtime: PppoeRuntime): void {
  const ifaces = ifaceIndex(currentModel(runtime))
  for (const name of runtime.manuallyStopped) {
    if (ifaces.get(name)?.up) runtime.manuallyStopped.delete(name)
  }
}
