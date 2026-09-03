/**
 * What happens to the instances and the one-to-one bindings this module wrote,
 * on the day the router owns both outright.
 *
 * The situation is a router carrying WAN Binding this module created - a record
 * each in the per-router document, an `ip rule` each in a priority band, a
 * firewall forwarding each - which then gets packages 2.4.0. From that moment
 * the same instance, and the same binding, is described in two places, and two
 * writers of one priority band is not a slower arrangement than one, it is a
 * wrong one. On a real router it was 34 rules deleted every thirty seconds and
 * written back a second later, for ever - each bound address on the default
 * connection for about a second in every thirty, with neither half reporting a
 * conflict because each was doing exactly what it had been told.
 *
 * **Doing nothing is not the safe option here, and that is what decides this
 * file.** The daemon's own pass reads back every rule in the bands it owns and
 * removes every one of them that no section asks for. So a router handed the
 * new package with five module-written bindings and two module-written
 * instances on it has none of those rules within thirty seconds, whatever this
 * module chooses to do - and this module must stand down at the same moment or
 * it is the second writer again. Waiting for somebody to press something does
 * not preserve them; it preserves the *records* while the routing quietly
 * stops, which is the "green everywhere, packets leaving by another WAN"
 * failure this whole change exists to remove.
 *
 * So they are handed over, and the shape is a convergent function rather than a
 * migration: **one pass that offers the router what the records say and forgets
 * a record once the router confirms it.** It runs at the top of every cache
 * refresh, it is a no-op when there is nothing to move - which is every router
 * a day after the changeover, and every router that never ran 3.3.x - and a
 * record the router refuses this tick is simply offered again on the next one.
 * An operator who fixes the reason needs no button, and there is no
 * half-finished state for a crash to leave behind.
 *
 * Four decisions inside it are worth stating.
 *
 * **The stamped numbers are sent, not omitted.** Both calls allocate when the
 * numbers are absent, which is right for something being created and wrong for
 * something that already exists: the rules standing on the router right now
 * were written at those priorities and into that table, so sending the numbers
 * is what makes the daemon adopt the rules already there rather than write a
 * second set somewhere else and sweep the first a moment later. It is the same
 * rule, and the same reason, as `wanbindInstanceLines` stamping an instance's
 * own recorded layout when this module still wrote the section itself.
 *
 * **One-to-one bindings go first, instances after.** A binding that already
 * follows an address makes an instance leave that address alone - `reserved`,
 * in the daemon's own vocabulary. Handing the instances over first would give
 * the daemon a pool and a LAN with none of the reservations yet, so it would
 * seat those addresses on its own WANs, write the rules, and release them again
 * when the bindings arrived a moment later. Both orders converge; only one of
 * them has no window in which a bound address is on the wrong WAN.
 *
 * **The record is dropped once the router has it, and not kept as a spare.** A
 * dormant copy sounds harmless until the package is removed again: the record
 * would come back to life and this module would write rules for a binding, or a
 * whole instance, that the operator may have deleted on the router in between.
 * Losing sight of one is recoverable by looking at the router; resurrecting a
 * deleted one is not.
 *
 * **Nothing else is written to the router - not even a tidy-up.** The firewall
 * forwardings the old SSH halves wrote are left exactly where they are. Once
 * the daemon's own forwardings are in force those sections permit traffic that
 * is already permitted, so they are untidy rather than harmful; removing them
 * would mean this half running `uci delete` on a router it has just declared it
 * does not write to, through the very folder that goes when the SSH halves do.
 * Tying the life of the new half to the old one, to delete a duplicate permit,
 * is the worse trade.
 */
import { safeUciWord, wanbindSection } from '../uci'
import {
  wanbindBindMany,
  wanbindBindings,
  wanbindInstanceSet,
  type AgentDeps,
  type WanbindBindSpec,
  type WanbindInstanceSpec
} from '../agent'
import type { BindingInstanceRecord, DirectBindingRecord } from '../store'
import { agentDeps, daemonReady, olderDaemonRunning, recordEvent } from './runtime'
import type { BindingRuntime } from './types'

