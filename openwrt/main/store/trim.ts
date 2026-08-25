/**
 * What to keep when the per-router document will not fit.
 *
 * Two jobs, kept apart on purpose. `trim` runs on every read and every update
 * and applies the configured caps. `fitHostData` runs only after a write was
 * refused, and its whole question is which of those caps to tighten further.
 * The core topology records - batches, instances, table assignments - are never
 * candidates: losing one of those loses the router, not some history.
 */
import type { OwrtRules } from '../config'
import { MAX_FINISHED_JOBS, trimFinishedJob } from '../records'
import { MAX_MODULE_EVENTS, serializedBytes, type OwrtHostData } from './schema'

export const PERSIST_TARGET_BYTES = 500 * 1024

/** The floor `fitHostData` will not shrink the sticky map below. */
const STICKY_FLOOR = 100

export function newestSticky(data: OwrtHostData): OwrtHostData['stickyMap'] {
  const unique = new Map<string, OwrtHostData['stickyMap'][number]>()
  for (const entry of [...data.stickyMap].sort((a, b) => b[3] - a[3])) {
    const key = `${entry[0]}\0${entry[1]}`
    if (!unique.has(key)) unique.set(key, entry)
  }
  return [...unique.values()]
}

/**
 * Drop table assignments whose binding instance is gone.
 *
 * `extraTables` is only ever written by a binding preparation, and nothing used
 * to remove an entry: delete an instance and its `[wan, table]` pairs stayed in
 * the document for the life of the router, still overriding the WAN-to-table
 * map for every instance created afterwards.
 *
 * Only entries that name an owner are candidates here. An entry with no owner
 * is either one a preparation has written and not yet claimed - the instance
 * record is pushed by the last item of the same job - or one from a build that
 * predates the field, and `normalize` is where those are dealt with, because
 * loading a document from disk is the one moment nothing can be in flight.
 */
export function pruneExtraTables(data: OwrtHostData): void {
  const live = new Set(data.instances.map((instance) => instance.id))
  data.extraTables = data.extraTables.filter((entry) => !entry[2] || live.has(entry[2]))
}

/**
 * Cut the per-instance event ring to a share per instance rather than one
 * shared budget.
 *
 * A single ring meant the noisiest instance emptied every other instance's
 * drawer: one reconcile over a busy LAN can push a hundred entries, and the
 * quiet instance next to it lost every event it had. Walking newest-first and
 * counting per instance keeps the ring in order while giving each instance its
 * own slice of the cap.
 */
function shareEventRing(
  events: OwrtHostData['events'],
  cap: number,
  instanceCount: number
): OwrtHostData['events'] {
  const share = Math.max(1, Math.floor(cap / Math.max(1, instanceCount)))
  const used = new Map<string, number>()
  const keep = new Array<boolean>(events.length).fill(false)
  for (let index = events.length - 1; index >= 0; index--) {
    const id = events[index]![0]
    const taken = used.get(id) ?? 0
    if (taken >= share) continue
    used.set(id, taken + 1)
    keep[index] = true
  }
  return events.filter((_, index) => keep[index])
}

export function trim(data: OwrtHostData, rules: OwrtRules, aggressive = false): void {
  const stickyCap = Math.max(STICKY_FLOOR, rules.stickyCap)
  data.stickyMap = newestSticky(data).slice(0, stickyCap)

  pruneExtraTables(data)

  const eventCap = aggressive ? Math.min(20, rules.maxEvents) : Math.max(10, rules.maxEvents)
  data.events = shareEventRing(data.events, eventCap, data.instances.length)

  const moduleEventCap = aggressive
    ? Math.min(20, rules.maxEvents)
    : Math.max(10, Math.min(MAX_MODULE_EVENTS, rules.maxEvents))
  if (data.moduleEvents.length > moduleEventCap) {
    data.moduleEvents = data.moduleEvents.slice(-moduleEventCap)
  }

  const jobCap = aggressive ? 3 : MAX_FINISHED_JOBS
  // `trimFinishedJob` is the one place that knows which steps a user opens the
  // history to find - it keeps errors, cancellations and warnings first. The
  // positional `items.slice(0, itemCap)` this replaced threw away exactly
  // those, because a 60-chunk job fails at the end and succeeds at the front.
  data.jobs = data.jobs.slice(0, jobCap).map((job) => trimFinishedJob(job, aggressive ? 8 : undefined))
}

/**
 * Shrink the sticky map first, and only cut the rings once it is at its floor.
 *
 * The old order was the other way round, and it sacrificed the wrong thing: a
 * document is large because of sticky entries, so cutting history to 20 event
 * rows and 3 jobs almost never made the write fit, and the user permanently
 * lost the record of what the module had done to save something that was never
 * the problem. That repeated on every flush - down to the aggressive caps,
 * refill, lose it again.
 */
export function fitHostData(data: OwrtHostData, rules: OwrtRules): void {
  const ranked = newestSticky(data)
  let keep = ranked.length
  while (keep > STICKY_FLOOR) {
    keep = Math.max(STICKY_FLOOR, Math.floor(keep * 0.85))
    data.stickyMap = ranked.slice(0, keep)
    if (serializedBytes(data) <= PERSIST_TARGET_BYTES) return
  }
  data.stickyMap = ranked.slice(0, STICKY_FLOOR)
  if (serializedBytes(data) <= PERSIST_TARGET_BYTES) return
  // Sticky is at its floor and the document still will not fit; only now is
  // history worth spending.
  trim(data, rules, true)
}
