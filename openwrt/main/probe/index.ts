/**
 * What the connected machine can do, and whether this module can manage it.
 *
 * Three files behind one door: `types.ts` is the vocabulary, `command.ts` asks
 * the router and reads the answers, `readiness.ts` turns those answers into the
 * verdict every surface renders. Import this barrel, never a file inside it.
 */
export {
  AGENT_API,
  AGENT_API_GUARD,
  AGENT_API_UPDATE,
  emptyAgentFacts,
  emptyFacts,
  type AgentCapability,
  type AgentFacts,
  type AgentGuard,
  type ForeignRule,
  type MissingPackage,
  type OpenWrtCapabilities,
  type PackageManager,
  type ProbeFacts,
  type ReadinessCard,
  type ReadinessCheck,
  type ReadinessChip,
  type ReadinessState,
  type ReadinessStatus,
  type ServiceState
} from './types'
export { installHint, type InstallContext } from './text'
export {
  APK_REQUIRED,
  FW4_MISSING,
  SPACE_BAD_KB,
  SPACE_WARN_KB,
  buildReadiness,
  emptyCapabilities,
  judgeAgent,
  opkgNotSupported
} from './readiness'
export { IP_FULL_PATH, PROBE_COMMAND, buildProbeCommand, freeKbFromDf, probeOpenWrt } from './command'
