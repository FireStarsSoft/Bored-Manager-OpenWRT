/**
 * The object the module holds, and the only thing outside this folder sees.
 *
 * One runtime per module instance, because a token names a router: clearing it
 * when the connection points somewhere else clears every outstanding check at
 * once, and there is nowhere for one to survive into a different machine.
 */
import { createCheckSession } from '@shared/check'
import type { ModuleCheckReport } from '@shared/check'
import type { OkResult } from '@shared/types'
import { applyInstall, checkInstall, pinnedSummary } from './install'
import { unstage } from './stage'
import { applyUninstall, checkUninstall } from './uninstall'
import type {
  AgentDomainDeps,
  AgentRuntime,
  FrozenInstallPlan,
  FrozenUninstallPlan
} from './types'

/** One row of the Router packages table. */
export interface PackageRow {
  name: string
  /** What the router has, or an empty string when it has none. */
  installed: string
  /** What this module build would install. */
  pinned: string
  /** running / stopped / not installed. */
  status: string
  detail: string
}

export class AgentManager {
  private runtime: AgentRuntime

  constructor(deps: AgentDomainDeps) {
    this.runtime = {
      deps,
      install: createCheckSession<FrozenInstallPlan>(),
      uninstall: createCheckSession<FrozenUninstallPlan>(),
      staged: null
    }
  }

  installCheck(values: unknown): Promise<ModuleCheckReport> {
    return checkInstall(this.runtime, values)
  }

  installApply(payload: unknown): OkResult {
    return applyInstall(this.runtime, payload)
  }

  uninstallCheck(values: unknown): Promise<ModuleCheckReport> {
    return checkUninstall(this.runtime, values)
  }

  uninstallApply(payload: unknown): Promise<OkResult> {
    return applyUninstall(this.runtime, payload)
  }

  /**
   * The table on the settings page.
   *
   * Built even when nothing is installed, because a table of packages a router
   * could have is what tells somebody there is something to install - an empty
   * table with "nothing here" says the opposite.
   */
  rows(): PackageRow[] {
    const agent = this.runtime.deps.agent()
    const pinned = pinnedSummary()
    const pinnedFor = new Map(pinned.packages.map((entry) => [entry.name, pinned.release]))

    const known = new Set<string>(['bm-agent', ...pinnedFor.keys()])
    for (const name of agent.provides) {
      if (name === 'binding') known.add('bm-wanbind')
      if (name === 'pppoe') known.add('bm-pppoe-pool')
      // One row, not two: the translation archives are part of the LuCI app
      // rather than something to install or remove on their own, and a table
      // that listed each language separately would be a table about packaging.
      if (name === 'luci') known.add('luci-app-bm')
    }

    return [...known].sort().map((name) => {
      // Only the agent reports its own version; a feature package is reported
      // by the capability it provides, so its version is the agent's release -
      // they ship together and are checked to agree at build time.
      const installed = agent.installed ? agent.release : ''
      const status = !agent.installed
        ? 'not installed'
        : agent.running
          ? 'running'
          : 'stopped'

      return {
        name,
        installed,
        pinned: pinnedFor.get(name) ?? '',
        status,
        detail: !agent.installed
          ? 'This router is managed over SSH.'
          : (agent.problem ?? `module API ${agent.apiVersion}, schema ${agent.schema}`)
      }
    })
  }

  /** A token describes one router; the machine behind this context changed. */
  async reset(): Promise<void> {
    this.runtime.install.clear()
    this.runtime.uninstall.clear()
    const staged = this.runtime.staged
    this.runtime.staged = null
    if (staged) await unstage(this.runtime.deps, staged)
  }

  dispose(): void {
    this.runtime.install.clear()
    this.runtime.uninstall.clear()
    // Deliberately no `unstage` here: dispose is the last thing that may touch
    // `ctx`, and a module the host has stopped may not send a command. A few
    // hundred kilobytes in tmpfs goes at the next reboot.
    this.runtime.staged = null
  }
}
