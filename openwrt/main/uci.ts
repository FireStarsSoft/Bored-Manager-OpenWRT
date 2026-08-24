/**
 * Pure UCI builders plus the small set of mutation primitives used by the
 * PPPoE manager. Long/generated payloads always travel over stdin.
 */
import type { ModuleContext, ModuleExecResult } from '@shared/modules'
import { uciQuote } from './parse'

export interface PppoeAccount {
  user: string
  pass: string
  vlan?: number
}

export interface PppoeBuildOptions {
  prefix: string
  carrier: string
  seqFrom: number
  tableBase: number
  /** Batch VLAN; a row VLAN takes precedence. */
  vlan?: number
}

export interface PppoeSectionPlan {
  seq: number
  section: string
  table: number
  device: string
  vlan?: number
  lines: string[]
}

export interface PppoeUciChunk {
  index: number
  total: number
  seqFrom: number
  seqTo: number
  sections: string[]
  lines: string[]
}

export interface ChunkProgress {
  index: number
  total: number
  label: string
}

export interface ApplyChunkOptions {
  timeoutMs: number
  delayMs?: number
  cancelled?: () => boolean
  onProgress?: (progress: ChunkProgress) => void
  onMutated?: () => void
}

export type InterfaceAction = 'start' | 'stop' | 'redial'
export type FirewallMode = 'wildcard' | 'networks'

export interface FirewallPlanOptions {
  zoneName: string
  prefix: string
  /** All managed prefixes that must remain in the shared wildcard zone. */
  prefixes?: readonly string[]
  mode: FirewallMode
  networkSections: readonly string[]
  chunkSize: number
  lanZone?: string
}

export interface FirewallPlan {
  zoneName: string
  prefix: string
  mode: FirewallMode
  setupLines: string[]
  membershipChunks: string[][]
}

export interface FirewallApplyResult {
  ok: boolean
  matches: number
  warning?: string
}

type ExecContext = Pick<ModuleContext, 'exec'>

export const MAX_PPPOE_SEQUENCE = 99_999
/** A malformed rule must never turn 5,000 accounts into 5,000 job rows. */
export const MAX_PPPOE_CHUNKS = 100

const PREFIX_RE = /^[a-z][a-z0-9]{0,3}$/
const UCI_NAME_RE = /^[A-Za-z0-9_]+$/
const DEVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,31}$/
const SECTION_RE = /^[A-Za-z0-9_]+$/

export class UciCancelledError extends Error {
  constructor() {
    super('cancelled')
  }
}

