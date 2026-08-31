/**
 * The one thing about the router-side daemon this folder has to know: which ip
 * rule priorities `bm-wanbind` has been told to write in.
 *
 * It is not in the shared preparation probe because that probe carries the
 * three configs both automations read - dhcp, network, firewall - and this is a
 * fourth that only the one-to-one create gate has any use for. Reading it here
 * keeps the extra round trip on the path that needs it rather than on every
 * instance check as well.
 *
 * The live setting is deliberately not what is read. `directPrefBase` on this
 * side and `rule_pref_base` on the router are edited independently, and it is
 * the router's copy that decides where the daemon actually writes; a band
 * checked against this module's own number would pass and then overlap.
 */
import { ENGINE_STOPPED, shellFailure, type ExecDeps } from '../binding'

const PROBE_TIMEOUT_MS = 20_000

/**
 * Bounded on both ends: `grep` throws away everything that is not the one
 * option, and `head` caps what is left, so a hand-edited config with a thousand
 * sections cannot fill the output buffer. Nothing is interpolated into it.
 */
const WANBIND_PREF_SCRIPT = String.raw`set +e
command -v uci >/dev/null 2>&1 || { echo '===DONE==='; exit 0; }
uci -q show bm_wanbind 2>/dev/null | grep -E '\.rule_pref_base=' | head -n 64
echo '===DONE==='
exit 0
`

const PREF_LINE = /^bm_wanbind\.[^.=]+\.rule_pref_base='?(\d{1,9})'?$/

/**
 * Every `rule_pref_base` the router's own binding config carries, or an empty
 * list when the daemon is not configured there at all.
 *
 * Fail-closed on a truncated answer: the sentinel is the last thing the script
 * prints, so its absence means stdout was cut short - and a check that read
 * half the sections would approve a band that overlaps one it never saw.
 */
export async function wanbindPrefBases(deps: ExecDeps): Promise<number[]> {
  if (deps.disposed) throw new Error(ENGINE_STOPPED)
  const result = await deps.ctx.exec('sh -s', {
    stdin: WANBIND_PREF_SCRIPT,
    timeoutMs: PROBE_TIMEOUT_MS
  })
  if (deps.disposed) throw new Error(ENGINE_STOPPED)
  if (result.code !== 0) throw shellFailure('read router binding priorities', result.code)
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim())
  if (!lines.includes('===DONE===')) {
    throw new Error(
      'the router binding configuration was cut off before it finished, so the check cannot tell which priorities the router-side daemon writes in'
    )
  }
  const bases: number[] = []
  for (const line of lines) {
    const match = PREF_LINE.exec(line)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isSafeInteger(value) && value > 0) bases.push(value)
  }
  return bases
}
