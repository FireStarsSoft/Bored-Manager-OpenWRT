/**
 * The five things an operator can do to a WAN Binding instance, each of them
 * one call to the daemon that owns it.
 *
 * Nothing here plans a rule, allocates a priority or writes a line of UCI. The
 * router does all of that from the section these calls write, which is why an
 * apply is a single `instance_set` where it used to be a job of a dozen steps -
 * and why there is nothing to undo when one fails. `instance_set` is
 * create-and-edit in one, so **an edit resends the fields that identify the
 * instance and omits everything it is not changing**: a field left off keeps
 * what the section has, and there is deliberately no spelling for "clear it".
 *
 * The two identifying fields come from a fresh read rather than from the cache
 * or from anything this module remembers. That is `direct/router.ts`'s rule and
 * it is here for the same reason: the cache is up to one tick old, and an
 * instance whose carrier somebody changed at a router shell in that window
 * would be quietly moved back by the next Save pressed on this page.
 */
import type { OkResult } from '@shared/types'
import {
  wanbindInfo,
  wanbindInstanceDelete,
  wanbindInstanceSet,
  type WanbindInstanceConfig,
  type WanbindInstanceSpec
} from '../agent'
import { isSafeUciValue } from '../uci'
import { isRecord, textField } from '../util'
import { takeInstancePlan } from './plan'
import { agentDeps, daemonProblem, daemonReady, recordEvent, runMutationJob } from './runtime'
import type { BindingRuntime } from './types'

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

/** What the router says this instance is, right now. */
interface InstanceRead {
  instance: WanbindInstanceConfig | null
  /** Why not, when there is none. Empty otherwise. */
  error: string
}

async function readInstance(runtime: BindingRuntime, id: string): Promise<InstanceRead> {
  const answered = await wanbindInfo(agentDeps(runtime))
  if (!answered.ok || !answered.data) {
    return {
      instance: null,
      error: answered.error ?? 'the router did not answer about its binding instances'
    }
  }
  const instance = (answered.data.configured ?? []).find((entry) => entry.id === id) ?? null
  return {
    instance,
    error: instance ? '' : `the router has no binding instance called ${id}`
  }
}

/**
 * One `instance_set`, with the two fields that name the instance filled in from
 * the router's own section.
 *
 * `lan` and `carrier` are not optional in the call and they are exactly the two
 * fields nothing here may change, so every path through this file resends them
 * unaltered - which is the whole of "the router is the source of truth" in one
 * function: this module holds an opinion about the field the operator just
 * changed and about nothing else.
 */
async function writeInstance(
  runtime: BindingRuntime,
  id: string,
  changes: Omit<WanbindInstanceSpec, 'lan' | 'carrier'>
): Promise<OkResult> {
  const read = await readInstance(runtime, id)
  if (!read.instance) return { ok: false, error: read.error }

  const written = await wanbindInstanceSet(agentDeps(runtime), id, {
    ...changes,
    lan: read.instance.lan,
    carrier: read.instance.carrier
  })
  if (!written.ok) {
    return { ok: false, error: written.error ?? 'the router would not take that change' }
  }
  return { ok: true, data: outcome(written.data) }
}

/** What a set actually did, for the job item and the event line. */
function outcome(reply: {
  flushed?: number
  verified?: number
  unverified?: number
  read?: boolean
} | null): string {
  if (!reply) return 'applied'
  const parts: string[] = []
  if (reply.flushed) parts.push(`${reply.flushed} rule(s) flushed first`)
  // `read: false` is the rule table refusing to be listed, which is not the
  // same statement as "nothing landed" - and reporting 0 unverified for it
  // would be this module saying everything worked about a router nobody
  // managed to ask.
  if (reply.read === false) parts.push('the rule table could not be read back')
  else if (reply.unverified) parts.push(`${reply.unverified} rule(s) not held by the kernel`)
  else if (reply.verified) parts.push(`${reply.verified} rule(s) verified`)
  return parts.length ? parts.join(', ') : 'applied'
}

