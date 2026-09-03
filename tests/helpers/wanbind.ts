/**
 * The router's own `bm.wanbind`, faked well enough to be argued with.
 *
 * From packages 2.4.0 the daemon owns WAN Binding outright - the sections, the
 * routing tables, the firewall paths, the fail-closed catch-all and every ip
 * rule - and this module asks, shows and sends changes back. So every test
 * about binding is now a test about what this module does with an *answer*, and
 * the answer is one `ubus -S call bm.wanbind <verb> '<json>'` per verb over the
 * connection the module already has.
 *
 * That makes hand-rolled JSON per test file the wrong shape twice over. The
 * replies are big enough that a fixture written by hand is mostly the fields
 * the test is not about, and a field spelled the way the test author remembered
 * it is a test passing against a router that does not exist. Everything below
 * is typed against `openwrt/main/agent/wanbind-types.ts`, which is the contract
 * itself, so a reply that drifts from the daemon stops compiling here rather
 * than passing quietly.
 *
 * The state is mutable on purpose: a `bind` lands in `state.bindings`, an
 * `instance_delete` takes a section out of `state.info.configured`, and the
 * next `info` sees it - which is what lets a test press a button and then read
 * the table, the way a person does. `calls` records everything asked, in order,
 * so "it never wrote an ip rule" and "it asked for exactly this" are both one
 * assertion.
 */
import type { ModuleContext, ModuleExecResult } from '@shared/modules'
import type {
  WanbindAssignment,
  WanbindBindingsReply,
  WanbindInfo,
  WanbindInstanceConfig,
  WanbindSettings,
  WanbindWaiting,
  WanbindWan
} from '../../openwrt/main/agent'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import type { JobSpec, OpenWrtJob } from '../../openwrt/main/jobs'
import type { AgentCapability } from '../../openwrt/main/probe'
import { HostStore } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'
import { BindingManager } from '../../openwrt/main/wanbind'
// Two files rather than the barrel, and deliberately: the handover is not
// published from `wanbind/index.ts` because nothing outside the folder is meant
// to run it, and neither is the runtime object it takes. The size gate walks
// `openwrt/main` only, so a test reaching past a barrel breaks no rule - but it
// is worth saying out loud that this is the one thing here that does.
import { handoverPending, type HandoverOutcome } from '../../openwrt/main/wanbind/handover'
import { createBindingRuntime } from '../../openwrt/main/wanbind/runtime'
import type { BindingRuntime } from '../../openwrt/main/wanbind/types'
import { moduleHarness, type ModuleHarness, type ModuleHarnessOptions } from './module-harness'

/**
 * The three shapes the agent barrel does not publish under their own names.
 *
 * Indexing the reply is the same type by definition, so these cannot drift from
 * the contract the way a hand-copied interface would - which is exactly what
 * `wanbind/rows.ts` does for the same two, and for the same reason: the older
 * `agent/wanbind.ts` still owns the spellings `WanbindBinding` and
 * `WanbindBand` until `direct/` goes.
 */
export type RouterBinding = WanbindBindingsReply['bindings'][number]
export type RouterBand = WanbindBindingsReply['band']
export type RouterInstanceState = WanbindInfo['instances'][number]

/** What the daemon runs on when nothing is in `config wanbind 'main'`. */
export const DAEMON_SETTINGS: WanbindSettings = {
  enabled: true,
  interval: 30,
  direct_pref_base: 19_000,
  rule_pref_base: 20_000,
  catch_all_pref_base: 30_000,
  catch_all_table: 253,
  wan_table_base: 10_000,
  wan_warn_uptime: 5,
  wan_error_grace: 20,
  release_grace: 120,
  lan_local: true,
  local_pref_base: 18_000
}

/** A band with room in it, which is the case nothing below is about. */
export const USABLE_BAND: RouterBand = {
  base: 19_000,
  span: 1_000,
  top: 19_999,
  reason: null,
  usable: true
}

// ------------------------------------------------------------------ builders

