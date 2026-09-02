import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import { AGENT_INFO, BINDING_AGENT_INFO, isProbeCommand, routerProbeOutput } from '../helpers/router'
import { fakeWanbind, instanceConfig } from '../helpers/wanbind'
import {
  PINNED_BASE,
  PINNED_PACKAGES,
  PINNED_RELEASE,
  hasPinnedRelease
} from '../../openwrt/main/agent/manifest'

/**
 * The router-side packages, from this side of the connection.
 *
 * Two things run through all of it. Nothing here is required - a router with no
 * agent is the router this module has always managed, and every path falls back
 * to SSH rather than refusing. And nothing is installed on a hash the download
 * itself supplied: each of the four sources has its own reason to be trusted,
 * and the tests below are mostly about that reason holding.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const HOST = {
  version: 1,
  nextSeq: 1,
  batches: [] as unknown[],
  instances: [] as unknown[],
  extraTables: [],
  stickyMap: [],
  events: [],
  moduleEvents: [],
  jobs: []
}

interface Router {
  harness: ModuleHarness
  call(method: string, ...args: unknown[]): Promise<unknown>
  commands(): string[]
  dispose(): void
}

/** A router the module has probed, with whatever agent the test asked for. */
async function router(
  options: {
    agent?: Record<string, unknown> | null
    hostData?: unknown
    answer?: (command: string, stdin: string) => ModuleExecResult | null
  } = {}
): Promise<Router> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: options.hostData ?? HOST,
    config: sharedModuleConfig(null)
  })

  harness.exec.mockImplementation(async (command, execOptions) => {
    if (isProbeCommand(command)) {
      return ok(routerProbeOutput({ agent: options.agent ?? null }))
    }
    const answered = options.answer?.(command, execOptions?.stdin ?? '')
    return answered ?? ok()
  })

  const runtime = activate(harness.ctx)
  runtime.applyPollers?.()
  await settle()

  return {
    harness,
    call: async (method, ...args) => harness.handlers.get(method)?.(...args),
    commands: () => harness.exec.mock.calls.map((call) => String(call[0])),
    dispose: () => runtime.dispose?.()
  }
}

const report = (value: unknown): ModuleCheckReport => value as ModuleCheckReport
const text = (value: unknown): string =>
  report(value)
    .findings.map((finding) => `${finding.level} ${finding.label} ${finding.detail ?? ''}`)
    .join('\n')

describe('what the probe makes of an agent', () => {
  it('reads a healthy one, and drives the router through it', async () => {
    const owrt = await router({ agent: AGENT_INFO })

    const caps = owrt.harness.emit.mock.calls
      .filter((call) => call[0] === 'capabilities')
      .map((call) => call[1] as { agent: Record<string, unknown> })
      .at(-1)

    expect(caps?.agent).toMatchObject({
      installed: true,
      running: true,
      release: '1.2.0',
      usable: true,
      canGuard: true,
      canUpdate: true,
      problem: null
    })
    owrt.dispose()
  })

  it('tells an installed-but-stopped agent from one that was never installed', async () => {
    // `bmctl info --json` answers when the service does not, and says so. The
    // difference matters: one is a service to start, the other is a package to
    // install, and a single "no agent" would send both to the wrong place.
    const stopped = await router({ agent: { ...AGENT_INFO, service: 'stopped' } })
    const caps = (report: string): Record<string, unknown> =>
      (stopped.harness.emit.mock.calls
        .filter((call) => call[0] === report)
        .map((call) => call[1] as { agent: Record<string, unknown> })
        .at(-1)?.agent ?? {}) as Record<string, unknown>

    expect(caps('capabilities')).toMatchObject({ installed: true, running: false, usable: false })
    expect(String(caps('capabilities').problem)).toContain('service is not running')
    expect(String(caps('capabilities').problem)).toContain('bm-agent start')
    stopped.dispose()

    const none = await router({ agent: null })
    expect(
      (none.harness.emit.mock.calls
        .filter((call) => call[0] === 'capabilities')
        .map((call) => call[1] as { agent: Record<string, unknown> })
        .at(-1)?.agent ?? {}) as Record<string, unknown>
    ).toMatchObject({ installed: false, usable: false, problem: null })
    none.dispose()
  })

  it('falls back rather than breaking on an agent from the future', async () => {
    // An app from last month must not stop a router working because somebody
    // updated its packages. Everything the agent does has an SSH equivalent, so
    // the only correct answer is to use it and say why.
    const owrt = await router({ agent: { ...AGENT_INFO, apiVersion: 99 } })

    const agent = (owrt.harness.emit.mock.calls
      .filter((call) => call[0] === 'capabilities')
      .map((call) => call[1] as { agent: Record<string, unknown>; state: string })
      .at(-1) ?? { agent: {}, state: '' }) as { agent: Record<string, unknown>; state: string }

    expect(agent.agent.usable).toBe(false)
    expect(String(agent.agent.problem)).toContain('speaks version 99')
    expect(String(agent.agent.problem)).toContain('Update Bored Manager')
    // Working, and pulled out for attention rather than blocked.
    expect(agent.state).toBe('attention')
    owrt.dispose()
  })

  it('refuses to run on data written by a newer build', async () => {
    const owrt = await router({ agent: { ...AGENT_INFO, schema: 1, dataSchema: 4 } })

    const agent = (owrt.harness.emit.mock.calls
      .filter((call) => call[0] === 'capabilities')
      .map((call) => call[1] as { agent: Record<string, unknown> })
      .at(-1)?.agent ?? {}) as Record<string, unknown>

    expect(agent.usable).toBe(false)
    expect(String(agent.problem)).toContain('schema 4')
    expect(String(agent.problem)).toContain('restore a snapshot')
    owrt.dispose()
  })
})

