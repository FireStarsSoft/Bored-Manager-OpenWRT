/**
 * Enable, disable, edit, delete - and the two ways the engine itself goes
 * quiet.
 *
 * Enable and Disable write the intended state, run one pass, and put the old
 * state back if that pass failed, so what the store says a binding is doing
 * always matches what the router was actually told. Delete is the only one that
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
 * Nothing here touches the router: the next pass reads these and applies them.
 */
export function updateDirect(
  runtime: DirectRuntime,
  idRaw: unknown,
  valuesRaw: unknown
): OkResult {
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

  const changes: string[] = []
  if (name !== record.name) changes.push(`renamed to "${name}"`)
  if (whenDown !== record.whenDown) {
    changes.push(
      whenDown === 'hold'
        ? 'holds when its WAN is down'
        : "falls back to the router's default connection when its WAN is down"
    )
  }
  if (enabled !== record.enabled) changes.push(enabled ? 'switched on' : 'switched off')
  if (changes.length === 0) return { ok: true, data: 'nothing changed' }

  // Write-through, like the create and the delete: these three are the record
  // rather than history, and a crash inside the debounce would bring the module
  // back holding an address the page it was changed on says it releases.
  runtime.store.updateNow((draft) => {
    const saved = draft.direct.find((entry) => entry.id === id)
    if (!saved) throw new Error(NO_SUCH)
    saved.name = name
    saved.whenDown = whenDown
    saved.enabled = enabled
  })
  runtime.options.event?.('edited', `one-to-one binding ${changes.join(', ')}`)
  // The rows carry all three, so they go out now - but this is not a new router
  // sample, so the timestamp stays where it was.
  republishSnapshot(runtime)
  return { ok: true }
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
