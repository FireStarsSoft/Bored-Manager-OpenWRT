/**
 * What the module knows about a connected machine, and the raw answers it is
 * derived from.
 *
 * `ProbeFacts` and `OpenWrtCapabilities` are deliberately two types rather than
 * one. Facts are what the router said; capabilities are the judgement made
 * about it. Keeping the judgement a pure function of the facts (`buildReadiness`
 * in `readiness.ts`) is what makes every branch of the verdict - including the
 * ones only a broken router reaches - testable without a router.
 */
import { DEFAULT_RULES } from '../config'
import type { PackageGroupKey } from '../packages'

/** The vocabulary the `statusCards` block tints its rows and chips with. */
export type ReadinessStatus = 'ok' | 'warn' | 'bad' | 'unknown'

/**
 * Whether something that has to be *running* actually is.
 *
 * `unknown` is a state of its own rather than a pessimistic `stopped` because
 * the answer comes from `pidof`, and a router without it would otherwise be
 * told its dnsmasq is down - a refusal invented out of a missing BusyBox
 * applet. Nothing may block on `unknown`; it is reported and moved past.
 */
export type ServiceState = 'running' | 'stopped' | 'unknown'

/**
 * An `ip rule` sitting below the preference this module starts writing at.
 *
 * The lowest preference wins, so one of these silently outranks every rule the
 * binding engine installs - and the fast sweep cannot see it, because it filters
 * `ip rule show` down to the managed window on the router before sending
 * anything back. That is the whole failure mode: green everywhere, packets
 * leaving by another WAN.
 */
export interface ForeignRule {
  pref: number
  /** The rest of the line as the router printed it, trimmed and capped. */
  text: string
}

/**
 * The range of agent API versions this module knows how to drive.
 *
 * Declared here rather than in `agent/` because the probe has to judge an
 * answer the moment it reads one, and `agent/` reads the verdict rather than
 * the other way round - the import has to point one way or the folders cannot
 * be split at all.
 *
 * An agent outside this range is never an error. Older means the module drives
 * what it can and does the rest over SSH; newer means the agent is from a
 * release this module has not met, and falling back is the only honest answer -
 * an app from last month must not stop a router from working because somebody
 * updated its packages.
 */
export const AGENT_API = { min: 1, max: 3 } as const

/** Which agent calls exist, by the version that introduced them. */
export const AGENT_API_GUARD = 2
export const AGENT_API_UPDATE = 3

/** The commit-confirm countdown, as the agent reports it. */
export interface AgentGuard {
  armed: boolean
  snapshot: string
  reason: string
  /** Seconds left; negative once it is overdue and restoring. */
  remaining: number
}

/**
 * What `ubus call bm.agent info` said, or what `bmctl info --json` said when
 * the service is installed but not running.
 *
 * `installed` and `running` are separate for the reason they always are here: a
 * package that is present with its service stopped is a different problem with
 * a different fix from a package that was never installed, and one field cannot
 * say both.
 */
export interface AgentFacts {
  installed: boolean
  running: boolean
  release: string
  apiVersion: number
  /** The schema the installed build understands. */
  schema: number
  /** What is actually written on the disk; null on a router with no data yet. */
  dataSchema: number | null
  /** Capability names the installed feature packages claim. */
  provides: string[]
  /**
   * The feature descriptors themselves, one per installed package, because a
   * capability name alone cannot say which generation of the package claims
   * it: `pppoe` from bm-pppoe-pool 1.x speaks a contract this module no
   * longer drives, and the difference is the descriptor's own `apiVersion`.
   */
  features: AgentFeatureInfo[]
  guard: AgentGuard | null
}

/**
 * The facts plus the judgement: whether this module will drive that agent, and
 * which of its calls exist.
 */
export interface AgentCapability extends AgentFacts {
  /** The module talks to it. False means every path falls back to SSH. */
  usable: boolean
  /** Why the module is not using it, in a sentence. Null when it is. */
  problem: string | null
  canGuard: boolean
  canUpdate: boolean
}

/**
 * What the surfaces show instead of deciding for themselves from `problem`.
 *
 * `connecting` and `checking` exist because "we have not looked yet" used to be
 * indistinguishable from "this router is unusable": both left `problem` set, so
 * every page replaced itself with an error panel during a perfectly normal
 * startup. `attention` is a router that works but is missing something optional.
 */
export type ReadinessState = 'connecting' | 'checking' | 'ready' | 'attention' | 'blocked'

/**
 * The only installer this module drives. OpenWRT 25.12 replaced opkg with apk,
 * and a router still on opkg is refused rather than half-supported: the two
 * disagree about package names, about what an index refresh does, and about
 * what an already-installed package means, so a shared code path was a guess
 * dressed up as support.
 */
