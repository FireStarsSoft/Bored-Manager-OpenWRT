/**
 * Driving `bm-wanbind`, when this router has it.
 *
 * The split here is deliberate and is the same one the package was built
 * around: **configuration is written, state is asked for.**
 *
 * - An instance is a `config instance` section in `/etc/config/bm_wanbind`, and
 *   the module writes it the way it writes every other piece of UCI - through
 *   `uci batch`, over the connection it already has. There is no ubus call to
 *   create one, on purpose: procd watches that file, so writing it is also how
 *   the daemon is told, and a second path that set the same fields through ubus
 *   would be a second thing to keep in step with it.
 * - Everything else - who is bound, who is waiting, move this one, run a pass
 *   now - is a ubus call, because only the running process knows.
 *
 * Nothing in this file is required. A router without the package answers every
 * call with one sentence saying so, and the caller falls back to the SSH path
 * that has been there since 2.0.0.
 */
import { uciQuote } from '../parse'
import type { ManagedLayout } from '../records'
import type { BindingInstanceRecord } from '../store'
import { objectCall, unwrap, WANBIND_OBJECT, type AgentCallResult, type AgentDeps } from './client'

/** A pass over four thousand clients is seconds, not milliseconds. */
const PASS_TIMEOUT_MS = 60_000

/** One instance, as the router reports it. */
export interface WanbindInstance {
  id: string
  lan: string
  carrier: string
  ready: boolean
  lanCidr: string | null
  sticky: boolean
  remap: boolean
  bound: number
  waiting: number
  held: number
  free: number
  devices: number
  lastPassAt: number
  lastPassMs: number
  reason: string
}

export interface WanbindInfo {
  name: string
  release: string
  apiVersion: number
  enabled: boolean
  interval: number
  uptime: number
  instances: WanbindInstance[]
}

export interface WanbindAssignment {
  instance: string
  mac: string
  ip: string
  host: string
  wan: string
  pref: number
  table: number
  assignedAt: number
}

export interface WanbindWaiting {
  instance: string
  mac: string
  ip: string
  host: string
  order: number
  since: number
  held: boolean
  /**
   * Why, as a code rather than as the sentence beside it.
   *
   * `exhausted` is the one that is not about the queue: the instance has run
   * out of ip rule priorities, so no WAN coming free will help and the range
   * has to be widened. Branching on the sentence would break the first time
   * either side reworded it.
   */
  why: 'queued' | 'held' | 'exhausted'
  reason: string
}

export interface WanbindStats {
  rssKb: number
  uptime: number
  eventsHandled: number
  assigned: number
  released: number
  queueDepth: number
  lastPassMs: number
}

function call<T>(
  deps: AgentDeps,
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<AgentCallResult<T>> {
  return objectCall<T>(deps, WANBIND_OBJECT, method, args, timeoutMs)
}

/**
 * The version handshake, and every instance's totals in one call.
 *
 * `apiVersion` is checked by the caller rather than here: a package from the
 * future has to leave the router working, so an unknown version is a fall back
 * to SSH with a sentence, never a refusal.
 */
export function wanbindInfo(deps: AgentDeps): Promise<AgentCallResult<WanbindInfo>> {
  return call<WanbindInfo>(deps, 'info')
}

export function wanbindStats(deps: AgentDeps): Promise<AgentCallResult<WanbindStats>> {
  return call<WanbindStats>(deps, 'stats')
}

/** Who is on which WAN. `id` empty means every instance. */
export async function wanbindAssignments(
  deps: AgentDeps,
  id = ''
): Promise<AgentCallResult<{ assignments: WanbindAssignment[] }>> {
  return call<{ assignments: WanbindAssignment[] }>(deps, 'assignments', { instance: id })
}

/** And who is not, with their place in the queue. */
export async function wanbindWaiting(
  deps: AgentDeps,
  id = ''
): Promise<AgentCallResult<{ waiting: WanbindWaiting[] }>> {
  return call<{ waiting: WanbindWaiting[] }>(deps, 'waiting', { instance: id })
}

/**
 * The three per-device actions, which are the same three the SSH path offers.
 *
 * `unwrap` folds the router's own `{ ok: false, reason }` into the transport
 * result, so a caller sees one shape rather than two levels of "did it work".
 */
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
export async function wanbindReconcile(deps: AgentDeps, id = ''): Promise<AgentCallResult> {
  return unwrap(await call(deps, 'reconcile', { instance: id }, PASS_TIMEOUT_MS))
}

/** Take every rule off. Used when an instance is deleted, before its section is. */
export async function wanbindFlush(deps: AgentDeps, id: string): Promise<AgentCallResult> {
  return unwrap(await call(deps, 'flush', { instance: id }, PASS_TIMEOUT_MS))
}

/**
 * `lan` and `carrier` reach a UCI value, so they are checked before they do.
 *
 * They come from this module's own records rather than from a form - the create
 * gate validated them as interface names long before an instance existed - so
 * this should never fire. It is here because the line above puts them between
 * quotes, and an allowlist two files away is not a guarantee.
 */
export function safeUciWord(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,32}$/.test(value)
}