/** One `config instance` as the daemon's configuration reader accepted it. */
export function instanceConfig(over: Partial<WanbindInstanceConfig> = {}): WanbindInstanceConfig {
  return {
    id: 'bmi_aaa001',
    name: 'Front of house',
    enabled: true,
    usable: true,
    reason: null,
    lan: 'lan',
    carrier: 'eth1',
    sticky: true,
    remap: true,
    rangeFrom: '',
    rangeTo: '',
    clientsPerWan: 1,
    slot: 0,
    rulePrefBase: 20_000,
    catchAllPref: 29_900,
    catchAllTable: 29_999,
    wanWarnUptime: 0,
    wanErrorGrace: 30,
    releaseGrace: 300,
    ...over
  }
}

/** And what the running daemon has made of it. */
export function instanceState(over: Partial<RouterInstanceState> = {}): RouterInstanceState {
  return {
    id: 'bmi_aaa001',
    ready: true,
    lanCidr: '192.168.1.0/24',
    bound: 0,
    carrying: 0,
    seats: -1,
    clientsPerWan: 1,
    range: null,
    cidrs: ['192.168.1.0/24'],
    waiting: 0,
    held: 0,
    free: 0,
    devices: 0,
    lastPassAt: 0,
    lastPassMs: 4,
    reason: '',
    ...over
  }
}

/** One seat an instance handed out. `assignedAt` is router seconds. */
export function assignment(over: Partial<WanbindAssignment> = {}): WanbindAssignment {
  return {
    instance: 'bmi_aaa001',
    mac: 'aa:bb:cc:dd:ee:01',
    ip: '192.168.1.20',
    host: 'desk',
    wan: 'pd00001',
    pref: 20_000,
    table: 10_001,
    assignedAt: 1_700_000_000,
    verified: true,
    ...over
  }
}

/** One client the instance is not seating, and why - as a code, not prose. */
export function waiting(over: Partial<WanbindWaiting> = {}): WanbindWaiting {
  return {
    instance: 'bmi_aaa001',
    mac: 'aa:bb:cc:dd:ee:02',
    ip: '192.168.1.21',
    host: 'phone',
    order: 1,
    since: 1_700_000_000,
    held: false,
    why: 'queued',
    reason: 'no WAN is free',
    ...over
  }
}

/** One binding the router holds - a hand-written section, or an instance seat. */
export function binding(over: Partial<RouterBinding> = {}): RouterBinding {
  return {
    id: 'bmdir_a1',
    name: 'Workshop',
    enabled: true,
    usable: true,
    source: 'manual',
    instance: '',
    targetKind: 'ip',
    label: '10.0.0.11',
    mac: '',
    host: '',
    wan: 'wan1',
    lan: 'lan',
    lanCidr: '10.0.0.0/24',
    lanZone: 'lan',
    wanZone: 'wan',
    whenDown: 'hold',
    pref: 19_000,
    table: 101,
    stampedTable: 101,
    wanTable: 101,
    state: 'bound',
    parkedBy: '',
    ip: '10.0.0.11',
    since: 1_700_000_000,
    reason: '',
    shadowedBy: '',
    forwarding: 'ok',
    needsForwarding: false,
    needsTable: false,
    evidence: '',
    verified: true,
    ...over
  }
}

/** One interface a WAN port or a carrier could be, as `wans` reports it. */
export function wan(over: Partial<WanbindWan> = {}): WanbindWan {
  return {
    name: 'wan1',
    proto: 'dhcp',
    device: 'eth1',
    l3Device: 'eth1',
    up: true,
    pending: false,
    uptime: 3_600,
    errorCode: '',
    ipv4: { addr: '203.0.113.5', mask: 24 },
    table: 101,
    zone: 'wan',
    role: 'uplink',
    evidence: ['it is in the masquerading firewall zone "wan"'],
    instance: '',
    holders: [],
    state: 'available',
    ...over
  }
}

// -------------------------------------------------------------------- the fake

