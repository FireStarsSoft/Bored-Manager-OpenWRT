/**
 * The shape of the module's own settings document, and the rules for reading
 * one back off disk.
 *
 * Two invariants live here and nowhere else: only values that differ from
 * `DEFAULT_RULES` are ever written (so a default that changes in a later
 * release reaches routers that never touched it), and a persisted numbering
 * layout that overlaps its own safety range is dropped rather than honoured.
 */
import { isRecord } from '../util'

export type ZoneMode = 'wildcard' | 'networks'

export interface OwrtRules {
  ifacePrefix: string
  tableBase: number
  rulePrefBase: number
  catchAllPrefBase: number
  catchAllTable: number
  uciChunkSize: number
  chunkDelayMs: number
  ruleChunkLines: number
  execTimeoutSec: number
  maxBatchRows: number
  zoneName: string
  zoneMode: ZoneMode
  remapOnWanError: boolean
  wanErrorGraceSec: number
  wanWarnUptimeSec: number
  stickyByMac: boolean
  releaseGraceSec: number
  autoRedialAfterMin: number
  /** Rewrite a WAN's missing `option ip4table` during the slow-tick audit. */
  autoRepairTables: boolean
  leaseFile: string
  maxEvents: number
  stickyCap: number
  /**
   * How often a point is written to the metrics history the dashboard charts
   * read back. The live tiles above them are fed by the `series` stream on
   * every fast tick; this is the archive behind them, and it used to be
   * written once per slow sweep - so a chart was one point per minute however
   * fast the sweep ran, and the short windows looked like a staircase.
   */
  historySampleSec: number
}

export interface OwrtConfig {
  version: 1
  /** Only values different from `DEFAULT_RULES` are written. */
  rules: Partial<OwrtRules>
  ui: { showHints: boolean }
}

export const DEFAULT_RULES: OwrtRules = {
  ifacePrefix: 'pd',
  tableBase: 10_000,
  rulePrefBase: 20_000,
  catchAllPrefBase: 29_900,
  catchAllTable: 29_999,
  uciChunkSize: 100,
  chunkDelayMs: 1_000,
  ruleChunkLines: 500,
  execTimeoutSec: 60,
  maxBatchRows: 5_000,
  zoneName: 'bmwanpool',
  zoneMode: 'wildcard',
  remapOnWanError: true,
  wanErrorGraceSec: 30,
  wanWarnUptimeSec: 60,
  stickyByMac: true,
  releaseGraceSec: 300,
  autoRedialAfterMin: 0,
  autoRepairTables: true,
  leaseFile: '/tmp/dhcp.leases',
  maxEvents: 200,
  stickyCap: 6_000,
  // What the slow sweep produced before this was a setting, so a router that
  // never touches it charts exactly as it did.
  historySampleSec: 60
}

export type NumericRule = {
  [K in keyof OwrtRules]: OwrtRules[K] extends number ? K : never
}[keyof OwrtRules]

/**
 * The narrowest client priority range either half will accept.
 *
 * MIN_PREF_SPAN in bm-wanbind's config.uc, and the same number for the same
 * reason: a range that cannot hold a useful number of clients is a
 * misconfiguration rather than a small pool, and both halves have to agree
 * about it or one of them accepts a setting the other will not run.
 */
export const MIN_PREF_SPAN = 64

export const RULE_BOUNDS: Record<NumericRule, { min: number; max: number; label: string }> = {
  tableBase: { min: 1_000, max: 25_000, label: 'Routing table base' },
  rulePrefBase: { min: 1_000, max: 28_999, label: 'Assignment rule priority base' },
  catchAllPrefBase: { min: 2_000, max: 29_999, label: 'Catch-all rule priority base' },
  catchAllTable: { min: 2_000, max: 32_766, label: 'Catch-all routing table' },
  uciChunkSize: { min: 1, max: 1_000, label: 'UCI sessions per chunk' },
  chunkDelayMs: { min: 0, max: 60_000, label: 'Delay between chunks (ms)' },
  ruleChunkLines: { min: 50, max: 2_000, label: 'IP-rule lines per command' },
  execTimeoutSec: { min: 10, max: 600, label: 'Job command timeout (s)' },
  maxBatchRows: { min: 1, max: 5_000, label: 'Connections per batch' },
  wanErrorGraceSec: { min: 0, max: 3_600, label: 'WAN error grace (s)' },
  wanWarnUptimeSec: { min: 0, max: 3_600, label: 'WAN warning uptime (s)' },
  releaseGraceSec: { min: 0, max: 86_400, label: 'Lease release grace (s)' },
  autoRedialAfterMin: { min: 0, max: 1_440, label: 'Automatic redial delay (min)' },
  maxEvents: { min: 20, max: 1_000, label: 'Saved binding events' },
  stickyCap: { min: 100, max: 10_000, label: 'Sticky mappings kept' },
  historySampleSec: { min: 5, max: 3_600, label: 'Chart sample interval (s)' }
}

