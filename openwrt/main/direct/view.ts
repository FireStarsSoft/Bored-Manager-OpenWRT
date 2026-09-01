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
import type { WanbindBinding } from '../agent'
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
 * Each of the four states that means something is wrong gets two of them, and
 * the pair always has the same shape: the first names the condition, the second
 * names where the address actually comes out. One word cannot carry both halves
 * of what hold does, and the half that matters to whoever is looking at the row
 * is the second: the address is not slow or degraded, it has no way out at all
 * until its WAN comes back.
 *
 * `stranded` is the state where that second chip has to be asked rather than
 * assumed. The two `When that WAN is down` answers send a stranded binding to
 * opposite ends of the router - parked on the blackhole with the device off the
 * internet, or re-pointed at main and out through the router's ordinary WAN -
 * and this row used to print the same two alarming chips for both. So the
 * binding quietly leaking past the metered line it had been pinned to looked
 * identical, at a glance, to the one that had been switched off, which is the
 * whole failure the stranded wording exists to prevent. It asks `onCatchAll`
 * and then borrows the very words `held` and `fallback` already use, so the
 * page has one vocabulary for one condition rather than two.
 */
function stateBadges(state: DirectState, whenDown: string, shadowedBy: string): ValueBadge[] {
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
    // The second chip used to read "no firewall path", which is true of both
    // halves - the forwarding this binding was stamped with really is gone
    // either way - and therefore says nothing about the only difference that
    // matters to the person reading the row.
    return [
      badge('moved off its LAN', BADGE.bad),
      onCatchAll(state, whenDown)
        ? badge('no way out', BADGE.bad)
        : badge('on the main table', BADGE.warn)
    ]
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
  if (state === 'refused') {
    // The pair again, and the second chip is the one that matters: a section
    // the daemon would not accept installs nothing at all, so the address is
    // wherever it would have been with no binding in the file. A single red
    // chip would have read as "broken and detained", which is the opposite of
    // what has happened to the traffic.
    return [badge('the router refused it', BADGE.bad), badge('no rule written', BADGE.warn)]
  }
  if (state === 'waiting') return statusBadges('waiting')
  return [badge('disabled')]
}

/**
 * The two `When that WAN is down` choices, worded exactly as the select on the
 * create form and on the row's own edit form words them.
 *
 * The column used to print the stored value, and `fallback` is also the word
 * the State chips use for a binding whose WAN is down right now - so one table
 * carried the same word for a setting and for a condition, and a row reading
 * "fallback / fallback" said nothing at all. Naming the option the user picked
 * is the house rule anyway; this is the map that keeps the row and the two
 * selects saying the same eleven words.
 */
const WHEN_DOWN_LABELS: Readonly<Record<string, string>> = {
  hold: 'Keep it off the internet',
  fallback: 'Let it use the default connection'
}

/**
 * Whether the rule this binding is written to carry points at the blackhole -
 * the catch-all table with nothing but an unreachable default in it.
 *
 * `held` is the obvious half. The other is a `stranded` binding whose owner
 * chose to park it: the device has walked off the LAN its firewall forwarding
 * was written from, and the pass writes it exactly the rule a hold writes, so
 * the address has precisely as little way out. All three callers ask this one
 * question rather than each spelling the pair out, because the row's Table
 * cell, the row's own State chips and the Overview tile disagreeing about the
 * same binding is what let a detained device be reported as nothing at all.
 */
function onCatchAll(state: DirectState, whenDown: string): boolean {
  return state === 'held' || (state === 'stranded' && whenDown === 'hold')
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
  if (onCatchAll(state, record.whenDown)) return String(catchAllTable)
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
    // Empty on this half, and that is the whole answer rather than a gap: a
    // binding this module wrote has its state chips and its rule to explain
    // itself, and nothing refused it on the way in. The column exists for the
    // rows a router refused, which only the router-owned half produces.
    reason: '',
    targetKind: record.target.kind,
    target: targetLabel(record.target),
    address: entry?.ip ?? (record.target.kind === 'ip' ? record.target.ip : ''),
    wan: record.wan,
    table: record.table,
    pref: record.pref,
    whenDown: record.whenDown,
    whenDownLabel: WHEN_DOWN_LABELS[record.whenDown] ?? record.whenDown,
    enabled: record.enabled,
    state,
    stateBadges: stateBadges(state, record.whenDown, entry?.shadowedBy ?? ''),
    since: entry?.since ?? 0,
    sinceLabel: entry?.since ? durationLabel(now - entry.since) : '',
    rule: ruleLine(record, entry, catchAllTable)
  }
}

/**
 * The same row, built from what the router says instead of from a record.
 *
 * It is here, beside `buildRow`, for the reason `buildRow` is called from both
 * sides: one row builder, so a column cannot come to mean two things depending
 * on which half answered. The columns are deliberately mapped to the same
 * meanings rather than to the nearest-looking field -
 *
 * - `table` is the binding's **stamped** table, as the record's is, because the
 *   column is "which table this binding was written for". The table its rule
 *   points at *now* goes into `rule`, which is the cell that exists to be
 *   compared with `ip rule show` by eye - and on this half the two can differ,
 *   because the daemon re-points a WAN that changed table and this module never
 *   could.
 * - `since` arrives in seconds on the router's clock and is multiplied here.
 *   Passed through raw it reported every binding as bound since 1970, which is
 *   the same mistake `binding/router.ts` documents one folder away.
 * - a state the daemon has not reached yet is empty, and is read exactly as
 *   `buildRow` reads an absent memory entry: waiting when it is switched on,
 *   disabled when it is not. A section written a second ago is genuinely
 *   waiting, and inventing a third word for it would only mean the two halves
 *   describe one condition differently.
 */
