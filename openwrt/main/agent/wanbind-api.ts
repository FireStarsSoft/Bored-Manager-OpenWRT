/**
 * Every call this module makes about WAN Binding, and nothing else.
 *
 * From packages 2.4.0 the router owns binding outright: the sections, the
 * routing tables, the firewall paths, the fail-closed catch-all and every ip
 * rule. This module adds, removes and reads. That is the same arrangement PPPoE
 * pools have had since 3.0.0, and it arrived here for a reason worth keeping in
 * front of anybody who edits this file.
 *
 * Until 3.4.0 both halves wrote the one-to-one priority band. The module wrote
 * rules over SSH without ever writing a `config direct` section; the daemon owns
 * that band and removes every rule in it no section asks for. On a real router
 * that was 34 rules deleted every thirty seconds and written back a second
 * later, for ever - each bound address on the router's default connection for
 * about a second in every thirty, with neither half reporting a conflict because
 * each was doing exactly what it had been told. **There is no fall back to
 * writing.** A call that fails means the rows are one tick stale, which the
 * snapshot says; the only fall back lives a level up at the capability verdict,
 * where no package, an old package and a stopped service all mean the same
 * thing.
 *
 * Two shapes run through all of it:
 *
 * - **A field that is not sent keeps what the section has.** Every mutating verb
 *   is create-and-edit in one, so an edit naming only a WAN must not be read as
 *   saying the binding has no name and no LAN. Each wrapper therefore omits a
 *   key rather than sending it empty, and there is no spelling for "clear it" -
 *   inventing a sentinel would be a second spelling of nothing for the two
 *   halves to disagree about.
 * - **The JSON types are not decorative.** ubus checks an argument against the
 *   template the daemon published and refuses the whole call on a mismatch, so a
 *   number sent as a string does not make a weaker call, it makes no call at
 *   all - which on a page looks exactly like the daemon being broken.
 */
import { hasFeature, objectCall, unwrap, WANBIND_OBJECT, type AgentCallResult, type AgentDeps } from './client'
import type { AgentCapability } from '../probe'
import {
  WANBIND_API,
  type WanbindBindReply,
  type WanbindBindSpec,
  type WanbindBindingsReply,
  type WanbindCheckReply,
  type WanbindInfo,
  type WanbindInstanceCheckReply,
  type WanbindInstanceDeleteReply,
  type WanbindInstanceSetReply,
  type WanbindInstanceSpec,
  type WanbindLayoutReply,
  type WanbindSettings,
  type WanbindStats,
  type WanbindUnbindManyReply,
  type WanbindUnbindReply,
  type WanbindWansReply,
  type WanbindAssignment,
} from './wanbind-types'
import type {
  WanbindRulesReply,
  WanbindVerifyReply,
  WanbindRuleExplainReply,
  WanbindWaitingReply
} from './wanbind-monitor-types'


/** A pass over four thousand clients is seconds, not milliseconds. */
const PASS_TIMEOUT_MS = 60_000

/**
 * Writing a section, preparing the router and running a pass, in one call.
 *
 * Longer than a pass because it may also reload netifd and fw4, and a router
 * that has just been given `option ip4table` on eight pool WANs takes its time
 * about it. A timeout here is not a failure the caller can act on - the write
 * either happened or it did not, and the next tick will say which - so it is set
 * where a slow router finishes rather than where a fast one usually does.
 */
const MUTATE_TIMEOUT_MS = 120_000

/**
 * The contract generation of the installed `bm-wanbind`, or 0.
 *
 * Read from the feature descriptor the agent relays rather than from the package
 * version: the two move for different reasons, and a package that added a ubus
 * call without changing the shape of an existing one is one this module can
 * still drive.
 */
export function wanbindApi(capability: AgentCapability): number {
  let best = 0
  for (const entry of capability.features) {
    if (entry.provides.includes('binding') && entry.apiVersion > best) {
      best = entry.apiVersion
    }
  }
  return best
}

/**
 * Whether this router keeps its own WAN Binding, and this module can drive it.
 *
 * Three facts folded into one answer on purpose, because every surface asks the
 * same question and only `requirements.ts` needs to tell them apart: the agent
 * is usable, `bm-wanbind` is installed, and it speaks the contract this module
 * was written against.
 */
export function hasBindingDaemon(capability: AgentCapability): boolean {
  return (
    hasFeature(capability, 'binding') &&
    wanbindApi(capability) >= WANBIND_API
  )
}

