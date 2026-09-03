/**
 * The shapes `bm.wanbind` answers with, and the ones it is asked in.
 *
 * A file of nothing but types, which is unusual here and is the point: from
 * packages 2.4.0 this contract *is* WAN Binding. The module keeps no record of
 * an instance or a binding, plans no rule and writes nothing to the router - it
 * asks, it shows, and it sends changes back. Everything the pages render comes
 * through here, so an interface that quietly disagreed with the daemon would be
 * a surface reporting confidently on a router it has misread.
 *
 * Two conventions run through all of it, and both are the daemon's rather than
 * this side's:
 *
 * **Field names are the daemon's own spelling.** The arguments are snake_case
 * because ubus type-checks a call against the template the daemon published, and
 * a key spelled the other way is not a weaker call - it is no call at all. The
 * replies are camelCase because that is what the daemon's ucode builds. Two
 * spellings in one file is uglier than one and is the truth.
 *
 * **An absent argument means "keep what the section has".** Every mutating verb
 * is create-and-edit in one, so an edit that says only which WAN an address
 * leaves by must not also be read as saying it has no name, sits behind no LAN
 * and holds when its WAN goes down. The wrappers in `wanbind.ts` therefore omit
 * a field rather than sending it empty, and there is deliberately no spelling
 * for "clear it" - a field is emptied at a router shell with `uci delete`.
 */

/**
 * The contract generation this module drives.
 *
 * 1 is packages 2.0.0 to 2.3.0: the daemon owned binding *instances* and the
 * module still wrote one-to-one bindings itself. 2 is 2.4.0, where it owns both
 * and this module writes no rule at all. The two cannot be mixed - see
 * `requirements.ts` for the sentence a router on the older contract gets.
 */
export const WANBIND_API = 2

/**
 * The main section: what an instance gets when it does not name its own.
 *
 * Every one of these is a default for instances created *afterwards*. A section
 * already on the router keeps the numbers it was stamped with, because those are
 * what the rules standing in the kernel were written against, and re-deriving
 * them would make the next pass fail to recognise its own work and write a
 * second copy of everything.
 */
export interface WanbindSettings {
  /** The instance half's switch. Bindings are reconciled either way. */
  enabled: boolean
  /** Seconds between full passes. */
  interval: number
  direct_pref_base: number
  rule_pref_base: number
  catch_all_pref_base: number
  catch_all_table: number
  wan_table_base: number
  wan_warn_uptime: number
  wan_error_grace: number
  release_grace: number
  /**
   * Whether a bound address may still reach the networks this router serves.
   *
   * A one-to-one binding sends everything from an address to its WAN's routing
   * table, and that table knows only how to leave the building - so with this
   * off a bound machine has the internet and not the printer on the next desk,
   * and the packet for the printer leaves by the WAN port addressed to a
   * private network that drops it. On by default.
   */
  lan_local: boolean
  /** Where those rules sit: sixty-four priorities from here, one per LAN. */
  local_pref_base: number
}

/** Whether the one-to-one priority band is safe to allocate from, and why not. */
export interface WanbindBand {
  base: number
  span: number
  top: number
  reason: string | null
  usable: boolean
}

export type WanbindFindingLevel = 'error' | 'warning' | 'info' | 'pass'

export interface WanbindFinding {
  level: WanbindFindingLevel
  label: string
  detail?: string
}

/**
 * One `config instance` as the daemon reads it, refused ones included.
 *
 * A refused section is in this list on purpose. An instance that has simply
 * disappeared from every list is the hardest kind of mistake to find: nothing is
 * broken, nothing is red, and the row that should be there is not.
 */
export interface WanbindInstanceConfig {
  id: string
  name: string
  enabled: boolean
  usable: boolean
  reason: string | null
  lan: string
  carrier: string
  sticky: boolean
  remap: boolean
  /** Empty means the whole LAN. Both are set together or not at all. */
  rangeFrom: string
  rangeTo: string
  /** 1 = a WAN each, N = that many share one, 0 = no limit. */
  clientsPerWan: number
  slot: number
  rulePrefBase: number
  catchAllPref: number
  catchAllTable: number
  wanWarnUptime: number
  wanErrorGrace: number
  releaseGrace: number
}

/** And what the running daemon has made of it. */
export interface WanbindInstanceState {
  id: string
  ready: boolean
  lanCidr: string | null
  /** Clients seated, which above one per WAN is not the number of WANs taken. */
  bound: number
  /** WANs carrying at least one client. */
  carrying: number
  /** What the pool could seat in total; -1 when there is no limit. */
  seats: number
  clientsPerWan: number
  range: { from: string; to: string } | null
  /** The address blocks this instance fences, which is its catch-all. */
  cidrs: string[]
  waiting: number
  held: number
  free: number
  devices: number
  lastPassAt: number
  lastPassMs: number
  reason: string
}

/** How many rules the kernel took, and how many it was not holding afterwards. */
export interface WanbindNetlinkCounters {
  written: number
  verified: number
  unverified: number
  removed: number
  lastUnverified: Array<{ pref: number; cidr: string; table: number }>
}

