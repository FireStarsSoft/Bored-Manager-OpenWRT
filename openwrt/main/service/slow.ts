/**
 * The slow probe: the three things the fast sweep cannot afford to ask for
 * every tick, plus the history point they anchor.
 *
 * `logread` explains why a session is down when the interface dump only says
 * that it is, `uci show network` maps sections to routing tables and usernames,
 * and `uci show firewall` says which zone LAN clients actually sit in. All
 * three are read-only, and all three keep their last good answer: a single
 * empty tick is a hiccup in the pipe, not a router that lost its firewall.
 */
import { splitSections } from '@shared/shell'
import {
  parseFirewallZones,
  parsePppoeLogErrors,
  parseUciIp4Tables,
  parseUciPppoeUsers,
  pickLanZone
} from '../parse'
import type { OpenWrtSlowSample } from '../types'
import { EXEC_TIMEOUT_MS, SLOW_COMMAND } from './command'
import { noteError, reportHealth } from './health'
import { isCurrent, type SweepRuntime } from './runtime'

/**
 * The router's own LAN firewall zone, or `''` before the first slow sweep has
 * read one. Callers fall back to `lan` themselves; this deliberately does not,
 * so "not discovered yet" stays distinguishable from "discovered, called lan".
 */
export function lanZone(runtime: SweepRuntime): string {
  return pickLanZone(runtime.firewallZones)
}

export async function sampleSlow(runtime: SweepRuntime, generation: number): Promise<void> {
  if (!isCurrent(runtime, generation)) return
  let result
  try {
    result = await runtime.ctx.exec(SLOW_COMMAND, { timeoutMs: EXEC_TIMEOUT_MS })
  } catch (error) {
    if (isCurrent(runtime, generation) && !runtime.slowFailed) {
      runtime.slowFailed = true
      const message = `slow probe failed (${error instanceof Error ? error.message : String(error)})`
      runtime.ctx.log(`openwrt: ${message}`)
      noteError(runtime, message)
      reportHealth(runtime)
    }
    return
  }
  if (!isCurrent(runtime, generation)) return
  if (result.code !== 0 && !result.stdout.trim()) {
    if (!runtime.slowFailed) {
      runtime.slowFailed = true
      runtime.ctx.log(
        `openwrt: slow probe returned no data (${(result.stderr || `exit ${result.code}`).trim().slice(0, 200)})`
      )
      noteError(runtime, `slow probe returned no data (exit ${result.code})`)
      reportHealth(runtime)
    }
    return
  }
  runtime.slowFailed = false
  const sections = splitSections(result.stdout)
  const log = sections.get('LOG') ?? ''
  runtime.pppoeErrors = parsePppoeLogErrors(log)
  // Fail closed. Without the sentinel a missing section reads as a router whose
  // WANs have no `option ip4table` at all, and the routing-table audit acts on
  // that: it loses the check that protects a WAN pointing at a table this
  // module does not own, and offers every managed WAN for repair. Keep the last
  // good answer, exactly as the firewall zones below do, and say the map is not
  // fit to reconcile against.
  const uciOk = (sections.get('UCIOK') ?? '').trim() === '1'
  if (uciOk) {
    const uci = sections.get('UCIMAP') ?? ''
    runtime.uciTables = parseUciIp4Tables(uci)
    runtime.pppoeUsers = parseUciPppoeUsers(uci)
  } else {
    runtime.ctx.log('openwrt: uci show network failed; keeping the last WAN table map')
  }
  const zones = parseFirewallZones(sections.get('FWZONES') ?? '')
  // A router with no firewall zones at all is not a thing; an empty section
  // means the grep or `uci` came back empty on this one tick. Keeping the
  // last good answer stops a single hiccup from silently moving the pool's
  // forwarding back to the assumed `lan`.
  if (zones.length > 0) runtime.firewallZones = zones
  const sample: OpenWrtSlowSample = {
    t: Date.now(),
    log,
    pppoeErrors: { ...runtime.pppoeErrors },
    pppoeUsers: { ...runtime.pppoeUsers },
    uciTables: { ...runtime.uciTables },
    uciTablesOk: uciOk,
    model: runtime.latest
  }
  runtime.slowAt = sample.t
  try {
    await runtime.hooks.onSlowSample?.(sample)
  } catch (error) {
    if (isCurrent(runtime, generation)) {
      const message = `slow self-heal failed (${error instanceof Error ? error.message : String(error)})`
      runtime.ctx.log(`openwrt: ${message}`)
      noteError(runtime, message)
    }
  }
  if (!isCurrent(runtime, generation)) return
  const overview = runtime.overview
  if (overview && overview.t !== runtime.historyModelAt) {
    runtime.historyModelAt = overview.t
    runtime.ctx.addHistory({
      t: sample.t,
      wanUp: overview.counts.wanUp,
      wanErr: overview.counts.wanErr,
      devices: overview.counts.devices,
      // Kept next to the device count on purpose: "40 devices" says nothing on
      // its own, and reading it against how many of them held a WAN is the
      // only way to see a pool that ran out overnight.
      bound: overview.counts.bound,
      waiting: overview.counts.waiting,
      rx: overview.poolAgg.rx,
      tx: overview.poolAgg.tx,
      // Persisted alongside the traffic so the history charts can show a
      // router that ran out of memory next to the throughput that stopped.
      load1: overview.sys.load1,
      memPct: overview.sys.memPct
    })
  }
}