export type PackageManager = 'apk'

/** One row of the requirements checklist. */
export interface ReadinessCheck {
  key: string
  title: string
  status: ReadinessStatus
  detail: string
  /** A failure here stops the module entirely; it becomes `problem`. */
  required: boolean
  /** The package group that fixes it, when there is one. */
  install: PackageGroupKey | null
}

export interface ReadinessChip {
  label: string
  status: ReadinessStatus
  /** Set on anything not `ok`, so the card's "pinned only" switch shows faults. */
  pinned: boolean
}

/** A `statusCards` card: one group of checks. */
export interface ReadinessCard {
  key: string
  title: string
  status: ReadinessStatus
  subtitle: string
  note: string
  checks: ReadinessChip[]
}

export interface MissingPackage {
  /** Exactly as it appears in the install allowlist. */
  name: string
  group: PackageGroupKey
  /** What it is needed for, in a sentence. */
  for: string
}

export interface OpenWrtCapabilities {
  t: number
  connected: boolean
  isOpenwrt: boolean
  release: string
  board: string
  hasUbus: boolean
  hasUci: boolean
  hasIp: boolean
  hasLogread: boolean
  hasNetifd: boolean
  hasPppd: boolean
  hasFw4: boolean
  hasPppoe: boolean
  hasDnsmasq: boolean
  /**
   * This router's `ip` accepts a numeric routing table, which is the only
   * thing WAN binding ever asks of it. Deliberately not "`ip rule` answers":
   * BusyBox's applet lists rules perfectly well and then refuses the tables.
   */
  hasIpRule: boolean
  /** Where `ip` resolves, and whether an unused iproute2 sits beside it. */
  ip: ProbeFacts['ip']
  /**
   * The three things a binary in PATH says nothing about. An installed dnsmasq
   * with a stopped service is the case that used to read as `hasDnsmasq: true`
   * and then show an empty device table with no reason given.
   */
  services: { dnsmasq: ServiceState; netifd: ServiceState; fw4: ServiceState }
  /** Rules that outrank this module's, most important first; capped. */
  foreignRules: ForeignRule[]
  /** How many there were in total, which may exceed what `foreignRules` holds. */
  foreignRuleCount: number
  /** Whether the competing-rule scan ran at all, as opposed to finding none. */
  foreignRulesRead: boolean
  /** mwan3 on this router. It writes rules far below anything managed here. */
  mwan3: { config: boolean; running: boolean }
  /** What "below the managed window" meant when this verdict was reached. */
  rulePrefBase: number
  /**
   * The router-side agent. Always present, `installed: false` when there is
   * none - a surface asking "is there an agent" must not have to tell an absent
   * object from an object saying no.
   */
  agent: AgentCapability
  /** -1 when `id -u` said nothing. */
  uid: number
  isRoot: boolean
  pkgManager: PackageManager | null
  /** Free kilobytes on /overlay (or / when there is no overlay); -1 unknown. */
  overlayFreeKb: number
  tools: string[]
  /**
   * Whether the router actually answered. False when the probe threw or came
   * back empty - a verdict the caller must keep retrying rather than latch,
   * since an SSH hiccup looks exactly like "not an OpenWRT router" here.
   */
  probed: boolean
  problem: string | null
  state: ReadinessState
  stateLabel: string
  /** Probed, and nothing blocking. The collector runs exactly when this is true. */
  ready: boolean
  checks: ReadinessCheck[]
  cards: ReadinessCard[]
  missingPackages: MissingPackage[]
  /** Something is missing that this module knows how to install from here. */
  setupNeeded: boolean
  /**
   * Which automation is being held back by something installable, so each one
   * can offer the installer on its own tab rather than sending the user to
   * another page - or showing an installer for a package it does not use.
   *
   * A spec cannot ask "either of these two", and binding needs both `ip rule`
   * and dnsmasq, so the disjunction is decided here rather than duplicated into
   * two identical conditionals in the page.
   */
  missingFor: { pppoe: boolean; binding: boolean }
  /**
   * Whether an install could run at all: a working router, with apk, logged
   * in as root. `setupNeeded` is this plus "and something is missing", and
   * folding the two together left the install form unreachable on a router
   * where nothing is missing - which is exactly the router somebody wants to
   * reinstall a group on.
   */
  canInstall: boolean
}