function call<T>(
  deps: AgentDeps,
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<AgentCallResult<T>> {
  return objectCall<T>(deps, WANBIND_OBJECT, method, args, timeoutMs)
}

// ---------------------------------------------------------------------- reads

export function wanbindInfo(deps: AgentDeps): Promise<AgentCallResult<WanbindInfo>> {
  return call<WanbindInfo>(deps, 'info')
}

export function wanbindStats(deps: AgentDeps): Promise<AgentCallResult<WanbindStats>> {
  return call<WanbindStats>(deps, 'stats')
}

export function wanbindSettingsGet(
  deps: AgentDeps
): Promise<AgentCallResult<WanbindSettings>> {
  return call<WanbindSettings>(deps, 'settings_get')
}

/** Who is on which WAN. `id` empty means every instance. */
export function wanbindAssignments(
  deps: AgentDeps,
  id = ''
): Promise<AgentCallResult<{ assignments: WanbindAssignment[] }>> {
  return call<{ assignments: WanbindAssignment[] }>(deps, 'assignments', { instance: id })
}

/** And who is not, with their place in the queue. */
export interface WanbindWaitingOptions {
  limit?: number
  offset?: number
  /**
   * Devices an instance is deliberately leaving alone because a one-to-one
   * binding already decides their address.
   *
   * Off by default on the router, and asked for here because the table shows
   * them: they are not waiting for anything, and on a router with five hundred
   * bindings under four instances they were most of the answer.
   */
  includeReserved?: boolean
}

export function wanbindWaiting(
  deps: AgentDeps,
  id = '',
  options: WanbindWaitingOptions = {}
): Promise<AgentCallResult<WanbindWaitingReply>> {
  return call<WanbindWaitingReply>(deps, 'waiting', {
    instance: id,
    limit: Math.trunc(options.limit ?? 500),
    offset: Math.trunc(options.offset ?? 0),
    include_reserved: options.includeReserved === true
  })
}

/**
 * Every binding the router has, refused and disabled ones included.
 *
 * The refused ones are why nothing is filtered here: a section the daemon will
 * not accept installs no rule and appears nowhere else at all, and a list that
 * quietly dropped it would be a binding the operator created, cannot see and
 * cannot delete.
 *
 * `source` narrows to `manual` or to one instance's derived seats.
 */
export function wanbindBindings(
  deps: AgentDeps,
  id = '',
  source = ''
): Promise<AgentCallResult<WanbindBindingsReply>> {
  return call<WanbindBindingsReply>(deps, 'bindings', { id, source })
}

/**
 * The router's own reading of its interfaces, with the evidence for each.
 *
 * Asked of the router rather than worked out here, and that is the whole point:
 * the two halves must not be able to reach different conclusions about which
 * side of the router an interface is on. This module used to decide it from the
 * device name, which is true of a stock build and of nothing else - a LAN on a
 * VLAN, a plain port or a radio was read as a WAN and every address behind it
 * was refused.
 */
export function wanbindLayout(deps: AgentDeps): Promise<AgentCallResult<WanbindLayoutReply>> {
  return call<WanbindLayoutReply>(deps, 'layout')
}

/** The interfaces a WAN port or a carrier could be, for the forms that ask. */
export function wanbindWans(deps: AgentDeps): Promise<AgentCallResult<WanbindWansReply>> {
  return call<WanbindWansReply>(deps, 'wans')
}

/**
 * Every ip rule on the router, and what the daemon makes of each one.
 *
 * The fast sweep only ever filtered the rule table down to this module's own
 * priority window, which is exactly why a rule somebody else wrote could steer
 * every packet on the router and appear on no surface at all. This asks for the
 * whole table, capped, with an owner and a sentence per row.
 */
export interface WanbindRulesOptions {
  limit?: number
  offset?: number
  /**
   * A sentence per row.
   *
   * Off by default, and that is the change this release made: at fifteen
   * hundred rules the sentences are most of the reply, and the page fetches
   * the one somebody clicked on rather than all of them.
   */
  reasons?: boolean
  /** netifd's three rules per interface as one row. On unless a caller says not. */
  collapse?: boolean
}

export function wanbindRules(
  deps: AgentDeps,
  options: WanbindRulesOptions = {}
): Promise<AgentCallResult<WanbindRulesReply>> {
  return call<WanbindRulesReply>(deps, 'rules', {
    limit: Math.trunc(options.limit ?? 0),
    offset: Math.trunc(options.offset ?? 0),
    reasons: options.reasons === true,
    collapse: options.collapse !== false
  })
}

/** One rule, and the sentence the list no longer carries for every row. */
export function wanbindRuleExplain(
  deps: AgentDeps,
  pref: number,
  cidr = '',
  dst = '',
  table = 0
): Promise<AgentCallResult<WanbindRuleExplainReply>> {
  return call<WanbindRuleExplainReply>(deps, 'rule_explain', {
    pref: Math.trunc(pref),
    cidr,
    dst,
    table: Math.trunc(table)
  })
}

/**
 * Remove many bindings in one call: one commit and one pass, not N of each.
 *
 * The daemon takes at most two hundred ids, which is what a caller has to batch
 * against - and every id gets a row in the reply whether or not it went, so a
 * caller can say which ones are still there rather than reporting the whole
 * batch by its worst member.
 */
export async function wanbindUnbindMany(
  deps: AgentDeps,
  ids: string[]
): Promise<AgentCallResult<WanbindUnbindManyReply>> {
  return unwrap(
    await call<WanbindUnbindManyReply>(deps, 'unbind_many', { ids }, MUTATE_TIMEOUT_MS)
  )
}

/** What the kernel is holding, against what the last pass decided it should. */
export function wanbindVerify(
  deps: AgentDeps,
  id = ''
): Promise<AgentCallResult<WanbindVerifyReply>> {
  return call<WanbindVerifyReply>(deps, 'verify', { instance: id })
}

// -------------------------------------------------------------------- changes

function instanceArgs(id: string, spec: WanbindInstanceSpec): Record<string, unknown> {
  const args: Record<string, unknown> = { id, lan: spec.lan, carrier: spec.carrier }
  if (spec.name != null) args.name = spec.name
  if (spec.sticky != null) args.sticky = spec.sticky
  if (spec.remap != null) args.remap = spec.remap
  if (spec.enabled != null) args.enabled = spec.enabled
  if (spec.range_from) args.range_from = spec.range_from
  if (spec.range_to) args.range_to = spec.range_to
  if (spec.clients_per_wan != null) args.clients_per_wan = Math.trunc(spec.clients_per_wan)
  if (spec.raise_dhcp_limits != null) args.raise_dhcp_limits = spec.raise_dhcp_limits
  // The stamped numbers, sent only on a handover. See the note on the type.
  for (const key of [
    'rule_pref_base',
    'catch_all_pref',
    'catch_all_table',
    'wan_warn_uptime',
    'wan_error_grace',
    'release_grace'
  ] as const) {
    const value = spec[key]
    if (value != null) args[key] = Math.trunc(value)
  }
  return args
}

/**
 * Would this spec be accepted, and what would it cost?
 *
 * Nothing is written. The findings are the router's own - it weighs its
 * interfaces, its zones, its priorities and its lease ceilings - and this module
 * shows them rather than second-guessing them, because a check that disagreed
 * with the apply would be worse than no check at all.
 */
export async function wanbindInstanceCheck(
  deps: AgentDeps,
  id: string,
  spec: WanbindInstanceSpec
): Promise<AgentCallResult<WanbindInstanceCheckReply>> {
  // Deliberately not unwrapped: `ok: false` here carries the findings that say
  // why, and folding it into a transport error would throw them away.
  return call<WanbindInstanceCheckReply>(deps, 'instance_check', instanceArgs(id, spec))
}

/** Create one, or change one. Create-and-edit in one call; absent keeps. */
export async function wanbindInstanceSet(
  deps: AgentDeps,
  id: string,
  spec: WanbindInstanceSpec
): Promise<AgentCallResult<WanbindInstanceSetReply>> {
  return unwrap(
    await call<WanbindInstanceSetReply>(
      deps,
      'instance_set',
      instanceArgs(id, spec),
      MUTATE_TIMEOUT_MS
    )
  )
}

/**
 * Remove one, rules first and the section after.
 *
 * A `reason` on a success is passed through rather than swallowed: the section
 * is gone, the operator asked for it to be gone, and the sentence is about
 * something left behind that needs a hand. An error here would invite them to
 * press Delete again and remove nothing.
 */
export async function wanbindInstanceDelete(
  deps: AgentDeps,
  id: string
): Promise<AgentCallResult<WanbindInstanceDeleteReply>> {
  return unwrap(
    await call<WanbindInstanceDeleteReply>(deps, 'instance_delete', { id }, MUTATE_TIMEOUT_MS)
  )
}

function bindArgs(spec: WanbindBindSpec): Record<string, unknown> {
  const args: Record<string, unknown> = { id: spec.id, wan: spec.wan }
  if (spec.name != null) args.name = spec.name
  if (spec.ip) args.ip = spec.ip
  if (spec.mac) args.mac = spec.mac
  if (spec.lan) args.lan = spec.lan
  if (spec.whenDown) args.when_down = spec.whenDown
  if (spec.pref != null) args.pref = Math.trunc(spec.pref)
  if (spec.table != null) args.table = Math.trunc(spec.table)
  if (spec.enabled != null) args.enabled = spec.enabled
  return args
}

/** Would this binding be accepted? Nothing is written. */
export function wanbindBindCheck(
  deps: AgentDeps,
  spec: WanbindBindSpec
): Promise<AgentCallResult<WanbindCheckReply>> {
  return call<WanbindCheckReply>(deps, 'bind_check', bindArgs(spec))
}

/**
 * Create one binding, or change one.
 *
 * `pref` and `table` are omitted on a create so the daemon allocates from its
 * own band and reads netifd's live table once. They are sent only when this
 * module is handing over a binding it wrote itself before 3.4.0, where they are
 * the numbers the rule already standing on the router was written at - and
 * sending them is what makes the daemon adopt that rule instead of writing a
 * second one somewhere else and sweeping the first a moment later.
 */
export async function wanbindBind(
  deps: AgentDeps,
  spec: WanbindBindSpec
): Promise<AgentCallResult<WanbindBindReply>> {
  return unwrap(await call<WanbindBindReply>(deps, 'bind', bindArgs(spec), MUTATE_TIMEOUT_MS))
}

export async function wanbindUnbind(
  deps: AgentDeps,
  id: string
): Promise<AgentCallResult<WanbindUnbindReply>> {
  return unwrap(await call<WanbindUnbindReply>(deps, 'unbind', { id }, MUTATE_TIMEOUT_MS))
}

/**
 * The main section's own settings.
 *
 * Only the keys that changed are sent, for the reason every other verb here
 * omits rather than empties: an edit about the pass interval is not a statement
 * about the priority bands.
 */
export async function wanbindSettingsSet(
  deps: AgentDeps,
  changes: Partial<WanbindSettings>
): Promise<AgentCallResult<{ ok: boolean; settings?: WanbindSettings; reason?: string }>> {
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(changes)) {
    if (value == null) continue
    args[key] = typeof value === 'boolean' ? value : Math.trunc(value as number)
  }
  return unwrap(
    await call<{ ok: boolean; settings?: WanbindSettings; reason?: string }>(
      deps,
      'settings_set',
      args,
      MUTATE_TIMEOUT_MS
    )
  )
}

