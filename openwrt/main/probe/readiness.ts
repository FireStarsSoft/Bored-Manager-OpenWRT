/**
 * The verdict: raw probe answers in, a readiness report out.
 *
 * Pure by design - no context, no I/O, no clock beyond the timestamp - because
 * the interesting branches belong to routers that are hard to keep around: one
 * still on fw3, one whose BusyBox `ip` has no `rule`, one that answered nothing
 * at all. A function of its arguments is a function a test can reach.
 *
 * The sentences live in `text.ts` and the checklist rows in `checks.ts`; what
 * is left here is the part worth reading in one piece. Both are re-exported
 * below, so the split is an arrangement of this folder rather than something
 * every caller has to know about.
 */
import { PACKAGE_GROUPS } from '../packages'
import { CARDS, observedChecks, type CheckSeed } from './checks'
import {
  APK_REQUIRED,
  CORE_TOOLS,
  installHint,
  type InstallContext,
  MIN_RELEASE,
  NOT_CONNECTED,
  NOT_OPENWRT,
  UNANSWERED,
  opkgNotSupported,
  releaseNumber
} from './text'
import {
  AGENT_API,
  AGENT_API_GUARD,
  AGENT_API_UPDATE,
  emptyFacts,
  type AgentCapability,
  type AgentFacts,
  type MissingPackage,
  type OpenWrtCapabilities,
  type PackageManager,
  type ProbeFacts,
  type ReadinessCard,
  type ReadinessCheck,
  type ReadinessState,
  type ReadinessStatus
} from './types'

/**
 * What the module does with the agent it found, and why.
 *
 * Every branch that ends in `usable: false` is a fall back to SSH, never a
 * failure: a router with no agent is the router this module has always managed,
 * and an agent from a release the module has not met has to leave that router
 * working rather than take it away. The only thing lost is speed and the safety
 * net, and the surfaces say so rather than going quiet.
 */
export function judgeAgent(facts: AgentFacts): AgentCapability {
  const base = { ...facts, canGuard: false, canUpdate: false }

  if (!facts.installed) {
    return { ...base, usable: false, problem: null }
  }

  if (!facts.running) {
    return {
      ...base,
      usable: false,
      problem:
        'The Bored Manager agent is installed but its service is not running, so this router is being managed over SSH instead. `/etc/init.d/bm-agent start` at a router shell, or check `logread -e bm-agent` for why it stopped.'
    }
  }

  // Data written by a newer build than the one installed. The agent refuses to
  // start on this and says so; if it is somehow running anyway, the module is
  // not going to be the one that writes through it.
  if (facts.dataSchema !== null && facts.schema > 0 && facts.dataSchema > facts.schema) {
    return {
      ...base,
      usable: false,
      problem: `This router's data is at schema ${facts.dataSchema} and the installed agent only understands ${facts.schema}. Install the newer packages again, or restore a snapshot taken before the downgrade.`
    }
  }

  if (facts.apiVersion < AGENT_API.min || facts.apiVersion > AGENT_API.max) {
    return {
      ...base,
      usable: false,
      problem:
        facts.apiVersion > AGENT_API.max
          ? `The agent on this router speaks version ${facts.apiVersion} of the module API and this module knows up to ${AGENT_API.max}, so it is being managed over SSH. Update Bored Manager's OpenWRT module.`
          : `The agent on this router speaks version ${facts.apiVersion} of the module API and this module needs at least ${AGENT_API.min}. Update the router packages.`
    }
  }

  return {
    ...base,
    usable: true,
    problem: null,
    canGuard: facts.apiVersion >= AGENT_API_GUARD,
    canUpdate: facts.apiVersion >= AGENT_API_UPDATE
  }
}

/**
 * The next step for a failing row, or `''` when there is nothing to add.
 *
 * `install` has been on every check since the install flow existed and no
 * surface ever read it, so the three rows that *can* be fixed from Module
 * settings - policy routing, PPPoE support, DHCP leases - were the only three
 * whose detail named no next step at all, while every row that cannot be fixed
 * from here spelled one out. A user reading "this router has the BusyBox ip"
 * was told what was wrong and left to find the form themselves.
 */
function remedy(seed: CheckSeed, context: InstallContext): string {
  if (!seed.install) return ''
  const group = PACKAGE_GROUPS.find((entry) => entry.key === seed.install)
  if (!group) return ''
  return ` ${installHint(context, `${group.title} (${group.packages.join(', ')})`)}`
}

const RANK: Record<ReadinessStatus, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 }

