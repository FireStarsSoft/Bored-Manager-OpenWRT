/**
 * The one mutation primitive left on this side: `uci batch` over SSH, used by
 * the binding half for the writes its daemon-less fallback still makes.
 *
 * One rule governs the file. `uci batch` reads its commands from stdin and
 * echoes back any line it rejects, so no error raised here may contain stdout
 * or stderr, ever: `commandFailure` is the single constructor for all of
 * them, and it reports an exit code and nothing else. Job history, events and
 * the app log all end up holding these strings.
 */
import type { ModuleContext, ModuleExecResult } from '@shared/modules'
import { execTimeout } from './names'

export type ExecContext = Pick<ModuleContext, 'exec'>

export function commandFailure(label: string, result: ModuleExecResult): Error {
  // UCI may echo the rejected input line. Never include stdout/stderr in an
  // exception that is retained by job history.
  return new Error(`${label} failed (exit ${result.code})`)
}

/**
 * The UCI packages this module ever commits.
 *
 * A closed list rather than a string, because `commit <name>` is built into a
 * line here and a name from anywhere else would be a way to make this module
 * commit somebody's uncommitted changes to a config it has nothing to do
 * with. PPPoE is deliberately absent: `/etc/config/network`'s pool sections
 * and the firewall zone belong to bm-pppoe-pool now.
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
  // diagnostics off the exception and fail the job when UCI prints an error.
  const result = await ctx.exec('uci batch', {
    stdin: `${body.join('\n')}\n`,
    timeoutMs: execTimeout(timeoutMs)
  })
  if (result.code !== 0 || /\buci:/.test(result.stderr || '')) {
    throw commandFailure('UCI batch', result)
  }
}