/** Which half a record belongs to. The two are worded differently throughout. */
export type HandoverKind = 'instance' | 'binding'

/** One record the router has not taken over, and the sentence that says why. */
export interface HandoverStranded {
  kind: HandoverKind
  /** The section the router was asked for, which is the id its own rows use. */
  id: string
  /** What the operator called it, which is how they will recognise it. */
  name: string
  reason: string
}

export interface HandoverOutcome {
  /** Sections the router took this pass. */
  wrote: number
  /** Records the router confirmed and this module has therefore forgotten. */
  dropped: number
  /** Everything offered and refused, by either half. */
  stranded: HandoverStranded[]
  /**
   * Records that could not be offered at all, because this router has no daemon
   * to offer them to.
   *
   * Counted rather than listed, and kept apart from `stranded`, because the two
   * are different sentences: a refusal names a fault somebody can fix, and this
   * is a router that has simply not been given the packages yet. Zero on every
   * router that has them.
   */
  stalled: { instances: number; bindings: number }
  /**
   * The router has a bm-wanbind, and it is one this module cannot drive.
   *
   * Only meaningful beside a non-zero `stalled`, and it changes what that
   * sentence may claim: a 2.3.x daemon owns the one-to-one priority band and
   * removes every rule in it that no section claims, which is every rule a
   * 3.3.x module wrote. On that router the records are not merely unmaintained,
   * they are being taken off.
   */
  sweeping: boolean
}

/** What a router with nothing left to hand over answers with. */
export const NOTHING_HANDED_OVER: HandoverOutcome = {
  wrote: 0,
  dropped: 0,
  stranded: [],
  stalled: { instances: 0, bindings: 0 },
  sweeping: false
}

const NOTHING: HandoverOutcome = {
  wrote: 0,
  dropped: 0,
  stranded: [],
  stalled: { instances: 0, bindings: 0 },
  sweeping: false
}

/**
 * Offer the router everything this module still holds, and forget what it takes.
 *
 * Awaited near the top of every cache refresh. The common case - a document
 * with no instance and no binding left in it - reaches the first `return` and
 * makes no call at all, so the pass that follows costs exactly what it costs on
 * a router that was never on 3.3.x.
 *
 * There is no `present` list argument, unlike the one-to-one half's own
 * handover before it: this runs *before* the refresh reads anything, and the
 * reply to each call already carries the section the router made of it, which
 * is the only thing a prior read would have been consulted for. Both calls are
 * create-and-edit in one and both are given the same stamped numbers every
 * time, so re-offering a section that already exists is a call the daemon finds
 * nothing to change in - which is what makes a crash between "the router
 * confirmed it" and "the record is gone" a retry rather than a repair.
 *
 * Returns rather than throws. Every path into this is a refresh with other work
 * to do; a handover that could not finish is a sentence on the page and another
 * attempt in a few seconds, not a reason to abandon the rows.
 */
export async function handoverPending(runtime: BindingRuntime): Promise<HandoverOutcome> {
  const data = runtime.store.read()
  if (data.instances.length === 0 && data.direct.length === 0) return NOTHING

  // Not connected is deliberately silent rather than `stalled`. The stalled
  // sentence tells somebody their router has no packages on it, and saying that
  // about a router nobody can currently reach would be a fact stated about
  // something unread - the refresh already says the connection is down.
  if (!runtime.ctx.connected) return NOTHING

  if (!daemonReady(runtime)) {
    return {
      wrote: 0,
      dropped: 0,
      stranded: [],
      stalled: { instances: data.instances.length, bindings: data.direct.length },
      sweeping: olderDaemonRunning(runtime)
    }
  }

  const deps = agentDeps(runtime)
  const generation = runtime.generation
  const outcome: HandoverOutcome = {
    wrote: 0,
    dropped: 0,
    stranded: [],
    stalled: { instances: 0, bindings: 0 },
    sweeping: false
  }

  // Checked between records for the reason every mutation in this folder checks
  // it: each call is seconds against the router, and a machine switched inside
  // that window must not have a record dropped from a document that is no
  // longer the one these rules belong to.
  const alive = (): boolean => generation === runtime.generation && runtime.ctx.connected

  // Both lists are copied before they are walked, because forgetting a record
  // replaces the array being walked with a shorter one.
  await handOverBindings(runtime, deps, [...data.direct], outcome, alive)

  for (const record of [...data.instances]) {
    if (!alive()) return outcome
    await handOverInstance(runtime, deps, record, outcome)
  }

  return outcome
}

