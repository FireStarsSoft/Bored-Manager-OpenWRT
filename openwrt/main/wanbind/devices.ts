/**
 * Unassign, Reassign, Pin and Release: everything an operator can do to a
 * device inside an instance's pool.
 *
 * Each of them is one ubus call and nothing else. Until 3.4.0 these wrote into
 * a planner's memory on this side and then ran a pass that rewrote the router's
 * ip rules from it, which is why the file they came from had to clone that
 * memory first and put it back when the pass failed half way - a device left
 * held, force-reassigned or pinned by a pass that never reached the router was
 * the failure that code existed to prevent. There is no planner here. The
 * daemon holds who is on which WAN, it is the only thing that can move them,
 * and a call that fails has changed nothing to put back.
 *
 * The four are not four spellings of one verb, and the difference matters at
 * every call site: `unassign` holds a client out of the pool and keeps it out
 * across a restart, `release` lets it back in, `reassign` moves a seated client
 * off the WAN it has, and `pin` puts one on a WAN by name. The daemon refuses
 * the wrong one with a sentence somebody can act on; the one refusal worth
 * pre-empting is Reassign on a device that is being held, which every surface
 * offers and which the daemon answers with "that client has no WAN to be moved
 * off" - see `effectiveAction`.
 */
import type { OkResult } from '@shared/types'
import {
  wanbindPin,
  wanbindReassign,
  wanbindReconcile,
  wanbindRelease,
  wanbindUnassign,
  type WanbindInstanceConfig
} from '../agent'
import { agentDeps, daemonProblem, daemonReady, recordEvent, runMutationJob } from './runtime'
import type { BindingRuntime } from './types'

export type DeviceAction = 'unassign' | 'reassign' | 'pin' | 'release'

const ACTION_VERB: Record<DeviceAction, string> = {
  unassign: 'Unassign',
  reassign: 'Reassign',
  pin: 'Pin',
  release: 'Release'
}

/**
 * What the ring calls each of them.
 *
 * A bare past-tense verb, as every other line this folder writes is - the job
 * list is what carries the `binding-` prefix, and a ring whose Kind column
 * mixed the two vocabularies would read as two different tables.
 */
const ACTION_KIND: Record<DeviceAction, string> = {
  unassign: 'unassigned',
  reassign: 'reassigned',
  pin: 'pinned',
  release: 'released'
}

/**
 * How many devices one call may name.
 *
 * Each target is a round trip, so a selection is a queue of them: five hundred
 * at a second each is the whole job spent on one press. The number is the same
 * one the PPPoE actions use, for the same reason - it is about how long a
 * person is prepared to watch a job run, not about anything on the router.
 */
const ACTION_LIMIT = 500

/** Lower-cased colon form, which is the spelling the daemon answers in. */
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/

/**
 * A MAC as the selection is keyed on, or ''.
 *
 * The daemon normalises again and refuses what it cannot read, so this is not
 * the gate - it is what makes two views of one device dedupe against each
 * other, since a router reports `AA:BB:...` in one place and `aa:bb:...` in
 * another and two spellings of one MAC would be two calls about one client.
 */
function normalizedMac(value: unknown): string {
  const mac = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return MAC.test(mac) ? mac : ''
}

/** One row of a selection: which instance, and which device in it. */
interface DeviceTarget {
  instanceId: string
  mac: string
}

/**
 * The selection, from either shape the tables send.
 *
 * A row action sends two fields of one row; a bulk toolbar sends the ticked
 * `key` column, which is `<instance>|<mac>`. A key that does not parse into
 * both halves is dropped rather than refusing the call: one unreadable key out
 * of two hundred must not lose the other hundred and ninety-nine, and the count
 * in the job label says how many are really going.
 *
 * Deduplicated because the drawer's Assignments table and the page's All
 * assignments table are two views of one row, and asking the daemon twice about
 * one client would report two changes where one happened.
 */
