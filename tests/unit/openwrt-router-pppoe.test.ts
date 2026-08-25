import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import activate from '../../openwrt/main/index'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import { AGENT_INFO, isProbeCommand, routerProbeOutput } from '../helpers/router'

/**
 * Creating a pool through `bm-pppoe-pool`, and the one thing that must be true
 * of it however it is done.
 *
 * A PPPoE password is readable by every process on the router for as long as it
 * is on a command line - `/proc/<pid>/cmdline` is world-readable - so neither
 * half may ever put one there. The SSH path keeps that invariant by piping UCI
 * lines through stdin; this one keeps it by writing the account list to a
 * `0600` file and passing only its path. The tests below are mostly about that.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 60): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * A pool this router already has.
 *
 * Actions only touch sections that belong to a managed batch, so without a
 * record every one of them is refused before a command is composed - which
 * would make the assertions below pass for the wrong reason.
 */
const BATCH = {
  id: 'b1',
  name: 'Pool A',
  prefix: 'ppp',
  carrier: 'eth1',
  createdAt: 1_700_000_000_000,
  count: 2,
  seqFrom: 1,
  seqTo: 2
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

const ACCOUNTS = ['alice@isp,secret-alice', 'bob@isp,secret-bob'].join('\n')

const TEMP = '/tmp/bm-pool.AbC123'

const VALUES = {
  name: 'Pool A',
  prefix: 'ppp',
  carrier: 'eth1',
  listText: ACCOUNTS
}

/**
 * What an apply sends back.
 *
 * The account list is deliberately blank: the check froze the parsed rows on
 * the server side, and the form does not send the credentials a second time.
 * Anything else here has to match what was checked, or the token is refused.
 */
const APPLY_VALUES = { ...VALUES, listText: '', listFile: '' }

interface Router {
  harness: ModuleHarness
  call(method: string, ...args: unknown[]): Promise<unknown>
  commands(): string[]
  stdins(): string[]
  dispose(): void
}

async function router(
  options: {
    provides?: string[]
    answer?: (command: string, stdin: string) => ModuleExecResult | null
    /** A router that already has a pool, for the tests that act on one. */
    batches?: unknown[]
  } = {}
): Promise<Router> {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: { ...HOST, batches: options.batches ?? [], nextSeq: options.batches?.length ? 3 : 1 },
    config: sharedModuleConfig(null)
  })

  harness.exec.mockImplementation(async (command, execOptions) => {
    if (isProbeCommand(command)) {
      return ok(routerProbeOutput({ agent: { ...AGENT_INFO, provides: options.provides ?? [] } }))
    }
    const answered = options.answer?.(command, execOptions?.stdin ?? '')
    if (answered) return answered
    if (command.includes('mktemp /tmp/bm-pool')) return ok(`${TEMP}\n`)
    if (command.includes('ubus -S call bm.pppoe pool_create')) {
      return ok(JSON.stringify({ ok: true, id: 'bmb1', created: 2, seqFrom: 1, seqTo: 2 }))
    }
    if (command.includes('ubus -S call bm.pppoe')) return ok(JSON.stringify({ ok: true }))
    // The carrier has to exist, or the check refuses before any of this. The
    // inspection runs as one `sh -s` script and names its own sections.
    if (command === 'sh -s' && (execOptions?.stdin ?? '').includes('===CARRIER===')) {
      return ok('===CARRIER===1\n===NETWORK===\n')
    }
    if (command.startsWith('nft list ruleset')) return ok('1 1')
    return ok()
  })

  const runtime = activate(harness.ctx)
  runtime.applyPollers?.()
  await settle()

  return {
    harness,
    call: async (method, ...args) => harness.handlers.get(method)?.(...args),
    commands: () => harness.exec.mock.calls.map((call) => String(call[0])),
    stdins: () =>
      harness.exec.mock.calls.map((call) => String((call[1] as { stdin?: string })?.stdin ?? '')),
    dispose: () => runtime.dispose?.()
  }
}

/** The check gate has to pass before an apply exists to test. */
async function plan(owrt: Router): Promise<string> {
  const report = (await owrt.call('pppoeBatchCheck', VALUES)) as ModuleCheckReport
  if (!report.token) {
    throw new Error(
      `the check refused: ${report.findings
        .map((finding) => `${finding.level} ${finding.label}`)
        .join(' | ')}`
    )
  }
  return report.token
}

