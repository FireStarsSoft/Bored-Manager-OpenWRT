/**
 * The one command that establishes what a connected machine can do, and the
 * readers that turn its output back into facts.
 *
 * Every section is a functional test rather than a lookup wherever it can be:
 * a binary in PATH is not a working feature, and on OpenWRT the difference is
 * routine - BusyBox `ip` has no `rule`, an apk router keeps an `opkg` shim that
 * installs nothing. What the answers then mean is `readiness.ts`; this file
 * only asks and reads.
 */
import type { ModuleContext } from '@shared/modules'
import { splitSections } from '@shared/shell'
import { DEFAULT_RULES } from '../config'
import { buildReadiness, emptyCapabilities } from './readiness'
import {
  emptyAgentFacts,
  emptyFacts,
  type AgentFacts,
  type ForeignRule,
  type OpenWrtCapabilities,
  type ServiceState
} from './types'

const PROBE_TIMEOUT_MS = 20_000

/**
 * How many competing ip rules the router is asked to send back.
 *
 * Filtering happens router-side for the same reason the fast sweep filters
 * there: on a router with a thousand bound clients an unfiltered `ip rule show`
 * is far larger than everything else this probe collects put together. Three
 * are ever shown to a user; the rest only make the count, and the count is
 * printed by awk rather than derived from the lines that survived the cap.
 */
const FOREIGN_RULE_LIMIT = 20

const PROBE_TOOLS = [
  'ubus',
  'uci',
  'ip',
  'fw4',
  'logread',
  'nft',
  'netifd',
  'pppd',
  'dnsmasq',
  'opkg',
  'apk'
]

/**
 * The probe, parameterized with the preference this module starts writing
 * assignment rules at.
 *
 * That number is the only thing the command needs from the configuration, and
 * it is needed router-side: everything below it outranks every rule the binding
 * engine installs, and everything at or above it is either this module's own or
 * consulted after it. Filtering there rather than here is what keeps the answer
 * small on a busy router.
 */
