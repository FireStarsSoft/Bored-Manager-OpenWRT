/**
 * The two shell commands the collector runs, and the pool ranges the fast one
 * is parameterized with.
 *
 * Both are a single bounded remote shell that prints `===NAME===` sections, so
 * one tick costs one round trip however many interfaces the router has. The
 * heavy per-interface work - deciding which devices belong to the managed pool
 * and summing their counters - happens router-side in awk, because shipping
 * `/proc/net/dev` for ten thousand PPPoE sessions is what the executor's output
 * cap exists to stop.
 */
import { shQuote } from '@shared/shell'
import type { OwrtRules } from '../config'
import { MANAGED_PREF_CEILING } from '../records'

export const EXEC_TIMEOUT_MS = 20_000

/**
 * One managed name range: `prefix` plus a numeric suffix inside the bounds.
 * A v2 pool is `prefix:0-4094` (its members are VLAN-numbered), a legacy pool
 * still carries the sequence range it was created with (five-digit suffixes
 * parse as the same numbers). The provider is the pool cache, which reads
 * them off the router - the router is the record now.
 */
export interface ManagedPppoeRange {
  prefix: string
  seqFrom: number
  seqTo: number
}

/** A range that is safe to interpolate into the awk spec below. */
export function isManagedRange(range: ManagedPppoeRange): boolean {
  return (
    /^[a-z][a-z0-9]{0,3}$/.test(range.prefix) &&
    Number.isInteger(range.seqFrom) &&
    Number.isInteger(range.seqTo) &&
    range.seqFrom >= 0 &&
    range.seqTo >= range.seqFrom
  )
}

const DEV_AWK = [
  `function managed(name, logical, count, specs, i, pair, bounds, prefix, suffix, seq) {`,
  `  if (substr(name, 1, 6) != "pppoe-" || R == "") return 0`,
  `  logical=substr(name, 7)`,
  `  count=split(R, specs, ";")`,
  `  for (i=1; i<=count; i++) {`,
  `    split(specs[i], pair, ":")`,
  `    split(pair[2], bounds, "-")`,
  `    prefix=pair[1]`,
  `    if (substr(logical, 1, length(prefix)) != prefix) continue`,
  `    suffix=substr(logical, length(prefix)+1)`,
  `    if (suffix !~ /^[0-9]+$/ || length(suffix) > 5) continue`,
  `    seq=suffix+0`,
  `    if (seq >= bounds[1]+0 && seq <= bounds[2]+0) return 1`,
  `  }`,
  `  return 0`,
  `}`,
  `NR > 2 {`,
  `  line=$0`,
  `  sub(/^[ \t]+/, "", line)`,
  `  pos=index(line, ":")`,
  `  if (!pos) next`,
  `  name=substr(line, 1, pos-1)`,
  `  data=substr(line, pos+1)`,
  `  sub(/^[ \t]+/, "", data)`,
  `  fields=split(data, value, /[ \t]+/)`,
  `  if (fields < 9) next`,
  `  rx=value[1]+0`,
  `  tx=value[9]+0`,
  `  if (managed(name)) { poolCount++; poolRx+=rx; poolTx+=tx }`,
  `  else { printf "%s %.0f %.0f\\n", name, rx, tx }`,
  `}`,
  `END { printf "===POOL=== %d %.0f %.0f\\n", poolCount+0, poolRx+0, poolTx+0 }`
].join('\n')

