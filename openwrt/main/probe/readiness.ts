/**
 * The verdict: raw probe answers in, a readiness report out.
 *
 * Pure by design - no context, no I/O, no clock beyond the timestamp - because
 * the interesting branches belong to routers that are hard to keep around: one
 * still on fw3, one whose BusyBox `ip` has no `rule`, one that answered nothing
 * at all. A function of its arguments is a function a test can reach.
 */
import { PACKAGE_GROUPS } from '../packages'
import {
  emptyFacts,
  type MissingPackage,
  type OpenWrtCapabilities,
  type PackageManager,
  type ProbeFacts,
  type ReadinessCard,
  type ReadinessCheck,
  type ReadinessState,
  type ReadinessStatus
} from './types'

const NOT_CONNECTED = 'Not connected to a router yet.'
const NOT_OPENWRT =
  'The connected machine is not an OpenWRT router. Connect this machine entry directly to the router over SSH.'

/** Every row of a router that has not said a word yet reads this. */
const UNANSWERED = 'The router has not answered yet.'

/**
 * The one sentence for a router with no apk database, read by all three places
 * that have to say it: this checklist's `pkgmgr` row, the install form's own
 * refusal, and `installHint` on every create form. They used to carry three
 * copies of "Neither opkg nor apk is present", which is how the card and the
 * form came to describe one router in two voices the moment one was edited.
 */
export const APK_REQUIRED =
  'No apk package database on this router. This module needs OpenWrt 25.12 or newer, which replaced opkg with apk.'

/**
 * The refusal for a router that is simply too old. Naming the release it runs
 * is the whole point: "no package manager" on a working 24.10 router sends the
 * user looking for a broken installer instead of at a firmware upgrade.
 */
export function opkgNotSupported(release: string): string {
  return `This module needs OpenWrt 25.12 or newer. This router runs ${
    release || 'an unknown release'
  } and still uses opkg.`
}

/** The first release that ships apk. Below it the module is untested, not broken. */
const MIN_RELEASE = 25.12

/**
 * `24.10.2` as a number to compare, or null for anything that is not a release
 * number at all - a snapshot build calls itself `SNAPSHOT` or `r28417`. That is
 * exactly why no gate in this file is allowed to key off the version string:
 * the apk database on disk decides, and this only ever produces a warning.
 */
function releaseNumber(release: string): number | null {
  const match = release.trim().match(/^(\d{2})\.(\d{2})/)
  return match ? Number(`${match[1]}.${match[2]}`) : null
}

/** Blocking requirements, in the order they are reported. */
const CORE_TOOLS = ['ubus', 'uci', 'ip', 'netifd']

/** Free kilobytes below which an install is refused outright / warned about. */
const SPACE_BAD_KB = 512
const SPACE_WARN_KB = 2_048

/**
 * One condition, one sentence. The readiness card, the PPPoE create gate and
 * the binding create gate all describe this same missing firewall, and used to
 * do it in three vocabularies - none of which said that this is the one
 * readiness failure the install flow deliberately cannot fix, so a user reading
 * "Firewall4: Not found" above an "Install missing packages" section went
 * looking for it there.
 */
export const FW4_MISSING =
  'Managed PPPoE pools and WAN binding both need nftables masquerading, which routers still on fw3 do not have. It cannot be installed from here: moving a router to fw4 is a firmware upgrade, done at a router shell.'

type CardKey = 'core' | 'firewall' | 'pppoe' | 'extras' | 'install'

interface CardShape {
  key: CardKey
  title: string
  /** Shown when every check in the card passed. */
  okNote: string
}

const CARDS: readonly CardShape[] = [
  { key: 'core', title: 'Core', okNote: 'This is an OpenWRT router and every required tool answered.' },
  {
    key: 'firewall',
    title: 'Firewall & routing',
    okNote: 'nftables masquerading and policy routing are both available.'
  },
  { key: 'pppoe', title: 'PPPoE dialing', okNote: 'The router can dial PPPoE sessions.' },
  { key: 'extras', title: 'Extras', okNote: 'Device discovery and router logs are available.' },
  {
    key: 'install',
    title: 'Install readiness',
    okNote: 'Missing packages can be installed from this page.'
  }
]

