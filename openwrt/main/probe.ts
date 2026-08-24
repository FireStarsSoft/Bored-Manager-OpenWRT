import type { ModuleContext } from '@shared/modules'
import { splitSections } from '@shared/shell'

export interface OpenWrtCapabilities {
  t: number
  connected: boolean
  isOpenwrt: boolean
  release: string
  board: string
  hasUbus: boolean
  hasUci: boolean
  hasIp: boolean
  hasLogread: boolean
  hasNetifd: boolean
  hasPppd: boolean
  hasFw4: boolean
  hasPppoe: boolean
  tools: string[]
  /**
   * Whether the router actually answered. False when the probe threw or came
   * back empty - a verdict the caller must keep retrying rather than latch,
   * since an SSH hiccup looks exactly like "not an OpenWRT router" here.
   */
  probed: boolean
  problem: string | null
}

const PROBE_TIMEOUT_MS = 20_000

const PROBE_COMMAND = [
  `echo '===REL==='; cat /etc/openwrt_release 2>/dev/null`,
  `echo '===BOARD==='; ubus -S call system board 2>/dev/null`,
  `echo '===TOOLS==='; command -v ubus uci ip fw4 logread nft netifd pppd 2>/dev/null`,
  // PPPoE support is read off the files the packages install, not off a
  // package manager: OpenWRT 25.12 and every main snapshot since late 2024
  // ship apk instead of opkg, so `opkg list-installed` produced nothing there
  // and PPPoE Dialer refused to create a batch on a router that had ppp,
  // ppp-mod-pppoe and kmod-pppoe installed all along. The artefacts are the
  // same under either manager - and they also cover a pppoe driver built into
  // the kernel, which no package list mentions at all.
  `echo '===PPP==='; if ls /usr/lib/pppd/*/*pppoe.so >/dev/null 2>&1; then echo plugin; fi; if ls /lib/modules/*/pppoe.ko* >/dev/null 2>&1 || grep -qs pppoe /lib/modules/*/modules.builtin; then echo kmod; fi`
].join('; ')

export function emptyCapabilities(): OpenWrtCapabilities {
  return {
    t: Date.now(),
    connected: false,
    isOpenwrt: false,
    release: '',
    board: '',
    hasUbus: false,
    hasUci: false,
    hasIp: false,
    hasLogread: false,
    hasNetifd: false,
    hasPppd: false,
    hasFw4: false,
    hasPppoe: false,
    tools: [],
    probed: false,
    problem: 'Not connected to a router yet.'
  }
}

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

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** One bounded command establishes whether the connected machine is OpenWRT. */
export async function probeOpenWrt(ctx: ModuleContext): Promise<OpenWrtCapabilities> {
  if (!ctx.connected) return emptyCapabilities()
  try {
    const result = await ctx.exec(PROBE_COMMAND, { timeoutMs: PROBE_TIMEOUT_MS })
    const answered = result.stdout.trim().length > 0
    const sections = splitSections(result.stdout)
    const release = releaseValues(sections.get('REL') ?? '')
    const board = boardValues(sections.get('BOARD') ?? '')
    const tools = (sections.get('TOOLS') ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().split('/').pop() ?? '')
      .filter((name) => name.length > 0)
    const toolSet = new Set(tools)
    const pppArtefacts = new Set(
      (sections.get('PPP') ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    )
    const isOpenwrt =
      release.DISTRIB_ID?.toLowerCase() === 'openwrt' ||
      board.distribution.toLowerCase() === 'openwrt'
    const missing = ['ubus', 'uci', 'ip', 'netifd'].filter((tool) => !toolSet.has(tool))
    let problem: string | null = null
    if (!isOpenwrt) {
      problem =
        'The connected machine is not an OpenWRT router. Connect this machine entry directly to the router over SSH.'
    } else if (missing.length) {
      problem = `OpenWRT is missing required command(s): ${missing.join(', ')}.`
    } else if (result.code !== 0 && !result.stdout.trim()) {
      problem = (result.stderr || 'The OpenWRT capability probe returned no data.')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300)
    }
    return {
      t: Date.now(),
      connected: true,
      isOpenwrt,
      release: release.DISTRIB_RELEASE || board.version,
      board: board.model || release.DISTRIB_TARGET || '',
      hasUbus: toolSet.has('ubus'),
      hasUci: toolSet.has('uci'),
      hasIp: toolSet.has('ip'),
      hasLogread: toolSet.has('logread'),
      hasNetifd: toolSet.has('netifd'),
      hasPppd: toolSet.has('pppd'),
      hasFw4: toolSet.has('fw4') && toolSet.has('nft'),
      hasPppoe:
        toolSet.has('pppd') && pppArtefacts.has('plugin') && pppArtefacts.has('kmod'),
      tools: [...new Set(tools)].sort(),
      probed: answered,
      problem
    }
  } catch (error) {
    return {
      ...emptyCapabilities(),
      t: Date.now(),
      connected: true,
      problem: cleanError(error) || 'The OpenWRT capability probe failed.'
    }
  }
}
