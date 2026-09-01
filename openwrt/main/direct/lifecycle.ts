/**
 * Enable, disable, edit, delete - and the two ways the engine itself goes
 * quiet.
 *
 * Enable and Disable write the intended state, run one pass, and put the old
 * state back if that pass failed, so what the store says a binding is doing
 * always matches what the router was actually told. The Enabled checkbox on the
 * edit form is the same action reached by a different route, so a save that
 * ticks it ends up in the same place rather than writing the flag and hoping.
 * Delete is the only one that
 * is allowed to finish on a router that is arguing with it, because Delete is
 * the documented way out of a broken state and it was refusing on exactly the
 * states it exists for.
 */
import type { OkResult } from '@shared/types'
import { ENGINE_STOPPED, NO_SAMPLE, execScript, removeScopedForwardings } from '../binding'
import type { DirectBindingRecord } from '../store'
import { isSafeUciValue } from '../uci'
import { isRecord, textField } from '../util'
import { runDirectPass } from './pass'
import { sectionPrefix } from './prepare'
import { current, emptyDirectSnapshot, exclusive, runMutationJob } from './runtime'
import { targetLabel } from './target'
import { emitSnapshot, republishSnapshot } from './view'
import type { DirectRuntime } from './types'

const NO_SUCH = 'no such one-to-one binding'

/**
 * The field a submission carries the capability verdict for its switch-on in.
 *
 * Whether this router can steer traffic by routing table at all is not readable
 * in this folder and should not be: it is one entry in `requirements.ts`, read
 * per call, and `runtime/handlers.ts` is where that table is consulted. So the
 * verdict travels here with the values, the same way the three fields do -
 * handlers writes the key last, so a hand-written invoke cannot supply one of
 * its own, and an absent key means nothing was in the way.
 *
 * It is a string rather than a flag because the sentence belongs to that table
 * as well. Re-wording it here would be the second copy the whole arrangement
 * exists to avoid.
 */
const ENABLE_REFUSAL = 'enableRefusal'

/**
 * Removing a rule by priority takes the whole group, because a corrupt snapshot
 * or an interrupted write can leave two rules at one number and a single `del`
 * would leave the second one steering traffic for a binding that no longer
 * exists.
 */
function removalLines(record: DirectBindingRecord): string[] {
  if (!Number.isSafeInteger(record.pref) || record.pref <= 0) {
    throw new Error(`one-to-one binding "${record.name}" has no usable rule priority to remove`)
  }
  return [`while ip -4 rule del pref ${record.pref} 2>/dev/null; do :; done`]
}

export async function enableDirect(runtime: DirectRuntime, idRaw: unknown): Promise<OkResult> {
  const record = find(runtime, idRaw)
  if (!record) return { ok: false, error: NO_SUCH }
  return runMutationJob(runtime, 'direct-enable', `Enable binding ${record.name}`, () =>
    setEnabled(runtime, record.id, true)
  )
}

export async function disableDirect(runtime: DirectRuntime, idRaw: unknown): Promise<OkResult> {
  const record = find(runtime, idRaw)
  if (!record) return { ok: false, error: NO_SUCH }
  return runMutationJob(runtime, 'direct-disable', `Disable binding ${record.name}`, () =>
    setEnabled(runtime, record.id, false)
  )
}

export async function deleteDirect(runtime: DirectRuntime, idRaw: unknown): Promise<OkResult> {
  const record = find(runtime, idRaw)
  if (!record) return { ok: false, error: NO_SUCH }
  return runMutationJob(runtime, 'direct-delete', `Delete binding ${record.name}`, () =>
    deleteNow(runtime, record.id)
  )
}

function find(runtime: DirectRuntime, idRaw: unknown): DirectBindingRecord | undefined {
  const id = String(idRaw ?? '')
  return runtime.store.read().direct.find((entry) => entry.id === id)
}

/**
 * Both the pending value and the revert go through the store, so whatever flush
 * lands next writes what the engine actually believes. A bare `record.enabled =
 * x` reaches the same object - `read()` hands back the live cache - but leaves
 * the document clean, and any unrelated update in the seconds the pass takes
 * would then persist the half-applied value while the revert is never written.
 */
function persistEnabled(runtime: DirectRuntime, id: string, enabled: boolean): void {
  runtime.store.update((data) => {
    const saved = data.direct.find((entry) => entry.id === id)
    if (saved) saved.enabled = enabled
  })
}