describe('the Router packages table', () => {
  it('answers on a router that has none, which is the router it is for', async () => {
    const owrt = await router({ agent: null })

    const rows = (await owrt.call('agentRows')) as Array<{ name: string; status: string }>

    expect(rows.map((row) => row.name)).toContain('bm-agent')
    expect(rows[0].status).toBe('not installed')
    owrt.dispose()
  })
})

describe('where the packages are allowed to come from', () => {
  // Whether this checkout is pinned is a fact about the build, not about the
  // code: `npm run pin:packages` fills the constants in before a release is
  // tagged and they are empty until then. So this asserts the pin as it stands
  // - and openwrt-agent-unpinned.test.ts mocks it away to hold the other
  // branch, which no checkout can exercise once a release has been cut.
  it('offers the release this module build is pinned to', async () => {
    const owrt = await router({ agent: null })

    const result = await owrt.call('agentInstallCheck', { source: 'pinned' })

    if (!hasPinnedRelease()) {
      // An invented hash would be worse in both directions: it cannot install
      // and it cannot explain itself.
      expect(report(result).ok).toBe(false)
      expect(text(result)).toContain('no pinned package release')
      expect(text(result)).toContain('bundle file or a path on the router')
      owrt.dispose()
      return
    }

    expect(report(result).ok).toBe(true)
    expect(text(result)).toContain(`Release ${PINNED_RELEASE}`)
    expect(text(result)).toContain('checked against a sha256 compiled into the module')
    // Every package the release ships, and bm-agent first: everything else
    // declares itself to it.
    expect(PINNED_PACKAGES.map((entry) => entry.name)[0]).toBe('bm-agent')
    for (const entry of PINNED_PACKAGES) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.size).toBeGreaterThan(0)
    }
    expect(PINNED_BASE).toContain(`pkg-v${PINNED_RELEASE}`)
    owrt.dispose()
  })

  it('will not ask a router with no agent to update itself', async () => {
    const owrt = await router({ agent: null })

    const result = await owrt.call('agentInstallCheck', { source: 'github' })

    expect(report(result).ok).toBe(false)
    expect(text(result)).toContain('needs an agent already installed')
    expect(text(result)).toContain('after that this router can update itself')
    owrt.dispose()
  })

  it('names the version when the agent is too old to update itself', async () => {
    const owrt = await router({ agent: { ...AGENT_INFO, apiVersion: 2 } })

    const result = await owrt.call('agentInstallCheck', { source: 'github' })

    expect(report(result).ok).toBe(false)
    expect(text(result)).toContain('version 2')
    expect(text(result)).toContain('self-update arrived in 3')
    owrt.dispose()
  })

  it('refuses a path that is not one, and never quotes it into a command', async () => {
    const owrt = await router({ agent: null })

    for (const path of ['bm-agent.apk', '../../etc/passwd.apk', '/tmp/x.txt', '']) {
      const result = await owrt.call('agentInstallCheck', { source: 'path', path })
      expect(report(result).ok, path).toBe(false)
      expect(text(result)).toContain('absolute path to a .apk')
    }

    // Nothing that failed validation reached a shell.
    expect(owrt.commands().join('\n')).not.toContain('passwd')
    owrt.dispose()
  })

  it('says plainly that a path on the router is verified by nobody', async () => {
    const owrt = await router({
      agent: null,
      answer: (command) => {
        if (command.includes('===STAT===')) {
          return ok(
            ['===STAT===', '20480', '===SUM===', `${'a'.repeat(64)}  /tmp/bm-agent.apk`].join('\n')
          )
        }
        return null
      }
    })

    const result = await owrt.call('agentInstallCheck', {
      source: 'path',
      path: '/tmp/bm-agent.apk'
    })

    expect(report(result).ok).toBe(true)
    expect(text(result)).toContain('warning Nothing here verifies this file')
    expect(text(result)).toContain('trusted because it is already on your router')
    owrt.dispose()
  })
})

