/**
 * What this router can do, when to ask again, and what to tell a user whose
 * router cannot do it yet.
 *
 * One latch holds the last verdict and the two keys that stop the module from
 * asking for it over and over: `applied` is the poller layout that is currently
 * in force, `probing` is the one a probe is in flight for. Everything that
 * reads the verdict rather than the router lives here too - the readiness
 * poller's own gate, and the two sentences (`installHint`, `unprobed`) that
 * every create form shows when a package is missing.
 */
import { failedCheck, type ModuleCheckReport } from '@shared/check'
import type { ModuleContext, ModulePoller } from '@shared/modules'
import {
  APK_REQUIRED,
  emptyCapabilities,
  probeOpenWrt,
  type OpenWrtCapabilities
} from '../probe'
import type { FastSweep } from '../service'

export const INTERVAL_KEY = 'openwrt'

/**
 * How often the readiness view re-checks a router that is not ready yet. Only
 * ticks while a surface is actually showing `capabilities`, so a router nobody
 * is looking at is never asked.
 */
const READINESS_INTERVAL_MS = 30_000

export interface CapabilityLatch {
  ctx: ModuleContext
  service: FastSweep
  capabilities: OpenWrtCapabilities
  flight: Promise<OpenWrtCapabilities> | null
  generation: number
  stopped: boolean
  /** The `connected|fast|slow` layout the collector pollers are running for. */
  applied: string | null
  /** The layout a probe is in flight for, so two never race for the same one. */
  probing: string | null
  /**
   * Whether the fast sweep has anything to be fast for. Supplied by the wiring,
   * which is the only place that can see both automations and the open surfaces
   * at once; see `fastIntervalFor` for what it decides.
   */
  fastWanted: () => boolean
  /**
   * The interval the fast poller is currently running at, or null while it is
   * stopped. Held so a tab switch can re-time it without going back through the
   * probe the layout key guards.
   */
  fastAppliedMs: number | null
  readinessOn: boolean
  poller: ModulePoller
}

export function createCapabilityLatch(
  ctx: ModuleContext,
  service: FastSweep,
  fastWanted: () => boolean = () => true
): CapabilityLatch {
  const latch: CapabilityLatch = {
    ctx,
    service,
    capabilities: emptyCapabilities(),
    flight: null,
    generation: 0,
    stopped: false,
    applied: null,
    probing: null,
    fastWanted,
    fastAppliedMs: null,
    readinessOn: false,
    poller: ctx.createPoller('openwrt:readiness', async () => {
      // The one gate that keeps this cheap: no readiness surface open, no probe.
      if (!ctx.connected || !ctx.streamActive('capabilities')) return
      await refreshCapabilities(latch)
    })
  }
  return latch
}

/** A verdict that stops the collector from running at all. */
function isBlocked(caps: OpenWrtCapabilities): boolean {
  return caps.problem !== null
}

/**
 * Whether asking again on a timer could plausibly change the answer. A router
 * that is missing a package, or that never answered at all, can become ready
 * while the page is open. A machine that answered and is simply not a router
 * never will, and re-probing it would be the hammering the poller latch was
 * built to stop.
 */
function worthWatching(caps: OpenWrtCapabilities): boolean {
  if (!caps.probed) return true
  if (!caps.isOpenwrt) return false
  return caps.problem !== null || caps.setupNeeded
}

export function applyReadinessPoller(
  latch: CapabilityLatch,
  caps: OpenWrtCapabilities
): void {
  const wanted = !latch.stopped && latch.ctx.connected && worthWatching(caps)
  if (wanted === latch.readinessOn) return
  latch.readinessOn = wanted
  if (wanted) latch.poller.start(READINESS_INTERVAL_MS)
  else latch.poller.stop()
}

export function stopReadinessPoller(latch: CapabilityLatch): void {
  if (!latch.readinessOn) return
  latch.readinessOn = false
  latch.poller.stop()
}