async function setEnabled(
  runtime: DirectRuntime,
  id: string,
  enabled: boolean
): Promise<OkResult> {
  return exclusive(runtime, async () => {
    const record = runtime.store.read().direct.find((entry) => entry.id === id)
    if (!record) return { ok: false, error: NO_SUCH }
    const model = runtime.options.latestModel()
    if (!model) return { ok: false, error: NO_SAMPLE }
    const old = record.enabled
    persistEnabled(runtime, id, enabled)
    const failed = await runDirectPass(runtime, model)
    // Fatal in both directions. A binding shown as switched off while its rule
    // is still on the router is the one inconsistency this file exists to
    // prevent, and a Enable that reports success without a rule is the other.
    if (failed) {
      persistEnabled(runtime, id, old)
      // The failing pass published its rows on the way out, and it published
      // them before the revert - so they say this binding is on while the record
      // says it is off, for however long the next pass takes to arrive. Pushing
      // them again settles that now, and `republishSnapshot` claims neither a
      // new sample nor a new verdict, so the error the pass reported stays on
      // the page beside them.
      republishSnapshot(runtime)
      return { ok: false, error: failed }
    }
    runtime.options.event?.(
      enabled ? 'enabled' : 'disabled',
      `one-to-one binding ${record.name} was ${enabled ? 'switched on' : 'switched off'}`
    )
    runtime.options.requestDump?.()
    return { ok: true }
  })
}

async function deleteNow(runtime: DirectRuntime, id: string): Promise<OkResult> {
  return exclusive(runtime, async () => {
    const record = runtime.store.read().direct.find((entry) => entry.id === id)
    if (!record) return { ok: false, error: NO_SUCH }
    const generation = runtime.workGeneration
    try {
      await execScript(runtime, removalLines(record), 'remove one-to-one binding rule')
    } catch (error) {
      // The rule is the thing that steers traffic, so this one is fatal: drop
      // the record now and nothing is left that knows the rule exists.
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!current(runtime, generation)) return { ok: false, error: ENGINE_STOPPED }
    try {
      await removeScopedForwardings(runtime, runtime.store, sectionPrefix(record.slot))
    } catch (error) {
      // Not fatal, unlike the rule. A leftover forwarding under this slot's own
      // prefix permits traffic the LAN zone almost certainly permits anyway,
      // and the next binding to take the slot rebuilds the whole prefix - while
      // refusing here would leave a binding nothing can delete.
      runtime.ctx.log(
        `openwrt: deleting ${record.name}: the firewall forwarding could not be removed (${
          error instanceof Error ? error.message : String(error)
        }); removing the binding anyway`
      )
    }
    if (!current(runtime, generation)) return { ok: false, error: ENGINE_STOPPED }
    // Write-through: a binding disappearing is topology, not history, and a
    // crash inside the ten-second debounce would bring the module back
    // believing it still owns a rule it has just taken off.
    runtime.store.updateNow((data) => {
      data.direct = data.direct.filter((entry) => entry.id !== id)
      data.extraTables = data.extraTables.filter((entry) => entry[2] !== id)
    })
    runtime.memory.delete(id)
    const model = runtime.options.latestModel()
    if (model) {
      // The snapshot the next pass plans against still carries the rule this
      // command has just removed; left there, the pass would read it back as an
      // unowned rule in the band and write a delete for it a second time.
      model.rules = model.rules.filter((rule) => rule.pref !== record.pref)
      emitSnapshot(runtime, model.t)
    } else {
      republishSnapshot(runtime)
    }
    runtime.options.event?.(
      'deleted',
      `one-to-one binding ${record.name} was deleted and ${targetLabel(record.target)} is back on the router's default connection`
    )
    runtime.options.requestDump?.()
    return { ok: true }
  })
}

