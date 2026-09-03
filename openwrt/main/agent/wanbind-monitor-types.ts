/**
 * What the rule monitor answers with.
 *
 * Split from `wanbind-types.ts` because it is a different question: everything
 * there describes what this router is configured to do, and everything here
 * describes what its kernel is actually holding and what the daemon makes of
 * each rule in it. The monitor's whole vocabulary travels together, so `scan/`
 * can name a row or a table by indexing the reply rather than importing five
 * types that could drift apart.
 */
import type { WanbindWaiting } from './wanbind-types'

export type WanbindRuleOwner =
  | 'manual'
  | 'client'
  | 'catch-all'
  | 'hold'
  /** One of the three rules netifd writes per interface with its own table. */
  | 'netifd'
  | 'kernel'
  | 'foreign'

/**
 * One row of the monitor: a rule on the router, and why it is there.
 *
 * `reason` is the whole feature. Anybody can list `ip rule show`; what somebody
 * looking at a router actually needs is a sentence saying why *this* address is
 * not on the default connection, built from what the router says rather than
 * from what any surface assumes.
 */
export interface WanbindRuleRow {
  pref: number
  cidr: string
  /**
   * The destination the rule selects on, for the rules that select on one.
   *
   * Empty on every source rule, which is most of them. The LAN-local escapes
   * are the ones that carry it, and it is half their identity: two of them
   * differ in nothing else.
   */
  dst?: string
  table: number
  action: number
  selector: string
  owner: WanbindRuleOwner
  id: string
  instance: string
  reason?: string
  /**
   * How many rules this row stands for, when the daemon collapsed a run of
   * them. Absent on a row that is one rule, which is the common case.
   *
   * netifd writes three rules for every interface carrying `option ip4table`,
   * so a router dialling five hundred sessions carries fifteen hundred of them
   * and they are all the same fact. Collapsed they are five hundred rows; the
   * count is what keeps the totals honest about the other thousand.
   */
  count?: number
  /** The preferences behind a collapsed row. */
  prefs?: number[]
}

export interface WanbindTableRow {
  table: number
  wan: string
  role: 'wan' | 'catch-all' | 'hold' | 'main' | ''
  hasDefault: boolean
  device: string
  gateway: string
  /** The default route in it is an unreachable one, which is a parked address. */
  unreachable: boolean
}

export interface WanbindRulesReply {
  ok: boolean
  /**
   * False when the kernel would not answer.
   *
   * Not the same as an empty list, and the difference is the point: "this router
   * has no rules" is the single most misleading thing this monitor could say.
   */
  read: boolean
  /**
   * Rows after netifd's three-per-interface are collapsed, which is what a
   * caller pages through - and separately how many rules the kernel is
   * actually holding. Two different questions: a page that showed one as the
   * other would tell somebody their router has a third of the rules it has.
   */
  count: number
  raw?: number
  offset?: number
  capped: boolean
  /** Set when reasons were asked for and the page was too large to carry them. */
  reasonsOmitted?: boolean
  limit: number
  rules: WanbindRuleRow[]
  bands: {
    direct: { base: number; top: number }
    local?: { base: number; top: number }
    /** Rules in this daemon's own bands that this daemon did not write. */
    foreign?: number
    instances: Array<{
      id: string
      base: number
      top: number
      catchAllPref: number
      catchAllTable: number
    }>
  }
  main: { device: string; gateway: string } | null
  tables: WanbindTableRow[]
}

/** One rule and its sentence, which the list above no longer carries per row. */
export interface WanbindRuleExplainReply {
  ok: boolean
  read: boolean
  found: boolean
  rule: WanbindRuleRow | null
}

/** Who is waiting for a WAN, what they are waiting on, and how many there are. */
export interface WanbindWaitingReply {
  waiting: WanbindWaiting[]
  /** The whole answer, of which `waiting` may be one page. */
  total?: number
  counts?: { queued: number; held: number; reserved: number }
  limit?: number
  offset?: number
  capped?: boolean
}

/** What the kernel is holding against what the last pass decided it should. */
export interface WanbindVerifyReply {
  ok: boolean
  read: boolean
  checked: number
  present: number
  /**
   * `dst` is set on a rule that matches where a packet is going rather than
   * where it came from - which is what a LAN-local escape is, and the one shape
   * a source-keyed reader could not tell apart from every other one of them.
   */
  missing: Array<{
    pref: number
    cidr: string
    dst?: string
    table: number
    id: string
    source: string
  }>
  extra: Array<{ pref: number; cidr: string; dst?: string; table: number }>
  /** Why the check could not run, when it could not. */
  reason?: string
}
