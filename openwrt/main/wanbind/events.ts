/**
 * The per-instance event ring: what goes in it, and how it gets there.
 *
 * Everything in it now comes from one place - two consecutive `assignments`
 * replies, compared. Nothing on this side plans anything any more, so there is
 * no pass whose decisions could be narrated; what there is instead is the
 * router's own answer about who is on which WAN, and the difference between two
 * of those answers is exactly the three facts a person opens this table for: a
 * device was seated, a device moved, a device lost its WAN.
 *
 * That is less than the planner used to say and it is worth naming what went
 * with it. `ip-change`, `waiting` and the exhausted-priorities notice were all
 * statements about the planner's own working, and the daemon reports the first
 * two as state a surface can simply show. What is left is history, which is the
 * one thing a table of live state cannot give: the Assignments table says a
 * device is on `wan3`, and only the ring says it was moved there at twenty past
 * four after `wan2` failed.
 */
import type { WanbindAssignment } from '../agent'
import type { BindingRuntime } from './types'

/** One line of history, already attributed to the instance whose ring it is. */
export interface BindingEvent {
  instanceId: string
  /** App-clock ms. The daemon's own clock is the router's and is not this one. */
  t: number
  kind: string
  text: string
}

/**
 * How many lines one comparison may add per instance.
 *
 * The ring is small and shared between every instance on the router, so one
 * unusual pass must not be able to evict the history of all the others. A
 * router that has just come back up seats every client it has in a single pass;
 * two hundred `assigned` lines would say nothing that "200 devices were seated"
 * does not, and would cost every line written before them.
 */
const MAX_PER_INSTANCE = 20

/** How many of one batch reach the live log, which is a window and not a record. */
const EMIT_LIMIT = 8

/**
 * Single-lined and bounded, because a hostname and an interface name from the
 * router can end up quoted in one of these, and a ring entry is kept.
 */
function safe(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500)
}

function assignmentKey(entry: WanbindAssignment): string {
  return `${entry.instance}|${entry.mac.toLowerCase()}`
}

function index(list: readonly WanbindAssignment[]): Map<string, WanbindAssignment> {
  const byKey = new Map<string, WanbindAssignment>()
  for (const entry of list) {
    if (!entry.instance || !entry.mac) continue
    byKey.set(assignmentKey(entry), entry)
  }
  return byKey
}

function where(entry: WanbindAssignment): string {
  return entry.ip ? `${entry.mac} (${entry.ip})` : entry.mac
}

/**
 * What changed between two `assignments` replies.
 *
 * Keyed on the instance *and* the MAC rather than the MAC alone, so a device
 * that moved from one instance's LAN to another's reads as a release from the
 * first and an assignment on the second - which is what happened, and which is
 * the only account that can be written, since the ring is per instance and a
 * line has to belong to exactly one of them.
 *
 * The caller decides what "previous" means, and there is one way to get it
 * wrong: the empty list a cache carries before its first fetch is not a router
 * with nobody seated on it, and comparing against it would report every client
 * on the router as newly assigned. Compare two replies that both happened.
 */
export function diffAssignments(
  previous: readonly WanbindAssignment[],
  current: readonly WanbindAssignment[]
): BindingEvent[] {
  const before = index(previous)
  const after = index(current)
  const now = Date.now()
  const events: BindingEvent[] = []
  const used = new Map<string, number>()
  const omitted = new Map<string, number>()

  const push = (instanceId: string, kind: string, text: string): void => {
    const count = used.get(instanceId) ?? 0
    if (count >= MAX_PER_INSTANCE) {
      omitted.set(instanceId, (omitted.get(instanceId) ?? 0) + 1)
      return
    }
    used.set(instanceId, count + 1)
    events.push({ instanceId, t: now, kind, text: safe(text) })
  }

  for (const [key, entry] of after) {
    const was = before.get(key)
    if (!was) {
      push(entry.instance, 'assigned', `${where(entry)} assigned to ${entry.wan}`)
      continue
    }
    if (was.wan !== entry.wan) {
      push(entry.instance, 'remapped', `${where(entry)} moved from ${was.wan} to ${entry.wan}`)
    }
  }

  for (const [key, entry] of before) {
    if (after.has(key)) continue
    // Why it left is not in this reply, and guessing would be worse than not
    // saying: a client that was unassigned by hand, one whose lease expired and
    // one whose WAN failed all leave the assignment list the same way. The
    // waiting table says which, for as long as it is still true.
    push(entry.instance, 'released', `${where(entry)} released ${entry.wan}`)
  }

  for (const [instanceId, count] of omitted) {
    events.push({
      instanceId,
      t: now,
      kind: 'omitted',
      text: `${count} further change(s) in this pass are not listed`
    })
  }

  return events
}

/** The instance's own name for the log line, or its id when it has none. */
function instanceName(runtime: BindingRuntime, id: string): string {
  const configured = runtime.cache.info?.configured ?? []
  return configured.find((entry) => entry.id === id)?.name || id
}

/**
 * Put a batch in the ring, and the tail of it in the live log.
 *
 * The ring is the record and takes everything; the log is a window somebody has
 * open on one instance, so only the last few of a large batch are pushed to it,
 * with a line saying how many were skipped. Without that line a burst reads as
 * a quiet moment on a router that just reseated two hundred clients.
 */
/**
 * One instance's history, newest first.
 *
 * The ring is this module's own and is the one thing about binding it still
 * keeps: the daemon reconciles, it does not remember, so nothing on the router
 * can answer "what happened to this instance while nobody was looking". The
 * index goes into the row id because two events in the same millisecond are
 * ordinary on a router seating a LAN at once, and a table with duplicate keys
 * drops rows.
 */
export function eventRows(runtime: BindingRuntime, idRaw: unknown) {
  const id = String(idRaw ?? '')
  return runtime.store
    .read()
    .events.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry[0] === id)
    .reverse()
    .map(({ entry, index }) => ({
      id: `${entry[1]}-${index}`,
      when: new Date(entry[1]).toISOString(),
      t: entry[1],
      kind: entry[2],
      text: entry[3]
    }))
}

export function recordEvents(runtime: BindingRuntime, events: readonly BindingEvent[]): void {
  if (events.length === 0) return

  runtime.store.update((data) => {
    for (const event of events) {
      data.events.push([event.instanceId, event.t, event.kind, safe(event.text)])
    }
  })

  const byInstance = new Map<string, BindingEvent[]>()
  for (const event of events) {
    const batch = byInstance.get(event.instanceId) ?? []
    batch.push(event)
    byInstance.set(event.instanceId, batch)
  }

  for (const [instanceId, batch] of byInstance) {
    const name = instanceName(runtime, instanceId)
    if (batch.length > EMIT_LIMIT) {
      runtime.ctx.emit('bindingLog', {
        id: instanceId,
        data: `${new Date().toISOString()} [${name}] ${batch.length - EMIT_LIMIT} earlier event(s) omitted from the live log`
      })
    }
    for (const event of batch.slice(-EMIT_LIMIT)) {
      runtime.ctx.emit('bindingLog', {
        id: instanceId,
        data: `${new Date(event.t).toISOString()} [${name}] ${event.text}`
      })
    }
  }
}
