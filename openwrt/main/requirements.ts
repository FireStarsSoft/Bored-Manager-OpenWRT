/**
 * What every method needs from the router, in one table.
 *
 * This is the answer to a fault the module carried for a long time: the two
 * create forms checked capabilities by hand, in two hand-written `if` chains,
 * and nothing else checked anything. `bindingApply` would happily apply a plan
 * the check had refused; `bindingStart` on an instance created months ago never
 * asked again whether `ip rule` still worked, so a router that had lost
 * `ip-full` answered a start with a shell error rather than a sentence. And a
 * method added tomorrow arrived with no gate at all, silently.
 *
 * So the mapping lives here instead, declared once per method, and
 * `runtime/handlers.ts` routes every single `ctx.handle` through it.
 * `scripts/check-requirements.mjs` fails the build when the two lists disagree,
 * which is what makes "every future feature checks its requirements first" a
 * property of the repository rather than a promise in a document.
 *
 * Two rules keep it honest:
 *
 * - **One condition, one sentence.** A requirement is described in exactly one
 *   place - the `REQUIREMENTS` table below - and features name it by key. The
 *   alternative is what `APK_REQUIRED` and `FW4_MISSING` were introduced to
 *   stop: the same missing package described in three vocabularies, each drifting
 *   away from the others the moment one was edited.
 * - **Silence is not "needs nothing".** A read-only method is written out as an
 *   explicit `null`, so a method that was simply forgotten is distinguishable
 *   from one deliberately left open.
 */
import { failedCheck, type ModuleCheckFinding, type ModuleCheckReport } from '@shared/check'
import type { OkResult } from '@shared/types'
import {
  FW4_MISSING,
  featureApi,
  hasPoolDaemon,
  installHint,
  PPPOE_POOL_API,
  type AgentCapability,
  type OpenWrtCapabilities
} from './probe'

// The one gate that is not about a package being present but about which
// contract it speaks. Reached through the agent client rather than reimplemented
// here, so the sentence a page shows and the call a page would have made agree
// about the same router.
import { hasBindingDaemon, wanbindApi, WANBIND_API } from './agent'

// Written in `probe/text.ts` so the readiness card can say the same thing;
// re-exported here because this is where every create-form gate looks for it.
export { installHint }

const UNPROBED_TITLE = 'The router has not been checked yet'
const UNPROBED_DETAIL =
  'Open Module settings and run Check again first, so this page knows what is actually missing.'

/**
 * Nothing has been read off this router yet, so every capability below is
 * false by default rather than by observation. Without this the create forms
 * assert that a perfectly healthy router is missing PPPoE, and then hand out
 * install instructions for it.
 */
export function unprobed(caps: OpenWrtCapabilities): ModuleCheckReport | null {
  return caps.probed ? null : failedCheck(UNPROBED_TITLE, UNPROBED_DETAIL)
}

/** Everything a feature may demand of a router, by name. */
export type RequirementKey =
  | 'pppoe'
  | 'pppoePool'
  | 'bindingDaemon'
  | 'fw4'
  | 'fw4Loaded'
  | 'dnsmasq'
  | 'dnsmasqRunning'
  | 'netifdRunning'

/**
 * Why this router cannot be driven for WAN Binding, or ''.
 *
 * Three separate facts, kept apart because they need three different things
 * done about them and folding them together would send somebody to reinstall an
 * agent they can see running. Exported because the pages need the same sentence
 * the requirement gate would have given them: a leaf that renders empty rows
 * with no explanation is the thing this module keeps promising not to do.
 */
export function bindingDaemonProblem(agent: AgentCapability): string {
  if (hasBindingDaemon(agent)) return ''

  if (!agent.usable) {
    return (
      'WAN Binding is owned end to end by bm-wanbind on the router, and there is no ' +
      'Bored Manager agent to reach it through. Install the router packages from Router ' +
      'packages, in Module settings.'
    )
  }

  if (!agent.provides.includes('binding')) {
    return 'This router has the agent but not bm-wanbind. Install it from Router packages, in Module settings.'
  }

  return (
    `The installed bm-wanbind speaks version ${wanbindApi(agent)} of its contract and this ` +
    `module drives ${WANBIND_API}. Update the router packages from Router packages, in Module ` +
    'settings; the instances and bindings it holds keep working meanwhile.'
  )
}

