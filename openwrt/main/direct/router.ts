/**
 * The pass that runs instead, when the router keeps the bindings itself.
 *
 * This is `binding/router.ts` one folder over, for the other half of the same
 * boundary - and the one difference between them is the one the owner chose.
 * There, the module keeps the records and the daemon keeps the assignment: an
 * instance is still written from this side, into `/etc/config/bm_wanbind`, and
 * only "who is bound to what" is asked for. Here, **the router is the source of
 * truth outright.** A `config direct` section is the binding; it is reconciled
 * on boot and on netifd events with nothing attached; and this module adds,
 * removes and reads over ubus and keeps no record of its own.
 *
 * So this pass writes no rule, and there is nothing here that plans one. It
 * asks who is bound, fills the same cache every surface already reads, and
 * hands whatever the module still has left over to `handover.ts` on the way
 * past.
 *
 * A call that fails does **not** fall back to the SSH pass, and it is the same
 * rule for the same reason: the daemon sweeps its whole priority band, so this
 * module writing into it would be two writers - and worse, each deleting the
 * other's work on its own timer. A router that did not answer this tick means
 * rows one tick stale, which the snapshot says. The only fall back is a level
 * up, at the capability verdict, where no package, an old package or a stopped
 * service all mean the router is not keeping bindings and the SSH pass runs
 * exactly as it did before any of this existed.
 */
import {
  hasFeature,
  wanbindBind,
  wanbindBindings,
  wanbindSection,
  wanbindUnbind,
  type AgentDeps
} from '../agent'
import type { OkResult } from '@shared/types'
import type { RouterModel } from '../types'
import { isSafeUciValue } from '../uci'
import { syncRouterDirect, type HandoverStranded } from './handover'
import { buildHandoverRow, buildRouterRow, emitSnapshot } from './view'
import type { DirectRow, DirectRuntime } from './types'

/**
 * Whether one-to-one bindings belong to the router on this tick.
 *
 * Read per call and never captured, exactly as `routerOwnsBinding` is: an `apk
 * add` or an `apk del` lands between one readiness cycle and the next, and this
 * is what makes the changeover a tick rather than a reconnect.
 */
export function routerOwnsDirect(runtime: DirectRuntime): boolean {
  const capability = runtime.options.agent?.()
  return !!capability && hasFeature(capability, 'direct')
}

/**
 * Whether this router keeps its own one-to-one bindings, asked without
 * requiring that we can currently talk to the agent.
 *
 * `hasFeature` folds two different facts into one answer: that the package is
 * installed, and that `bm-agent` is usable right now. For deciding whether to
 * *call* the daemon that is exactly right. For deciding whether this module may
 * write `ip rule`s of its own it is dangerous, because bm-wanbind is a separate
 * procd service: stopping bm-agent, or shipping one whose apiVersion this build
 * does not accept, makes `usable` false while the daemon carries on reconciling
 * its `config direct` sections every thirty seconds.
 *
 * Reading it as "no longer router-owned" then sent the SSH pass over a store
 * holding no records - the handover deletes them once the router confirms - so
 * it read every rule in the band as an orphan and deleted the lot. The daemon
 * put them back on its next pass, this module deleted them again on its next
 * tick, and every bound address spent most of its life on the wrong WAN with
 * neither side reporting a conflict.
 *
 * So the package alone answers this one. A router that has genuinely had
 * bm-wanbind removed stops advertising `direct` and falls back properly.
 */
export function routerKeepsDirect(runtime: DirectRuntime): boolean {
  const capability = runtime.options.agent?.()
  return !!capability && capability.provides.includes('direct')
}

/**
 * The agent handle for this tick, or null when the router is not keeping
 * bindings. Built rather than stored so the verdict inside it cannot go stale
 * between the question and the call.
 */
export function routerDeps(runtime: DirectRuntime): AgentDeps | null {
  const capability = runtime.options.agent?.()
  if (!capability || !hasFeature(capability, 'direct')) return null
  return { ctx: runtime.ctx, capability: () => capability }
}

/** The reason every refused router-owned action gives, in one place. */
export const NOT_ROUTER_OWNED =
  'this router is no longer reporting that it keeps one-to-one bindings'

/**
 * One pass. Null when it worked; the reason otherwise, for the snapshot.
 *
 * The order is deliberate: read, hand over, and re-read only if something was
 * written. A handover that wrote nothing - which is every pass on every router
 * a day after the changeover - costs exactly one ubus call, the same one the
 * rows come from.
 */