/**
 * A UCI section name for one instance.
 *
 * The module's own instance ids are opaque strings it generated; UCI section
 * names may hold only letters, digits and underscores. `bm` plus the id with
 * everything else replaced is stable, collision-free for the ids this module
 * makes, and recognisable in `uci show bm_wanbind`.
 */
export function wanbindSection(id: string): string {
  return `bm${id.replace(/[^A-Za-z0-9_]/g, '')}`
}

/**
 * The lines that put one instance in `/etc/config/bm_wanbind`.
 *
 * Every number comes from the instance's own recorded layout, never from the
 * rules in force now. That is the same rule the SSH reconciler follows and for
 * the same reason: the priorities and the catch-all table are what the rules
 * already on the router were written against, so an instance created under one
 * layout and reconciled under another would have the daemon fail to recognise
 * its own work and write a second copy of every rule.
 */
export function wanbindInstanceLines(
  instance: BindingInstanceRecord,
  layout: ManagedLayout,
  rules: { wanWarnUptimeSec: number; wanErrorGraceSec: number; releaseGraceSec: number }
): string[] {
  // The last gate before either becomes a line in a config file. Both were
  // validated as interface names by the create gate long before an instance
  // existed, so this should never fire - which is exactly why it is checked on
  // the line that needs it rather than trusted from two files away.
  if (!safeUciWord(instance.lan) || !safeUciWord(instance.carrier)) {
    throw new Error(
      `instance ${instance.name} names an interface this module will not write to a config file`
    )
  }

  const section = wanbindSection(instance.id)
  const flag = (on: boolean): string => (on ? "'1'" : "'0'")
  const number = (value: number): string => `'${Math.trunc(value)}'`

  return [
    `set bm_wanbind.${section}=instance`,
    `set bm_wanbind.${section}.enabled=${flag(instance.running)}`,
    `set bm_wanbind.${section}.lan=${uciQuote(instance.lan)}`,
    `set bm_wanbind.${section}.carrier=${uciQuote(instance.carrier)}`,
    `set bm_wanbind.${section}.sticky=${flag(instance.sticky)}`,
    `set bm_wanbind.${section}.remap=${flag(instance.remap)}`,
    // The instance's own slot, so two instances on one router never share a
    // catch-all priority - exactly as the SSH path allocates them.
    `set bm_wanbind.${section}.rule_pref_base=${number(layout.rulePrefBase)}`,
    `set bm_wanbind.${section}.catch_all_pref=${number(layout.catchAllPrefBase + instance.slot)}`,
    `set bm_wanbind.${section}.catch_all_table=${number(layout.catchAllTable)}`,
    `set bm_wanbind.${section}.wan_warn_uptime=${number(rules.wanWarnUptimeSec)}`,
    `set bm_wanbind.${section}.wan_error_grace=${number(rules.wanErrorGraceSec)}`,
    `set bm_wanbind.${section}.release_grace=${number(rules.releaseGraceSec)}`
  ]
}

/** And the line that takes it out again. */
export function wanbindRemoveLines(id: string): string[] {
  return [`delete bm_wanbind.${wanbindSection(id)}`]
}

