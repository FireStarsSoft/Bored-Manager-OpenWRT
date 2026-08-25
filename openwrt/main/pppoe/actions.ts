/**
 * Start, stop and redial - by batch, by selection, and by the watchdog that
 * nobody asked for.
 *
 * Every one of them ends up in `startActionJob`, which is where the two rules
 * that make a wave survivable live: the requested names are filtered against
 * what netifd actually has before the script is written, and everything but
 * `stop` runs best-effort and is verified afterwards rather than trusted.
 */
import type { OkResult } from '@shared/types'
import type { FinishedJob, JobSpec, OpenWrtJob } from '../jobs'
import {
  UciCancelledError,
  applyInterfaceWave,
  chunkValues,
  effectivePppoeChunkSize,
  isManagedSectionName,
  waitCancelable,
  type InterfaceAction
} from '../uci'
import { allBatchNames } from './names'
import {
  clearRowCache,
  currentModel,
  forceDump,
  recordEvent,
  timeoutMs,
  type PppoeRuntime
} from './runtime'
import type { PppoeRow } from './types'
import { emitSummary, rowsByBatch } from './view'

function isAction(value: unknown): value is InterfaceAction {
  return value === 'start' || value === 'stop' || value === 'redial'
}

function actionTitle(action: InterfaceAction): string {
  return action === 'start' ? 'Start' : action === 'stop' ? 'Stop' : 'Redial'
}

export function batchAction(
  runtime: PppoeRuntime,
  idRaw: unknown,
  actionRaw: unknown
): OkResult {
  const id = typeof idRaw === 'string' ? idRaw : ''
  const batch = runtime.store.read().batches.find((entry) => entry.id === id)
  if (!batch) return { ok: false, error: 'no such PPPoE batch' }
  if (runtime.deleting.has(id)) return { ok: false, error: 'that batch is being deleted' }
  if (runtime.creating.has(id)) {
    return { ok: false, error: 'that batch is still being created - wait for the job to finish' }
  }
  if (!isAction(actionRaw)) return { ok: false, error: `"${String(actionRaw)}" is not a PPPoE action` }
  const job = startActionJob(
    runtime,
    actionRaw,
    allBatchNames(batch),
    `${actionTitle(actionRaw)} batch ${batch.name}`,
    `pppoe-batch-${actionRaw}`
  )
  return { ok: true, data: job.id }
}

export function connAction(
  runtime: PppoeRuntime,
  namesRaw: unknown,
  actionRaw: unknown
): OkResult {
  if (!isAction(actionRaw)) return { ok: false, error: `"${String(actionRaw)}" is not a PPPoE action` }
  // A row action sends one name, a bulk action sends the selection. Both end
  // up here, and the filtering below is what makes the single-name form no
  // weaker than the list: an id that is not part of a managed batch is
  // dropped either way.
  const selected = Array.isArray(namesRaw)
    ? namesRaw.map(String)
    : typeof namesRaw === 'string' && namesRaw
      ? [namesRaw]
      : []
  if (!selected.length) return { ok: false, error: 'nothing was selected' }
  const data = runtime.store.read()
  const deletingNames = new Set(
    data.batches.filter((batch) => runtime.deleting.has(batch.id)).flatMap(allBatchNames)
  )
  if (selected.some((name) => deletingNames.has(name))) {
    return { ok: false, error: 'one or more selected interfaces is being deleted' }
  }
  const creatingNames = new Set(
    data.batches.filter((batch) => runtime.creating.has(batch.id)).flatMap(allBatchNames)
  )
  if (selected.some((name) => creatingNames.has(name))) {
    return { ok: false, error: 'one or more selected interfaces is still being created' }
  }
  const managed = new Set(data.batches.flatMap(allBatchNames))
  const names = [...new Set(selected)].filter((name) => managed.has(name) && isManagedSectionName(name))
  if (!names.length) return { ok: false, error: 'none of the selected interfaces belongs to a managed batch' }
  const job = startActionJob(
    runtime,
    actionRaw,
    names,
    `${actionTitle(actionRaw)} ${names.length} PPPoE connection${names.length === 1 ? '' : 's'}`,
    `pppoe-connection-${actionRaw}`
  )
  return { ok: true, data: job.id }
}

