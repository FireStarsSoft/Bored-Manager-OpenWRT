/**
 * One instance's pool of WANs, as the fast sweep can see it.
 *
 * The only part of this folder that does not read the daemon, and the reason is
 * worth stating: `bm-wanbind` answers for its own rules rather than for the
 * router, so a WAN's live address, whether it is still dialing and how long it
 * has been up are not in any of its replies. They come off the same sample
 * every other surface in this module reads, which is what stops a line being
 * `dialing` on this page and `available` on the Overview.
 *
 * Nothing here decides who gets a WAN. `wanState` says what condition a line is
 * in and `summarizeWans` counts those conditions; which of them the daemon will
 * actually hand out is the daemon's business, and a second opinion about that
 * on this side is precisely the arrangement 3.4.0 removed.
 */
import type { IfaceState, RouterModel } from '../types'
import type { BindingWanAggregate, BindingWanSummary } from './types'

/**
 * One interface an instance may hand out, as this side reads it off the sweep.
 *
 * `table` is null when netifd is not reporting an `ip4table` for it, and that
 * is a fact about the router rather than a gap in this reading: the daemon
 * writes `option ip4table` on every WAN it prepares for a pool, so a pool WAN
 * without one is a WAN no pass has got to yet, and a client seated on it would
 * have a rule pointing at a table with nothing in it.
 */
export interface PoolWan {
  name: string
  table: number | null
  up: boolean
  pending: boolean
  /** The live address; empty while it has none. */
  ipv4: string
  uptimeSec: number
  errorCode: string
}

export function wanView(iface: IfaceState): PoolWan {
  return {
    name: iface.name,
    table: iface.ip4Table != null && iface.ip4Table > 0 ? iface.ip4Table : null,
    up: iface.up,
    pending: iface.pending,
    ipv4: iface.ipv4?.addr ?? '',
    uptimeSec: iface.uptimeSec,
    errorCode: iface.errorCode ?? ''
  }
}

/** A carrier names a device and every VLAN sub-device under it. */
export function carrierMatches(device: string, carrier: string): boolean {
  return device === carrier || device.startsWith(`${carrier}.`)
}

/**
 * The interfaces one instance's carrier covers, minus the instance's own LAN.
 *
 * Worked out here rather than asked of the daemon for one narrow reason: this
 * is the pool as the *sweep* can see it, and the sweep is where the address and
 * the uptime come from. Every count built on it is about the health of a line,
 * never about whether a section is allowed to use one.
 */
export function poolWans(
  model: RouterModel | null,
  lan: string,
  carrier: string
): PoolWan[] {
  if (!model || !carrier) return []
  const seen = new Set<string>()
  const result: PoolWan[] = []
  for (const iface of model.ifaces) {
    if (
      iface.name === lan ||
      iface.name === 'loopback' ||
      !['pppoe', 'dhcp', 'static'].includes(iface.proto) ||
      !carrierMatches(iface.device, carrier) ||
      seen.has(iface.name)
    ) {
      continue
    }
    seen.add(iface.name)
    result.push(wanView(iface))
  }
  return result
}

/** Whether this WAN could take a client right now. */
export function wanUsable(wan: PoolWan, warnUptimeSec: number): boolean {
  return (
    wan.table != null &&
    wan.up &&
    !wan.pending &&
    Boolean(wan.ipv4) &&
    !wan.errorCode &&
    wan.uptimeSec >= warnUptimeSec
  )
}

/**
 * The same question as a word instead of a boolean, because a surface has to
 * say which of the three ways a WAN is unusable this one is: still dialing,
 * broken, or up but not yet trusted with anybody.
 */
export function wanState(wan: PoolWan, warnUptimeSec: number): string {
  if (wan.pending) return 'dialing'
  if (!wan.up || wan.errorCode) return 'error'
  if (!wan.ipv4 || wan.table == null || wan.uptimeSec < warnUptimeSec) return 'warning'
  return 'available'
}

export function emptyWanSummary(): BindingWanSummary {
  return { total: 0, available: 0, bound: 0, error: 0, warning: 0, dialing: 0 }
}

/**
 * One instance's pool counted the way the tiles read it.
 *
 * A healthy WAN carrying somebody is `bound` rather than `available`, so the
 * two never double-count and `available` is the number that answers the only
 * question the tile is asked: could anybody else be seated.
 */
export function summarizeWans(
  wans: readonly PoolWan[],
  warnUptimeSec: number,
  carrying: ReadonlySet<string>
): BindingWanSummary {
  const summary = emptyWanSummary()
  summary.total = wans.length
  for (const wan of wans) {
    const state = wanState(wan, warnUptimeSec)
    if (state === 'dialing') summary.dialing += 1
    else if (state === 'error') summary.error += 1
    else if (state === 'warning') summary.warning += 1
    else if (carrying.has(wan.name)) summary.bound += 1
    else summary.available += 1
  }
  return summary
}

/**
 * Every instance's pool folded into one set of counts.
 *
 * Summed here rather than where it is drawn because a page spec can neither add
 * a column up nor divide two of them: a donut of "what is the whole pool doing"
 * and a meter of "how full is it" arrive already computed or not at all.
 */
export function aggregateWans(
  summaries: readonly BindingWanSummary[]
): BindingWanAggregate {
  const total = summaries.reduce((sum, one) => {
    sum.total += one.total
    sum.available += one.available
    sum.bound += one.bound
    sum.error += one.error
    sum.warning += one.warning
    sum.dialing += one.dialing
    return sum
  }, emptyWanSummary())
  return {
    ...total,
    // Zero rather than a division by nothing: a router with no instance has an
    // empty pool, and "0% of nothing is bound" is the true reading of that.
    boundPct: total.total > 0 ? Math.round((total.bound / total.total) * 100) : 0
  }
}
