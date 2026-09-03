/**
 * The check that decides whether packages may be installed, and the job that
 * installs them.
 *
 * Four sources, one execution path. Whatever route the files took - pinned to
 * this module release, published on GitHub, carried in a bundle from the user's
 * own machine, or already sitting on the router - they end as an argument list
 * of verified files and a single `apk add --allow-untrusted`. That convergence
 * is deliberate: the interesting differences between the sources are about
 * *trust*, and they are settled before this file installs anything.
 *
 * `apk upgrade` does not appear here and must never appear here, for the reason
 * `setup/install.ts` gives at length: the OpenWrt documentation warns that
 * upgrading every package on a running router can leave it unbootable.
 */
import {
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import { shQuote } from '@shared/shell'
import type { OkResult } from '@shared/types'
import type { JobItemSpec } from '../jobs'
import { isRecord, textField } from '../util'
import { agentCall, unwrap } from './client'
import {
  NOTHING_PINNED,
  PINNED_BASE,
  PINNED_PACKAGES,
  PINNED_RELEASE,
  hasPinnedRelease
} from './manifest'
import { SAFE_ARCHIVE, ordered, stageBundle, stagePath, unstage } from './stage'
import {
  isInstallSource,
  type AgentRuntime,
  type FrozenInstallPlan,
  type InstallSource,
  type StagedPackage
} from './types'

const INSTALL_TIMEOUT_MS = 300_000
const DOWNLOAD_TIMEOUT_MS = 180_000
/**
 * How long to give the service before "not running" is treated as a failure.
 *
 * `bm-agent`'s postinst restarts it three seconds after apk returns, deferred
 * on purpose so that an update taken from the router can send its answer before
 * the process running it is replaced. Comfortably longer than that, because the
 * cost of waiting is a few seconds on a step nobody watches and the cost of not
 * waiting is an install that worked being reported as broken.
 */
const RESTART_GRACE_MS = 6_000

function clean(result: ModuleExecResult): string {
  return `${result.stderr || ''}\n${result.stdout || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()
    ?.slice(0, 200) ?? `exit ${result.code}`
}

/**
 * The gates every source shares, in the order they are worth reporting.
 *
 * Deliberately the same shape and largely the same words as `setup/plan.ts`:
 * a user who has read one refusal on the settings page should recognise the
 * other, because they are the same conditions about the same router.
 */
function commonRefusal(runtime: AgentRuntime): ModuleCheckReport | null {
  const caps = runtime.deps.capabilities()

  if (!runtime.deps.ctx.connected) {
    return failedCheck('Not connected to a router', 'Connect the machine entry and try again.')
  }
  if (!caps.probed) {
    return failedCheck(
      'The router has not been checked yet',
      'Run Check again first, so this page knows what is actually on the router.'
    )
  }
  if (caps.problem) {
    return failedCheck('This machine cannot be managed yet', caps.problem)
  }
  if (!caps.pkgManager) {
    return failedCheck(
      'No apk package manager on this router',
      'These packages are installed with apk, which this firmware does not have.'
    )
  }
  if (!caps.isRoot) {
    return failedCheck(
      'Installing packages needs root',
      caps.uid < 0
        ? 'The router did not report a user id for this login.'
        : `This login is uid ${caps.uid}. Connect as root to install packages from here.`
    )
  }

  return null
}

/**
 * What the four sources describe, before anything is fetched.
 *
 * `pinned` and `github` change nothing at check time. `bundle` and `path` do
 * touch the router - one uploads and unpacks, the other reads a file - because
 * neither can be verified any other way, and finding out that a bundle is
 * corrupt after pressing Install is strictly worse than finding out now. The
 * report says which of the two happened.
 */
async function describe(
  runtime: AgentRuntime,
  source: InstallSource,
  values: Record<string, unknown>
): Promise<{ ok: boolean; plan: FrozenInstallPlan | null; findings: ModuleCheckFinding[] }> {
  const agent = runtime.deps.agent()

  if (source === 'pinned') {
    if (!hasPinnedRelease()) {
      return {
        ok: false,
        plan: null,
        findings: [{ level: 'error', label: 'Nothing is pinned to this module release', detail: NOTHING_PINNED }]
      }
    }

    return {
      ok: true,
      plan: {
        source,
        release: PINNED_RELEASE,
        dir: '',
        files: ordered(PINNED_PACKAGES.map((entry) => ({ ...entry }))),
        base: PINNED_BASE
      },
      findings: [
        {
          level: 'info',
          label: `Release ${PINNED_RELEASE}, pinned to this module build`,
          detail: `Each file is downloaded by the router and checked against a sha256 compiled into the module, so a changed release cannot be substituted for this one. The router needs to be able to reach ${PINNED_BASE}.`
        }
      ]
    }
  }

  if (source === 'github') {
    if (!agent.usable) {
      return {
        ok: false,
        plan: null,
        findings: [
          {
            level: 'error',
            label: 'This source needs an agent already installed',
            detail:
              (agent.problem ??
                'There is no agent on this router yet, so nothing there can fetch and verify a release.') +
              ' Install from the pinned release or a bundle first; after that this router can update itself.'
          }
        ]
      }
    }

    if (!agent.canUpdate) {
      return {
        ok: false,
        plan: null,
        findings: [
          {
            level: 'error',
            label: `The agent on this router is too old to update itself`,
            detail: `It speaks version ${agent.apiVersion} of the module API and self-update arrived in 3. Install a newer release from a bundle, and after that it can look after itself.`
          }
        ]
      }
    }

    return {
      ok: true,
      plan: { source, release: '', dir: '', files: [], base: '' },
      findings: [
        {
          level: 'info',
          label: 'The router does this one itself',
          detail:
            'It fetches the release manifest, checks the signature against the key it was built with, downloads each package and matches it against the hash in that manifest. The module only asks it to start and reports what it says.'
        }
      ]
    }
  }

  if (source === 'bundle') {
    // Either the file input or the box beside it. A bundle is base64 text, so
    // pasting it works and does not depend on how a browser handles the upload.
    const bundle = textField(values, 'bundleFile') || textField(values, 'bundleText')
    const staged = await stageBundle(runtime.deps, bundle)

    if (!staged.ok) {
      return {
        ok: false,
        plan: null,
        findings: [{ level: 'error', label: 'That bundle cannot be installed', detail: staged.error ?? '' }]
      }
    }

    return {
      ok: true,
      plan: { source, release: '', dir: staged.dir, files: staged.files, base: '' },
      findings: staged.notes.map((note) => ({ level: 'info', label: note }))
    }
  }

  const staged = await stagePath(runtime.deps, textField(values, 'path'))
  if (!staged.ok) {
    return {
      ok: false,
      plan: null,
      findings: [{ level: 'error', label: 'That path cannot be installed', detail: staged.error ?? '' }]
    }
  }

  return {
    ok: true,
    plan: { source: 'path', release: '', dir: '', files: staged.files, base: '' },
    findings: [
      { level: 'warning', label: 'Nothing here verifies this file', detail: staged.notes.join(' ') }
    ]
  }
}

export async function checkInstall(runtime: AgentRuntime, raw: unknown): Promise<ModuleCheckReport> {
  const refusal = commonRefusal(runtime)
  if (refusal) return refusal

  const values = (isRecord(raw) ? raw : {})
  const source = values.source
  if (!isInstallSource(source)) {
    return failedCheck('Pick where the packages should come from', 'Choose one of the four sources.')
  }

  // Whatever a previous check left in tmpfs. Done before the new one so a user
  // who checks a bundle five times is charged for one copy of it, not five.
  if (runtime.staged) {
    await unstage(runtime.deps, runtime.staged)
    runtime.staged = null
  }

  const described = await describe(runtime, source, values)
  const findings: ModuleCheckFinding[] = [...described.findings]

  if (!described.ok || !described.plan) {
    return { ok: false, findings }
  }

  const plan = described.plan
  runtime.staged = plan.dir || null

  const agent = runtime.deps.agent()
  if (agent.installed && source !== 'github') {
    findings.push({
      level: 'info',
      label: `Replacing the agent this router already has (${agent.release})`,
      detail:
        'Configuration under /etc/config and everything under /etc/bm - snapshots included - is left alone. The service restarts when the install finishes.'
    })
  }

  for (const entry of plan.files) {
    findings.push({
      level: 'pass',
      label: `Install ${entry.name}`,
      detail: entry.file === entry.name ? undefined : entry.file
    })
  }

  if (source === 'github') {
    findings.push({ level: 'pass', label: 'Ask the router to update itself' })
  }

  if (hasBlockingFinding(findings)) return { ok: false, findings }

  return {
    ok: true,
    token: runtime.install.issue(values, Object.freeze({ ...plan, files: Object.freeze(plan.files) })),
    findings
  }
}

/** One `apk add` over everything, so apk resolves the set against itself. */
function installCommand(files: readonly string[]): string {
  return `apk add --allow-untrusted ${files.map(shQuote).join(' ')}`
}

function jobItems(runtime: AgentRuntime, plan: FrozenInstallPlan): JobItemSpec[] {
  const deps = runtime.deps
  const items: JobItemSpec[] = []

  if (plan.source === 'github') {
    items.push({
      name: 'Ask the router to update itself',
      run: async () => {
        // The router does the fetching, the signature check and the install; it
        // also arms its own guard around the whole thing. Repeating any of that
        // here would be a second implementation of the part that has to be
        // right, running on the side of the connection that cannot be trusted
        // to survive it.
        const result = await deps.ctx.exec('bmctl update --json', {
          timeoutMs: INSTALL_TIMEOUT_MS
        })
        if (result.code !== 0) {
          throw new Error(`the router refused the update: ${clean(result)}`)
        }
      }
    })

    // The step that makes the update stick.
    //
    // `bmctl update` arms a commit-confirm guard around the whole thing and
    // then deliberately leaves it armed - at a console it prints "run `bmctl
    // config confirm` to keep this, or leave it and the router restores
    // snapshot X on its own". That is exactly right for a person at a
    // terminal, and exactly wrong for a job nobody is watching: the countdown
    // ran out, the router put the previous packages back, and the module read
    // the update as having succeeded because apk had said so.
    //
    // So the router is read back first - the guard is only worth confirming if
    // what it is guarding actually works - and confirmed after. A confirm that
    // fails is a warning rather than a failure: the update itself landed, and
    // what happens next is the router restoring on its own, which is the safe
    // direction and is what the guard is for.
    items.push({
      name: 'Read the router back and keep the change',
      run: async (): Promise<void | { warning: string }> => {
        let next = await deps.reprobe()

        if (!next.agent.running) {
          await new Promise((resolve) => setTimeout(resolve, RESTART_GRACE_MS))
          next = await deps.reprobe()
        }

        if (!next.agent.installed || !next.agent.running) {
          throw new Error(
            'the router updated itself and its agent is not answering afterwards - ' +
              'the guard it armed will restore the previous packages within its timeout'
          )
        }

        // One call, the way `guardedJobs` confirms its own. Reaching this item
        // at all is the proof that matters: the update landed and the router is
        // answering over a connection that is evidently still carrying
        // commands. An agent too old to have a guard answers this the same way
        // it answers everything else it does not have, and that is not a
        // failure either - there was nothing counting down.
        const kept = unwrap(
          await agentCall({ ctx: deps.ctx, capability: deps.agent }, 'guard_confirm')
        )

        if (!kept.ok) {
          return {
            warning:
              `${next.agent.release} is installed and answering, but the guard it armed was ` +
              `not confirmed: ${kept.error ?? 'the agent did not answer'}. Unless \`bmctl ` +
              'config confirm\` is run on the router, it will restore the packages it had ' +
              'before, within the guard\'s timeout.'
          }
        }
      }
    })

    return items
  }

  // Downloaded at apply time, never at check time: a check that changes nothing
  // is the promise every other check on this module makes.
  if (plan.source === 'pinned') {
    items.push({
      name: 'Make room on the router',
      run: async () => {
        const result = await deps.ctx.exec(
          `umask 077; mktemp -d /tmp/bm-stage.XXXXXX`,
          { timeoutMs: 15_000 }
        )
        const dir = (result.stdout || '').trim().split(/\r?\n/)[0] ?? ''
        if (!/^\/tmp\/bm-stage\.[A-Za-z0-9]{6,}$/.test(dir)) {
          throw new Error('could not make a temporary directory on the router')
        }
        runtime.staged = dir
      }
    })

    for (const entry of plan.files) {
      items.push({
        name: `Download ${entry.file}`,
        run: async (cancelled) => {
          if (cancelled()) return
          const dir = runtime.staged ?? ''
          const dest = `${dir}/${entry.file}`
          const url = `${plan.base}${entry.file}`

          const fetched = await deps.ctx.exec(
            `uclient-fetch -q -O ${shQuote(dest)} ${shQuote(url)} 2>&1 || wget -q -O ${shQuote(dest)} ${shQuote(url)} 2>&1`,
            { timeoutMs: DOWNLOAD_TIMEOUT_MS }
          )
          if (fetched.code !== 0) {
            throw new Error(`${entry.file} would not download: ${clean(fetched)}`)
          }

          // Against the hash compiled into this module, which is the whole
          // reason this source is trusted at all.
          const sum = await deps.ctx.exec(`sha256sum ${shQuote(dest)}`, { timeoutMs: 60_000 })
          const found = (sum.stdout || '').trim().match(/^([0-9a-f]{64})/)
          if (!found || found[1] !== entry.sha256) {
            throw new Error(
              `${entry.file} does not match the checksum this module was built with - it is not the file that was published`
            )
          }
        }
      })
    }
  }

  items.push({
    name: `Install ${plan.files.length} package(s)`,
    run: async (cancelled) => {
      if (cancelled()) return

      const paths = plan.files.map((entry) =>
        // A `path` source names the file where the user left it; every other
        // source has staged it into a directory this module made.
        plan.source === 'path' ? entry.file : `${runtime.staged ?? plan.dir}/${entry.file}`
      )

      for (const entry of plan.files) {
        // The last gate before a shell, on names that came from a manifest
        // rather than from this module's own table.
        if (plan.source !== 'path' && !SAFE_ARCHIVE.test(entry.file)) {
          throw new Error(`${entry.file} is not a plain archive name; nothing was installed`)
        }
      }

      const result = await deps.ctx.exec(installCommand(paths), { timeoutMs: INSTALL_TIMEOUT_MS })
      if (result.code !== 0) {
        throw new Error(`apk add failed: ${clean(result)}`)
      }
    }
  })

  items.push({
    name: 'Read the router back',
    run: async () => {
      let next = await deps.reprobe()
      if (!next.agent.installed) {
        throw new Error(
          'apk reported success but the router still has no agent - check `logread -e bm-agent`'
        )
      }
      if (!next.agent.running) {
        // Asked again before it is called a failure. `bm-agent`'s postinst
        // restarts the service a few seconds after apk returns - deferred so
        // that an update taken from the router can answer before the process
        // running it is replaced - so a first read landing inside that gap sees
        // a service that is on its way back up, not one that would not start.
        await new Promise((resolve) => setTimeout(resolve, RESTART_GRACE_MS))
        next = await deps.reprobe()
      }
      if (!next.agent.running) {
        throw new Error(
          `${next.agent.release} is installed but its service is not running - check \`logread -e bm-agent\``
        )
      }
    }
  })

  return items
}

