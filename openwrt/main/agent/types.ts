/**
 * What the four install sources are, and what a check freezes into a token.
 *
 * The four exist because they have four different trust roots, not because
 * anybody wanted four buttons - see `manifest.ts` for the table. They converge
 * on one execution path, and that convergence is the point: a directory of
 * verified `.apk` files on the router, and one `apk add` over it. Adding a
 * fifth source later means adding a way to fill that directory, not another
 * installer.
 */
import type { CheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { JobSpec, OpenWrtJob } from '../jobs'
import type { AgentCapability, OpenWrtCapabilities } from '../probe'

export type InstallSource = 'pinned' | 'github' | 'bundle' | 'path'

export const INSTALL_SOURCES: readonly InstallSource[] = ['pinned', 'github', 'bundle', 'path']

export function isInstallSource(value: unknown): value is InstallSource {
  return typeof value === 'string' && (INSTALL_SOURCES as readonly string[]).includes(value)
}

/** One archive, wherever it came from and however it is going to be checked. */
export interface StagedPackage {
  name: string
  file: string
  sha256: string
  size: number
}

/**
 * What the apply is allowed to do, sealed into a one-use token by the check.
 *
 * Nothing a user typed survives into it as text that reaches a shell: a path is
 * validated and quoted, a bundle has already been unpacked and verified, and a
 * pinned download's URL and hash come from `manifest.ts`. What the token
 * carries is the decision, not the input.
 */
export interface FrozenInstallPlan {
  source: InstallSource
  /** The release being installed, as far as it is known. */
  release: string
  /**
   * A router-side directory holding files that have already been verified.
   * Empty for `pinned`, which downloads at apply time, and for `github`, where
   * the router does the whole thing itself.
   */
  dir: string
  /** Files to install, in order. `bm-agent` first: everything declares to it. */
  files: readonly StagedPackage[]
  /** Where `pinned` fetches from. Empty otherwise. */
  base: string
}

export interface FrozenUninstallPlan {
  /** Package names, in removal order - dependents before what they depend on. */
  packages: readonly string[]
  /** Also delete `/etc/config/bm_*` and `/etc/bm/`, except the baseline. */
  purge: boolean
}

/** What the agent domain needs from the rest of the module. */
export interface AgentDomainDeps {
  ctx: ModuleContext
  capabilities: () => OpenWrtCapabilities
  agent: () => AgentCapability
  /** Re-runs the probe and publishes the new verdict. */
  reprobe: () => Promise<OpenWrtCapabilities>
  jobs: { readonly busy: boolean; start(spec: JobSpec): OpenWrtJob }
  event: (kind: string, text: string) => void
  /** Named things that would have to be stopped before packages can go. */
  blockers: () => { instances: string[]; batches: string[]; bindings: string[] }
}

export interface AgentRuntime {
  deps: AgentDomainDeps
  install: CheckSession<FrozenInstallPlan>
  uninstall: CheckSession<FrozenUninstallPlan>
  /**
   * The staging directory the last check left on the router, so the next one
   * can take it away. An abandoned check would otherwise sit in tmpfs until the
   * router reboots, and a user who checks a bundle five times should not be
   * charged five copies of it.
   */
  staged: string | null
}
