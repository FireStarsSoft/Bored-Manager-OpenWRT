/**
 * What happens to the bindings this module wrote, on the day the router learns
 * to write them itself.
 *
 * The situation is a router carrying one-to-one bindings this module created -
 * a record each in the per-router document, one `ip rule` each in the direct
 * band, a `bmd<slot>_` firewall forwarding each - which then gets a `bm-wanbind`
 * new enough to advertise `direct`. The same binding is now described in two
 * places, and `binding/router.ts` says what two writers of one ip rule range
 * means.
 *
 * **Doing nothing is not the safe option here, and that is what decides this
 * file.** The daemon's own pass reads back every rule in its band - and the
 * band it ships with is 19000, which is the band this module ships with - and
 * removes every one of them that no `config direct` section asks for. So a
 * router that is handed the new package with five module-written bindings on it
 * has none within thirty seconds, whatever this module chooses to do, and if
 * this module stands down at the same moment (which it must, or it becomes the
 * second writer) the page shows the router's empty list and five bindings have
 * silently ceased to exist. Waiting for the operator to press something does
 * not preserve them; it preserves the *records* while the routing quietly
 * stops, which is the "green everywhere, packets leaving by another WAN"
 * failure this module keeps warning about.
 *
 * So they are handed over, and the shape is `binding/sync.ts`'s rather than a
 * migration: **one convergent function that writes what the records say and
 * forgets a record once the router confirms it.** It runs at the top of every
 * router-owned pass, it is safe when there is nothing to do, and a binding the
 * router refuses this tick is simply retried on the next one - so an operator
 * who fixes the reason needs no button, and there is no half-finished state for
 * a crash to leave behind.
 *
 * Two decisions inside it are worth stating.
 *
 * **The stamped `pref` and `table` are sent, not omitted.** `bind` allocates
 * both when they are absent, which is right for a binding being created and
 * wrong for one that already exists: the rule standing on the router right now
 * was written at that priority, so sending the number is what makes the daemon
 * adopt that rule rather than write a second one somewhere else and leave the
 * first to be swept a moment later. It is the same rule, and the same reason,
 * as `wanbindInstanceLines` stamping an instance's own recorded layout.
 *
 * **The record is dropped once the router has it, and not kept as a spare.** A
 * dormant copy sounds harmless until the package is removed again: the record
 * would come back to life and this module would write a rule for a binding the
 * operator may have deleted on the router in between. Losing sight of a binding
 * is recoverable by looking at the router; resurrecting a deleted one is not.
 */
import {
  safeUciWord,
  wanbindBind,
  wanbindSection,
  type AgentDeps,
  type WanbindBinding
} from '../agent'
import { removeScopedForwardings } from '../binding'
import type { DirectBindingRecord } from '../store'
import { sectionPrefix } from './prepare'
import { targetLabel } from './target'
import type { DirectRuntime } from './types'

/** One record the router has not taken over, and the sentence that says why. */
export interface HandoverStranded {
  record: DirectBindingRecord
  reason: string
}

export interface HandoverOutcome {
  /** Sections written to the router this pass. */
  wrote: number
  /** Records the router confirmed and this module has therefore forgotten. */
  dropped: number
  /** Everything still described in two places, or in none. */
  stranded: HandoverStranded[]
}

const NOTHING: HandoverOutcome = { wrote: 0, dropped: 0, stranded: [] }

/**
 * Hand every module-written binding to the router, and forget the ones it has.
 *
 * `present` is the list the caller has already read, so the common case - a
 * router with no records left to move, which is every router a day after the
 * changeover - costs nothing at all beyond a map lookup per record.
 *
 * Returns rather than throws. Every path into this is a pass that has other
 * work to do; a handover that could not finish is a sentence on the page and a
 * retry in thirty seconds, not a reason to abandon the rows.
 */
