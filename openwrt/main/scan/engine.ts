/**
 * The object the container holds: one poller, one cached snapshot, one stream.
 *
 * The monitor is the only collector in this module that exists purely to be
 * looked at. Nothing reconciles against it and nothing acts on it, which is
 * what makes the gate in `tick` the most important line in the file: a router
 * nobody has the Monitor page open on must not be paying for a round trip every
 * minute, forever, for a table no one will read. The readiness poller gates
 * itself on `streamActive('capabilities')` for exactly that reason and this
 * copies it - the page's own `{kind:'stream', event:'monitor'}` sources are what
 * arm it, and closing the page disarms it again.
 *
 * `scanNow()` is the button beside that: it forces a pass whether or not
 * anything is watching, because a person pressing it *is* the thing watching.
 * It still refuses politely on a disconnected machine rather than putting a
 * call on a wire with nothing at the other end.
 *
 * A pass is now one `bm.wanbind` call. There is no shell command here any more
 * and there must not be one again: the daemon reads both netlink dumps in one
 * place, holds the sections those rules were written against, and is therefore
 * the only half that can say who owns a rule and be right.
 */
import type { ModulePoller } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { wanbindRules, type AgentDeps } from '../agent'
import { RULE_BOUNDS } from '../config'
import { bindingDaemonProblem } from '../requirements'
import { buildScanRows, emptyScanSummary } from './rows'
import type { ScanEngineOptions, ScanSnapshot } from './types'

const NOT_CONNECTED =
  'not connected to a router - connect this machine entry, then scan again'

/**
 * The router went away, or the module was reset, while a pass was in flight.
 *
 * Its own copy of the sentence the rest of the module uses for the same three
 * causes. It reads like a module bug when it names an object nobody has heard
 * of and gives no cause at all, which on a failed action is worse than useless.
 */
const SCAN_STOPPED =
  'the router disconnected, or the module was reset, before this finished - reconnect and try again'

/**
 * `read: false` from the daemon, which is not an empty router.
 *
 * The one sentence this feature must never say wrongly is "this router has no
 * policy rules": it is the exact opposite of the answer a person opened the
 * page to get. The daemon answers `read: false` when a netlink dump would not
 * come back, and it carries an empty rule list beside it - so the flag is read
 * before the list, always, and a failed dump is published as a failed sweep.
 */
const UNREADABLE =
  'the router could not read its own rule table - the kernel did not answer the dump - so this pass was discarded rather than reported as a router with no rules'

/** The call worked and the daemon still refused. Rare, and worth its own words. */
const REFUSED = 'the router refused the rule scan without saying why'

/** Nothing scanned yet, which is not the same statement as a failed scan. */
export function emptyScanSnapshot(): ScanSnapshot {
  return {
    t: 0,
    ok: true,
    lastError: '',
    rows: [],
    // Nothing has been read, so nothing has been cut and no cap has been named:
    // the ceiling on one reply is the daemon's number, and it travels in the
    // reply rather than being guessed at here.
    summary: emptyScanSummary()
  }
}

export class ScanEngine {
  private readonly options: ScanEngineOptions
  private readonly poller: ModulePoller
  private payload: ScanSnapshot = emptyScanSnapshot()
  /**
   * The interval the poller is currently running at, or null while it is
   * stopped. Held for the reason `readiness.ts` holds `fastAppliedMs`: without
   * it there is no way to tell "already running at the right rate" from
   * "running at yesterday's rate", and a changed `scanIntervalSec` would keep
   * the old cadence until the next reconnect.
   */
  private appliedMs: number | null = null
  private flight: Promise<string> | null = null
  /**
   * Bumped by every reset and by dispose. A pass is a round trip, and a host
   * change arriving in that window used to let the reply land anyway - rows
   * published onto the `monitor` stream as though they described the router now
   * connected.
   */
  private generation = 0
  private disposed = false

  constructor(options: ScanEngineOptions) {
    this.options = options
    this.poller = options.ctx.createPoller('openwrt:scan', () => this.tick())
  }

  snapshot(): ScanSnapshot {
    return this.payload
  }

  rows(): ScanSnapshot['rows'] {
    return this.payload.rows
  }

  async scanNow(): Promise<OkResult> {
    if (this.disposed) return { ok: false, error: SCAN_STOPPED }
    if (!this.options.ctx.connected) return { ok: false, error: NOT_CONNECTED }
    const error = await this.sweep()
    return error ? { ok: false, error } : { ok: true }
  }

