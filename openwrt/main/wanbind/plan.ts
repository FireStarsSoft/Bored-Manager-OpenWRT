/**
 * The two check gates: turn form fields into a spec the daemon understands, let
 * the router say whether it would take it, and freeze the exact spec behind a
 * one-use token.
 *
 * Validation of record lives on the router - `instance_check` and `bind_check`
 * in bm-wanbind - so the findings these gates show are the same sentences
 * `bmwan check` shows at a router shell, worded once. **The daemon's findings
 * are the router's own reading of itself: they are shown and never argued
 * with.** A check that disagreed with the apply would be worse than no check at
 * all, because the operator would have read a report about a router that then
 * did something else.
 *
 * What stays on this side is only what needs no router to decide: a name that
 * is not one line of text, a range whose endpoints do not parse or run
 * backwards, a target another binding already follows. Everything about the
 * router's interfaces, zones, priorities, lease ceilings and tables is asked
 * for rather than worked out here - this module used to decide which side of
 * the router an interface was on from its device name, which was true of a
 * stock build and of nothing else.
 *
 * Ids are generated here because a create has to name its section before the
 * check can ask about it, and the same id has to reach the apply: the token is
 * what carries it, so what is created is what was read about.
 */
import {
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import {
  wanbindBindCheck,
  wanbindInstanceCheck,
  type WanbindBindSpec,
  type WanbindInstanceSpec
} from '../agent'
import { isSafeUciValue } from '../uci'
import { ipv4ToInt, isRecord, textField } from '../util'
import { agentDeps, daemonProblem, daemonReady } from './runtime'
import type { BindingRuntime } from './types'

/**
 * An id becomes a UCI section name, and UCI section names hold only letters,
 * digits and underscores. Nothing composes one from anything a person typed -
 * both are generated below - so this is a guard against a future caller rather
 * than against the forms, and it refuses rather than repairing: an id quietly
 * rewritten would name a section this module could never find again.
 */
const SECTION_ID = /^[A-Za-z0-9_]{1,32}$/

/** Lower-cased colon form, which is the spelling the daemon answers in. */
const MAC_ADDRESS = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

const INSTANCE_PREFIX = 'bmi_'
const BINDING_PREFIX = 'bmd_'

/** A pool of one WAN each is 4096 rules; past that is a typo, not a plan. */
const CLIENTS_PER_WAN_MAX = 4096

/** Enough to read; more is a wall of text nobody finishes. */
const SHOWN_DETAILS = 8

/**
 * What a passed instance check freezes.
 *
 * The daemon takes an instance's id *beside* its spec rather than inside it -
 * `instance_set(id, spec)` - so a token carrying only the spec would leave the
 * apply to invent a second id, and it would create a different instance from
 * the one the report described. The session is typed for the spec, and this is
 * that spec plus the two things the daemon keeps outside it, so it is still
 * what the session accepts; `takeInstancePlan` is the one place that reads the
 * extra fields back.
 */
export interface InstancePlan extends WanbindInstanceSpec {
  id: string
  /** False would be an edit, which does not go through a token at all yet. */
  creating: boolean
}

/**
 * Spend an instance token, and get back what the check resolved.
 *
 * The narrowing is here rather than at each call site because it is the only
 * place in this folder that knows the session holds a plan rather than a bare
 * spec, and one cast somebody can read beats three nobody notices.
 */
export function takeInstancePlan(
  runtime: BindingRuntime,
  token: string,
  values: unknown
): InstancePlan | null {
  const taken = runtime.instanceSession.take(token, values)
  return taken ? (taken.payload as InstancePlan) : null
}

/**
 * A section name nothing on this router is using.
 *
 * Random rather than counted, because the counter would have to live somewhere
 * and the only durable place left on this side is the event ring. Six base36
 * characters against a list the router just gave us is enough; the date-stamped
 * fallback exists so that a router answering with a list of every possible id
 * ends in a section name rather than in a loop.
 */
function makeId(prefix: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `${prefix}${Math.random().toString(36).slice(2, 8)}`
    // `Math.random()` occasionally produces a short base36 expansion, and an id
    // of four characters is still unique - it is just not the shape the rest of
    // the module recognises at a glance.
    if (id.length === prefix.length + 6 && SECTION_ID.test(id) && !taken.has(id)) return id
  }
  return `${prefix}${Date.now().toString(36).slice(-6)}`
}