interface CheckSeed extends ReadinessCheck {
  card: CardKey
}

const RANK: Record<ReadinessStatus, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 }

function worst(statuses: readonly ReadinessStatus[]): ReadinessStatus {
  let out: ReadinessStatus = 'ok'
  for (const status of statuses) if (RANK[status] < RANK[out]) out = status
  return out
}

function toolCheck(
  key: string,
  title: string,
  present: boolean,
  card: CardKey,
  detailWhenMissing: string
): CheckSeed {
  return {
    key,
    title,
    status: present ? 'ok' : 'bad',
    detail: present ? 'Present' : detailWhenMissing,
    required: true,
    install: null,
    card
  }
}

function pppoeDetail(hasPppd: boolean, plugin: boolean, kmod: boolean): string {
  const missing: string[] = []
  if (!hasPppd) missing.push('the pppd daemon')
  if (!plugin) missing.push('the rp-pppoe plugin')
  if (!kmod) missing.push('kernel PPPoE support')
  return missing.length
    ? `Missing ${missing.join(', ')}.`
    : 'pppd, the rp-pppoe plugin and kernel support are all present.'
}

function spaceCheck(freeKb: number, needed: boolean): CheckSeed {
  const seed = { key: 'space', title: 'Free space', required: false, install: null, card: 'install' as const }
  if (freeKb < 0) {
    return { ...seed, status: 'unknown', detail: 'df did not report the overlay; installs may run out of room.' }
  }
  const size = `${Math.round(freeKb / 1024)} MB free on the overlay`
  if (freeKb < SPACE_BAD_KB) {
    return {
      ...seed,
      status: needed ? 'bad' : 'warn',
      detail: `${size}. Too little to install anything; free some space first.`
    }
  }
  if (freeKb < SPACE_WARN_KB) {
    return { ...seed, status: 'warn', detail: `${size}. Enough for a small package, but only just.` }
  }
  return { ...seed, status: 'ok', detail: size }
}

function stateLabelFor(state: ReadinessState): string {
  if (state === 'connecting') return 'Waiting for a connection'
  if (state === 'checking') return 'Checking the router'
  if (state === 'blocked') return 'Cannot manage this machine'
  return state === 'attention' ? 'Needs attention' : 'Ready'
}

export function emptyCapabilities(): OpenWrtCapabilities {
  return buildReadiness(emptyFacts())
}

/**
 * The whole verdict, derived from raw answers and nothing else - no context, no
 * clock beyond the timestamp, so every branch of it is reachable from a test.
 */