describe('creating a pool on a router that has bm-pppoe-pool', () => {
  it('writes the accounts to a 0600 file and passes only its path', async () => {
    const owrt = await router({ provides: ['pppoe'] })
    const token = await plan(owrt)
    expect(token).not.toBe('')

    await owrt.call('pppoeBatchApply', {
      token,
      values: APPLY_VALUES
    })
    await settle(80)

    const commands = owrt.commands()
    const joined = commands.join('\n')

    // The file is made by mktemp, not by a name this module composed: a
    // guessable path under /tmp can be pre-created as a symlink and turned into
    // a write somewhere else entirely.
    expect(joined).toContain('mktemp /tmp/bm-pool.XXXXXX')
    expect(joined).toContain('umask 077')
    expect(joined).toContain(`ubus -S call bm.pppoe pool_create`)

    // The whole point: no password is an argument to anything.
    expect(joined).not.toContain('secret-alice')
    expect(joined).not.toContain('secret-bob')

    // It did travel, but on stdin.
    expect(owrt.stdins().join('\n')).toContain('secret-alice')
    owrt.dispose()
  })

  it('does not fall back to writing chunks itself', async () => {
    const owrt = await router({ provides: ['pppoe'] })
    const token = await plan(owrt)

    await owrt.call('pppoeBatchApply', {
      token,
      values: APPLY_VALUES
    })
    await settle(80)

    // One create goes one way or the other. Half a pool through each would be
    // two idea of which sections exist.
    expect(owrt.stdins().join('\n')).not.toContain('set network.ppp00001.password')
    owrt.dispose()
  })

  it('still writes the chunks itself on a router without the package', async () => {
    const owrt = await router({ provides: [] })
    const token = await plan(owrt)

    await owrt.call('pppoeBatchApply', {
      token,
      values: APPLY_VALUES
    })
    await settle(80)

    const stdin = owrt.stdins().join('\n')
    expect(stdin).toContain('set network.ppp00001.proto=')
    // And the credentials still never reach a command line on this path either.
    expect(owrt.commands().join('\n')).not.toContain('secret-alice')
    expect(owrt.commands().join('\n')).not.toContain('ubus -S call bm.pppoe')
    owrt.dispose()
  })

  it('fails the create when the router refuses, rather than writing half of it', async () => {
    const owrt = await router({
      provides: ['pppoe'],
      answer: (command) =>
        command.includes('bm.pppoe pool_create')
          ? ok(JSON.stringify({ ok: false, reason: 'the prefix has to be 1 to 4 characters' }))
          : null
    })
    const token = await plan(owrt)

    const result = (await owrt.call('pppoeBatchApply', {
      token,
      values: APPLY_VALUES
    })) as OkResult
    await settle(80)

    expect(result.ok).toBe(true) // the job started
    const jobs = owrt.harness.emit.mock.calls
      .filter((call) => call[0] === 'jobs')
      .map((call) => JSON.stringify(call[1]))
      .join('\n')
    expect(jobs).toContain('the prefix has to be 1 to 4 characters')
    expect(owrt.stdins().join('\n')).not.toContain('set network.ppp00001.proto=')
    owrt.dispose()
  })
})

/**
 * Acting on sessions, and the one way this half is unlike the binding half.
 *
 * Binding refuses to fall back because two writers in one ip rule priority
 * range cannot both be right. Nothing here is like that: netifd owns these
 * sections whichever half asks it, and `ifup` and the daemon's `up` are the
 * same verb. So a refusal here is a reason to do it the other way, not a
 * reason to stop - and it is not a rare case, because the daemon only acts on
 * sections belonging to a pool record it wrote itself.
 */
describe('starting and stopping sessions', () => {
  it('falls back to SSH when the router does not own the sections', async () => {
    const owrt = await router({
      provides: ['pppoe'],
      batches: [BATCH],
      answer: (command) =>
        command.includes('bm.pppoe action')
          ? ok(JSON.stringify({
              ok: false,
              reason: 'none of those sections belong to a pool on this router'
            }))
          : null
    })

    await owrt.call('pppoeConnAction', ['ppp00001'], 'stop')
    await settle(80)

    expect(owrt.commands().join('\n')).toContain('ubus -S call bm.pppoe action')
    // Every batch created before the package was installed is refused by name.
    // Without this the Stop failed the job and Start was dropped in silence.
    // The wave runs as one `sh -s` script, so the verb is on stdin.
    expect(owrt.stdins().join('\n')).toContain('ifdown')
    owrt.dispose()
  })

  it('does not also run ifdown when the router did it', async () => {
    const owrt = await router({ provides: ['pppoe'], batches: [BATCH] })

    await owrt.call('pppoeConnAction', ['ppp00001'], 'stop')
    await settle(80)

    expect(owrt.commands().join('\n')).toContain('ubus -S call bm.pppoe action')
    expect(owrt.stdins().join('\n')).not.toContain('ifdown')
    owrt.dispose()
  })
})