describe('a bundle from the machine running the app', () => {
  const BUNDLE_MANIFEST = {
    manifestSchema: 1,
    release: '1.2.0',
    packages: [
      {
        name: 'bm-agent',
        file: 'bm-agent-1.2.0-r1.apk',
        sha256: 'b'.repeat(64),
        size: 21504
      }
    ]
  }

  /** The router side of a bundle check: unpack, then checksum. */
  const answerBundle = (sum: string) => (command: string): ModuleExecResult | null => {
    if (command.includes('mktemp -d /tmp/bm-stage')) return ok('/tmp/bm-stage.AbC123\n')
    if (command.includes('bundle.b64')) return ok(JSON.stringify(BUNDLE_MANIFEST))
    if (command.includes('sha256sum')) return ok(`${sum}  bm-agent-1.2.0-r1.apk\n`)
    return null
  }

  it('unpacks and checksums on the router before anything is installed', async () => {
    const owrt = await router({ agent: null, answer: answerBundle('b'.repeat(64)) })

    const result = await owrt.call('agentInstallCheck', {
      source: 'bundle',
      bundleText: 'AAAABBBBCCCC=='
    })

    expect(report(result).ok).toBe(true)
    expect(text(result)).toContain('nothing has been installed yet')
    expect(text(result)).toContain('release 1.2.0')
    // Pushed on stdin rather than as an argument: a few hundred kilobytes is
    // past any argument limit, and /proc/<pid>/cmdline is world-readable.
    const upload = owrt.harness.exec.mock.calls.find((call) =>
      String(call[0]).includes('bundle.b64')
    )
    expect(String(call1(upload))).toContain('AAAABBBBCCCC==')
    owrt.dispose()
  })

  // OpenWRT builds BusyBox with base64 off - `BUSYBOX_DEFAULT_BASE64` is `n`,
  // along with uuencode and uudecode - so a stock 25.12 router has no base64
  // command. Finding that out on the one install path that exists for routers
  // with no internet would be a poor way to learn it, so the decode falls back
  // to ucode, whose b64dec is a built-in and which every image with firewall4
  // already has.
  it('decodes without base64, which a stock OpenWRT router does not have', async () => {
    const owrt = await router({ agent: null, answer: answerBundle('b'.repeat(64)) })

    await owrt.call('agentInstallCheck', { source: 'bundle', bundleText: 'AAAABBBBCCCC==' })

    const upload = String(
      owrt.harness.exec.mock.calls.map((call) => String(call[0])).find((c) => c.includes('bundle.b64'))
    )
    expect(upload).toContain('command -v base64')
    expect(upload).toContain('/usr/bin/ucode')
    expect(upload).toContain('b64dec')
    // And it says which of the two is missing rather than failing at `tar`.
    expect(upload).toContain('neither base64 nor ucode')
    owrt.dispose()
  })

  it('stops before apk when a file does not match the manifest it came with', async () => {
    const owrt = await router({ agent: null, answer: answerBundle('c'.repeat(64)) })

    const result = await owrt.call('agentInstallCheck', {
      source: 'bundle',
      bundleText: 'AAAABBBBCCCC=='
    })

    expect(report(result).ok).toBe(false)
    expect(text(result)).toContain('does not match the checksum')
    expect(owrt.commands().join('\n')).not.toContain('apk add')
    // And the half-unpacked directory is taken away rather than left in tmpfs.
    expect(owrt.commands().join('\n')).toContain('rm -rf ')
    owrt.dispose()
  })

  it('refuses anything that is not base64 text, without touching the router', async () => {
    const owrt = await router({ agent: null })

    const result = await owrt.call('agentInstallCheck', {
      source: 'bundle',
      bundleText: '\u0000\u0001binary rubbish'
    })

    expect(report(result).ok).toBe(false)
    expect(text(result)).toContain('should be base64 text')
    expect(owrt.commands().join('\n')).not.toContain('mktemp')
    owrt.dispose()
  })
})