export function applyInstall(runtime: AgentRuntime, raw: unknown): OkResult {
  const payload = (isRecord(raw) ? raw : {})
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.install.take(token, payload.values)

  if (!taken) return { ok: false, error: 'that check expired or the form changed - check again' }
  if (!runtime.deps.ctx.connected) {
    return { ok: false, error: 'the router disconnected after the check' }
  }
  if (runtime.deps.jobs.busy) {
    return { ok: false, error: 'another job is still running - wait for it to finish' }
  }

  const plan = taken.payload
  if (plan.source !== 'github' && !plan.files.length) {
    return { ok: false, error: 'that plan installs nothing - check again' }
  }

  const staged = plan.dir
  const label =
    plan.source === 'github'
      ? 'Update the router packages from GitHub'
      : `Install ${plan.files.length} router package(s)${plan.release ? ` (${plan.release})` : ''}`

  let jobId: string
  try {
    const job = runtime.deps.jobs.start({
      kind: 'openwrt-agent-install',
      label,
      items: jobItems(runtime, plan),
      onError: 'abort',
      onFinished: async (finished) => {
        runtime.deps.event(
          'agent-install',
          `Router packages ${finished.state}: ${plan.source}${plan.release ? ` ${plan.release}` : ''}`
        )
        // Whatever was staged, however it ended. A few hundred kilobytes of
        // tmpfs on a router with 64 MB of RAM is not nothing.
        if (staged) await unstage(runtime.deps, staged)
        if (runtime.staged && runtime.staged !== staged) {
          await unstage(runtime.deps, runtime.staged)
        }
        runtime.staged = null
        // A job that aborted never reached its verify step, so every surface
        // would still be showing what was true before it started.
        if (finished.state !== 'done') await runtime.deps.reprobe()
      }
    })
    jobId = job.id
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return { ok: true, data: jobId }
}

/** Exported for the settings table: what this module build would install. */
export function pinnedSummary(): { release: string; packages: StagedPackage[] } {
  return { release: PINNED_RELEASE, packages: PINNED_PACKAGES.map((entry) => ({ ...entry })) }
}
