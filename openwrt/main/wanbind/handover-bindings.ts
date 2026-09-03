/**
 * The one-to-one half of the handover: every binding this module still holds,
 * offered to the daemon in batches.
 *
 * Split from `handover.ts` next door on size, and cut here because this is the
 * half with machinery in it. The instance half is one call per record - there
 * is no `instance_set_many` - so it stayed where the orchestration is.
 *
 * The three small helpers both halves use (`strand`, `refusal`, `targetLabel`)
 * live here rather than in a third file, because this is the half that uses
 * them most and a file holding three functions would be a worse place to look
 * than this one.
 *
 * The batching is the part to read carefully. A batch is bounded by bytes as
 * well as by count, and by the bytes that actually go on the wire rather than
 * by anything nearer to hand - see `HANDOVER_BYTES`. And the arithmetic is not
 * load-bearing: `sendBatch` halves a batch the router would not take at all and
 * tries again, so a number this file gets wrong about somebody else's SSH
 * server cannot cost a user their bindings.
 */
import { safeUciWord, wanbindSection } from '../uci'
import {
  bindManyBytes,
  wanbindBindMany,
  type AgentCallResult,
  type AgentDeps,
  type WanbindBindManyReply,
  type WanbindBindSpec
} from '../agent'
import type { DirectBindingRecord } from '../store'
import { recordEvent } from './runtime'
import type { BindingRuntime } from './types'
import type { HandoverKind, HandoverOutcome } from './handover'

/** The address or the MAC, whichever this binding was created against. */
export function targetLabel(record: DirectBindingRecord): string {
  return record.target.kind === 'ip' ? record.target.ip : record.target.mac
}

export function strand(
  outcome: HandoverOutcome,
  kind: HandoverKind,
  id: string,
  name: string,
  reason: string
): void {
  outcome.stranded.push({ kind, id, name, reason })
}

/**
 * The verdict on a section the router has just been given: the sentence to keep
 * the record with, or null when the router has it and the record may go.
 *
 * One function for both halves, because both replies answer the same three
 * questions in the same order and only the last has a subtlety. A section the
 * daemon's own configuration reader refuses **is** on the router and is still
 * not a binding - it installs no rule and seats nobody - so the record stays.
 * It is the only description of the thing that is not the router saying it will
 * not have it, and dropping it would leave the operator with something they
 * created, cannot see and cannot delete.
 */
export function refusal(
  written: { ok: boolean; error: string | null },
  row: { usable: boolean; reason: string | null } | undefined
): string | null {
  if (!written.ok) return written.error ?? 'the router would not take it'
  if (!row) return 'the router accepted it but did not say what it did with it'
  if (!row.usable) {
    return row.reason || 'the router will not accept the section it was written into'
  }
  return null
}

/**
 * One one-to-one binding, offered with the priority and the table its rule was
 * written at.
 */
/** How many specs `bind_many` takes in one call, on the daemon's own limit. */
const HANDOVER_CHUNK = 200

/**
 * And how many bytes of them, which is the ceiling that actually binds.
 *
 * Every ubus call this module makes puts its whole JSON payload on an SSH
 * command line, and dropbear - the SSH server OpenWrt ships - refuses an exec
 * request whose command is longer than a few kilobytes, before any shell runs.
 * Two hundred specs is about thirty kilobytes, so batching by count alone turned
 * a slow handover into one that fails outright, on precisely the routers it was
 * added for. Nothing else in this module has ever put a payload this size on a
 * command line - the pool spec goes through a file for the same reason.
 *
 * Four kilobytes of *wire* bytes, measured by `bindManyBytes`, which builds the
 * command the call will actually make. Measuring anything nearer to hand goes
 * wrong on the one field a user controls: a binding's name is up to eighty
 * characters of any printable Unicode, so counting characters rather than bytes
 * under-counts a Thai or CJK name threefold, and counting the JSON before the
 * shell quoting under-counts an apostrophe fourfold. Both were true of the first
 * attempt at this, and both put the command back over the limit.
 *
 * The budget is not the only thing standing between this and a failed handover -
 * see the halving in `handOverBindings`. A number this file gets wrong about
 * somebody else's SSH server must not be able to cost a user their bindings.
 */
const HANDOVER_BYTES = 4_000

/**
 * Every one-to-one binding this module still holds, offered in batches.
 *
 * One call per batch rather than one per record, and at the size this release
 * is about that is the difference between about twenty round trips and five
 * hundred - each of which would be its own commit to the router's flash and its
 * own reconcile pass, while the page showed nothing. A batch is bounded by
 * bytes rather than by count; see `HANDOVER_BYTES`.
 *
 * The verdict on each record is unchanged and is still per record: the reply
 * carries a row for every spec sent, and a batch that succeeded as a whole can
 * still hold a binding the daemon's own reader refused. A record whose row says
 * so is kept and named, exactly as it was when each was its own call.
 *
 * A batch that fails as a whole strands every record in it with the transport's
 * own sentence and leaves them all in the document, so the next tick offers
 * them again. Every spec carries the numbers the rule already standing was
 * written at, so re-offering one the router already has is a call it finds
 * nothing to change in - which is what makes an interrupted handover a retry
 * rather than a repair.
 */
