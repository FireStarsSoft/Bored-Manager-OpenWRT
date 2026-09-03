/**
 * What the Capacity tab renders, and what the `capacity` stream carries.
 *
 * Plain JSON throughout, for the reason every payload in this module is: it
 * travels through `ctx.emit` to a renderer with no imports, so a Map or a class
 * instance would arrive as `{}`.
 *
 * The distinction the whole shape turns on is between a number the router gave
 * and a number nobody could work out. A fact the router would not answer is
 * null here and renders as "unknown"; it never becomes a zero, because a zero
 * on a ceiling reads as "this router holds nothing" and that is the one thing
 * this page must never say by accident.
 */
import type { ValueBadge } from '@shared/module-ui'

/**
 * Where the report stands.
 *
 * `unavailable` is a router that cannot answer at all - no agent, or one from
 * before the verb existed - and it is a different page from `unknown`, which is
 * a router that has simply not been asked yet.
 */
export type CapacityState = 'unknown' | 'unavailable' | 'ready'

/** The four verdicts, in the daemon's spelling. */
export type StabilityLevel = 'unknown' | 'unstable' | 'at-risk' | 'stable'

/** The five write paths a fix is allowed to take, and nothing else. */
export type CapacityFixKind =
  | 'tune_set'
  | 'wanbind_reconcile'
  | 'wanbind_settings_set'
  | 'wanbind_instance_set'
  | 'pool_reconcile'

export interface CapacityFinding {
  key: string
  /** `error` | `warning` | `info` | `pass`, as the router said it. */
  level: string
  /** `bad` | `warn` | `ok`, which is what a badge is drawn from. */
  status: string
  levelBadges: ValueBadge[]
  label: string
  detail: string
  /** Whether a row on the Fixes table carries this key. */
  fixable: boolean
}

export interface CapacityFixRow {
  key: string
  kind: CapacityFixKind
  /** The finding's label, so the row says what it is fixing. */
  label: string
  /** What pressing it does, in words, including anything it interrupts. */
  action: string
  /** Who writes it: the router's own agent, or this module over SSH. */
  writer: string
  /** The arguments, already checked against what the kind may carry. */
  args: Record<string, string | number | boolean>
}

export interface CapacityTierRow {
  id: string
  label: string
  range: string
  needs: string[]
  stateBadges: ValueBadge[]
}

export interface CapacitySnapshot {
  state: CapacityState
  /** The wall clock at the last answer, or 0. */
  at: number
  /** True once the report is older than the age a fix may be applied against. */
  stale: boolean
  /** Never false. Every number here is estimated and the page says so. */
  estimate: boolean
  /** Why there is no report, when there is none. Empty while `ready`. */
  reason: string
  /** The agent release this router has, for the sentence that names the update. */
  agentRelease: string

  summary: {
    stability: string
    reason: string
    limitedBy: string
    ceiling: string
    tierNow: string
    tierNext: string
    calibratedOn: string
    at: number
  }

  hardware: {
    board: string
    arch: string
    target: string
    cpuModel: string
    cpus: number | null
    kernel: string
    /** Bytes, because the renderer's `bytes` format wants bytes. */
    memTotal: number | null
    memAvailable: number | null
    flashTotal: number | null
    flashFree: number | null
    nicCount: number | null
    load1: number
    load5: number
    load15: number
  }

  software: {
    release: string
    agent: string
    wanbind: string
    pppoe: string
    fw4: string
    fw4Loaded: string
    flowOffload: string
    hwOffload: string
    conntrackMax: number | null
    conntrackCount: number | null
    conntrackPct: number | null
    gcThresh3: number | null
    ipRules: number | null
    leaseMax: number | null
  }

  load: {
    sessions: number
    bindings: number
    instances: number
    pools: number
    clients: number
    sessionsUp: number
    bound: number
    leases: number
    wanbind: string
    pppoe: string
  }

  needed: {
    mem: number | null
    cpus: number | null
    flash: number | null
    flowOffload: string
    conntrackMax: number | null
    gcThresh3: number | null
    leaseMax: number | null
    pools: number | null
    prefs: number | null
  }

  ceiling: {
    sessions: number | null
    bindings: number | null
    limitedBy: string
    /** 0-100, for the two meters. Null where there is no ceiling to be part of. */
    sessionsPct: number | null
    bindingsPct: number | null
    sentence: string
    basis: string
  }

  tier: {
    current: string
    currentLabel: string
    nextAt: number | null
    nextChanges: string[]
    rows: CapacityTierRow[]
  }

  stability: {
    level: StabilityLevel
    label: string
    reason: string
    /** True while the verdict is one somebody should look at now. */
    attention: boolean
  }

  requirements: CapacityFinding[]
  issues: CapacityFinding[]
  fixes: CapacityFixRow[]
  fixCount: number
}