/** A checkbox sends a boolean; an invoke made by hand may send its text. */
function boolField(values: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = values[key]
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'off' || value === '0') return false
  return fallback
}

function has(values: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key)
}

/**
 * The daemon's findings, as the check report's own.
 *
 * Re-read defensively rather than trusted: this arrives as parsed JSON from a
 * router, and a finding with no label would render as an empty row that the
 * operator has no way to interpret. The four levels are spelled the same on
 * both sides, so anything else becomes `info` rather than being dropped - a
 * sentence the router wanted said is worth more than its severity.
 */
function findingsOf(reply: { findings?: unknown }): ModuleCheckFinding[] {
  if (!Array.isArray(reply.findings)) return []
  return reply.findings
    .filter(
      (entry): entry is { level: string; label: string; detail?: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { label?: unknown }).label === 'string'
    )
    .map((entry) => ({
      level:
        entry.level === 'error' || entry.level === 'warning' || entry.level === 'pass'
          ? entry.level
          : 'info',
      label: entry.label,
      ...(entry.detail ? { detail: entry.detail } : {})
    }))
}

/**
 * The two things that must be true before either gate does any work.
 *
 * The daemon gate is here as well as in the requirement table because a check
 * that got past it would issue a token for a router with nothing to apply it
 * to, and the apply would fail with whatever a call to a missing ubus object
 * sounds like. The sentence under the headline is `bindingDaemonProblem`'s own
 * and is never reworded here: an operator who reads one wording on this form
 * and another on the readiness card is reading about the same router.
 */
function notReady(runtime: BindingRuntime, what: 'instance' | 'binding'): ModuleCheckReport | null {
  if (!runtime.ctx.connected) {
    return failedCheck('The router is not connected', 'Connect the machine entry and try again.')
  }
  if (!daemonReady(runtime)) {
    return failedCheck(
      what === 'instance'
        ? 'This router cannot be given a WAN Binding instance'
        : 'This router cannot be given a one-to-one binding',
      daemonProblem(runtime)
    )
  }
  return null
}

// -------------------------------------------------------------------- instance

/**
 * The scope half of the create form: whole LAN, or a window inside it.
 *
 * Only the two things the router cannot be asked about are decided here - that
 * the endpoints are IPv4 at all, and that they are the right way round. Whether
 * they sit inside the LAN's subnet is the daemon's to answer, because only it
 * knows what that subnet is this second, and a second opinion computed from a
 * sample one tick old is how a form comes to refuse an address that is fine.
 */
function scopeKeys(
  values: Record<string, unknown>,
  spec: WanbindInstanceSpec,
  findings: ModuleCheckFinding[]
): void {
  const source = textField(values, 'source')
  if (source && source !== 'lan' && source !== 'range') {
    findings.push({
      level: 'error',
      label: 'Choose either every DHCP client on the LAN or an address range on it'
    })
    return
  }
  if (source !== 'range') return

  const from = textField(values, 'from')
  const to = textField(values, 'to')
  const low = ipv4ToInt(from)
  const high = ipv4ToInt(to)
  if (low == null || high == null) {
    findings.push({
      level: 'error',
      // The one refusal here that does not quote the value back, because at
      // this branch it is still unparsed text of unknown shape.
      label: 'The range start and end must both be IPv4 addresses',
      detail: 'Write them in dotted form, for example 192.168.1.50 and 192.168.1.99.'
    })
    return
  }
  if (low > high) {
    findings.push({ level: 'error', label: `The range runs backwards: ${from} is above ${to}` })
    return
  }
  spec.range_from = from
  spec.range_to = to
}