export function buildReadiness(facts: ProbeFacts): OpenWrtCapabilities {
  const tools = new Set(facts.tools)
  const hasPppd = tools.has('pppd')
  const hasFw4 = tools.has('fw4') && tools.has('nft')
  const hasPppoe = hasPppd && facts.ppp.plugin && facts.ppp.kmod
  const hasDnsmasq = tools.has('dnsmasq')
  const hasLogread = tools.has('logread')
  // A functional test, and deliberately not a version string: a snapshot build
  // reports its release as `SNAPSHOT`, so parsing one would refuse every
  // snapshot router that has apk and works perfectly. The database on disk
  // decides, because an apk router also keeps an `opkg` shim in PATH that
  // answers `command -v` and then refuses to install anything.
  const pkgManager: PackageManager | null = facts.pkgDb.apk ? 'apk' : null
  const pkgProblem = pkgManager
    ? null
    : facts.pkgDb.opkg
      ? opkgNotSupported(facts.release)
      : APK_REQUIRED
  const release = releaseNumber(facts.release)
  const oldRelease = release !== null && release < MIN_RELEASE
  const isRoot = facts.uid === 0

  const capabilityValues = {
    hasPppoe,
    hasIpRule: facts.hasIpRule,
    hasDnsmasq
  }
  const missingPackages: MissingPackage[] = []
  // Only from answers. Before the probe lands every capability above is false
  // by default rather than by observation, and listing all three groups then
  // put "install ppp, ppp-mod-pppoe and kmod-pppoe" on the settings page for a
  // router that had not been asked.
  if (facts.probed) {
    for (const group of PACKAGE_GROUPS) {
      if (capabilityValues[group.capability]) continue
      for (const name of group.packages) {
        missingPackages.push({ name, group: group.key, for: group.purpose })
      }
    }
  }

  const missingCore = CORE_TOOLS.filter((tool) => !tools.has(tool))
  let problem: string | null = null
  if (!facts.connected) problem = NOT_CONNECTED
  else if (!facts.probed) {
    // Only here does the transport get to speak. A router that answered but is
    // not OpenWRT keeps the wording it always had.
    problem = facts.transportError || 'The OpenWRT capability probe returned no data.'
  } else if (!facts.isOpenwrt) problem = NOT_OPENWRT
  else if (missingCore.length) {
    // This reaches the setup page verbatim, as the detail under "This machine
    // cannot be managed yet" - directly above an install section that cannot
    // supply a single one of these.
    problem = `OpenWRT is missing required command(s): ${missingCore.join(', ')}. These are part of the base system, so they cannot be installed from here.`
  } else if (pkgProblem) {
    // The breaking gate. A router on opkg is not half-supported: the module
    // would offer it an install flow that speaks a package manager it does not
    // have, so it is stopped here with the release it actually runs.
    problem = pkgProblem
  }

  const ready = facts.probed && problem === null
  const releaseLabel = [facts.release, facts.board].filter(Boolean).join(' · ') || 'OpenWRT'
  const observed: CheckSeed[] = [
    {
      key: 'openwrt',
      title: 'OpenWRT firmware',
      status: !facts.isOpenwrt ? 'bad' : oldRelease ? 'warn' : 'ok',
      detail: !facts.isOpenwrt
        ? 'This machine did not identify itself as OpenWRT.'
        : oldRelease
          ? `${releaseLabel}. This module is built for OpenWrt 25.12 and newer; nothing below that is tested.`
          : releaseLabel,
      required: true,
      install: null,
      card: 'core'
    },
    toolCheck('ubus', 'ubus system bus', tools.has('ubus'), 'core', 'Not found in PATH.'),
    toolCheck('uci', 'uci configuration', tools.has('uci'), 'core', 'Not found in PATH.'),
    toolCheck('ip', 'iproute2 (ip)', tools.has('ip'), 'core', 'Not found in PATH.'),
    toolCheck('netifd', 'netifd', tools.has('netifd'), 'core', 'Not found in PATH.'),
    {
      key: 'fw4',
      title: 'Firewall4 (fw4 + nft)',
      status: hasFw4 ? 'ok' : 'bad',
      // No install entry on purpose: a router still on fw3 cannot be upgraded
      // into fw4 from here without taking its firewall down.
      detail: hasFw4 ? 'Present' : `Not found. ${FW4_MISSING}`,
      required: false,
      install: null,
      card: 'firewall'
    },
    {
      key: 'iprule',
      title: 'Policy routing (ip rule)',
      status: facts.hasIpRule ? 'ok' : 'warn',
      detail: facts.hasIpRule
        ? 'Present'
        : 'This `ip` has no rule support. WAN binding cannot steer a device without it.',
      required: false,
      install: facts.hasIpRule ? null : 'ipfull',
      card: 'firewall'
    },
    {
      key: 'pppoe',
      title: 'PPPoE support',
      status: hasPppoe ? 'ok' : 'bad',
      detail: pppoeDetail(hasPppd, facts.ppp.plugin, facts.ppp.kmod),
      required: false,
      install: hasPppoe ? null : 'pppoe',
      card: 'pppoe'
    },
    {
      key: 'dnsmasq',
      title: 'dnsmasq (DHCP leases)',
      status: hasDnsmasq ? 'ok' : 'warn',
      detail: hasDnsmasq
        ? 'Present'
        : 'Without it there are no DHCP leases to read, so the device table stays empty.',
      required: false,
      install: hasDnsmasq ? null : 'dnsmasq',
      card: 'extras'
    },
    {
      key: 'logread',
      title: 'logread',
      status: hasLogread ? 'ok' : 'warn',
      detail: hasLogread
        ? 'Present'
        : 'Part of the base system. PPPoE dial errors are read from it; without it a failed session gives no reason.',
      required: false,
      install: null,
      card: 'extras'
    },
    {
      key: 'pkgmgr',
      title: 'Package manager (apk)',
      status: pkgManager ? 'ok' : 'bad',
      // The same strings the install form and every create form's install hint
      // read, so the card and the form cannot describe one router in two
      // vocabularies once either is edited.
      detail: pkgManager ? 'apk is available' : (pkgProblem ?? APK_REQUIRED),
      required: true,
      install: null,
      card: 'install'
    },
    {
      key: 'root',
      title: 'Root access',
      status: isRoot ? 'ok' : facts.uid < 0 ? 'unknown' : 'warn',
      detail: isRoot
        ? 'Logged in as root'
        : facts.uid < 0
          ? 'The router did not report a user id.'
          : `Logged in as uid ${facts.uid}. Installing packages needs root.`,
      required: false,
      install: null,
      card: 'install'
    },
    spaceCheck(facts.overlayFreeKb, missingPackages.length > 0)
  ]

  // Nothing has been read off this router, so ten of the thirteen rows above
  // were a default dressed up as an observation - "ubus: Not found in PATH",
  // "PPPoE support: Missing the pppd daemon", "Firewall4: Not found" - about a
  // machine that had not answered a single question. `unknown` is the one
  // honest verdict here, and it is what the card filter and the chips render.
  const seeds: CheckSeed[] = facts.probed
    ? observed
    : observed.map(
        (seed): CheckSeed => ({ ...seed, status: 'unknown', detail: UNANSWERED, install: null })
      )

  const checks: ReadinessCheck[] = seeds.map(({ card: _card, ...check }) => check)
  const cards: ReadinessCard[] = CARDS.map((shape) => {
    const own = seeds.filter((seed) => seed.card === shape.key)
    const failing = own.filter((seed) => seed.status !== 'ok')
    return {
      key: shape.key,
      title: shape.title,
      status: worst(own.map((seed) => seed.status)),
      subtitle: `${own.length - failing.length}/${own.length} ok`,
      // Said once. Rolling up the rows of an unanswered router repeated the
      // same sentence up to five times in one card's Detail line.
      note: !facts.probed
        ? UNANSWERED
        : failing.length
          ? failing.map((seed) => `${seed.title}: ${seed.detail}`).join(' ')
          : shape.okNote,
      checks: own.map((seed) => ({
        label: seed.title,
        status: seed.status,
        pinned: seed.status !== 'ok'
      }))
    }
  })

  const setupNeeded = ready && missingPackages.length > 0 && pkgManager !== null && isRoot
  // A warning is something the user may choose to live with; only a `bad` check
  // on a working router is worth pulling them to the settings page for.
  const attention = ready && (setupNeeded || checks.some((check) => check.status === 'bad'))
  const state: ReadinessState = !facts.connected
    ? 'connecting'
    : !facts.probed
      ? 'checking'
      : problem
        ? 'blocked'
        : attention
          ? 'attention'
          : 'ready'

  return {
    t: Date.now(),
    connected: facts.connected,
    isOpenwrt: facts.isOpenwrt,
    release: facts.release,
    board: facts.board,
    hasUbus: tools.has('ubus'),
    hasUci: tools.has('uci'),
    hasIp: tools.has('ip'),
    hasLogread,
    hasNetifd: tools.has('netifd'),
    hasPppd,
    hasFw4,
    hasPppoe,
    hasDnsmasq,
    hasIpRule: facts.hasIpRule,
    uid: facts.uid,
    isRoot,
    pkgManager,
    overlayFreeKb: facts.overlayFreeKb,
    tools: [...tools].sort(),
    probed: facts.probed,
    problem,
    state,
    stateLabel: stateLabelFor(state),
    ready,
    checks,
    cards,
    missingPackages,
    setupNeeded
  }
}
