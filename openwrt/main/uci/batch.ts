/**
 * The mutation primitives: the few places this module changes a router.
 *
 * One rule governs the whole file. `uci batch` reads its commands from stdin
 * and echoes back any line it rejects - and for this module those lines carry
 * PPPoE passwords. So no error raised here may contain stdout or stderr, ever:
 * `commandFailure` is the single constructor for all of them, and it reports an
 * exit code and nothing else. Job history, events and the app log all end up
 * holding these strings.
 */
import type { ModuleContext, ModuleExecResult } from '@shared/modules'
import { uciQuote } from '../parse'
import { checkedSections, execTimeout } from './names'
import type { PppoeUciChunk } from './pppoe-plan'

export type ExecContext = Pick<ModuleContext, 'exec'>

export type InterfaceAction = 'start' | 'stop' | 'redial'

export interface ApplyChunkOptions {
  timeoutMs: number
  cancelled?: () => boolean
  /**
   * Called after each committed write, so a caller that is mirroring router
   * state can invalidate its dump. Progress reporting is not this layer's job:
   * every chunk is already its own job item, which is where a user sees it.
   */
  onMutated?: () => void
}

export class UciCancelledError extends Error {
  constructor() {
    super('cancelled')
  }
}

export function commandFailure(label: string, result: ModuleExecResult): Error {
  // UCI may echo the rejected input line, which can contain a password. Never
  // include stdout/stderr in an exception that is retained by job history.
  return new Error(`${label} failed (exit ${result.code})`)
}

/**
 * The UCI packages this module ever commits.
 *
 * A closed list rather than a string, because `commit <name>` is built into a
 * line here and a name from anywhere else would be a way to make this module
 * commit somebody's uncommitted changes to a config it has nothing to do with.
 * `bm_wanbind` joined the two originals when the router-side binder did.
 */
export type UciPackage = 'network' | 'firewall' | 'bm_wanbind'

export async function runUciBatch(
  ctx: ExecContext,
  lines: readonly string[],
  commits: readonly UciPackage[],
  timeoutMs: number
): Promise<void> {
  const body = lines.filter((line) => line.trim().length > 0)
  for (const config of [...new Set(commits)]) body.push(`commit ${config}`)
  if (body.length === 0) return
  // `-q` hides per-command failures while `uci batch` still exits 0. Keep
  // diagnostics off the exception (passwords travel on stdin) and fail the
  // job when UCI prints an error line.
  const result = await ctx.exec('uci batch', {
    stdin: `${body.join('\n')}\n`,
    timeoutMs: execTimeout(timeoutMs)
  })
  if (result.code !== 0 || /\buci:/.test(result.stderr || '')) {
    throw commandFailure('UCI batch', result)
  }
}

export async function reloadNetwork(ctx: ExecContext, timeoutMs: number): Promise<void> {
  const result = await ctx.exec('/etc/init.d/network reload', { timeoutMs: execTimeout(timeoutMs) })
  if (result.code !== 0) throw commandFailure('network reload', result)
}

export async function reloadFirewall(ctx: ExecContext, timeoutMs: number): Promise<void> {
  const result = await ctx.exec('service firewall reload', { timeoutMs: execTimeout(timeoutMs) })
  if (result.code !== 0) throw commandFailure('firewall reload', result)
}

export async function applyPppoeChunk(
  ctx: ExecContext,
  chunk: Pick<PppoeUciChunk, 'lines'>,
  timeoutMs: number,
  options: {
    onCommitted?: () => void
    /**
     * Whether the caller has been stopped or pointed at another machine. Not
     * the same question as cancellation below: this one is about whether the
     * context may be used at all.
     */
    stopped?: () => boolean
  } = {}
): Promise<void> {
  await runUciBatch(ctx, chunk.lines, ['network'], timeoutMs)
  // This is the only place that knows the sections are on the router. The
  // reload below can still fail, and a caller that infers "committed" from
  // whether the whole step succeeded would conclude the chunk never landed -
  // then forget sections that exist, with their passwords, and can no longer
  // be stopped or deleted. Tell the caller here, before anything else can go
  // wrong.
  options.onCommitted?.()
  // Never honour cancellation between commit and reload: runtime and UCI must
  // agree before the next chunk is allowed to stop. Being stopped is the one
  // exception, and it is not a decision this layer gets to weigh - the commit
  // is a full round trip, and the module can be disposed or moved to another
  // machine while it is in flight. Reloading then sends a command over a
  // context the host has already revoked, or to the wrong router entirely.
  if (options.stopped?.()) return
  await reloadNetwork(ctx, timeoutMs)
}

export async function waitCancelable(msRaw: number, cancelled: () => boolean = () => false): Promise<void> {
  const ms = Math.max(0, Math.trunc(msRaw))
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (cancelled()) throw new UciCancelledError()
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, until - Date.now())))
  }
  if (cancelled()) throw new UciCancelledError()
}

export async function applyInterfaceWave(
  ctx: ExecContext,
  namesRaw: readonly string[],
  action: InterfaceAction,
  timeoutMs: number,
  options: { bestEffort?: boolean } = {}
): Promise<void> {
  const names = checkedSections(namesRaw)
  if (names.length === 0) throw new Error('interface wave is empty')
  const down = names.map((name) => `ifdown ${uciQuote(name)}`)
  const up = names.map((name) => `ifup ${uciQuote(name)}`)
  const commands = action === 'start' ? up : action === 'stop' ? down : [...down, ...up]
  const scriptLines = options.bestEffort
    ? commands.map((command) => `${command} >/dev/null 2>&1 || true`)
    : ['set -e', ...commands]
  const result = await ctx.exec('sh -s', {
    stdin: `${scriptLines.join('\n')}\n`,
    timeoutMs: execTimeout(timeoutMs)
  })
  if (result.code !== 0) throw commandFailure(`${action} interface wave`, result)
}