export async function routerSample(
  runtime: DirectRuntime,
  model: RouterModel
): Promise<string | null> {
  const deps = routerDeps(runtime)
  if (!deps) return NOT_ROUTER_OWNED

  const first = await wanbindBindings(deps)
  if (!first.ok || !first.data) {
    return first.error ?? 'the router did not report its one-to-one bindings'
  }
  if (runtime.disposed) return null

  const handover = await syncRouterDirect(runtime, deps, first.data.bindings)
  if (runtime.disposed) return null

  let listed = first.data
  if (handover.wrote > 0) {
    // Only when something went in, and its answer is allowed to be worse than
    // the first: a re-read that failed leaves the rows this pass already has,
    // which are one handover behind rather than absent.
    const again = await wanbindBindings(deps)
    if (again.ok && again.data) listed = again.data
    if (runtime.disposed) return null
  }

  const now = model.t
  const held = new Set(listed.bindings.map((binding) => binding.id))
  // A record the router has a section for is already on the page as the
  // router's own row, refusal and all - so only the ones it has no section for
  // at all are drawn from the record. Without this test a binding the daemon's
  // configuration reader rejects appeared twice under two ids, and only one of
  // them could be deleted.
  const orphans = handover.stranded.filter(
    (entry) => !held.has(wanbindSection(entry.record.id))
  )

  runtime.routerBand = listed.band
  // Every one of them, not only the ones with no row. A section the daemon
  // holds and refuses is visible on the page with its own reason, but it is
  // still a binding described in two places and steering nothing, and the
  // sentence that says what has happened to the traffic is owed either way.
  runtime.handoverNotice = notice(
    handover.stranded,
    listed.band.usable ? null : listed.band.reason
  )
  runtime.routerRows = [
    ...listed.bindings.map((binding) => buildRouterRow(binding, now)),
    // The bindings the router would not take, drawn from the records that still
    // describe them. They are last because they are the exception; they are
    // present because a binding the operator created and can see nowhere is the
    // worst outcome this changeover has available.
    ...orphans.map((entry) => buildHandoverRow(entry.record, now, entry.reason))
  ]
  emitSnapshot(runtime, now)
  return null
}

/**
 * Re-read the router after something this module just changed, so the row moves
 * now rather than at the next tick.
 *
 * Best effort on purpose. The action it follows has already succeeded on the
 * router; turning a failed re-read into a failed Enable would report the wrong
 * thing about a binding that is switched on.
 */
export async function refreshRouterRows(runtime: DirectRuntime): Promise<void> {
  const model = runtime.options.latestModel()
  if (!model) return
  await routerSample(runtime, model).catch(() => null)
}

/**
 * The sentence the page carries beneath the table, or empty.
 *
 * Two conditions, and the band comes first when both are true: a band the
 * daemon will not allocate from is why nothing new can be created *and* usually
 * why a handover was refused, so leading with the consequence and burying the
 * cause would have the operator fixing the wrong thing.
 */
function notice(stranded: readonly HandoverStranded[], bandReason: string | null): string {
  const parts: string[] = []
  if (bandReason) {
    parts.push(
      `The router will not allocate rule priorities for one-to-one bindings: ${bandReason}. Nothing new can be created here until that is settled on the router.`
    )
  }
  const first = stranded[0]
  if (first) {
    const one = stranded.length === 1
    parts.push(
      `${stranded.length} one-to-one binding${one ? '' : 's'} created by this module ${
        one ? 'has' : 'have'
      } not been taken over by the router - "${first.record.name}" ${
        first.reason
      }. This module writes no rule on a router that keeps its own bindings, so ${
        one ? 'that address is' : 'those addresses are'
      } on the router's default connection meanwhile. The handover is retried on every pass, so fixing the reason is all that is needed.`
    )
  }
  return parts.join(' ')
}

/** The row the router last reported for one binding, by the id it answers to. */
export function routerRow(runtime: DirectRuntime, id: string): DirectRow | undefined {
  return runtime.routerRows?.find((row) => row.id === id)
}

