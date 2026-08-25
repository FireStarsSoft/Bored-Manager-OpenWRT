import type { ModuleExecResult } from '@shared/modules'
import { moduleHarness, type ModuleHarness, type ModuleHarnessOptions } from './module-harness'

/**
 * A per-router document that a module can actually write to.
 *
 * The harness's own `hostDataGet` hands back a fixed `options.hostData` and its
 * `hostDataSet` only records the call, so a test that creates something and
 * then asks a handler whether it is there is reading the module's in-memory
 * cache - it would pass just as happily if nothing were ever persisted. This
 * puts one variable behind both members, which is what makes "and it was still
 * there after a reload" a statement about the write rather than about the
 * cache.
 *
 * `module-harness.ts` is a vendored SDK copy and cannot be changed, so the
 * wiring is done from the test side, the way `watch()` in
 * `openwrt-runtime.test.ts` wraps `ctx.log`.
 */
export interface HostDataDocument {
  /** What is on disk right now, or null before anything has written it. */
  read(): unknown
  /** Overwrite it, the way the app does when a module calls `hostDataSet`. */
  write(value: unknown): void
  /** How many times a module has written it. */
  writes: number
}

export function hostDataDocument(initial: unknown = null): HostDataDocument {
  let value = initial === null || initial === undefined ? null : clone(initial)
  const doc: HostDataDocument = {
    read: () => value,
    write: (next) => {
      // A snapshot, not the object the module handed over. `serializeHostData`
      // reuses the live arrays out of the store's cache, so keeping a reference
      // would let a mutation made after the write change what "was on disk" -
      // and a round-trip test would be reading the cache again by another name.
      value = clone(next)
      doc.writes += 1
    },
    writes: 0
  }
  return doc
}

function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

/** The value the harness's own `hostDataGet` returns while the context is live. */
const LIVE = { live: true }

/**
 * A harness whose host data is `doc` rather than a fixed value.
 *
 * Two of these over one document are one router read twice: a module that
 * writes through the first and a module that starts up against what it wrote.
 */
export function harnessOverHostData(
  id: string,
  answer: (command: string) => ModuleExecResult | Promise<ModuleExecResult>,
  doc: HostDataDocument,
  options: Omit<ModuleHarnessOptions, 'hostData'> = {}
): ModuleHarness {
  const harness = moduleHarness(id, answer, { ...options, hostData: LIVE })
  const ctx = harness.ctx as unknown as {
    hostDataGet: () => unknown
    hostDataSet: (value: unknown) => void
  }
  const realGet = ctx.hostDataGet
  const realSet = ctx.hostDataSet
  // The real members still run, so the harness's post-stop rule keeps applying:
  // once the context is revoked its getter answers null instead of `LIVE`, and
  // a read or a write made after that is recorded in `afterStopCalls` and goes
  // no further than it would on a real host.
  ctx.hostDataGet = () => (realGet() === LIVE ? doc.read() : null)
  ctx.hostDataSet = (value) => {
    realSet(value)
    if (realGet() !== LIVE) return
    doc.write(value)
  }
  return harness
}