/** Everything a feature may demand be *absent*. Reported, never refused. */
export type ConflictKey = 'mwan3' | 'foreignRules'

interface RequirementSpec {
  /** The refusal headline. About the router, not about the feature. */
  title: string
  /** True when this router meets it. */
  met(caps: OpenWrtCapabilities): boolean
  /** The sentence under the headline: what to do about it. */
  detail(caps: OpenWrtCapabilities): string
}

/**
 * The one place each condition is worded.
 *
 * The three `*Running` entries are satisfied by `unknown` on purpose. That
 * state means the router has no `pidof` to answer with, not that the service is
 * down, and refusing a user's apply over a missing BusyBox applet would be a
 * fault invented out of thin air. Only an observed `stopped` refuses.
 */
const REQUIREMENTS: Record<RequirementKey, RequirementSpec> = {
  pppoe: {
    title: 'PPPoE support is missing on this router',
    met: (caps) => caps.hasPppoe,
    detail: (caps) => installHint(caps, 'ppp, ppp-mod-pppoe and kmod-pppoe')
  },
  pppoePool: {
    title: 'The pool daemon this module drives is not on this router',
    met: (caps) => hasPoolDaemon(caps.agent),
    detail: (caps) => {
      if (!caps.agent.usable) {
        return (
          'PPPoE Dialer pools are owned end to end by bm-pppoe-pool 2.x on the router, and there is no ' +
          'Bored Manager agent to reach it through. Install the router packages from Router ' +
          'packages, in Module settings.'
        )
      }
      if (!caps.agent.provides.includes('pppoe')) {
        return 'This router has the agent but not bm-pppoe-pool. Install it from Router packages, in Module settings.'
      }
      return (
        `The installed bm-pppoe-pool speaks version ${featureApi(caps.agent, 'pppoe')} of its contract and this ` +
        `module drives ${PPPOE_POOL_API}. Update the router packages from Router packages, in Module settings; ` +
        'the pools it holds keep dialling meanwhile.'
      )
    }
  },
  bindingDaemon: {
    title: 'The binding daemon this module drives is not on this router',
    met: (caps) => hasBindingDaemon(caps.agent),
    detail: (caps) => bindingDaemonProblem(caps.agent) || ''
  },
  fw4: {
    title: 'Firewall4 is required, and this router does not have it',
    met: (caps) => caps.hasFw4,
    detail: () => FW4_MISSING
  },
  fw4Loaded: {
    title: 'The firewall is installed but not running',
    met: (caps) => caps.services.fw4 !== 'stopped',
    detail: () =>
      'fw4 and nft are both present, but no `inet fw4` table is loaded, so nothing is masquerading and a managed pool would carry no client traffic. Start it with `service firewall start` at a router shell, then run Check again.'
  },
  dnsmasq: {
    title: 'dnsmasq is missing on this router',
    met: (caps) => caps.hasDnsmasq,
    detail: (caps) => installHint(caps, 'dnsmasq')
  },
  dnsmasqRunning: {
    title: 'dnsmasq is installed but not running',
    met: (caps) => caps.services.dnsmasq !== 'stopped',
    detail: () =>
      'Nothing writes the DHCP lease file while it is down, so there are no devices to discover and every binding instance would sit empty with no reason given. Start it with `service dnsmasq start` at a router shell, then run Check again.'
  },
  netifdRunning: {
    title: 'netifd is installed but not running',
    met: (caps) => caps.services.netifd !== 'stopped',
    detail: () =>
      'netifd is what brings up every interface this module writes through UCI, so nothing applied here would take effect until it is started: `service network restart` at a router shell.'
  }
}

interface ConflictSpec {
  /** True when this router has the conflict. */
  present(caps: OpenWrtCapabilities): boolean
  /** The warning, worded for a report the user reads before applying. */
  finding(caps: OpenWrtCapabilities): ModuleCheckFinding
}

/**
 * Warnings, never refusals.
 *
 * A router with policy routing of its own is a router somebody set up that way,
 * and this module has no business overruling that. What it does have business
 * doing is saying so before an apply, because this is the one fault that leaves
 * every other surface looking correct: the fast sweep filters `ip rule show`
 * down to the managed window on the router, so a rule below that window steers
 * every packet and appears nowhere in this module at all.
 */