export interface WanbindInfo {
  name: string
  release: string
  apiVersion: number
  /**
   * The instance half's switch, and nothing else.
   *
   * Hand-placed bindings are reconciled either way, which is what
   * `bindingsMaintained` says out loud. A surface reading this one field as
   * "the daemon is doing nothing" would report a router keeping every binding
   * in force as a stopped daemon.
   */
  enabled: boolean
  bindingsMaintained: boolean
  interval: number
  uptime: number
  settings: WanbindSettings
  instances: WanbindInstanceState[]
  configured: WanbindInstanceConfig[]
  core: {
    ready: boolean
    reason: string
    bindings: number
    bound: number
    held: number
    fallback: number
    stranded: number
    shadowed: number
    waiting: number
    disabled: number
    refused: number
  }
  netlink: WanbindNetlinkCounters
}

export interface WanbindStats {
  rssKb: number
  uptime: number
  eventsHandled: number
  assigned: number
  released: number
  queueDepth: number
  lastPassMs: number
  netlink: WanbindNetlinkCounters
}

export interface WanbindAssignment {
  instance: string
  mac: string
  ip: string
  host: string
  wan: string
  pref: number
  table: number
  assignedAt: number
  /** False when the kernel is not holding the rule this row describes. */
  verified: boolean
}

export interface WanbindWaiting {
  instance: string
  mac: string
  ip: string
  host: string
  order: number
  since: number
  held: boolean
  /**
   * Why, as a code rather than as the sentence beside it.
   *
   * `exhausted` is the one that is not about the queue - the instance has run
   * out of ip rule priorities, so no WAN coming free will help. `reserved` is
   * the newest: a one-to-one binding already follows this address, so the
   * instance leaves it alone rather than writing a second rule for it that the
   * kernel would never reach. Branching on the sentence would break the first
   * time either side reworded it.
   */
  why: 'queued' | 'held' | 'exhausted' | 'reserved'
  reason: string
}

export type WanbindBindingState =
  | ''
  | 'bound'
  | 'held'
  | 'fallback'
  | 'stranded'
  | 'shadowed'
  | 'waiting'
  | 'disabled'
  | 'refused'

/** One binding as the router reports it. */
export interface WanbindBinding {
  id: string
  name: string
  enabled: boolean
  /** False when the daemon's own configuration reader refused the section. */
  usable: boolean
  /**
   * Who placed it. `manual` is a `config direct` section somebody wrote; an
   * instance id is a seat that instance handed out. The field exists so that no
   * reader has to infer it from a priority band.
   */
  source: string
  instance: string
  targetKind: 'ip' | 'mac' | ''
  /** The normalised address or MAC, for a sentence about it. */
  label: string
  mac: string
  host: string
  wan: string
  lan: string
  lanCidr: string
  lanZone: string
  wanZone: string
  whenDown: 'hold' | 'fallback'
  pref: number
  /** What its rule points at right now; 0 when no rule is written. */
  table: number
  /** `option table` as written in the section. */
  stampedTable: number
  /** netifd's live `ip4table` for the WAN; 0 when it has none. */
  wanTable: number
  state: WanbindBindingState
  /** What is holding this address when it is not on its WAN. */
  parkedBy: 'hold-table' | 'catch-all' | ''
  ip: string
  /** Seconds, on the router's clock. This side counts in milliseconds. */
  since: number
  /** Prose for a person. Never branched on - `state` and `usable` are that. */
  reason: string
  shadowedBy: string
  forwarding: 'ok' | 'missing' | 'wrong' | 'no-lan' | 'no-zone' | ''
  needsForwarding: boolean
  needsTable: boolean
  /** Why the router read this binding's WAN as one of its own LANs, if it did. */
  evidence: string
  /** False when the kernel is not holding the rule this row describes. */
  verified: boolean
}

export interface WanbindBindingsReply {
  bindings: WanbindBinding[]
  /**
   * Whether an id or a source was asked for.
   *
   * An empty list means two different things and nothing else in the reply
   * tells them apart: this router holds no binding, or none matched what was
   * asked. A surface that could not distinguish them states a fact about the
   * whole router while showing a view that can never contain a row.
   */
  filtered: boolean
  counts: { manual: number; derived: number; byState: Record<string, number> }
  band: WanbindBand
  instances: Array<{
    id: string
    base: number
    top: number
    catchAllPref: number
    catchAllTable: number
    scope: string[]
  }>
  maintained: boolean
}

/** One interface, as the router's own classifier weighs it up. */
export interface WanbindVerdict {
  name: string
  role: 'lan' | 'uplink' | 'unclear'
  cidr: string
  device: string
  zone: string
  zoneMasquerades: boolean
  /** Both lists, always. The losing side is the half a refusal has to quote. */
  lanEvidence: string[]
  uplinkEvidence: string[]
}

