import {
  createCheckSession,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { isRecord, textField } from './util'

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
  stickyCap: 6_000
}

type NumericRule = {
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
const MIN_PREF_SPAN = 64

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
  stickyCap: { min: 100, max: 10_000, label: 'Sticky mappings kept' }
}

const NUMERIC_KEYS = Object.keys(RULE_BOUNDS) as NumericRule[]
const BOOLEAN_KEYS = [
  'remapOnWanError',
  'stickyByMac',
  'autoRepairTables'
] as const satisfies ReadonlyArray<keyof OwrtRules>

const IFACE_PREFIX = /^[a-z][a-z0-9]{0,3}$/
const UCI_NAME = /^[a-z][a-z0-9_]{0,31}$/

function validLeaseFile(value: string): boolean {
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

function emptyConfig(): OwrtConfig {
  return { version: 1, rules: {}, ui: { showHints: true } }
}

/** Defensively load the hand-editable module config and retain valid overrides only. */
function normalize(raw: unknown): OwrtConfig {
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

/**
 * Config is shared by all router instances, so the normalised document is kept
 * only until something writes it: `onConfigChange` fires for every instance of
 * the module, this one included, so a toggle made on another router drops this
 * copy instead of being overwritten by it. Without the cache, `effectiveRules()`
 * re-read and re-validated the file on every call - many times per fast tick,
 * since every batch, every rule number and every table poll asks for it.
 */
export class ConfigStore {
  private cache: OwrtConfig | null = null
  private rules: OwrtRules | null = null
  private readonly unsubscribe: () => void

  constructor(private ctx: ModuleContext) {
    this.unsubscribe = ctx.onConfigChange(() => {
      this.cache = null
      this.rules = null
    })
  }

  read(): OwrtConfig {
    return (this.cache ??= normalize(this.ctx.configGet()))
  }

  effectiveRules(): OwrtRules {
    return (this.rules ??= { ...DEFAULT_RULES, ...this.read().rules })
  }

  update<T>(mutate: (config: OwrtConfig) => T): T {
    const config = this.read()
    const result = mutate(config)
    const written = normalize(config)
    this.ctx.configSet(written)
    // The listener above has just cleared both; what was written is what the
    // next read should see.
    this.cache = written
    this.rules = null
    return result
  }

  setRules(rules: Partial<OwrtRules>): void {
    this.update((config) => {
      config.rules = rules
    })
  }

  /**
   * Set the flag outright. A checkbox already knows which state it wants, and
   * the toggle this replaced turned that into "whatever the opposite of the
   * server's copy is" - the wrong answer whenever the page was opened before
   * another surface changed it.
   */
  setHints(on: boolean): boolean {
    return this.update((config) => {
      config.ui.showHints = on
      return config.ui.showHints
    })
  }

  reset(): void {
    this.cache = null
    this.rules = null
  }

  /** Stop listening. The context drops the listener on revoke anyway; this is for a tidy dispose. */
  dispose(): void {
    this.unsubscribe()
    this.reset()
  }
}

/**
 * Check/apply adapter for the declarative settings form. Keeping it beside the
 * store makes the "persist only diffs" invariant impossible for callers to skip.
 */
/**
 * Whether this router already has records whose layout the locked rules
 * describe.
 *
 * `unknown` is the case that used to be missing. The records are per-machine
 * while the rules are global, so "no records" read off a disconnected context -
 * or off a different machine in the pool - is not the same statement as "this
 * router has none". Answering `none` there unlocked the numbering of a router
 * that was sitting on a hundred live PPPoE sessions, and the next create wrote
 * them into a different table range than the one already in use.
 */
export type RulesTopology = 'none' | 'present' | 'unknown'

const UNKNOWN_TOPOLOGY =
  'Numbering and firewall-layout rules cannot change while no router is connected'

/** The six values that describe where this module's objects live on a router. */
const LOCKED_KEYS: ReadonlyArray<keyof OwrtRules> = [
  'tableBase',
  'rulePrefBase',
  'catchAllPrefBase',
  'catchAllTable',
  'zoneName',
  'zoneMode'
]

export class RulesEditor {
  private session = createCheckSession<Partial<OwrtRules>>()

  constructor(
    private ctx: ModuleContext,
    private store: ConfigStore,
    private topology: () => RulesTopology
  ) {}

  effective(): Record<string, string | number | boolean> {
    const current = this.store.effectiveRules()
    const out: Record<string, string | number | boolean> = {}
    for (const key of Object.keys(DEFAULT_RULES) as Array<keyof OwrtRules>) {
      out[key] = current[key]
    }
    return out
  }

  /**
   * Validate one group of rules against everything already in force.
   *
   * The form is split into four groups, and each submission carries only its
   * own fields. Merging over `DEFAULT_RULES` therefore meant saving a group
   * silently reset every override belonging to the other three - the check
   * reported "3 rule override(s) will be saved" and quietly dropped four.
   * Merging over the current values instead makes a blank field mean "leave
   * this as it is"; the placeholders still name the defaults, and Reset every
   * rule is how a user goes back to them.
   */
  check(raw: unknown): ModuleCheckReport {
    const values = isRecord(raw) ? raw : {}
    const findings: ModuleCheckFinding[] = []
    const entered: Partial<OwrtRules> = {}
    const current = this.store.effectiveRules()

    for (const key of NUMERIC_KEYS) {
      const rawValue = textField(values, key)
      if (!rawValue) continue
      const value = Number(rawValue)
      const bounds = RULE_BOUNDS[key]
      if (!Number.isInteger(value)) {
        findings.push({
          level: 'error',
          label: `${bounds.label} must be a whole number`,
          detail: `You entered "${rawValue}".`
        })
      } else if (value < bounds.min || value > bounds.max) {
        findings.push({
          level: 'error',
          label: `${bounds.label} must be between ${bounds.min} and ${bounds.max}`,
          detail: `You entered ${value}.`
        })
      } else {
        ;(entered as Record<string, unknown>)[key] = value
      }
    }

    const prefix = textField(values, 'ifacePrefix')
    if (prefix) {
      if (!IFACE_PREFIX.test(prefix)) {
        findings.push({
          level: 'error',
          label: 'Interface prefix must be 1-4 lowercase letters or digits and start with a letter'
        })
      } else {
        entered.ifacePrefix = prefix
      }
    }
    const zoneName = textField(values, 'zoneName')
    if (zoneName) {
      if (!UCI_NAME.test(zoneName)) {
        findings.push({
          level: 'error',
          label: 'Firewall zone name must start with a lowercase letter and contain only lowercase letters, digits or underscores'
        })
      } else {
        entered.zoneName = zoneName
      }
    }
    const zoneMode = textField(values, 'zoneMode')
    if (zoneMode) {
      if (zoneMode !== 'wildcard' && zoneMode !== 'networks') {
        findings.push({ level: 'error', label: 'Firewall zone mode must be wildcard or networks' })
      } else {
        entered.zoneMode = zoneMode
      }
    }
    const leaseFile = textField(values, 'leaseFile')
    if (leaseFile) {
      if (!validLeaseFile(leaseFile)) {
        findings.push({ level: 'error', label: 'Lease file must be a short absolute path without line breaks' })
      } else {
        entered.leaseFile = leaseFile
      }
    }
    for (const key of BOOLEAN_KEYS) {
      if (typeof values[key] === 'boolean') {
        ;(entered as Record<string, unknown>)[key] = values[key]
      }
    }

    const candidate: OwrtRules = { ...current, ...entered }
    findings.push(...this.blockers(candidate, current))
    if (candidate.zoneMode === 'networks') {
      findings.push({
        level: 'info',
        label: 'Firewall membership will be written per network',
        detail: 'This is the compatibility fallback when fw4 does not expand the wildcard netdev.'
      })
    }

    const kept: Partial<OwrtRules> = {}
    for (const key of Object.keys(DEFAULT_RULES) as Array<keyof OwrtRules>) {
      if (candidate[key] !== DEFAULT_RULES[key]) {
        ;(kept as Record<string, unknown>)[key] = candidate[key]
      }
    }
    const changed = (Object.keys(DEFAULT_RULES) as Array<keyof OwrtRules>).filter(
      (key) => candidate[key] !== current[key]
    )
    findings.push({
      level: 'pass',
      label: changed.length
        ? `${changed.length} rule(s) will change: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ', ...' : ''}`
        : 'Nothing changes - every value entered is already in force',
      detail: Object.keys(kept).length
        ? `${Object.keys(kept).length} rule override(s) will be saved; everything else keeps its default.`
        : 'Every OpenWRT rule will use its default.'
    })

    const ok = !hasBlockingFinding(findings)
    return ok
      ? // The token freezes what the user typed for *this* group, not the whole
        // merged document. Freezing the merge meant a save carried a snapshot
        // of every other group as it looked during the check, so applying it
        // reverted any override saved in between - and, because the snapshot
        // was written verbatim, it wrote locked values straight past the lock
        // that had just approved them.
        { ok: true, token: this.session.issue(values, entered), findings }
      : { ok: false, findings }
  }

  apply(raw: unknown): OkResult {
    const payload = isRecord(raw) ? raw : {}
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) {
      return { ok: false, error: 'that check expired or the form changed - check again' }
    }
    // Re-derive against what is in force now rather than trusting the check.
    // Ten minutes can pass between the two, and in that time another group can
    // be saved, a batch can be created, or the connection can drop.
    const current = this.store.effectiveRules()
    const candidate: OwrtRules = { ...current, ...taken.payload }
    const blocker = this.blockers(candidate, current)[0]
    if (blocker) {
      return { ok: false, error: `${blocker.label.toLowerCase()} - check again` }
    }

    const kept: Partial<OwrtRules> = {}
    for (const key of Object.keys(DEFAULT_RULES) as Array<keyof OwrtRules>) {
      if (candidate[key] !== DEFAULT_RULES[key]) {
        ;(kept as Record<string, unknown>)[key] = candidate[key]
      }
    }
    this.store.setRules(kept)
    this.ctx.log(`openwrt: rule overrides saved: ${Object.keys(kept).join(', ') || 'none'}`)
    return { ok: true }
  }

  /**
   * Put every rule back to its default except the ones that are locked, and say
   * which ones were kept.
   *
   * It used to refuse wholesale: one batch on the router and "Reset every rule"
   * did nothing at all, so the chunk size, the grace periods and the lease file
   * - none of which describe where anything lives - could no longer be reset
   * without deleting the pool first. The locked six are the only values a
   * running router's records depend on, and they are the only ones held back.
   */
  reset(): OkResult {
    const current = this.store.effectiveRules()
    const topology = this.topology()
    const held = topology === 'none'
      ? []
      : LOCKED_KEYS.filter((key) => current[key] !== DEFAULT_RULES[key])
    const kept: Partial<OwrtRules> = {}
    for (const key of held) {
      ;(kept as Record<string, unknown>)[key] = current[key]
    }
    this.store.setRules(kept)
    this.session.clear()
    this.ctx.log(
      `openwrt: rule overrides cleared${held.length ? `, keeping ${held.join(', ')}` : ''}`
    )
    if (!held.length) return { ok: true }
    return {
      ok: true,
      data:
        `Every rule is back to its default except ${held.join(', ')}, kept because ` +
        (topology === 'unknown'
          ? 'no router is connected to say whether records exist that depend on them. Connect the router these rules apply to, then reset again.'
          : 'batches or binding instances describe where their objects live on the router. Delete those records first, then reset again.')
    }
  }

  /**
   * Every reason a candidate must not be saved, in one place so `check` and
   * `apply` cannot drift apart. `check` shows them; `apply` runs them again
   * against the values in force at that moment and refuses on the first.
   */
  private blockers(candidate: OwrtRules, current: OwrtRules): ModuleCheckFinding[] {
    const findings: ModuleCheckFinding[] = []
    if (candidate.rulePrefBase >= candidate.catchAllPrefBase) {
      findings.push({
        level: 'error',
        label: 'Assignment rule priorities must end before the catch-all priority range'
      })
    }
    // The bases alone are checked above; this is the range each of them spans.
    // One client ip rule per WAN and one routing table per WAN, so a batch of
    // `maxBatchRows` sessions needs that many of both before the catch-all
    // numbering starts. Only the tables were ever checked, so a priority base
    // set close under the catch-all range saved cleanly and then silently ran
    // out of preferences: every device past the gap stayed queued behind a
    // fail-closed catch-all with no internet and no setting saying why.
    if (candidate.rulePrefBase + candidate.maxBatchRows >= candidate.catchAllPrefBase) {
      findings.push({
        level: 'error',
        label: 'The client rule priority range overlaps the catch-all priority range',
        detail: `Each bound device takes one ip rule priority from ${candidate.rulePrefBase} upwards and a batch can hold ${candidate.maxBatchRows}, so the catch-all base has to sit at least that far above it. Raise the catch-all priority base or lower the rule priority base / maximum batch size.`
      })
    }
    // A floor as well as a gap, because the router half has one. A narrow range
    // passes every test above when the batch size is small, and `bm-wanbind`
    // then refuses the instance by omitting it from its own list - so the
    // binding table shows nothing bound, nothing waiting and no error, and the
    // only explanation is a line in the router's syslog.
    if (candidate.catchAllPrefBase - candidate.rulePrefBase < MIN_PREF_SPAN) {
      findings.push({
        level: 'error',
        label: 'The client rule priority range is too narrow',
        detail: `There are ${candidate.catchAllPrefBase - candidate.rulePrefBase} priorities between the two bases, and at least ${MIN_PREF_SPAN} are needed. The router's own binding service refuses an instance narrower than that, and it refuses it silently.`
      })
    }
    if (candidate.tableBase + candidate.maxBatchRows >= candidate.catchAllTable) {
      findings.push({
        level: 'error',
        label: 'The PPPoE routing-table range overlaps the catch-all routing table',
        detail: 'Raise the catch-all table or lower the table base / maximum batch size.'
      })
    }
    const changed = LOCKED_KEYS.filter((key) => candidate[key] !== current[key])
    if (!changed.length) return findings
    const topology = this.topology()
    if (topology === 'unknown') {
      findings.push({
        level: 'error',
        label: UNKNOWN_TOPOLOGY,
        detail: `Connect the router that these rules will apply to, then change ${changed.join(', ')}.`
      })
    } else if (topology === 'present') {
      findings.push({
        level: 'error',
        label: 'Numbering and firewall-layout rules cannot change while batches or binding instances exist',
        detail: `Delete those router-managed records first before changing ${changed.join(', ')}.`
      })
    }
    return findings
  }

  clear(): void {
    this.session.clear()
  }
}