/**
 * How many clients share one WAN. Absent leaves the daemon's own default alone,
 * which is what an unticked form key has to mean while the create form has no
 * field for this at all.
 */
function capacityKey(
  values: Record<string, unknown>,
  spec: WanbindInstanceSpec,
  findings: ModuleCheckFinding[]
): void {
  if (!has(values, 'clientsPerWan')) return
  const text = textField(values, 'clientsPerWan')
  if (!text) return
  const value = Number(text)
  if (!Number.isInteger(value) || value < 0 || value > CLIENTS_PER_WAN_MAX) {
    findings.push({
      level: 'error',
      label: `Clients per WAN must be a whole number 0-${CLIENTS_PER_WAN_MAX}`,
      detail: '1 gives every client a WAN of its own; a larger number shares one; 0 is no limit.'
    })
    return
  }
  spec.clients_per_wan = value
}

/**
 * What applying this would move, and what it would fence and hand out.
 *
 * These are reply fields rather than findings, which is the daemon saying they
 * are the caller's to render: `moves` in particular is a list rather than a
 * flag precisely so that a page can say what would be disturbed instead of only
 * that something would be.
 */
function planFindings(
  data: {
    moves?: Array<{ field: string; from: string; to: string }>
    pool?: string[]
    scope?: { lanCidr: string; cidrs: string[] } | null
  },
  findings: ModuleCheckFinding[]
): void {
  const moves = data.moves ?? []
  if (moves.length) {
    findings.push({
      level: 'warning',
      label: `${moves.length} setting(s) this instance is stamped with would move`,
      detail: `${moves
        .slice(0, SHOWN_DETAILS)
        .map((move) => `${move.field}: ${move.from} -> ${move.to}`)
        .join(
          '; '
        )}. Every rule standing on the router for this instance was written at the old numbers, so they are flushed and written again.`
    })
  }

  const pool = data.pool ?? []
  if (pool.length) {
    findings.push({
      level: 'pass',
      label: `${pool.length} WAN(s) go into this instance's pool`,
      detail: pool.slice(0, SHOWN_DETAILS).join(', ')
    })
  }

  const scope = data.scope
  if (scope) {
    findings.push({
      level: 'pass',
      label: scope.cidrs.length
        ? `${scope.cidrs.length} address block(s) on ${scope.lanCidr} are fenced by this instance`
        : `The whole of ${scope.lanCidr} is fenced by this instance`,
      detail:
        'Devices inside the fence with no WAN of their own are held off the internet rather than leaking onto the router\'s own connection; devices outside it are left completely alone.'
    })
  }
}

/** Ask the router, fold its findings in, and freeze the plan when it passes. */
async function checkInstanceWithDaemon(
  runtime: BindingRuntime,
  id: string,
  spec: WanbindInstanceSpec,
  values: Record<string, unknown>,
  local: ModuleCheckFinding[]
): Promise<ModuleCheckReport> {
  const reply = await wanbindInstanceCheck(agentDeps(runtime), id, spec)

  // `ok: false` with data is the daemon refusing and saying why; only a reply
  // with nothing in it at all is the call itself having failed.
  if (!reply.ok && !reply.data) {
    return {
      ok: false,
      findings: [
        ...local,
        {
          level: 'error',
          label: 'The router could not check this instance',
          detail: reply.error ?? 'It did not answer.'
        }
      ]
    }
  }

  const data = reply.data
  const findings = [...local, ...findingsOf(data ?? {})]
  if (data) planFindings(data, findings)
  if (data?.reason) findings.push({ level: 'info', label: data.reason })

  const ok = data?.ok === true && !hasBlockingFinding(findings)
  if (!ok) return { ok: false, findings }

  const plan: InstancePlan = { ...spec, id, creating: true }
  return { ok: true, token: runtime.instanceSession.issue(values, plan), findings }
}