const CONFLICTS: Record<ConflictKey, ConflictSpec> = {
  mwan3: {
    present: (caps) => caps.mwan3.config,
    finding: (caps) => ({
      level: 'warning',
      label: `mwan3 is installed on this router${caps.mwan3.running ? ' and running' : ''}`,
      detail: `It writes its own ip rules far below preference ${caps.rulePrefBase}, and the lowest preference wins - so a device this module binds to one WAN can still leave by another, with nothing here to show for it. Run one or the other, not both.`
    })
  },
  foreignRules: {
    present: (caps) => caps.foreignRuleCount > 0 && !caps.mwan3.config,
    finding: (caps) => {
      const shown = caps.foreignRules.slice(0, 3)
      const rest = caps.foreignRuleCount - shown.length
      return {
        level: 'warning',
        label: `${caps.foreignRuleCount} ip rule(s) outrank the ones this module writes`,
        detail: `${shown
          .map((rule) => `${rule.pref}: ${rule.text}`)
          .join('; ')}${
          rest > 0 ? `, and ${rest} more` : ''
        }. They sit below preference ${caps.rulePrefBase}, and the lowest preference wins, so the bindings below can read as applied while those decide where the traffic actually goes.`
      }
    }
  }
}

/**
 * What one method is, and what it needs.
 *
 * `kind` decides the shape of a refusal, and is declared rather than guessed
 * from the method name: a `checkForm` expects a `ModuleCheckReport` and renders
 * its findings, while an action button expects an `OkResult` and shows `error`
 * as a toast. Handing either one the other's shape produces a control that
 * fails silently.
 */
export interface FeatureSpec {
  kind: 'check' | 'action'
  /** Refusals, in the order they are reported: most fundamental first. */
  requires: readonly RequirementKey[]
  /** Warnings folded into a check report. Only meaningful for `kind: 'check'`. */
  conflicts?: readonly ConflictKey[]
  /**
   * Reserved for the router-side agent: which of its features this method uses
   * once one is installed, and whether it is required rather than preferred.
   * Nothing reads it yet - the slot exists so adding the agent is a value here
   * rather than another gate somewhere else.
   */
  agent?: { feature: string; required: boolean }
  /**
   * Whether this method's writes have to run under the router's commit-confirm
   * guard, so a change that cuts the connection undoes itself. Reserved the
   * same way `agent` is.
   */
  guard?: boolean
}

/**
 * Everything the pool forms and their applies demand of a router, most
 * fundamental first: the dialing stack and the firewall are firmware-level,
 * the pool daemon is an installable package.
 */
const PPPOE_CREATE: readonly RequirementKey[] = [
  'pppoe',
  'fw4',
  'fw4Loaded',
  'pppoePool',
  'netifdRunning'
]
const BINDING_CREATE: readonly RequirementKey[] = [
  'bindingDaemon',
  'fw4',
  'fw4Loaded',
  'dnsmasq',
  'dnsmasqRunning',
  'netifdRunning'
]

/**
 * A hand-placed one-to-one binding asks for less than an instance does, and
 * the difference is dnsmasq. An instance exists to distribute whatever DHCP
 * hands out, so a router with no lease file has nothing for it to do; a 1-1
 * binding on a typed address does not care whether anything is leasing at all,
 * and refusing it on a missing dnsmasq would block the one kind of binding
 * that still works on a router with static clients. A MAC target does need the
 * lease file, and says so as a finding in the check rather than as a refusal
 * here - the address may simply be offline this minute.
 */
const DIRECT_CREATE: readonly RequirementKey[] = [
  'bindingDaemon',
  'fw4',
  'fw4Loaded',
  'netifdRunning'
]