/** Everything the daemon would answer from, as one object a test may edit. */
export interface WanbindState {
  settings: WanbindSettings
  /** The instance half's switch. Bindings are reconciled either way. */
  enabled: boolean
  bindingsMaintained: boolean
  configured: WanbindInstanceConfig[]
  instances: RouterInstanceState[]
  assignments: WanbindAssignment[]
  waiting: WanbindWaiting[]
  bindings: RouterBinding[]
  band: RouterBand
  wans: WanbindWan[]
  core: WanbindInfo['core']
}

/** One call the module made, as the daemon would have received it. */
export interface WanbindCall {
  verb: string
  args: Record<string, unknown>
}

/**
 * A reply for one verb, replacing the default.
 *
 * Returning a `ModuleExecResult` is how a test says "the router refused this at
 * the transport" - a non-zero exit, or output that is not JSON. Returning
 * anything else is the reply body, which is where a `{ ok: false, reason }`
 * refusal goes: the two are different failures and this module treats them
 * differently, so the fake has to be able to produce either.
 */
export type WanbindAnswer = (
  args: Record<string, unknown>,
  state: WanbindState
) => unknown | ModuleExecResult

export interface WanbindDaemon {
  state: WanbindState
  /** Every call, in order. */
  calls: WanbindCall[]
  /**
   * Answer one command, or null when it is not addressed to `bm.wanbind`.
   *
   * Meant to be the first thing a harness's `exec` consults, so that a test's
   * own fixtures answer the sweep and the probe and this answers the daemon.
   */
  answer(command: string): ModuleExecResult | null
  /** Replace one verb's reply, for the tests that are about a refusal. */
  on(verb: string, answer: WanbindAnswer): void
  /** The JSON argument of every call to one verb, oldest first. */
  payloads(verb: string): Array<Record<string, unknown>>
  /** How many times one verb was called. */
  count(verb: string): number
}

const OK = (stdout = ''): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

function isExecResult(value: unknown): value is ModuleExecResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ModuleExecResult).code === 'number' &&
    typeof (value as ModuleExecResult).stdout === 'string'
  )
}

const PREFIX = 'ubus -S call bm.wanbind '

/**
 * The verb and its one JSON document, out of the command line the client built.
 *
 * `shQuote` wraps the payload in single quotes and escapes an inner one as
 * `'\''`, so this undoes exactly that rather than assuming a payload has no
 * apostrophe in it - an instance called `Bob's shop` is a name somebody will
 * type, and a fixture that silently failed to parse it would report the call as
 * never having been made.
 */
function parseCall(command: string): WanbindCall | null {
  const at = command.indexOf(PREFIX)
  if (at < 0) return null
  const rest = command.slice(at + PREFIX.length)
  const space = rest.indexOf(' ')
  const verb = space < 0 ? rest.trim() : rest.slice(0, space).trim()
  if (!verb) return null

  const quoted = space < 0 ? '' : rest.slice(space + 1).trim()
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) return { verb, args: {} }
  const json = quoted.slice(1, -1).split(`'\\''`).join("'")
  try {
    const parsed: unknown = JSON.parse(json)
    return {
      verb,
      args:
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {}
    }
  } catch {
    return { verb, args: {} }
  }
}

function emptyCore(): WanbindInfo['core'] {
  return {
    ready: true,
    reason: '',
    bindings: 0,
    bound: 0,
    held: 0,
    fallback: 0,
    stranded: 0,
    shadowed: 0,
    waiting: 0,
    disabled: 0,
    refused: 0
  }
}

function counters(): WanbindInfo['netlink'] {
  return { written: 0, verified: 0, unverified: 0, removed: 0, lastUnverified: [] }
}

/**
 * A daemon whose answers come from `seed`, with everything else at its default.
 *
 * The one field with a rule of its own is `instances`: a section the daemon
 * refused has a `configured` entry and no running state at all, so a seed that
 * gives only `configured` gets a ready state per usable section rather than an
 * empty list - which is the router a test almost always means, and getting it
 * wrong makes every instance read `stopped` for a reason the test is not about.
 */
