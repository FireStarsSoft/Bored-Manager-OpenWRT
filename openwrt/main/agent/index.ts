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
  wanbindFlush,
  wanbindInfo,
  wanbindInstanceLines,
  wanbindPin,
  wanbindReassign,
  wanbindReconcile,
  wanbindRelease,
  wanbindRemoveLines,
  wanbindSection,
  wanbindStats,
  wanbindUnassign,
  wanbindWaiting,
  type WanbindAssignment,
  type WanbindInfo,
  type WanbindInstance,
  type WanbindStats,
  type WanbindWaiting
} from './wanbind'
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
