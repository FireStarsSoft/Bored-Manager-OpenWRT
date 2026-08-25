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
import { buildReadiness, emptyCapabilities } from './readiness'
import { emptyFacts, type OpenWrtCapabilities } from './types'

const PROBE_TIMEOUT_MS = 20_000

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

export const PROBE_COMMAND = [
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
  // A functional test, not a lookup: the `ip` that is present may be the
  // BusyBox applet, which has no `rule` subcommand at all.
  `echo '===IPRULE==='; if ip -4 rule show >/dev/null 2>&1; then echo ok; fi`,
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

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** One bounded command establishes what the connected machine can do. */
export async function probeOpenWrt(ctx: ModuleContext): Promise<OpenWrtCapabilities> {
  if (!ctx.connected) return emptyCapabilities()
  try {
    const result = await ctx.exec(PROBE_COMMAND, { timeoutMs: PROBE_TIMEOUT_MS })
    const sections = splitSections(result.stdout)
    const release = releaseValues(sections.get('REL') ?? '')
    const board = boardValues(sections.get('BOARD') ?? '')
    const tools = lines(sections.get('TOOLS') ?? '').map((line) => line.split('/').pop() ?? '')
    const ppp = new Set(lines(sections.get('PPP') ?? ''))
    const pkg = new Set(lines(sections.get('PKG') ?? ''))
    const uid = Number(lines(sections.get('IDU') ?? '')[0])
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
      transportError: cleanError(error) || 'The OpenWRT capability probe failed.'
    })
  }
}
