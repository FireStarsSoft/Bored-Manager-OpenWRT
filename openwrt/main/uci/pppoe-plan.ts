/**
 * The UCI a PPPoE pool is made of, as data.
 *
 * Nothing here runs anything: every function returns lines, so the exact text
 * that would reach the router can be asserted in a test without a router. The
 * chunking is part of the plan rather than of the execution because a chunk
 * boundary is what a failure is recorded against - see `shrinkToCommitted`.
 */
import { uciQuote } from '../parse'
import {
  assertUciName,
  checkedSections,
  chunkValues,
  effectivePppoeChunkSize,
  isPppoePrefix,
  isSafeDeviceName,
  isSafeUciValue,
  pppoeSectionName,
  pppoeTableId,
  validVlan,
  vlanSectionName
} from './names'

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

export type FirewallMode = 'wildcard' | 'networks'

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
    // The check gate refuses these already; this is the last gate before the
    // credential becomes a line on `uci batch`'s stdin, and it names the row
    // rather than the value - the value is a password.
    if (!isSafeUciValue(row.user) || !isSafeUciValue(row.pass)) {
      throw new Error(`account row ${index + 1} contains a control character`)
    }
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