export function fakeWanbind(seed: Partial<WanbindState> = {}): WanbindDaemon {
  const configured = seed.configured ?? []
  const state: WanbindState = {
    settings: seed.settings ?? { ...DAEMON_SETTINGS },
    enabled: seed.enabled ?? true,
    bindingsMaintained: seed.bindingsMaintained ?? true,
    configured,
    instances:
      seed.instances ??
      configured
        .filter((entry) => entry.usable && entry.enabled)
        .map((entry) => instanceState({ id: entry.id, clientsPerWan: entry.clientsPerWan })),
    assignments: seed.assignments ?? [],
    waiting: seed.waiting ?? [],
    bindings: seed.bindings ?? [],
    band: seed.band ?? { ...USABLE_BAND },
    wans: seed.wans ?? [],
    core: seed.core ?? emptyCore()
  }

  const calls: WanbindCall[] = []
  const overrides = new Map<string, WanbindAnswer>()

  const info = (): WanbindInfo => ({
    name: 'bm-wanbind',
    release: '2.4.0',
    apiVersion: 2,
    enabled: state.enabled,
    bindingsMaintained: state.bindingsMaintained,
    interval: state.settings.interval,
    uptime: 600,
    settings: state.settings,
    instances: state.instances,
    configured: state.configured,
    core: state.core,
    netlink: counters()
  })

  const bindingsReply = (args: Record<string, unknown>): WanbindBindingsReply => {
    const id = String(args.id ?? '')
    const source = String(args.source ?? '')
    const rows = state.bindings.filter(
      (entry) => (!id || entry.id === id) && (!source || entry.source === source)
    )
    return {
      bindings: rows,
      filtered: Boolean(id || source),
      counts: {
        manual: rows.filter((entry) => entry.source === 'manual').length,
        derived: rows.filter((entry) => entry.source !== 'manual').length,
        byState: {}
      },
      band: state.band,
      instances: state.configured.map((entry) => ({
        id: entry.id,
        base: entry.rulePrefBase,
        top: entry.catchAllPref - 1,
        catchAllPref: entry.catchAllPref,
        catchAllTable: entry.catchAllTable,
        scope: [entry.rangeFrom && entry.rangeTo ? `${entry.rangeFrom}-${entry.rangeTo}` : 'lan']
      })),
      maintained: state.bindingsMaintained
    }
  }

  /** `bind` is create-and-edit in one, so this writes through the same door. */
  const bind = (args: Record<string, unknown>): unknown => {
    const id = String(args.id ?? '')
    const at = state.bindings.findIndex((entry) => entry.id === id)
    const previous = at >= 0 ? state.bindings[at]! : null
    const row = binding({
      ...(previous ?? {}),
      id,
      name: args.name != null ? String(args.name) : (previous?.name ?? id),
      wan: args.wan != null ? String(args.wan) : (previous?.wan ?? ''),
      ...(args.lan != null ? { lan: String(args.lan) } : {}),
      ...(args.mac != null ? { targetKind: 'mac' as const, mac: String(args.mac), label: String(args.mac) } : {}),
      ...(args.ip != null ? { targetKind: 'ip' as const, ip: String(args.ip), label: String(args.ip) } : {}),
      ...(args.when_down != null
        ? { whenDown: args.when_down === 'fallback' ? ('fallback' as const) : ('hold' as const) }
        : {}),
      // Absent means the daemon allocates from its own band; present is a
      // handover naming the numbers the rule already standing was written at.
      pref: args.pref != null ? Number(args.pref) : (previous?.pref ?? state.band.base),
      table: args.table != null ? Number(args.table) : (previous?.table ?? 0),
      stampedTable: args.table != null ? Number(args.table) : (previous?.stampedTable ?? 0),
      enabled: args.enabled != null ? args.enabled === true : (previous?.enabled ?? true),
      state: args.enabled === false ? ('disabled' as const) : (previous?.state ?? ('bound' as const))
    })
    if (at >= 0) state.bindings[at] = row
    else state.bindings.push(row)
    return { ok: true, binding: row }
  }

  const instanceSet = (args: Record<string, unknown>): unknown => {
    const id = String(args.id ?? '')
    const at = state.configured.findIndex((entry) => entry.id === id)
    const previous = at >= 0 ? state.configured[at]! : null
    const row = instanceConfig({
      ...(previous ?? {}),
      id,
      name: args.name != null ? String(args.name) : (previous?.name ?? id),
      lan: args.lan != null ? String(args.lan) : (previous?.lan ?? ''),
      carrier: args.carrier != null ? String(args.carrier) : (previous?.carrier ?? ''),
      ...(args.sticky != null ? { sticky: args.sticky === true } : {}),
      ...(args.remap != null ? { remap: args.remap === true } : {}),
      ...(args.enabled != null ? { enabled: args.enabled === true } : {}),
      ...(args.range_from != null ? { rangeFrom: String(args.range_from) } : {}),
      ...(args.range_to != null ? { rangeTo: String(args.range_to) } : {}),
      ...(args.clients_per_wan != null ? { clientsPerWan: Number(args.clients_per_wan) } : {}),
      ...(args.rule_pref_base != null ? { rulePrefBase: Number(args.rule_pref_base) } : {}),
      ...(args.catch_all_pref != null ? { catchAllPref: Number(args.catch_all_pref) } : {}),
      ...(args.catch_all_table != null ? { catchAllTable: Number(args.catch_all_table) } : {})
    })
    if (at >= 0) state.configured[at] = row
    else state.configured.push(row)
    if (!state.instances.some((entry) => entry.id === id)) {
      state.instances.push(instanceState({ id, clientsPerWan: row.clientsPerWan }))
    }
    return {
      ok: true,
      findings: [],
      instance: row,
      flushed: 0,
      prepared: { tables: [], forwardings: 0, catchAll: [], dhcp: null },
      read: true,
      verified: 0,
      unverified: 0
    }
  }

  const defaults: Record<string, WanbindAnswer> = {
    info: () => info(),
    stats: () => ({
      rssKb: 900,
      uptime: 600,
      eventsHandled: 0,
      assigned: 0,
      released: 0,
      queueDepth: 0,
      lastPassMs: 4,
      netlink: counters()
    }),
    settings_get: () => state.settings,
    settings_set: (args) => {
      for (const [key, value] of Object.entries(args)) {
        if (key in state.settings) {
          ;(state.settings as unknown as Record<string, unknown>)[key] = value
        }
      }
      return { ok: true, settings: state.settings }
    },
    assignments: (args) => {
      const id = String(args.instance ?? '')
      return {
        assignments: id
          ? state.assignments.filter((entry) => entry.instance === id)
          : state.assignments
      }
    },
    waiting: (args) => {
      const id = String(args.instance ?? '')
      return { waiting: id ? state.waiting.filter((entry) => entry.instance === id) : state.waiting }
    },
    bindings: (args) => bindingsReply(args),
    bind,
    // The batch form, which is what a handover uses. Each spec goes through the
    // same `bind` the single form does, so a test that makes the daemon refuse
    // one id sees it refused here too - and every spec gets a row whether or
    // not it was written, which is the property the caller keeps records on.
    bind_many: (args) => {
      const specs = Array.isArray(args.bindings) ? args.bindings : []
      const results = specs.map((one) => {
        const spec = (one ?? {}) as Record<string, unknown>
        const id = String(spec.id ?? '')
        // Through the override, not past it. A test that says "this router
        // refuses dir_a1" with `on('bind', ...)` means the router, and a batch
        // form that consulted only the default would let the handover succeed
        // against a daemon the test had made hostile.
        const answer = overrides.get('bind') ?? bind
        const reply = answer(spec, state)
        // An override may answer either shape - a plain reply, or the exec
        // result a test uses to say "the router answered this on stdout" - so
        // both are read here the way the transport reads them.
        const answered = (isExecResult(reply)
          ? (JSON.parse(reply.stdout || '{}') as Record<string, unknown>)
          : ((reply ?? {}) as Record<string, unknown>)) as {
          ok?: boolean
          binding?: { pref?: number; table?: number }
          reason?: string
        }

        if (answered.ok !== true) {
          return { id, ok: false, pref: 0, table: 0, reason: answered.reason ?? 'refused' }
        }

        // A real daemon that wrote a section lists it afterwards, whatever its
        // own reader then makes of it - and the caller reads that list back to
        // tell "written" from "kept". An override answering with a row has
        // therefore written one, so the state has to hold it or the read-back
        // sees a router that took the section and lost it.
        if (answered.binding && overrides.has('bind')) {
          const row = answered.binding as unknown as RouterBinding
          const seen = state.bindings.findIndex((entry) => entry.id === row.id)
          if (seen >= 0) state.bindings[seen] = row
          else state.bindings.push(row)
        }

        return {
          id,
          ok: true,
          pref: answered.binding?.pref ?? 0,
          table: answered.binding?.table ?? 0,
          reason: ''
        }
      })
      const written = results.filter((one) => one.ok).length
      return {
        ok: true,
        written,
        refused: results.length - written,
        pending: true,
        due: 2,
        results
      }
    },
    bind_check: () => ({ ok: true, findings: [] }),
    unbind: (args) => {
      const id = String(args.id ?? '')
      const at = state.bindings.findIndex((entry) => entry.id === id)
      if (at >= 0) state.bindings.splice(at, 1)
      return { ok: true, id, removed: at >= 0 ? 1 : 0, swept: 0, reason: null }
    },
    // The batch form. Every id gets a row whether or not it went, which is what
    // lets a caller name the ones the router kept rather than reporting the
    // whole batch by its worst member.
    unbind_many: (args) => {
      const ids = Array.isArray(args.ids) ? args.ids.map((one) => String(one)) : []
      const results = ids.map((id) => {
        const at = state.bindings.findIndex((entry) => entry.id === id)
        if (at < 0) return { id, ok: false, reason: `no binding called ${id}` }
        state.bindings.splice(at, 1)
        return { id, ok: true, reason: '' }
      })
      return {
        ok: true,
        removed: results.filter((one) => one.ok).length,
        pending: true,
        due: 2,
        results
      }
    },
    instance_check: () => ({
      ok: true,
      findings: [],
      allocated: {
        rule_pref_base: 20_000,
        catch_all_pref: 29_900,
        catch_all_table: 29_999,
        slot: 0
      },
      scope: null,
      pool: [],
      moves: []
    }),
    instance_set: instanceSet,
    instance_delete: (args) => {
      const id = String(args.id ?? '')
      state.configured = state.configured.filter((entry) => entry.id !== id)
      state.instances = state.instances.filter((entry) => entry.id !== id)
      return { ok: true, id, removed: 0, forwardings: 0, reason: null }
    },
    wans: () => ({ ok: true, wans: state.wans, carriers: [] }),
    layout: () => ({ ok: true, interfaces: [], stated: true }),
    rules: () => ({
      ok: true,
      read: true,
      count: 0,
      capped: false,
      limit: 0,
      rules: [],
      bands: { direct: { base: state.band.base, top: state.band.top }, instances: [] },
      main: null,
      tables: []
    }),
    verify: () => ({ ok: true, read: true, checked: 0, present: 0, missing: [], extra: [] }),
    pin: () => ({ ok: true }),
    reassign: (args) => ({ mac: String(args.mac ?? ''), from: '', wan: 'pd00002' }),
    unassign: () => ({ ok: true }),
    release: () => ({ ok: true }),
    reconcile: () => ({ ok: true }),
    flush: () => ({ ok: true })
  }

  return {
    state,
    calls,
    on: (verb, answerFor) => {
      overrides.set(verb, answerFor)
    },
    payloads: (verb) => calls.filter((call) => call.verb === verb).map((call) => call.args),
    count: (verb) => calls.filter((call) => call.verb === verb).length,
    answer: (command) => {
      const call = parseCall(command)
      if (!call) return null
      calls.push(call)
      const handler = overrides.get(call.verb) ?? defaults[call.verb]
      // A ubus method the daemon does not have exits non-zero with its own
      // sentence on stderr, which is the shape the client turns into "The agent
      // refused <verb>: ...". Answering `{}` instead would let a test pass
      // against a call that could never have worked on a router.
      if (!handler) return { code: 1, stdout: '', stderr: `Command failed: Not found` }
      const reply = handler(call.args, state)
      if (isExecResult(reply)) return reply
      // A ubus method with nothing to say answers with no body at all.
      return OK(reply === undefined ? '' : JSON.stringify(reply))
    }
  }
}

