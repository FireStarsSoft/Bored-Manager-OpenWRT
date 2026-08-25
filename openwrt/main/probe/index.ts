/**
 * What the connected machine can do, and whether this module can manage it.
 *
 * Three files behind one door: `types.ts` is the vocabulary, `command.ts` asks
 * the router and reads the answers, `readiness.ts` turns those answers into the
 * verdict every surface renders. Import this barrel, never a file inside it.
 */
export {
  emptyFacts,
  type MissingPackage,
  type OpenWrtCapabilities,
  type PackageManager,
  type ProbeFacts,
  type ReadinessCard,
  type ReadinessCheck,
  type ReadinessChip,
  type ReadinessState,
  type ReadinessStatus
} from './types'
export {
  APK_REQUIRED,
  FW4_MISSING,
  buildReadiness,
  emptyCapabilities,
  opkgNotSupported
} from './readiness'
export { PROBE_COMMAND, freeKbFromDf, probeOpenWrt } from './command'
