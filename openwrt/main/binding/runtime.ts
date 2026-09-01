/**
 * The mutable state the engine carries between passes, and the three things
 * every path does with it: run one at a time, check it is still ours to touch,
 * and put lines on the router.
 *
 * Work is serialized because a reconcile awaits SSH for seconds and an action
 * arriving in that window would plan against rules the other half is still
 * writing. `workGeneration` is what makes a reset or a disconnect abandon that
 * queue instead of letting it land on a router nobody is looking at any more.
 */
import { createCheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import type { HostStore } from '../store'
import { runUciBatch } from '../uci'
import type {
  BindingCreatePlan,
  BindingEngineOptions,
  BindingRuntime,
  BindingSnapshot,
  ExecDeps,
  WanTableSource
} from './types'

/**
 * Reached from sixteen places, all of them the same three real causes. It used
 * to name an object the user has never heard of and give no cause at all, which
 * is worse than useless on a failed job item: it reads like a module bug.
 */
export const ENGINE_STOPPED =
  'the router disconnected, or the module was reset, before this finished - reconnect and try again'

/** The action-path twin of REFRESH_HINT, phrased as a sentence fragment. */
export const NO_SAMPLE = 'no router sample is available yet - run Refresh now, then try again'

export function shellFailure(label: string, code: number): Error {
  return new Error(`${label} failed (exit ${code})`)
}

/** The only thing `commandFailure` puts in a message, and all this may read back. */
const EXIT_CODE = /\(exit (-?\d+)\)/

/**
 * Every `uci` write this folder makes, through the one runner that notices a
 * refused line.
 *
 * `uci -q batch` exits 0 whether or not it applied anything, so a write sent
 * straight to `ctx.exec` and judged on its exit code reported success for a
 * batch UCI had rejected outright - which is how the routing-table audit came
 * to announce "Restored option ip4table" for a set of WANs it had not changed.
 * `runUciBatch` fails on the `uci:` line instead, and is also the chokepoint
 * that keeps the rejected line - which may be a PPPoE password - out of the
 * error. Only its exit code is carried across, so a failed job item still says
 * which of the writes it was.
 *
 * It asks for `ExecDeps` rather than the whole runtime because the one-to-one
 * automation next door writes the same `/etc/config` sections from a runtime of
 * its own shape, and a second copy of this chokepoint is exactly how one of the
 * two would end up putting a refused line into an error message.
 */
export async function uciWrite(
  deps: ExecDeps,
  label: string,
  lines: readonly string[],
  commits: ReadonlyArray<'network' | 'firewall'>
): Promise<void> {
  try {
    await runUciBatch(
      deps.ctx,
      lines,
      commits,
      deps.options.rules().execTimeoutSec * 1000
    )
  } catch (error) {
    const code = EXIT_CODE.exec(error instanceof Error ? error.message : '')
    // Anything else came from the executor rather than from UCI, and already
    // says what it was; relabelling it would only hide that.
    if (!code) throw error
    throw shellFailure(label, Number(code[1]))
  }
}

export function createBindingRuntime(
  ctx: ModuleContext,
  store: HostStore,
  options: BindingEngineOptions
): BindingRuntime {
  return {
    ctx,
    store,
    options,
    checkSession: createCheckSession<BindingCreatePlan>(),
    latestModel: null,
    lastUptime: null,
    lanRoutes: new Map(),
    memory: new Map(),
    cache: new Map(),
    latestPayload: emptyBindingSnapshot(),
    serial: Promise.resolve(),
    workGeneration: 0,
    disposed: false,
    manualWanTables: undefined,
    preparations: new Map(),
    lastTableAuditWarning: '',
    lastTableRepairNotice: '',
    tableRepairAttempts: 0
  }
}

/** Nothing sampled yet, which is not the same statement as a failed pass. */
export function emptyBindingSnapshot(): BindingSnapshot {
  return {
    t: 0,
    hookOk: true,
    lastError: '',
    instances: [],
    rows: [],
    wans: {
      total: 0,
      available: 0,
      bound: 0,
      error: 0,
      warning: 0,
      dialing: 0,
      boundPct: 0
    }
  }
}

export function current(runtime: BindingRuntime, generation: number): boolean {
  return !runtime.disposed && generation === runtime.workGeneration && runtime.ctx.connected
}

export function exclusive<T>(runtime: BindingRuntime, run: () => Promise<T>): Promise<T> {
  const generation = runtime.workGeneration
  const guarded = (): Promise<T> =>
    current(runtime, generation)
      ? run()
      : Promise.reject(new Error(ENGINE_STOPPED))
  const pending = runtime.serial.then(guarded, guarded)
  runtime.serial = pending.then(
    () => undefined,
    () => undefined
  )
  return pending
}

/**
 * One `sh -s` round trip for a batch of lines, refused the moment the engine
 * behind it has gone away.
 *
 * Structural in its first argument for the same reason `uciWrite` is. The
 * second `disposed` read is the one that matters: a command takes seconds over
 * SSH, and a reset arriving in that window has to make this throw rather than
 * let the caller record the write as landed. So a caller must hand over the
 * live runtime object - a snapshot copied into an `ExecDeps`-shaped literal
 * pins the field to whatever it was before the command ran, and that check
 * never fires again.
 */
export async function execScript(
  deps: ExecDeps,
  lines: readonly string[],
  label: string
): Promise<void> {
  if (lines.length === 0) return
  if (deps.disposed) throw new Error(ENGINE_STOPPED)
  const result = await deps.ctx.exec('sh -s', {
    stdin: `set -eu\n${lines.join('\n')}\n`,
    timeoutMs: deps.options.rules().execTimeoutSec * 1000
  })
  if (result.code !== 0) throw shellFailure(label, result.code)
  if (deps.disposed) throw new Error(ENGINE_STOPPED)
}

export function currentWanTables(runtime: BindingRuntime): WanTableSource | undefined {
  return runtime.manualWanTables ?? runtime.options.wanTables?.()
}

/**
 * Every operator-triggered mutation becomes a job so the failure is visible in
 * the job list rather than only in a returned error nobody reads.
 */
export async function runMutationJob(
  runtime: BindingRuntime,
  kind: string,
  label: string,
  work: () => Promise<OkResult>
): Promise<OkResult> {
  if (!runtime.options.jobs) return work()
  try {
    const job = runtime.options.jobs.start({
      kind,
      label,
      items: [{
        name: label,
        run: async () => {
          const result = await work()
          if (!result.ok) throw new Error(result.error || `${label} failed`)
          return result.data || 'done'
        }
      }],
      onError: 'abort'
    })
    return { ok: true, data: job.id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