/**
 * What a one-to-one binding needs, on a router that owns every one of them.
 *
 * The work moved; most of what the work needs did not, and that is worth saying
 * because it is not obvious. The daemon still writes a firewall forwarding,
 * which needs fw4 loaded, and it still asks netifd which table a WAN puts its
 * routes in. A router missing either refuses the create for exactly the reason
 * it always did, in the same sentence, whether the refusal comes from here or
 * from the daemon a moment later.
 *
 * The one that went is `ipRule`, and it went rather than being loosened. It
 * asked whether this module's `ip` binary could steer traffic by routing table,
 * which was the right question while this module wrote the rules; the daemon
 * writes them over netlink and never opens `/sbin/ip`, so the question no
 * longer has a bearing on anything. `ip-full` is still offered under Router
 * readiness, because a router somebody administers by hand is better off with
 * it, and the readiness card still reports what it found - but nothing here is
 * gated on it, and a requirement nothing gates on is a sentence waiting to be
 * said about the wrong router.
 *
 * The other entry that would have been wrong to keep - a ceiling on the records
 * this module stores - is not a requirement at all and lives in the create gate,
 * which skips it on that half.
 */

/**
 * Every method name in `openwrt/module.json`, and what it needs.
 *
 * `null` means the method reads and nothing else: it opens no SSH session,
 * writes nothing, and must keep answering on a router that cannot do anything
 * at all - a table that refuses to render is strictly worse than an empty one
 * that says why. It is spelled out rather than left absent so that a method
 * somebody forgot is not mistaken for one deliberately left open.
 *
 * An action with `requires: []` is a different statement: it writes, and it
 * still needs nothing. Those are the cleanup and settings paths, and each one
 * carries the reason on the line above it - refusing to delete a pool because
 * the router lost the package that dials it would leave the user with a pool
 * they cannot get rid of.
 */
