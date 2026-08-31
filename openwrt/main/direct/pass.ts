/**
 * The I/O half of a reconcile: the pure pass, then the commands it produced.
 *
 * The order is the whole of it. The kernel writes go first and the caches only
 * afterwards, because a rule that failed to land must not be remembered as
 * though it had; and the diff is folded into `model.rules` on success, because
 * an Enable or a Create arriving between two fast samples would otherwise plan
 * against a snapshot that predates the rules this pass just wrote and try to
 * write them again.
 */
import {
  applyRuleDiffInMemory,
  buildWanTableIndex,
  execScript,
  lanCidr,
  ENGINE_STOPPED
} from '../binding'
import type { OwrtRules } from '../config'
import type { DirectBindingRecord } from '../store'
import type { RouterModel } from '../types'
import { directWans, planDirectReconciliation } from './reconcile'
import { emitSnapshot } from './view'
import type { DirectPolicy, DirectRuntime } from './types'

/**
 * Exactly the five settings the pure pass reads. Naming them one by one is
 * what stops it quietly growing a sixth dependency that no fixture sets.
 */
export function directPolicy(rules: OwrtRules): DirectPolicy {
  return {
    directPrefBase: rules.directPrefBase,
    catchAllTable: rules.catchAllTable,
    ruleChunkLines: rules.ruleChunkLines,
    releaseGraceSec: rules.releaseGraceSec,
    wanWarnUptimeSec: rules.wanWarnUptimeSec
  }
}

/**
 * The subnet each stamped LAN carries right now, and only the LANs some record
 * actually names.
 *
 * Read from this tick's sample rather than from the plan the binding was
 * created against, because a LAN that has been renumbered under a device is one
 * of the two ways an address ends up outside the zone its firewall forwarding
 * was written from - the other being the device roaming to a different LAN
 * entirely. Both look the same from here, and both have to be caught.
 *
 * A LAN the sample does not carry simply has no entry, which the pass reads as
 * "not sampled" rather than as "the device has moved".
 */
function stampedLanCidrs(
  model: RouterModel,
  records: readonly DirectBindingRecord[]
): Map<string, string> {
  const wanted = new Set(records.map((record) => record.lan))
  const cidrs = new Map<string, string>()
  for (const iface of model.ifaces) {
    if (!wanted.has(iface.name)) continue
    const cidr = lanCidr(iface)
    if (cidr) cidrs.set(iface.name, cidr)
  }
  return cidrs
}

export interface DirectPassOptions {
  /** A record that is being created and is not in the store yet. */
  extra?: readonly DirectBindingRecord[]
  /**
   * Whether this pass publishes its own snapshot. The create job says no: it
   * has to push the record first, or the rows it published would be missing the
   * very binding the job just installed.
   */
  publish?: boolean
}

/**
 * Run one pass and return the message of whatever stopped it, or null.
 *
 * Nothing here throws for a router that refused a command: the fast tick calls
 * this every two seconds and an exception per tick is not a failure mode
 * anybody can read. The callers that are a single operator action - Enable,
 * Create - turn the message back into one.
 */
export async function runDirectPass(
  runtime: DirectRuntime,
  model: RouterModel,
  options: DirectPassOptions = {}
): Promise<string | null> {
  if (runtime.disposed) return ENGINE_STOPPED
  const rules = runtime.options.rules()
  const data = runtime.store.read()
  const records: DirectBindingRecord[] = [...data.direct, ...(options.extra ?? [])]
  const tables = buildWanTableIndex(model, data, rules, runtime.options.wanTables?.())
  const result = planDirectReconciliation({
    now: model.t,
    records,
    leases: model.leases,
    rules: model.rules,
    wans: directWans(model, tables.byWan),
    lanCidrs: stampedLanCidrs(model, records),
    memory: [...runtime.memory.values()],
    policy: directPolicy(rules)
  })

  try {
    // The blackhole before anything is pointed at it: between the two, a held
    // address would be looked up in a table with no route in it, fall through
    // to the main table, and leave over the router's default connection - the
    // exact leak holding exists to prevent.
    await execScript(runtime, result.routeLines, 'install one-to-one blackhole route')
    for (const chunk of result.diff.chunks) {
      await execScript(runtime, chunk, 'reconcile one-to-one binding rules')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (options.publish !== false && !runtime.disposed) emitSnapshot(runtime, model.t, message)
    return message
  }
  if (runtime.disposed) return ENGINE_STOPPED

  applyRuleDiffInMemory(model.rules, result.diff)
  const live = new Set(records.map((record) => record.id))
  for (const id of [...runtime.memory.keys()]) {
    if (!live.has(id)) runtime.memory.delete(id)
  }
  for (const entry of result.memory) runtime.memory.set(entry.id, entry)
  for (const event of result.events) runtime.options.event?.(event.kind, event.text)
  if (options.publish !== false) emitSnapshot(runtime, model.t)
  return null
}
