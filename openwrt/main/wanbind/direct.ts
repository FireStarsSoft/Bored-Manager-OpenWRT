/**
 * The five things an operator can do to a one-to-one binding, each of them one
 * call to the daemon that owns it.
 *
 * This is `direct/router.ts` with the other half of that folder taken away.
 * There, these calls were the path taken *when* the router was keeping its own
 * bindings, with an SSH pass behind them for when it was not; here there is no
 * behind. The module writes no ip rule, plans none, and keeps no record of a
 * binding for the router's to disagree with - so a call that fails means the
 * rows are one tick stale, which the snapshot says, and nothing else.
 *
 * Two rules carried over unchanged from that file, because both were learned
 * the hard way:
 *
 * - **A binding is edited by resending it.** `bind` is create-and-edit in one,
 *   so a change has to restate the fields that identify the binding - the
 *   target and the WAN - and those come from a fresh read rather than from the
 *   cached row, which is up to one tick old. A binding whose WAN somebody
 *   changed at a router shell inside that window would otherwise be rewritten
 *   here with the WAN it used to have.
 * - **`pref` and `table` are never sent.** Omitted, they keep exactly what the
 *   section has, which is what the rule standing in the kernel was written
 *   against. Sending this module's idea of them would be re-deriving a number
 *   that stopped being its to derive in 3.4.0.
 *
 * What is new is the third rule, and it exists because the daemon reports both
 * halves of binding through one call: **a row whose source is not `manual` is
 * an instance seat, not a binding.** Editing or deleting one here would be this
 * page reaching into the other half's work, and the instance would take it
 * straight back on its next pass - a change that appeared to succeed, showed
 * for a few seconds and then undid itself with nothing anywhere to explain it.
 */
import type { OkResult } from '@shared/types'
import { wanbindBindV2, wanbindBindingsV2, wanbindUnbindV2, type WanbindBindSpec } from '../agent'
import { isSafeUciValue } from '../uci'
import { isRecord, textField } from '../util'
import { agentDeps, daemonProblem, daemonReady, recordEvent, runMutationJob } from './runtime'
import type { BindingRuntime, DirectRow } from './types'

/**
 * Why nothing here can run, or ''.
 *
 * The daemon gate is not the transport's: `bm.wanbind` answers as soon as the
 * package is installed, so a router on the older contract takes these calls and
 * refuses them with ubus's own sentence about an unknown method. The
 * requirement's wording says what to do about it instead.
 */
function unavailable(runtime: BindingRuntime): string {
  if (!runtime.ctx.connected) return 'the router is not connected'
  return daemonReady(runtime) ? '' : daemonProblem(runtime)
}

/** The row the last pass reported for one binding, by the id it answers to. */
function directRow(runtime: BindingRuntime, id: string): DirectRow | undefined {
  return runtime.latestDirect.rows.find((row) => row.id === id)
}

/**
 * The refusal a seat gets, worded so that it says where the control actually
 * is rather than only that this one is the wrong one.
 *
 * `source` is the daemon's own field rather than something inferred from the
 * priority a rule sits at, which matters here more than anywhere: a surface
 * that worked ownership out from a band would start refusing every hand-placed
 * binding the moment either band moved.
 */
function seatRefusal(name: string, source: string, target: string): string {
  return `"${name}" is not a one-to-one binding - it is a seat the binding instance ${source} handed to ${target}, and that instance takes it back on its next pass. Move it with the actions on the device's own row under Instances, or bind ${target} here, which is what stops the instance handing it out at all.`
}

/**
 * Read one binding off the router and send it back with something changed.
 *
 * The read is not decoration and it is not the cache: see the note at the top
 * of this file. It is also where the two refusals that have nothing to do with
 * the change itself live - a section the daemon holds but cannot read a target
 * out of, and a seat that belongs to an instance.
 */
