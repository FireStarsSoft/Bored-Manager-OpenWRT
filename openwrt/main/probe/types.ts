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
import type { PackageGroupKey } from '../packages'

/** The vocabulary the `statusCards` block tints its rows and chips with. */
export type ReadinessStatus = 'ok' | 'warn' | 'bad' | 'unknown'

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
  /** `ip rule` actually ran. BusyBox `ip` on some targets has no rule support. */
  hasIpRule: boolean
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
  /** Why nothing usable came back. Only ever read when `probed` is false. */
  transportError: string
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
    transportError: ''
  }
}