/**
 * Write one binding to the router, from the row it already has plus whatever is
 * changing.
 *
 * `bind` is create-and-update in one, so an edit has to resend the fields that
 * identify the binding - the target and the WAN - and those come from the
 * router's own row rather than from anything this module remembers. That is the
 * whole of "the router is the source of truth" in one function: this module
 * does not hold an opinion about what the binding is, only about the field the
 * operator just changed.
 *
 * `pref` and `table` are deliberately not sent. Omitted, they are kept exactly
 * as the section has them, which is what the rule standing on the router was
 * written against; sending this module's idea of them would be re-deriving a
 * number that is not its to derive.
 */
export async function routerEdit(
  runtime: DirectRuntime,
  id: string,
  changes: { name?: string; whenDown?: 'hold' | 'fallback'; enabled?: boolean }
): Promise<OkResult> {
  const deps = routerDeps(runtime)
  if (!deps) return { ok: false, error: NOT_ROUTER_OWNED }

  // Read back rather than taken from the cached row: the cache is up to one
  // tick old, and a binding whose WAN somebody changed on the router in that
  // window would be rewritten here with the WAN it used to have.
  const listed = await wanbindBindings(deps, id)
  if (!listed.ok || !listed.data) {
    return { ok: false, error: listed.error ?? 'the router did not answer about that binding' }
  }
  const current = listed.data.bindings.find((binding) => binding.id === id)
  if (!current) return { ok: false, error: 'the router has no one-to-one binding with that name' }
  if (current.targetKind !== 'ip' && current.targetKind !== 'mac') {
    return {
      ok: false,
      error: `the router's own section for this binding names neither an address nor a MAC, so there is nothing to send back to it - ${
        current.reason || 'check it with `bmwan bindings` at a router shell'
      }`
    }
  }

  const written = await wanbindBind(deps, {
    id,
    name: changes.name ?? current.name,
    ...(current.targetKind === 'ip' ? { ip: current.label } : { mac: current.label }),
    wan: current.wan,
    ...(current.lan ? { lan: current.lan } : {}),
    whenDown: changes.whenDown ?? current.whenDown,
    enabled: changes.enabled ?? current.enabled
  })
  if (!written.ok) {
    return { ok: false, error: written.error ?? 'the router would not take that change' }
  }
  return { ok: true }
}

/**
 * Take one binding off the router entirely.
 *
 * A `reason` on a success is passed through as the answer's data rather than
 * turned into a failure: the section is gone, the operator asked for it to be
 * gone, and the sentence is about something left behind that needs a hand. An
 * error here would invite them to press Delete again and remove nothing.
 */
export async function routerRemove(runtime: DirectRuntime, id: string): Promise<OkResult> {
  const deps = routerDeps(runtime)
  if (!deps) return { ok: false, error: NOT_ROUTER_OWNED }
  const removed = await wanbindUnbind(deps, id)
  if (!removed.ok) {
    return { ok: false, error: removed.error ?? 'the router would not remove that binding' }
  }
  const left = removed.data?.reason
  if (left) runtime.ctx.log(`openwrt: removing one-to-one binding ${id}: ${left}`)

  // The record that produced this section, if this module still has one. A
  // handover keeps its record until the router reports the binding as usable,
  // so a Delete pressed in that window would otherwise have the next pass write
  // the binding straight back - the operator deleting it once a minute for
  // ever, and never being told why it kept returning.
  const owner = runtime.store.read().direct.find((entry) => wanbindSection(entry.id) === id)
  if (owner) {
    runtime.store.updateNow((data) => {
      data.direct = data.direct.filter((entry) => entry.id !== owner.id)
      data.extraTables = data.extraTables.filter((entry) => entry[2] !== owner.id)
    })
    runtime.memory.delete(owner.id)
  }
  return left ? { ok: true, data: left } : { ok: true }
}

/**
 * Switch one router-held binding on or off.
 *
 * `bind` again rather than a method of its own, because the router is the
 * source of truth and `enabled` is a field of the section like any other -
 * there is no state here for a separate call to keep in step with.
 */
export async function routerSetEnabled(
  runtime: DirectRuntime,
  id: string,
  enabled: boolean
): Promise<OkResult> {
  const name = routerRow(runtime, id)?.name ?? id
  const result = await routerEdit(runtime, id, { enabled })
  if (!result.ok) return result
  runtime.options.event?.(
    enabled ? 'enabled' : 'disabled',
    `one-to-one binding ${name} was ${enabled ? 'switched on' : 'switched off'} on the router`
  )
  await refreshRouterRows(runtime)
  runtime.options.requestDump?.()
  return { ok: true }
}