export function refreshCapabilities(latch: CapabilityLatch): Promise<OpenWrtCapabilities> {
  // A probe is a command, and a module the host has stopped may not send one.
  // `stopped` was only read after the probe came back, so a readiness tick
  // already queued when `dispose()` ran - and either explicit re-check reached
  // through a handler the host has not dropped yet - still put a PROBE_COMMAND
  // on the wire to a machine nothing is managing any more. The last verdict is
  // handed back instead; nobody is left to be told a new one.
  if (latch.stopped) return Promise.resolve(latch.capabilities)
  if (latch.flight) return latch.flight
  const ctx = latch.ctx
  const generation = latch.generation
  const pending = probeOpenWrt(ctx)
    .then((next) => {
      if (latch.stopped || generation !== latch.generation) return next
      const wasBlocked = isBlocked(latch.capabilities)
      latch.capabilities = next
      ctx.emit('capabilities', next)
      applyReadinessPoller(latch, next)
      if (next.problem) ctx.log(`openwrt: ${next.problem}`)
      else if (wasBlocked) {
        // The router became usable without the connection changing - a
        // package finished installing, fw4 came back, the firmware finished
        // booting. `applied` holds the blocked verdict, so nothing would
        // have started the collector until the next reconnect or a manual
        // Check; the module simply sat there on a router that was ready.
        latch.applied = null
        latch.probing = null
        startPollers(latch, next)
      }
      return next
    })
    .finally(() => {
      if (latch.flight === pending) latch.flight = null
    })
  latch.flight = pending
  return pending
}

/**
 * How often the fast collector should actually run.
 *
 * A router with no PPPoE batch and no binding instance has nothing to
 * reconcile, so the sweep is only feeding a dashboard - and on a router nobody
 * has open it is feeding nothing at all, thirty times a minute, over SSH, for
 * every pooled machine the app is connected to. With either automation present
 * the rate never moves: reconcile genuinely needs every tick, and a bound
 * client left stranded on a WAN that just died costs far more than the sweeps.
 *
 * The fall-back is the slow cadence rather than a number of its own, so the two
 * intervals a user can actually set are still the only two that exist.
 */
function fastIntervalFor(latch: CapabilityLatch, fastMs: number, slowSec: number): number {
  // Fast polling paused, or no slow cadence configured to fall back to.
  if (fastMs === 0 || slowSec === 0) return fastMs
  return latch.fastWanted() ? fastMs : Math.max(fastMs, slowSec * 1_000)
}

/**
 * Re-time a fast poller that is already running. The layout key deliberately
 * does not carry the idle state: a tab switch changes the cadence, and putting
 * it in the key would send every one of them back through a PROBE_COMMAND.
 */
function retimeFast(latch: CapabilityLatch, wantedMs: number): void {
  if (latch.fastAppliedMs === null || latch.fastAppliedMs === wantedMs) return
  latch.fastAppliedMs = wantedMs
  latch.service.fastPoller.stop()
  if (wantedMs > 0) latch.service.fastPoller.start(wantedMs)
}

/**
 * `known` is a probe result the caller has just awaited. Without it every
 * explicit re-check paid for a second identical PROBE_COMMAND over SSH,
 * because refreshCapabilities() had already settled by the time this ran.
 */