describe('taking the packages off again', () => {
  it('refuses while a binding instance is running, and names it', async () => {
    // The name and the count come off the router now, not out of this module's
    // own records, and that is the whole reason this case had to be rewritten.
    //
    // Until 3.4.0 the uninstall blocker read `hostData.instances` - a list this
    // module kept - so it would happily refuse on a machine whose router had
    // been reflashed since, and happily allow on one whose instances this
    // module had never heard of. `bm.wanbind info` is the only thing that knows
    // what is actually running, and taking the package off is exactly the
    // moment that distinction matters: what is at stake is a fail-closed
    // catch-all going away under a LAN that is relying on it.
    const daemon = fakeWanbind({
      configured: [instanceConfig({ id: 'bind_1', name: 'Office LAN', enabled: true })]
    })

    const owrt = await router({
      agent: BINDING_AGENT_INFO,
      answer: (command) => daemon.answer(command)
    })

    const result = await owrt.call('agentUninstallCheck', {})

    expect(report(result).ok).toBe(false)
    expect(text(result)).toContain('Office LAN')
    expect(text(result)).toContain('fail-closed catch-all')
    owrt.dispose()
  })

  it('keeps the configuration unless asked, and never the baseline either way', async () => {
    const owrt = await router({ agent: AGENT_INFO })

    const kept = await owrt.call('agentUninstallCheck', {})
    expect(report(kept).ok).toBe(true)
    expect(text(kept)).toContain('Reinstalling later comes back to the same router')

    const purged = await owrt.call('agentUninstallCheck', { purge: true })
    expect(report(purged).ok).toBe(true)
    expect(text(purged)).toContain('warning Also deleting the configuration')
    expect(text(purged)).toContain('baseline stays')
    owrt.dispose()
  })

  it('removes in dependency order and leaves the prerm to undo the router', async () => {
    const owrt = await router({
      agent: { ...AGENT_INFO, provides: ['binding', 'pppoe'] },
      answer: (command) => (command.startsWith('apk del') ? ok('removed') : null)
    })

    const checked = report(await owrt.call('agentUninstallCheck', {}))
    expect(checked.ok).toBe(true)
    expect(await owrt.call('agentUninstallApply', { token: checked.token, values: {} })).toMatchObject(
      { ok: true }
    )
    await settle(60)

    const del = owrt.commands().find((command) => command.startsWith('apk del'))
    // Feature packages first: each one's own prerm takes its rules off the
    // router, and the agent is what they deregister from.
    expect(del).toBe("apk del 'bm-wanbind' 'bm-pppoe-pool' 'bm-agent'")
    // No rule cleanup here at all. `apk del` at a shell has to leave the same
    // router behind as this does, and the only way to promise that is to do
    // nothing the shell would not.
    expect(owrt.commands().join('\n')).not.toContain('ip rule del')
    owrt.dispose()
  })
})

describe('the safety net around a change', () => {
  it('arms before a write and confirms after it', async () => {
    const owrt = await router({
      agent: AGENT_INFO,
      answer: (command) => (command.includes('ubus -S call bm.agent guard_') ? ok('{}') : null)
    })

    const checked = report(await owrt.call('agentUninstallCheck', {}))
    expect(checked.ok).toBe(true)
    owrt.dispose()
  })

  it('adds nothing at all on a router with no agent', async () => {
    const owrt = await router({ agent: null })

    // Nothing that resembles a guard call is ever sent. A router that has
    // always been driven over SSH should not start seeing new commands.
    expect(owrt.commands().join('\n')).not.toContain('guard_arm')
    owrt.dispose()
  })
})

/** `exec` is called as (command, options); the fixture reads the second. */
function call1(entry: unknown[] | undefined): string {
  const options = entry?.[1] as { stdin?: string } | undefined
  return options?.stdin ?? ''
}
