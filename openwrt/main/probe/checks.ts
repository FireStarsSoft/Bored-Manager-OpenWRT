/**
 * The checklist rows, and the cards they group into.
 *
 * Separated from the verdict so that `readiness.ts` reads as what it is:
 * derive the facts, decide whether this router can be managed at all,
 * assemble. Which rows exist and how each one words itself is a long flat
 * list, and a long flat list is exactly the thing that should not sit in the
 * middle of a decision.
 *
 * Everything here is pure. A row is a function of the facts and of the values
 * already derived from them, which is what keeps every branch - including the
 * ones only a broken router reaches - reachable from a test.
 */
import { IP_FULL_PATH } from './command'
import { APK_REQUIRED, FW4_MISSING, SPACE_BAD_KB, SPACE_WARN_KB } from './text'
import { featureApi, PPPOE_POOL_API } from './types'
import type {
  AgentCapability,
  PackageManager,
  ProbeFacts,
  ReadinessCheck
} from './types'

export type CardKey = 'core' | 'firewall' | 'pppoe' | 'extras' | 'install' | 'agent'

export interface CardShape {
  key: CardKey
  title: string
  /** Shown when every check in the card passed. */
  okNote: string
}

export const CARDS: readonly CardShape[] = [
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
  },
  {
    key: 'agent',
    title: 'Router packages',
    okNote: 'The agent is installed and this module is driving the router through it.'
  }
]

