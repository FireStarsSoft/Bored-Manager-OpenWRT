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
  problem: string | null
}

const PROBE_TIMEOUT_MS = 20_000

const PROBE_COMMAND = [
  `echo '===REL==='; cat /etc/openwrt_release 2>/dev/null`,
  `echo '===BOARD==='; ubus -S call system board 2>/dev/null`,
  `echo '===TOOLS==='; command -v ubus uci ip fw4 logread nft netifd pppd 2>/dev/null`,
  `echo '===PPP==='; opkg list-installed 2>/dev/null | grep -E '^(ppp|ppp-mod-pppoe|kmod-pppoe) '`
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
    const sections = splitSections(result.stdout)
    const release = releaseValues(sections.get('REL') ?? '')
    const board = boardValues(sections.get('BOARD') ?? '')
    const tools = (sections.get('TOOLS') ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().split('/').pop() ?? '')
      .filter((name) => name.length > 0)
    const toolSet = new Set(tools)
    const packages = new Set(
      (sections.get('PPP') ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0] ?? '')
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
        toolSet.has('pppd') &&
        packages.has('ppp') &&
        packages.has('ppp-mod-pppoe') &&
        packages.has('kmod-pppoe'),
      tools: [...new Set(tools)].sort(),
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
