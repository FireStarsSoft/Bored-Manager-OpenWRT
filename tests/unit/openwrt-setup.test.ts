import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import type { JobsSnapshot } from '../../openwrt/main/jobs'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'

/**
 * Installing what a router is missing.
 *
 * Everything here is one shape of the same worry: the only strings that reach a
 * shell come from `packages.ts`. The form contributes three booleans and
 * nothing else, and the check that produced a plan is the check the user read.
 */

const ok = (stdout: string, stderr = '', code = 0): ModuleExecResult => ({
  code,
  stdout,
  stderr
})

/** Mirrors `LOCK_RETRY_MS` in setup/install.ts. */
const LOCK_RETRY_MS = 3_000

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * The verify step asks the router a second time after a real delay, so a probe
 * that was already in flight when `apk add` returned cannot answer it. Nothing
 * here can be pumped with zero-length rounds; the wait has to be waited out.
 */
const settleVerifyRetry = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 3_500))
  await settle()
}

interface Router {
  pppoe: boolean
  ipRule: boolean
  dnsmasq: boolean
  uid: string
  pkgDb: string[]
  managers: string[]
  release: string
  freeKb: number
  defaultRoute: boolean
  /** Commands the router refused, by prefix. */
  fail: string[]
  /** stderr the refused command answers with, so a known failure can be told. */
  failStderr: string
  /**
   * The `===IPRULE===` detail lines. Left alone this describes a router whose
   * `ip` simply is iproute2; a test about the alternatives link supplies its
   * own.
   */
  ipDetail: string[]
}

function router(patch: Partial<Router> = {}): Router {
  return {
    pppoe: false,
    ipRule: true,
    dnsmasq: true,
    uid: '0',
    pkgDb: ['apkdb'],
    managers: ['/usr/bin/apk'],
    release: '25.12.5',
    freeKb: 8_192,
    defaultRoute: true,
    fail: [],
    failStderr: 'ERROR: unable to select packages: kmod-pppoe (no such package)',
    ipDetail: ['path /sbin/ip', 'real /sbin/ip'],
    ...patch
  }
}

function probeOutput(state: Router): string {
  return [
    '===REL===',
    "DISTRIB_ID='OpenWrt'",
    `DISTRIB_RELEASE='${state.release}'`,
    '===BOARD===',
    JSON.stringify({ model: 'Test Router', release: { distribution: 'OpenWrt' } }),
    '===TOOLS===',
    '/sbin/ubus',
    '/sbin/uci',
    '/sbin/ip',
    '/sbin/fw4',
    '/usr/sbin/nft',
    '/sbin/netifd',
    '/sbin/logread',
    ...(state.pppoe ? ['/usr/sbin/pppd'] : []),
    ...(state.dnsmasq ? ['/usr/sbin/dnsmasq'] : []),
    ...state.managers,
    '===PPP===',
    ...(state.pppoe ? ['plugin', 'kmod'] : []),
    '===PKG===',
    ...state.pkgDb,
    '===IDU===',
    state.uid,
    '===SPACE===',
    'Filesystem           1K-blocks      Used Available Use% Mounted on',
    `/dev/loop0                8192      2048      ${state.freeKb}  25% /overlay`,
    '===IPRULE===',
    ...(state.ipRule ? ['ok'] : []),
    ...state.ipDetail,
    '===DONE==='
  ].join('\n')
}

function preflightOutput(state: Router): string {
  return [
    '===SPACE===',
    'Filesystem           1K-blocks      Used Available Use% Mounted on',
    `/dev/loop0                8192      2048      ${state.freeKb}  25% /overlay`,
    '===ROUTE===',
    ...(state.defaultRoute ? ['default via 192.168.1.1 dev eth0'] : [])
  ].join('\n')
}