export interface CheckSeed extends ReadinessCheck {
  card: CardKey
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

/**
 * The competing-policy-routing row.
 *
 * Everything it reports is a warning rather than a failure on purpose: a router
 * with deliberate policy routing of its own is a router someone set up that
 * way, and this module has no business refusing to run on it. What it does have
 * business doing is saying so, because this is the one fault that leaves every
 * other surface looking correct - the fast sweep filters `ip rule show` down to
 * the managed window before it ever reaches here, so a rule below that window
 * decides where the packets go and appears nowhere at all.
 */
function conflictCheck(facts: ProbeFacts): CheckSeed {
  const seed = {
    key: 'conflict',
    title: 'Competing policy routing',
    required: false,
    install: null,
    card: 'firewall' as const
  }
  // Whether the scan ran, not whether policy routing works.
  //
  // These were the same question while `hasIpRule` meant "`ip rule` answers".
  // It now means numeric routing tables, and BusyBox's `ip` fails that while
  // still listing rules perfectly well - so reading this row off `hasIpRule`
  // would blank it on precisely the routers where a competing rule is the most
  // likely thing somebody is hunting for.
  if (!facts.foreignRulesRead) {
    return {
      ...seed,
      status: 'unknown',
      detail: 'Nothing could be read back about competing rules, so this router may have some that outrank anything WAN binding writes.'
    }
  }
  if (facts.mwan3.config) {
    return {
      ...seed,
      status: 'warn',
      detail: `mwan3 is installed on this router${
        facts.mwan3.running ? ' and running' : ', though not currently running'
      }. It writes its own ip rules far below preference ${
        facts.rulePrefBase
      }, and the lowest preference wins - so a device bound to one WAN here can still leave by another, with nothing on this page to show for it. Run one or the other, not both.`
    }
  }
  if (facts.foreignRuleCount === 0) {
    return {
      ...seed,
      status: 'ok',
      detail: `Nothing sits below preference ${facts.rulePrefBase}, so no rule outranks the ones this module writes.`
    }
  }
  const shown = facts.foreignRules.slice(0, 3)
  const named = shown.map((rule) => `${rule.pref}: ${rule.text}`).join('; ')
  const rest = facts.foreignRuleCount - shown.length
  return {
    ...seed,
    status: 'warn',
    detail: `${facts.foreignRuleCount} ip rule(s) sit below preference ${
      facts.rulePrefBase
    } and outrank every rule this module writes - ${named}${
      rest > 0 ? `, and ${rest} more` : ''
    }. WAN binding will read as applied here while those decide where the traffic actually goes.`
  }
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

/**
 * What the rows need beyond the raw facts: the handful of values the verdict
 * has already worked out, passed in rather than recomputed, so that the two
 * cannot come to disagree about the same router.
 */
export interface CheckInput {
  facts: ProbeFacts
  tools: Set<string>
  hasPppd: boolean
  hasFw4: boolean
  hasPppoe: boolean
  hasMacvlan: boolean
  hasDnsmasq: boolean
  hasLogread: boolean
  oldRelease: boolean
  releaseLabel: string
  pkgManager: PackageManager | null
  pkgProblem: string | null
  isRoot: boolean
  agent: AgentCapability
  /** How many packages are missing, which decides how hard the space row is. */
  missingPackages: number
}

/**
 * One feature package: is it there, and what changes because it is.
 *
 * Never a failure and never `bad`. Both halves work; these rows exist so that a
 * person can tell which one is running without reading a log, which is the
 * whole of what "compatibility mode is labelled" means at this level of detail.
 *
 * `unknown` when there is no agent to ask - not `warn`. A router with no agent
 * has already been told so one row above, and repeating it twice more as though
 * they were three separate problems is how a readiness list stops being read.
 */
function featureCheck(
  agent: AgentCapability,
  feature: string,
  title: string,
  packageName: string,
  present: string,
  absent: string,
  /** The oldest contract this module still drives; omit to accept any. */
  minApi?: number
): CheckSeed {
  if (!agent.usable) {
    return {
      key: `feature-${feature}`,
      title,
      status: 'unknown',
      detail: 'There is no agent to ask; the row above says why.',
      required: false,
      install: null,
      card: 'agent'
    }
  }

  const installed = agent.provides.includes(feature)
  if (installed && minApi !== undefined && featureApi(agent, feature) < minApi) {
    const found = agent.features.find((entry) => entry.provides.includes(feature))
    return {
      key: `feature-${feature}`,
      title,
      status: 'warn',
      detail:
        `${packageName} ${found?.version || ''} speaks version ${featureApi(agent, feature)} of its contract and this module drives ${minApi}. ` +
        'Update the router packages from Router packages, in Module settings - the pools it holds keep dialling meanwhile, but nothing here can read or change them.',
      required: false,
      install: null,
      card: 'agent'
    }
  }

  return {
    key: `feature-${feature}`,
    title,
    status: installed ? 'ok' : 'warn',
    detail: installed ? `${packageName} is installed. ${present}` : `${packageName} is not installed. ${absent} Install it from Router packages, in Module settings.`,
    required: false,
    install: null,
    card: 'agent'
  }
}

/**
 * Whether this router can steer a packet by numeric routing table, and - when
 * it cannot - which of three quite different reasons applies.
 *
 * The three used to be one sentence and one offer to install `ip-full`. Two of
 * them are not fixed by installing anything: a router where the package went on
 * and the alternatives symlink did not switch already has the binary, and a
 * kernel built without multiple routing tables refuses a numeric table from a
 * full iproute2 as well. Offering an install to either is how somebody comes to
 * run the same job three times and read `partial` three times.
 */
function ipRuleCheck(facts: ProbeFacts): CheckSeed {
  const base = {
    key: 'iprule',
    title: 'Policy routing (ip rule)',
    required: false,
    card: 'firewall'
  } as const
  const at = facts.ip.path || '/sbin/ip'
  // Only worth printing when it points somewhere else: `/sbin/ip -> /sbin/ip` is
  // two paths and no information.
  const aliased = Boolean(facts.ip.real) && facts.ip.real !== at

  if (facts.hasIpRule) {
    return {
      ...base,
      status: 'ok',
      detail: facts.ip.real ? `Present (${facts.ip.real})` : 'Present',
      install: null
    }
  }

  // Installed, working when called directly, and still not what `ip` means.
  // This is the router that has just been through the install flow: `apk add`
  // succeeded, the binary is there, and nothing switched the alternative.
  if (facts.ip.fullPresent && facts.ip.fullWorks) {
    return {
      ...base,
      status: 'warn',
      detail:
        `iproute2 is installed at ${IP_FULL_PATH} and does accept a numeric routing table, but ` +
        `${at} still resolves to ${facts.ip.real || 'BusyBox'} - the alternatives link was never ` +
        `switched, so \`ip\` on this router is still the BusyBox applet. Installing the package ` +
        `again will not change that. Relink it at a router shell with ` +
        `\`ln -sf ${IP_FULL_PATH} ${at}\`, then run Check again.`,
      install: null
    }
  }

  // Present and still refused, which is not a package problem at all.
  if (facts.ip.fullPresent) {
    // A router whose own binding daemon is up deserves the caveat: bm-wanbind
    // writes rules over netlink and never touches the ip binary, so if its
    // instances are binding clients, this reading is stale or wrong rather
    // than the kernel being short a feature.
    const daemonBinds =
      facts.agent.installed && facts.agent.running && facts.agent.provides.includes('binding')
    return {
      ...base,
      status: 'warn',
      detail:
        `iproute2 is installed at ${IP_FULL_PATH} and this kernel still refuses a numeric routing ` +
        `table, so policy routing is not built into this firmware. No package fixes that: WAN ` +
        `binding needs an image built with multiple routing tables.` +
        (daemonBinds
          ? ` This router's own bm-wanbind is running, though - it writes rules over netlink ` +
            `without the ip binary, so if its instances are binding clients, run Check again ` +
            `and trust what the daemon reports.`
          : ''),
      install: null
    }
  }

  return {
    ...base,
    status: 'warn',
    detail:
      `This is the BusyBox \`ip\`${aliased ? ` (${at} -> ${facts.ip.real})` : ''}, which ` +
      `answers \`ip rule show\` but rejects a numeric routing table - ` +
      `\`invalid argument to 'table ID'\`. Every rule WAN binding writes names one, so it would ` +
      `create an instance and then fail on the first line that steers anything.`,
    install: 'ipfull'
  }
}

/** Every row, in the order they are reported, as this router actually answered. */
export function observedChecks(input: CheckInput): CheckSeed[] {
  const {
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
    agent
  } = input

  return [
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
      key: 'netifdrun',
      title: 'netifd running',
      // Only ever about the process. With the binary missing the row above has
      // already said so, and `problem` has already stopped the module - saying
      // it twice in two vocabularies is what this file exists to avoid.
      status: !tools.has('netifd')
        ? 'unknown'
        : facts.services.netifd === 'stopped'
          ? 'bad'
          : facts.services.netifd === 'unknown'
            ? 'unknown'
            : 'ok',
      detail: !tools.has('netifd')
        ? 'The netifd binary is missing; the row above has the rest.'
        : facts.services.netifd === 'stopped'
          ? 'Installed, but not running. Every interface this module configures through UCI is brought up by netifd, so nothing applied here would take effect until it is started.'
          : facts.services.netifd === 'unknown'
            ? 'This router has no pidof, so whether netifd is running could not be checked.'
            : 'Running',
      required: false,
      install: null,
      card: 'core'
    },
    {
      key: 'fw4',
      title: 'Firewall4 (fw4 + nft)',
      // Installed but not loaded is a warning, not a failure: `fw4 reload` or a
      // firewall restart fixes it, which is a very different next step from the
      // fw3 router the `bad` branch is about.
      status: !hasFw4 ? 'bad' : facts.services.fw4 === 'stopped' ? 'warn' : 'ok',
      // No install entry on purpose: a router still on fw3 cannot be upgraded
      // into fw4 from here without taking its firewall down.
      detail: !hasFw4
        ? `Not found. ${FW4_MISSING}`
        : facts.services.fw4 === 'stopped'
          ? 'fw4 and nft are both installed, but no `inet fw4` table is loaded, so the firewall is not actually running. Masquerading for a managed pool will not happen until it is: `service firewall start` at a router shell.'
          : 'Present, with its ruleset loaded',
      required: false,
      install: null,
      card: 'firewall'
    },
    ipRuleCheck(facts),
    conflictCheck(facts),
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
      key: 'macvlan',
      title: 'macvlan (per-slot MACs)',
      status: hasMacvlan ? 'ok' : 'warn',
      detail: hasMacvlan
        ? 'Present. A direct-mode pool can give each slot its own MAC on one carrier.'
        : 'Not installed. Direct carrier mode with mac_mode auto rides one macvlan per slot; without this module those devices will not come up.',
      required: false,
      install: hasMacvlan ? null : 'macvlan',
      card: 'pppoe'
    },
    {
      key: 'dnsmasq',
      title: 'dnsmasq (DHCP leases)',
      // Installed-but-stopped is deliberately not `hasDnsmasq: false`. The
      // package is there, so offering to install it again would be nonsense;
      // what is wrong is the service, and that is what the detail says.
      status: !hasDnsmasq ? 'warn' : facts.services.dnsmasq === 'stopped' ? 'warn' : 'ok',
      detail: !hasDnsmasq
        ? 'Without it there are no DHCP leases to read, so the device table stays empty.'
        : facts.services.dnsmasq === 'stopped'
          ? 'Installed, but the service is not running. Nothing writes the lease file while it is down, so the device table empties out and WAN binding has nobody left to assign. Start it with `service dnsmasq start`.'
          : facts.services.dnsmasq === 'unknown'
            ? 'Present. This router has no pidof, so whether the service is running could not be checked.'
            : 'Present and running',
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
    spaceCheck(facts.overlayFreeKb, input.missingPackages > 0),
    {
      key: 'agent',
      title: 'Bored Manager agent',
      // A warning, never a failure. Everything this module does works without
      // it - slower, and without the safety net - so a router with none is a
      // router in compatibility mode, not a router with a fault.
      status: agent.usable ? 'ok' : agent.installed ? 'warn' : 'warn',
      detail: agent.usable
        ? `${agent.release} (module API ${agent.apiVersion}), schema ${agent.schema}`
        : agent.problem
          ? agent.problem
          : 'Not installed. This router is managed over SSH: everything works, but slower, and without snapshots or the commit-confirm safety net. Install it from Router packages, in Module settings.',
      required: false,
      install: null,
      card: 'agent'
    },
    // The two feature packages, which the agent reports in `provides`.
    //
    // Their own row each, rather than a line inside the agent's, because the
    // question they answer is different: the agent's row says whether this
    // module is talking to the router at all, and these say which half is doing
    // the work. A router with the agent and neither package is not broken and
    // is not in compatibility mode either - it has the safety net and does the
    // work over SSH - and nothing said that until there was somewhere to say it.
    featureCheck(
      agent,
      'binding',
      'One-to-one WAN binding',
      'bm-wanbind',
      'The router assigns clients itself: a lease binds in milliseconds rather than at the next poll, and the rules are written over netlink.',
      'Binding is done over SSH. It works, and it reconciles on a poll rather than on the lease, so a client waits up to one sweep for its WAN.'
    ),
    featureCheck(
      agent,
      'pppoe',
      'PPPoE Dialer',
      'bm-pppoe-pool',
      'The router owns its pools end to end: interfaces, VLANs or direct slots, MACs, routing tables and the firewall zone are all derived and reconciled on the router itself.',
      'PPPoE Dialer needs it: this module composes and reads pools through the daemon and writes none of it over SSH.',
      PPPOE_POOL_API
    ),
    {
      key: 'guard',
      title: 'Change safety net',
      status: !agent.usable ? 'unknown' : agent.canGuard ? 'ok' : 'warn',
      detail: !agent.usable
        ? 'Only the agent can provide this; the row above says why there is none.'
        : agent.canGuard
          ? agent.guard
            ? `A guard is armed on snapshot ${agent.guard.snapshot}, ${Math.max(agent.guard.remaining, 0)}s left. Nothing confirms it and this router puts the change back on its own.`
            : 'Changes are applied under a countdown that restores the router if nothing confirms them.'
          : 'This agent is too old to arm a countdown. Update the router packages.',
      required: false,
      install: null,
      card: 'agent'
    }
  ]
}