/** The address or the MAC, whichever this binding was created against. */
function targetLabel(record: DirectBindingRecord): string {
  return record.target.kind === 'ip' ? record.target.ip : record.target.mac
}

function strand(
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
function refusal(
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
 * Every one-to-one binding this module still holds, offered in batches.
 *
 * One call per two hundred rather than one per record, and at the size this
 * release is about that is the difference between three round trips and five
 * hundred - each of which would be its own commit to the router's flash and its
 * own reconcile pass, while the page showed nothing.
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
async function handOverBindings(
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
    if (!safeUciWord(record.wan) || (record.lan !== '' && !safeUciWord(record.lan))) {
      strand(
        outcome,
        'binding',
        id,
        record.name,
        `it names an interface this module will not write to the router's configuration ("${record.wan}")`
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

  for (let at = 0; at < pending.length; at += HANDOVER_CHUNK) {
    if (!alive()) return

    const batch = pending.slice(at, at + HANDOVER_CHUNK)
    const confirmed: DirectBindingRecord[] = []
    const reply = await wanbindBindMany(deps, batch.map((one) => one.spec))

    if (!alive()) return

    if (!reply.ok || !reply.data || reply.data.ok === false) {
      const why =
        reply.data?.reason ?? reply.error ?? 'the router did not say why it would not take them'

      for (const one of batch) strand(outcome, 'binding', one.id, one.record.name, why)
      continue
    }

    const rows = new Map(reply.data.results.map((row) => [row.id, row]))

    // The batch reply says what was *written*, and written is not the same as
    // kept: the daemon's own configuration reader runs afterwards, and a
    // section it throws out is on the router and is still not a binding - it
    // installs no rule and seats nobody. The single form got that verdict back
    // in the same reply; the batch form does not carry it, so the list is read
    // once per batch rather than once per record.
    //
    // A list this module cannot read is not taken as approval. Every record in
    // the batch is kept and named, and the next tick offers them again - which
    // costs one repeated call and never drops a record on a silence.
    const listed = await wanbindBindings(deps)
    const held = new Map(
      (listed.ok && listed.data ? listed.data.bindings : []).map((row) => [row.id, row])
    )
    const readable = listed.ok && Boolean(listed.data)

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

      if (!readable) {
        strand(
          outcome,
          'binding',
          one.id,
          one.record.name,
          'the router took it and then would not list what it now holds, so this module cannot tell whether the section it wrote is one the daemon will act on'
        )
        continue
      }

      const refused = refusal({ ok: true, error: null }, held.get(one.id))

      if (refused) {
        strand(outcome, 'binding', one.id, one.record.name, refused)
        continue
      }

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

/**
 * One instance, offered with the layout its rules and its catch-all were
 * written against.
 *
 * The three timing settings the old writer also stamped - the WAN warn uptime,
 * the error grace and the release grace - are deliberately not sent. They are
 * knobs about how long the daemon waits, not numbers any standing rule was
 * written at, and this folder holds no copy of them on purpose: a number kept
 * on both sides is a number the two halves can quietly come to disagree about.
 * Omitted, the section inherits the router's own, which is where they belong
 * from now on.
 *
 * `clients_per_wan` is not sent either, for a plainer reason: the record has no
 * such field. Every instance this module ever wrote gave each client a WAN of
 * its own, which is what the daemon does with the field absent.
 */
async function handOverInstance(
  runtime: BindingRuntime,
  deps: AgentDeps,
  record: BindingInstanceRecord,
  outcome: HandoverOutcome
): Promise<void> {
  const id = wanbindSection(record.id)

  // The same last gate the one-to-one half applies, and the same reason.
  if (!safeUciWord(record.lan) || !safeUciWord(record.carrier)) {
    strand(
      outcome,
      'instance',
      id,
      record.name,
      `it names an interface this module will not write to the router's configuration ("${record.lan}" over "${record.carrier}")`
    )
    return
  }

  const source = record.source
  const layout = record.layout
  const spec: WanbindInstanceSpec = {
    name: record.name,
    lan: record.lan,
    carrier: record.carrier,
    sticky: record.sticky,
    remap: record.remap,
    enabled: record.running,
    // The range is sent because leaving it out would not leave the instance as
    // it is - it would widen it to the whole LAN, and the fail-closed catch-all
    // is written for exactly the addresses the scope covers. An instance that
    // silently started fencing every address on its LAN is a change nobody
    // asked for, made during a handover nobody pressed.
    ...(source?.kind === 'range' ? { range_from: source.from, range_to: source.to } : {}),
    // Stamped, and absent only on a record written before this module stamped
    // them at all. There is no fallback to derive here and that is deliberate:
    // this folder keeps no priority band of its own, so the only honest
    // alternative is to let the daemon allocate. The instance then works from
    // its own rules, and whatever the old build left behind is a rule with no
    // owner - which the rules monitor names outright, and which nothing else
    // this module could do would have removed either.
    ...(layout
      ? {
          rule_pref_base: layout.rulePrefBase,
          // The instance's own slot, so two instances on one router never share
          // a catch-all priority - the same sum the old writer wrote.
          catch_all_pref: layout.catchAllPrefBase + record.slot,
          catch_all_table: layout.catchAllTable
        }
      : {})
  }

  const written = await wanbindInstanceSet(deps, id, spec)
  if (written.ok) outcome.wrote += 1
  const refused = refusal(written, written.data?.instance)
  if (refused) {
    strand(outcome, 'instance', id, record.name, refused)
    return
  }

  forget(
    runtime,
    'instance',
    record.id,
    `binding instance ${record.name} (${record.lan} over ${record.carrier}) is now kept by the router's bm-wanbind, and this module no longer holds a record of it`
  )
  outcome.dropped += 1
}

/**
 * The record goes, and with it every claim this module had on the router's
 * routing tables and on where a device was last placed.
 *
 * Write-through, exactly as a delete is: the record is the only thing that
 * would make this module write a rule for this again, and a crash inside the
 * debounce would bring it back as a second writer.
 *
 * Three things go with it and one deliberately does not. The `option ip4table`
 * this module wrote stays on the router - the daemon never takes one back
 * either - but the *claim* on it does not, because the claim exists to say
 * which record may remove it and there is no longer a record; the WAN's table
 * belongs to the router now, which is the truth. The sticky entries go for the
 * same reason: they are this module's memory of where it last put a device, and
 * it does not place devices any more. The event ring stays, because it is the
 * only history of what this instance did and history is not state.
 */
function forget(
  runtime: BindingRuntime,
  kind: HandoverKind,
  id: string,
  message: string
): void {
  runtime.store.updateNow((data) => {
    // One array or the other, never "whichever holds this id". The two halves
    // generate their ids independently, and a sweep across both would let one
    // handover delete the other half's record on a collision nobody had ruled
    // out - a record gone with its rules still standing and nothing left that
    // could ever remove them.
    if (kind === 'instance') {
      data.instances = data.instances.filter((entry) => entry.id !== id)
      data.stickyMap = data.stickyMap.filter((entry) => entry[0] !== id)
    } else {
      data.direct = data.direct.filter((entry) => entry.id !== id)
    }
    data.extraTables = data.extraTables.filter((entry) => entry[2] !== id)
  })
  // The module-wide trail, not the instance's own ring: the ring belongs to a
  // record that no longer exists, and a line written into it would be a line
  // about something the reader can find nowhere else on the page.
  recordEvent(runtime, 'handover', message)
}
