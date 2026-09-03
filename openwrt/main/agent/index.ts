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
  CAPACITY_AGENT_RELEASE,
  agentCapacity,
  type RawCapacity,
  type RawCapacityFinding,
  type RawCapacityFix,
  type RawCapacityTier
} from './capacity'
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
  wanbindInfo,
  wanbindInstanceCheck,
  wanbindInstanceDelete,
  wanbindInstanceSet,
  wanbindRules,
  wanbindRuleExplain,
  // The 2.4.0 contract, and the only one: the module asks the daemon and
  // writes nothing itself.
  wanbindBind,
  wanbindBindings,
  wanbindUnbind,
  wanbindUnbindMany,
  wanbindAssignments,
  wanbindWaiting,
  wanbindLayout,
  // Neither of these exists in the older file, so they take their plain names:
  // writing the main section, and the interface list the forms open on.
  wanbindSettingsSet,
  wanbindWans,
  // The five that move one client between WANs, and the two that ask the
  // daemon to reconcile or to take everything off. They were the older file's
  // until this release; they are the same ubus methods and this is now the
  // only wrapper for them.
  wanbindPin,
  wanbindReassign,
  wanbindUnassign,
  wanbindRelease,
  wanbindReconcile,
  wanbindFlush
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
  type WanbindSettings,
  type WanbindVerdict,
  type WanbindWaiting,
  type WanbindWan
} from './wanbind-types'
export type {
  WanbindRulesReply,
  WanbindRuleExplainReply,
  WanbindWaitingReply
} from './wanbind-monitor-types'

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