export async function syncRouterDirect(
  runtime: DirectRuntime,
  deps: AgentDeps,
  present: readonly WanbindBinding[]
): Promise<HandoverOutcome> {
  const records = runtime.store.read().direct
  if (records.length === 0) return NOTHING

  const byId = new Map(present.map((binding) => [binding.id, binding]))
  const outcome: HandoverOutcome = { wrote: 0, dropped: 0, stranded: [] }

  for (const record of records) {
    if (runtime.disposed || !runtime.ctx.connected) break

    const section = wanbindSection(record.id)
    let row = byId.get(section)

    if (!row) {
      // The last gate before either reaches a config file on the router, and
      // checked here rather than trusted from the create gate for the reason
      // `wanbindInstanceLines` checks it: a per-router document can be edited
      // by hand, and an allowlist two files away is not a guarantee.
      if (!safeUciWord(record.wan) || (record.lan !== '' && !safeUciWord(record.lan))) {
        outcome.stranded.push({
          record,
          reason: `it names an interface this module will not write to the router's configuration ("${record.wan}")`
        })
        continue
      }
      const written = await wanbindBind(deps, {
        id: section,
        name: record.name,
        ...(record.target.kind === 'ip'
          ? { ip: record.target.ip }
          : { mac: record.target.mac }),
        wan: record.wan,
        ...(record.lan ? { lan: record.lan } : {}),
        whenDown: record.whenDown,
        // Stamped. See the note at the top: these are the numbers the rule
        // already on the router was written at, and sending them is what makes
        // the daemon adopt that rule instead of writing a second one.
        pref: record.pref,
        table: record.table,
        enabled: record.enabled
      })
      if (!written.ok) {
        outcome.stranded.push({
          record,
          reason: written.error ?? 'the router would not take it'
        })
        continue
      }
      outcome.wrote += 1
      row = written.data?.binding
    }

    // No row, or one the router's own configuration reader refuses. The record
    // stays: it is the only description of this binding that is not the router
    // saying it will not have it, and the row for it is drawn from the record
    // so the operator can still see and delete the thing they created.
    if (!row) {
      outcome.stranded.push({
        record,
        reason: 'the router accepted it but did not say what it did with it'
      })
      continue
    }
    if (!row.usable) {
      outcome.stranded.push({
        record,
        reason: row.reason || 'the router will not accept the section it was written into'
      })
      continue
    }

    await forget(runtime, record, row)
    outcome.dropped += 1
  }

  return outcome
}

/**
 * The record goes, and with it this module's claim on the WAN's routing table.
 *
 * The firewall forwarding is the one thing here with an ordering rule. The
 * daemon writes its own, named `bmd_<section>`, from the same LAN zone to the
 * same WAN zone - so once it is in force this module's `bmd<slot>_` sections
 * are a duplicate permitting traffic that is already permitted, and leaving
 * them would leave sections on the router that nothing can ever be asked to
 * remove. But they are only a duplicate *once the daemon's is in force*, and
 * the row says so outright: anything other than `ok` and they stay where they
 * are, because a window with no forwarding at all is the address dropped.
 *
 * Nothing here is fatal. The record is what makes a rule this module's, and a
 * binding the router now owns must not be left half-owned by both because a
 * `uci delete` did not run.
 */
async function forget(
  runtime: DirectRuntime,
  record: DirectBindingRecord,
  row: WanbindBinding
): Promise<void> {
  if (row.forwarding === 'ok') {
    try {
      await removeScopedForwardings(runtime, runtime.store, sectionPrefix(record.slot))
    } catch (error) {
      runtime.ctx.log(
        `openwrt: ${record.name} was handed to the router, but the firewall forwarding this module had written could not be removed (${
          error instanceof Error ? error.message : String(error)
        }); it permits traffic the router's own forwarding permits anyway`
      )
    }
  }

  // Write-through, exactly as a delete is: the record is the only thing that
  // would make this module write a rule for this address again, and a crash
  // inside the ten-second debounce would bring it back as a second writer.
  runtime.store.updateNow((data) => {
    data.direct = data.direct.filter((entry) => entry.id !== record.id)
    // The `option ip4table` this module wrote stays on the router - the daemon
    // never takes one back either - but the claim on it does not, because the
    // claim exists to say which record may remove it and there is no longer a
    // record. The WAN's table now belongs to the router, which is the truth.
    data.extraTables = data.extraTables.filter((entry) => entry[2] !== record.id)
  })
  runtime.memory.delete(record.id)
  runtime.options.event?.(
    'handover',
    `one-to-one binding ${record.name} (${targetLabel(record.target)} through ${record.wan}) is now kept by the router's bm-wanbind, and this module no longer holds a record of it`
  )
}
