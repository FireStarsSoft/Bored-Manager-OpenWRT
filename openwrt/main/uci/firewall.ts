/**
 * The one firewall zone this module owns, and how to prove it took effect.
 *
 * A PPPoE pool that dials successfully and carries no client traffic looks
 * identical to a healthy one from the interface list, so the plan is always
 * followed by a check against `nft` rather than against UCI's exit code. The
 * zone, its masquerading and the single LAN forwarding are one object: they are
 * built together, applied together, and rebuilt from the records rather than
 * appended to, so a batch that disappears cannot leave a fragment behind.
 */
import { uciQuote } from '../parse'
import {
  assertUciName,
  assertZoneValue,
  checkedSections,
  chunkValues,
  effectivePppoeChunkSize,
  execTimeout,
  isPppoePrefix
} from './names'
import {
  UciCancelledError,
  commandFailure,
  reloadFirewall,
  runUciBatch,
  type ApplyChunkOptions,
  type ExecContext
} from './batch'
import type { FirewallMode } from './pppoe-plan'

export interface FirewallPlanOptions {
  zoneName: string
  prefix: string
  /** All managed prefixes that must remain in the shared wildcard zone. */
  prefixes?: readonly string[]
  mode: FirewallMode
  networkSections: readonly string[]
  chunkSize: number
  lanZone?: string
}

/**
 * The one forwarding this module owns, named rather than anonymous so it can be
 * rewritten and removed. See the comment on the `set` that builds it.
 */
export const POOL_FORWARDING_SECTION = 'bmfwd'

export interface FirewallPlan {
  zoneName: string
  prefix: string
  mode: FirewallMode
  /** The zone LAN clients sit in, with the `lan` fallback already applied. */
  lanZone: string
  setupLines: string[]
  membershipChunks: string[][]
}

export interface FirewallApplyResult {
  ok: boolean
  matches: number
  warning?: string
}

export interface ApplyFirewallOptions extends ApplyChunkOptions {
  /**
   * Whether to check that the reload produced nft rules for this prefix.
   *
   * That check is only meaningful once the pooled interfaces exist. In
   * `wildcard` mode the zone claims them with a `pppoe-<prefix>+` device glob,
   * which matches nothing at all before the first one is created, so the
   * preparation pass that runs ahead of the chunks asks for no verification -
   * it would report every healthy create as a broken one.
   */
  verify?: boolean
}

export function buildFirewallPlan(options: FirewallPlanOptions): FirewallPlan {
  assertUciName(options.zoneName, 'firewall zone')
  if (!isPppoePrefix(options.prefix)) throw new Error('PPPoE prefix is invalid')
  const prefixes = [...new Set(options.prefixes ?? [options.prefix])]
  if (prefixes.some((prefix) => !isPppoePrefix(prefix))) throw new Error('PPPoE prefix is invalid')
  const lanZone = options.lanZone || 'lan'
  assertZoneValue(lanZone, 'LAN firewall zone')
  const networks = checkedSections(options.networkSections)
  const setupLines = [
    `set firewall.${options.zoneName}=zone`,
    `set firewall.${options.zoneName}.name=${uciQuote(options.zoneName)}`,
    `set firewall.${options.zoneName}.input=${uciQuote('REJECT')}`,
    `set firewall.${options.zoneName}.output=${uciQuote('ACCEPT')}`,
    `set firewall.${options.zoneName}.forward=${uciQuote('REJECT')}`,
    `set firewall.${options.zoneName}.masq=${uciQuote('1')}`,
    `set firewall.${options.zoneName}.mtu_fix=${uciQuote('1')}`,
    `delete firewall.${options.zoneName}.device`,
    `delete firewall.${options.zoneName}.network`,
    // One named forwarding for the whole module, not one per batch. A
    // forwarding is a relation between two zones - "LAN may reach the managed
    // WAN pool" - and every batch lands in the same destination zone, so a
    // second one with the same src/dest pair would only add a duplicate nft
    // rule. Naming it per batch would also leave one behind for every batch
    // ever deleted, since nothing else knows they existed.
    `set firewall.${POOL_FORWARDING_SECTION}=forwarding`,
    `set firewall.${POOL_FORWARDING_SECTION}.src=${uciQuote(lanZone)}`,
    `set firewall.${POOL_FORWARDING_SECTION}.dest=${uciQuote(options.zoneName)}`
  ]
  if (options.mode === 'wildcard') {
    for (const prefix of prefixes) {
      setupLines.push(`add_list firewall.${options.zoneName}.device=${uciQuote(`pppoe-${prefix}+`)}`)
    }
  }
  const membershipChunks =
    options.mode === 'networks'
      ? chunkValues(networks, effectivePppoeChunkSize(networks.length, options.chunkSize)).map((chunk) =>
          chunk.map((section) => `add_list firewall.${options.zoneName}.network=${uciQuote(section)}`)
        )
      : []
  return {
    zoneName: options.zoneName,
    prefix: options.prefix,
    mode: options.mode,
    lanZone,
    setupLines,
    membershipChunks
  }
}

/**
 * Take the shared zone and its LAN forwarding back off the router.
 *
 * The zone exists to carry this module's sessions. Deleting the last batch used
 * to rebuild it anyway - empty, still masquerading, still forwarded to from the
 * LAN, and in wildcard mode still claiming `pppoe-<prefix>+` for a prefix
 * nothing uses any more - so a router this module had finished with kept a zone
 * only this module understood.
 *
 * The forwarding goes first: it names the zone as its `dest`, and fw4 refuses
 * to load a forwarding whose destination zone does not exist. Each half is only
 * named if the router actually has it, because `uci delete` on a section that
 * is not there prints `uci: Entry not found` and fails the whole batch.
 */