// --------------------------------------------------- the client, over the fake

/**
 * The capability verdict for a router carrying packages 2.4.0.
 *
 * The module reads this per call rather than capturing it, so a test that wants
 * "the package was removed under us" edits the object it passed in rather than
 * rebuilding anything.
 */
export function bindingCapability(over: Partial<AgentCapability> = {}): AgentCapability {
  return {
    installed: true,
    running: true,
    release: '2.4.0',
    apiVersion: 3,
    schema: 2,
    dataSchema: 2,
    provides: ['binding', 'direct'],
    features: [
      { name: 'bm-wanbind', version: '2.4.0', apiVersion: 2, provides: ['binding', 'direct'] }
    ],
    guard: null,
    usable: true,
    problem: null,
    canGuard: false,
    canUpdate: false,
    ...over
  }
}

/** The router as the fast sweep saw it, which is where a WAN's own state comes from. */
export function routerModel(over: Partial<RouterModel> = {}): RouterModel {
  return {
    t: 1_700_000_000_000,
    sys: { uptimeSec: 4_000, load1: 0, memTotal: 512_000, memFree: 200_000 },
    ifaces: [],
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases: [],
    rules: [],
    rates: {},
    ...over
  }
}

export interface WanbindDeps {
  harness: ModuleHarness
  daemon: WanbindDaemon
  store: HostStore
  /** Every job started, in order, with what its work actually did. */
  jobs: Array<{ kind: string; label: string; ok: boolean; error: string }>
  /** Every line the module wrote to its own event trail this run. */
  events: Array<{ kind: string; text: string }>
  config: { effectiveRules: () => { execTimeoutSec: number } }
  jobRunner: { start: (spec: JobSpec) => OpenWrtJob }
  service: { forceDump: () => void; latestModel: () => RouterModel | null; event: () => void }
  capability: () => AgentCapability
}

