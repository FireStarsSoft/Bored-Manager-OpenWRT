/**
 * The shape of the module's own settings document, and the rules for reading
 * one back off disk.
 *
 * Two invariants live here and nowhere else: only values that differ from
 * `DEFAULT_RULES` are ever written (so a default that changes in a later
 * release reaches routers that never touched it), and a persisted numbering
 * layout that overlaps its own safety range is dropped rather than honoured.
 */
import { DIRECT_PREF_SPAN } from '../records'
import { isRecord } from '../util'

/**
 * The PPPoE knobs that used to live here - interface prefix, chunk sizes and
 * delays, batch caps, the redial timer, the zone membership mode - are gone
 * with the SSH path that consumed them. A pool records its own numbering and
 * firewall on the router, and the daemon's watchdog has its own settings
 * form. `tableBase` stays for two callers: the binding half numbers extra WAN
 * tables from it, and the create form offers it as the default base.
 */
export interface OwrtRules {
  tableBase: number
  rulePrefBase: number
  /**
   * Where the `DIRECT_PREF_SPAN`-wide band the one-to-one bindings take their
   * preferences from starts. It is a setting rather than a constant for the
   * same reason `rulePrefBase` is: a router that already has something living
   * at these numbers needs somewhere else to put the module's own band, and
   * moving it afterwards is what the stamped `pref` on each record protects
   * against.
   */
  directPrefBase: number
  catchAllPrefBase: number
  catchAllTable: number
  ruleChunkLines: number
  execTimeoutSec: number
  zoneName: string
  remapOnWanError: boolean
  wanErrorGraceSec: number
  wanWarnUptimeSec: number
  stickyByMac: boolean
  releaseGraceSec: number
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
  /**
   * How often the binding monitor sweeps the router's whole `ip rule` table.
   * It is deliberately far slower than the fast sweep: the monitor exists to
   * surface rules nobody in this module wrote, and those change when a person
   * changes them, not every two seconds.
   */
  scanIntervalSec: number
}

export interface OwrtConfig {
  version: 1
  /** Only values different from `DEFAULT_RULES` are written. */
  rules: Partial<OwrtRules>
  ui: { showHints: boolean }
}

export const DEFAULT_RULES: OwrtRules = {
  tableBase: 10_000,
  rulePrefBase: 20_000,
  directPrefBase: 19_000,
  catchAllPrefBase: 29_900,
  catchAllTable: 29_999,
  ruleChunkLines: 500,
  execTimeoutSec: 60,
  zoneName: 'bmwanpool',
  remapOnWanError: true,
  wanErrorGraceSec: 30,
  wanWarnUptimeSec: 60,
  stickyByMac: true,
  releaseGraceSec: 300,
  autoRepairTables: true,
  leaseFile: '/tmp/dhcp.leases',
  maxEvents: 200,
  stickyCap: 6_000,
  // What the slow sweep produced before this was a setting, so a router that
  // never touches it charts exactly as it did.
  historySampleSec: 60,
  scanIntervalSec: 60
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
  directPrefBase: { min: 1_000, max: 28_000, label: 'One-to-one rule priority base' },
  catchAllPrefBase: { min: 2_000, max: 29_999, label: 'Catch-all rule priority base' },
  catchAllTable: { min: 2_000, max: 32_766, label: 'Catch-all routing table' },
  ruleChunkLines: { min: 50, max: 2_000, label: 'IP-rule lines per command' },
  execTimeoutSec: { min: 10, max: 600, label: 'Job command timeout (s)' },
  wanErrorGraceSec: { min: 0, max: 3_600, label: 'WAN error grace (s)' },
  wanWarnUptimeSec: { min: 0, max: 3_600, label: 'WAN warning uptime (s)' },
  releaseGraceSec: { min: 0, max: 86_400, label: 'Lease release grace (s)' },
  maxEvents: { min: 20, max: 1_000, label: 'Saved binding events' },
  stickyCap: { min: 100, max: 10_000, label: 'Sticky mappings kept' },
  historySampleSec: { min: 5, max: 3_600, label: 'Chart sample interval (s)' },
  scanIntervalSec: { min: 15, max: 3_600, label: 'Binding scan interval (s)' }
}

export const NUMERIC_KEYS = Object.keys(RULE_BOUNDS) as NumericRule[]
export const BOOLEAN_KEYS = [
  'remapOnWanError',
  'stickyByMac',
  'autoRepairTables'
] as const satisfies ReadonlyArray<keyof OwrtRules>

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
    typeof sourceRules.zoneName === 'string' &&
    UCI_NAME.test(sourceRules.zoneName) &&
    sourceRules.zoneName !== DEFAULT_RULES.zoneName
  ) {
    rules.zoneName = sourceRules.zoneName
  }
  if (
    typeof sourceRules.leaseFile === 'string' &&
    validLeaseFile(sourceRules.leaseFile) &&
    sourceRules.leaseFile !== DEFAULT_RULES.leaseFile
  ) {
    rules.leaseFile = sourceRules.leaseFile
  }

  // Never accept a persisted numbering layout that overlaps its own safety
  // rule/table, or leaves less room than the router half will run with.
  const candidate = { ...DEFAULT_RULES, ...rules }
  if (
    candidate.rulePrefBase >= candidate.catchAllPrefBase ||
    candidate.catchAllPrefBase - candidate.rulePrefBase < MIN_PREF_SPAN
  ) {
    delete rules.rulePrefBase
    delete rules.catchAllPrefBase
  }
  const checked = { ...DEFAULT_RULES, ...rules }
  if (checked.tableBase + MIN_PREF_SPAN >= checked.catchAllTable) {
    delete rules.tableBase
    delete rules.catchAllTable
  }

  // The one-to-one band has to end before the assignment band begins. Let the
  // two overlap and the instance planner reads a 1-1 rule back as one of its
  // own assignments: it adopts the preference, finds no lease that justifies
  // it, and deletes on the next tick a binding somebody placed by hand - once
  // per tick, with nothing anywhere saying why the address keeps losing its
  // WAN. The direct override goes first because it is the newer setting and
  // the more likely mistake; only if the shipped default still overlaps is a
  // lowered `rulePrefBase` the thing that has to go, and it leaves with
  // `catchAllPrefBase` because the guard above treats those two as one pair
  // and half a pair is a layout with the catch-all below the assignments.
  const banded = { ...DEFAULT_RULES, ...rules }
  if (banded.directPrefBase + DIRECT_PREF_SPAN > banded.rulePrefBase) {
    delete rules.directPrefBase
    const retried = { ...DEFAULT_RULES, ...rules }
    if (retried.directPrefBase + DIRECT_PREF_SPAN > retried.rulePrefBase) {
      delete rules.rulePrefBase
      delete rules.catchAllPrefBase
    }
  }

  const ui = isRecord(raw.ui) ? raw.ui : {}
  return {
    version: 1,
    rules,
    ui: { showHints: ui.showHints !== false }
  }
}