export function buildProbeCommand(rulePrefBase: number): string {
  // Interpolated into awk, so it is reduced to an integer first and falls back
  // to the default rather than to nothing: an empty `-v B=` would make the
  // comparison `$1+0 < 0` and quietly report every router as conflict-free.
  const base = Math.trunc(rulePrefBase) > 0 ? Math.trunc(rulePrefBase) : DEFAULT_RULES.rulePrefBase
  return [
    `echo '===REL==='; cat /etc/openwrt_release 2>/dev/null`,
    `echo '===BOARD==='; ubus -S call system board 2>/dev/null`,
    // One `command -v` per tool. BusyBox ash implements `command -v` as a builtin
    // that prints only its FIRST operand and ignores the rest, so asking for all
    // eight at once answered "ubus" and nothing else - and the module told every
    // router it had no uci, no ip and no netifd, then refused to start.
    `echo '===TOOLS==='; for t in ${PROBE_TOOLS.join(' ')}; do command -v "$t" 2>/dev/null; done`,
    // PPPoE support is read off the files the packages install, not off a
    // package manager: OpenWRT 25.12 and every main snapshot since late 2024
    // ship apk instead of opkg, so `opkg list-installed` produced nothing there
    // and PPPoE Dialer refused to create a batch on a router that had ppp,
    // ppp-mod-pppoe and kmod-pppoe installed all along. The artefacts are the
    // same under either manager - and they also cover a pppoe driver built into
    // the kernel, which no package list mentions at all.
    `echo '===PPP==='; if ls /usr/lib/pppd/*/*pppoe.so >/dev/null 2>&1; then echo plugin; fi; if ls /lib/modules/*/pppoe.ko* >/dev/null 2>&1 || grep -qs pppoe /lib/modules/*/modules.builtin; then echo kmod; fi`,
    // Which manager can install, decided by the databases on disk rather than by
    // the binary: an apk router keeps an `opkg` compatibility shim in PATH.
    //
    // opkg is still asked about even though only apk is supported. It is the
    // difference between "this router runs 24.10 and still uses opkg" and "no
    // apk package database on this router" - two refusals with two different
    // next steps, which a single "no package manager" could not tell apart.
    // `/etc/apk/world` is a second apk signal: it lists the explicit installs and
    // is present on every apk router, including one whose installed database
    // lives somewhere the login cannot stat.
    `echo '===PKG==='; if [ -f /usr/lib/opkg/status ]; then echo opkgdb; fi; if [ -f /lib/apk/db/installed ] || [ -f /usr/lib/apk/db/installed ]; then echo apkdb; fi; if [ -f /etc/apk/world ]; then echo apkworld; fi`,
    `echo '===IDU==='; id -u 2>/dev/null`,
    `echo '===SPACE==='; df -k /overlay 2>/dev/null || df -k / 2>/dev/null`,
    // A functional test, not a lookup, and it has to test the function this
    // module actually uses.
    //
    // `ip -4 rule show` alone was not that test. BusyBox's `ip` applet does
    // have a `rule` subcommand and answers `show` perfectly well - what it
    // cannot do is a **numeric routing table**, which is every write this
    // module makes:
    //
    //     ip: invalid argument '29999' to 'table'
    //     ip: invalid argument '29999' to 'table ID'
    //
    // So a stock 25.12 image with no `ip-full` passed policy routing, reported
    // "nothing is missing", and let a binding instance be created that could
    // never install a single rule. The firewall half of the apply is written
    // first and commits; the routing half then fails on its first line - so the
    // instance ended up half applied, on a router the check had called ready,
    // and the sweep retried it every two seconds forever.
    //
    // `route show` and not a rule add: read-only, and it fails on exactly the
    // same argument. An empty numeric table is not an error to iproute2, so a
    // router that has it answers 0 with no output.
    `echo '===IPRULE==='; if ip -4 rule show >/dev/null 2>&1 && ip -4 route show table 29999 >/dev/null 2>&1; then echo ok; fi`,
    // A binary in PATH is not a running service, and the difference is invisible
    // everywhere else in this module: dnsmasq stopped still answers `command -v`,
    // so the router reported `hasDnsmasq: true`, the lease file went stale, and
    // the device table emptied out under the words "No active DHCP leases" with
    // nothing anywhere to say why.
    //
    // Each half announces that it could ask before it answers - `pidof` for the
    // two daemons, `nftok` for the firewall - so that "this router could not be
    // asked" and "this service is down" stay two different answers. Only the
    // second is worth refusing over, and without the sentinels an answer that
    // arrived short, or a login that cannot run nft, reads as the whole system
    // being down.
    `echo '===SERVICE==='; if command -v pidof >/dev/null 2>&1; then echo pidof; if pidof dnsmasq >/dev/null 2>&1; then echo dnsmasq; fi; if pidof netifd >/dev/null 2>&1; then echo netifd; fi; fi; BM_NFT=$(nft list tables inet 2>/dev/null) && { echo nftok; case "$BM_NFT" in *'table inet fw4'*) echo fw4;; esac; }`,
    // The silent failure this whole section exists for: the lowest ip rule
    // preference wins, and the fast sweep filters `ip rule show` down to the
    // managed window on the router before sending anything back - so a rule below
    // that window steers every packet and appears nowhere in this module at all.
    // Bindings read as applied, the dashboard is green, and the traffic leaves by
    // a different WAN.
    //
    // mwan3 is named separately because it is the common case by a wide margin
    // and because its rules only exist while it is running: `/etc/config/mwan3`
    // is the durable evidence, `mwan3track` the live one, and a user who has both
    // packages needs to be told which one is deciding rather than shown a list of
    // preferences to interpret.
    `echo '===CONFLICT==='; if [ -f /etc/config/mwan3 ]; then echo mwan3conf; fi; if pidof mwan3track >/dev/null 2>&1; then echo mwan3run; fi; ip -4 rule show 2>/dev/null | awk -F: -v B=${base} '$1+0 > 0 && $1+0 < B { n++; if (n <= ${FOREIGN_RULE_LIMIT}) printf "rule %s\\n", $0 } END { printf "total %d\\n", n+0 }'`,
    // The router-side agent, in the same round trip as everything else. A
    // second SSH command per readiness cycle for one small JSON blob is a cost
    // paid on every pooled router the app is connected to, forever.
    //
    // ubus first, because an agent that answers ubus is an agent that is
    // actually running. `bmctl info --json` is the fallback for the case that
    // matters most and is easiest to get wrong: installed, but its service is
    // stopped or refusing to start. It reads the same files the daemon would
    // and reports `service: stopped`, so the difference survives.
    `echo '===AGENT==='; ubus -S call bm.agent info 2>/dev/null || { [ -x /usr/sbin/bmctl ] && bmctl info --json 2>/dev/null; } || true`,
    // The last line of a complete answer, and the only proof there is one. An
    // answer the executor cut short parsed exactly like a whole one: the tail
    // sections were simply absent, so the module announced "missing ubus, uci,
    // ip, netifd" on a healthy router, and latched hasIpRule=false - which
    // refuses every new binding until the next reconnect.
    //
    // It has to be a section of its own, the way `===RULESOK===` is in
    // service/command.ts: `splitSections` recognises only a line that is exactly
    // `===NAME===`, capitals and no underscore, so `===DONE===1` would match
    // nothing and become the last line of the IPRULE body instead.
    `echo '===DONE==='`
  ].join('; ')
}

/**
 * The probe as it reads on a router left at the shipped rule preference base.
 * Kept because a fixture that has to match the wire needs one fixed spelling of
 * it; the runtime builds its own from the configuration in force.
 */