function worst(statuses: readonly ReadinessStatus[]): ReadinessStatus {
  let out: ReadinessStatus = 'ok'
  for (const status of statuses) if (RANK[status] < RANK[out]) out = status
  return out
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
  const hasMacvlan = facts.ppp.macvlan === true
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

  const agent = judgeAgent(facts.probed ? facts.agent : { ...facts.agent, installed: false })

  const capabilityValues = {
    hasPppoe,
    hasMacvlan,
    hasIpRule: facts.hasIpRule,
    hasDnsmasq
  }
  const missingPackages: MissingPackage[] = []
  // Only from answers. Before the probe lands every capability above is false
  // by default rather than by observation, and listing all three groups then
  // put "install ppp, ppp-mod-pppoe and kmod-pppoe" on the settings page for a
  // router that had not been asked.
  //
  // And only when installing it could still change the answer. `ip-full` on
  // disk is the case that made this necessary: the capability stays false
  // because the alternatives link was never switched, or because this kernel has
  // no policy routing at all, and `apk add ip-full` is a no-op in both. The
  // readiness row already says so and offers no install - the form read
  // `hasIpRule` on its own and offered it anyway, so the same router was invited
  // to run the same no-op job for ever, which is the loop this release is about.
  if (facts.probed) {
    for (const group of PACKAGE_GROUPS) {
      if (group.optional) continue
      if (capabilityValues[group.capability]) continue
      if (group.capability === 'hasIpRule' && facts.ip.fullPresent) continue
      for (const name of group.packages) {
        missingPackages.push({ name, group: group.key, for: group.purpose })
      }
    }
  }

  const missingCore = CORE_TOOLS.filter((tool: string) => !tools.has(tool))
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
  const observed = observedChecks({
    facts,
    tools,
    hasPppd,
    hasFw4,
    hasPppoe,
    hasMacvlan,
    hasDnsmasq,
    hasLogread,
    oldRelease,
    releaseLabel,
    pkgManager,
    pkgProblem,
    isRoot,
    agent,
    missingPackages: missingPackages.length
  })

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
  const canInstall = ready && pkgManager !== null && isRoot
  const setupNeeded = canInstall && missingPackages.length > 0
  // Read off `missingPackages` rather than off the capabilities a second time,
  // so an automation tab cannot offer an install that the settings page has
  // already decided is not worth offering.
  const missingGroups = new Set(missingPackages.map((entry) => entry.group))
  // Hoisted above the cards on purpose: a row that names an installable group
  // has to be able to say where to go and install it, and `installHint` needs
  // both of the flags above to pick which of the four sentences applies.
  const installContext: InstallContext = { probed: facts.probed, problem, pkgManager, isRoot, setupNeeded }
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
          ? failing.map((seed) => `${seed.title}: ${seed.detail}${remedy(seed, installContext)}`).join(' ')
          : shape.okNote,
      checks: own.map((seed) => ({
        label: seed.title,
        status: seed.status,
        pinned: seed.status !== 'ok'
      }))
    }
  })

  // A warning is something the user may choose to live with; only a `bad` check
  // on a working router is worth pulling them to the settings page for - with
  // one deliberate exception.
  //
  // A router with no usable agent works, and every surface says so rather than
  // refusing. But it works over SSH: no snapshots, no commit-confirm, a lease
  // read on a timer instead of on the event, and a pool built one round trip at
  // a time. That is a difference worth a banner, not a sentence three pages
  // deep - so it earns `attention` without being a `bad` check, because the
  // router is not faulty and the card should not be red.
  const attention =
    ready &&
    (setupNeeded || !agent.usable || checks.some((check) => check.status === 'bad'))
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
    hasMacvlan,
    hasDnsmasq,
    hasIpRule: facts.hasIpRule,
    ip: facts.ip,
    services: facts.probed
      ? facts.services
      : { dnsmasq: 'unknown', netifd: 'unknown', fw4: 'unknown' },
    // Only from answers, the same way `missingPackages` is: an unprobed router
    // has no rules and no mwan3 by default rather than by observation, and a
    // gate reading these must not be handed a fact nobody established.
    foreignRules: facts.probed ? [...facts.foreignRules] : [],
    foreignRuleCount: facts.probed ? facts.foreignRuleCount : 0,
    foreignRulesRead: facts.probed && facts.foreignRulesRead,
    mwan3: facts.probed ? facts.mwan3 : { config: false, running: false },
    agent,
    rulePrefBase: facts.rulePrefBase,
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
    setupNeeded,
    // Only ever true when an install could actually run: an automation tab
    // offering a form that would refuse is worse than one saying nothing.
    missingFor: {
      pppoe: canInstall && missingGroups.has('pppoe'),
      binding: canInstall && (missingGroups.has('ipfull') || missingGroups.has('dnsmasq'))
    },
    canInstall
  }
}

export {
  APK_REQUIRED,
  FW4_MISSING,
  SPACE_BAD_KB,
  SPACE_WARN_KB,
  opkgNotSupported
} from './text'