export const NUMERIC_KEYS = Object.keys(RULE_BOUNDS) as NumericRule[]
export const BOOLEAN_KEYS = [
  'remapOnWanError',
  'stickyByMac',
  'autoRepairTables'
] as const satisfies ReadonlyArray<keyof OwrtRules>

export const IFACE_PREFIX = /^[a-z][a-z0-9]{0,3}$/
export const UCI_NAME = /^[a-z][a-z0-9_]{0,31}$/

export function validLeaseFile(value: string): boolean {
  return (
    value.length <= 256 &&
    /^\/[A-Za-z0-9_./-]+$/.test(value) &&
    !value.split('/').includes('..')
  )
}

function validNumber(key: NumericRule, value: unknown): value is number {
  const bounds = RULE_BOUNDS[key]
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= bounds.min &&
    value <= bounds.max
  )
}

export function emptyConfig(): OwrtConfig {
  return { version: 1, rules: {}, ui: { showHints: true } }
}

/** Defensively load the hand-editable module config and retain valid overrides only. */
export function normalize(raw: unknown): OwrtConfig {
  if (!isRecord(raw)) return emptyConfig()
  const sourceRules = isRecord(raw.rules) ? raw.rules : {}
  const rules: Partial<OwrtRules> = {}

  for (const key of NUMERIC_KEYS) {
    const value = sourceRules[key]
    if (validNumber(key, value) && value !== DEFAULT_RULES[key]) {
      ;(rules as Record<string, unknown>)[key] = value
    }
  }
  for (const key of BOOLEAN_KEYS) {
    const value = sourceRules[key]
    if (typeof value === 'boolean' && value !== DEFAULT_RULES[key]) {
      ;(rules as Record<string, unknown>)[key] = value
    }
  }
  if (
    typeof sourceRules.ifacePrefix === 'string' &&
    IFACE_PREFIX.test(sourceRules.ifacePrefix) &&
    sourceRules.ifacePrefix !== DEFAULT_RULES.ifacePrefix
  ) {
    rules.ifacePrefix = sourceRules.ifacePrefix
  }
  if (
    typeof sourceRules.zoneName === 'string' &&
    UCI_NAME.test(sourceRules.zoneName) &&
    sourceRules.zoneName !== DEFAULT_RULES.zoneName
  ) {
    rules.zoneName = sourceRules.zoneName
  }
  if (
    (sourceRules.zoneMode === 'wildcard' || sourceRules.zoneMode === 'networks') &&
    sourceRules.zoneMode !== DEFAULT_RULES.zoneMode
  ) {
    rules.zoneMode = sourceRules.zoneMode
  }
  if (
    typeof sourceRules.leaseFile === 'string' &&
    validLeaseFile(sourceRules.leaseFile) &&
    sourceRules.leaseFile !== DEFAULT_RULES.leaseFile
  ) {
    rules.leaseFile = sourceRules.leaseFile
  }

  // Never accept a persisted numbering layout that overlaps its own safety rule/table.
  const candidate = { ...DEFAULT_RULES, ...rules }
  if (candidate.rulePrefBase >= candidate.catchAllPrefBase) {
    delete rules.rulePrefBase
    delete rules.catchAllPrefBase
  }
  const spanned = { ...DEFAULT_RULES, ...rules }
  // The same span test the tables get, for the preferences. One client rule per
  // WAN, so a range narrower than a batch runs into the catch-all preferences.
  // The floor applies whatever the batch size: bm-wanbind refuses an instance
  // with less than that between the two, and refuses it by leaving the section
  // out of its own list - which shows up as an instance with no devices, no
  // error and nothing to say why.
  if (
    spanned.rulePrefBase + spanned.maxBatchRows >= spanned.catchAllPrefBase ||
    spanned.catchAllPrefBase - spanned.rulePrefBase < MIN_PREF_SPAN
  ) {
    delete rules.rulePrefBase
    delete rules.catchAllPrefBase
    delete rules.maxBatchRows
  }
  const checked = { ...DEFAULT_RULES, ...rules }
  if (checked.tableBase + checked.maxBatchRows >= checked.catchAllTable) {
    delete rules.tableBase
    delete rules.maxBatchRows
    delete rules.catchAllTable
  }

  const ui = isRecord(raw.ui) ? raw.ui : {}
  return {
    version: 1,
    rules,
    ui: { showHints: ui.showHints !== false }
  }
}