/**
 * Create the instance a passed check froze.
 *
 * The verify step re-reads the router rather than this module's cache, and it
 * is not decoration: `instance_set` answering `ok` means the section was
 * written and a pass was run, and the one failure that leaves every surface
 * looking correct is a section the daemon accepted, wrote and then would not
 * read back - so the create is only finished once the router lists it.
 */
export async function applyInstance(runtime: BindingRuntime, raw: unknown): Promise<OkResult> {
  const payload = isRecord(raw) ? raw : {}
  const token = typeof payload.token === 'string' ? payload.token : ''
  const plan = takeInstancePlan(runtime, token, payload.values)
  if (!plan) return { ok: false, error: 'that check expired or the form changed - check again' }
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
  if (!plan.creating) return { ok: false, error: 'that token belongs to an edit - check again' }

  const { id, creating, ...spec } = plan
  const generation = runtime.generation

  return runMutationJob(
    runtime,
    'binding-create',
    `Create WAN Binding instance ${spec.name ?? id}`,
    async () => {
      const written = await wanbindInstanceSet(agentDeps(runtime), id, spec)
      if (!written.ok) {
        return { ok: false, error: written.error ?? 'the router refused to create the instance' }
      }

      runtime.service.forceDump()
      // The machine can be switched while an apply is in flight, and a verify
      // that read the wrong router would refuse a create that had worked.
      if (generation !== runtime.generation) return { ok: true }

      const read = await readInstance(runtime, id)
      if (!read.instance) {
        return { ok: false, error: `${read.error} after the create` }
      }
      recordEvent(
        runtime,
        'created',
        `binding instance ${read.instance.name} was created on the router: ${read.instance.lan} -> ${read.instance.carrier}`,
        id
      )
      // A section the daemon wrote and then refused installs no rule and seats
      // nobody, and its row would otherwise be zeroes with no account of why.
      // The create still succeeded - the section is there and is editable - so
      // this is the job's data rather than its failure.
      if (!read.instance.usable) {
        return {
          ok: true,
          data: `the router will not use this instance yet: ${read.instance.reason ?? 'it did not say why'}`
        }
      }
      return { ok: true, data: outcome(written.data) }
    },
    id
  )
}

/**
 * The three fields an instance keeps, and the four it cannot be edited into.
 *
 * The LAN, the carrier, the scope and the clients-per-WAN are what every rule
 * standing on the router was written against: the catch-all was written from
 * the scope's covering blocks, each seat's rule from an address inside it, and
 * the priorities from how many seats there could be. Editing one of them would
 * leave those rules exactly where they are, owned by a section that no longer
 * describes them, while the daemon wrote a second set somewhere else. Delete
 * and recreate is the only honest way to do it, and it is what these say.
 */
