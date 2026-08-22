/**
 * Small sequential job runner for router mutations.
 *
 * Callers must make each item a chunk or wave, never an individual PPPoE
 * connection. A 5,000-account import with chunks of 100 therefore has about
 * fifty live items instead of 5,000.
 */
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'

export type JobItemStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped' | 'cancelled'
export type JobState = 'running' | 'done' | 'failed' | 'partial' | 'cancelled'
export type FinishedJobState = Exclude<JobState, 'running'>

export interface JobItem {
  idx: number
  name: string
  status: JobItemStatus
  message?: string
  ms?: number
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

export type FinishedJobItem = Omit<JobItem, 'status'> & {
  status: Exclude<JobItemStatus, 'pending' | 'running'>
}

export interface FinishedJob extends Omit<OpenWrtJob, 'state' | 'finishedAt' | 'items'> {
  state: FinishedJobState
  finishedAt: number
  items: FinishedJobItem[]
}

export interface JobsSnapshot {
  t: number
  jobs: OpenWrtJob[]
  running: OpenWrtJob[]
  finished: OpenWrtJob[]
}

export interface JobItemSpec {
  /** A chunk/wave label safe to retain in job history. */
  name: string
  /**
   * Work already in flight is not killed. Check `cancelled` within long waits,
   * and never put credentials in a returned message or thrown error.
   */
  run: (cancelled: () => boolean) => Promise<void | string>
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

export const MAX_FINISHED_JOBS = 10
export const MAX_HISTORY_ITEMS = 30
const EMIT_THROTTLE_MS = 500

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cloneItem(item: FinishedJobItem): FinishedJobItem {
  return {
    idx: item.idx,
    name: item.name,
    status: item.status,
    ...(item.message ? { message: item.message } : {}),
    ...(typeof item.ms === 'number' ? { ms: item.ms } : {})
  }
}

/**
 * Keep failures/cancellations first when trimming, then restore display order.
 * This also makes histories written by an older, less tightly capped build
 * safe to expose through the latest stream.
 */
export function trimFinishedJob(job: FinishedJob): FinishedJob {
  const items = Array.isArray(job.items) ? job.items : []
  const selected =
    items.length <= MAX_HISTORY_ITEMS
      ? items
      : [
          ...items.filter((item) => item.status === 'error' || item.status === 'cancelled'),
          ...items.filter((item) => item.status !== 'error' && item.status !== 'cancelled')
        ].slice(0, MAX_HISTORY_ITEMS)
  return {
    ...job,
    cancelRequested: undefined,
    items: selected.map(cloneItem).sort((a, b) => a.idx - b.idx)
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
    const jobs = this.list()
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
        this.updateProgress(job)
        this.emit()
        try {
          const note = await source.run(cancelled)
          if (!this.current(generation)) return
          item.status = 'ok'
          if (typeof note === 'string' && note.trim()) item.message = note.trim()
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
