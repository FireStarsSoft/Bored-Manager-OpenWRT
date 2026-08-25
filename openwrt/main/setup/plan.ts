/**
 * The gates an install has to pass, the report the user reads before confirming
 * it, and the token that ties the two together.
 *
 * Nothing here talks to a shell except the preflight read, and nothing here
 * changes anything on the router - not even a package index refresh, which is
 * slow and is a change in its own right. The three checkboxes select *which*
 * frozen group runs, never *what* runs: the only thing that leaves this file is
 * a list of allowlisted names sealed into the token.
 */
import {
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import { PACKAGE_GROUPS } from '../packages'
import { APK_REQUIRED } from '../probe'
import { preflight, updateCommand } from './install'
import { asRecord, type FrozenSetupPlan, type SetupRuntime } from './runtime'

const SPACE_BLOCK_KB = 512
const SPACE_WARN_KB = 2_048

/** Checkbox values arrive as booleans, strings or nothing at all. */
function selected(values: Record<string, unknown>, key: string): boolean {
  const value = values[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value === 'true' || value === 'on' || value === '1'
  return false
}

/**
 * What would be installed, and whether this router can take it. Nothing is
 * mutated here - not even a package index refresh, which is slow and is a
 * change in its own right.
 */
export async function checkSetup(
  runtime: SetupRuntime,
  raw: unknown
): Promise<ModuleCheckReport> {
  const caps = runtime.deps.capabilities()
  if (!runtime.ctx.connected) {
    return failedCheck('Not connected to a router', 'Connect the machine entry and try again.')
  }
  if (!caps.probed) {
    return failedCheck(
      'The router has not been checked yet',
      'Run Check again first, so this page knows what is actually missing.'
    )
  }
  if (caps.problem) {
    return failedCheck('This machine cannot be managed yet', caps.problem)
  }
  if (!caps.pkgManager) {
    // Behind `caps.problem` today, which already blocks a router with no apk
    // database. Kept because it is the gate that owns this refusal, and it
    // reads the one constant the checklist card and every install hint read.
    return failedCheck('No apk package manager on this router', APK_REQUIRED)
  }
  if (!caps.isRoot) {
    return failedCheck(
      'Installing packages needs root',
      caps.uid < 0
        ? 'The router did not report a user id for this login.'
        : `This login is uid ${caps.uid}. Connect as root to install packages from here.`
    )
  }

  const values = asRecord(raw)
  const chosen = PACKAGE_GROUPS.filter((group) => selected(values, group.key))
  if (!chosen.length) {
    return failedCheck('Nothing selected', 'Tick at least one group to install.')
  }
  const wanted = chosen.filter((group) => !caps[group.capability])
  if (!wanted.length) {
    return failedCheck(
      'Everything selected is already installed',
      'The router already reports support for all of it.'
    )
  }
  const packages = wanted.flatMap((group) => [...group.packages])

  const findings: ModuleCheckFinding[] = []
  const reading = await preflight(runtime)
  if (reading.freeKb >= 0 && reading.freeKb < SPACE_BLOCK_KB) {
    findings.push({
      level: 'error',
      label: `Only ${reading.freeKb} KB free on the overlay`,
      detail: 'Free some space on the router before installing anything.'
    })
  } else if (reading.freeKb >= 0 && reading.freeKb < SPACE_WARN_KB) {
    findings.push({
      level: 'warning',
      label: `${Math.round(reading.freeKb / 1024)} MB free on the overlay`,
      detail: 'Enough for these packages, but the router has little room left.'
    })
  }
  if (!reading.hasDefaultRoute) {
    findings.push({
      level: 'warning',
      label: 'The router has no default route right now',
      detail:
        'Refreshing the package index downloads from the internet; without an uplink the first step will fail.'
    })
  }
  if (/snapshot/i.test(caps.release) && packages.some((name) => name.startsWith('kmod-'))) {
    findings.push({
      level: 'warning',
      label: 'Kernel modules on a snapshot build often refuse to install',
      detail:
        'Snapshot kernels change daily and a kmod package built for a different one will be rejected. Flashing a matching image is the usual fix.'
    })
  }

  findings.push({
    level: 'info',
    label: 'Refresh the apk package index first',
    detail: updateCommand()
  })
  for (const group of wanted) {
    for (const name of group.packages) {
      findings.push({
        level: 'pass',
        label: `Install ${name}`,
        detail: group.purpose
      })
    }
  }

  if (hasBlockingFinding(findings)) return { ok: false, findings }
  const plan: FrozenSetupPlan = Object.freeze({
    manager: caps.pkgManager,
    groups: Object.freeze(wanted.map((group) => group.key)),
    packages: Object.freeze(packages)
  })
  return { ok: true, token: runtime.session.issue(values, plan), findings }
}
