/**
 * Which numeric routing table each WAN owns, where that answer comes from, and
 * what to do when the router loses it.
 *
 * A binding rule is nothing but "this source IP looks up that table", so the
 * WAN-to-table map is the one fact the whole feature rests on. It is assembled
 * from four sources of decreasing doubt, written when an instance is prepared,
 * and audited on every slow tick because a deleted `option ip4table` survives
 * in the running netifd state until the next reboot and then silently strands
 * every assignment pointing at it.
 */
import { shQuote } from '@shared/shell'
import type { OwrtRules } from '../config'
import { recordLayout } from '../records'
import type { OwrtHostData } from '../store'
import type { RouterModel } from '../types'
import { poolIfaces } from './pool'
import { ENGINE_STOPPED, exclusive, shellFailure, uciWrite } from './runtime'
import { UCI_SECTION } from './uci-doc'
import type {
  BindingRuntime,
  TablePreparation,
  WanTableIndex,
  WanTableSource
} from './types'

/**
 * A list an event line can carry. Event text is truncated at 500 characters,
 * and one bad restore can strip `option ip4table` from every WAN on the router
 * at once - naming all 800 of them would push the sentence itself out.
 */
function briefList(items: readonly string[], max: number): string {
  return items.length <= max
    ? items.join(', ')
    : `${items.slice(0, max).join(', ')} and ${items.length - max} more`
}

/**
 * How many times the same missing set is written before the audit stops trying.
 *
 * A repair is `uci set` plus `commit network` plus `/etc/init.d/network reload`
 * on a production router. When it does not stick - a read-only overlay, a
 * config the router rewrites from somewhere else - the audit sees the identical
 * set on the next slow tick and used to write again, every tick, for as long as
 * the router stayed that way. Three rounds is enough to ride out a transient
 * failure; past that it is a standing condition and only a person can fix it.
 */
const MAX_TABLE_REPAIR_ATTEMPTS = 3

export function tableSourceEntries(
  source: WanTableSource | undefined
): Array<[string, number]> {
  if (!source) return []
  if (Array.isArray(source)) {
    return source
      .map((entry) => [String(entry[0]), Number(entry[1])] as [string, number])
      .filter((entry) => entry[0] && Number.isSafeInteger(entry[1]) && entry[1] > 0)
  }
  return Object.entries(source)
    .map(([wan, table]) => [wan, Number(table)] as [string, number])
    .filter((entry) => entry[0] && Number.isSafeInteger(entry[1]) && entry[1] > 0)
}

export function buildWanTableIndex(
  model: RouterModel,
  data: OwrtHostData,
  rules: OwrtRules,
  source?: WanTableSource
): WanTableIndex {
  const candidates = new Map<string, number>()

  // The naming convention is a fallback. Persisted and router-observed values
  // below override it.
  for (const batch of data.batches) {
    // Each batch numbers from the table base it was created under, not the one
    // configured now: a base changed after the fact would rename every table
    // this convention claims and make the reconciler write rules pointing at
    // tables no interface has.
    const base = recordLayout(batch, rules).tableBase
    for (let seq = batch.seqFrom; seq <= batch.seqTo; seq++) {
      candidates.set(`${batch.prefix}${String(seq).padStart(5, '0')}`, base + seq)
    }
  }
  for (const [wan, table] of data.extraTables) candidates.set(wan, table)
  for (const iface of model.ifaces) {
    if (iface.ip4Table != null && iface.ip4Table > 0) {
      candidates.set(iface.name, iface.ip4Table)
    }
  }
  for (const [wan, table] of tableSourceEntries(source)) candidates.set(wan, table)

  const byWan = new Map<string, number>()
  const byTable = new Map<number, string>()
  const conflicts: WanTableIndex['conflicts'] = []
  const conflictedTables = new Map<number, string>()
  for (const [wan, table] of candidates) {
    const firstConflict = conflictedTables.get(table)
    if (firstConflict) {
      conflicts.push({ table, first: firstConflict, second: wan })
      byWan.delete(wan)
      continue
    }
    const oldWan = byTable.get(table)
    if (oldWan && oldWan !== wan) {
      conflicts.push({ table, first: oldWan, second: wan })
      conflictedTables.set(table, oldWan)
      byWan.delete(oldWan)
      byWan.delete(wan)
      byTable.delete(table)
      continue
    }
    byWan.set(wan, table)
    byTable.set(table, wan)
  }
  return { byWan, byTable, conflicts }
}