export function startPollers(latch: CapabilityLatch, known?: OpenWrtCapabilities): void {
  const { ctx, service } = latch
  const fastMs = Math.max(0, ctx.fastIntervalMs(INTERVAL_KEY))
  const slowSec = Math.max(0, ctx.slowIntervalSec(INTERVAL_KEY))
  const key = `${ctx.connected}|${fastMs}|${slowSec}`
  if (key === latch.applied) {
    retimeFast(latch, fastIntervalFor(latch, fastMs, slowSec))
    return
  }
  service.fastPoller.stop()
  service.slowPoller.stop()
  latch.fastAppliedMs = null
  if (!ctx.connected) {
    latch.applied = key
    latch.probing = null
    stopReadinessPoller(latch)
    return
  }
  if (latch.probing === key) return
  latch.probing = key
  void (known ? Promise.resolve(known) : refreshCapabilities(latch)).then(
    (available) => {
      if (latch.stopped || latch.probing !== key || !ctx.connected) return
      if (available.problem) {
        // Record the key for a verdict the router actually gave us: there is
        // nothing to poll until the connection or the intervals change, and
        // leaving it unset re-ran the probe over SSH on every applyPollers()
        // - every connect, settings change, tab switch and module toggle -
        // for each pooled machine that is not a router. A probe that threw
        // or came back empty stays retryable. Explicit re-checks (sweepNow,
        // refreshSlow) call refreshCapabilities() directly, and reset()
        // clears the key.
        if (available.probed) latch.applied = key
        latch.probing = null
        return
      }
      latch.applied = key
      latch.probing = null
      if (fastMs > 0) {
        // Re-asked here rather than reused from above: the probe took a round
        // trip, and the tab it was started for may already be gone.
        latch.fastAppliedMs = fastIntervalFor(latch, fastMs, slowSec)
        service.fastPoller.start(latch.fastAppliedMs)
      }
      if (slowSec > 0) service.slowPoller.start(slowSec * 1_000)
      else if (Object.keys(service.uciTables).length === 0) void service.runSlow()
    },
    () => {
      if (latch.probing === key) latch.probing = null
    }
  )
}

export function resetLatch(latch: CapabilityLatch): void {
  latch.applied = null
  latch.probing = null
  latch.fastAppliedMs = null
  latch.generation += 1
  latch.flight = null
  latch.capabilities = emptyCapabilities()
  stopReadinessPoller(latch)
}

export function disposeLatch(latch: CapabilityLatch): void {
  latch.stopped = true
  latch.fastAppliedMs = null
  latch.generation += 1
  latch.flight = null
  stopReadinessPoller(latch)
}

/**
 * Where to send a user whose router is missing something. The module can now
 * install most of it, so pointing at a shell is only right when it cannot -
 * and then which reason it is decides what the user should do next.
 * `setupNeeded` folds four conditions into one boolean, so a single fallback
 * sentence sent a non-root login, a router with no package manager and a
 * router nobody had probed yet all off to the same shell.
 */
export function installHint(caps: OpenWrtCapabilities, what: string): string {
  if (caps.setupNeeded) {
    return `Open Module settings and use "Install missing packages" - this module installs ${what} for you with the package manager this release ships.`
  }
  if (!caps.probed) {
    return 'Open Module settings and run Check again first, so this page can see what the router actually has.'
  }
  if (caps.problem) {
    return `Something more basic is in the way first: ${caps.problem} Router readiness, in Module settings, has the rest.`
  }
  if (!caps.pkgManager) {
    // Reached only if the gate above ever stops treating a missing apk database
    // as a blocking problem; the sentence is shared with the checklist card and
    // the install form either way.
    return `${APK_REQUIRED} Until that is sorted out, ${what} has to go on at a router shell.`
  }
  if (!caps.isRoot) {
    return `Installing ${what} needs root. Connect this machine entry as root and Module settings can install it for you.`
  }
  // Probed, healthy, root, with a package manager - so the checklist believes
  // nothing is missing while the gate above says otherwise. That is a stale
  // snapshot rather than a router problem, and re-probing is what fixes it.
  return `Module settings does not currently list ${what} as missing. Run Check again there to re-read the router.`
}

/**
 * Nothing has been read off this router yet, so every capability below is
 * false by default rather than by observation. Without this the create forms
 * assert that a perfectly healthy router is missing PPPoE, and then hand out
 * install instructions for it.
 */
export function unprobed(caps: OpenWrtCapabilities): ModuleCheckReport | null {
  return caps.probed
    ? null
    : failedCheck(
        'The router has not been checked yet',
        'Open Module settings and run Check again first, so this page knows what is actually missing.'
      )
}