export const FEATURES: Record<string, FeatureSpec | null> = {
  // Reads. Every one of these feeds a table or a chip that has to keep
  // rendering on a router in any state whatsoever.
  selectOptions: null,
  deviceRows: null,
  pppoePools: null,
  pppoeRows: null,
  pppoeLegacyRows: null,
  // The carrier list a create form offers. A read of the router, and one that
  // answers `[]` with the reason in the row rather than refusing the form.
  pppoeCarriers: null,
  pppoeSettingsGet: null,
  bindingRows: null,
  bindingWaitingRows: null,
  bindingEventRows: null,
  eventRows: null,
  rulesEffective: null,
  // The sentence that says what is in the way. Gating it on the router being
  // able to do things would be a joke at the user's expense.
  installHint: null,

  // The re-check path itself. It refuses on its own terms - not connected, or
  // a blocking problem the probe just found - and it is the only way out of a
  // stale verdict, so nothing derived from that verdict may stand in its way.
  sweepNow: { kind: 'action', requires: [] },
  // Module-local display setting; never touches the router.
  hintsSet: { kind: 'action', requires: [] },

  // The install flow. Gating it on the packages it exists to install would be
  // a loop with no way out; it does its own checking in `setup/plan.ts`.
  setupCheck: { kind: 'check', requires: [] },
  setupApply: { kind: 'action', requires: [] },

  poolCreateCheck: { kind: 'check', requires: PPPOE_CREATE, conflicts: ['mwan3'] },
  // The gap this table was written for: the check refused, and then the apply
  // ran anyway on a token issued before the router lost something.
  poolCreateApply: { kind: 'action', requires: PPPOE_CREATE },
  // Editing an existing pool is the same writes as creating one.
  poolSetCheck: { kind: 'check', requires: PPPOE_CREATE, conflicts: ['mwan3'] },
  poolSetApply: { kind: 'action', requires: PPPOE_CREATE },
  // Start/stop/redial/enable/disable, per row or per pool. All of them are
  // daemon calls - enable and disable write `option auto` on the router - so
  // they need the daemon, not the dialing stack.
  pppoePoolAction: { kind: 'action', requires: ['pppoePool'] },
  pppoeConnAction: { kind: 'action', requires: ['pppoePool'] },
  // Deleting goes through the daemon too: it is the only thing that knows
  // everything a pool derived. A router that lost the package cannot delete
  // until it is back, and the refusal says to reinstall it - which is also
  // the only path that ever removes the pool.
  poolDelete: { kind: 'action', requires: ['pppoePool'] },
  // The daemon's own watchdog and counter settings.
  pppoeSettingsCheck: { kind: 'check', requires: ['pppoePool'] },
  pppoeSettingsApply: { kind: 'action', requires: ['pppoePool'] },

  bindingCheck: { kind: 'check', requires: BINDING_CREATE, conflicts: ['mwan3', 'foreignRules'] },
  bindingApply: { kind: 'action', requires: BINDING_CREATE },
  // Renaming an instance and flipping its two behaviour flags. It touches
  // nothing on the router at all - the planner reads the three fields on its
  // next pass - so requiring anything of the router would be a refusal invented
  // for the sake of symmetry, on the one screen a user reaches when something
  // is already wrong.
  bindingUpdate: { kind: 'action', requires: ['bindingDaemon'] },
  // Asked again on every start, not just at creation. An instance made months
  // ago on a router that has since lost `ip-full` used to answer a start with a
  // shell error from the middle of a reconcile.
  bindingStart: { kind: 'action', requires: BINDING_CREATE },
  // Stop and delete are the way out of a broken state; they never refuse.
  //
  // They still need the daemon, and that is not the same thing as refusing
  // them: a router with no daemon has no instance to stop, so the gate can
  // never be the reason somebody is stuck with one they cannot remove.
  bindingStop: { kind: 'action', requires: ['bindingDaemon'] },
  bindingDelete: { kind: 'action', requires: ['bindingDaemon'] },
  // All three are one ubus call to the router, which either does it or says
  // why. There is nothing left here for an `ip` binary to fail at.
  bindingUnassign: { kind: 'action', requires: ['bindingDaemon'] },
  bindingReassign: { kind: 'action', requires: ['bindingDaemon'] },
  bindingPin: { kind: 'action', requires: ['bindingDaemon'] },

  // The hand-placed one-to-one bindings. The reads answer on any router at
  // all, for the same reason every other read here does.
  directRows: null,
  directCheck: { kind: 'check', requires: DIRECT_CREATE, conflicts: ['mwan3', 'foreignRules'] },
  directApply: { kind: 'action', requires: DIRECT_CREATE },
  // Switching one back on puts a rule and a firewall path on the router, so it
  // is gated exactly as the apply is.
  directEnable: { kind: 'action', requires: DIRECT_CREATE },
  // Lighter than `directEnable` above **in this table**, and the rest of the
  // difference is made up in `runtime/handlers.ts`. Both halves are needed and
  // neither is enough alone.
  //
  // Two of this form's three fields have to go through on a router that can do
  // nothing else at all: a rename, and switching a binding *off*. The way out
  // of a broken state is never refused, and refusing a rename on the router
  // where somebody most wants to label what is wrong is a gate for its own
  // sake. A standing list cannot express that, because whether a Save is an
  // enable depends on the values submitted and on what the binding currently
  // is - so the list here holds only what all three fields need, and the handler
  // escalates the one case that needs more, reading the sentence off
  // `directEnable`'s own entry so the two doors cannot be worded apart.
  //
  // This entry did briefly carry no escalation at all, on the reasoning that
  // the daemon would report the problem back. It does not. `bind` in
  // `service.uc` contains no firewall test of any kind: it writes the section
  // and runs a pass, the rule goes in over netlink - which needs no fw4, no nft
  // and no `ip` binary - and the row comes back `bound`. The daemon prepares a
  // forwarding only for `missing` and `wrong`; a router with no firewall zones
  // answers `no-zone`, which it declines to act on and does not log. So the
  // save landed, the page went green, and nothing was forwarding. That is the
  // failure this release exists to abolish, reintroduced by trusting a report
  // that is not made.
  //
  // The row now carries the daemon's `forwarding` field, which the module was
  // dropping, so the cases no gate can reach - a binding enabled before fw4 was
  // removed, or enabled at a router shell - say so on the page. The gate and
  // the chip cover different halves and neither replaces the other.
  directUpdate: { kind: 'action', requires: ['bindingDaemon'] },
  // The way out of a broken state is never refused for anything but the one
  // thing that would make it impossible: a router with no daemon has no
  // binding to switch off, so this gate cannot strand anybody.
  directDisable: { kind: 'action', requires: ['bindingDaemon'] },
  directDelete: { kind: 'action', requires: ['bindingDaemon'] },

  // The binding monitor. Its whole purpose is to describe a router whose
  // routing somebody else is deciding, so requiring anything of that router
  // before it will look would be a refusal aimed at the one page written to
  // explain the refusals.
  scanRows: null,
  scanNow: { kind: 'action', requires: ['bindingDaemon'] },

  // The daemon's own numbers - the priority bands, the catch-all table and the
  // timers an instance is stamped with when it is created. They were module
  // settings until 3.4.0, which meant this side held an opinion about numbers
  // the rules standing on the router had been written against.
  bindingSettingsGet: null,
  bindingSettingsCheck: { kind: 'check', requires: ['bindingDaemon'] },
  bindingSettingsApply: { kind: 'action', requires: ['bindingDaemon'] },

  // The rules editor writes numbers into this module's own configuration. It
  // has its own validation, and it must stay usable on a router with problems -
  // widening a preference range is sometimes the fix.
  rulesCheck: { kind: 'check', requires: [] },
  rulesApply: { kind: 'action', requires: [] },
  rulesReset: { kind: 'action', requires: [] },
  // The router-wide scale limits. Reads answer always; the check and apply do
  // their own gating - no router connected, no slow-sweep answer yet - because
  // raising conntrack is sometimes the fix for the very state a capability
  // gate would refuse on, and the write path is chosen per apply (the agent
  // when it is 2.1.0+, SSH when it is not).
  limitsEffective: null,
  limitsCheck: { kind: 'check', requires: [] },
  limitsApply: { kind: 'action', requires: [] },
  // Job bookkeeping, module-side only.
  jobCancel: { kind: 'action', requires: [] },
  jobsClear: { kind: 'action', requires: [] },

  // The Router packages table. A read, and one that has to keep answering on a
  // router with nothing installed - which is the router it exists for.
  agentRows: null,
  // Installing and removing the router-side packages. Gated on nothing here for
  // the same reason `setupCheck` is: these are the flows that put a router into
  // the state everything else asks for, so requiring any of it would be a loop
  // with no way out. Each does its own checking, in far more detail than a
  // capability flag could carry - including refusing to remove packages from
  // under a running binding instance, by name.
  agentInstallCheck: { kind: 'check', requires: [] },
  agentInstallApply: { kind: 'action', requires: [] },
  agentUninstallCheck: { kind: 'check', requires: [] },
  agentUninstallApply: { kind: 'action', requires: [] }
}

