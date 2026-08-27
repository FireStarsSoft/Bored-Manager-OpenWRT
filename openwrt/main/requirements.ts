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
  type OpenWrtCapabilities
} from './probe'

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
  | 'fw4'
  | 'fw4Loaded'
  | 'ipRule'
  | 'dnsmasq'
  | 'dnsmasqRunning'
  | 'netifdRunning'

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
  ipRule: {
    // Not "has no rule support": BusyBox's applet lists rules perfectly well
    // and refuses only the numeric routing tables, which is the whole of what
    // binding asks of it. The readiness card carries the three reasons apart;
    // this is the one sentence a refused apply gets.
    title: 'This router cannot steer traffic by routing table',
    // Met by the binary this module writes through - or by the router's own
    // binding daemon. With bm-wanbind installed the module never writes an ip
    // rule itself: every bind goes over ubus and the daemon writes netlink,
    // so refusing on the module's own `ip` binary would block work the router
    // is demonstrably doing. The readback the fast sweep does works on the
    // BusyBox applet either way.
    met: (caps) =>
      caps.hasIpRule || (caps.agent.usable && caps.agent.provides.includes('binding')),
    detail: (caps) =>
      caps.ip.fullPresent
        ? `Router readiness, in Module settings, has the reason - iproute2 is on this router and \`ip\` is not resolving to it, or this kernel has no policy routing. Neither is fixed by installing a package.`
        : installHint(caps, 'ip-full')
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
  'fw4',
  'fw4Loaded',
  'ipRule',
  'dnsmasq',
  'dnsmasqRunning',
  'netifdRunning'
]

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
  bindingUpdate: { kind: 'action', requires: [] },
  // Asked again on every start, not just at creation. An instance made months
  // ago on a router that has since lost `ip-full` used to answer a start with a
  // shell error from the middle of a reconcile.
  bindingStart: { kind: 'action', requires: BINDING_CREATE },
  // Stop and delete are the way out of a broken state; they never refuse.
  bindingStop: { kind: 'action', requires: [] },
  bindingDelete: { kind: 'action', requires: [] },
  // All three write a rule, so an `ip` that cannot write one is worth naming
  // rather than letting the next reconcile fail somewhere the user cannot see.
  bindingUnassign: { kind: 'action', requires: ['ipRule'] },
  bindingReassign: { kind: 'action', requires: ['ipRule'] },
  bindingPin: { kind: 'action', requires: ['ipRule'] },

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
