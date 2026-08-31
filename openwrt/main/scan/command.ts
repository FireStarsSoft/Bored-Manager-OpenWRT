/**
 * The one bounded shell the binding monitor runs, and nothing else.
 *
 * This is the command that makes the feature possible at all. The fast sweep
 * filters `ip -4 rule show` down to the module's own preference window on the
 * router (`service/command.ts`), which is exactly why a hand-written rule that
 * steers every packet out of a different WAN appears nowhere in this module
 * today: the module has never once looked outside its own band. So this reads
 * the *whole* rule table, then follows every table those rules point at far
 * enough to say where each one actually leads.
 *
 * Three things keep that from being expensive or dangerous:
 *
 * - One round trip. Rules, the main table's default and the per-table routes
 *   all come back from a single `sh -s`, so a scan costs one SSH command
 *   however many rules the router carries.
 * - Every output is capped router-side with `head`. A router with a per-host
 *   rule set can have thousands of rules, and the executor's output limit
 *   truncates the tail of a reply - which here would silently drop the
 *   sentinel and the routes and leave the reply looking like a clean read.
 * - Every table token is validated before it reaches a command line. A name in
 *   `/etc/iproute2/rt_tables` is written by whoever administers the router, not
 *   by this module, so it is untrusted text arriving in the middle of a shell
 *   script.
 */

/**
 * Long enough for `ip route show` on sixty-four tables over a slow SSH hop,
 * short enough that a wedged scan cannot sit on the connection until the
 * poller fires again.
 */
export const SCAN_TIMEOUT_MS = 20_000

/**
 * How many rule lines are kept. Beyond this a router is not being monitored,
 * it is being dumped.
 *
 * The script asks for one line more than this and the parser drops it again.
 * That extra line is the only way this side can tell a table that ends at 500
 * from a table that was cut at 500: `head` prints the same thing either way,
 * and the reply carries no count of its own.
 */
export const SCAN_MAX_RULES = 500

/** How many distinct lookup tables the routes pass will follow. */
export const SCAN_MAX_TABLES = 64

/** Route lines kept per table, which is enough to see a default and its company. */
export const SCAN_MAX_ROUTES = 8

/**
 * Fed to `sh -s` on stdin, so nothing here is ever interpolated by this side.
 *
 * `set -uf` rather than `set -eu`: `-e` would abandon the script on the first
 * `grep` that matches nothing, and the whole point of the layout below is that
 * it always reaches `===SCANOK===` and says which way the read went. `-f` turns
 * pathname expansion off, because the token loop iterates over unquoted words
 * that came off the router - a table named `*` would otherwise expand to the
 * contents of the working directory before the guard ever saw it.
 *
 * `mktemp` rather than `/tmp/.bm-owrt-scan.$$`: a PID is guessable, so anything
 * else on the router can pre-create that path as a symlink and have this
 * truncate whatever it points at (CWE-377). `mktemp` creates the file itself
 * and refuses to reuse one. The rule table is captured to a file rather than
 * piped because it is read twice - once to print, once to harvest the table
 * tokens - and asking `ip` twice would let the two answers disagree.
 *
 * `===SCANOK===` is a fail-closed sentinel of the same family as the fast
 * sweep's `===RULESOK===`, and it has to be a section of its own: `splitSections`
 * only recognises a line that is exactly `===NAME===`, capitals and no
 * underscore. A router that cannot read its own rule table must report a failed
 * scan, never an empty one - "no rules on this router" is the single most
 * misleading thing this monitor could ever say.
 */