/**
 * One batch, halved and retried when the router does not answer it at all.
 *
 * The size budget above is arithmetic about a limit that belongs to somebody
 * else's SSH server, and arithmetic about someone else's limit is exactly the
 * kind of thing to be wrong about. If the whole call fails - which is what an
 * over-long command looks like, since it is refused before any shell runs and
 * comes back with nothing to read - the batch is split and each half tried
 * again. A batch of one that still fails is a real refusal and is reported as
 * one.
 *
 * The results are concatenated, so the caller sees the same shape it would have
 * seen from one call, and each record still gets its own verdict.
 */
async function sendBatch(
  deps: AgentDeps,
  batch: Array<{ record: DirectBindingRecord; id: string; spec: WanbindBindSpec }>,
  alive: () => boolean
): Promise<AgentCallResult<WanbindBindManyReply>> {
  const reply = await wanbindBindMany(deps, batch.map((one) => one.spec))

  if (reply.ok && reply.data && reply.data.ok !== false) return reply
  if (batch.length < 2 || !alive()) return reply

  // Split only when the call did not reach the daemon.
  //
  // `data.ok === false` means the router answered and refused the batch as a
  // whole - "/etc/config could not be opened", "the overlay may be full" - and
  // a smaller call gets the same answer. Splitting on it walks the entire tree
  // for nothing: 2n-1 calls where the old code made log n, each able to sit on
  // a two-minute timeout, on a pass the page is waiting for. Halving is for the
  // failure that has no answer at all, which is what an over-long command looks
  // like, and that is the one this guard lets through.
  if (reply.data && reply.data.ok === false) return reply

  // Both halves, always, and merged per record.
  //
  // Returning on the first half that failed is the obvious shape and it is
  // wrong twice over. One record the router will not take at all - a name too
  // long for the wire, a section it refuses whole - would take every record
  // batched behind it with it, unsent, on this tick and on every later tick,
  // because the batching is deterministic and would compose the same batch
  // again. And a failure in the second half would strand the records the first
  // half had already got onto the router, which is the dormant-copy state this
  // whole file exists to end.
  //
  // Before batching, each record was its own call and a poisonous one stranded
  // only itself. That property is worth keeping.
  const middle = Math.ceil(batch.length / 2)
  const left = await sendBatch(deps, batch.slice(0, middle), alive)
  const right = alive()
    ? await sendBatch(deps, batch.slice(middle), alive)
    : failedHalf('the router was left before this half was sent')

  const both = [left, right]
  const answered = both.filter((one) => one.ok && one.data && one.data.ok !== false)

  // Neither half answered: one honest transport sentence rather than a
  // synthesised refusal per record about a router that is simply not there.
  if (!answered.length) return left.ok ? right : left

  const halves = [
    { half: left, records: batch.slice(0, middle) },
    { half: right, records: batch.slice(middle) }
  ]
  const results: WanbindBindManyReply['results'] = []
  let written = 0
  let refused = 0

  for (const { half, records } of halves) {
    if (half.ok && half.data && half.data.ok !== false) {
      results.push(...half.data.results)
      written += half.data.written
      refused += half.data.refused
      continue
    }

    const why = half.data?.reason ?? half.error ?? 'the router would not take them'

    for (const one of records) {
      results.push({ id: one.id, ok: false, pref: 0, table: 0, reason: why })
      refused += 1
    }
  }

  return { ok: true, data: { ok: true, written, refused, results }, error: null }
}

/** The shape a half that was never sent comes back as, so the merge is uniform. */
function failedHalf(why: string): AgentCallResult<WanbindBindManyReply> {
  return {
    ok: false,
    data: null,
    error: why
  } as AgentCallResult<WanbindBindManyReply>
}