async function directEdit(
  runtime: BindingRuntime,
  id: string,
  changes: { name?: string; whenDown?: 'hold' | 'fallback'; enabled?: boolean }
): Promise<OkResult> {
  const deps = agentDeps(runtime)
  const listed = await wanbindBindingsV2(deps, id)
  if (!listed.ok || !listed.data) {
    return { ok: false, error: listed.error ?? 'the router did not answer about that binding' }
  }

  const current = listed.data.bindings.find((binding) => binding.id === id)
  if (!current) return { ok: false, error: 'the router has no one-to-one binding with that name' }
  if (current.source !== 'manual') {
    return { ok: false, error: seatRefusal(current.name || id, current.source, current.label) }
  }
  if (current.targetKind !== 'ip' && current.targetKind !== 'mac') {
    return {
      ok: false,
      error: `the router's own section for this binding names neither an address nor a MAC, so there is nothing to send back to it - ${
        current.reason || 'check it with `bmwan bindings` at a router shell'
      }`
    }
  }

  const written = await wanbindBindV2(deps, {
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
 * Create the binding a passed check froze.
 *
 * The verify step re-reads rather than trusting the answer, for the reason the
 * whole 3.4.0 changeover exists: a binding this module believes in and the
 * router does not is exactly the state that used to leave a page green over a
 * router doing something else entirely.
 */
export async function applyBind(runtime: BindingRuntime, raw: unknown): Promise<OkResult> {
  const payload = isRecord(raw) ? raw : {}
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.bindSession.take(token, payload.values)
  if (!taken) return { ok: false, error: 'that check expired or the form changed - check again' }

  // The token was spent above whatever happens next, which is the protocol: a
  // check is single-use, and a router that went away between the report and
  // the apply has to be checked again rather than applied to on the old one.
  const refusal = unavailable(runtime)
  if (refusal) {
    return {
      ok: false,
      error: runtime.ctx.connected ? refusal : 'the router disconnected after the check'
    }
  }

  const spec: WanbindBindSpec = { ...taken.payload }
  const name = spec.name ?? spec.id
  const target = spec.ip ?? spec.mac ?? ''

  return runMutationJob(
    runtime,
    'direct-create',
    `Bind ${target} to ${spec.wan}`,
    async () => {
      const written = await wanbindBindV2(agentDeps(runtime), spec)
      if (!written.ok) {
        return { ok: false, error: written.error ?? 'the router refused to create the binding' }
      }
      runtime.service.forceDump()

      const listed = await wanbindBindingsV2(agentDeps(runtime), spec.id)
      const created = listed.data?.bindings.find((binding) => binding.id === spec.id)
      if (!created) {
        return {
          ok: false,
          error: `the router does not list a one-to-one binding for ${target} after the create`
        }
      }
      recordEvent(
        runtime,
        'created',
        `one-to-one binding ${name} was created on the router: ${target} leaves through ${spec.wan}`
      )
      // Created and refused is a section that exists, can be seen and can be
      // deleted, but installs no rule - so it is the job's data rather than its
      // failure, and the row carries the daemon's own reason beside it.
      if (!created.usable) {
        return {
          ok: true,
          data: `the router will not use this binding yet: ${created.reason || 'it did not say why'}`
        }
      }
      return { ok: true, data: `${target} leaves through ${spec.wan}` }
    },
    spec.id
  )
}

/**
 * The four fields a binding is built from, which cannot be edited into
 * something else.
 *
 * Worded from the row the router last reported, because on this half there is
 * no record to word it from - and deliberately in the shape the SSH half used,
 * because an operator who read one of these before the changeover and the other
 * after is reading about the same rule.
 */
function immutableRefusal(row: DirectRow, values: Record<string, unknown>): string | null {
  const refusal = (what: string, asked: string): string =>
    `the ${what} of an existing one-to-one binding cannot be changed - the router wrote its rule as "from ${row.target}/32 lookup ${row.table} pref ${row.pref}" for ${row.wan}; delete this binding and create one for ${asked}`

  const kind = textField(values, 'targetKind').toLowerCase()
  if (kind && kind !== row.targetKind) return refusal('target kind', kind)

  const address = textField(values, 'address')
  if (address && address.toLowerCase() !== row.target.toLowerCase()) {
    return refusal('address', address)
  }

  const wan = textField(values, 'wan')
  if (wan && wan !== row.wan) return refusal('WAN port', wan)

  for (const key of ['pref', 'table'] as const) {
    const asked = textField(values, key)
    if (asked && Number(asked) !== row[key]) {
      return refusal(key === 'pref' ? 'rule priority' : 'routing table', asked)
    }
  }
  return null
}

/** A checkbox sends a boolean; an invoke made by hand may send its text. */
function boolField(values: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = values[key]
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'off' || value === '0') return false
  return fallback
}

/**
 * The row's own edit form: a rename, the down behaviour, the switch.
 *
 * All three travel in one `bind`, so there is no "the rename was saved, the
 * switch-on was not" to explain: it either lands or it does not, and a
 * half-saved binding is not a state the router can be left in.
 */
export async function updateDirect(
  runtime: BindingRuntime,
  idRaw: unknown,
  valuesRaw: unknown
): Promise<OkResult> {
  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  const values = isRecord(valuesRaw) ? valuesRaw : {}
  const blocked = unavailable(runtime)
  if (blocked) return { ok: false, error: blocked }

  const row = directRow(runtime, id)
  if (!row) return { ok: false, error: 'no such one-to-one binding' }
  if (row.source !== 'manual') {
    return { ok: false, error: seatRefusal(row.name || id, row.source, row.target) }
  }

  const immutable = immutableRefusal(row, values)
  if (immutable) return { ok: false, error: immutable }

  const name = Object.prototype.hasOwnProperty.call(values, 'name')
    ? textField(values, 'name')
    : row.name
  // The create gate's three tests and its sentence, because this name reaches
  // job labels, event rows and `ctx.log` on this side before it is ever a UCI
  // value on the router - and a newline inside it forges a whole log line here
  // regardless of what the daemon would have made of it.
  if (!name || name.length > 80 || !isSafeUciValue(name)) {
    return { ok: false, error: 'binding name must contain 1-80 characters on one line' }
  }
  const clash = runtime.latestDirect.rows.some(
    (other) =>
      other.id !== id && other.source === 'manual' && other.name.toLowerCase() === name.toLowerCase()
  )
  if (clash) return { ok: false, error: `a one-to-one binding named "${name}" already exists` }

  const asked = textField(values, 'whenDown')
  const whenDown: 'hold' | 'fallback' = asked
    ? asked === 'fallback'
      ? 'fallback'
      : 'hold'
    : row.whenDown === 'fallback'
      ? 'fallback'
      : 'hold'
  const enabled = boolField(values, 'enabled', row.enabled)

  if (name === row.name && whenDown === row.whenDown && enabled === row.enabled) {
    return { ok: true, data: 'nothing changed' }
  }

  return runMutationJob(
    runtime,
    'direct-edit',
    `Save one-to-one binding ${name}`,
    async () => {
      const written = await directEdit(runtime, id, { name, whenDown, enabled })
      if (!written.ok) return written
      runtime.service.forceDump()
      recordEvent(runtime, 'edited', `one-to-one binding ${name} was changed on the router`)
      return { ok: true }
    },
    id
  )
}

/**
 * Switch one binding on or off.
 *
 * `bind` again rather than a verb of its own, because `enabled` is a field of
 * the section like any other and the daemon reconciles from the section. There
 * is no state on this side for a separate call to keep in step with.
 */
async function setEnabled(
  runtime: BindingRuntime,
  idRaw: unknown,
  enabled: boolean
): Promise<OkResult> {
  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  if (!id) return { ok: false, error: 'no one-to-one binding was named' }
  const blocked = unavailable(runtime)
  if (blocked) return { ok: false, error: blocked }

  const row = directRow(runtime, id)
  if (row && row.source !== 'manual') {
    return { ok: false, error: seatRefusal(row.name || id, row.source, row.target) }
  }
  const name = row?.name ?? id

  return runMutationJob(
    runtime,
    enabled ? 'direct-enable' : 'direct-disable',
    `${enabled ? 'Enable' : 'Disable'} one-to-one binding ${name}`,
    async () => {
      const written = await directEdit(runtime, id, { enabled })
      if (!written.ok) return written
      runtime.service.forceDump()
      recordEvent(
        runtime,
        enabled ? 'enabled' : 'disabled',
        `one-to-one binding ${name} was switched ${enabled ? 'on' : 'off'} on the router`
      )
      return { ok: true }
    },
    id
  )
}

export function enableDirect(runtime: BindingRuntime, idRaw: unknown): Promise<OkResult> {
  return setEnabled(runtime, idRaw, true)
}

export function disableDirect(runtime: BindingRuntime, idRaw: unknown): Promise<OkResult> {
  return setEnabled(runtime, idRaw, false)
}

/**
 * Take one binding off the router entirely: its rule first, its section after.
 *
 * A `reason` on a success is passed through as the answer's data rather than
 * turned into a failure. The section is gone, the operator asked for it to be
 * gone, and the sentence is about something left behind that needs a hand - an
 * error here would invite them to press Delete again and remove nothing.
 */
export async function deleteDirect(runtime: BindingRuntime, idRaw: unknown): Promise<OkResult> {
  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  if (!id) return { ok: false, error: 'no one-to-one binding was named' }
  const blocked = unavailable(runtime)
  if (blocked) return { ok: false, error: blocked }

  const row = directRow(runtime, id)
  if (row && row.source !== 'manual') {
    return { ok: false, error: seatRefusal(row.name || id, row.source, row.target) }
  }
  const name = row?.name ?? id

  return runMutationJob(
    runtime,
    'direct-delete',
    `Delete one-to-one binding ${name}`,
    async () => {
      const removed = await wanbindUnbindV2(agentDeps(runtime), id)
      if (!removed.ok) {
        return { ok: false, error: removed.error ?? 'the router would not remove that binding' }
      }
      runtime.service.forceDump()

      const left = removed.data?.reason ?? ''
      const rules = removed.data?.removed ?? 0
      recordEvent(
        runtime,
        'deleted',
        `one-to-one binding ${name} was removed from the router, with ${rules} rule(s)${
          left ? `: ${left}` : ''
        }`
      )
      return left ? { ok: true, data: left } : { ok: true, data: `${rules} rule(s) removed` }
    },
    id
  )
}
