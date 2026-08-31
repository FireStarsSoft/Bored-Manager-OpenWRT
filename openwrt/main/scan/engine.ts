/**
 * The object the container holds: one poller, one cached snapshot, one stream.
 *
 * The monitor is the only collector in this module that exists purely to be
 * looked at. Nothing reconciles against it and nothing acts on it, which is
 * what makes the gate in `tick` the most important line in the file: a router
 * nobody has the Monitor page open on must not be paying for an SSH round trip
 * every minute, forever, for a table no one will read. The readiness poller
 * gates itself on `streamActive('capabilities')` for exactly that reason and
 * this copies it - the page's own `{kind:'stream', event:'monitor'}` sources
 * are what arm it, and closing the page disarms it again.
 *
 * `scanNow()` is the button beside that: it forces a pass whether or not
 * anything is watching, because a person pressing it *is* the thing watching.
 * It still refuses politely on a disconnected machine, in the same words the
 * `sweepNow` handler uses, rather than putting a command on a wire with nothing
 * at the other end.
 */
import type { ModulePoller } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { ENGINE_STOPPED } from '../binding'
import { RULE_BOUNDS } from '../config'
import { classifyScan } from './classify'
import { SCAN_COMMAND, SCAN_MAX_RULES, SCAN_TIMEOUT_MS } from './command'
import { isKernelBaseline, parseScanOutput } from './parse'
import type { ScanEngineOptions, ScanReadout, ScanSnapshot } from './types'

const NOT_CONNECTED =
  'not connected to a router - connect this machine entry, then scan again'

/**
 * A scan the router could not complete is reported as a failure and never as
 * an empty table. "This router has no policy rules" is the one sentence this
 * feature must never say wrongly: it is the exact opposite of the answer a
 * person opened the page to get.
 */
const UNREADABLE =
  'the router could not read its own ip rule table, so this scan was discarded rather than reported as a router with no rules'

const TRUNCATED =
  'the scan reply exceeded the command output limit, so it was discarded rather than reported as a partial rule table'

const NO_BASELINE =
  'the rule table came back without the local/main/default rules every Linux router carries, so this scan was discarded rather than reported as a router with no rules'

/**
 * Whether the rule dump is a rule table at all, asked of the body rather than
 * of the sentinel.
 *
 * `===SCANOK===` only says the router's `ip -4 rule show` exited zero into the
 * temporary file; it cannot say that what came back down the wire is what went
 * into it. A reply whose `===RULES===` body reads back as nothing - a section
 * eaten between the router and here, an `ip` that printed its table somewhere
 * this side never saw - would sail past the sentinel and be published as a
 * router with no policy rules, which is the single sentence this feature must
 * never say wrongly. Every Linux router alive carries `from all lookup
 * local/main/default`, so a dump holding none of those three is a read that
 * went wrong however clean it looks.
 *
 * A dump cut at the router's own cap is exempt, and has to be: the baseline
 * sits at preferences 32766 and 32767, so on a router with five hundred rules
 * below it the kernel's own three are exactly what `head` left behind. That
 * reply is reported as the truncated table it is, and refusing it here would
 * blind the monitor on the busiest routers it exists for.
 */
export function scanRulesLookWhole(readout: ScanReadout): boolean {
  if (readout.rulesTruncated) return true
  return readout.rules.some(isKernelBaseline)
}

/** Nothing scanned yet, which is not the same statement as a failed scan. */
export function emptyScanSnapshot(): ScanSnapshot {
  return {
    t: 0,
    ok: true,
    lastError: '',
    rows: [],
    summary: {
      total: 0,
      byOwner: {},
      foreign: 0,
      unreachable: 0,
      selectors: 0,
      // Nothing has been read, so nothing has been cut. The cap still travels,
      // because a surface bound to it should not have to render a blank the
      // one time the stream arrives before the first scan lands.
      rulesTruncated: false,
      rulesCap: SCAN_MAX_RULES
    }
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
   * Bumped by every reset and by dispose. A scan takes seconds over SSH, and a
   * host change arriving in that window used to let the reply land anyway -
   * rows classified against the previous router's records, published onto the
   * `monitor` stream as though they described the one now connected.
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
    if (this.disposed) return { ok: false, error: ENGINE_STOPPED }
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
    // No Monitor surface open, no command. See the file header.
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
   * rather than opening a second SSH command against the same router - and,
   * more to the point, rather than racing it to publish a snapshot.
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

  /** Returns the failure sentence, or an empty string when the pass landed. */
  private async run(): Promise<string> {
    const ctx = this.options.ctx
    const generation = this.generation
    let result
    try {
      result = await ctx.exec('sh -s', { stdin: SCAN_COMMAND, timeoutMs: SCAN_TIMEOUT_MS })
    } catch (error) {
      // The executor's own message, not the router's output: a timeout or a
      // dropped connection is worth reporting, and a rule table is not.
      const detail = error instanceof Error ? error.message : String(error)
      return this.fail(generation, `the binding scan did not complete (${detail.slice(0, 120)})`)
    }
    if (!this.current(generation)) return ENGINE_STOPPED
    if (result.code === 125 || result.stderr.includes('[overflow]')) {
      return this.fail(generation, TRUNCATED)
    }

    const readout = parseScanOutput(result.stdout)
    if (!readout.ok) return this.fail(generation, UNREADABLE)
    if (!scanRulesLookWhole(readout)) return this.fail(generation, NO_BASELINE)

    const { rows, summary } = classifyScan({
      readout,
      rules: this.options.rules(),
      model: this.options.latestModel(),
      direct: this.options.direct(),
      instances: this.options.instances(),
      assignments: this.options.assignments(),
      capabilities: this.options.capabilities()
    })
    if (!this.current(generation)) return ENGINE_STOPPED
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
