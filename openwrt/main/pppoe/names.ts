/**
 * Which interface sections a batch record covers.
 *
 * The record stores a range, not a list, so every path that needs the names -
 * rows, actions, delete, the firewall membership list - derives them the same
 * way from the same three fields. A record that was shrunk after a half-failed
 * create therefore stops naming the sections that never reached the router the
 * moment it is written, with nothing left to keep in step.
 */
import { pppoeSectionName } from '../uci'
import type { PppoeBatchRecord } from '../records'

/**
 * A ceiling no configured rule can raise. `maxBatchRows` is operator-editable
 * and a stored record can be older than the rules it was created under, so both
 * the check and the name expansion clamp against this rather than trusting what
 * the document claims.
 */
export const HARD_MAX_BATCH_ROWS = 5_000

export function batchSequences(batch: PppoeBatchRecord): number[] {
  const from = Math.max(1, Math.trunc(batch.seqFrom))
  const available = Math.max(0, Math.trunc(batch.seqTo) - from + 1)
  const declared = Math.max(0, Math.trunc(batch.count))
  const count = Math.min(HARD_MAX_BATCH_ROWS, available, declared || available)
  return Array.from({ length: count }, (_, index) => from + index).filter(
    (seq) => seq <= 99_999
  )
}

export function allBatchNames(batch: PppoeBatchRecord): string[] {
  return batchSequences(batch).map((seq) => pppoeSectionName(batch.prefix, seq))
}