function actionTargets(idOrKeys: unknown, macRaw?: unknown): DeviceTarget[] {
  const targets: DeviceTarget[] = []
  if (Array.isArray(idOrKeys)) {
    for (const raw of idOrKeys) {
      const key = String(raw ?? '')
      const separator = key.indexOf('|')
      if (separator <= 0) continue
      const instanceId = key.slice(0, separator)
      const mac = normalizedMac(key.slice(separator + 1))
      if (instanceId && mac) targets.push({ instanceId, mac })
    }
  } else {
    const instanceId = String(idOrKeys ?? '')
    const mac = normalizedMac(macRaw)
    if (instanceId && mac) targets.push({ instanceId, mac })
  }
  const seen = new Set<string>()
  return targets.filter((target) => {
    const key = `${target.instanceId}|${target.mac}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function targetKey(target: DeviceTarget): string {
  return `${target.instanceId}|${target.mac}`
}

/** The section as the daemon last described it, or null when it did not. */
function instanceConfig(
  runtime: BindingRuntime,
  id: string
): WanbindInstanceConfig | null {
  return (runtime.cache.info?.configured ?? []).find((entry) => entry.id === id) ?? null
}

function instanceLabel(runtime: BindingRuntime, id: string): string {
  return instanceConfig(runtime, id)?.name || id
}

/**
 * The devices the daemon says it is holding out of the pool.
 *
 * Read from the cached `waiting` reply, which is the only thing on this side
 * that knows: a hold lives in the daemon's own state file and there is no
 * record of one here. A cache that has not been filled yet answers "none",
 * which is the safe way round - the call goes as the operator asked for it and
 * the daemon's own sentence comes back.
 */
function heldKeys(runtime: BindingRuntime): Set<string> {
  const held = new Set<string>()
  for (const entry of runtime.cache.waiting) {
    if (!entry.held) continue
    const mac = normalizedMac(entry.mac)
    if (mac) held.add(`${entry.instance}|${mac}`)
  }
  return held
}

/**
 * What to actually call for this target.
 *
 * Reassign on a held device is the one substitution, and it is not a
 * convenience: `reassign` unbinds the client and asks for anything but the WAN
 * it had, so a device with no WAN is refused with "that client has no WAN to be
 * moved off". Every surface offers Reassign on the waiting table - its own
 * confirmation reads "Release the hold and assign a free WAN when one is
 * available?" - so the button that says it will let a device back in would
 * otherwise be the one button that never works.
 */
function effectiveAction(
  action: DeviceAction,
  target: DeviceTarget,
  held: ReadonlySet<string>
): DeviceAction {
  return action === 'reassign' && held.has(targetKey(target)) ? 'release' : action
}

/**
 * Why this pin cannot be honoured as asked, or null.
 *
 * Only what the router has already told this side is used. An instance that
 * seats one client per WAN cannot take a selection: the daemon would seat the
 * last of them and put every other one back in the queue, evicting each in turn
 * - which is a page reporting four successful pins where one device ended up
 * where it was asked to be. Above one client per WAN that is no longer true,
 * which is why this asks the instance rather than assuming the old rule, and an
 * instance this module has not read yet is not guessed about at all.
 */
function pinRefusal(
  runtime: BindingRuntime,
  targets: readonly DeviceTarget[],
  wan: string
): string | null {
  if (!wan) {
    return 'Name the WAN to pin this device to, spelled as it is in the WAN column of the Assignments table.'
  }
  if (targets.length < 2) return null
  const crowded = targets.find(
    (target) => instanceConfig(runtime, target.instanceId)?.clientsPerWan === 1
  )
  if (!crowded) return null
  return (
    `${instanceLabel(runtime, crowded.instanceId)} gives each client a WAN of its own, so ` +
    `${targets.length} devices cannot share ${wan}: the router would seat the last of them and ` +
    'put the others back in the queue. Pin them one at a time, or raise the clients-per-WAN ' +
    'setting on that instance first.'
  )
}

/** One line in the ring per instance, per verb, naming who moved. */
function recordDone(
  runtime: BindingRuntime,
  done: ReadonlyArray<DeviceTarget & { action: DeviceAction }>,
  wan: string
): void {
  const groups = new Map<string, { action: DeviceAction; instanceId: string; macs: string[] }>()
  for (const entry of done) {
    const key = `${entry.action}|${entry.instanceId}`
    const group = groups.get(key) ?? {
      action: entry.action,
      instanceId: entry.instanceId,
      macs: []
    }
    group.macs.push(entry.mac)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    // Six names and a count. The ring entry is cut at 500 characters wherever
    // it is written, and a line that spent all of them on MAC addresses would
    // have said less than one that says how many there were.
    const shown = group.macs.slice(0, 6).join(', ')
    const rest = group.macs.length > 6 ? ` and ${group.macs.length - 6} more` : ''
    const where = group.action === 'pin' && wan ? ` to ${wan}` : ''
    recordEvent(
      runtime,
      ACTION_KIND[group.action],
      `${ACTION_VERB[group.action]}${where}: ${shown}${rest}`,
      group.instanceId
    )
  }
}

async function deviceActionNow(
  runtime: BindingRuntime,
  targets: readonly DeviceTarget[],
  action: DeviceAction,
  wan: string
): Promise<OkResult> {
  if (!runtime.ctx.connected) return { ok: false, error: 'the router is not connected' }
  if (!daemonReady(runtime)) return { ok: false, error: daemonProblem(runtime) }

  const deps = agentDeps(runtime)
  const held = heldKeys(runtime)
  const done: Array<DeviceTarget & { action: DeviceAction }> = []
  /** Reassigned off a WAN and not seated again yet, which is a success. */
  let queued = 0

  // Named, and with however many already went through. A selection that stopped
  // half way is a fact the user needs; reporting only the failure would have
  // them repeat the ones that worked.
  const stopped = (error: string | null): OkResult => ({
    ok: false,
    error: done.length
      ? `${error ?? 'the router refused'} (${done.length} of ${targets.length} were done first)`
      : (error ?? 'the router refused')
  })

  for (const target of targets) {
    const wanted = effectiveAction(action, target, held)
    if (wanted === 'reassign') {
      const moved = await wanbindReassign(deps, target.instanceId, target.mac)
      if (!moved.ok) return stopped(moved.error)
      // A reassign that found nothing free took the client off the WAN it had
      // and put it in the queue, which is what was asked for. The daemon says
      // so with a null `wan` rather than with a failure, and this side counts
      // it rather than turning it back into one.
      if (!moved.data?.wan) queued += 1
    } else {
      const result =
        wanted === 'pin'
          ? await wanbindPin(deps, target.instanceId, target.mac, wan)
          : wanted === 'unassign'
            ? await wanbindUnassign(deps, target.instanceId, target.mac)
            : await wanbindRelease(deps, target.instanceId, target.mac)
      if (!result.ok) return stopped(result.error)
    }
    done.push({ ...target, action: wanted })
  }

  // Best effort, and last. The rows a surface reads next are one pass behind if
  // this does not land, which the next tick corrects; failing an action the
  // router did perform would be reporting the wrong thing entirely.
  await wanbindReconcile(deps)
  runtime.service.forceDump()
  recordDone(runtime, done, wan)

  const noun = `${done.length} device${done.length === 1 ? '' : 's'}`
  return { ok: true, data: queued ? `${noun}, ${queued} now waiting for a WAN` : noun }
}

/**
 * What every row action and bulk toolbar on the device tables calls.
 *
 * Wrapped in a job because a selection is a queue of round trips and the
 * operator should be able to watch it, and because a failure half way through
 * belongs in the job list rather than only in a toast nobody kept.
 *
 * Deliberately without a `busy` id: that set exists to stop two create-and-edit
 * calls landing on one section, where the loser silently undoes the winner. A
 * device action writes no section, the daemon serialises its own state, and
 * keying the set on the instance would refuse an operator's second Unassign on
 * a different device of the same pool with a sentence about a change that has
 * nothing to do with theirs.
 */
export function queueDeviceAction(
  runtime: BindingRuntime,
  idOrKeys: unknown,
  macRaw: unknown,
  action: DeviceAction,
  wanRaw?: unknown
): Promise<OkResult> {
  const targets = actionTargets(idOrKeys, macRaw)
  if (targets.length === 0) {
    return Promise.resolve({ ok: false, error: 'no valid device was selected' })
  }
  if (targets.length > ACTION_LIMIT) {
    return Promise.resolve({
      ok: false,
      error: `at most ${ACTION_LIMIT} devices in one action - select fewer`
    })
  }

  const wan = String(wanRaw ?? '').trim()
  if (action === 'pin') {
    const refusal = pinRefusal(runtime, targets, wan)
    if (refusal) return Promise.resolve({ ok: false, error: refusal })
  }

  return runMutationJob(
    runtime,
    `binding-${action}`,
    `${ACTION_VERB[action]} ${targets.length} device${targets.length === 1 ? '' : 's'}`,
    () => deviceActionNow(runtime, targets, action, wan)
  )
}
