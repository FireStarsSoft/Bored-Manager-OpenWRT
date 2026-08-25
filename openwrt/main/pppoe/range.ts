/**
 * Where the next batch's sequence numbers - and with them its interface names
 * and its routing tables - can go.
 *
 * Two sources have to agree before a range is free: this module's own records,
 * which may cover sections a failed create never actually wrote, and the
 * router's live UCI, which may hold sections and `ip4table` values this module
 * never wrote at all. A collision with either is skipped past rather than
 * refused, so a fragmented router still yields a range instead of a dead end.
 */
import { pppoeSectionName, pppoeTableId } from '../uci'
import type { FrozenBatchPlan, PppoeRules, PppoeStoreData, RouterInventory } from './types'

export function allocationLimit(rules: PppoeRules): number {
  return Math.min(99_999, Math.trunc(rules.catchAllTable) - Math.trunc(rules.tableBase) - 1)
}

function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom <= bTo && bFrom <= aTo
}

export function findSequenceRange(
  count: number,
  prefix: string,
  rules: PppoeRules,
  data: PppoeStoreData,
  inventory: RouterInventory
): { from: number; to: number } | null {
  const limit = allocationLimit(rules)
  const start = Math.max(1, Math.trunc(data.nextSeq) || 1)
  return (
    scanSequenceRange(count, prefix, rules, data, inventory, start, limit) ??
    (start > 1 ? scanSequenceRange(count, prefix, rules, data, inventory, 1, start - 1) : null)
  )
}

function scanSequenceRange(
  count: number,
  prefix: string,
  rules: PppoeRules,
  data: PppoeStoreData,
  inventory: RouterInventory,
  startFrom: number,
  maxFrom: number
): { from: number; to: number } | null {
  const limit = allocationLimit(rules)
  let from = Math.max(1, startFrom)
  while (from <= maxFrom && from + count - 1 <= limit) {
    const to = from + count - 1
    let movedTo = from
    for (const batch of data.batches) {
      if (overlaps(from, to, batch.seqFrom, batch.seqTo)) {
        movedTo = Math.max(movedTo, batch.seqTo + 1)
      }
    }
    if (movedTo !== from) {
      from = movedTo
      continue
    }

    let collision = 0
    for (let seq = from; seq <= to; seq++) {
      if (
        inventory.sections.has(pppoeSectionName(prefix, seq)) ||
        inventory.tables.has(pppoeTableId(rules.tableBase, seq))
      ) {
        collision = seq
        break
      }
    }
    if (collision) {
      from = collision + 1
      continue
    }
    return { from, to }
  }
  return null
}

/**
 * The apply-time re-check of what the check found free. Another batch may have
 * been created, or someone may have written the same sections by hand, in the
 * minutes the token was valid for.
 */
export function rangeStillFree(
  plan: FrozenBatchPlan,
  rules: PppoeRules,
  data: PppoeStoreData,
  inventory: RouterInventory
): boolean {
  if (
    data.batches.some((batch) =>
      overlaps(plan.seqFrom, plan.seqTo, batch.seqFrom, batch.seqTo)
    )
  ) {
    return false
  }
  for (let seq = plan.seqFrom; seq <= plan.seqTo; seq++) {
    if (
      inventory.sections.has(pppoeSectionName(plan.prefix, seq)) ||
      inventory.tables.has(pppoeTableId(rules.tableBase, seq))
    ) {
      return false
    }
  }
  return true
}
