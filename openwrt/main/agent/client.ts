/**
 * Calling the router-side agent, and refusing to when it is not there.
 *
 * Every call is one `ubus -S call <object> <method>` over the connection the
 * module already has. There is no second transport and no daemon of its own on
 * this side: the agent is a faster, safer way to do things through the same
 * SSH session, not a replacement for it.
 *
 * Three objects, and which one is reachable is a property of the router rather
 * than of this module: `bm.agent` comes with the agent, and `bm.wanbind` and
 * `bm.pppoe` arrive only with their own packages. A call to one that is not
 * installed is refused here, by name, before anything reaches a shell.
 *
 * Two rules run through all of it:
 *
 * - **Never assume the agent is there.** The verdict is read at call time from
 *   the capability latch, because an `apk del` on the router lands between one
 *   readiness cycle and the next, and a call built on a stale yes fails as a
 *   shell error instead of a sentence.
 * - **A failure here is a fall back, not an error.** Everything the agent does,
 *   the SSH path can still do. So a call that did not work says so and lets the
 *   caller decide, rather than turning a slower route into a broken one.
 */
import type { ModuleContext } from '@shared/modules'
import { shQuote } from '@shared/shell'
import type { AgentCapability } from '../probe'

/**
 * The three ubus objects this module knows how to talk to.
 *
 * `bm.agent` is always there when the agent is; the other two arrive with their
 * own packages and are therefore asked for by capability rather than assumed.
 * The names are constants here so that no caller composes one - a ubus object
 * name reaches a command line, and one built from anything a user typed would
 * be a way to invoke arbitrary router services through this module.
 */
export const AGENT_OBJECT = 'bm.agent'
export const WANBIND_OBJECT = 'bm.wanbind'
export const PPPOE_OBJECT = 'bm.pppoe'

/**
 * A capability name a feature package declares in `provides`.
 *
 * The agent reads `/usr/share/bm/features/` on every `info` call and reports
 * the flat list, so this is what the module branches on rather than a package
 * name: a capability can move between packages later without this side having
 * to learn the new arrangement.
 */
export type AgentFeature = 'binding' | 'pppoe' | 'direct'

/** ubus is local to the router; anything slower than this is a fault. */
const CALL_TIMEOUT_MS = 30_000

/** Downloading and installing packages, which is minutes rather than seconds. */
export const LONG_CALL_TIMEOUT_MS = 300_000

export interface AgentCallResult<T = Record<string, unknown>> {
  ok: boolean
  /** Parsed reply on success. */
  data: T | null
  /** Why not, in a sentence a surface can show. */
  error: string | null
}

/** What the client needs, so it can be built from a test without a runtime. */
export interface AgentDeps {
  ctx: ModuleContext
  /** Read per call, never captured: an agent can be removed under this. */
  capability: () => AgentCapability
}

function refusal(message: string): AgentCallResult {
  return { ok: false, data: null, error: message }
}

/**
 * Whether the router has the package that answers `feature`.
 *
 * Separate from `usable` because they fail differently and for different
 * reasons: no agent at all is one sentence about this router, and an agent with
 * no `bm-wanbind` beside it is another about one package. Collapsing them would
 * send somebody to reinstall the agent they already have.
 */
export function hasFeature(capability: AgentCapability, feature: AgentFeature): boolean {
  return capability.usable && capability.provides.includes(feature)
}

/** The one sentence for a router whose agent is there but the package is not. */
export function missingFeature(feature: AgentFeature): string {
  if (feature === 'binding') {
    return 'This router has the Bored Manager agent but not bm-wanbind, so binding is being done over SSH. Install it from Module settings, Router packages.'
  }
  if (feature === 'direct') {
    // Worded about the *version* rather than about the package, because the
    // router this fires on almost always has bm-wanbind: it has the one that
    // owns instances and not the one that owns one-to-one bindings. Telling
    // somebody to install a package they can see installed is how a sentence
    // stops being read.
    return 'This router has bm-wanbind, but not a version new enough to own one-to-one bindings, so they are being written over SSH. Update it from Module settings, Router packages.'
  }
  return 'This router has the Bored Manager agent but not bm-pppoe-pool, so PPPoE Dialer pools are being created over SSH. Install it from Module settings, Router packages.'
}

/**
 * A refusal in the transport's own shape, for a call that never left because
 * the router does not have the feature it needs.
 *
 * Published so that `wanbind.ts` can gate a *method* the way `objectCall` gates
 * an *object*: `bm.wanbind` exists as soon as the package does, and the four
 * one-to-one methods arrived a release later than the rest of it. A router with
 * the older package answers them with a shell error about an unknown method,
 * and one sentence about the version is worth more than that.
 */
export function featureRefusal<T = Record<string, unknown>>(
  feature: AgentFeature
): AgentCallResult<T> {
  return refusal(missingFeature(feature)) as AgentCallResult<T>
}