export interface WanbindOptions {
  daemon?: WanbindDaemon
  capability?: AgentCapability
  model?: RouterModel | null
  hostData?: unknown
  harness?: ModuleHarnessOptions
  /** Answered before the daemon's, for the commands a test owns itself. */
  answer?: (command: string) => ModuleExecResult | null
}

/**
 * Everything this folder is constructed from, faked.
 *
 * Jobs run inline. Every mutation goes through `runMutationJob`, which answers
 * with a job id the instant the job starts - so a test that only read the
 * return value would be asserting that a job was created and never that the
 * router was asked for anything. `jobs` is what the work actually did.
 */
export function wanbindDeps(options: WanbindOptions = {}): WanbindDeps {
  const daemon = options.daemon ?? fakeWanbind()
  const harness = moduleHarness('openwrt', () => OK(), {
    ...(options.hostData !== undefined ? { hostData: options.hostData } : {}),
    ...options.harness
  })
  harness.exec.mockImplementation(async (command) => {
    return options.answer?.(command) ?? daemon.answer(command) ?? OK()
  })

  const jobs: WanbindDeps['jobs'] = []
  const events: Array<{ kind: string; text: string }> = []
  const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
  const capability = options.capability ?? bindingCapability()

  return {
    harness,
    daemon,
    store,
    jobs,
    events,
    config: { effectiveRules: () => ({ execTimeoutSec: 60 }) },
    jobRunner: {
      start: (spec) => {
        const entry = { kind: spec.kind, label: spec.label, ok: true, error: '' }
        jobs.push(entry)
        void (async () => {
          try {
            for (const item of spec.items) await item.run(() => false)
          } catch (error) {
            entry.ok = false
            entry.error = error instanceof Error ? error.message : String(error)
          }
          spec.onFinished?.({} as never)
        })()
        return { id: `job${jobs.length}` } as unknown as OpenWrtJob
      }
    },
    service: {
      forceDump: () => {},
      latestModel: () => options.model ?? null,
      event: (kind?: string, text?: string) => {
        events.push({ kind: String(kind ?? ''), text: String(text ?? '') })
      }
    },
    capability: () => capability
  }
}

