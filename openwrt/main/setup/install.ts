/**
 * Every string this module can send to a package manager, the one place that
 * reads a package manager's output back, and the job that runs them.
 *
 * They live together on purpose. The commands are the part a firmware change
 * rewrites - the move off opkg touched this file and nothing else - and they
 * are also the part a reviewer has to be able to read end to end without first
 * working through the check gates in `plan.ts`. The verb is `update` or `add`,
 * a name comes from `../packages.ts`, and there is no third source of text
 * anywhere below.
 *
 * `apk upgrade` is not here and must never be: the OpenWRT documentation warns
 * that upgrading every package on a running router can leave it unbootable.
 */
import type { ModuleExecResult } from '@shared/modules'
import { shQuote, splitSections } from '@shared/shell'
import type { OkResult } from '@shared/types'
import type { JobItemSpec, OpenWrtJob } from '../jobs'
import { isInstallablePackage, packageGroup, type PackageGroup } from '../packages'
import { IP_FULL_PATH, SPACE_BAD_KB, freeKbFromDf, type OpenWrtCapabilities } from '../probe'
import { asRecord, type SetupRuntime } from './runtime'

const CHECK_TIMEOUT_MS = 15_000
/** An index refresh pulls a package list over whatever uplink the router has. */
const UPDATE_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 180_000
/** apk's database lock is not queued, so a single second attempt is the retry. */
const LOCK_RETRY_MS = 3_000
/** How long the verify step waits before asking the router a second time. */
const VERIFY_RETRY_MS = 3_000

const PREFLIGHT_COMMAND = [
  `echo '===SPACE==='; df -k /overlay 2>/dev/null || df -k / 2>/dev/null`,
  `echo '===ROUTE==='; ip -4 route 2>/dev/null | grep '^default' | head -n 2`
].join('; ')

/**
 * No flags, and deliberately none.
 *
 * `--no-interactive` and `-q` both look like obvious additions and neither can
 * be verified across the apk-tools builds OpenWRT has shipped since 25.12.0. A
 * flag this router's apk does not recognise is not a degraded install, it is a
 * usage error on every single step - so the two commands stay exactly as the
 * OpenWRT documentation writes them.
 */
export function updateCommand(): string {
  return 'apk update'
}

export function installCommand(name: string): string {
  // Quoted even though the name is a constant from the allowlist: the quoting
  // is what makes that guarantee local to this line instead of something a
  // reader has to go and verify two files away.
  return `apk add ${shQuote(name)}`
}

/**
 * The same install, forced onto a package apk already believes it has.
 *
 * `--force-reinstall` is OpenWRT's own patch to apk-tools
 * (`package/system/apk/patches/0100-add-add-force-reinstall-option.patch`),
 * and it is the verb repair mode needed: without it `apk add` on an installed
 * package is a no-op, so "reinstall" restored a package that had gone missing
 * and did nothing at all for one whose files had been damaged.
 *
 * It landed in v25.12.3, so a router on 25.12.0 to .2 does not have it. That is
 * not decided from the release string - a snapshot build calls itself
 * `SNAPSHOT` and this module never gates on version text - but by running it
 * and reading what apk says, which is the same way every other question here is
 * answered.
 */
export function reinstallCommand(name: string): string {
  return `apk add --force-reinstall ${shQuote(name)}`
}

/** apk on a release older than the `--force-reinstall` patch. */
const NO_SUCH_OPTION = /unrecogni[sz]ed option|invalid option|unknown option|unknown argument/i

export function rejectedTheOption(result: ModuleExecResult): boolean {
  return result.code !== 0 && NO_SUCH_OPTION.test(allOutput(result))
}

/** LuCI's Software page takes the apk database lock and holds it while open. */
const LOCKED = /unable to lock database|resource temporarily unavailable/i
/** The index and the installed system disagree, usually after a sysupgrade. */
const WORLD_BREAKS = /breaks:\s*world\[/i

const LOCKED_HINT =
  "LuCI's Software page is holding the package database - close it and try again"
// Deliberately only an explanation. Editing /etc/apk/world to force this past
// apk is a repair on the router's own package state, and doing it from here -
// unattended, over SSH, on a router the user is not looking at - is how a
// module that installs three packages ends up owning a broken sysupgrade.
const WORLD_HINT = 'the package index and the installed system disagree after a sysupgrade'

/** Whatever apk actually printed, whichever stream it went to. */
function allOutput(result: ModuleExecResult): string {
  return `${result.stderr || ''}\n${result.stdout || ''}`
}

function isDatabaseLocked(result: ModuleExecResult): boolean {
  return result.code !== 0 && LOCKED.test(allOutput(result))
}

/** `https://user:pass@feed/...` as apk echoes a configured feed URL back. */
function maskCredentials(line: string): string {
  return line.replace(/\/\/[^\s/@]+:[^\s/@]*@/g, '//***:***@')
}

function lastLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .pop() ?? ''
  )
}