/** The raw answers one probe produced, before any judgement is made about them. */
export interface ProbeFacts {
  connected: boolean
  probed: boolean
  isOpenwrt: boolean
  release: string
  board: string
  tools: readonly string[]
  ppp: { plugin: boolean; kmod: boolean }
  /**
   * Both databases, although only apk is supported: `opkg` present and `apk`
   * absent is a router this module can name the release of and explain itself
   * to, rather than one it reports as having no package manager at all.
   */
  pkgDb: { opkg: boolean; apk: boolean }
  /** -1 when unknown. */
  uid: number
  /** -1 when unknown. */
  overlayFreeKb: number
  hasIpRule: boolean
  /**
   * Where `ip` actually resolves on this router, and whether a working
   * iproute2 is sitting beside it unused.
   *
   * `hasIpRule` on its own cannot tell three very different routers apart: one
   * that never had iproute2, one that has it at `/usr/libexec/ip-full` while
   * `/sbin/ip` is still the BusyBox symlink (an install that ran and did not
   * switch the alternative), and one whose kernel has no policy routing at all,
   * where no package will ever help. All three used to end at the same
   * sentence and the same offer to install `ip-full` again.
   *
   * Every string is `''` and every flag `false` when the router was not asked
   * or could not answer - "not known" has to stay distinguishable from "no".
   */
  ip: {
    /** What `command -v ip` printed, e.g. `/sbin/ip`. */
    path: string
    /** What that resolves to, e.g. `/bin/busybox` or `/usr/libexec/ip-full`. */
    real: string
    /** `/usr/libexec/ip-full` exists and is executable. */
    fullPresent: boolean
    /** ...and answers a numeric routing table when called directly. */
    fullWorks: boolean
  }
  services: { dnsmasq: ServiceState; netifd: ServiceState; fw4: ServiceState }
  /** Already filtered to below `rulePrefBase` and capped by the router. */
  foreignRules: readonly ForeignRule[]
  /** What the router counted before the cap was applied. */
  foreignRuleCount: number
  /**
   * Whether the scan ran at all, as opposed to finding nothing. Its own fact
   * rather than something read off `hasIpRule`: that now means numeric routing
   * tables, which BusyBox's `ip` refuses while still listing rules fine.
   */
  foreignRulesRead: boolean
  mwan3: { config: boolean; running: boolean }
  /** Exactly what the agent answered, before any judgement about it. */
  agent: AgentFacts
  /**
   * The preference this module starts writing assignment rules at, carried in
   * as a fact so the verdict can name it without reading the configuration.
   * That is what keeps `buildReadiness` a pure function of its argument, which
   * is the only reason every branch of it is reachable from a test.
   */
  rulePrefBase: number
  /** Why nothing usable came back. Only ever read when `probed` is false. */
  transportError: string
}

/** One entry of `/usr/share/bm/features/`, as the agent relays it. */
export interface AgentFeatureInfo {
  name: string
  version: string
  apiVersion: number
  provides: string[]
}

/**
 * The contract generation of the package answering `capability`, 0 when no
 * installed package claims it. The highest wins on the theoretical router
 * with two packages claiming one capability - the newer contract is the one
 * the module would drive.
 */
export function featureApi(facts: AgentFacts, capability: string): number {
  let best = 0
  for (const entry of facts.features) {
    if (entry.provides.includes(capability) && entry.apiVersion > best) {
      best = entry.apiVersion
    }
  }
  return best
}

/**
 * The pool contract this module drives: pools of VLAN members, validated and
 * reconciled on the router. bm-pppoe-pool 1.x spoke a different shape -
 * numbered session runs, no firewall, no member edits - and this module no
 * longer carries the SSH code that drove it, so 1.x reads as "update needed"
 * rather than as a pool daemon.
 */
export const PPPOE_POOL_API = 2

export function hasPoolDaemon(agent: AgentCapability): boolean {
  return (
    agent.usable &&
    agent.provides.includes('pppoe') &&
    featureApi(agent, 'pppoe') >= PPPOE_POOL_API
  )
}

/** No agent, said in the shape a reader expects rather than as a null. */
export function emptyAgentFacts(): AgentFacts {
  return {
    installed: false,
    running: false,
    release: '',
    apiVersion: 0,
    schema: 0,
    dataSchema: null,
    provides: [],
    features: [],
    guard: null
  }
}

export function emptyFacts(): ProbeFacts {
  return {
    connected: false,
    probed: false,
    isOpenwrt: false,
    release: '',
    board: '',
    tools: [],
    ppp: { plugin: false, kmod: false },
    pkgDb: { opkg: false, apk: false },
    uid: -1,
    overlayFreeKb: -1,
    hasIpRule: false,
    ip: { path: '', real: '', fullPresent: false, fullWorks: false },
    services: { dnsmasq: 'unknown', netifd: 'unknown', fw4: 'unknown' },
    foreignRules: [],
    foreignRuleCount: 0,
    foreignRulesRead: false,
    mwan3: { config: false, running: false },
    agent: emptyAgentFacts(),
    rulePrefBase: DEFAULT_RULES.rulePrefBase,
    transportError: ''
  }
}