export interface WanbindHandover {
  harness: ModuleHarness
  daemon: WanbindDaemon
  store: HostStore
  /** Offer the router everything the document still holds, once. */
  run(): Promise<HandoverOutcome>
  dispose(): void
}

/**
 * The handover half, over the same fake.
 *
 * It is reached through the free function rather than through `BindingManager`
 * because that is the only way in: `handoverPending` is not on the manager and
 * `wanbind/index.ts` does not publish it. Anything a caller does with the
 * outcome - the sentence a page carries - is `handoverNotice`, which the barrel
 * does publish.
 */
export function wanbindHandover(options: WanbindOptions = {}): WanbindHandover {
  const deps = wanbindDeps(options)
  const runtime: BindingRuntime = createBindingRuntime(
    deps.harness.ctx,
    deps.config,
    deps.jobRunner,
    deps.service,
    deps.store,
    deps.capability
  )
  return {
    harness: deps.harness,
    daemon: deps.daemon,
    store: deps.store,
    run: () => handoverPending(runtime),
    dispose: () => deps.store.dispose()
  }
}

export interface WanbindClient {
  harness: ModuleHarness
  daemon: WanbindDaemon
  /**
   * The per-router document, so a test can read what is left in it.
   *
   * What the handover does is as much about what it *forgets* as about what it
   * offers: a record the router took and this module kept would be offered
   * again on every tick for the life of the machine.
   */
  store: HostStore
  manager: BindingManager
  /** Every line written to the module-wide event trail this run. */
  events: Array<{ kind: string; text: string }>
  /** Every job the manager started, in order, with what it did when it ran. */
  jobs: Array<{ kind: string; label: string; ok: boolean; error: string }>
  /** Fetch from the daemon and rebuild both snapshots, the way a tick does. */
  tick(): Promise<void>
  dispose(): void
}

