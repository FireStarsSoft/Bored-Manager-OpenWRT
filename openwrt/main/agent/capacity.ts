/**
 * `bm.agent capacity`: what the router has, against what its configuration
 * needs.
 *
 * The arithmetic is on the router and stays there. This module renders one
 * reply; it does not size anything itself, and it must not - a second model on
 * this side would be a second answer, and the two would differ on the day
 * somebody most needs one of them.
 *
 * Additive, so the agent's `apiVersion` did not move for it. An agent from
 * before 2.4.0 answers "Method not found", which the manager turns into the
 * sentence naming the update rather than into a failed call.
 *
 * Everything below is optional, and that is the contract rather than
 * defensiveness: the report is built from facts a router may not answer, and a
 * fact it would not answer arrives as null. `normalize.ts` is where null
 * becomes something a page can render, and it is the only place that decides
 * what an absent fact looks like.
 */
import { AGENT_OBJECT, objectCall, type AgentCallResult, type AgentDeps } from './client'

/** The first packages release whose agent publishes `capacity`. */
export const CAPACITY_AGENT_RELEASE = '2.4.0'

/**
 * Reading the router is a dozen small files, four uci packages and up to six
 * ubus calls, and the daemons answer on a two-second timeout of their own. A
 * refresh somebody pressed is worth waiting a little longer for than a poll.
 */
const CAPACITY_TIMEOUT_MS = 20_000

export interface RawCapacityFix {
  kind?: string
  args?: Record<string, unknown>
}

export interface RawCapacityFinding {
  key?: string
  level?: string
  label?: string
  detail?: string
  fix?: RawCapacityFix | null
  values?: Record<string, unknown>
}

export interface RawCapacityTier {
  current?: string
  label?: string
  needs?: string[]
  next?: { at?: number; label?: string; changes?: string[] } | null
}

export interface RawCapacityDimension {
  sessions?: number | null
  bindings?: number | null
}

export interface RawCapacity {
  ok?: boolean
  reason?: string
  at?: number
  estimate?: boolean
  cachedAt?: number
  fresh?: boolean
  stale?: boolean

  hardware?: {
    board?: string
    arch?: string
    target?: string
    openwrt?: string
    kernel?: string
    cpus?: number | null
    cpuModel?: string
    memTotalKb?: number | null
    memAvailableKb?: number | null
    memAvailableEstimated?: boolean
    flashTotalKb?: number | null
    flashFreeKb?: number | null
    flashMount?: string
    nicCount?: number
    nicsKnown?: boolean
    load1?: number
    load5?: number
    load15?: number
  }

  software?: {
    release?: string
    packages?: { agent?: string; wanbind?: string | null; pppoe?: string | null; luci?: string | null }
    fw4?: boolean
    fw4Loaded?: boolean | null
    flowOffload?: boolean | null
    flowOffloadKernel?: boolean | null
    hwOffload?: { configured?: boolean | null; capable?: string }
    conntrackMax?: number | null
    conntrackCount?: number | null
    gcThresh1?: number | null
    gcThresh2?: number | null
    gcThresh3?: number | null
    leaseMax?: number | null
    leaseMaxDefault?: boolean
  }

  load?: {
    configured?: {
      pools?: Array<{ id?: string; prefix?: string; zone?: string; members?: number }>
      members?: number
      instances?: number
      bindings?: number
      prefsClaimed?: number
      rangedClients?: number
      zones?: Array<{ name?: string; networks?: number; devices?: number }>
    }
    live?: {
      sessionsUp?: number
      bound?: number
      leases?: number
      ipRules?: number | null
      conntrackCount?: number | null
    }
    answered?: { wanbind?: boolean; pppoe?: boolean }
    clients?: number
    instanceId?: string
  }

  needed?: {
    memKb?: number | null
    idleKb?: number | null
    reserveKb?: number | null
    conntrackFullKb?: number
    cpus?: number
    flashKb?: number
    flowOffload?: boolean
    conntrackMax?: number
    gcThresh1?: number
    gcThresh2?: number
    gcThresh3?: number
    conntrackMemCapped?: boolean
    leaseMax?: number
    prefs?: number
    pools?: number
  }

  requirements?: RawCapacityFinding[]
  issues?: RawCapacityFinding[]

  tiers?: { sessions?: RawCapacityTier; bindings?: RawCapacityTier }

  ceiling?: {
    sessions?: number | null
    bindings?: number | null
    limitedBy?: { sessions?: string; bindings?: string }
    dimensions?: Record<string, RawCapacityDimension | number | null>
    basis?: {
      kbPerSession?: number
      kbPerBinding?: number
      kbPerClient?: number
      reserveKb?: number | null
      calibrated?: boolean
      calibratedOn?: string
      arch?: string
      archMatch?: boolean
      definition?: string
    }
  }

  stability?: { level?: string; reason?: string }
  constants?: Array<{ name?: string; value?: number; unit?: string; source?: string; calibrated?: boolean }>
}

/** Ask the router. `refresh` skips the agent's own ten-second cache. */
export function agentCapacity(
  deps: AgentDeps,
  refresh = false
): Promise<AgentCallResult<RawCapacity>> {
  return objectCall<RawCapacity>(
    deps,
    AGENT_OBJECT,
    'capacity',
    { refresh },
    CAPACITY_TIMEOUT_MS
  )
}