export interface WanbindLayoutReply {
  ok: boolean
  interfaces: WanbindVerdict[]
  /** False when the router could not read /etc/config at all. */
  stated: boolean
  /** Why not. Present only on a refusal. */
  reason?: string
}

/**
 * One interface a WAN port or a carrier could be, with what the router says.
 *
 * The list a form offers, and the reason it is asked of the router rather than
 * derived here: the two halves must not be able to reach different conclusions
 * about which side of the router an interface is on. This module used to decide
 * it from the device name, which was true of a stock build and of nothing else.
 */
export interface WanbindWan {
  name: string
  proto: string
  device: string
  l3Device: string
  up: boolean
  pending: boolean
  uptime: number
  errorCode: string
  ipv4: { addr: string; mask: number } | null
  table: number | null
  zone: string
  role: 'lan' | 'uplink' | 'unclear'
  evidence: string[]
  /** The instance whose pool it is in, or empty. */
  instance: string
  /** The MACs currently seated on it. */
  holders: string[]
  state: 'available' | 'bound' | 'warning' | 'error' | 'dialing'
}

export interface WanbindWansReply {
  ok: boolean
  wans: WanbindWan[]
  carriers: Array<{ device: string; up: boolean; wans: string[] }>
  /** Why not. Present only on a refusal - netifd giving no answer, usually. */
  reason?: string
}

/** What `instance_check` and `instance_set` are given. `id` travels beside it. */
export interface WanbindInstanceSpec {
  name?: string
  lan: string
  carrier: string
  sticky?: boolean
  remap?: boolean
  range_from?: string
  range_to?: string
  clients_per_wan?: number
  enabled?: boolean
  /**
   * The three numbers a create leaves to the router.
   *
   * Sent only when this module is handing over an instance it wrote itself
   * before 3.4.0, where they are what the rules already standing were written
   * against - so sending them is what makes the daemon adopt those rules rather
   * than write a second set somewhere else and sweep the first a moment later.
   */
  rule_pref_base?: number
  catch_all_pref?: number
  catch_all_table?: number
  wan_warn_uptime?: number
  wan_error_grace?: number
  release_grace?: number
  raise_dhcp_limits?: boolean
}

export interface WanbindInstanceCheckReply {
  ok: boolean
  findings: WanbindFinding[]
  allocated: {
    rule_pref_base: number
    catch_all_pref: number
    catch_all_table: number
    slot: number
  }
  scope: { lanCidr: string; cidrs: string[] } | null
  pool: string[]
  /**
   * What applying this would move, and therefore flush first.
   *
   * A list rather than a flag, because a page that says only "this will
   * disturb the rules already on the router" has told somebody to be nervous
   * without telling them what about. Empty means nothing standing changes.
   */
  moves: Array<{ field: string; from: string; to: string }>
  reason?: string
}

export interface WanbindInstanceSetReply {
  ok: boolean
  reason?: string
  findings: WanbindFinding[]
  instance?: WanbindInstanceConfig
  flushed: number
  prepared: {
    tables: Array<{ wan: string; table: number }>
    forwardings: number
    /** The address blocks the fence was written as, not merely that it was. */
    catchAll: string[]
    /** Absent unless the spec asked for the lease ceilings to be raised. */
    dhcp: { ok: boolean; wrote: boolean; reason: string } | null
  }
  /**
   * Rules the kernel was holding afterwards, and how many it was not.
   *
   * `read` is what tells a clean pass from one where the rule table could not
   * be read at all - without it `unverified: 0` means both, and the surface
   * that reports "everything landed" would be saying it about a router nobody
   * managed to ask.
   */
  read: boolean
  verified: number
  unverified: number
}

export interface WanbindInstanceDeleteReply {
  ok: boolean
  id: string
  removed: number
  forwardings: number
  /** Non-null on a success too: the section is gone, something needs a hand. */
  reason: string | null
}

/**
 * What `bind` is given. One method for create and for update, because the
 * router is the source of truth: a module that lost track of what it wrote has
 * to converge on it rather than make a second binding for one address.
 */
export interface WanbindBindSpec {
  id: string
  name?: string
  ip?: string
  mac?: string
  wan: string
  lan?: string
  whenDown?: 'hold' | 'fallback'
  pref?: number
  table?: number
  enabled?: boolean
}

export interface WanbindBindReply {
  ok: boolean
  binding?: WanbindBinding
  findings?: WanbindFinding[]
  reason?: string
}

export interface WanbindCheckReply {
  ok: boolean
  findings: WanbindFinding[]
  reason?: string
}

/** What `unbind_many` answers: one row per id, whether or not it went. */
export interface WanbindUnbindManyReply {
  ok: boolean
  removed: number
  pending?: boolean
  due?: number
  reason?: string
  results: Array<{ id: string; ok: boolean; reason: string }>
}

export interface WanbindUnbindReply {
  ok: boolean
  id: string
  removed: number
  swept: number
  /** Non-null on a success too: the section is gone, something needs a hand. */
  reason: string | null
}