// ------------------------------------------------------------- device actions

export async function wanbindPin(
  deps: AgentDeps,
  id: string,
  mac: string,
  wan: string
): Promise<AgentCallResult> {
  return unwrap(await call(deps, 'pin', { instance: id, mac, wan }))
}

/**
 * Move one client to a different WAN.
 *
 * A success with no `wan` is a client that was taken off the one it had and is
 * now in the queue - which is what was asked for. Reporting that as a failure
 * would invite somebody to press it again and move nothing.
 */
export async function wanbindReassign(
  deps: AgentDeps,
  id: string,
  mac: string
): Promise<AgentCallResult<{ mac: string; from: string; wan: string | null }>> {
  return unwrap(
    await call<{ mac: string; from: string; wan: string | null }>(deps, 'reassign', {
      instance: id,
      mac
    })
  )
}

export async function wanbindUnassign(
  deps: AgentDeps,
  id: string,
  mac: string
): Promise<AgentCallResult> {
  return unwrap(await call(deps, 'unassign', { instance: id, mac }))
}

export async function wanbindRelease(
  deps: AgentDeps,
  id: string,
  mac: string
): Promise<AgentCallResult> {
  return unwrap(await call(deps, 'release', { instance: id, mac }))
}

/** Run a full pass now. What Refresh presses, and what an apply waits for. */
export async function wanbindReconcile(
  deps: AgentDeps,
  id = ''
): Promise<AgentCallResult> {
  return unwrap(await call(deps, 'reconcile', { instance: id }, PASS_TIMEOUT_MS))
}

/** Take every rule off. What an uninstall runs, and nothing else should. */
export async function wanbindFlush(
  deps: AgentDeps,
  id = ''
): Promise<AgentCallResult> {
  return unwrap(await call(deps, 'flush', { instance: id }, PASS_TIMEOUT_MS))
}