  /**
   * Start, stop and re-time from the three things that decide the cadence. One
   * comparison covers all of it: a wanted interval that differs from the
   * applied one is a stop and a start, and null is a stop.
   *
   * The verdict is one of the three on purpose. A machine that answered "not a
   * router" - or one blocked on its firmware - has no rule table worth reading
   * and never will until something changes, and this module holds the line
   * that such a machine pays for nothing at all afterwards, not even a timer
   * that wakes up to decide it has no work. `readiness.startPollers` calls
   * this again on the far side of every probe, so a router that becomes usable
   * arms the monitor without waiting for the next tab switch.
   *
   * A router with no `bm-wanbind` still arms it, and that is deliberate: the
   * pass costs no round trip there - it stops at the capability verdict and
   * publishes the requirement's own sentence - and that sentence, on the page
   * somebody has open, is the whole of what they need to be told.
   */
  applyPollers(): void {
    const caps = this.options.capabilities()
    const usable = caps.probed && caps.problem === null
    const bounds = RULE_BOUNDS.scanIntervalSec
    const wanted =
      !this.disposed && this.options.ctx.connected && usable
        ? Math.min(bounds.max, Math.max(bounds.min, Math.trunc(this.options.rules().scanIntervalSec))) *
          1_000
        : null
    if (wanted === this.appliedMs) return
    this.appliedMs = wanted
    this.poller.stop()
    if (wanted !== null) this.poller.start(wanted)
  }

  reset(): void {
    this.payload = emptyScanSnapshot()
    this.flight = null
    this.generation += 1
    this.appliedMs = null
    this.poller.stop()
  }

  dispose(): void {
    this.disposed = true
    this.flight = null
    this.generation += 1
    this.appliedMs = null
    this.poller.stop()
  }

  private async tick(): Promise<void> {
    const ctx = this.options.ctx
    if (this.disposed || !ctx.connected) return
    // No Monitor surface open, no call. See the file header.
    if (!ctx.streamActive('monitor')) return
    // A router the module has already judged unusable will answer this the
    // same way it answers everything else, and the capabilities card is
    // already saying why. Asking it once a minute anyway only adds a failed
    // scan to the reason.
    if (this.options.capabilities().problem) return
    await this.sweep()
  }

  /**
   * One pass, shared by whoever asks for it first.
   *
   * A button press arriving while a poller tick is in flight joins that tick
   * rather than opening a second call against the same router - and, more to
   * the point, rather than racing it to publish a snapshot.
   */
  private sweep(): Promise<string> {
    const existing = this.flight
    if (existing) return existing
    const pending = this.run().finally(() => {
      if (this.flight === pending) this.flight = null
    })
    this.flight = pending
    return pending
  }

  /**
   * What a daemon call takes, built per pass.
   *
   * The capability is read inside the closure rather than captured, so an `apk
   * add` or an `apk del` on the router changes what this module can do at the
   * next tick rather than at the next reconnect.
   */
  private deps(): AgentDeps {
    return { ctx: this.options.ctx, capability: this.options.agent }
  }

  /** Returns the failure sentence, or an empty string when the pass landed. */
  private async run(): Promise<string> {
    const generation = this.generation
    // The requirement's own words, not invented ones. No agent, no bm-wanbind
    // and a package too old to drive are three different things to go and do,
    // and one sentence saying "the scan failed" would send somebody to
    // reinstall an agent they can see running.
    const problem = bindingDaemonProblem(this.options.agent())
    if (problem) return this.fail(generation, problem)

    const reply = await wanbindRules(this.deps())
    if (!this.current(generation)) return SCAN_STOPPED
    if (!reply.ok || !reply.data) return this.fail(generation, reply.error ?? REFUSED)
    // Before the list, always. An empty `rules` beside `read: false` is the
    // kernel declining to answer, and publishing it as a table would say the
    // one thing this feature must never say wrongly.
    if (!reply.data.read) return this.fail(generation, UNREADABLE)

    const { rows, summary } = buildScanRows(reply.data)
    if (!this.current(generation)) return SCAN_STOPPED
    this.publish({ t: Date.now(), ok: true, lastError: '', rows, summary })
    return ''
  }

  /** Still the same engine, on the same router, as when this pass started. */
  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  /**
   * A failed pass keeps the rows and the timestamp it already had. They
   * describe the router as it was at that moment, which is true and stale;
   * replacing them with nothing would tell a reader the rules had gone away,
   * and re-stamping them with now would tell them the scan had just succeeded.
   */
  private fail(generation: number, error: string): string {
    if (!this.current(generation)) return error
    this.publish({ ...this.payload, ok: false, lastError: error })
    this.options.ctx.log(`openwrt: ${error}`)
    return error
  }

  private publish(next: ScanSnapshot): void {
    this.payload = next
    this.options.ctx.emit('monitor', next)
  }
}
