/**
 * Taking the router packages off again.
 *
 * Two things make this more than an `apk del`.
 *
 * The first is that the module refuses while anything is still running on top
 * of the packages, and names it. A binding instance whose rules the agent is
 * maintaining, or a PPPoE pool it dialed, would be left behind by a removal
 * with nothing looking after it - so those are stopped by the user, on purpose,
 * before this is allowed to proceed.
 *
 * The second is what is *not* done here. Removing the `ip rule`s, unhooking
 * `dhcpscript`, stopping the services: all of that belongs to each package's
 * own `prerm`, not to this file. `apk del bm-agent` typed at a router shell has
 * to leave exactly the same router behind as pressing Uninstall in the app, and
 * the only way to guarantee that is for the module to do nothing the shell
 * would not.
 */
import {
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import { shQuote } from '@shared/shell'
import type { OkResult } from '@shared/types'
import type { JobItemSpec } from '../jobs'
import { isRecord } from '../util'
import { agentCall } from './client'
import type { AgentRuntime, FrozenUninstallPlan } from './types'

const REMOVE_TIMEOUT_MS = 180_000

/**
 * Removal order: anything that declares itself to the agent goes first.
 *
 * The reverse of the install order, and for the same reason - a feature package
 * removed after the agent has nothing left to deregister from, and its prerm is
 * the thing that takes its rules off the router.
 */
const ORDER = ['bm-wanbind', 'bm-pppoe-pool', 'luci-i18n-bm-vi', 'luci-app-bm', 'bm-agent']

function flag(values: Record<string, unknown>, key: string): boolean {
  const value = values[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value === 'true' || value === 'on' || value === '1'
  return false
}

/**
 * Which of the four are actually on this router.
 *
 * Read from what the agent reported rather than by asking apk: the probe
 * already knows, and a second round trip to learn something already in hand is
 * a round trip on every router the app is connected to.
 */
function installedPackages(runtime: AgentRuntime): string[] {
  const agent = runtime.deps.agent()
  if (!agent.installed) return []

  const present = new Set<string>(['bm-agent'])
  for (const name of agent.provides) {
    if (name === 'binding') present.add('bm-wanbind')
    if (name === 'pppoe') present.add('bm-pppoe-pool')
    // The LuCI app and every translation archive built from it. The
    // translations depend on the app, so leaving one behind would leave the app
    // behind with it. `npm run packages:check` fails the build when a language
    // is added to packages/luci-app-bm/po/ without a name here.
    if (name === 'luci') {
      present.add('luci-app-bm')
      present.add('luci-i18n-bm-vi')
    }
  }

  return ORDER.filter((name) => present.has(name))
}

export function checkUninstall(runtime: AgentRuntime, raw: unknown): ModuleCheckReport {
  const caps = runtime.deps.capabilities()

  if (!runtime.deps.ctx.connected) {
    return failedCheck('Not connected to a router', 'Connect the machine entry and try again.')
  }
  if (!caps.probed) {
    return failedCheck(
      'The router has not been checked yet',
      'Run Check again first, so this page knows what is actually installed.'
    )
  }
  if (!caps.isRoot) {
    return failedCheck(
      'Removing packages needs root',
      'Connect this machine entry as root and this page can remove them for you.'
    )
  }

  const packages = installedPackages(runtime)
  if (!packages.length) {
    return failedCheck(
      'There is nothing to remove',
      'This router has no Bored Manager packages installed.'
    )
  }

  const values = (isRecord(raw) ? raw : {})
  const purge = flag(values, 'purge')
  const findings: ModuleCheckFinding[] = []

  // The refusal that matters. Naming what is running is the whole of it: "stop
  // things first" sends somebody hunting, and they may well have forgotten
  // which router this is.
  const blocking = runtime.deps.blockers()
  if (blocking.instances.length) {
    findings.push({
      level: 'error',
      label: `${blocking.instances.length} binding instance(s) are still running`,
      detail: `Stop ${blocking.instances.join(', ')} on the Connection page first. Removing the packages underneath a running instance would leave its ip rules and its fail-closed catch-all on the router with nothing maintaining them.`
    })
  }
  if (blocking.bindings.length) {
    findings.push({
      level: 'warning',
      label: `${blocking.bindings.length} one-to-one binding(s) live in this router's own configuration`,
      detail: `${blocking.bindings.join(', ')} are held by bm-wanbind, not by this module, which is what lets them keep working with the app closed. Removing the packages removes them with it, and nothing here can put them back - this module keeps no copy of a binding the router owns. Write down what they are, or delete them from the Connection page first if you meant to.`
    })
  }
  if (blocking.batches.length) {
    findings.push({
      level: 'error',
      label: `${blocking.batches.length} PPPoE pool(s) still exist`,
      detail: `Delete ${blocking.batches.join(', ')} on the Connection page first. The sessions would stay dialed and the firewall zone would stay in place, and nothing left on the router would know what they were for.`
    })
  }

  findings.push({
    level: 'info',
    label: 'A snapshot is taken before anything is removed',
    detail:
      'It captures the router as it is now, so the state before the uninstall is still there afterwards - including the baseline, which is never deleted whatever else this does.'
  })

  for (const name of packages) {
    findings.push({
      level: 'pass',
      label: `Remove ${name}`,
      detail:
        name === 'bm-agent'
          ? 'Its prerm stops the service and the guard timer.'
          : 'Its prerm takes back the rules and hooks it installed.'
    })
  }

  if (purge) {
    findings.push({
      level: 'warning',
      label: 'Also deleting the configuration and everything under /etc/bm',
      detail:
        'Settings, saved state and every snapshot except the baseline go with them. Reinstalling afterwards gets a router set up from scratch rather than the one you had. The baseline stays because it is the only way back to how this router looked before any of this touched it.'
    })
  } else {
    findings.push({
      level: 'info',
      label: 'Configuration and snapshots are kept',
      detail:
        'Reinstalling later comes back to the same router. Tick "Delete everything" to remove them as well.'
    })
  }

  if (hasBlockingFinding(findings)) return { ok: false, findings }

  return {
    ok: true,
    token: runtime.uninstall.issue(
      values,
      Object.freeze({ packages: Object.freeze(packages), purge })
    ),
    findings
  }
}

function jobItems(runtime: AgentRuntime, plan: FrozenUninstallPlan): JobItemSpec[] {
  const deps = runtime.deps
  const items: JobItemSpec[] = []

  items.push({
    name: 'Take a snapshot first',
    run: async () => {
      const result = await agentCall(
        { ctx: deps.ctx, capability: deps.agent },
        'config_snapshot',
        { reason: 'before-uninstall' }
      )
      // A warning rather than a stop. The user asked for the packages to go, and
      // refusing to remove them because the thing being removed could not take
      // a photograph of itself first would be a strange place to draw a line.
      if (!result.ok) {
        return { warning: `no snapshot was taken: ${result.error ?? 'the agent did not answer'}` }
      }
    }
  })

  items.push({
    name: `Remove ${plan.packages.length} package(s)`,
    run: async () => {
      // One command, in dependency order, so apk removes the set as a set. Each
      // package's own prerm is what takes its rules and hooks off the router.
      const result = await deps.ctx.exec(
        `apk del ${plan.packages.map(shQuote).join(' ')}`,
        { timeoutMs: REMOVE_TIMEOUT_MS }
      )
      if (result.code !== 0) {
        const reason = `${result.stderr || ''}\n${result.stdout || ''}`
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .pop()
        throw new Error(`apk del failed: ${reason?.slice(0, 200) ?? `exit ${result.code}`}`)
      }
    }
  })

  if (plan.purge) {
    items.push({
      name: 'Delete the configuration and saved state',
      run: async () => {
        // The baseline survives, and the path is spelled out rather than
        // globbed away, because this is the one command in the module that
        // deletes a user's data and it should read as exactly what it does.
        const result = await deps.ctx.exec(
          [
            `rm -f /etc/config/bm_agent /etc/config/bm_pppoe /etc/config/bm_wanbind`,
            `find /etc/bm -mindepth 1 -maxdepth 1 ! -name snapshots -exec rm -rf {} +`,
            `find /etc/bm/snapshots -mindepth 1 -maxdepth 1 ! -name baseline -exec rm -rf {} +`,
            `:`
          ].join('; '),
          { timeoutMs: 60_000 }
        )
        if (result.code !== 0) {
          return { warning: 'some files under /etc/bm could not be deleted' }
        }
      }
    })
  }

  items.push({
    name: 'Read the router back',
    run: async () => {
      const next = await deps.reprobe()
      if (next.agent.installed) {
        throw new Error('apk reported success but the agent is still reporting itself installed')
      }
    }
  })

  return items
}

export function applyUninstall(runtime: AgentRuntime, raw: unknown): OkResult {
  const payload = (isRecord(raw) ? raw : {})
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.uninstall.take(token, payload.values)

  if (!taken) return { ok: false, error: 'that check expired or the form changed - check again' }
  if (!runtime.deps.ctx.connected) {
    return { ok: false, error: 'the router disconnected after the check' }
  }
  if (runtime.deps.jobs.busy) {
    return { ok: false, error: 'another job is still running - wait for it to finish' }
  }

  const plan = taken.payload
  if (!plan.packages.length) return { ok: false, error: 'that plan removes nothing - check again' }

  // Re-asked, not trusted from the token. A binding instance can be started in
  // the minutes between reading a report and pressing the button, and the whole
  // point of the refusal is that nothing is removed from underneath one.
  const blocking = runtime.deps.blockers()
  if (blocking.instances.length || blocking.batches.length) {
    return {
      ok: false,
      error: `something started since that check: ${[...blocking.instances, ...blocking.batches].join(', ')} - stop it and check again`
    }
  }

  let jobId: string
  try {
    const job = runtime.deps.jobs.start({
      kind: 'openwrt-agent-uninstall',
      label: `Remove ${plan.packages.length} router package(s)${plan.purge ? ' and their data' : ''}`,
      items: jobItems(runtime, plan),
      onError: 'abort',
      onFinished: async (finished) => {
        runtime.deps.event(
          'agent-uninstall',
          `Router packages ${finished.state}: removed ${plan.packages.join(', ')}${plan.purge ? ' and deleted their data' : ''}`
        )
        // So every surface drops back to the compatibility path in one readiness
        // cycle rather than at the next reconnect.
        if (finished.state !== 'done') await runtime.deps.reprobe()
      }
    })
    jobId = job.id
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return { ok: true, data: jobId }
}
