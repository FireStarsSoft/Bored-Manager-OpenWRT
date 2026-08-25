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
    await settle()

    const job = lastJobs(harness).finished[0]
    expect(job.state).toBe('partial')
    expect(job.items[4].status).toBe('error')
    expect(job.items[4].message).toContain('PPPoE support still not available')
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
