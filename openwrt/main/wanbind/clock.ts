/**
 * Two clocks, and the arithmetic that keeps them apart.
 *
 * The router counts in whole seconds on its own wall clock; this side counts in
 * milliseconds on the app's. Every duration on a binding page is the difference
 * between a timestamp the router sent and a "now" - and if that now comes from
 * this machine, the number is the duration plus however far the two clocks
 * disagree. A router with no working NTP disagrees by decades, and it is the
 * router somebody is most likely to be looking at this page to fix.
 *
 * Split out of `rows.ts` on size, and it is a clean seam: nothing here knows
 * what a row is.
 */

/**
 * The router counts in whole seconds on its own wall clock; this side counts in
 * milliseconds on the app's. Every timestamp that arrives from the daemon is
 * multiplied on the way in, because passed through raw it reports every seat as
 * taken in 1970 - the same mistake `binding/router.ts` documents one folder
 * away, made once per surface until it was done in one place.
 */
export function routerMs(seconds: number): number {
  return seconds > 0 ? seconds * 1_000 : 0
}

/**
 * The router's own clock, or this machine's when it did not say.
 *
 * Every `since` and `assignedAt` here is the router's `time()`, and subtracting
 * one from `Date.now()` measures the gap between two clocks as well as the
 * duration - which on a router with no NTP reads as "bound 55 years ago".
 */
export function routerNow(info: { started?: number; uptime?: number } | null): number {
  const started = info?.started ?? 0

  return started > 0 ? routerMs(started + (info?.uptime ?? 0)) : Date.now()
}

export function durationLabel(msRaw: number): string {
  const seconds = Math.max(0, Math.floor(msRaw / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}
