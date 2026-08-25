/**
 * The state the free functions in this folder take as their first argument, and
 * the dependency shape the module fills in.
 *
 * There is only one piece of mutable state here - the check session - but it is
 * the important one: a token names a router, and `SetupManager` owns exactly
 * one runtime so that clearing it clears every token at once.
 */
import { createCheckSession, type CheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { JobSpec, OpenWrtJob } from '../jobs'
import type { PackageGroupKey } from '../packages'
import type { OpenWrtCapabilities, PackageManager } from '../probe'

/** What the runner needs from `Jobs`, without inheriting its generic. */
export interface SetupJobs {
  readonly busy: boolean
  start(spec: JobSpec): OpenWrtJob
}

export interface SetupDeps {
  capabilities: () => OpenWrtCapabilities
  /** Re-runs the probe and publishes the new verdict. */
  reprobe: () => Promise<OpenWrtCapabilities>
  jobs: SetupJobs
  event: (kind: string, text: string) => void
}

export interface FrozenSetupPlan {
  manager: PackageManager
  /** The user asked for groups the probe already reports as present. */
  repair: boolean
  groups: readonly PackageGroupKey[]
  packages: readonly string[]
}

export interface SetupRuntime {
  ctx: ModuleContext
  deps: SetupDeps
  session: CheckSession<FrozenSetupPlan>
}

export function createSetupRuntime(ctx: ModuleContext, deps: SetupDeps): SetupRuntime {
  return { ctx, deps, session: createCheckSession<FrozenSetupPlan>() }
}

/** A token describes a router; a different router must not be able to spend it. */
export function resetRuntime(runtime: SetupRuntime): void {
  runtime.session.clear()
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