/**
 * Editing a binding that already exists.
 *
 * Three things can change: the display name, what happens when the WAN is down,
 * and whether it is switched on. The address, the WAN port, the priority and
 * the table cannot, for the reason an instance's LAN and carrier cannot - the
 * rule on the router was built from all four, so changing one here would leave
 * the real rule behind, unowned and still steering, while the record described
 * a different one. Delete and recreate is the only honest way to do that.
 *
 * The name and the down behaviour touch nothing: the next pass reads them and
 * applies them, and they are saved even on a router that can do nothing else,
 * because this form is a page a person reaches precisely when something is
 * already wrong.
 *
 * Ticking Enabled is not the harmless third field beside them. The pass that
 * follows writes the same rule at the same priority the row's Enable button
 * writes, so it is that button spelled differently and it goes down the same
 * path - `setEnabled`: write the flag, run one pass, put the flag back if that
 * pass failed. The two doors first disagreed about WHETHER the router can steer
 * traffic by routing table at all. That verdict is `directEnable`'s own entry in
 * `requirements.ts` and is readable in `runtime/handlers.ts` and not in this
 * folder, so handlers reads it and hands it over with the submission - but this
 * function is what acts on it, at the point the switch-on would have run.
 * Handlers used to act on it itself, returning the refusal before this function
 * was called at all, and that threw away everything else in the same Save: on a
 * router that has lost `ip-full`, and on a module whose first probe has not
 * landed yet, a rename typed into this form vanished without a word, two lines
 * under a hint promising it was kept. Both refusals now leave the same state
 * behind and end the same way.
 * They then went on disagreeing about WHAT HAPPENS WHEN THE WRITE FAILS on a
 * router that satisfies every one of those requirements - `option ip4table`
 * deleted from the WAN section by hand is the reported way in. The button
 * reverted and said what went wrong; this answered "Save: done" and left a
 * binding switched on with no rule behind it, the same silence one layer down.
 *
 * Switching Enabled OFF stays a plain record write, and the asymmetry is
 * deliberate. Off is how a person stops the module managing an address, the
 * form is the surface they have open when they want that, and a save refused
 * because the router would not take the rule removal would strand them on it.
 * The record going off is also self-correcting where an Enable is not: every
 * following pass sees a rule in the band with no enabled record behind it and
 * removes it again, and the snapshot carries the error while it keeps failing.
 */