/**
 * Split a requested selection into the sections netifd currently knows about
 * and the ones it does not.
 *
 * A wave runs as one `sh` script. Under `set -e` a single `ifdown` on a
 * section that is not there stops the script where it stands, so every
 * healthy session earlier in the same wave is left down and never reaches its
 * `ifup`. Dropping the unknown names before the script is written is what
 * makes that impossible rather than merely unlikely.
 *
 * Fails open on purpose: before the first sample the model lists nothing, and
 * filtering against it then would refuse every action on a router that is
 * simply still being read.
 */
function liveSubset(
  runtime: PppoeRuntime,
  names: readonly string[]
): { live: string[]; skipped: string[] } {
  const known = new Set((currentModel(runtime)?.ifaces ?? []).map((iface) => iface.name))
  if (known.size === 0) return { live: [...names], skipped: [] }
  const live: string[] = []
  const skipped: string[] = []
  for (const name of names) (known.has(name) ? live : skipped).push(name)
  return { live, skipped }
}

function startActionJob(
  runtime: PppoeRuntime,
  action: InterfaceAction,
  requested: readonly string[],
  label: string,
  kind: string,
  after?: (job: FinishedJob) => void | Promise<void>
): OpenWrtJob {
  const rules = runtime.config.effectiveRules()
  const { live, skipped } = liveSubset(runtime, requested)
  const size = effectivePppoeChunkSize(live.length, rules.uciChunkSize)
  const waves = live.length ? chunkValues(live, size) : []
  const items: JobSpec['items'] = []

  if (skipped.length) {
    const shown = skipped.slice(0, 5).join(', ')
    const note =
      `${skipped.length} of ${requested.length} interface${requested.length === 1 ? '' : 's'} ` +
      `${skipped.length === 1 ? 'is' : 'are'} not on the router and ` +
      `${skipped.length === 1 ? 'was' : 'were'} skipped: ${shown}` +
      (skipped.length > 5 ? `, and ${skipped.length - 5} more` : '')
    items.push({
      name: 'Skip interfaces the router does not have',
      run: async () => {
        recordEvent(runtime, `pppoe-${action}`, note)
        return { warning: note }
      }
    })
  }

  for (const [index, wave] of waves.entries()) {
    items.push({
      name: `${actionTitle(action)} wave ${index + 1}/${waves.length}`,
      run: async (cancelled) => {
        try {
          // `stop` stays strict: it is the action whose failure the user has
          // to know about, and the filtering above already removed the one
          // input that made it fail spuriously. `start` and `redial` run
          // best-effort because "already down" is not an error when the point
          // of the wave is to bring the session back - and because a wave
          // that stops half-way through leaves sessions down that nothing
          // will bring up again. The verification item below reads the real
          // state rather than trusting the exit code.
          await applyInterfaceWave(runtime.ctx, wave, action, timeoutMs(rules), {
            bestEffort: action !== 'stop'
          })
          for (const name of wave) {
            if (action === 'stop') runtime.manuallyStopped.add(name)
            else runtime.manuallyStopped.delete(name)
          }
          // The row cache keys on the size of that set, and a stop of one
          // session followed by a start of another leaves the size where it
          // was while every row it decides has changed.
          clearRowCache(runtime)
        } finally {
          forceDump(runtime)
        }
        if (index + 1 < waves.length && rules.chunkDelayMs > 0 && !cancelled()) {
          try {
            await waitCancelable(rules.chunkDelayMs, cancelled)
          } catch (error) {
            if (!(error instanceof UciCancelledError)) throw error
          }
        }
      }
    })
  }

  if (waves.length && action !== 'stop') {
    items.push({
      /**
       * What `bestEffort` gives up, this gets back. It cannot assert the
       * sessions are up - PPPoE takes seconds to dial and would report a
       * false failure - so it asserts the thing that is true immediately: a
       * section netifd accepted is a section netifd still lists.
       */
      name: `Verify ${live.length} interface${live.length === 1 ? '' : 's'} after ${actionTitle(action).toLowerCase()}`,
      run: async () => {
        forceDump(runtime)
        await runtime.service.refreshNow?.()
        const known = new Set((currentModel(runtime)?.ifaces ?? []).map((iface) => iface.name))
        if (known.size === 0) return
        const gone = live.filter((name) => !known.has(name))
        if (!gone.length) return
        const note =
          `${gone.length} of ${live.length} interface${live.length === 1 ? '' : 's'} ` +
          `disappeared from netifd: ${gone.slice(0, 5).join(', ')}` +
          (gone.length > 5 ? `, and ${gone.length - 5} more` : '')
        recordEvent(runtime, `pppoe-${action}`, note)
        return { warning: note }
      }
    })
  }

  return runtime.jobs.start({
    kind,
    label,
    onError: 'continue',
    items,
    onFinished: async (finished) => {
      forceDump(runtime)
      emitSummary(runtime)
      await after?.(finished)
    }
  })
}