/**
 * Slow-tick ownership audit. A deleted `option ip4table` would otherwise
 * survive in the running netifd state until the next reboot, then silently
 * strand every sticky assignment that points at it.
 *
 * Repairing it writes to the router's own network config and reloads netifd,
 * which is not something to do behind an operator's back on a production
 * box - hence the `autoRepairTables` rule. Switched off, the audit still runs
 * and still says what it found; it just does not act on it. Either way the
 * finding is now an event, because the app log is not somewhere anyone looks.
 */
export async function reconcileWanTables(
  runtime: BindingRuntime,
  source: WanTableSource
): Promise<void> {
  runtime.manualWanTables = source
  if (
    runtime.disposed ||
    !runtime.latestModel ||
    runtime.store.read().instances.length === 0
  ) {
    return
  }
  await exclusive(runtime, async () => {
    const model = runtime.latestModel
    if (!model || runtime.disposed) return
    const data = runtime.store.read()
    const rules = runtime.options.rules()
    const observed = new Map(tableSourceEntries(source))
    const expected = new Map<string, number>()
    for (const batch of data.batches) {
      const base = recordLayout(batch, rules).tableBase
      for (let seq = batch.seqFrom; seq <= batch.seqTo; seq++) {
        expected.set(`${batch.prefix}${String(seq).padStart(5, '0')}`, base + seq)
      }
    }
    for (const [wan, table] of data.extraTables) expected.set(wan, table)
    for (const iface of model.ifaces) {
      if (iface.ip4Table != null && !expected.has(iface.name)) {
        expected.set(iface.name, iface.ip4Table)
      }
    }

    const missing = new Map<string, number>()
    const conflicts: string[] = []
    for (const instance of data.instances) {
      for (const iface of poolIfaces(model, instance.lan, instance.carrier)) {
        const wanted = expected.get(iface.name)
        if (wanted == null || !UCI_SECTION.test(iface.name)) continue
        const current = observed.get(iface.name)
        if (current == null) missing.set(iface.name, wanted)
        else if (current !== wanted) {
          conflicts.push(`${iface.name}: expected ${wanted}, found ${current}`)
        }
      }
    }
    conflicts.sort()
    const warning = conflicts.join('; ')
    if (warning && warning !== runtime.lastTableAuditWarning) {
      runtime.ctx.log(`openwrt: WAN table ownership conflict; not overwriting (${warning})`)
      // Never repaired, rule or no rule: a table number something else has
      // already claimed is not ours to take back.
      runtime.options.event?.(
        'wan-table-conflict',
        `${conflicts.length} WAN(s) point at a routing table this module did not assign, so option ip4table is left alone (${briefList(conflicts, 3)})`
      )
    }
    runtime.lastTableAuditWarning = warning
    if (missing.size === 0) {
      // Nothing outstanding, so losing the same option again later is news
      // rather than a repeat of the notice below, and the next loss gets its
      // own full quota of repair attempts.
      runtime.lastTableRepairNotice = ''
      runtime.tableRepairAttempts = 0
      return
    }

    const entries = [...missing].map(([wan, table]) => ({ wan, table }))
    const names = entries.map((entry) => entry.wan).sort()
    /**
     * Latched on the exact set, and on which of the two things this rule says
     * to do about it. Left unrepaired the condition stays true on every slow
     * tick until someone acts, and one notice per tick would be the only thing
     * left in a 100-entry ring within two hours. The latch is cleared above
     * the moment an audit comes back clean.
     */
    const notice = `${rules.autoRepairTables ? 'repair' : 'hold'}:${names.join(',')}`
    if (notice !== runtime.lastTableRepairNotice) {
      runtime.lastTableRepairNotice = notice
      runtime.tableRepairAttempts = 0
      if (!rules.autoRepairTables) {
        runtime.options.event?.(
          'wan-table-missing',
          `${entries.length} WAN(s) have lost option ip4table and automatic repair is switched off; their assignments stop routing once netifd drops the running table (${briefList(names, 3)})`
        )
      }
    }
    if (!rules.autoRepairTables) return

    /**
     * The write is what the audit latches on, not the event it emitted. The
     * two used to be the same thing: the event was said once and the `uci set`
     * + `commit network` + `network reload` behind it ran again on every
     * single slow tick, silently, for as long as the router kept losing the
     * option.
     */
    if (runtime.tableRepairAttempts >= MAX_TABLE_REPAIR_ATTEMPTS) {
      if (runtime.tableRepairAttempts === MAX_TABLE_REPAIR_ATTEMPTS) {
        // Counted past the cap so this is said exactly once per set.
        runtime.tableRepairAttempts += 1
        runtime.options.event?.(
          'wan-table-repair-stopped',
          `option ip4table did not stay on ${entries.length} WAN(s) after ${MAX_TABLE_REPAIR_ATTEMPTS} repair attempts, so no further write is made; their assignments stop routing once netifd drops the running table (${briefList(names, 3)})`
        )
      }
      return
    }
    runtime.tableRepairAttempts += 1

    await runtime.store.withNetwork(async () => {
      for (let index = 0; index < entries.length; index += rules.uciChunkSize) {
        const chunk = entries.slice(index, index + rules.uciChunkSize)
        await uciWrite(
          runtime,
          'repair WAN routing tables',
          chunk.map((entry) => `set network.${entry.wan}.ip4table='${entry.table}'`),
          ['network']
        )
      }
      const reload = await runtime.ctx.exec('/etc/init.d/network reload', {
        timeoutMs: rules.execTimeoutSec * 1000
      })
      if (reload.code !== 0) throw shellFailure('reload repaired WAN tables', reload.code)
    })
    runtime.manualWanTables = [
      ...observed,
      ...entries.map((entry) => [entry.wan, entry.table] as const)
    ]
    runtime.options.requestDump?.()
    runtime.ctx.log(`openwrt: restored option ip4table on ${entries.length} WAN(s)`)
    // Said per repair that finished rather than per set, because the attempt
    // cap above is now what stops it repeating: a write that landed is worth
    // reporting, and one that threw half way is retried and reported when it
    // finally lands instead of being swallowed by the latch.
    runtime.options.event?.(
      'wan-table-repaired',
      `Restored option ip4table on ${entries.length} WAN(s) and reloaded the network (${briefList(names, 3)})`
    )
  })
}

