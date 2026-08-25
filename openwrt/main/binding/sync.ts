/**
 * Keeping `/etc/config/bm_wanbind` in step with this module's own records.
 *
 * There is one rule and everything else follows from it: **the records are the
 * truth, and the file is a projection of them.** So this is not five branches
 * threaded through create, start, stop, rename and delete - it is one
 * convergent function that writes what the records say and removes what they do
 * not, and every one of those five works by changing a record and calling it.
 * Adding a sixth operation later needs no change here at all.
 *
 * That also makes it safe to run when nothing has happened, which is what makes
 * it a repair: a router restored from a backup, one whose file somebody edited,
 * or one that gained the package after the instances were created all converge
 * on the next call rather than needing anything noticed.
 *
 * Ordering matters in exactly one place. An instance being removed has its
 * rules flushed *before* its section goes, because once the section is gone the
 * daemon has no instance for that priority range and will never look at it
 * again - the rules would stay on the router with nothing maintaining them and
 * nothing able to explain them.
 */
import { hasFeature, wanbindFlush, wanbindInstanceLines, wanbindRemoveLines, wanbindSection, type AgentDeps } from '../agent'
import { recordLayout } from '../records'
import type { AgentCapability } from '../probe'
import { runUciBatch } from '../uci'
import type { BindingRuntime } from './types'

/** Reading and rewriting one small config file; nothing here is a long wait. */
const SYNC_TIMEOUT_MS = 30_000

/** `bm_wanbind.bmABC=instance` -> `bmABC`. Sections only, never options. */
const SECTION_LINE = /^bm_wanbind\.([A-Za-z0-9_]+)=instance\s*$/

/**
 * What the router currently has, or null when it could not be read.
 *
 * Null is not an empty set, and the difference decides whether anything is
 * deleted: a failed read treated as "the router has no sections" would delete
 * nothing and add everything, which is harmless, but the same mistake in the
 * other direction would be a router losing its instances because one command
 * did not run.
 */
async function currentSections(runtime: BindingRuntime): Promise<Set<string> | null> {
  const result = await runtime.ctx.exec('uci -q show bm_wanbind', {
    timeoutMs: SYNC_TIMEOUT_MS
  })

  // A router with the package but no instances yet has an empty file and uci
  // exits non-zero on it, which is not a failure to read.
  if (result.code !== 0 && (result.stderr || '').trim().length > 0) return null

  const out = new Set<string>()
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    const match = SECTION_LINE.exec(line.trim())
    if (match) out.add(match[1])
  }
  return out
}

export interface SyncOutcome {
  /** Sections written, whether or not they were already right. */
  wrote: number
  /** Sections removed because no record names them any more. */
  removed: number
  /** Why nothing happened, or null. Never a failure to report to a user. */
  skipped: string | null
}

const NOTHING: SyncOutcome = { wrote: 0, removed: 0, skipped: null }

/**
 * Write the instance sections, remove the orphans, and tell the service.
 *
 * Returns rather than throws. Every caller is a mutation that has already
 * succeeded in this module's own records - the instance exists, it is running,
 * it was renamed - and failing that operation because the router's copy could
 * not be updated would leave the user with an error and a change that did
 * happen. The next call converges instead, and there is always a next call:
 * the slow tick makes one.
 */
export async function syncRouterInstances(
  runtime: BindingRuntime,
  capability: AgentCapability | undefined
): Promise<SyncOutcome> {
  if (!capability || !hasFeature(capability, 'binding')) {
    return { ...NOTHING, skipped: 'this router is not running bm-wanbind' }
  }
  if (runtime.disposed || !runtime.ctx.connected) {
    return { ...NOTHING, skipped: 'not connected' }
  }

  const present = await currentSections(runtime)
  if (present === null) {
    return { ...NOTHING, skipped: 'the router did not say what it has' }
  }

  const rules = runtime.options.rules()
  const instances = runtime.store.read().instances
  const wanted = new Map(instances.map((one) => [wanbindSection(one.id), one]))

  const lines: string[] = []
  let wrote = 0

  for (const [, instance] of wanted) {
    // Throws only on a record naming something that is not an interface name,
    // which the create gate made impossible. Left to propagate rather than
    // swallowed: it would mean a record this module wrote is not one it can
    // read, and continuing past that is worse than stopping.
    lines.push(...wanbindInstanceLines(instance, recordLayout(instance, rules), rules))
    wrote++
  }

  const orphans = [...present].filter((section) => !wanted.has(section))
  const deps: AgentDeps = { ctx: runtime.ctx, capability: () => capability }

  for (const section of orphans) {
    // Before the section is removed, never after. See the note at the top.
    await wanbindFlush(deps, section)
    lines.push(...wanbindRemoveLines(section))
  }

  if (!lines.length) return NOTHING

  await runUciBatch(runtime.ctx, lines, ['bm_wanbind'], SYNC_TIMEOUT_MS)

  // procd hashes the file and restarts the instance when it changes, but only
  // when it is told to look. `reload` is what tells it, and it is also what
  // makes an edit take effect without waiting for the next reboot.
  await runtime.ctx.exec('/etc/init.d/bm-wanbind reload', { timeoutMs: SYNC_TIMEOUT_MS })

  return { wrote, removed: orphans.length, skipped: null }
}

/**
 * The same, but never throwing and never blocking the caller.
 *
 * What the engine's mutation methods use. A sync that failed is a router one
 * tick behind its records, which the next call corrects; turning it into a
 * failed Start would be reporting the wrong thing about an instance that did
 * start.
 */
export function syncRouterInstancesQuietly(
  runtime: BindingRuntime,
  capability: AgentCapability | undefined
): void {
  void syncRouterInstances(runtime, capability).catch((error) => {
    if (runtime.disposed) return
    runtime.ctx.log(
      `openwrt: could not update bm_wanbind on the router: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  })
}
