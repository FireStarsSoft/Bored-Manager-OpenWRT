/**
 * The daemon's own `config wanbind 'main'`: read for the form's initial values,
 * checked against the same limits the router holds, and applied over ubus.
 *
 * Every number here belongs to the router. Until 3.4.0 this module kept its own
 * copy of all of them under Module settings, wrote rules against that copy, and
 * the daemon wrote rules against its own - which is how one priority band came
 * to have two writers. There is one copy now, it is the router's, and this form
 * is how it is edited.
 *
 * The bounds below are stated on this side as well as on that one, and that is
 * deliberate rather than duplication: the daemon refuses the same things, but it
 * refuses a whole call with one sentence, while a form has to say which field is
 * wrong before anything is sent. Where the two windows differ this one is the
 * narrower - the daemon will take a grace of a day, and a day is a typo.
 */
import {
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { OkResult } from '@shared/types'
import { wanbindSettingsSet, type WanbindSettings } from '../agent'
import { DIRECT_PREF_SPAN } from '../records'
import { isRecord, textField } from '../util'
import { agentDeps, daemonProblem, daemonReady, recordEvent } from './runtime'
import type { BindingRuntime } from './types'

/** Every field of the section except the switch; see `settingsCheck`. */
type SettingKey = Exclude<keyof WanbindSettings, 'enabled'>

interface Bound {
  key: SettingKey
  label: string
  min: number
  max: number
}

/**
 * The room an instance needs between its client rules and its catch-all.
 *
 * MIN_PREF_SPAN in the daemon's `config.uc` and in this module's own
 * `config/rules.ts`, and the same number in all three for the same reason: it
 * is also the largest number of clients one instance could ever seat, so a
 * range narrower than this is a configuration that runs out during an ordinary
 * evening rather than a small pool.
 */
const MIN_PREF_SPAN = 64

/**
 * The form's own window on each number.
 *
 * `catch_all_table` stops at 2000 at the bottom, which already excludes 254 and
 * 255 - the router's own main and local tables, which the daemon refuses by
 * name because an `unreachable default` written into either takes the router off
 * the network. There is no second check for them here for that reason.
 *
 * Two of these windows are narrower than the router's: the daemon takes any
 * grace up to a day, and this form stops the two WAN graces at an hour. An hour
 * is already far past anything a flapping uplink needs, and a grace measured in
 * days is a slipped digit that leaves a WAN reserved for a device that left.
 * `release_grace` keeps the full day, because a lease reservation held overnight
 * is a real thing to want.
 */
const BOUNDS: readonly Bound[] = [
  { key: 'interval', label: 'Pass interval (s)', min: 5, max: 3_600 },
  { key: 'direct_pref_base', label: 'One-to-one rule priority base', min: 1_000, max: 28_000 },
  { key: 'rule_pref_base', label: 'Assignment rule priority base', min: 1_000, max: 28_999 },
  { key: 'catch_all_pref_base', label: 'Catch-all rule priority base', min: 2_000, max: 29_999 },
  { key: 'catch_all_table', label: 'Catch-all routing table', min: 2_000, max: 32_766 },
  { key: 'wan_table_base', label: 'WAN routing table base', min: 1_000, max: 25_000 },
  { key: 'wan_warn_uptime', label: 'New-WAN warning window (s)', min: 0, max: 3_600 },
  { key: 'wan_error_grace', label: 'WAN error grace (s)', min: 0, max: 3_600 },
  { key: 'release_grace', label: 'Lease release grace (s)', min: 0, max: 86_400 }
]

/**
 * What the daemon runs on when nothing is in the file.
 *
 * Its own defaults, not this module's old ones, and they are here so that a
 * form can open before the first `info` has landed. Two of them sit outside the
 * windows above - `catch_all_pref_base` at 30000 and `catch_all_table` at 253 -
 * which is not a mistake in either place and is exactly why an unchanged value
 * is never judged below.
 */
const DAEMON_DEFAULTS: WanbindSettings = {
  enabled: true,
  interval: 30,
  direct_pref_base: 19_000,
  rule_pref_base: 20_000,
  catch_all_pref_base: 30_000,
  catch_all_table: 253,
  wan_table_base: 10_000,
  wan_warn_uptime: 5,
  wan_error_grace: 20,
  release_grace: 120
}

/**
 * The section as the router last reported it.
 *
 * Off the cache rather than through `settings_get`, because `info` carries the
 * whole section on every tick and the cache is therefore never more than one
 * tick behind. Opening a form must not start a round trip: a form that does
 * cannot open at all on a router that has gone quiet, which is the moment
 * somebody most wants to look at what it was set to.
 */
export function settingsGet(runtime: BindingRuntime): WanbindSettings {
  return runtime.cache.info?.settings ?? DAEMON_DEFAULTS
}

/**
 * How wide the one-to-one priority band is on this router.
 *
 * The daemon's own number when it has said it, and the shared constant when it
 * has not. Both halves have always held 1000 here; asking the router first is
 * what keeps this check right on the day one of them changes it.
 */
function bandSpan(runtime: BindingRuntime): number {
  const span = runtime.cache.bindings?.band.span ?? 0
  return span > 0 ? span : DIRECT_PREF_SPAN
}

/**
 * Read one field, refuse what the router would refuse, and say which field.
 *
 * A blank field keeps the value in force, as everywhere else in this module. A
 * field holding exactly what the router already runs is not judged against the
 * window at all: the daemon ships two defaults that sit outside it, so a form
 * prefilled from a stock router would otherwise refuse to save a pass interval
 * because of a catch-all table nobody touched.
 */
function readEntered(
  values: Record<string, unknown>,
  current: WanbindSettings,
  findings: ModuleCheckFinding[]
): Partial<WanbindSettings> {
  const entered: Partial<WanbindSettings> = {}
  for (const bound of BOUNDS) {
    const text = textField(values, bound.key)
    if (!text) continue
    const value = Number(text)
    if (!Number.isInteger(value)) {
      findings.push({ level: 'error', label: `${bound.label} must be a whole number` })
      continue
    }
    if (value !== current[bound.key] && (value < bound.min || value > bound.max)) {
      findings.push({
        level: 'error',
        label: `${bound.label} must be a whole number ${bound.min}-${bound.max}`
      })
      continue
    }
    entered[bound.key] = value
  }
  return entered
}

/**
 * The two ways a set of numbers that are each fine can still not work together.
 *
 * Both are the daemon's own refusals, said here about the field somebody just
 * typed in. The first is the fault this whole release exists to remove, one
 * layer down: a one-to-one binding numbered inside the instance band is adopted
 * by an instance as one of its own client assignments, found to have no lease
 * behind it, and deleted on the next pass - once every pass, for ever, with
 * nothing anywhere saying why that address keeps losing its WAN.
 */
function crossFieldFindings(
  after: WanbindSettings,
  span: number,
  findings: ModuleCheckFinding[]
): void {
  const top = after.direct_pref_base + span - 1
  if (top >= after.rule_pref_base) {
    findings.push({
      level: 'error',
      label: `The one-to-one band ${after.direct_pref_base}-${top} is not below the assignment base ${after.rule_pref_base}`,
      detail:
        `A binding takes its priority from a band ${span} wide starting at the one-to-one base. ` +
        'It has to end before the instances start numbering their client rules, or a binding ' +
        'placed by hand is read by an instance as one of its own and swept on the next pass.'
    })
  }
  const room = after.catch_all_pref_base - after.rule_pref_base
  if (room < MIN_PREF_SPAN) {
    findings.push({
      level: 'error',
      label: `Only ${room} priorities between the assignment base ${after.rule_pref_base} and the catch-all base ${after.catch_all_pref_base}`,
      detail: `At least ${MIN_PREF_SPAN} are needed, and that number is also the most clients one instance could seat.`
    })
  }
}

export function settingsCheck(runtime: BindingRuntime, raw: unknown): ModuleCheckReport {
  if (!daemonReady(runtime)) {
    return failedCheck('This router does not answer for WAN Binding', daemonProblem(runtime))
  }

  const values = isRecord(raw) ? raw : {}
  const findings: ModuleCheckFinding[] = []
  const current = settingsGet(runtime)
  const entered = readEntered(values, current, findings)

  if (!Object.keys(entered).length && !hasBlockingFinding(findings)) {
    findings.push({
      level: 'error',
      label: 'Nothing was entered',
      detail: 'A blank field keeps the value in force; fill in at least one.'
    })
  }

  // Only what actually changes is sent, for the reason every other verb in this
  // contract omits rather than empties: a form about the pass interval is not a
  // statement about where the priority bands are.
  const changed = (Object.keys(entered) as SettingKey[]).filter(
    (key) => entered[key] !== current[key]
  )
  const changes: Partial<WanbindSettings> = {}
  for (const key of changed) changes[key] = entered[key]

  if (!hasBlockingFinding(findings)) {
    crossFieldFindings({ ...current, ...changes }, bandSpan(runtime), findings)
  }

  if (!hasBlockingFinding(findings)) {
    findings.push({
      level: changed.length ? 'pass' : 'info',
      label: changed.length
        ? `${changed.length} setting(s) change: ${changed.join(', ')}`
        : 'Every value entered is already in force',
      detail:
        'The pass interval takes effect at once - the router re-arms its timer rather than ' +
        'waiting out the old one. Every other number here is the default an instance is ' +
        'stamped with when it is created afterwards: a section already on the router keeps ' +
        'the numbers it has, because those are what the ip rules standing in its kernel were ' +
        'written against, so moving a base here moves nothing that is already running.'
    })
  }

  const ok = !hasBlockingFinding(findings)
  return ok
    ? { ok: true, token: runtime.settingsSession.issue(values, changes), findings }
    : { ok: false, findings }
}

/**
 * Send what changed.
 *
 * The switch is not part of this form and is never sent from it. `enabled`
 * going false takes every instance's rules off the router first, and a checkbox
 * reports false when it is simply absent - so one saved pass interval would
 * have taken every pool off the air, which is the largest thing this module can
 * do wearing the smallest form it has.
 */
export async function settingsApply(runtime: BindingRuntime, raw: unknown): Promise<OkResult> {
  const payload = isRecord(raw) ? raw : {}
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.settingsSession.take(token, payload.values)
  if (!taken) return { ok: false, error: 'that check expired or the form changed - check again' }
  if (!runtime.ctx.connected) return { ok: false, error: 'the router disconnected after the check' }
  if (!daemonReady(runtime)) return { ok: false, error: daemonProblem(runtime) }

  const changed = Object.keys(taken.payload)
  const result = await wanbindSettingsSet(agentDeps(runtime), taken.payload)
  if (!result.ok) return { ok: false, error: result.error ?? 'the router refused' }

  // The rows and the form's own initial values come from the next tick's fetch.
  // Nothing is written back into the cache here: the reply says what the router
  // holds now, and a second copy of it on this side is the arrangement this
  // whole release exists to remove.
  runtime.service.forceDump()
  recordEvent(
    runtime,
    'settings',
    changed.length
      ? `daemon settings changed on the router: ${changed.join(', ')}`
      : 'daemon settings were re-applied on the router unchanged'
  )
  return { ok: true, data: `${changed.length} setting(s) applied` }
}