/**
 * A `BindingManager` over a faked daemon, and nothing else.
 *
 * The manager is the whole surface this half has - every page reads it and
 * every button calls it - so a test that drives it is testing the wiring as
 * well as the builder underneath, which is the difference between this and
 * calling a row builder directly. What it deliberately does not bring is the
 * rest of the module: no probe, no fast sweep and no requirements gate, so a
 * failure here is about binding rather than about a router fixture.
 *
 * Jobs run inline. Every mutation goes through `runMutationJob`, which answers
 * with a job id the instant the job starts - so a test that only read the
 * return value would be asserting that a job was created and never that the
 * router was asked for anything. `jobs` is what the work actually did.
 */
export function wanbindClient(options: WanbindOptions = {}): WanbindClient {
  const deps = wanbindDeps(options)
  const { harness, daemon, store, jobs } = deps
  const manager = new BindingManager(
    harness.ctx as ModuleContext,
    deps.config,
    deps.jobRunner,
    deps.service,
    store,
    deps.capability
  )

  return {
    harness,
    daemon,
    store,
    manager,
    jobs,
    events: deps.events,
    tick: async () => {
      await manager.refresh()
      manager.snapshot()
      manager.directSnapshot()
    },
    dispose: () => {
      manager.dispose()
      store.dispose()
    }
  }
}
