/**
 * The router-side agent, from this side of the connection.
 *
 * `manifest.ts` is what this module build is pinned to and why that is a trust
 * root; `client.ts` is one ubus call and the rule that a failure is a fall back
 * rather than an error; `guard.ts` wraps a change in the router's own undo;
 * `stage.ts` gets files onto the router and proves they are the right ones;
 * `install.ts` and `uninstall.ts` are the check-then-apply pairs; `manager.ts`
 * is the object the module holds.
 *
 * `wanbind.ts` and `pppoe.ts` are the two feature packages, each reached only
 * when the agent says its capability is installed. They are the reason
 * `client.ts` takes an object name at all: `bm.agent` is always there when the
 * agent is, and those two arrive with their own packages.
 *
 * Nothing here is required for the module to work. Every path it offers has an
 * SSH equivalent that predates it, and a router with no agent, an agent that is
 * stopped, or one from a release this module has not met all end in the same
 * place: the module drives the router the way it always did, and says so.
 *
 * Import this barrel, never a file inside it.
 */
export {
  AGENT_OBJECT,
  PPPOE_OBJECT,
  WANBIND_OBJECT,
  agentCall,
  featureRefusal,
  hasFeature,
  missingFeature,
  objectCall,
  unwrap,
  type AgentCallResult,
  type AgentDeps,
  type AgentFeature
} from './client'
export {
  poolAction,
  poolCarriers,
  poolCheck,
  poolCreate,
  poolDelete,
  poolInfo,
  poolReconcile,
  poolSessions,
  poolSet,
  poolSettingsGet,
  poolSettingsSet,
  poolStats,
  type PoolActionName,
  type PoolCarrier,
  type PoolCheckReply,
  type PoolFinding,
  type PoolInfo,
  type PoolInfoEntry,
  type PoolLegacyEntry,
  type PoolMemberInfo,
  type PoolRow,
  type PoolRowStatus,
  type PoolSetChange,
  type PoolSettings,
  type PoolSpec,
  type PoolSpecMember
} from './pppoe'
export {
  safeUciWord,
  wanbindAssignments,
  wanbindBind,
  wanbindBindings,
  wanbindFlush,
  wanbindInstanceLines,
  wanbindLayout,
  wanbindPin,
  wanbindReassign,
  wanbindReconcile,
  wanbindRelease,
  wanbindRemoveLines,
  wanbindSection,
  wanbindStats,
  wanbindUnassign,
  wanbindUnbind,
  wanbindWaiting,
  type WanbindBand,
  type WanbindBinding,
  type WanbindBindReply,
  type WanbindUnbindReply,
  type WanbindInstance,
  type WanbindStats
} from './wanbind'

// The 2.4.0 contract, beside the calls that predate it. The two files answer
// the same questions about two different generations of the daemon, and only
// one spelling of each name can leave this barrel - so a name they share is
// published from the newer file as soon as something outside `agent/` needs the
// newer shape, and the names below are those. Nothing outside this folder names
// the older ones, which is what makes that safe; `WanbindBinding` and
// `WanbindBand` stay on the old file because `direct/` still reads them from
// the old calls, and both halves go when the module stops writing rules.
export {
  hasBindingDaemon,
  wanbindApi,
  wanbindBindCheck,
  // `info` answers with the instance sections and their states from 2.4.0, and
  // with neither before it. Nothing outside `agent/` called the older one at
  // all, so the newer one simply takes the name.
  wanbindInfo,
  wanbindInstanceCheck,
  wanbindInstanceDelete,
  wanbindInstanceSet,
  // The whole rule table with an owner and a sentence per row. No older call
  // asks for it - the fast sweep only ever filtered `ip rule show` down to the
  // module's own priority window - so it takes its plain name.
  wanbindRules,
  // `bind`, `bindings` and `unbind` are spelled the same way by both
  // generations, and the two are not interchangeable: the older three are gated
  // on the `direct` capability, which no shipped package advertises, so on a
  // real router they refuse before they reach a shell - while these go through
  // `binding` like the rest of the 2.4.0 contract. `direct/` calls the older
  // three under the plain names and has to go on doing exactly what it does
  // today, so the newer three leave here under the generation they belong to.
  // The suffix goes when `direct/` does, and these become the only `bind`,
  // `bindings` and `unbind` in the module.
  wanbindBind as wanbindBindV2,
  wanbindBindings as wanbindBindingsV2,
  wanbindUnbind as wanbindUnbindV2,
  // `assignments` and `waiting` are the same ubus method in both generations;
  // what moved is the reply. A seat now says whether the kernel is actually
  // holding its rule, and a queue entry can now answer `reserved` - a device
  // the instance is deliberately leaving alone because a one-to-one binding
  // already decides its address. `binding/router.ts` reads the older shapes and
  // has to go on doing exactly what it does today, so these leave here under
  // the generation they belong to, and lose the suffix when it does.
  wanbindAssignments as wanbindAssignmentsV2,
  wanbindWaiting as wanbindWaitingV2,
  // `layout` is the same method in both generations, and the older wrapper is
  // gated on the `direct` capability no shipped package advertises - so on a
  // real router it refuses before it reaches a shell, which is precisely what a
  // dropdown must not do. `direct/check.ts` calls the older one under the plain
  // name and goes on doing exactly what it does today; the suffix goes with it.
  wanbindLayout as wanbindLayoutV2,
  // Neither of these exists in the older file, so they take their plain names:
  // writing the main section, and the interface list the forms open on.
  wanbindSettingsSet,
  wanbindWans
} from './wanbind-api'
export {
  WANBIND_API,
  type WanbindAssignment,
  type WanbindBindSpec,
  type WanbindBindingState,
  type WanbindBindingsReply,
  type WanbindInfo,
  type WanbindInstanceConfig,
  type WanbindInstanceSpec,
  type WanbindLayoutReply,
  // The monitor's whole vocabulary travels in this one shape: `scan/` names the
  // row and table types by indexing it rather than importing them separately,
  // so an owner the daemon learns cannot be missed by a union copied here.
  type WanbindRulesReply,
  type WanbindSettings,
  type WanbindVerdict,
  type WanbindWaiting,
  type WanbindWan
} from './wanbind-types'
export {
  TUNE_AGENT_RELEASE,
  agentAtLeast,
  tuneGet,
  tuneSet,
  type TuneApplied,
  type TuneState,
  type TuneValues,
  type TuneWanted
} from './tune'
export { armGuard, cancelGuard, confirmGuard, underGuard, type GuardState } from './guard'
export { guardedJobs, type JobStarter } from './jobs'
export { AgentManager, type PackageRow } from './manager'
export {
  NOTHING_PINNED,
  PINNED_PACKAGES,
  PINNED_RELEASE,
  hasPinnedRelease,
  type PinnedPackage
} from './manifest'
export { INSTALL_SOURCES, isInstallSource, type AgentDomainDeps, type InstallSource } from './types'