/** The create gate for a WAN Binding instance. */
export async function checkInstance(
  runtime: BindingRuntime,
  raw: unknown
): Promise<ModuleCheckReport> {
  const refusal = notReady(runtime, 'instance')
  if (refusal) return refusal

  const values = isRecord(raw) ? raw : {}
  const findings: ModuleCheckFinding[] = []
  // The router's own list, which is the only list there is: this module keeps
  // no record of an instance any more, so a name clash or a taken id can only
  // be told from what the daemon last answered with.
  const configured = runtime.cache.info?.configured ?? []

  const name = textField(values, 'name')
  if (!name || name.length > 80 || !isSafeUciValue(name)) {
    findings.push({
      level: 'error',
      // The value is deliberately not echoed back: this name reaches job
      // labels, event rows and `ctx.log` on this side before it is ever a UCI
      // value on the router, and a newline inside it forges a whole log line
      // here whatever the daemon would have made of it.
      label: 'Instance name must contain 1-80 characters on one line'
    })
  } else if (configured.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
    findings.push({ level: 'error', label: `An instance named "${name}" already exists` })
  }

  const lan = textField(values, 'lan')
  const carrier = textField(values, 'carrier')
  if (!lan || !carrier) {
    findings.push({
      level: 'error',
      label: 'Choose exactly one LAN interface and one WAN carrier'
    })
  } else if (lan === carrier) {
    findings.push({
      level: 'error',
      label: 'The LAN logical interface and WAN carrier must be different'
    })
  }

  const spec: WanbindInstanceSpec = {
    name,
    lan,
    carrier,
    sticky: boolField(values, 'sticky', true),
    remap: boolField(values, 'remap', true),
    // A create says so outright. Every other verb here omits what it is not
    // changing, but there is no section yet whose value could be kept.
    enabled: true
  }
  if (values.raiseDhcpLimits === true) spec.raise_dhcp_limits = true
  scopeKeys(values, spec, findings)
  capacityKey(values, spec, findings)

  if (hasBlockingFinding(findings)) return { ok: false, findings }

  const id = makeId(INSTANCE_PREFIX, new Set(configured.map((entry) => entry.id)))
  return checkInstanceWithDaemon(runtime, id, spec, values, findings)
}

// --------------------------------------------------------------------- binding

/**
 * The one-to-one bindings somebody wrote, as opposed to the seats an instance
 * handed out.
 *
 * The daemon reports both through `bindings` and tells them apart with
 * `source`, and the difference decides two things here: a name only has to be
 * unique among the sections a person can see and edit, and a seat on an address
 * is not a reason to refuse binding that address - taking a client off its
 * instance and pinning it is the whole point of the form.
 */
function manualBindings(runtime: BindingRuntime): ReadonlyArray<{
  id: string
  name: string
  targetKind: string
  label: string
}> {
  return (runtime.cache.bindings?.bindings ?? []).filter((binding) => binding.source === 'manual')
}

/** Ask the router about a binding, fold its findings in, freeze the spec. */
async function checkBindWithDaemon(
  runtime: BindingRuntime,
  spec: WanbindBindSpec,
  values: Record<string, unknown>,
  local: ModuleCheckFinding[]
): Promise<ModuleCheckReport> {
  const reply = await wanbindBindCheck(agentDeps(runtime), spec)

  if (!reply.ok && !reply.data) {
    return {
      ok: false,
      findings: [
        ...local,
        {
          level: 'error',
          label: 'The router could not check this binding',
          detail: reply.error ?? 'It did not answer.'
        }
      ]
    }
  }

  const data = reply.data
  const findings = [...local, ...findingsOf(data ?? {})]
  if (data?.reason) findings.push({ level: 'info', label: data.reason })

  const ok = data?.ok === true && !hasBlockingFinding(findings)
  if (!ok) return { ok: false, findings }

  return {
    ok: true,
    // The spec already carries its own id, so unlike an instance there is
    // nothing to wrap it in.
    token: runtime.bindSession.issue(values, Object.freeze({ ...spec })),
    findings
  }
}

