import {
  createCheckSession,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'

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
  leaseFile: '/tmp/dhcp.leases',
  maxEvents: 200,
  stickyCap: 6_000
}

type NumericRule = {
  [K in keyof OwrtRules]: OwrtRules[K] extends number ? K : never
}[keyof OwrtRules]

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
  'stickyByMac'
] as const satisfies ReadonlyArray<keyof OwrtRules>

const IFACE_PREFIX = /^[a-z][a-z0-9]{0,3}$/
const UCI_NAME = /^[a-z][a-z0-9_]{0,31}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

  toggleHints(): boolean {
    return this.update((config) => {
      config.ui.showHints = !config.ui.showHints
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

function text(values: Record<string, unknown>, key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value)
}

/**
 * Check/apply adapter for the declarative settings form. Keeping it beside the
 * store makes the "persist only diffs" invariant impossible for callers to skip.
 */
export class RulesEditor {
  private session = createCheckSession<Partial<OwrtRules>>()

  constructor(
    private ctx: ModuleContext,
    private store: ConfigStore,
    private hasTopology: () => boolean
  ) {}

  effective(): Record<string, string | number | boolean> {
    const current = this.store.effectiveRules()
    const out: Record<string, string | number | boolean> = {}
    for (const key of Object.keys(DEFAULT_RULES) as Array<keyof OwrtRules>) {
      out[key] = current[key]
    }
    return out
  }

  check(raw: unknown): ModuleCheckReport {
    const values = isRecord(raw) ? raw : {}
    const findings: ModuleCheckFinding[] = []
    const entered: Partial<OwrtRules> = {}

    for (const key of NUMERIC_KEYS) {
      const rawValue = text(values, key)
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

    const prefix = text(values, 'ifacePrefix')
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
    const zoneName = text(values, 'zoneName')
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
    const zoneMode = text(values, 'zoneMode')
    if (zoneMode) {
      if (zoneMode !== 'wildcard' && zoneMode !== 'networks') {
        findings.push({ level: 'error', label: 'Firewall zone mode must be wildcard or networks' })
      } else {
        entered.zoneMode = zoneMode
      }
    }
    const leaseFile = text(values, 'leaseFile')
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

    const candidate: OwrtRules = { ...DEFAULT_RULES, ...entered }
    if (candidate.rulePrefBase >= candidate.catchAllPrefBase) {
      findings.push({
        level: 'error',
        label: 'Assignment rule priorities must end before the catch-all priority range'
      })
    }
    if (candidate.tableBase + candidate.maxBatchRows >= candidate.catchAllTable) {
      findings.push({
        level: 'error',
        label: 'The PPPoE routing-table range overlaps the catch-all routing table',
        detail: 'Raise the catch-all table or lower the table base / maximum batch size.'
      })
    }

    const current = this.store.effectiveRules()
    if (this.hasTopology()) {
      const locked: Array<keyof OwrtRules> = [
        'tableBase',
        'rulePrefBase',
        'catchAllPrefBase',
        'catchAllTable',
        'zoneName',
        'zoneMode'
      ]
      const changed = locked.filter((key) => candidate[key] !== current[key])
      if (changed.length) {
        findings.push({
          level: 'error',
          label: 'Numbering and firewall-layout rules cannot change while batches or binding instances exist',
          detail: `Delete those router-managed records first before changing ${changed.join(', ')}.`
        })
      }
    }
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
    findings.push({
      level: 'pass',
      label: Object.keys(kept).length
        ? `${Object.keys(kept).length} rule override(s) will be saved`
        : 'Every OpenWRT rule will use its default'
    })

    const ok = !hasBlockingFinding(findings)
    return ok
      ? { ok: true, token: this.session.issue(values, kept), findings }
      : { ok: false, findings }
  }

  apply(raw: unknown): OkResult {
    const payload = isRecord(raw) ? raw : {}
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) {
      return { ok: false, error: 'that check expired or the form changed - check again' }
    }
    this.store.setRules(taken.payload)
    this.ctx.log(
      `openwrt: rule overrides saved: ${Object.keys(taken.payload).join(', ') || 'none'}`
    )
    return { ok: true }
  }

  reset(): OkResult {
    const current = this.store.effectiveRules()
    if (
      this.hasTopology() &&
      (current.tableBase !== DEFAULT_RULES.tableBase ||
        current.rulePrefBase !== DEFAULT_RULES.rulePrefBase ||
        current.catchAllPrefBase !== DEFAULT_RULES.catchAllPrefBase ||
        current.catchAllTable !== DEFAULT_RULES.catchAllTable ||
        current.zoneName !== DEFAULT_RULES.zoneName ||
        current.zoneMode !== DEFAULT_RULES.zoneMode)
    ) {
      return {
        ok: false,
        error: 'numbering and firewall-layout rules cannot be reset while batches or binding instances exist'
      }
    }
    this.store.setRules({})
    this.session.clear()
    this.ctx.log('openwrt: rule overrides cleared')
    return { ok: true }
  }

  clear(): void {
    this.session.clear()
  }
}
