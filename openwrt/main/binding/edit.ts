/**
 * Editing an instance that already exists.
 *
 * Only three of its fields can change: the display name and the two behaviour
 * flags. `lan`, `carrier` and the address range cannot, and not for want of a
 * form field - they are the topology every rule on the router was built from,
 * and the range decides which blocks its catch-all selects. Moving a running
 * instance to another LAN would leave its catch-all pointing at the old subnet
 * and its client rules written from addresses that are no longer behind it, so
 * a device would keep a WAN it can no longer reach and a new one would leak
 * onto the router's own. Delete and recreate is the only honest way to do that,
 * and it is what the refusal below says.
 *
 * Nothing here touches the router: the planner reads these three on its next
 * pass, and the fast tick is what applies them.
 */
import type { OkResult } from '@shared/types'
import { isSafeUciValue } from '../uci'
import { isRecord, textField } from '../util'
import { recordEvents } from './events'
import { republishSnapshot } from './view'
import type { BindingRuntime } from './types'

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

export function updateInstance(
  runtime: BindingRuntime,
  idRaw: unknown,
  valuesRaw: unknown
): OkResult {
  const id = String(idRaw ?? '')
  const values = isRecord(valuesRaw) ? valuesRaw : {}
  const data = runtime.store.read()
  const instance = data.instances.find((entry) => entry.id === id)
  if (!instance) return { ok: false, error: 'no such binding instance' }

  // A field the form did not send keeps what the record has; a field it sent
  // empty is someone clearing the box, and gets the same refusal the create
  // form gives rather than a save that silently did nothing to it.
  const name = Object.prototype.hasOwnProperty.call(values, 'name')
    ? textField(values, 'name')
    : instance.name
  // The same sieve the create gate applies, and for the same reason: this name
  // reaches job labels, event rows and `ctx.log`, so a control character inside
  // it forges a whole line in each of them. Checking only the length here left
  // a rename as the way in - the gate was on the door and not on the window,
  // and an instance created under a clean name could be edited into a dirty
  // one. The value is deliberately not echoed back into the refusal.
  if (!name || name.length > 80 || !isSafeUciValue(name)) {
    return { ok: false, error: 'instance name must contain 1-80 characters on one line' }
  }
  if (
    data.instances.some(
      (entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    return { ok: false, error: `an instance named "${name}" already exists` }
  }
  for (const key of ['lan', 'carrier'] as const) {
    const asked = textField(values, key)
    if (asked && asked !== instance[key]) {
      return {
        ok: false,
        error: `the ${key === 'lan' ? 'LAN interface' : 'WAN carrier'} of an existing instance cannot be changed - its catch-all and every client rule were installed for ${instance.lan} -> ${instance.carrier}; delete this instance and create one for ${asked}`
      }
    }
  }
  // The address range joins them, for the same reason and with the same
  // remedy. The catch-all standing on the router right now was written as the
  // covering CIDR blocks of the range this instance was created with: narrow
  // the range here and every device that fell out of it keeps matching a
  // blackholed block with no assignment rule ever coming to lift it out, while
  // widening it leaves the new addresses matching nothing at all.
  const stored = instance.source?.kind === 'range' ? instance.source : null
  const askedSource = textField(values, 'source')
  const askedFrom = textField(values, 'from')
  const askedTo = textField(values, 'to')
  if (
    (askedSource && askedSource !== (stored ? 'range' : 'lan')) ||
    (stored && askedFrom && askedFrom !== stored.from) ||
    (stored && askedTo && askedTo !== stored.to)
  ) {
    return {
      ok: false,
      error: `the address range of an existing instance cannot be changed - its catch-all was installed for ${stored ? `${stored.from} - ${stored.to}` : `the whole of ${instance.lan}`}; delete this instance and create one with the range you want`
    }
  }
  const sticky = boolField(values, 'sticky', instance.sticky)
  const remap = boolField(values, 'remap', instance.remap)
  const changes: string[] = []
  if (name !== instance.name) changes.push(`renamed to "${name}"`)
  if (sticky !== instance.sticky) changes.push(`sticky ${sticky ? 'on' : 'off'}`)
  if (remap !== instance.remap) changes.push(`error remap ${remap ? 'on' : 'off'}`)
  if (changes.length === 0) return { ok: true, data: 'nothing changed' }

  // Write-through, like the create and the delete: these three are the record
  // rather than history, and a crash inside the ten-second debounce would
  // bring the module back distributing clients under the old flags while the
  // page it was changed on shows the new ones.
  runtime.store.updateNow((draft) => {
    const saved = draft.instances.find((entry) => entry.id === id)
    if (!saved) throw new Error('no such binding instance')
    saved.name = name
    saved.sticky = sticky
    saved.remap = remap
  })
  // The cached summary is only rebuilt by a reconcile, and a rename that waits
  // for the next fast tick looks like a save that did nothing.
  const cached = runtime.cache.get(id)
  if (cached) cached.summary = { ...cached.summary, name }
  recordEvents(runtime, { ...instance, name, sticky, remap }, [{
    t: Date.now(),
    kind: 'edited',
    text: `binding instance ${changes.join(', ')}`
  }])
  // The rows carry the three edited values, so they have to go out now - but
  // this is not a new router sample, so the timestamp stays where it was.
  republishSnapshot(runtime)
  return { ok: true }
}