/** The create gate for one address on one WAN port. */
export async function checkBind(
  runtime: BindingRuntime,
  raw: unknown
): Promise<ModuleCheckReport> {
  const refusal = notReady(runtime, 'binding')
  if (refusal) return refusal

  const values = isRecord(raw) ? raw : {}
  const findings: ModuleCheckFinding[] = []
  const held = manualBindings(runtime)

  const name = textField(values, 'name')
  if (!name || name.length > 80 || !isSafeUciValue(name)) {
    findings.push({
      level: 'error',
      label: 'Binding name must contain 1-80 characters on one line'
    })
  } else if (held.some((binding) => binding.name.toLowerCase() === name.toLowerCase())) {
    findings.push({ level: 'error', label: `A one-to-one binding named "${name}" already exists` })
  }

  const kindRaw = textField(values, 'targetKind').toLowerCase()
  const kind = kindRaw === 'mac' ? 'mac' : kindRaw === 'ip' ? 'ip' : ''
  if (!kind) {
    findings.push({
      level: 'error',
      label: 'Choose whether this binding names an IP address or a device MAC'
    })
  }

  const typed = textField(values, 'address')
  const address = kind === 'mac' ? typed.toLowerCase() : typed
  if (kind === 'ip' && ipv4ToInt(address) == null) {
    findings.push({
      level: 'error',
      label: 'The address must be an IPv4 address',
      detail: 'Write it in dotted form, for example 192.168.1.50.'
    })
  } else if (kind === 'mac' && !MAC_ADDRESS.test(address)) {
    findings.push({
      level: 'error',
      label: 'The MAC must be twelve hexadecimal digits in colon form',
      detail: 'For example 3c:2a:f4:11:0b:97.'
    })
  } else if (kind) {
    // Two sections naming one target is two rules for one address, and only the
    // lower priority ever runs - so the second binding reads as created,
    // steers nothing, and the operator has no way to see which of the pair is
    // in force. The daemon refuses this too; refusing here means the sentence
    // names the binding that already has it.
    const owner = held.find(
      (binding) => binding.targetKind === kind && binding.label.toLowerCase() === address.toLowerCase()
    )
    if (owner) {
      findings.push({
        level: 'error',
        label: `The one-to-one binding "${owner.name}" already follows ${address}`,
        detail:
          'Change that binding instead - its WAN port cannot be edited, so if it is the wrong one, delete it and create this one again.'
      })
    }
  }

  const wan = textField(values, 'wan')
  if (!wan) findings.push({ level: 'error', label: 'Choose the WAN port this address leaves by' })

  const whenDownRaw = textField(values, 'whenDown')
  if (whenDownRaw && whenDownRaw !== 'hold' && whenDownRaw !== 'fallback') {
    findings.push({
      level: 'error',
      label: 'Choose what happens to this address while its WAN is down'
    })
  }

  if (hasBlockingFinding(findings)) return { ok: false, findings }

  const id = makeId(
    BINDING_PREFIX,
    new Set((runtime.cache.bindings?.bindings ?? []).map((binding) => binding.id))
  )
  const spec: WanbindBindSpec = {
    id,
    name,
    wan,
    whenDown: whenDownRaw === 'fallback' ? 'fallback' : 'hold',
    ...(kind === 'mac' ? { mac: address } : { ip: address }),
    enabled: true
  }
  // `pref` and `table` are deliberately absent: the daemon allocates the first
  // from its own band and reads the second off netifd, and a number sent from
  // here would be this module deciding something it no longer owns.
  return checkBindWithDaemon(runtime, spec, values, findings)
}