/**
 * The refusal this method owes the caller, or null to let it through.
 *
 * A method with no requirements is never delayed by an unprobed router: those
 * are the reads, the cleanups and the re-check path, and making them wait for a
 * probe would leave a freshly connected router with nothing working for the
 * first few seconds and no explanation.
 */
export function requirementRefusal(
  name: string,
  caps: OpenWrtCapabilities
): ModuleCheckReport | OkResult | null {
  const spec = FEATURES[name]
  // Unknown to the table. The build is what catches this - see
  // `scripts/check-requirements.mjs` - because failing closed here would turn a
  // forgotten registry entry into a dead button nothing explains.
  if (!spec || spec.requires.length === 0) return null
  if (!caps.probed) {
    return spec.kind === 'check'
      ? failedCheck(UNPROBED_TITLE, UNPROBED_DETAIL)
      : { ok: false, error: `${UNPROBED_TITLE}. ${UNPROBED_DETAIL}` }
  }
  for (const key of spec.requires) {
    const requirement = REQUIREMENTS[key]
    if (requirement.met(caps)) continue
    const detail = requirement.detail(caps)
    return spec.kind === 'check'
      ? failedCheck(requirement.title, detail)
      : { ok: false, error: `${requirement.title}. ${detail}` }
  }
  return null
}

/**
 * The warnings a check report should carry alongside its own findings. Empty
 * for everything that declares no conflicts, and for a router nobody has
 * probed - a conflict nobody looked for is not a conflict anybody found.
 */
export function requirementWarnings(
  name: string,
  caps: OpenWrtCapabilities
): ModuleCheckFinding[] {
  const spec = FEATURES[name]
  if (!spec?.conflicts?.length || !caps.probed) return []
  return spec.conflicts
    .filter((key) => CONFLICTS[key].present(caps))
    .map((key) => CONFLICTS[key].finding(caps))
}