/**
 * Optional slow-tick rescue. netifd already retries by itself, so the default
 * rule is zero/off and no timer exists here.
 */
export function watchdog(runtime: PppoeRuntime, now = Date.now()): string | null {
  const rules = runtime.config.effectiveRules()
  const minutes = Math.max(0, Math.trunc(rules.autoRedialAfterMin))
  if (minutes <= 0) {
    runtime.errorSince.clear()
    return null
  }
  if (
    runtime.watchdogJobId &&
    runtime.jobs.list().some((job) => job.id === runtime.watchdogJobId && job.state === 'running')
  ) {
    return null
  }
  runtime.watchdogJobId = null

  // Not `rows(runtime, 'errors')`: that flattens every batch into display rows
  // with no batch id left on them, so the watchdog was the one action path with
  // no `deleting` guard. A delete stops its sections wave by wave, and every
  // `ifdown` makes the next slow tick see another error row - so the watchdog
  // redialed exactly the sessions the delete had just taken down, against UCI
  // that was being removed under it. `creating` is its twin, for the same
  // reason `batchAction` refuses both.
  const errors: PppoeRow[] = []
  for (const [batchId, batchRows] of rowsByBatch(runtime, now)) {
    if (runtime.deleting.has(batchId) || runtime.creating.has(batchId)) continue
    for (const row of batchRows) {
      if (row.status === 'error' && !runtime.manuallyStopped.has(row.name)) errors.push(row)
    }
  }
  const current = new Set(errors.map((row) => row.name))
  for (const name of runtime.errorSince.keys()) {
    if (!current.has(name)) runtime.errorSince.delete(name)
  }
  const threshold = minutes * 60_000
  const due: string[] = []
  for (const row of errors) {
    const since = runtime.errorSince.get(row.name)
    if (since === undefined) {
      runtime.errorSince.set(row.name, now)
    } else if (now - since >= threshold) {
      due.push(row.name)
    }
  }
  if (!due.length) return null

  const job = startActionJob(
    runtime,
    'redial',
    due,
    `Watchdog redial ${due.length} stuck PPPoE connection${due.length === 1 ? '' : 's'}`,
    'pppoe-watchdog',
    (finished) => {
      runtime.watchdogJobId = null
      const resetAt = Date.now()
      for (const name of due) runtime.errorSince.set(name, resetAt)
      recordEvent(
        runtime,
        'pppoe-watchdog',
        `Watchdog redial job ${finished.state} for ${due.length} connection${due.length === 1 ? '' : 's'}`
      )
    }
  )
  runtime.watchdogJobId = job.id
  recordEvent(
    runtime,
    'pppoe-watchdog',
    `Started watchdog redial for ${due.length} connection${due.length === 1 ? '' : 's'}`
  )
  return job.id
}