/**
 * One ubus call, to one of the three objects above.
 *
 * Arguments go as one JSON document rather than as a command line, quoted
 * exactly once here. Nothing a user typed is ever spliced into the string: the
 * object and the method name come from this module and the payload is
 * serialized, so there is no path from a form field to a shell token.
 */
/**
 * The command one ubus call becomes, and the only place that shape is written.
 *
 * Exported because a caller sending a list has to know how big the call will be
 * *before* it makes it: the whole payload travels as one shell argument, and an
 * SSH server refuses an exec request whose command is longer than a few
 * kilobytes - before any shell runs, so there is no output to read and nothing
 * on the router to look at afterwards. Measuring anything less than this - the
 * unquoted JSON, or its length in characters rather than in bytes - under-counts:
 * a name typed in Thai costs three bytes a character, and an apostrophe costs
 * four once it is quoted.
 */
export function ubusCommand(object: string, method: string, args: unknown): string {
  return `ubus -S call ${object} ${method} ${shQuote(JSON.stringify(args))}`
}

/** That command's length on the wire, in bytes rather than in characters. */
export function ubusCommandBytes(object: string, method: string, args: unknown): number {
  return new TextEncoder().encode(ubusCommand(object, method, args)).length
}

export async function objectCall<T = Record<string, unknown>>(
  deps: AgentDeps,
  object: string,
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs = CALL_TIMEOUT_MS
): Promise<AgentCallResult<T>> {
  const capability = deps.capability()

  if (!capability.usable) {
    return refusal(
      capability.problem ??
        'There is no Bored Manager agent on this router, so this has to be done over SSH.'
    ) as AgentCallResult<T>
  }

  // The object, not the method. `bm.wanbind` is there as soon as the package
  // is, and the package has claimed `binding` since 2.0.0 and `direct` since
  // 2.3.0 - so either capability is evidence the object exists. Which methods
  // it answers is a finer question, and `wanbind.ts` asks it per call.
  if (
    object === WANBIND_OBJECT &&
    !hasFeature(capability, 'binding') &&
    !hasFeature(capability, 'direct')
  ) {
    return refusal(missingFeature('binding')) as AgentCallResult<T>
  }

  if (object === PPPOE_OBJECT && !hasFeature(capability, 'pppoe')) {
    return refusal(missingFeature('pppoe')) as AgentCallResult<T>
  }

  if (!deps.ctx.connected) {
    return refusal('Not connected to the router.') as AgentCallResult<T>
  }

  const command = ubusCommand(object, method, args)

  try {
    const result = await deps.ctx.exec(command, { timeoutMs })

    if (result.code !== 0) {
      // ubus prints its reason on stderr and exits non-zero for an unknown
      // method as readily as for a broken one, so the text is what tells the
      // two apart - and it is the only thing the user can act on.
      const reason = (result.stderr || result.stdout || '').replace(/\s+/g, ' ').trim()
      return refusal(
        reason ? `The agent refused ${method}: ${reason.slice(0, 300)}` : `The agent refused ${method}.`
      ) as AgentCallResult<T>
    }

    const text = (result.stdout || '').trim()
    // A ubus method with nothing to say answers with no body at all, which is a
    // success rather than a parse failure.
    if (!text) return { ok: true, data: null, error: null }

    try {
      return { ok: true, data: JSON.parse(text) as T, error: null }
    } catch {
      return refusal(
        `The agent answered ${method} with something that is not JSON.`
      ) as AgentCallResult<T>
    }
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, ' ')
      .trim()
    return refusal(`Could not reach the agent: ${reason.slice(0, 200)}`) as AgentCallResult<T>
  }
}

/**
 * The same call, to `bm.agent`.
 *
 * Kept as its own name because it is by far the most common one and reads
 * better at every call site than repeating the object; everything about the
 * agent itself - snapshots, the guard, updates - goes through here.
 */
export async function agentCall<T = Record<string, unknown>>(
  deps: AgentDeps,
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs = CALL_TIMEOUT_MS
): Promise<AgentCallResult<T>> {
  return objectCall<T>(deps, AGENT_OBJECT, method, args, timeoutMs)
}

/**
 * The agent's own answers carry `{ ok: false, reason }` inside a successful
 * ubus call - the call worked, the thing it asked for did not. Folding that
 * into the transport result here means one shape reaches every caller instead
 * of two levels of "did it work".
 */
export function unwrap<T>(result: AgentCallResult<T>): AgentCallResult<T> {
  if (!result.ok || !result.data) return result

  // Read defensively rather than through a type constraint. Every reply this
  // module reads carries `ok` and `reason` when it refuses and neither when it
  // succeeds, so a constraint that demanded them would force every caller to
  // widen its own return type to include fields it never sees.
  const body = result.data as { ok?: unknown; reason?: unknown }
  if (body.ok !== false) return result

  return {
    ok: false,
    data: result.data,
    error:
      typeof body.reason === 'string' ? body.reason : 'The agent refused, without saying why.'
  }
}