export async function updateDirect(
  runtime: DirectRuntime,
  idRaw: unknown,
  valuesRaw: unknown
): Promise<OkResult> {
  const id = String(idRaw ?? '')
  const values = isRecord(valuesRaw) ? valuesRaw : {}
  const data = runtime.store.read()
  const record = data.direct.find((entry) => entry.id === id)
  if (!record) return { ok: false, error: NO_SUCH }

  const immutable = immutableRefusal(record, values)
  if (immutable) return { ok: false, error: immutable }

  const name = Object.prototype.hasOwnProperty.call(values, 'name')
    ? textField(values, 'name')
    : record.name
  // The same three tests the create gate applies, and the same sentence, because
  // a rename is the second door into the one field that reaches job labels,
  // event rows and `ctx.log` - and a newline inside it forges a whole log line.
  // Checking only the length here meant a name the gate would have refused could
  // be typed into an existing binding instead.
  if (!name || name.length > 80 || !isSafeUciValue(name)) {
    return { ok: false, error: 'binding name must contain 1-80 characters on one line' }
  }
  if (
    data.direct.some(
      (entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    return { ok: false, error: `a one-to-one binding named "${name}" already exists` }
  }
  const whenDownRaw = textField(values, 'whenDown')
  const whenDown = whenDownRaw
    ? whenDownRaw === 'fallback'
      ? 'fallback'
      : 'hold'
    : record.whenDown
  const enabled = boolField(values, 'enabled', record.enabled)
  // Only off-to-on is the Enable button; a save of a binding that is already
  // running arrives with the box ticked because that is what the box is showing.
  const switchingOn = enabled && !record.enabled

  const changes: string[] = []
  // The same edits again, under the labels the form puts on them, for the
  // sentence a refused switch-on ends with. A refusal that did not say which
  // half of the submission survived would leave the operator guessing whether
  // their rename went with it.
  const landed: string[] = []
  if (name !== record.name) {
    changes.push(`renamed to "${name}"`)
    landed.push('Binding name')
  }
  if (whenDown !== record.whenDown) {
    changes.push(
      whenDown === 'hold'
        ? 'holds when its WAN is down'
        : "falls back to the router's default connection when its WAN is down"
    )
    landed.push('When that WAN is down')
  }
  if (!switchingOn && enabled !== record.enabled) changes.push('switched off')
  if (changes.length === 0 && !switchingOn) return { ok: true, data: 'nothing changed' }

  if (changes.length > 0) {
    // Write-through, like the create and the delete: these are the record rather
    // than history, and a crash inside the debounce would bring the module back
    // holding an address the page it was changed on says it releases.
    //
    // First, too, so that the pass a switch-on runs below plans against the
    // record as saved and its event names the binding by the name it now has.
    runtime.store.updateNow((draft) => {
      const saved = draft.direct.find((entry) => entry.id === id)
      if (!saved) throw new Error(NO_SUCH)
      saved.name = name
      saved.whenDown = whenDown
      // A switch-on is `setEnabled`'s flag to write and, if the pass fails, to
      // take back; writing it here as well would be the very thing that made
      // this form disagree with the button.
      if (!switchingOn) saved.enabled = enabled
    })
    runtime.options.event?.('edited', `one-to-one binding ${changes.join(', ')}`)
    // The rows carry all three, so they go out now - but this is not a new router
    // sample, so the timestamp stays where it was.
    republishSnapshot(runtime)
  }
  if (!switchingOn) return { ok: true }
  // Read only here, with the rest of the submission already on disk. A verdict
  // about the router cannot stop a rename that never goes near the router, and
  // the not-probed case is the one that proves it: a module a few seconds into
  // its first probe refuses every switch-on, and losing a rename to that would
  // be losing it for no reason at all.
  const blocked = textField(values, ENABLE_REFUSAL)
  if (blocked) return { ok: false, error: incapableRouter(blocked, landed) }
  return switchOnFromForm(runtime, id, landed)
}

/**
 * Which half of the submission survived, under the labels the form puts on
 * them. Empty when the save carried nothing but the checkbox, because there is
 * then no other half to account for.
 */
function keptClause(landed: readonly string[]): string {
  if (landed.length === 0) return ''
  return ` ${landed.join(' and ')} ${landed.length > 1 ? 'were' : 'was'} saved.`
}

/**
 * A switch-on this router cannot do at all, once the rest of the save has
 * landed.
 *
 * The verdict is returned word for word: the row's Enable button is refused in
 * exactly that sentence, and two doors into one action may not describe one
 * router in two ways - a test holds the two side by side for that reason. What
 * this adds is the half the button can never be asked about, because the button
 * carries no other fields: when this Save did change something else, the
 * sentence ends by saying so, in the wording a refused pass ends with.
 */
function incapableRouter(verdict: string, landed: readonly string[]): string {
  if (landed.length === 0) return verdict
  return `${verdict} Enabled is still off and no rule was written.${keptClause(landed)}`
}

/**
 * The Enabled checkbox, once the rest of the submission has been saved.
 *
 * `setEnabled` is the row's Enable button, so this is that action with the
 * form's own wording around its refusal - and the refusal is returned rather
 * than filed as a job the way the button files one, because a Save is something
 * a person is sitting in front of waiting for an answer to. What the pass could
 * not do comes first, because it is the reason; then the state the binding was
 * left in, then the fields that did save.
 *
 * They do save. Both of them reach the router through nothing at all, they are
 * the edits this form exists to allow on a router that is misbehaving, and
 * undoing a rename because an `ip rule` would not write would be a second
 * surprise stacked on the first. So the rule is: everything that can be applied
 * without the router is applied, the one thing that cannot is all-or-nothing,
 * and the sentence says which was which.
 */
async function switchOnFromForm(
  runtime: DirectRuntime,
  id: string,
  landed: readonly string[]
): Promise<OkResult> {
  let result: OkResult
  try {
    result = await setEnabled(runtime, id, true)
  } catch (error) {
    // `exclusive` rejects rather than returns when the engine was reset or the
    // machine disconnected while this save was queued behind another job.
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (result.ok) return result
  const failure = result.error || 'the rule for this binding could not be written'
  // The state clause is here whether or not anything else was saved, and that
  // is the difference from `incapableRouter` above: this failure is the
  // router's own words about one command, and says nothing at all about what
  // the binding was left doing.
  return {
    ok: false,
    error: `${failure} - Enabled is still off and no rule was written.${keptClause(landed)}`
  }
}

function immutableRefusal(
  record: DirectBindingRecord,
  values: Record<string, unknown>
): string | null {
  const refusal = (what: string, asked: string): string =>
    `the ${what} of an existing one-to-one binding cannot be changed - its rule was written as "from ${targetLabel(record.target)}/32 lookup ${record.table} pref ${record.pref}" for ${record.wan}; delete this binding and create one for ${asked}`
  const kind = textField(values, 'targetKind').toLowerCase()
  if (kind && kind !== record.target.kind) return refusal('target kind', kind)
  const address = textField(values, 'address')
  if (address && address.toLowerCase() !== targetLabel(record.target).toLowerCase()) {
    return refusal('address', address)
  }
  const wan = textField(values, 'wan')
  if (wan && wan !== record.wan) return refusal('WAN port', wan)
  for (const key of ['pref', 'table'] as const) {
    const asked = textField(values, key)
    if (asked && Number(asked) !== record[key]) {
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

export function reset(runtime: DirectRuntime): void {
  runtime.workGeneration += 1
  runtime.checkSession.clear()
  runtime.memory.clear()
  runtime.preparations.clear()
  runtime.latestPayload = emptyDirectSnapshot()
}

export function dispose(runtime: DirectRuntime): void {
  runtime.workGeneration += 1
  runtime.disposed = true
  runtime.checkSession.clear()
  runtime.memory.clear()
  runtime.preparations.clear()
}