/** A router that answers the probe, the preflight and any package command. */
function newRouter(
  state: Router,
  options: { activeStreams?: string[] } = {}
): { harness: ModuleHarness; runtime: ReturnType<typeof activate>; installs: string[] } {
  const installs: string[] = []
  const harness = moduleHarness(
    'openwrt',
    (command) => {
      if (command.includes("echo '===REL==='")) return ok(probeOutput(state))
      if (command.includes("echo '===ROUTE==='")) return ok(preflightOutput(state))
      if (/^apk /.test(command)) {
        installs.push(command)
        if (state.fail.some((prefix) => command.startsWith(prefix))) {
          // apk prints its progress to stdout and its reason to stderr, which
          // is the whole point of reading them separately.
          return ok('Downloading kmod-pppoe (6.6.104-r1)', state.failStderr, 1)
        }
        // The router really does gain the capability, so the verify step has
        // something to find.
        if (command.includes('kmod-pppoe')) state.pppoe = true
        if (command.includes('ip-full')) state.ipRule = true
        return ok('installed')
      }
      return ok('')
    },
    { config: sharedModuleConfig(null), ...options }
  )
  const runtime = activate(harness.ctx)
  return { harness, runtime, installs }
}

const check = async (
  harness: ModuleHarness,
  values: unknown
): Promise<ModuleCheckReport> =>
  (await harness.handlers.get('setupCheck')?.(values)) as ModuleCheckReport

const apply = async (harness: ModuleHarness, payload: unknown): Promise<OkResult> =>
  (await harness.handlers.get('setupApply')?.(payload)) as OkResult

/** The last jobs payload the module pushed. */
function lastJobs(harness: ModuleHarness): JobsSnapshot {
  const pushes = harness.emit.mock.calls.filter((call) => call[0] === 'jobs')
  return pushes[pushes.length - 1]?.[1] as JobsSnapshot
}

const labels = (report: ModuleCheckReport, level: string): string[] =>
  report.findings.filter((finding) => finding.level === level).map((finding) => finding.label)