export const SCAN_COMMAND = [
  'set -uf',
  `echo '===RULES==='`,
  'BM_SCAN=$(mktemp /tmp/.bm-owrt-scan.XXXXXX 2>/dev/null) || BM_SCAN=',
  'if [ -n "$BM_SCAN" ] && ip -4 rule show >"$BM_SCAN" 2>/dev/null; then',
  // One line past the cap, so the reply says whether it was cut. Without the
  // extra line a table of exactly 500 and a table of 4,000 arrive identical,
  // and the page reports "Rules seen: 500" about the second one as a fact -
  // with this module's own catch-alls, which sit above the band, among the
  // rules that silently went missing.
  `  head -n ${SCAN_MAX_RULES + 1} "$BM_SCAN"`,
  `  echo '===DEFAULT==='`,
  // The main table's own default is the contrast every explanation is built
  // against - "this address does not leave the way everything else does" is
  // not a sentence anyone can write without it. It is fetched here rather than
  // in the loop below because `main` is deliberately skipped there.
  `  ip -4 route show table main 2>/dev/null | grep '^default' | head -n 8`,
  // The token list is settled once, into a variable, and then used twice: once
  // to tell this side which tables were looked at and once to look at them.
  // Building it twice would let the two answers differ, and the whole reason
  // `===TABLES===` exists is that a set of tables inferred rather than stated
  // was already wrong once - see the section's own note below.
  //
  // `local`, `main` and `default` are dropped before `head` rather than inside
  // the loop: they appear in the kernel's own baseline rules on every router
  // alive, so filtering them afterwards would spend three of the sixty-four
  // slots on tables nothing here reads - `local` is pure noise and main's
  // default already has a section of its own.
  // The awk carries the previous field along rather than indexing `$(i + 1)`,
  // so the program holds no `$(` at all: this whole loop sits inside a command
  // substitution, and a shell that mis-nests those would swallow the script.
  '  BM_T=',
  '  for t in $(awk \'{ p = ""; for (i = 1; i <= NF; i++) { if (p == "lookup" || p == "table") { if ($i != "local" && $i != "main" && $i != "default") print $i } p = $i } }\' "$BM_SCAN" | sort -u | head -n ' +
    `${SCAN_MAX_TABLES}); do`,
  // The guard, before the token is allowed anywhere near a command line or
  // this side. An rt_tables name is administrator-written text; without this, a
  // table called `x;reboot` would be a command rather than an argument. The
  // length cut is the same 64 the parser enforces on the way back in: a token
  // longer than that is one the reader will drop anyway, so querying it would
  // spend a slot and a reply line on an answer nothing can use.
  `    case "$t" in ''|*[!A-Za-z0-9_.-]*) continue;; esac`,
  '    [ ${#t} -le 64 ] || continue',
  '    BM_T="$BM_T $t"',
  '  done',
  // What was actually queried, said out loud by the side that did the querying.
  // The list above is harvested from the whole rule file while `===RULES===` is
  // capped, so on a big router the two sets diverge - and a classifier left to
  // infer this set from the rules it could see decided that tables it had never
  // asked about were tables with no way out. A table nobody queried has to read
  // as unknown, which it cannot do unless this section says who was asked.
  `  echo '===TABLES==='`,
  // `printf` rather than `echo`, because the guarded character set allows a
  // leading `-` and a table named `-n` is a flag to every echo on the router
  // rather than a name: the token would vanish from the list while the routes
  // loop went on querying it, and the two halves of this section's one job
  // would disagree about which tables were asked.
  `  for t in $BM_T; do printf '%s\\n' "$t"; done`,
  `  echo '===ROUTES==='`,
  // Re-guarded rather than trusted: `$BM_T` holds only tokens that passed the
  // case above, and the cost of proving that again at the one line that
  // interpolates into a command is nothing at all.
  '  for t in $BM_T; do',
  `    case "$t" in ''|*[!A-Za-z0-9_.-]*) continue;; esac`,
  `    ip -4 route show table "$t" 2>/dev/null | head -n ${SCAN_MAX_ROUTES} | awk -v T="$t" '{ print T " " $0 }'`,
  '  done',
  `  echo '===SCANOK==='; echo 1`,
  'else',
  // The empty sections still have to be printed. A reply missing them entirely
  // is indistinguishable from one the executor truncated, and the parser would
  // have to guess which.
  `  echo '===DEFAULT==='`,
  `  echo '===TABLES==='`,
  `  echo '===ROUTES==='`,
  `  echo '===SCANOK==='; echo 0`,
  'fi',
  // The trailing `:` keeps the script's exit status at 0 - without it the
  // `[ -n "" ]` of a failed mktemp would decide it, and a fail-closed sentinel
  // that also fails the command would be reported twice as two different faults.
  '[ -n "$BM_SCAN" ] && rm -f "$BM_SCAN"',
  ':',
  ''
].join('\n')