export function buildRouterRow(binding: WanbindBinding, now: number): DirectRow {
  const state: DirectState = binding.state
    ? (binding.state as DirectState)
    : binding.enabled
      ? 'waiting'
      : 'disabled'
  const since = binding.since > 0 ? binding.since * 1000 : 0
  return {
    id: binding.id,
    // The daemon falls back to the section name itself, so this is belt and
    // braces - but an empty Name column is unreadable and a row nobody can
    // point at is not something to leave to another program's defaults.
    name: binding.name || binding.id,
    targetKind: binding.targetKind,
    target: binding.label,
    address: binding.ip,
    wan: binding.wan,
    table: binding.stampedTable || binding.wanTable,
    pref: binding.pref,
    whenDown: binding.whenDown,
    whenDownLabel: WHEN_DOWN_LABELS[binding.whenDown] ?? binding.whenDown,
    enabled: binding.enabled,
    state,
    stateBadges: stateBadges(state, binding.whenDown, binding.shadowedBy),
    since,
    sinceLabel: since ? durationLabel(now - since) : '',
    rule: routerRuleLine(binding),
    reason: binding.reason,
    routerOwned: true
  }
}

/**
 * A binding this module still has a record of, on a router that owns bindings
 * and has not taken this one over.
 *
 * It exists so that such a binding appears at all. The rows on that half come
 * from the router's list, and a record the router refused - or never received,
 * because the call itself was refused - is in neither list; without this the
 * operator's own binding would vanish from the page with nothing to click and
 * nothing to read. So it is drawn from the record, marked `refused` because
 * that is exactly what has happened to it, and carries the sentence that says
 * by whom.
 *
 * `rule` is empty on purpose and is the honest cell: this module writes no rule
 * on a router that owns bindings, and the router has not written one either, so
 * there is nothing standing for this address anywhere.
 */
export function buildHandoverRow(
  record: DirectBindingRecord,
  now: number,
  reason: string
): DirectRow {
  return {
    ...buildRow(record, undefined, now, 0),
    state: 'refused',
    stateBadges: stateBadges('refused', record.whenDown, ''),
    rule: '',
    reason,
    routerOwned: true
  }
}

/**
 * What the router actually has standing for this binding, written the way `ip
 * rule show` writes it.
 *
 * The live table rather than the stamped one, and `main` as the word, for the
 * same reason `installedTable` does it: this cell exists to be held beside the
 * router's own output. A table of 0 is the daemon saying there is no rule -
 * which is a refused section, a disabled binding, or one whose priority it has
 * frozen because there is nowhere to park a hold - and an invented line would
 * be the one thing worse than an empty cell.
 */
function routerRuleLine(binding: WanbindBinding): string {
  if (!binding.ip || binding.table <= 0) return ''
  const table = binding.table === MAIN_TABLE ? 'main' : String(binding.table)
  return `from ${binding.ip}/32 lookup ${table} pref ${binding.pref}`
}

/**
 * The kernel's main table by number, because that is how it comes back over
 * netlink - the router half reads a number where this one reads the word
 * `main` out of `ip rule show`.
 */
const MAIN_TABLE = 254

/**
 * The two numbers the Overview tiles and the one-to-one chart are drawn from.
 *
 * `held` counts the rule rather than the word: every binding whose rule points
 * at the blackhole, which is `held` and also a parked `stranded`. Counting the
 * state name alone left a device that had roamed onto another VLAN overnight
 * sitting on the unreachable table with the tile reporting nothing detained -
 * the one reading the tile exists to prevent.
 */
export function countTotals(rows: readonly DirectRow[]): DirectTotals {
  return {
    ok: rows.filter((row) => row.state === 'bound').length,
    held: rows.filter((row) => onCatchAll(row.state, row.whenDown)).length
  }
}

// ---------------------------------------------------------------- engine side

/**
 * The rows every surface reads, from whichever half owns them.
 *
 * `routerRows` is null on a router this module binds itself and an array - an
 * empty one included - on a router that keeps its own bindings, which is the
 * only way "nothing was created here" and "this router has none" can be told
 * apart. Falling back to the records on an empty router answer would show
 * bindings this module no longer writes a single rule for.
 */
export function directRows(runtime: DirectRuntime): DirectRow[] {
  if (runtime.routerRows) return runtime.routerRows
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
  // On a router that keeps its own bindings there are no records to read, and
  // the router's rows are the whole of what is claimed. It should not matter -
  // a router owning one-to-one bindings owns instances too, so the planner this
  // feeds is not running - but "should not matter" is not a reason to hand back
  // an empty list, and the day the two capabilities can arrive apart is the day
  // that emptiness seats an instance client on a bound address.
  if (runtime.routerRows) {
    for (const row of runtime.routerRows) {
      if (!row.enabled) continue
      if (row.address) addresses.add(row.address)
    }
    return [...addresses]
  }
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
    totals: { ...countTotals(rows), total: rows.length },
    routerOwned: runtime.routerOwned,
    // Carried on a failed pass as readily as on a good one: a handover that has
    // not finished is exactly the thing an operator needs told while the router
    // is being difficult, and dropping it here would hide it behind whichever
    // error happened to arrive last.
    // Omitted rather than sent empty: the page's only test for "is there
    // anything to say here" is `exists`, which an empty string passes - and a
    // note with a blank reason under it is worse than no note.
    ...(runtime.handoverNotice ? { notice: runtime.handoverNotice } : {})
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