describe('openwrt setup check: what would be installed, and whether it can be', () => {
  it('refuses when the login is not root, and says which login it is', async () => {
    const { harness, runtime } = newRouter(router({ uid: '1000' }))
    runtime.applyPollers?.()
    await settle(6)

    const report = await check(harness, { pppoe: true })

    expect(report.ok).toBe(false)
    expect(report.findings[0].detail).toContain('uid 1000')
    runtime.dispose?.()
  })

  it('refuses a router that still uses opkg, and names the release it runs', async () => {
    // 25.12 replaced opkg with apk. Half-supporting the old one means offering
    // an install flow that speaks a package manager this router does not have,
    // so it is refused here with the one thing the user can act on: which
    // release they are on, and which one this needs.
    const { harness, runtime, installs } = newRouter(
      router({ release: '24.10.2', pkgDb: ['opkgdb'], managers: ['/bin/opkg'] })
    )
    runtime.applyPollers?.()
    await settle(6)

    const report = await check(harness, { pppoe: true })

    expect(report.ok).toBe(false)
    expect(report.findings[0].detail).toBe(
      'This module needs OpenWrt 25.12 or newer. This router runs 24.10.2 and still uses opkg.'
    )
    expect(installs).toEqual([])
    runtime.dispose?.()
  })

  it('refuses a router with no package database at all', async () => {
    const { harness, runtime } = newRouter(router({ pkgDb: [], managers: [] }))
    runtime.applyPollers?.()
    await settle(6)

    const report = await check(harness, { pppoe: true })

    expect(report.ok).toBe(false)
    expect(report.findings[0].detail).toContain('No apk package database on this router.')
    expect(report.findings[0].detail).toContain('25.12')
    runtime.dispose?.()
  })

  it('refuses an empty selection, and one that is already installed', async () => {
    const { harness, runtime } = newRouter(router({ pppoe: true }))
    runtime.applyPollers?.()
    await settle(6)

    expect((await check(harness, {})).findings[0].label).toBe('Nothing selected')
    expect((await check(harness, { pppoe: true })).findings[0].label).toContain(
      'already installed'
    )
    runtime.dispose?.()
  })

  it('lists every package it would install and changes nothing while checking', async () => {
    const { harness, runtime, installs } = newRouter(router())
    runtime.applyPollers?.()
    await settle(6)

    const report = await check(harness, { pppoe: true })

    expect(report.ok).toBe(true)
    expect(report.token).toBeTruthy()
    expect(labels(report, 'pass')).toEqual([
      'Install ppp',
      'Install ppp-mod-pppoe',
      'Install kmod-pppoe'
    ])
    expect(labels(report, 'info')[0]).toContain('Refresh the apk package index')
    // Refreshing the index is itself a change, and a slow one. It belongs to
    // the job the user confirms, not to the report they are reading.
    expect(installs).toEqual([])
    runtime.dispose?.()
  })

  it('blocks on an overlay with no room and warns on one that is nearly full', async () => {
    const empty = newRouter(router({ freeKb: 200 }))
    empty.runtime.applyPollers?.()
    const tight = newRouter(router({ freeKb: 1_024 }))
    tight.runtime.applyPollers?.()
    await settle(6)

    const blocked = await check(empty.harness, { pppoe: true })
    const warned = await check(tight.harness, { pppoe: true })

    expect(blocked.ok).toBe(false)
    expect(labels(blocked, 'error')[0]).toContain('200 KB free')
    expect(warned.ok).toBe(true)
    expect(labels(warned, 'warning')[0]).toContain('1 MB free')
    empty.runtime.dispose?.()
    tight.runtime.dispose?.()
  })

  it('warns about the two things that make an install fail on arrival', async () => {
    const offline = newRouter(router({ defaultRoute: false }))
    offline.runtime.applyPollers?.()
    const snapshot = newRouter(router({ release: 'SNAPSHOT r28000' }))
    snapshot.runtime.applyPollers?.()
    await settle(6)

    const noRoute = await check(offline.harness, { pppoe: true })
    const kernel = await check(snapshot.harness, { pppoe: true })

    expect(noRoute.ok).toBe(true)
    expect(labels(noRoute, 'warning')[0]).toContain('no default route')
    // A kmod built for yesterday's snapshot kernel is refused by the manager,
    // which is worth saying before the job rather than in step four of five.
    expect(labels(kernel, 'warning')[0]).toContain('Kernel modules on a snapshot build')
    offline.runtime.dispose?.()
    snapshot.runtime.dispose?.()
  })
})