/**
 * Why a package command failed, in one line.
 *
 * This is the one place in the module that repeats command output back to the
 * user, and it is safe precisely because the command was built here: a fixed
 * verb plus an allowlisted package name, with no credential anywhere near it.
 * The reason an install failed - a dependency, a kernel mismatch, a full
 * overlay - is only ever in that output, and without it the step reads
 * "install failed" and leaves the user exactly where they started.
 *
 * stderr first, and only stderr when it has anything at all: apk streams its
 * `Downloading ...` progress to stdout, so concatenating the two and taking the
 * last line reported a download that was still in flight as the cause of the
 * failure. A feed URL can carry credentials, so one is masked before the line
 * is kept anywhere.
 */
export function failureReason(result: ModuleExecResult): string {
  const line = lastLine(result.stderr || '') || lastLine(result.stdout || '')
  return line ? maskCredentials(line).slice(0, 200) : `exit ${result.code}`
}

/**
 * The same line, with the two failures common enough to name translated into
 * something a user can act on. Both read as apk internals otherwise, and both
 * have a next step that is not "try again".
 */
export function packageFailure(result: ModuleExecResult): string {
  const reason = failureReason(result)
  const output = allOutput(result)
  if (LOCKED.test(output)) return `${LOCKED_HINT} (${reason})`
  if (WORLD_BREAKS.test(output)) return `${WORLD_HINT} (${reason})`
  return reason
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * One apk command, retried exactly once when the database was locked. The lock
 * belongs to a LuCI page a user can close in the few seconds this waits, and
 * apk does not queue behind it - so without the retry an install fails on a
 * condition that has usually already cleared.
 */
async function runPackageCommand(
  runtime: SetupRuntime,
  command: string,
  timeoutMs: number,
  cancelled: () => boolean
): Promise<ModuleExecResult> {
  const first = await runtime.ctx.exec(command, { timeoutMs })
  if (!isDatabaseLocked(first)) return first
  await sleep(LOCK_RETRY_MS)
  if (cancelled()) return first
  return runtime.ctx.exec(command, { timeoutMs })
}

export interface PreflightReading {
  freeKb: number
  hasDefaultRoute: boolean
}

/**
 * The two router facts that decide whether an install can even start. Read
 * here rather than beside the gate that uses it, so the shell side of this
 * folder is one file.
 */
export async function preflight(runtime: SetupRuntime): Promise<PreflightReading> {
  try {
    const result = await runtime.ctx.exec(PREFLIGHT_COMMAND, { timeoutMs: CHECK_TIMEOUT_MS })
    const sections = splitSections(result.stdout)
    return {
      freeKb: freeKbFromDf(sections.get('SPACE') ?? ''),
      hasDefaultRoute: /^default\s/m.test((sections.get('ROUTE') ?? '').trim())
    }
  } catch {
    // Not knowing is not a reason to refuse: the install itself will say so.
    return { freeKb: -1, hasDefaultRoute: true }
  }
}

/** Starts the install job and returns its id; progress arrives on `jobs`. */
/**
 * Why a package that installed cleanly left its capability missing.
 *
 * "The router may need a reboot" was the whole of this sentence, and it is the
 * one remedy that cannot help the case people actually hit: `ip-full` goes on,
 * apk reports success, and `/sbin/ip` is still the BusyBox symlink because the
 * alternatives link was never switched. Running the same job again produced the
 * same `partial` for the same invisible reason. The probe now knows which of
 * the three it is, so the failure says so.
 */
function stillMissingMessage(groups: readonly PackageGroup[], caps: OpenWrtCapabilities): string {
  const titles = groups.map((group) => group.title).join(', ')
  const ipfull = groups.find((group) => group.capability === 'hasIpRule')
  if (ipfull) {
    const at = caps.ip.path || '/sbin/ip'
    if (caps.ip.fullPresent && caps.ip.fullWorks) {
      return (
        `${titles}: the package installed and works at ${IP_FULL_PATH}, but ${at} still resolves ` +
        `to ${caps.ip.real || 'BusyBox'}, so nothing that runs \`ip\` is using it. The install did ` +
        `its job; the alternatives link did not switch. Relink it at a router shell with ` +
        `\`ln -sf ${IP_FULL_PATH} ${at}\` and run Check again - reinstalling will not help.`
      )
    }
    if (caps.ip.fullPresent) {
      return (
        `${titles}: iproute2 is installed and this kernel still refuses a numeric routing table, ` +
        `so policy routing is not built into this firmware. No package can add it - WAN binding ` +
        `needs an image built with multiple routing tables.`
      )
    }
  }
  return `${titles} still not available after installing; the router may need a reboot`
}

export function applySetup(runtime: SetupRuntime, raw: unknown): OkResult {
  const payload = asRecord(raw)
  const token = typeof payload.token === 'string' ? payload.token : ''
  const taken = runtime.session.take(token, payload.values)
  if (!taken) return { ok: false, error: 'that check expired or the form changed - check again' }
  if (!runtime.ctx.connected) return { ok: false, error: 'the router disconnected after the check' }
  if (runtime.deps.jobs.busy) {
    return { ok: false, error: 'another job is still running - wait for it to finish' }
  }

  const plan = taken.payload
  // The last gate before a shell. A plan that has been tampered with in any
  // way that matters cannot get past this.
  if (!plan.packages.length || !plan.packages.every(isInstallablePackage)) {
    return { ok: false, error: 'that plan is not installable - check again' }
  }

  const items: JobItemSpec[] = [
    {
      name: 'Refresh the apk package index',
      run: async (cancelled) => {
        const result = await runPackageCommand(
          runtime,
          updateCommand(),
          UPDATE_TIMEOUT_MS,
          cancelled
        )
        if (result.code === 0) return
        // A warning, and then on with the job. Aborting here cancelled an
        // install of packages the router already had cached because one feed
        // of several was unreachable - and an index that is genuinely unusable
        // is reported by the install steps below, which are the ones that
        // actually need it.
        return { warning: `package index refresh failed: ${packageFailure(result)}` }
      }
    }
  ]
  plan.packages.forEach((name, index) => {
    items.push({
      name: `${plan.repair ? 'Run the install again for' : 'Install'} ${name}`,
      run: async (cancelled) => {
        if (cancelled()) return
        // Read again, per package. The gate in `plan.ts` measured the overlay
        // once, before a single byte had been written, and a three-package
        // group on a router with a few megabytes free can run it out half way
        // through - which apk reports as a failed install of whatever happened
        // to be next, on a router that is now also full. The first package is
        // exempt: nothing has been written since the check, and a second `df`
        // over SSH for a reading taken seconds ago buys nothing.
        if (index > 0) {
          const room = await preflight(runtime)
          if (room.freeKb >= 0 && room.freeKb < SPACE_BAD_KB) {
            throw new Error(
              `stopped before installing ${name}: only ${room.freeKb} KB left on the overlay. Free some space and run this again - what has been installed so far stays.`
            )
          }
        }
        if (plan.repair) {
          // Forced first, because that is what "install it again" has to mean
          // for a package apk already lists. A router older than v25.12.3 has
          // no such option and says so, and the plain command below is then the
          // whole of what this router can do - which the warning names, rather
          // than letting a step report success for having changed nothing.
          const forced = await runPackageCommand(
            runtime,
            reinstallCommand(name),
            INSTALL_TIMEOUT_MS,
            cancelled
          )
          if (forced.code === 0) return
          if (!rejectedTheOption(forced)) {
            throw new Error(`${name} failed to install: ${packageFailure(forced)}`)
          }
          const plain = await runPackageCommand(
            runtime,
            installCommand(name),
            INSTALL_TIMEOUT_MS,
            cancelled
          )
          if (plain.code !== 0) {
            throw new Error(`${name} failed to install: ${packageFailure(plain)}`)
          }
          return {
            warning: `this router's apk has no --force-reinstall (it arrived in OpenWrt 25.12.3), so ${name} was only reinstalled if it had gone missing`
          }
        }
        const result = await runPackageCommand(
          runtime,
          installCommand(name),
          INSTALL_TIMEOUT_MS,
          cancelled
        )
        if (result.code !== 0) {
          throw new Error(`${name} failed to install: ${packageFailure(result)}`)
        }
      }
    })
  })
  items.push({
    name: 'Verify what the router can do now',
    run: async () => {
      const missing = (caps: OpenWrtCapabilities): PackageGroup[] =>
        plan.groups
          .map((key) => packageGroup(key))
          .filter((group): group is PackageGroup => group !== null)
          .filter((group) => !caps[group.capability])

      let next = await runtime.deps.reprobe()
      let stillMissing = missing(next)
      if (stillMissing.length) {
        // Asked twice before it is called a failure, the way the agent
        // installer already does. `refreshCapabilities` joins a probe that is
        // already in flight, and the readiness poller is guaranteed to be
        // ticking here - it only runs while a surface showing `capabilities` is
        // open, which is exactly the page this job was started from. A tick
        // whose PROBE_COMMAND went on the wire before `apk add` returned would
        // otherwise answer this step with what was true before the install.
        await new Promise((resolve) => setTimeout(resolve, VERIFY_RETRY_MS))
        next = await runtime.deps.reprobe()
        stillMissing = missing(next)
      }
      if (stillMissing.length) throw new Error(stillMissingMessage(stillMissing, next))
    }
  })

  let job: OpenWrtJob
  try {
    job = runtime.deps.jobs.start({
      kind: 'openwrt-setup',
      label: `${plan.repair ? 'Reinstall' : 'Install'} ${plan.packages.length} package(s) with ${plan.manager}`,
      items,
      onError: 'abort',
      onFinished: async (finished) => {
        runtime.deps.event(
          'packages-install',
          `Package ${plan.repair ? 'reinstall' : 'install'} ${finished.state}: ${plan.packages.join(
            ', '
          )} via ${plan.manager}`
        )
        // A job that aborted never reached its verify step, so the readiness
        // checklist would otherwise still be showing what was true before.
        if (finished.state !== 'done') await runtime.deps.reprobe()
      }
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, data: job.id }
}