function wholeNumber(value: number, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number`)
  return value
}

function validVlan(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  const vlan = wholeNumber(value, 'VLAN')
  if (vlan < 1 || vlan > 4094) throw new Error('VLAN must be between 1 and 4094')
  return vlan
}

function execTimeout(value: number): number {
  return Number.isFinite(value) ? Math.max(1_000, Math.trunc(value)) : 60_000
}

export function isPppoePrefix(value: string): boolean {
  return PREFIX_RE.test(value)
}

export function isSafeDeviceName(value: string): boolean {
  return DEVICE_RE.test(value)
}

export function isManagedSectionName(value: string): boolean {
  return SECTION_RE.test(value) && value.length <= 15
}

export function padPppoeSequence(seq: number): string {
  const value = wholeNumber(seq, 'PPPoE sequence')
  if (value < 1 || value > MAX_PPPOE_SEQUENCE) {
    throw new Error(`PPPoE sequence must be between 1 and ${MAX_PPPOE_SEQUENCE}`)
  }
  return String(value).padStart(5, '0')
}

export function pppoeSectionName(prefix: string, seq: number): string {
  if (!isPppoePrefix(prefix)) throw new Error('PPPoE prefix must be 1-4 lowercase letters or digits and start with a letter')
  const name = `${prefix}${padPppoeSequence(seq)}`
  // "pppoe-" plus the logical interface must fit Linux IFNAMSIZ (15 visible chars).
  if (`pppoe-${name}`.length > 15) throw new Error(`PPPoE interface name pppoe-${name} is too long`)
  return name
}

export function pppoeTableId(tableBase: number, seq: number): number {
  const base = wholeNumber(tableBase, 'table base')
  const table = base + wholeNumber(seq, 'PPPoE sequence')
  if (base < 1 || table > 2_147_483_647) throw new Error('PPPoE routing table is outside the supported range')
  return table
}

export function vlanSectionName(vlan: number): string {
  return `bmv${validVlan(vlan)}`
}

function vlanLines(carrier: string, vlan: number): string[] {
  const section = vlanSectionName(vlan)
  const device = `${carrier}.${vlan}`
  if (device.length > 15) throw new Error(`VLAN device ${device} is longer than Linux IFNAMSIZ`)
  return [
    `set network.${section}=device`,
    `set network.${section}.type=${uciQuote('8021q')}`,
    `set network.${section}.ifname=${uciQuote(carrier)}`,
    `set network.${section}.vid=${uciQuote(String(vlan))}`,
    `set network.${section}.name=${uciQuote(device)}`
  ]
}

export function buildPppoeSections(
  rows: readonly PppoeAccount[],
  options: PppoeBuildOptions
): PppoeSectionPlan[] {
  if (!isPppoePrefix(options.prefix)) {
    throw new Error('PPPoE prefix must be 1-4 lowercase letters or digits and start with a letter')
  }
  if (!isSafeDeviceName(options.carrier)) throw new Error('carrier is not a safe interface name')
  const batchVlan = validVlan(options.vlan)

  return rows.map((row, index) => {
    const seq = options.seqFrom + index
    const section = pppoeSectionName(options.prefix, seq)
    const table = pppoeTableId(options.tableBase, seq)
    const vlan = validVlan(row.vlan ?? batchVlan)
    const device = vlan === undefined ? options.carrier : `${options.carrier}.${vlan}`
    if (device.length > 15) throw new Error(`device ${device} is longer than Linux IFNAMSIZ`)
    return {
      seq,
      section,
      table,
      device,
      ...(vlan === undefined ? {} : { vlan }),
      lines: [
        `set network.${section}=interface`,
        `set network.${section}.proto=${uciQuote('pppoe')}`,
        `set network.${section}.device=${uciQuote(device)}`,
        `set network.${section}.username=${uciQuote(row.user)}`,
        `set network.${section}.password=${uciQuote(row.pass)}`,
        `set network.${section}.ipv6=${uciQuote('0')}`,
        `set network.${section}.peerdns=${uciQuote('0')}`,
        `set network.${section}.defaultroute=${uciQuote('1')}`,
        `set network.${section}.ip4table=${uciQuote(String(table))}`,
        `set network.${section}.metric=${uciQuote(String(table))}`
      ]
    }
  })
}

/** Deterministic line builder used by both chunk planning and golden tests. */
export function buildPppoeUciLines(
  rows: readonly PppoeAccount[],
  options: PppoeBuildOptions
): string[] {
  const sections = buildPppoeSections(rows, options)
  const emittedVlans = new Set<number>()
  const lines: string[] = []
  for (const section of sections) {
    if (section.vlan !== undefined && !emittedVlans.has(section.vlan)) {
      emittedVlans.add(section.vlan)
      lines.push(...vlanLines(options.carrier, section.vlan))
    }
    lines.push(...section.lines)
  }
  return lines
}

export function buildPppoeUci(
  rows: readonly PppoeAccount[],
  options: PppoeBuildOptions
): string
export function buildPppoeUci(options: PppoeBuildOptions & { rows: readonly PppoeAccount[] }): string
export function buildPppoeUci(
  rowsOrOptions: readonly PppoeAccount[] | (PppoeBuildOptions & { rows: readonly PppoeAccount[] }),
  maybeOptions?: PppoeBuildOptions
): string {
  const bundled = Array.isArray(rowsOrOptions)
    ? null
    : (rowsOrOptions as PppoeBuildOptions & { rows: readonly PppoeAccount[] })
  const rows = bundled?.rows ?? (rowsOrOptions as readonly PppoeAccount[])
  const options = bundled ?? maybeOptions
  if (!options) throw new Error('PPPoE build options are required')
  const lines = buildPppoeUciLines(rows, options)
  return lines.length ? `${lines.join('\n')}\n` : ''
}

export function chunkValues<T>(values: readonly T[], sizeRaw: number): T[][] {
  const size = Math.max(1, Math.trunc(sizeRaw) || 1)
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

/** Honour the configured size while enforcing a bounded live job payload. */
export function effectivePppoeChunkSize(rowCount: number, requested: number): number {
  const count = Math.max(0, Math.trunc(rowCount))
  const configured = Math.max(1, Math.trunc(requested) || 1)
  return Math.max(configured, Math.ceil(count / MAX_PPPOE_CHUNKS) || 1)
}

export function planPppoeChunks(
  rows: readonly PppoeAccount[],
  options: PppoeBuildOptions,
  requestedChunkSize: number
): PppoeUciChunk[] {
  const sections = buildPppoeSections(rows, options)
  const chunks = chunkValues(sections, effectivePppoeChunkSize(sections.length, requestedChunkSize))
  const emittedVlans = new Set<number>()
  return chunks.map((chunk, index) => {
    const lines: string[] = []
    for (const section of chunk) {
      if (section.vlan !== undefined && !emittedVlans.has(section.vlan)) {
        emittedVlans.add(section.vlan)
        lines.push(...vlanLines(options.carrier, section.vlan))
      }
      lines.push(...section.lines)
    }
    return {
      index: index + 1,
      total: chunks.length,
      seqFrom: chunk[0]?.seq ?? options.seqFrom,
      seqTo: chunk.at(-1)?.seq ?? options.seqFrom,
      sections: chunk.map((section) => section.section),
      lines
    }
  })
}

function commandFailure(label: string, result: ModuleExecResult): Error {
  // UCI may echo the rejected input line, which can contain a password. Never
  // include stdout/stderr in an exception that is retained by job history.
  return new Error(`${label} failed (exit ${result.code})`)
}

export async function runUciBatch(
  ctx: ExecContext,
  lines: readonly string[],
  commits: readonly ('network' | 'firewall')[],
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
  timeoutMs: number
): Promise<void> {
  await runUciBatch(ctx, chunk.lines, ['network'], timeoutMs)
  // Never honour cancellation between commit and reload: runtime and UCI must
  // agree before the next chunk is allowed to stop.
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

/**
 * Convenience loop for non-job callers. PppoeManager normally exposes every
 * chunk as its own JobItemSpec and calls applyPppoeChunk directly.
 */
export async function applyUciChunks(
  ctx: ExecContext,
  chunks: readonly PppoeUciChunk[],
  options: ApplyChunkOptions
): Promise<void> {
  const cancelled = options.cancelled ?? (() => false)
  for (const chunk of chunks) {
    if (cancelled()) throw new UciCancelledError()
    await applyPppoeChunk(ctx, chunk, options.timeoutMs)
    options.onMutated?.()
    options.onProgress?.({
      index: chunk.index,
      total: chunk.total,
      label: `${chunk.seqFrom}-${chunk.seqTo}`
    })
    if (chunk.index < chunk.total && (options.delayMs ?? 0) > 0) {
      await waitCancelable(options.delayMs ?? 0, cancelled)
    }
  }
}

function checkedSections(names: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const name = String(raw)
    if (!isManagedSectionName(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
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

export async function applyInterfaceWaves(
  ctx: ExecContext,
  waves: readonly (readonly string[])[],
  action: InterfaceAction,
  options: ApplyChunkOptions
): Promise<void> {
  const cancelled = options.cancelled ?? (() => false)
  for (let index = 0; index < waves.length; index++) {
    if (cancelled()) throw new UciCancelledError()
    await applyInterfaceWave(ctx, waves[index] ?? [], action, options.timeoutMs)
    options.onMutated?.()
    options.onProgress?.({
      index: index + 1,
      total: waves.length,
      label: `${action} wave ${index + 1}`
    })
    if (index + 1 < waves.length && (options.delayMs ?? 0) > 0) {
      await waitCancelable(options.delayMs ?? 0, cancelled)
    }
  }
}

function assertUciName(value: string, label: string): void {
  if (!UCI_NAME_RE.test(value)) throw new Error(`${label} is not a UCI section name`)
}

export function buildFirewallPlan(options: FirewallPlanOptions): FirewallPlan {
  assertUciName(options.zoneName, 'firewall zone')
  if (!isPppoePrefix(options.prefix)) throw new Error('PPPoE prefix is invalid')
  const prefixes = [...new Set(options.prefixes ?? [options.prefix])]
  if (prefixes.some((prefix) => !isPppoePrefix(prefix))) throw new Error('PPPoE prefix is invalid')
  const lanZone = options.lanZone || 'lan'
  assertUciName(lanZone, 'LAN firewall zone')
  const networks = checkedSections(options.networkSections)
  const setupLines = [
    `set firewall.${options.zoneName}=zone`,
    `set firewall.${options.zoneName}.name=${uciQuote(options.zoneName)}`,
    `set firewall.${options.zoneName}.input=${uciQuote('REJECT')}`,
    `set firewall.${options.zoneName}.output=${uciQuote('ACCEPT')}`,
    `set firewall.${options.zoneName}.forward=${uciQuote('REJECT')}`,
    `set firewall.${options.zoneName}.masq=${uciQuote('1')}`,
    `set firewall.${options.zoneName}.mtu_fix=${uciQuote('1')}`,
    `delete firewall.${options.zoneName}.device`,
    `delete firewall.${options.zoneName}.network`,
    `set firewall.bmfwd=forwarding`,
    `set firewall.bmfwd.src=${uciQuote(lanZone)}`,
    `set firewall.bmfwd.dest=${uciQuote(options.zoneName)}`
  ]
  if (options.mode === 'wildcard') {
    for (const prefix of prefixes) {
      setupLines.push(`add_list firewall.${options.zoneName}.device=${uciQuote(`pppoe-${prefix}+`)}`)
    }
  }
  const membershipChunks =
    options.mode === 'networks'
      ? chunkValues(networks, effectivePppoeChunkSize(networks.length, options.chunkSize)).map((chunk) =>
          chunk.map((section) => `add_list firewall.${options.zoneName}.network=${uciQuote(section)}`)
        )
      : []
  return {
    zoneName: options.zoneName,
    prefix: options.prefix,
    mode: options.mode,
    setupLines,
    membershipChunks
  }
}

export async function verifyFirewall(
  ctx: ExecContext,
  prefix: string,
  timeoutMs: number
): Promise<{ matches: number }> {
  if (!isPppoePrefix(prefix)) throw new Error('PPPoE prefix is invalid')
  const result = await ctx.exec(`nft list ruleset 2>/dev/null | grep -c ${uciQuote(`pppoe-${prefix}`)}`, {
    timeoutMs: execTimeout(timeoutMs)
  })
  // grep exits 1 for a valid zero-count result.
  if (result.code !== 0 && result.code !== 1) throw commandFailure('firewall verification', result)
  const matches = Number.parseInt(result.stdout.trim(), 10)
  return { matches: Number.isFinite(matches) ? Math.max(0, matches) : 0 }
}

export async function applyFirewallPlan(
  ctx: ExecContext,
  plan: FirewallPlan,
  options: ApplyChunkOptions
): Promise<FirewallApplyResult> {
  const cancelled = options.cancelled ?? (() => false)
  if (cancelled()) throw new UciCancelledError()
  await runUciBatch(ctx, plan.setupLines, ['firewall'], options.timeoutMs)
  options.onMutated?.()

  let stopped = false
  for (let index = 0; index < plan.membershipChunks.length; index++) {
    if (cancelled()) {
      stopped = true
      break
    }
    await runUciBatch(ctx, plan.membershipChunks[index] ?? [], ['firewall'], options.timeoutMs)
    options.onMutated?.()
    options.onProgress?.({
      index: index + 1,
      total: plan.membershipChunks.length,
      label: `firewall memberships ${index + 1}`
    })
  }

  // Apply whatever was committed even if cancellation arrived between network
  // membership chunks; otherwise UCI and nft would disagree indefinitely.
  await reloadFirewall(ctx, options.timeoutMs)
  const verified = await verifyFirewall(ctx, plan.prefix, options.timeoutMs)
  if (stopped || cancelled()) throw new UciCancelledError()
  if (verified.matches > 0) return { ok: true, matches: verified.matches }
  const warning =
    plan.mode === 'wildcard'
      ? `Firewall reload produced no nft rule for pppoe-${plan.prefix}; switch zoneMode to "networks" on this OpenWRT build.`
      : `Firewall reload produced no nft rule for pppoe-${plan.prefix}; inspect the ${plan.zoneName} zone before using these sessions.`
  return { ok: false, matches: 0, warning }
}

export function buildDeletePppoeLines(
  sectionsRaw: readonly string[],
  firewall?: { zoneName: string; mode: FirewallMode }
): string[] {
  const sections = checkedSections(sectionsRaw)
  if (firewall) assertUciName(firewall.zoneName, 'firewall zone')
  const lines: string[] = []
  for (const section of sections) {
    lines.push(`delete network.${section}`)
    if (firewall?.mode === 'networks') {
      lines.push(`del_list firewall.${firewall.zoneName}.network=${uciQuote(section)}`)
    }
  }
  return lines
}

export function buildDeleteVlanLines(vlans: readonly number[]): string[] {
  return [...new Set(vlans.map((vlan) => validVlan(vlan) as number))].map(
    (vlan) => `delete network.${vlanSectionName(vlan)}`
  )
}
