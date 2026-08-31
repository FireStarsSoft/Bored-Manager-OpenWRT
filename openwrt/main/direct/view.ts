/**
 * Everything a surface renders for Binding 1-1: one row per binding, and the
 * snapshot pushed on the `direct` stream.
 *
 * Nothing here decides anything. `buildRow` is pure and is called from both
 * sides - the planner builds its rows with it during a pass, and the engine
 * builds them again for a plain read between passes - because two row builders
 * is how a rename shows in one table and not in the other.
 */
import type { ValueBadge } from '@shared/module-ui'
import { BADGE, badge, statusBadges } from '../badges'
import type { DirectBindingRecord } from '../store'
import type { RouterModel } from '../types'
import { leaseAddresses, resolveTarget, targetLabel } from './target'
import type {
  DirectMemoryEntry,
  DirectRow,
  DirectRuntime,
  DirectState,
  DirectTotals
} from './types'

/**
 * The instance half has this arithmetic too, on a function its barrel does not
 * publish - and reaching past a barrel is what the size gate refuses. Eight
 * lines copied is the cheaper of the two answers.
 */
export function durationLabel(msRaw: number): string {
  const seconds = Math.max(0, Math.floor(msRaw / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

/**
 * What a state means, in chips.
 *
 * `held` gets two of them on purpose. One word cannot carry both halves of what
 * hold does, and the half that matters to whoever is looking at the row is the
 * second: the address is not slow or degraded, it has no way out at all until
 * its WAN comes back.
 */
function stateBadges(state: DirectState, shadowedBy: string): ValueBadge[] {
  if (state === 'bound') return statusBadges('bound')
  if (state === 'held') return [...statusBadges('held'), badge('no way out', BADGE.bad)]
  if (state === 'fallback') {
    // "default connection" alone read as though the binding had simply been
    // taken off the router. It has a rule, pointing at the main table, and that
    // rule is the whole reason the address reaches the default connection
    // rather than an instance catch-all - so the chip names it.
    return [badge('WAN down', BADGE.bad), badge('on the main table', BADGE.warn)]
  }
  if (state === 'stranded') {
    return [badge('moved off its LAN', BADGE.bad), badge('no firewall path', BADGE.bad)]
  }
  if (state === 'shadowed') {
    // The second chip names the binding rather than saying "another binding",
    // because the row this one is shadowed by is the only thing that can be
    // edited or deleted to resolve it, and a table of two identical addresses
    // gives no clue which of them is the one in force.
    return [
      badge('not in force', BADGE.bad),
      badge(shadowedBy ? `held by ${shadowedBy}` : 'address already bound', BADGE.warn)
    ]
  }
  if (state === 'waiting') return statusBadges('waiting')
  return [badge('disabled')]
}

/**
 * The rule this binding should be holding, written the way it is written on the
 * router so a person can compare the two by eye.
 */
function ruleLine(
  record: DirectBindingRecord,
  entry: DirectMemoryEntry | undefined,
  catchAllTable: number
): string {
  if (!entry?.ip) return ''
  const table = installedTable(record, entry.state, catchAllTable)
  return table ? `from ${entry.ip}/32 lookup ${table} pref ${record.pref}` : ''
}

/**
 * Which table the rule for this state points at, spelled the way `ip rule show`
 * spells it - so `main` as the word, because that is what the router prints for
 * table 254 and this cell exists to be compared with it by eye.
 *
 * Neither of the down states is a binding without a rule. Held has one pointing
 * at the blackhole; fallback has one pointing at main, and the empty cell it
 * used to get read as "nothing is installed" - which is precisely the reading
 * that let a fallback binding look harmless while it was, in fact, being
 * swallowed by an instance's catch-all. The mapping is this file's own rather
 * than the planner's because only one of the two renders a name instead of a
 * number.
 *
 * `shadowed` is the state where the empty cell is the truth: another binding
 * holds this address at a lower preference and this one writes nothing at all,
 * which is exactly what its chips say.
 */
function installedTable(
  record: DirectBindingRecord,
  state: DirectState,
  catchAllTable: number
): string {
  if (state === 'bound') return String(record.table)
  if (state === 'held' || (state === 'stranded' && record.whenDown === 'hold')) {
    return String(catchAllTable)
  }
  if (state === 'fallback' || (state === 'stranded' && record.whenDown === 'fallback')) {
    return 'main'
  }
  return ''
}

export function buildRow(
  record: DirectBindingRecord,
  entry: DirectMemoryEntry | undefined,
  now: number,
  catchAllTable: number
): DirectRow {
  const state: DirectState = entry?.state ?? (record.enabled ? 'waiting' : 'disabled')
  return {
    id: record.id,
    name: record.name,
    targetKind: record.target.kind,
    target: targetLabel(record.target),
    address: entry?.ip ?? (record.target.kind === 'ip' ? record.target.ip : ''),
    wan: record.wan,
    table: record.table,
    pref: record.pref,
    whenDown: record.whenDown,
    enabled: record.enabled,
    state,
    stateBadges: stateBadges(state, entry?.shadowedBy ?? ''),
    since: entry?.since ?? 0,
    sinceLabel: entry?.since ? durationLabel(now - entry.since) : '',
    rule: ruleLine(record, entry, catchAllTable)
  }
}

export function countTotals(rows: readonly DirectRow[]): DirectTotals {
  return {
    ok: rows.filter((row) => row.state === 'bound').length,
    held: rows.filter((row) => row.state === 'held').length
  }
}

// ---------------------------------------------------------------- engine side

export function directRows(runtime: DirectRuntime): DirectRow[] {
  const catchAllTable = runtime.options.rules().catchAllTable
  const now = Date.now()
  return runtime.store
    .read()
    .direct.map((record) => buildRow(record, runtime.memory.get(record.id), now, catchAllTable))
}

/**
 * The addresses the instance planner must leave alone.
 *
 * Enabled bindings only. A held or fallen-back binding still reserves its
 * address - the instance half handing it a pool WAN while the one-to-one rule
 * is merely parked would be two rules for one device, one of which nobody asked
 * for. A *disabled* binding reserves nothing, because being switched off is
 * exactly the statement that this address is not spoken for.
 *
 * The sample's leases are not the whole answer, though they look like it.
 * `resolveTarget` returns '' the instant a MAC's lease disappears, while the
 * pass keeps that binding's rule installed at the last address it was seen at
 * for `releaseGraceSec` - five minutes by default. For those five minutes the
 * instance planner was being told the address was free while a 1-1 rule for it
 * stood on the router, so a lease dnsmasq re-issued in that window put a
 * completely different device on the bound WAN with nothing on any page to say
 * so. Unioning in what the last pass actually wrote a rule for makes the two
 * agree: an address is reserved for exactly as long as a rule for it stands.
 */
export function reservedIps(runtime: DirectRuntime, model: RouterModel): string[] {
  const leaseByMac = leaseAddresses(model.leases)
  const addresses = new Set<string>()
  for (const record of runtime.store.read().direct) {
    if (!record.enabled) continue
    const ip = resolveTarget(record.target, leaseByMac)
    if (ip) addresses.add(ip)
    const installed = runtime.memory.get(record.id)?.ip ?? ''
    if (installed) addresses.add(installed)
  }
  return [...addresses]
}

/**
 * Push the rows every surface renders. `error` is the message of a pass that
 * failed; the rows still go out - a page with nothing on it says less than
 * stale rows that admit they are stale - but they keep the timestamp of the
 * last pass that actually reached the router, and carry what went wrong so a
 * surface can say it.
 */
export function emitSnapshot(
  runtime: DirectRuntime,
  t: number,
  error: string | null = null
): void {
  if (runtime.disposed) return
  const rows = directRows(runtime)
  runtime.latestPayload = {
    t: error == null ? t : runtime.latestPayload.t,
    hookOk: error == null,
    lastError: error ?? '',
    rows,
    totals: { ...countTotals(rows), total: rows.length }
  }
  runtime.ctx.emit('direct', runtime.latestPayload)
}

/**
 * Re-push the rows after something that changed them without going near the
 * router. It claims neither a new sample nor a new verdict: a rename must not
 * make a pass that is still failing look like it recovered.
 */
export function republishSnapshot(runtime: DirectRuntime): void {
  emitSnapshot(
    runtime,
    runtime.latestPayload.t,
    runtime.latestPayload.hookOk ? null : runtime.latestPayload.lastError
  )
}