export const PROBE_COMMAND = buildProbeCommand(DEFAULT_RULES.rulePrefBase)

function releaseValues(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1)
    }
    out[match[1]] = value
  }
  return out
}

function boardValues(text: string): {
  model: string
  distribution: string
  version: string
} {
  try {
    const value = JSON.parse(text) as {
      model?: unknown
      board_name?: unknown
      release?: { distribution?: unknown; version?: unknown; revision?: unknown }
    }
    const model =
      typeof value.model === 'string'
        ? value.model
        : typeof value.board_name === 'string'
          ? value.board_name
          : ''
    const distribution =
      typeof value.release?.distribution === 'string' ? value.release.distribution : ''
    const version =
      typeof value.release?.version === 'string'
        ? value.release.version
        : typeof value.release?.revision === 'string'
          ? value.release.revision
          : ''
    return { model, distribution, version }
  } catch {
    return { model: '', distribution: '', version: '' }
  }
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Available kilobytes out of a `df -k` dump, -1 when it did not say.
 *
 * The column is found by reading the header rather than by counting fields
 * back from the end of the row. Counting from the right assumed the mount
 * point was one field, so a router with `/mnt/usb disk` mounted shifted every
 * row by one and the module read `85%` as its free space. BusyBox also wraps a
 * long device name onto a line of its own, leaving a continuation row that is
 * short by the Filesystem column - which is what the numeric first field
 * detects.
 *
 * The value is floored, never rounded: 511.6 KB reported as 512 is exactly the
 * threshold the install gate treats as enough room to start.
 */
export function freeKbFromDf(text: string): number {
  const rows = lines(text)
  const headerAt = rows.findIndex((row) => /(^|\s)Avail(able)?(\s|$)/.test(row))
  if (headerAt < 0) return -1
  const header = rows[headerAt].split(/\s+/).filter(Boolean)
  const availableAt = header.findIndex((name) => /^Avail(able)?$/.test(name))
  let free = -1
  for (const row of rows.slice(headerAt + 1)) {
    const fields = row.split(/\s+/).filter(Boolean)
    const wrapped = /^\d+$/.test(fields[0] ?? '')
    const value = Number(fields[wrapped ? availableAt - 1 : availableAt])
    if (Number.isFinite(value) && value >= 0) free = Math.floor(value)
  }
  return free
}

/**
 * The `===CONFLICT===` body: the rules the router kept, and the number it
 * counted before the cap. The count is read rather than inferred, so "20 shown"
 * and "20 there" stay distinguishable.
 *
 * `read` is the difference between "no competing rules" and "nobody looked",
 * and it is its own answer rather than being inferred from `hasIpRule`. The
 * awk's END block prints `total` unconditionally, so the line is there whenever
 * the scan ran at all.
 *
 * They used to be the same question and are not any more. `hasIpRule` now means
 * numeric routing tables, which BusyBox's `ip` refuses - but that same `ip`
 * answers `ip -4 rule show` perfectly well, so the scan runs and its result is
 * worth reporting. Reading it off `hasIpRule` would blank this row on exactly
 * the routers where a competing rule is most likely to be what somebody is
 * looking for.
 */
function foreignRules(body: readonly string[]): {
  rules: ForeignRule[]
  count: number
  read: boolean
} {
  const rules: ForeignRule[] = []
  let count = 0
  let read = false
  for (const line of body) {
    const rule = line.match(/^rule\s+(\d+):\s*(.*)$/)
    if (rule) {
      rules.push({ pref: Number(rule[1]), text: rule[2].trim().slice(0, 120) })
      continue
    }
    const total = line.match(/^total\s+(\d+)$/)
    if (total) {
      count = Number(total[1])
      read = true
    }
  }
  // Ascending, because the lowest preference is the one that actually decides.
  rules.sort((a, b) => a.pref - b.pref)
  return { rules, count: Math.max(count, rules.length), read }
}

/**
 * The `===AGENT===` body: whatever `bm.agent info` answered.
 *
 * An empty body is a router with no agent, and so is anything that does not
 * parse - a half-written blob and an absent one lead to the same place, which
 * is the module driving this router over SSH. `running` is decided by which of
 * the two commands produced the answer: `bmctl` sets `service`, ubus does not,
 * because ubus answering *is* the service running.
 */
function agentFacts(body: string): AgentFacts {
  const text = body.trim()
  if (!text) return emptyAgentFacts()

  let info: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyAgentFacts()
    info = parsed as Record<string, unknown>
  } catch {
    return emptyAgentFacts()
  }

  const release = typeof info.release === 'string' ? info.release : ''
  if (!release) return emptyAgentFacts()

  const number = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0

  const guard = info.guard
  const guardRecord =
    guard && typeof guard === 'object' && !Array.isArray(guard)
      ? (guard as Record<string, unknown>)
      : null

  return {
    installed: true,
    // `bmctl info --json` carries `service`; a ubus reply does not, and a ubus
    // reply is itself proof the daemon is up.
    running: typeof info.service === 'string' ? info.service === 'running' : true,
    release,
    apiVersion: number(info.apiVersion),
    schema: number(info.schema),
    dataSchema: typeof info.dataSchema === 'number' ? Math.trunc(info.dataSchema) : null,
    provides: Array.isArray(info.provides)
      ? info.provides.filter((name): name is string => typeof name === 'string')
      : [],
    guard:
      guardRecord && guardRecord.armed === true
        ? {
            armed: true,
            snapshot: typeof guardRecord.snapshot === 'string' ? guardRecord.snapshot : '',
            reason: typeof guardRecord.reason === 'string' ? guardRecord.reason : '',
            remaining: number(guardRecord.remaining)
          }
        : null
  }
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/**
 * One bounded command establishes what the connected machine can do.
 *
 * `rulePrefBase` is the preference the binding engine starts writing at. It
 * decides what counts as a competing rule, so it is asked for rather than
 * assumed - and it travels on into the facts, where the verdict names it.
 */
export async function probeOpenWrt(
  ctx: ModuleContext,
  rulePrefBase: number = DEFAULT_RULES.rulePrefBase
): Promise<OpenWrtCapabilities> {
  if (!ctx.connected) return emptyCapabilities()
  try {
    const result = await ctx.exec(buildProbeCommand(rulePrefBase), {
      timeoutMs: PROBE_TIMEOUT_MS
    })
    const sections = splitSections(result.stdout)
    const release = releaseValues(sections.get('REL') ?? '')
    const board = boardValues(sections.get('BOARD') ?? '')
    const tools = lines(sections.get('TOOLS') ?? '').map((line) => line.split('/').pop() ?? '')
    const ppp = new Set(lines(sections.get('PPP') ?? ''))
    const pkg = new Set(lines(sections.get('PKG') ?? ''))
    const uid = Number(lines(sections.get('IDU') ?? '')[0])
    const service = new Set(lines(sections.get('SERVICE') ?? ''))
    const conflictBody = lines(sections.get('CONFLICT') ?? '')
    const conflict = new Set(conflictBody)
    const foreign = foreignRules(conflictBody)
    // Only the sentinel makes "absent" mean "stopped". Without it the answers
    // are unknown rather than down, so no gate built on top of this can refuse
    // a router over a missing BusyBox applet or an nft nobody could run.
    const running = (asked: string, name: string): ServiceState =>
      service.has(asked) ? (service.has(name) ? 'running' : 'stopped') : 'unknown'
    return buildReadiness({
      connected: true,
      // The sentinel, not "something came back": a half-carried answer is the
      // one shape that reads as a complete verdict about a broken router.
      probed: sections.has('DONE'),
      isOpenwrt:
        release.DISTRIB_ID?.toLowerCase() === 'openwrt' ||
        board.distribution.toLowerCase() === 'openwrt',
      release: release.DISTRIB_RELEASE || board.version,
      board: board.model || release.DISTRIB_TARGET || '',
      tools: tools.filter((name) => name.length > 0),
      ppp: { plugin: ppp.has('plugin'), kmod: ppp.has('kmod') },
      pkgDb: { opkg: pkg.has('opkgdb'), apk: pkg.has('apkdb') || pkg.has('apkworld') },
      uid: Number.isFinite(uid) ? uid : -1,
      overlayFreeKb: freeKbFromDf(sections.get('SPACE') ?? ''),
      hasIpRule: lines(sections.get('IPRULE') ?? '').includes('ok'),
      services: {
        dnsmasq: running('pidof', 'dnsmasq'),
        netifd: running('pidof', 'netifd'),
        // Not a daemon: the question is whether fw4's ruleset is loaded, which
        // is only answerable by an `nft` that actually listed the tables.
        fw4: running('nftok', 'fw4')
      },
      foreignRules: foreign.rules,
      foreignRuleCount: foreign.count,
      foreignRulesRead: foreign.read,
      mwan3: { config: conflict.has('mwan3conf'), running: conflict.has('mwan3run') },
      agent: agentFacts(sections.get('AGENT') ?? ''),
      rulePrefBase,
      transportError: (result.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    })
  } catch (error) {
    return buildReadiness({
      ...emptyFacts(),
      // Read again rather than hardcoded: a machine that dropped mid-probe is
      // disconnected by the time this runs, and claiming otherwise published a
      // `checking` state carrying an SSH transport error as the router's own
      // problem - which the readiness poller then kept retrying.
      connected: ctx.connected,
      rulePrefBase,
      transportError: cleanError(error) || 'The OpenWRT capability probe failed.'
    })
  }
}