describe('openwrt setup apply: the only commands it can produce', () => {
  it('refreshes the index, installs each package and verifies the result', async () => {
    const { harness, runtime, installs } = newRouter(router())
    runtime.applyPollers?.()
    await settle(6)
    const values = { pppoe: true }
    const report = await check(harness, values)

    const started = await apply(harness, { token: report.token, values })
    await settle()

    expect(started.ok).toBe(true)
    expect(installs).toEqual([
      'apk update',
      "apk add 'ppp'",
      "apk add 'ppp-mod-pppoe'",
      "apk add 'kmod-pppoe'"
    ])
    const job = lastJobs(harness).finished[0]
    expect(job.state).toBe('done')
    expect(job.items.map((item) => item.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(job.items[4].name).toContain('Verify')
    runtime.dispose?.()
  })

  it('produces no apk verb but update and add', async () => {
    // `apk upgrade` is the one that matters: the OpenWRT documentation warns
    // that upgrading every package on a running router can leave it unbootable,
    // and nothing on this page has any business reaching for it. The package
    // names are already allowlisted; this locks the verb in front of them.
    const { harness, runtime, installs } = newRouter(router({ ipRule: false, dnsmasq: false }))
    runtime.applyPollers?.()
    await settle(6)
    const values = { pppoe: true, ipfull: true, dnsmasq: true }
    const report = await check(harness, values)

    await apply(harness, { token: report.token, values })
    await settle()

    expect(installs).toEqual([
      'apk update',
      "apk add 'ppp'",
      "apk add 'ppp-mod-pppoe'",
      "apk add 'kmod-pppoe'",
      "apk add 'ip-full'",
      "apk add 'dnsmasq'"
    ])
    const verbs = new Set(installs.map((command) => command.split(' ')[1]))
    expect([...verbs].sort()).toEqual(['add', 'update'])
    expect(harness.exec.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(
      'apk upgrade'
    )
    runtime.dispose?.()
  })

  it('cannot be talked into running anything else', async () => {
    // The checkboxes choose which frozen group runs; they are never part of a
    // command. Anything that is not exactly a truthy checkbox is simply off.
    const { harness, runtime, installs } = newRouter(router({ ipRule: false }))
    runtime.applyPollers?.()
    await settle(6)
    const values = {
      pppoe: true,
      ipfull: '; rm -rf / #',
      dnsmasq: '$(reboot)',
      packages: ['evil-package'],
      name: '`id`'
    }
    const report = await check(harness, values)

    await apply(harness, { token: report.token, values })
    await settle()

    expect(installs).toEqual([
      'apk update',
      "apk add 'ppp'",
      "apk add 'ppp-mod-pppoe'",
      "apk add 'kmod-pppoe'"
    ])
    // The name is only half the allowlist; the verb in front of it is the other
    // half, and `apk upgrade` on a running router can leave it unbootable.
    expect(new Set(installs.map((command) => command.split(' ')[1]))).toEqual(
      new Set(['update', 'add'])
    )
    const everything = harness.exec.mock.calls.map((call) => String(call[0])).join('\n')
    expect(everything).not.toContain('rm -rf')
    expect(everything).not.toContain('reboot')
    expect(everything).not.toContain('evil-package')
    expect(everything).not.toContain('apk upgrade')
    runtime.dispose?.()
  })

  it('warns on a failed index refresh and installs anyway', async () => {
    // One unreachable feed used to cancel the whole job, including packages the
    // router already had cached. An index that is genuinely unusable is
    // reported by the install steps themselves, which are the ones that need it.
    const { harness, runtime, installs } = newRouter(
      router({ fail: ['apk update'], failStderr: 'ERROR: unable to fetch https://feed/x86_64' })
    )
    runtime.applyPollers?.()
    await settle(6)
    const values = { pppoe: true }
    const report = await check(harness, values)

    await apply(harness, { token: report.token, values })
    await settle()

    expect(installs).toEqual([
      'apk update',
      "apk add 'ppp'",
      "apk add 'ppp-mod-pppoe'",
      "apk add 'kmod-pppoe'"
    ])
    const job = lastJobs(harness).finished[0]
    expect(job.state).toBe('done')
    expect(job.items[0].status).toBe('warning')
    // apk streams `Downloading ...` to stdout, so a reader that concatenated
    // both streams and took the last line reported a download in flight as the
    // reason the refresh failed.
    expect(job.items[0].message).toContain('unable to fetch')
    expect(job.items[0].message).not.toContain('Downloading')
    expect(job.items.slice(1).every((item) => item.status === 'ok')).toBe(true)
    runtime.dispose?.()
  })

  it('stops at the first package that will not install', async () => {
    const { harness, runtime, installs } = newRouter(router({ fail: ["apk add 'ppp-mod-pppoe'"] }))
    runtime.applyPollers?.()
    await settle(6)
    const values = { pppoe: true }
    const report = await check(harness, values)

    await apply(harness, { token: report.token, values })
    await settle()

    expect(installs).toEqual(['apk update', "apk add 'ppp'", "apk add 'ppp-mod-pppoe'"])
    const job = lastJobs(harness).finished[0]
    expect(job.state).toBe('partial')
    expect(job.items[2].status).toBe('error')
    // The reason lives only in apk's own output, and the command it came from
    // was built here - there is no credential anywhere near it.
    expect(job.items[2].message).toContain('unable to select packages')
    expect(job.items.slice(3).every((item) => item.status === 'skipped')).toBe(true)
    runtime.dispose?.()
  })

  it('translates the two apk failures that have a next step, and retries the lock once', async () => {
    // Both read as apk internals otherwise, and both have a next step that is
    // not "try again": one is a page the user has open in another tab, the
    // other is a package state this module deliberately will not repair.
    const locked = newRouter(
      router({
        fail: ["apk add 'ppp'"],
        failStderr: 'ERROR: Unable to lock database: Resource temporarily unavailable'
      })
    )
    locked.runtime.applyPollers?.()
    const broken = newRouter(
      router({ fail: ["apk add 'ppp'"], failStderr: '  breaks: world[base-files=1.0-r3]' })
    )
    broken.runtime.applyPollers?.()
    await settle(6)

    for (const module of [locked, broken]) {
      const values = { pppoe: true }
      const report = await check(module.harness, values)
      await apply(module.harness, { token: report.token, values })
    }
    // Long enough for the one lock retry, which is timed rather than polled.
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS + 200))
    await settle()

    expect(lastJobs(broken.harness).finished[0].items[1].message).toContain(
      'the package index and the installed system disagree after a sysupgrade'
    )
    // Retried exactly once: the lock belongs to a page the user can close in
    // the seconds this waits, and apk does not queue behind it.
    expect(locked.installs).toEqual(['apk update', "apk add 'ppp'", "apk add 'ppp'"])
    expect(lastJobs(locked.harness).finished[0].items[1].message).toContain(
      "LuCI's Software page is holding the package database"
    )
    locked.runtime.dispose?.()
    broken.runtime.dispose?.()
    // The three-second wait above is most of this test's wall time.
  }, 15_000)

  it('fails the verify step when the router still cannot do it', async () => {
    const state = router()
    const { harness, runtime } = newRouter(state)
    runtime.applyPollers?.()
    await settle(6)
    const values = { pppoe: true }
    const report = await check(harness, values)
    // Every command succeeds and the capability never appears - a kmod that
    // installed against the wrong kernel looks exactly like this.
    state.pppoe = false
    harness.exec.mockImplementation(async (command) => {
      if (command.includes("echo '===REL==='")) return ok(probeOutput(state))
      return ok('')
    })

    await apply(harness, { token: report.token, values })
    await settleVerifyRetry()

    const job = lastJobs(harness).finished[0]
    expect(job.state).toBe('partial')
    expect(job.items[4].status).toBe('error')
    expect(job.items[4].message).toContain('PPPoE support still not available')
    runtime.dispose?.()
  })

  it('blames the alternatives link, not a reboot, when ip-full is on and unused', async () => {
    // The case that had no test and produced three identical `partial` jobs in
    // a row on a real router: `apk add ip-full` succeeds, the binary is on disk
    // and works when called by its own path, and `/sbin/ip` is still the
    // BusyBox symlink - so the capability the verify step looks for is still
    // missing and reinstalling will never bring it back.
    const state = router({ ipRule: false })
    const { harness, runtime } = newRouter(state)
    runtime.applyPollers?.()
    await settle(6)
    const values = { ipfull: true }
    const report = await check(harness, values)

    harness.exec.mockImplementation(async (command: string) => {
      if (command.includes("echo '===REL==='")) {
        // Installed, working, and not what `ip` means.
        state.ipDetail = ['path /sbin/ip', 'real /bin/busybox', 'libexec', 'libexecok']
        return ok(probeOutput(state))
      }
      if (command.includes("echo '===ROUTE==='")) return ok(preflightOutput(state))
      return ok('installed')
    })

    await apply(harness, { token: report.token, values })
    await settleVerifyRetry()

    const job = lastJobs(harness).finished[0]
    expect(job.state).toBe('partial')
    const verify = job.items[job.items.length - 1]
    expect(verify.status).toBe('error')
    expect(verify.message).toContain('/usr/libexec/ip-full')
    expect(verify.message).toContain('ln -sf')
    // The one remedy that cannot possibly help here, and the only one this
    // step used to offer.
    expect(verify.message).not.toContain('reboot')
    runtime.dispose?.()
  })

  it('says no package can help when the kernel refuses the table', async () => {
    const state = router({ ipRule: false })
    const { harness, runtime } = newRouter(state)
    runtime.applyPollers?.()
    await settle(6)
    const values = { ipfull: true }
    const report = await check(harness, values)

    harness.exec.mockImplementation(async (command: string) => {
      if (command.includes("echo '===REL==='")) {
        // iproute2 is what `ip` resolves to, and it still cannot do it.
        state.ipDetail = ['path /sbin/ip', 'real /usr/libexec/ip-full', 'libexec']
        return ok(probeOutput(state))
      }
      if (command.includes("echo '===ROUTE==='")) return ok(preflightOutput(state))
      return ok('installed')
    })

    await apply(harness, { token: report.token, values })
    await settleVerifyRetry()

    const job = lastJobs(harness).finished[0]
    const verify = job.items[job.items.length - 1]
    expect(verify.status).toBe('error')
    expect(verify.message).toContain('kernel')
    expect(verify.message).not.toContain('reboot')
    runtime.dispose?.()
  })

  it('reads the router twice before calling a capability missing', async () => {
    // `refreshCapabilities` joins a probe that is already in flight, and the
    // readiness poller is guaranteed to be running while this page is open. A
    // tick whose PROBE_COMMAND went out before `apk add` returned would answer
    // the verify step with what was true before the install, so the step asks
    // again rather than failing a job the router would disagree with.
    const state = router({ pppoe: false })
    const { harness, runtime } = newRouter(state)
    runtime.applyPollers?.()
    await settle(6)
    const values = { pppoe: true }
    const report = await check(harness, values)

    let probes = 0
    harness.exec.mockImplementation(async (command: string) => {
      if (command.includes("echo '===REL==='")) {
        probes += 1
        // Stale on the first read after the install, current on the second.
        return ok(probeOutput({ ...state, pppoe: probes > 1 }))
      }
      if (command.includes("echo '===ROUTE==='")) return ok(preflightOutput(state))
      return ok('installed')
    })

    await apply(harness, { token: report.token, values })
    await settleVerifyRetry()

    expect(lastJobs(harness).finished[0].state).toBe('done')
    runtime.dispose?.()
  })

  it('will not apply a token twice, or one whose form changed', async () => {
    // Both groups are missing here, so ticking the second box is a real change
    // to what would run - and what runs must be what the report described.
    const { harness, runtime, installs } = newRouter(router({ ipRule: false }))
    runtime.applyPollers?.()
    await settle(6)
    const values = { pppoe: true }

    const first = await check(harness, values)
    const tampered = await apply(harness, {
      token: first.token,
      values: { ...values, ipfull: true }
    })
    await settle(4)

    expect(first.ok).toBe(true)
    expect(tampered).toMatchObject({ ok: false })
    expect(installs).toEqual([])

    const second = await check(harness, values)
    const started = await apply(harness, { token: second.token, values })
    await settle()
    const replay = await apply(harness, { token: second.token, values })

    expect(started.ok).toBe(true)
    expect(replay).toMatchObject({ ok: false })
    expect(installs).toHaveLength(4)
    runtime.dispose?.()
  })
})

describe('openwrt readiness poller', () => {
  it('watches a router that is missing something, but only while a surface reads it', async () => {
    const { harness, runtime } = newRouter(router(), { activeStreams: ['capabilities'] })
    runtime.applyPollers?.()
    await settle(6)

    // Pollers 0 and 1 are the fast and slow collectors.
    expect(harness.pollers[2].start).toHaveBeenCalledWith(30_000)
    const before = harness.exec.mock.calls.length
    await harness.ticks[2]()
    expect(harness.exec.mock.calls.length).toBe(before + 1)
    runtime.dispose?.()
  })

  it('costs nothing when nobody is looking at the readiness page', async () => {
    const { harness, runtime } = newRouter(router(), { activeStreams: ['overview'] })
    runtime.applyPollers?.()
    await settle(6)

    const before = harness.exec.mock.calls.length
    await harness.ticks[2]()

    expect(harness.exec.mock.calls.length).toBe(before)
    runtime.dispose?.()
  })

  it('stops watching once the router has everything', async () => {
    const { harness, runtime } = newRouter(router({ pppoe: true }), {
      activeStreams: ['capabilities']
    })
    runtime.applyPollers?.()
    await settle(6)

    expect(harness.pollers[2].start).not.toHaveBeenCalled()
    runtime.dispose?.()
  })

  it('does not re-probe a machine that answered and is not a router', async () => {
    // It answered. It will not become a router while the page is open, and
    // asking every thirty seconds is the hammering the poller latch exists to
    // prevent.
    const harness = moduleHarness('openwrt', () => ok('===REL===\nID=debian\n===BOARD===\n===DONE==='), {
      config: sharedModuleConfig(null),
      activeStreams: ['capabilities']
    })
    const runtime = activate(harness.ctx)

    runtime.applyPollers?.()
    await settle(6)

    expect(harness.pollers.every((poller) => poller.start.mock.calls.length === 0)).toBe(true)
    runtime.dispose?.()
  })
})

/**
 * The two things the install flow could not do: put a group back on a router
 * that reports it as present, and notice that the overlay filled up half way
 * through a group of three.
 */
describe('openwrt setup: running the install again, and running out of room', () => {
  it('refuses a present group without repair, and plans it with repair', async () => {
    const { harness, runtime } = newRouter(router({ pppoe: true }))
    runtime.applyPollers?.()
    await settle(6)

    // What this page said, and only said, to somebody whose ppp is installed
    // and not working.
    const plain = await check(harness, { pppoe: true })
    expect(plain.ok).toBe(false)
    expect(plain.findings[0].detail).toContain('Run the install again')

    const repaired = await check(harness, { pppoe: true, repair: true })
    expect(repaired.ok).toBe(true)
    // Named for what it is, and honest about which router it is talking to:
    // `--force-reinstall` genuinely unpacks the files again, and it arrived in
    // OpenWrt 25.12.3, so the detail says what an older apk will do instead.
    expect(labels(repaired, 'warning')).toContain(
      'Running the install again, including what is already present'
    )
    expect(repaired.findings.map((one) => one.detail).join(' ')).toContain('25.12.3')
    expect(labels(repaired, 'pass')).toEqual([
      'Run the install again for ppp',
      'Run the install again for ppp-mod-pppoe',
      'Run the install again for kmod-pppoe'
    ])
    runtime.dispose?.()
  })

  it('still emits nothing but add, and still cannot emit upgrade', async () => {
    const { harness, runtime, installs } = newRouter(router({ pppoe: true }))
    runtime.applyPollers?.()
    await settle(6)

    const report = await check(harness, { pppoe: true, repair: true })
    expect(await apply(harness, { token: report.token, values: { pppoe: true, repair: true } }))
      .toMatchObject({ ok: true })
    await settle(60)

    // `--force-reinstall`, which OpenWrt patched into apk for 25.12.3, is what
    // makes "install it again" mean anything at all: plain `apk add` on a
    // package apk already lists does nothing.
    expect(installs).toEqual([
      'apk update',
      "apk add --force-reinstall 'ppp'",
      "apk add --force-reinstall 'ppp-mod-pppoe'",
      "apk add --force-reinstall 'kmod-pppoe'"
    ])
    // The one command this module must never be able to produce, whatever a
    // form sends: the OpenWRT documentation warns it can leave a running router
    // unbootable.
    expect(installs.join(' ')).not.toContain('upgrade')
    runtime.dispose?.()
  })

  // A router on 25.12.0 to .2 has no --force-reinstall. It must not read as a
  // failed install, and it must not read as a successful repair either.
  it('falls back to a plain add when this apk has no --force-reinstall', async () => {
    const { harness, runtime, installs } = newRouter(
      router({
        pppoe: true,
        fail: ['apk add --force-reinstall'],
        failStderr: "apk: unrecognized option '--force-reinstall'"
      })
    )
    runtime.applyPollers?.()
    await settle(6)

    const report = await check(harness, { pppoe: true, repair: true })
    expect(await apply(harness, { token: report.token, values: { pppoe: true, repair: true } }))
      .toMatchObject({ ok: true })
    await settle(60)

    // Tried, refused, and then done the only way this router can do it.
    expect(installs).toContain("apk add --force-reinstall 'ppp'")
    expect(installs).toContain("apk add 'ppp'")
    runtime.dispose?.()
  })

  it('keeps the repair flag out of the shell and inside the token', async () => {
    const { harness, runtime, installs } = newRouter(router({ pppoe: true }))
    runtime.applyPollers?.()
    await settle(6)

    const report = await check(harness, { pppoe: true, repair: true })
    // The values the apply carries have to be the values that were checked, so
    // an apply that quietly drops the flag is refused rather than run as a
    // different plan.
    expect(await apply(harness, { token: report.token, values: { pppoe: true } })).toMatchObject({
      ok: false
    })
    expect(installs).toEqual([])
    runtime.dispose?.()
  })

  it('stops between packages when the overlay filled up, and says what is done', async () => {
    // The check reads free space once, before anything is written. A group of
    // three on a router with a few megabytes spare can run it out on the second
    // one, which apk then reports as a failed install on a router that is now
    // also full.
    const state = router({ freeKb: 8_192 })
    const { harness, runtime, installs } = newRouter(state)
    runtime.applyPollers?.()
    await settle(6)

    const report = await check(harness, { pppoe: true })
    expect(report.ok).toBe(true)
    // The first package goes on, and the overlay fills while it does.
    state.freeKb = 64
    expect(await apply(harness, { token: report.token, values: { pppoe: true } })).toMatchObject({
      ok: true
    })
    await settle(80)

    expect(installs).toEqual(['apk update', "apk add 'ppp'"])
    const job = lastJobs(harness).finished[0]
    // 'partial' rather than 'error': the index refresh and the first package
    // both succeeded, and the job says so instead of reporting the whole run as
    // a failure the user has to unpick.
    expect(job?.state).toBe('partial')
    const failed = job?.items.find((item) => item.status === 'error')
    expect(failed?.message).toContain('stopped before installing ppp-mod-pppoe')
    expect(failed?.message).toContain('64 KB')
    // What is already on the router stays on it; nothing is rolled back.
    expect(failed?.message).toContain('stays')
    runtime.dispose?.()
  })

  it('does not pay for a second df before the first package', async () => {
    const { harness, runtime } = newRouter(router())
    runtime.applyPollers?.()
    await settle(6)

    const report = await check(harness, { pppoe: true })
    const before = harness.exec.mock.calls.filter((call) =>
      String(call[0]).includes("echo '===ROUTE==='")
    ).length
    await apply(harness, { token: report.token, values: { pppoe: true } })
    await settle(80)

    // One reading per package after the first, and not one for the first:
    // nothing has been written since the check took its own seconds ago.
    const after = harness.exec.mock.calls.filter((call) =>
      String(call[0]).includes("echo '===ROUTE==='")
    ).length
    expect(after - before).toBe(2)
    runtime.dispose?.()
  })
})