function immutableRefusal(
  instance: WanbindInstanceConfig,
  values: Record<string, unknown>
): string | null {
  for (const key of ['lan', 'carrier'] as const) {
    const asked = textField(values, key)
    if (asked && asked !== instance[key]) {
      return `the ${
        key === 'lan' ? 'LAN interface' : 'WAN carrier'
      } of an existing instance cannot be changed - its catch-all and every client rule were installed for ${
        instance.lan
      } -> ${instance.carrier}; delete this instance and create one for ${asked}`
    }
  }

  const ranged = Boolean(instance.rangeFrom && instance.rangeTo)
  const scope = ranged ? `${instance.rangeFrom} - ${instance.rangeTo}` : `the whole of ${instance.lan}`
  const askedSource = textField(values, 'source')
  const askedFrom = textField(values, 'from')
  const askedTo = textField(values, 'to')
  if (
    (askedSource && askedSource !== (ranged ? 'range' : 'lan')) ||
    (ranged && askedFrom && askedFrom !== instance.rangeFrom) ||
    (ranged && askedTo && askedTo !== instance.rangeTo)
  ) {
    return `the addresses an existing instance serves cannot be changed - its catch-all was installed for ${scope}; delete this instance and create one with the range you want`
  }

  const askedCapacity = textField(values, 'clientsPerWan')
  if (askedCapacity && Number(askedCapacity) !== instance.clientsPerWan) {
    return `the clients-per-WAN setting of an existing instance cannot be changed - every seat this instance has handed out was allocated at ${
      instance.clientsPerWan === 0 ? 'no limit' : instance.clientsPerWan
    }, and the rule priorities it holds were reserved for that number; delete this instance and create one with the number you want`
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
 * The row's own edit form: a rename and the two behaviour flags.
 *
 * No token, because there is nothing to freeze - none of the three changes a
 * rule, a table or a firewall path, and a report saying so would be a form
 * standing between the operator and a checkbox.
 */
export async function updateInstance(
  runtime: BindingRuntime,
  idRaw: unknown,
  valuesRaw: unknown
): Promise<OkResult> {
  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  const values = isRecord(valuesRaw) ? valuesRaw : {}
  const blocked = unavailable(runtime)
  if (blocked) return { ok: false, error: blocked }

  const configured = runtime.cache.info?.configured ?? []
  const instance = configured.find((entry) => entry.id === id)
  if (!instance) return { ok: false, error: 'no such binding instance' }

  const refusal = immutableRefusal(instance, values)
  if (refusal) return { ok: false, error: refusal }

  // A field the form did not send keeps what the section has; a field it sent
  // empty is somebody clearing the box, and gets the create gate's refusal
  // rather than a Save that silently did nothing to it.
  const name = Object.prototype.hasOwnProperty.call(values, 'name')
    ? textField(values, 'name')
    : instance.name
  if (!name || name.length > 80 || !isSafeUciValue(name)) {
    return { ok: false, error: 'instance name must contain 1-80 characters on one line' }
  }
  if (
    configured.some(
      (entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    return { ok: false, error: `an instance named "${name}" already exists` }
  }

  const sticky = boolField(values, 'sticky', instance.sticky)
  const remap = boolField(values, 'remap', instance.remap)
  const changes: string[] = []
  if (name !== instance.name) changes.push(`renamed to "${name}"`)
  if (sticky !== instance.sticky) changes.push(`sticky ${sticky ? 'on' : 'off'}`)
  if (remap !== instance.remap) changes.push(`error remap ${remap ? 'on' : 'off'}`)
  if (!changes.length) return { ok: true, data: 'nothing changed' }

  return runMutationJob(
    runtime,
    'binding-edit',
    `Save WAN Binding instance ${name}`,
    async () => {
      const written = await writeInstance(runtime, id, { name, sticky, remap })
      if (!written.ok) return written
      runtime.service.forceDump()
      recordEvent(runtime, 'edited', `binding instance ${changes.join(', ')}`, id)
      return written
    },
    id
  )
}

/**
 * Raise dnsmasq's lease ceiling on this instance's LAN, and change nothing else.
 *
 * `instance_set` takes the whole instance, so the LAN and the carrier travel
 * unchanged from the section as the daemon reports it - sending the raise
 * alone would rewrite them to nothing. The daemon does the arithmetic: it
 * raises the ceiling to the seats this instance can hand out, never lowers one,
 * and restarts dnsmasq.
 *
 * The one caller is the capacity report's fix for `lease-max`. It is here
 * rather than there because this is the half that holds the instance.
 */
export async function raiseDhcpLimits(
  runtime: BindingRuntime,
  idRaw: unknown
): Promise<OkResult> {
  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  const blocked = unavailable(runtime)
  if (blocked) return { ok: false, error: blocked }

  const instance = (runtime.cache.info?.configured ?? []).find((entry) => entry.id === id)
  if (!instance) return { ok: false, error: 'no such binding instance' }
  if (!instance.enabled) {
    return {
      ok: false,
      error: `binding instance "${instance.name}" is switched off, and the daemon only raises the lease ceiling for one that is running`
    }
  }

  const reply = await wanbindInstanceSet(agentDeps(runtime), id, {
    lan: instance.lan,
    carrier: instance.carrier,
    raise_dhcp_limits: true
  })

  if (!reply.ok || !reply.data) {
    return { ok: false, error: reply.error ?? 'the daemon refused the change' }
  }
  if (reply.data.ok === false) {
    return { ok: false, error: reply.data.reason ?? 'the daemon refused the change' }
  }

  recordEvent(runtime, 'edited', `dnsmasq lease ceiling raised for ${instance.lan}`, id)
  return { ok: true }
}

/**
 * Switch an instance on or off.
 *
 * `instance_set` again rather than a verb of its own, because `enabled` is a
 * field of the section like any other and the daemon reconciles from the
 * section. There is no state on this side for a separate call to keep in step
 * with, which is exactly what the old start/stop pair had to do.
 */
async function setEnabled(
  runtime: BindingRuntime,
  idRaw: unknown,
  enabled: boolean
): Promise<OkResult> {
  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  if (!id) return { ok: false, error: 'no binding instance was named' }
  const blocked = unavailable(runtime)
  if (blocked) return { ok: false, error: blocked }

  const name =
    (runtime.cache.info?.configured ?? []).find((entry) => entry.id === id)?.name ?? id

  return runMutationJob(
    runtime,
    enabled ? 'binding-start' : 'binding-stop',
    `${enabled ? 'Start' : 'Stop'} WAN Binding instance ${name}`,
    async () => {
      const written = await writeInstance(runtime, id, { enabled })
      if (!written.ok) return written
      runtime.service.forceDump()
      recordEvent(
        runtime,
        enabled ? 'started' : 'stopped',
        `binding instance ${name} was switched ${enabled ? 'on' : 'off'} on the router`,
        id
      )
      return written
    },
    id
  )
}

export function startInstance(runtime: BindingRuntime, idRaw: unknown): Promise<OkResult> {
  return setEnabled(runtime, idRaw, true)
}

export function stopInstance(runtime: BindingRuntime, idRaw: unknown): Promise<OkResult> {
  return setEnabled(runtime, idRaw, false)
}

/**
 * Remove an instance: its rules first, its firewall paths after, its section
 * last, all inside the daemon's own call.
 *
 * A `reason` on a success is passed through as the answer's data rather than
 * turned into a failure. The section is gone, the operator asked for it to be
 * gone, and the sentence is about something left behind that needs a hand - an
 * error here would invite them to press Delete again and remove nothing.
 */
export async function deleteInstance(
  runtime: BindingRuntime,
  idRaw: unknown
): Promise<OkResult> {
  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  if (!id) return { ok: false, error: 'no binding instance was named' }
  const blocked = unavailable(runtime)
  if (blocked) return { ok: false, error: blocked }

  const name =
    (runtime.cache.info?.configured ?? []).find((entry) => entry.id === id)?.name ?? id

  return runMutationJob(
    runtime,
    'binding-delete',
    `Delete WAN Binding instance ${name}`,
    async () => {
      const removed = await wanbindInstanceDelete(agentDeps(runtime), id)
      if (!removed.ok) {
        return { ok: false, error: removed.error ?? 'the router would not remove that instance' }
      }
      runtime.service.forceDump()

      const left = removed.data?.reason ?? ''
      const rules = removed.data?.removed ?? 0
      recordEvent(
        runtime,
        'deleted',
        `binding instance ${name} was removed from the router, with ${rules} rule(s)${
          left ? `: ${left}` : ''
        }`,
        id
      )
      return left ? { ok: true, data: left } : { ok: true, data: `${rules} rule(s) removed` }
    },
    id
  )
}
