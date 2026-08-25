/**
 * Small sequential job runner for router mutations.
 *
 * Callers must make each item a chunk or wave, never an individual PPPoE
 * connection. A 5,000-account import with chunks of 100 therefore has about
 * fifty live items instead of 5,000.
 */
import type { ModuleContext } from '@shared/modules'
import type { ValueBadge } from '@shared/module-ui'
import type { OkResult } from '@shared/types'
import { BADGE, badge, chip, statusBadges, type StatusChip, type StatusTone } from './badges'
import {
  MAX_FINISHED_JOBS,
  trimFinishedJob,
  type FinishedJob,
  type StoredJobItem,
  type StoredJobItemState,
  type StoredJobState
} from './records'

export type { FinishedJob }
/** Re-exported so call sites keep reaching it through the runner they use. */
export { trimFinishedJob }

/**
 * The live states are the persisted ones plus the two that only exist while the
 * runner is holding the job. Derived in this direction so that a state the
 * store cannot write is impossible to introduce here by accident.
 */
export type JobItemStatus = StoredJobItemState | 'pending' | 'running'
export type JobState = StoredJobState | 'running'
export type FinishedJobState = StoredJobState

export interface JobItem extends Omit<StoredJobItem, 'status'> {
  status: JobItemStatus
}

export interface OpenWrtJob {
  id: string
  kind: string
  label: string
  state: JobState
  startedAt: number
  finishedAt?: number
  total: number
  done: number
  failed: number
  progressPct: number
  /** Lets a forced cancel emit visibly differ while the in-flight item finishes. */
  cancelRequested?: boolean
  items: JobItem[]
}

export type FinishedJobItem = StoredJobItem

export interface JobItemView extends JobItem {
  statusBadges: ValueBadge[]
}

/**
 * A job as the pages read it. The extra fields exist because the alternative
 * was a table of raw words and a percentage: a `statusCards` card needs a tone
 * to tint itself with, a short subtitle and a bounded set of chips, and none of
 * that can be computed inside a JSON spec.
 */
export interface JobView extends Omit<OpenWrtJob, 'items'> {
  health: StatusTone
  /** `4/12`, for the card's title row. */
  progressLabel: string
  /** The step running now, or the first thing that went wrong. */
  note: string
  chips: StatusChip[]
  stateBadges: ValueBadge[]
  /** Wall time from start to finish; empty while the job is still running. */
  tookLabel: string
  items: JobItemView[]
}

export interface JobsSnapshot {
  t: number
  jobs: JobView[]
  running: JobView[]
  finished: JobView[]
}

/**
 * A step that finished but not cleanly - the router took the change and then
 * did not show it. Returning this instead of a plain note is what keeps a
 * firewall reload that produced no rule from being reported as a green step.
 */
export interface JobItemWarning {
  warning: string
}

export interface JobItemSpec {
  /** A chunk/wave label safe to retain in job history. */
  name: string
  /**
   * Work already in flight is not killed. Check `cancelled` within long waits,
   * and never put credentials in a returned message or thrown error.
   */
  run: (cancelled: () => boolean) => Promise<void | string | JobItemWarning>
}

export interface JobSpec {
  kind: string
  label: string
  items: JobItemSpec[]
  /** Router mutation jobs normally abort after the first failed chunk. */
  onError?: 'abort' | 'continue'
  onFinished?: (job: FinishedJob) => void | Promise<void>
}

/** The part of HostStore data this runner needs. Extra fields are untouched. */
export interface JobHistoryData {
  jobs: FinishedJob[]
}

/** HostStore satisfies this structurally without a runtime import/cycle. */
export interface JobStore<TData extends JobHistoryData = JobHistoryData> {
  read(): TData
  update<TResult>(mutate: (data: TData) => TResult): TResult
}

const EMIT_THROTTLE_MS = 500

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * How long a finished job took, in words.
 *
 * The renderer's `duration` format needs an absolute start to count from and
 * this is an elapsed amount, so it is formatted here. (`service.ts`, `pppoe.ts`
 * and `binding.ts` each grew their own copy of this arithmetic; consolidating
 * the four is a separate change from decorating the payload.)
 */
function tookLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const JOB_STATE_COLOR: Readonly<Record<JobState, string | undefined>> = {
  running: BADGE.busy,
  done: BADGE.good,
  partial: BADGE.warn,
  failed: BADGE.bad,
  cancelled: undefined
}

/** A running job is only `ok` once it is done; until then nothing has proven out. */
function jobHealth(job: OpenWrtJob, failed: number, warned: number): StatusTone {
  if (failed > 0 || job.state === 'failed') return 'bad'
  if (warned > 0 || job.state === 'partial' || job.state === 'cancelled') return 'warn'
  return job.state === 'done' ? 'ok' : 'unknown'
}

/**
 * Chips for one card, bounded regardless of how many steps the job has. A
 * 5,000-account import runs about fifty chunks and a chip per chunk would be a
 * wall; what a user needs is the step running now and how the rest divided up.
 */
function jobChips(job: OpenWrtJob, failed: number, warned: number): StatusChip[] {
  const chips: StatusChip[] = []
  const current = job.items.find((item) => item.status === 'running')
  if (current) chips.push(chip(current.name, 'unknown'))
  if (failed) chips.push(chip(`${failed} failed`, 'bad'))
  if (warned) chips.push(chip(`${warned} warning`, 'warn'))
  const counted = { ok: 0, pending: 0, skipped: 0, cancelled: 0 }
  for (const item of job.items) {
    if (item.status === 'ok') counted.ok += 1
    else if (item.status === 'pending') counted.pending += 1
    else if (item.status === 'skipped') counted.skipped += 1
    else if (item.status === 'cancelled') counted.cancelled += 1
  }
  if (counted.ok) chips.push(chip(`${counted.ok} ok`, 'ok'))
  if (counted.pending) chips.push(chip(`${counted.pending} pending`, 'unknown'))
  if (counted.skipped) chips.push(chip(`${counted.skipped} skipped`, 'unknown'))
  if (counted.cancelled) chips.push(chip(`${counted.cancelled} cancelled`, 'unknown'))
  // History keeps at most MAX_FINISHED_JOB_ITEMS steps, failures first. Counting
  // only what survived would quietly report a 60-chunk job as "30 ok"; the
  // chips have to add up to `total` or the card is lying about the job.
  const dropped = Math.max(0, job.total - job.items.length)
  if (dropped) chips.push(chip(`${dropped} not kept in history`, 'unknown'))
  return chips
}

/**
 * The read-only view of a job. Copies rather than annotates: the live job
 * objects are still being mutated by the runner, and a decorated one that
 * reached `persist` would put chips into the saved history for good.
 */
export function jobView(job: OpenWrtJob): JobView {
  const failed = job.items.filter((item) => item.status === 'error').length
  const warned = job.items.filter((item) => item.status === 'warning').length
  const current = job.items.find((item) => item.status === 'running')
  const firstBad = job.items.find(
    (item) => item.status === 'error' || item.status === 'warning'
  )
  return {
    ...job,
    items: job.items.map((item) => ({ ...item, statusBadges: statusBadges(item.status) })),
    health: jobHealth(job, failed, warned),
    progressLabel: `${job.done}/${job.total}`,
    note: current?.name ?? (firstBad ? firstBad.message ?? firstBad.name : ''),
    chips: jobChips(job, failed, warned),
    stateBadges: [
      badge(job.cancelRequested ? 'cancelling' : job.state, JOB_STATE_COLOR[job.state])
    ],
    tookLabel: job.finishedAt ? tookLabel(job.finishedAt - job.startedAt) : ''
  }
}

export function makeJobId(taken: ReadonlySet<string> = new Set()): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    if (!taken.has(id)) return id
  }
  return `job_${Date.now().toString(36)}_${taken.size.toString(36)}`
}