export function buildZoneTeardownLines(options: {
  zoneName: string
  zonePresent: boolean
  forwardingPresent: boolean
}): string[] {
  assertUciName(options.zoneName, 'firewall zone')
  const lines: string[] = []
  if (options.forwardingPresent) lines.push(`delete firewall.${POOL_FORWARDING_SECTION}`)
  if (options.zonePresent) lines.push(`delete firewall.${options.zoneName}`)
  return lines
}

export interface FirewallVerification {
  /** Rules in the LAN zone's own forward chain that reach the pool zone. */
  forwarding: number
  /** Rules anywhere in the ruleset naming a device of this pool. */
  devices: number
}

/**
 * What the ruleset says about the two things the plan promised: that the pool's
 * devices are in a zone at all, and that the LAN may reach that zone.
 *
 * The second question is the one this check exists for and the one it could not
 * previously ask. `nft list ruleset | grep -c pppoe-<prefix>` matches the zone's
 * own device glob whether or not any client can reach it - and the failure the
 * check was written to catch, a LAN zone discovered wrongly or assumed to be
 * `lan` on a router that calls it something else, produces exactly that: a
 * zone full of healthy sessions and a forwarding whose `src` names a zone fw4
 * has never heard of, which fw4 drops. Every session dialed, and not one
 * client packet crossed.
 *
 * fw4 gives each zone a `forward_<zone>` chain and jumps from it into the
 * destination zone's accept chain, so a rule inside `forward_<lan>` that names
 * the pool zone is the loaded forwarding. One `nft list ruleset` answers both
 * questions; awk keeps the two counts apart.
 */
export async function verifyFirewall(
  ctx: ExecContext,
  target: { prefix: string; zoneName: string; lanZone: string },
  timeoutMs: number
): Promise<FirewallVerification> {
  if (!isPppoePrefix(target.prefix)) throw new Error('PPPoE prefix is invalid')
  assertUciName(target.zoneName, 'firewall zone')
  assertZoneValue(target.lanZone, 'LAN firewall zone')
  const program = [
    'index($0, S) { inside = 1; next }',
    'inside && index($0, "}") { inside = 0; next }',
    'inside && index($0, D) { forwarding++ }',
    'index($0, P) { devices++ }',
    'END { printf "%d %d\\n", forwarding + 0, devices + 0 }'
  ].join(' ')
  const command =
    'nft list ruleset 2>/dev/null | awk ' +
    `-v S=${uciQuote(`chain forward_${target.lanZone} {`)} ` +
    `-v D=${uciQuote(target.zoneName)} ` +
    `-v P=${uciQuote(`pppoe-${target.prefix}`)} ` +
    uciQuote(program)
  const result = await ctx.exec(command, { timeoutMs: execTimeout(timeoutMs) })
  // 0 is the normal exit. 1 is still accepted because a count of nothing is a
  // legitimate answer, not a broken command - anything else means the pipeline
  // never ran, which is worth raising.
  if (result.code !== 0 && result.code !== 1) throw commandFailure('firewall verification', result)
  const [forwarding, devices] = result.stdout.trim().split(/\s+/)
  return { forwarding: count(forwarding), devices: count(devices) }
}

function count(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

export async function applyFirewallPlan(
  ctx: ExecContext,
  plan: FirewallPlan,
  options: ApplyFirewallOptions
): Promise<FirewallApplyResult> {
  const cancelled = options.cancelled ?? (() => false)
  if (cancelled()) throw new UciCancelledError()
  await runUciBatch(ctx, plan.setupLines, ['firewall'], options.timeoutMs)
  options.onMutated?.()

  let stopped = false
  for (let index = 0; index < plan.membershipChunks.length; index++) {
    if (cancelled()) {
      stopped = true
      break
    }
    await runUciBatch(ctx, plan.membershipChunks[index] ?? [], ['firewall'], options.timeoutMs)
    options.onMutated?.()
  }

  // Apply whatever was committed even if cancellation arrived between network
  // membership chunks; otherwise UCI and nft would disagree indefinitely.
  await reloadFirewall(ctx, options.timeoutMs)
  if (options.verify === false) {
    if (stopped || cancelled()) throw new UciCancelledError()
    // Nothing was measured, so `matches` carries no verdict: a caller that
    // asked not to verify is not reporting on the pool's health.
    return { ok: true, matches: 0 }
  }
  const verified = await verifyFirewall(ctx, plan, options.timeoutMs)
  if (stopped || cancelled()) throw new UciCancelledError()
  // Order matters: a ruleset that mentions the pool nowhere has no zone to
  // forward into, so saying "the LAN cannot reach it" would point the user at
  // the wrong half of a firewall that never materialized at all.
  if (verified.devices === 0) {
    const warning =
      plan.mode === 'wildcard'
        ? // `zoneMode` and `networks` are the rule key and its stored value; the
          // user is looking at a select labelled "Firewall membership mode" whose
          // options are worded differently, and this text reaches them as a job
          // item message and an event row, with no key names anywhere near it.
          `Firewall reload produced no nft rule for pppoe-${plan.prefix}; on this OpenWRT build set Firewall membership mode to the explicit UCI network list, under Module settings, Rules.`
        : `Firewall reload produced no nft rule for pppoe-${plan.prefix}; inspect the ${plan.zoneName} zone before using these sessions.`
    return { ok: false, matches: 0, warning }
  }
  if (verified.forwarding === 0) {
    return {
      ok: false,
      matches: 0,
      warning:
        `The firewall reload left no rule letting ${plan.lanZone} reach ${plan.zoneName}: ` +
        `these sessions will dial and carry no client traffic. Check that ${plan.lanZone} ` +
        'is the firewall zone this router keeps its LAN in.'
    }
  }
  return { ok: true, matches: verified.devices }
}