export async function handOverBindings(
  runtime: BindingRuntime,
  deps: AgentDeps,
  records: DirectBindingRecord[],
  outcome: HandoverOutcome,
  alive: () => boolean
): Promise<void> {
  const pending: Array<{ record: DirectBindingRecord; id: string; spec: WanbindBindSpec }> = []

  for (const record of records) {
    const id = wanbindSection(record.id)

    // The last gate before either name reaches a section on the router, checked
    // here rather than trusted from the create gate that let the record in: a
    // per-router document can be edited by hand, and an allowlist two files
    // away is not a guarantee.
    const unsafe = !safeUciWord(record.wan)
      ? { field: 'WAN', value: record.wan }
      : record.lan !== '' && !safeUciWord(record.lan)
        ? { field: 'LAN', value: record.lan }
        : null

    if (unsafe) {
      // The field that actually failed, named. Quoting the WAN when it was the
      // LAN that was rejected leaves a record kept for ever with the only
      // explanation pointing at a value that is fine.
      strand(
        outcome,
        'binding',
        id,
        record.name,
        `its ${unsafe.field} is a name this module will not write to the router's configuration ("${unsafe.value}")`
      )
      continue
    }

    pending.push({
      record,
      id,
      spec: {
        id,
        name: record.name,
        ...(record.target.kind === 'ip' ? { ip: record.target.ip } : { mac: record.target.mac }),
        wan: record.wan,
        ...(record.lan ? { lan: record.lan } : {}),
        whenDown: record.whenDown,
        // Stamped. See the note at the top: these are the numbers the rule
        // already on the router was written at, and sending them is what makes
        // the daemon adopt that rule instead of writing a second one somewhere
        // else.
        pref: record.pref,
        table: record.table,
        enabled: record.enabled
      }
    })
  }

  for (let at = 0; at < pending.length; ) {
    if (!alive()) return

    // Filled by size and by count, and always at least one - a single record
    // too large for the budget is still better sent than skipped for ever.
    const batch: typeof pending = []

    while (at < pending.length && batch.length < HANDOVER_CHUNK) {
      const next = pending[at]
      if (!next) break

      if (batch.length > 0 && bindManyBytes([...batch, next].map((one) => one.spec)) > HANDOVER_BYTES) {
        break
      }

      batch.push(next)
      at += 1
    }

    const confirmed: DirectBindingRecord[] = []
    const reply = await sendBatch(deps, batch, alive)

    if (!alive()) return

    if (!reply.ok || !reply.data || reply.data.ok === false) {
      const why =
        reply.data?.reason ?? reply.error ?? 'the router did not say why it would not take them'

      for (const one of batch) strand(outcome, 'binding', one.id, one.record.name, why)
      continue
    }

    if (!alive()) return

    // `results[].ok` is the daemon's own read-back, not merely "it was
    // written". `bindMany` re-snapshots after its commit, reads every section
    // it wrote through the same reader a hand-typed one goes through, and for
    // one that does not survive it restores the section and flips the row to
    // `ok: false` with the reason. So written-but-unreadable - the case that
    // produces two ids for one binding if it is got wrong - arrives here as a
    // refusal, and asking the router a second time would only be a second
    // chance to lose a record on a call that failed.
    const rows = new Map(reply.data.results.map((row) => [row.id, row]))

    for (const one of batch) {
      const row = rows.get(one.id)

      if (!row) {
        strand(
          outcome,
          'binding',
          one.id,
          one.record.name,
          'the router accepted the batch but did not say what it did with it'
        )
        continue
      }

      if (!row.ok) {
        strand(outcome, 'binding', one.id, one.record.name, row.reason || 'the router refused it')
        continue
      }

      outcome.wrote += 1
      confirmed.push(one.record)
    }

    // One write for the batch, and one line in the trail. `forget` flushes the
    // whole per-router document, so calling it per record made five hundred
    // records five hundred writes of a document that can be a couple of hundred
    // kilobytes - and five hundred lines into an event ring that holds far
    // fewer than that, which would have pushed out every other kind of event
    // the ring exists to keep.
    forgetMany(runtime, confirmed, outcome)
  }
}

/**
 * Drop every record in one batch the router confirmed, in one write.
 *
 * The single-record `forget` next door is still what the instance half uses -
 * instances are handed over one at a time, because `instance_set` is one at a
 * time - and this is its batch form. Both remove the same three things: the
 * record, and any routing-table claim filed under it.
 */
function forgetMany(
  runtime: BindingRuntime,
  records: DirectBindingRecord[],
  outcome: HandoverOutcome
): void {
  if (!records.length) return

  const ids = new Set(records.map((one) => one.id))

  runtime.store.updateNow((data) => {
    data.direct = data.direct.filter((entry) => !ids.has(entry.id))
    data.extraTables = data.extraTables.filter((entry) => !ids.has(entry[2] ?? ''))
  })

  outcome.dropped += records.length

  const first = records[0]
  const one = records.length === 1

  recordEvent(
    runtime,
    'handover',
    one && first
      ? `one-to-one binding ${first.name} (${targetLabel(first)} through ${first.wan}) is now kept by the router's bm-wanbind, and this module no longer holds a record of it`
      : `${records.length} one-to-one bindings this module created before the router kept its own are now kept by bm-wanbind, every one of them at the priority its rule already stood at, and this module holds no record of them`
  )
}
