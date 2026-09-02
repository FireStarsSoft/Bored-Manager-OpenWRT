/**
 * Check/apply adapter for the declarative settings form. Kept beside the store
 * so the "persist only diffs" invariant is impossible for a caller to skip.
 */
import {
  createCheckSession,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { isRecord, textField } from '../util'
import {
  BOOLEAN_KEYS,
  DEFAULT_RULES,
  MIN_PREF_SPAN,
  NUMERIC_KEYS,
  RULE_BOUNDS,
  UCI_NAME,
  validLeaseFile,
  type OwrtRules
} from './rules'
import type { ConfigStore } from './store'

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

export class RulesEditor {
  private session = createCheckSession<Partial<OwrtRules>>()

  constructor(
    private ctx: ModuleContext,
    private store: ConfigStore
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
    findings.push(...this.blockers(candidate))

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
    const blocker = this.blockers(candidate)[0]
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
   * It used to refuse wholesale: one record on the router and "Reset every
   * rule" did nothing at all, so the grace periods and the lease file - none of
   * which describe where anything lives - could no longer be reset without
   * deleting the instance first. The locked three are the only values a running
   * router's records depend on, and they are the only ones held back.
   */
  reset(): OkResult {
    // Nothing is held back any more, and the reason is the whole of this
    // release. Three numbers here used to be locked while an instance existed,
    // because the rules standing on the router had been written against them -
    // move one and the next pass failed to recognise its own work and wrote a
    // second copy of everything. The router owns those numbers now: it stamps
    // each section with the band it was created under and re-reads them itself,
    // so there is nothing on any router this reset could contradict.
    this.store.setRules({})
    this.session.clear()
    this.ctx.log('openwrt: rule overrides cleared')
    return { ok: true }
  }

  /**
   * Every reason a candidate must not be saved, in one place so `check` and
   * `apply` cannot drift apart. `check` shows them; `apply` runs them again
   * against the values in force at that moment and refuses on the first.
   */
  private blockers(candidate: OwrtRules): ModuleCheckFinding[] {
    const findings: ModuleCheckFinding[] = []
    if (candidate.rulePrefBase >= candidate.catchAllPrefBase) {
      findings.push({
        level: 'error',
        label: 'Assignment rule priorities must end before the catch-all priority range'
      })
    }
    // A floor as well as an ordering, because the router half has one. A
    // narrow range would make `bm-wanbind` refuse the instance by omitting it
    // from its own list - so the binding table shows nothing bound, nothing
    // waiting and no error, and the only explanation is a line in syslog.
    if (candidate.catchAllPrefBase - candidate.rulePrefBase < MIN_PREF_SPAN) {
      findings.push({
        level: 'error',
        label: 'The client rule priority range is too narrow',
        detail: `There are ${candidate.catchAllPrefBase - candidate.rulePrefBase} priorities between the two bases, and at least ${MIN_PREF_SPAN} are needed. The router's own binding service refuses an instance narrower than that, and it refuses it silently.`
      })
    }
    // WAN tables are numbered upward from the base, so the catch-all table
    // has to leave room for at least a pool's worth of them.
    if (candidate.tableBase + MIN_PREF_SPAN >= candidate.catchAllTable) {
      findings.push({
        level: 'error',
        label: 'The WAN routing-table range overlaps the catch-all routing table',
        detail: 'Raise the catch-all table or lower the table base.'
      })
    }
    // No refusal here any more either. What used to be refused - moving a
    // priority band under a live instance - is not this editor's to refuse,
    // because it is not this module's number: an instance is stamped by the
    // router with the band it was created under and keeps it, and the defaults
    // for the next one are edited on Connection, under WAN Binding.
    return findings
  }

  clear(): void {
    this.session.clear()
  }
}