/**
 * The edit form, for a binding the router keeps.
 *
 * The three fields it may change are the three the SSH half may change, and the
 * four it may not are the four that half refuses too - for the same reason,
 * which is that the rule standing on the router was built from all of them. The
 * refusal is worded from the router's own row rather than from a record,
 * because on this half there is no record; everything else about it, including
 * the sentence, is `lifecycle.ts`'s.
 *
 * There is no equivalent of that file's "the rename was saved, the switch-on
 * was not" split, and there does not need to be: this is one `bind` call
 * carrying all three fields, so it either lands or it does not, and a partial
 * save is not a state the router can be left in.
 */
export async function routerUpdate(
  runtime: DirectRuntime,
  id: string,
  values: Record<string, unknown>
): Promise<OkResult> {
  const row = routerRow(runtime, id)
  if (!row) return { ok: false, error: 'no such one-to-one binding' }

  const immutable = immutableRefusal(row, values)
  if (immutable) return { ok: false, error: immutable }

  const name = Object.prototype.hasOwnProperty.call(values, 'name')
    ? String(values.name ?? '').trim()
    : row.name
  // The same three tests the create gate applies and the same sentence, because
  // this name reaches job labels, event rows and `ctx.log` on this side before
  // it ever reaches a UCI value on the router - and a newline inside it forges
  // a whole log line here regardless of what the daemon would have done with it.
  if (!name || name.length > 80 || !isSafeUciValue(name)) {
    return { ok: false, error: 'binding name must contain 1-80 characters on one line' }
  }
  const clash = (runtime.routerRows ?? []).some(
    (other) => other.id !== id && other.name.toLowerCase() === name.toLowerCase()
  )
  if (clash) return { ok: false, error: `a one-to-one binding named "${name}" already exists` }

  const whenDownRaw = String(values.whenDown ?? '')
  const whenDown = whenDownRaw
    ? whenDownRaw === 'fallback'
      ? 'fallback'
      : 'hold'
    : (row.whenDown as 'hold' | 'fallback')
  const enabled = boolField(values, 'enabled', row.enabled)

  if (name === row.name && whenDown === row.whenDown && enabled === row.enabled) {
    return { ok: true, data: 'nothing changed' }
  }

  const written = await routerEdit(runtime, id, { name, whenDown, enabled })
  if (!written.ok) return written
  runtime.options.event?.(
    'edited',
    `one-to-one binding ${name} was changed on the router`
  )
  await refreshRouterRows(runtime)
  runtime.options.requestDump?.()
  return { ok: true }
}

/**
 * The four fields a binding is built from, which cannot be edited into
 * something else on either half.
 *
 * Worded from the row because there is no record here, and deliberately in the
 * same shape as `lifecycle.ts`'s: the operator who reads one of these on a
 * router that binds for itself and the other on a router that does not is
 * reading about the same rule, and the two must not describe it differently.
 */
function immutableRefusal(row: DirectRow, values: Record<string, unknown>): string | null {
  const refusal = (what: string, asked: string): string =>
    `the ${what} of an existing one-to-one binding cannot be changed - the router wrote its rule as "from ${row.target}/32 lookup ${row.table} pref ${row.pref}" for ${row.wan}; delete this binding and create one for ${asked}`
  const kind = String(values.targetKind ?? '').toLowerCase()
  if (kind && kind !== row.targetKind) return refusal('target kind', kind)
  const address = String(values.address ?? '').trim()
  if (address && address.toLowerCase() !== row.target.toLowerCase()) {
    return refusal('address', address)
  }
  const wan = String(values.wan ?? '').trim()
  if (wan && wan !== row.wan) return refusal('WAN port', wan)
  for (const key of ['pref', 'table'] as const) {
    const asked = String(values[key] ?? '').trim()
    if (asked && Number(asked) !== row[key]) {
      return refusal(key === 'pref' ? 'rule priority' : 'routing table', asked)
    }
  }
  return null
}

/** A checkbox sends a boolean; an invoke made by hand may send its text. */
function boolField(
  values: Record<string, unknown>,
  key: string,
  fallback: boolean
): boolean {
  const value = values[key]
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'off' || value === '0') return false
  return fallback
}

/** Forget everything read off the router, so a reconnect asks again. */
export function forgetRouterState(runtime: DirectRuntime): void {
  runtime.routerOwned = false
  runtime.routerRows = null
  runtime.routerBand = null
  runtime.handoverNotice = ''
}