/** Throw this inside an item to distinguish a cooperative stop from failure. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled')
  }
}

export class Jobs<TData extends JobHistoryData = JobHistoryData> {
  private live: OpenWrtJob[] = []
  private cancelling = new Set<string>()
  private lastEmit = 0
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private lastPayload: JobsSnapshot | null = null
  private generation = 0
  private disposed = false

  constructor(
    private ctx: Pick<ModuleContext, 'emit' | 'log'>,
    private store: JobStore<TData>
  ) {}

  /** Running jobs first, followed by at most ten compatible history entries. */
  list(): OpenWrtJob[] {
    const remembered = (this.store.read().jobs ?? [])
      .slice(0, MAX_FINISHED_JOBS)
      .map((job) => trimFinishedJob(job))
    return [...this.live, ...remembered]
  }

  snapshot(): JobsSnapshot {
    const jobs = this.list().map((job) => jobView(job))
    const payload = {
      t: Date.now(),
      jobs,
      running: jobs.filter((job) => job.state === 'running'),
      finished: jobs.filter((job) => job.state !== 'running')
    }
    this.lastPayload = payload
    return payload
  }

  /** The last exact payload pushed, or a freshly built initial payload. */
  get latest(): JobsSnapshot {
    return this.lastPayload ?? this.snapshot()
  }

  get busy(): boolean {
    return this.live.length > 0
  }

  start(spec: JobSpec): OpenWrtJob {
    if (this.disposed) throw new Error('the jobs engine is disposed')
    const items = spec.items.map((item, idx) => ({
      idx,
      name: item.name,
      status: 'pending' as const
    }))
    const job: OpenWrtJob = {
      id: makeJobId(new Set(this.list().map((entry) => entry.id))),
      kind: spec.kind,
      label: spec.label,
      state: 'running',
      startedAt: Date.now(),
      total: items.length,
      done: 0,
      failed: 0,
      progressPct: items.length ? 0 : 100,
      items
    }
    this.live.unshift(job)
    this.emit(true)
    const generation = this.generation
    void this.run(job, spec, generation)
    return job
  }

  cancel(idRaw: unknown): OkResult {
    const id = typeof idRaw === 'string' ? idRaw : ''
    const job = this.live.find((entry) => entry.id === id)
    if (!job) return { ok: false, error: 'no such job, or it has already finished' }
    this.cancelling.add(id)
    job.cancelRequested = true
    this.ctx.log(`openwrt: job ${id} (${job.label}) cancellation requested`)
    // A transition must not wait behind the progress throttle.
    this.emit(true)
    return { ok: true }
  }

  clearFinished(): OkResult {
    const removed = this.store.update((data) => {
      const count = data.jobs.length
      data.jobs = []
      return count
    })
    this.emit(true)
    return { ok: true, data: String(removed) }
  }

  /**
   * A connection reset invalidates every in-flight command. Late resolutions
   * are ignored so they cannot be persisted under the next host key.
   */
  reset(): void {
    this.stopLive(false)
  }

  /** Deactivation has the same cancellation rule and permanently rejects starts. */
  dispose(): void {
    this.stopLive(true)
  }

  private stopLive(dispose: boolean): void {
    this.generation += 1
    for (const job of this.live) {
      this.cancelling.add(job.id)
      job.cancelRequested = true
    }
    this.live = []
    this.cancelling.clear()
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    this.lastPayload = null
    this.disposed = dispose
    // Say that the list is empty. A reset in the middle of a job used to clear
    // the live list without ever emitting again, so the last progress frame -
    // "Apply PPPoE chunk 3/10, 30%" - stayed on screen for the rest of the
    // session, describing a job that had been abandoned. Deactivation is the
    // one case with nobody left to tell.
    if (!dispose) this.emit(true)
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private async run(job: OpenWrtJob, spec: JobSpec, generation: number): Promise<void> {
    const cancelled = (): boolean => this.cancelling.has(job.id) || !this.current(generation)
    let aborted = false

    try {
      for (let index = 0; index < spec.items.length; index++) {
        if (!this.current(generation)) return
        const item = job.items[index]
        const source = spec.items[index]
        if (!item || !source) continue
        if (cancelled() || aborted) {
          item.status = cancelled() ? 'cancelled' : 'skipped'
          job.done += 1
          continue
        }

        item.status = 'running'
        const startedAt = Date.now()
        item.startedAt = startedAt
        this.updateProgress(job)
        this.emit()
        try {
          const note = await source.run(cancelled)
          if (!this.current(generation)) return
          const warning =
            note && typeof note === 'object' && typeof note.warning === 'string'
              ? note.warning.trim()
              : ''
          item.status = warning ? 'warning' : 'ok'
          if (warning) item.message = warning
          else if (typeof note === 'string' && note.trim()) item.message = note.trim()
        } catch (error) {
          if (!this.current(generation)) return
          if (error instanceof CancelledError || cancelled()) {
            item.status = 'cancelled'
          } else {
            item.status = 'error'
            item.message = errorMessage(error)
            job.failed += 1
            if ((spec.onError ?? 'abort') === 'abort') aborted = true
          }
        }
        item.ms = Date.now() - startedAt
        job.done += 1
        this.updateProgress(job)
        this.emit()
      }
    } catch (error) {
      if (!this.current(generation)) return
      this.ctx.log(`openwrt: job ${job.id} runner failed: ${errorMessage(error)}`)
      for (const item of job.items) {
        if (item.status !== 'pending' && item.status !== 'running') continue
        item.status = 'error'
        item.message = 'job runner stopped unexpectedly'
        job.done += 1
        job.failed += 1
      }
    }

    if (!this.current(generation)) return
    const wasCancelled = this.cancelling.has(job.id)
    for (const item of job.items) {
      if (item.status !== 'pending') continue
      item.status = wasCancelled ? 'cancelled' : 'skipped'
      job.done += 1
    }
    job.failed = job.items.filter((item) => item.status === 'error').length
    job.finishedAt = Date.now()
    job.progressPct = 100
    job.state = wasCancelled
      ? 'cancelled'
      : job.failed === 0
        ? 'done'
        : job.failed === job.total
          ? 'failed'
          : 'partial'
    delete job.cancelRequested

    this.cancelling.delete(job.id)
    this.live = this.live.filter((entry) => entry.id !== job.id)
    const finished = job as unknown as FinishedJob
    this.persist(finished)
    this.ctx.log(
      `openwrt: job ${job.id} (${job.label}) ${job.state}: ${job.total - job.failed}/${job.total} without errors`
    )
    // Finishing is a user-visible transition and must not wait for optional
    // bookkeeping (for example a defensive reload after an interrupted delete).
    this.emit(true)
    if (spec.onFinished) {
      try {
        await spec.onFinished(finished)
      } catch (error) {
        if (this.current(generation)) {
          this.ctx.log(`openwrt: job ${job.id} completion hook failed: ${errorMessage(error)}`)
        }
      }
    }
  }

  private updateProgress(job: OpenWrtJob): void {
    job.progressPct = job.total ? Math.round((job.done / job.total) * 100) : 100
  }

  private persist(job: FinishedJob): void {
    const entry = trimFinishedJob(job)
    try {
      this.store.update((data) => {
        data.jobs = [entry, ...data.jobs.filter((old) => old.id !== entry.id)].slice(0, MAX_FINISHED_JOBS)
      })
      return
    } catch (error) {
      this.ctx.log(`openwrt: full job history could not be saved: ${errorMessage(error)}`)
    }

    // A failed write may already have mutated the store's in-memory document.
    // Keep the new job exactly once and discard more old history before retrying.
    try {
      this.store.update((data) => {
        data.jobs = [entry, ...data.jobs.filter((old) => old.id !== entry.id)].slice(0, 5)
      })
    } catch (error) {
      this.ctx.log(`openwrt: job history could not be saved: ${errorMessage(error)}`)
    }
  }

  /**
   * Push at most twice a second during bursts, with a trailing update. Starts,
   * finishes and cancel requests call this with `now` and bypass the throttle.
   */
  private emit(now = false): void {
    if (this.disposed) return
    const elapsed = Date.now() - this.lastEmit
    if (!now && elapsed < EMIT_THROTTLE_MS) {
      if (!this.emitTimer) {
        this.emitTimer = setTimeout(() => {
          this.emitTimer = null
          this.emit(true)
        }, EMIT_THROTTLE_MS - elapsed)
      }
      return
    }
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    this.lastEmit = Date.now()
    const payload = this.snapshot()
    this.ctx.emit('jobs', payload)
  }
}

/** Descriptive alias for call sites that prefer the module-specific name. */
export { Jobs as OpenWrtJobs }