/** Exported for fixture/golden tests; it still executes as one remote shell. */
export function buildFastSweepCommand(
  rules: OwrtRules,
  ranges: readonly ManagedPppoeRange[],
  includeDump: boolean
): string {
  const rangeSpec = ranges
    .map((range) => `${range.prefix}:${range.seqFrom}-${range.seqTo}`)
    .join(';')
  const parts = [
    `echo '===SYS==='; ubus -S call system info 2>/dev/null || true`,
    `echo '===DEV==='; awk -v R=${shQuote(rangeSpec)} ${shQuote(DEV_AWK)} /proc/net/dev 2>/dev/null || true`,
    `echo '===LEASES==='; cat ${shQuote(rules.leaseFile)} 2>/dev/null || true`,
    // RULESOK is a fail-closed sentinel: a hidden `ip` failure must not look
    // like "zero managed rules" or BindingEngine will re-add every assignment.
    //
    // It has to be a section of its own - `splitSections` only recognises a
    // line that is exactly `===NAME===`, with NAME in capitals and no
    // underscore. Written as `===RULES_OK===1` it matched nothing at all and
    // became the last line of the RULES body, so the sentinel read false on
    // every single tick: no reconcile ever ran, the binding engine never got
    // a model, and every binding method answered "no router sample".
    //
    // `mktemp` rather than `/tmp/.bm-owrt-rules.$$`: a PID is guessable, so
    // anything else on the router can pre-create that path as a symlink and
    // have this truncate whatever it points at (CWE-377). `mktemp` creates the
    // file itself and refuses to reuse one. A failed `mktemp` prints 0, so it
    // fails closed the same way a failed `ip` does, and the trailing `; :`
    // keeps the joined command's exit status at 0 - without it the final
    // `[ -n "" ]` would decide it.
    `echo '===RULES==='; BM_RULES=$(mktemp /tmp/.bm-owrt-rules.XXXXXX 2>/dev/null) || BM_RULES=; if [ -n "$BM_RULES" ] && ip -4 rule show >"$BM_RULES" 2>/dev/null; then awk -F: -v B=${Math.trunc(
      rules.rulePrefBase
    )} -v E=${MANAGED_PREF_CEILING} '$1+0 >= B && $1+0 < E' "$BM_RULES"; echo '===RULESOK==='; echo 1; else echo '===RULESOK==='; echo 0; fi; [ -n "$BM_RULES" ] && rm -f "$BM_RULES"; :`
  ]
  if (includeDump) {
    parts.push(
      `echo '===DUMP==='; ubus -S call network.interface dump 2>/dev/null || true`
    )
  }
  return parts.join('; ')
}

export const SLOW_COMMAND = [
  `echo '===LOG==='; logread -l 300 2>/dev/null | grep -E 'pppd|netifd' || true`,
  // UCIOK is a fail-closed sentinel, the twin of RULESOK above and of the
  // `===SYSCTL===` check the preparation probe makes. An absent or empty
  // UCIMAP is otherwise indistinguishable from a router with no `ip4table`
  // anywhere - and the binding engine reads that as "every managed WAN has
  // lost its table, and no WAN conflicts with anything", which is both the
  // conflict check that protects a foreign table and the trigger for
  // rewriting `option ip4table` on the whole pool.
  //
  // It has to be a section of its own: `splitSections` only recognises a line
  // that is exactly `===NAME===`, capitals and no underscore.
  //
  // `mktemp` for the same reason the rule capture above uses it: a PID is
  // guessable, so anything else on the router can pre-create that path as a
  // symlink and have this truncate whatever it points at (CWE-377). A failed
  // `mktemp` prints 0, which is the fail-closed answer already described.
  `echo '===UCIMAP==='; BM_UCI=$(mktemp /tmp/.bm-owrt-uci.XXXXXX 2>/dev/null) || BM_UCI=; if [ -n "$BM_UCI" ] && uci -q show network >"$BM_UCI" 2>/dev/null; then grep -E '\\.(ip4table|username)=' "$BM_UCI" || true; echo '===UCIOK==='; echo 1; else echo '===UCIOK==='; echo 0; fi; [ -n "$BM_UCI" ] && rm -f "$BM_UCI"; :`,
  // Which zone LAN clients are in. Filtered down to the three keys the reader
  // uses: a full `uci show firewall` on a router with per-host rules is far
  // larger than anything else this probe collects.
  `echo '===FWZONES==='; uci -q show firewall 2>/dev/null | grep -E '=zone$|\\.name=|\\.network=' || true`
].join('; ')