/**
 * Attach the owning instance to the table assignments its preparation wrote,
 * called from the same store write that first puts the instance record in the
 * document. Ownership is what lets the assignment be dropped again when the
 * instance is deleted, instead of overriding the WAN-to-table map for the life
 * of the router.
 */
export function claimExtraTables(
  data: OwrtHostData,
  instanceId: string,
  wans: readonly string[]
): void {
  const claimed = new Set(wans)
  data.extraTables = data.extraTables.map((entry) =>
    claimed.has(entry[0]) ? [entry[0], entry[1], instanceId] : entry
  )
}

export async function applyTableChunk(
  runtime: BindingRuntime,
  chunk: readonly TablePreparation[],
  timeoutMs: number,
  preparationId: string
): Promise<void> {
  if (chunk.length === 0) return
  const owners = new Map<number, string>()
  for (const [wan, table] of runtime.store.read().extraTables) {
    if (!owners.has(table)) owners.set(table, wan)
  }
  for (const [id, preparation] of runtime.preparations) {
    for (const entry of preparation.tableAdds) {
      if (id !== preparationId && !owners.has(entry.table)) {
        owners.set(entry.table, entry.wan)
      }
    }
  }
  const lines: string[] = []
  for (const entry of chunk) {
    if (!UCI_SECTION.test(entry.wan)) throw new Error(`unsafe WAN section ${entry.wan}`)
    const owner = owners.get(entry.table)
    if (owner && owner !== entry.wan) {
      throw new Error(`routing table ${entry.table} was claimed by ${owner}`)
    }
    lines.push(`set network.${entry.wan}.ip4table='${entry.table}'`)
  }
  // Serialized against every other writer of /etc/config/network. A PPPoE
  // create committing a chunk at the same moment reads the file, applies its
  // own sections and writes the whole thing back, so whichever of the two
  // finishes second silently discards the other - a hundred live sections, or
  // this pool's entire table map, gone with no error anywhere.
  await runtime.store.withNetwork(() =>
    uciWrite(runtime, 'write WAN routing tables', lines, ['network'])
  )
  if (runtime.disposed) throw new Error(ENGINE_STOPPED)
  // The UCI mutation is already durable even if a later ifup fails. Remember
  // it now so a cancelled/partial preparation never loses the table mapping.
  runtime.store.update((data) => {
    // Written without an owner. The instance record does not exist yet - it is
    // pushed by the last item of the same job - and an entry naming an
    // instance the document does not have would be pruned as an orphan on the
    // very next read. `claimExtraTables` stamps ownership once the instance
    // lands; a preparation that never gets that far leaves the entry unowned,
    // which is honest: the UCI write did happen.
    const map = new Map(data.extraTables.map((entry) => [entry[0], entry]))
    for (const entry of chunk) map.set(entry.wan, [entry.wan, entry.table])
    data.extraTables = [...map.values()]
  })

  const restarted = await runtime.ctx.exec('sh -s', {
    stdin: `set -e\n${chunk.map((entry) => `ifup ${shQuote(entry.wan)}`).join('\n')}\n`,
    timeoutMs
  })
  if (restarted.code !== 0) throw shellFailure('restart prepared WANs', restarted.code)
  if (runtime.disposed) throw new Error(ENGINE_STOPPED)
  runtime.options.requestDump?.()
}
