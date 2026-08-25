import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import type { JobsSnapshot } from '../../openwrt/main/jobs'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'

/**
 * Start, Stop and Redial on a whole batch.
 *
 * The three are one code path with two switches in it, and both switches decide
 * whether a router is left in a state nothing will correct. `stop` is strict,
 * because a stop that half worked is the failure a user has to be told about;
 * `start` and `redial` are best-effort, because "already down" is not an error
 * when the point of the wave is to bring the session back, and a wave that
 * aborts partway leaves sessions down that nothing else will lift. What
 * best-effort gives up, the verification step after it gets back.
 *
 * A deliberate Stop is also the one row state the router cannot report: netifd
 * says only that the section is down, which is what a session failing to dial
 * looks like too. The module remembers the difference, and the watchdog reads
 * it before deciding what to redial.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const PROBE = [
  '===REL===',
  "DISTRIB_ID='OpenWrt'",
  "DISTRIB_RELEASE='25.12.0'",
  '===BOARD===',
  JSON.stringify({ model: 'Test Router', release: { distribution: 'OpenWrt', version: '25.12.0' } }),
  '===TOOLS===',
  '/sbin/ubus',
  '/sbin/uci',
  '/sbin/ip',
  '/sbin/fw4',
  '/sbin/logread',
  '/sbin/netifd',
  '/usr/sbin/nft',
  '/usr/sbin/pppd',
  '===PPP===',
  'plugin',
  'kmod',
  '===PKG===',
  'apkdb',
  '===DONE==='
].join('\n')

const BATCH = {
  id: 'b1',
  name: 'Pool',
  prefix: 'pd',
  carrier: 'eth1',
  createdAt: 1,
  count: 3,
  seqFrom: 1,
  seqTo: 3
}

/** All three sections exist and none of them is up, which is where an action starts. */
const DUMP = JSON.stringify({
  interface: [
    { interface: 'pd00001', up: false, proto: 'pppoe', device: 'pppoe-pd00001' },
    { interface: 'pd00002', up: false, proto: 'pppoe', device: 'pppoe-pd00002' },
    { interface: 'pd00003', up: false, proto: 'pppoe', device: 'pppoe-pd00003' }
  ]
})

const FAST = [
  '===SYS===',
  JSON.stringify({ uptime: 4_000, load: [0, 0, 0], memory: { total: 1, free: 1 } }),
  '===DEV===',
  'Inter-|   Receive                    |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes',
  '  eth1: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0',
  '===POOL=== 0 0 0',
  '===LEASES===',
  '===RULES===',
  '===RULESOK===',
  '1',
  '===DUMP===',
  DUMP
].join('\n')

interface Router {
  harness: ModuleHarness
  /** Every `sh -s` wave script the module sent, in order. */
  scripts: string[]
}

function router(): Router {
  const scripts: string[] = []
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: { version: 1, nextSeq: 4, batches: [BATCH] },
    config: sharedModuleConfig({ rules: { chunkDelayMs: 0 } })
  })
  harness.exec.mockImplementation(async (command, options) => {
    const stdin = options?.stdin ?? ''
    if (command.includes("echo '===REL==='")) return ok(PROBE)
    if (command.includes("echo '===SYS==='")) return ok(FAST)
    if (command === 'sh -s' && /^(ifdown|ifup) /m.test(stdin)) {
      scripts.push(stdin)
      return ok()
    }
    return ok()
  })
  return { harness, scripts }
}

async function sampled(): Promise<Router & { dispose(): void }> {
  const { harness, scripts } = router()
  const runtime = activate(harness.ctx)
  runtime.applyPollers?.()
  // One real sweep, so the module knows which sections the router has.
  expect(await harness.handlers.get('sweepNow')?.()).toMatchObject({ ok: true })
  await settle()
  return { harness, scripts, dispose: () => runtime.dispose?.() }
}

const statuses = (harness: ModuleHarness): string[] =>
  (harness.handlers.get('pppoeRows')?.('b1') as Array<{ status: string }>).map(
    (row) => row.status
  )

function lastJobs(harness: ModuleHarness): JobsSnapshot {
  const pushes = harness.emit.mock.calls.filter((call) => call[0] === 'jobs')
  return pushes[pushes.length - 1]?.[1] as JobsSnapshot
}

const stepNames = (harness: ModuleHarness): string[] =>
  lastJobs(harness).finished[0]?.items.map((item) => item.name) ?? []

describe('the script each batch action sends', () => {
  it('takes every section down for Stop, and refuses to continue past a failure', async () => {
    const run = await sampled()

    expect(run.harness.handlers.get('pppoeBatchAction')?.('b1', 'stop')).toMatchObject({ ok: true })
    await settle()

    const script = run.scripts.join('\n')
    // `set -e` rather than `|| true`: a stop that silently left half the pool
    // dialing is the one outcome the user has to hear about, and the sections
    // the router does not have are already filtered out before this is written.
    expect(script).toContain('set -e')
    expect(script).not.toContain('|| true')
    expect(script).toContain("ifdown 'pd00001'")
    expect(script).toContain("ifdown 'pd00003'")
    expect(script).not.toContain('ifup')
    run.dispose()
  })

  it('only brings sections up for Start, and does not trust the exit code', async () => {
    const run = await sampled()

    expect(run.harness.handlers.get('pppoeBatchAction')?.('b1', 'start')).toMatchObject({ ok: true })
    await settle()

    const script = run.scripts.join('\n')
    expect(script).toContain("ifup 'pd00001'")
    expect(script).not.toContain('ifdown')
    // Best-effort: one section refusing to come up must not abandon the rest of
    // the wave, leaving sessions down that nothing will lift again.
    expect(script).toContain('|| true')
    expect(script).not.toContain('set -e')
    // And the step that gets back what best-effort gave up. It cannot assert
    // the sessions are up - PPPoE takes seconds to dial - only that a section
    // netifd accepted is a section netifd still lists.
    expect(stepNames(run.harness).some((name) => name.startsWith('Verify'))).toBe(true)
    run.dispose()
  })

  it('takes each section down and back up for Redial, in that order', async () => {
    const run = await sampled()

    expect(run.harness.handlers.get('pppoeBatchAction')?.('b1', 'redial')).toMatchObject({
      ok: true
    })
    await settle()

    const script = run.scripts.join('\n')
    const downAt = script.indexOf("ifdown 'pd00003'")
    const upAt = script.indexOf("ifup 'pd00001'")
    expect(downAt).toBeGreaterThanOrEqual(0)
    // Every ifdown in the wave comes before the first ifup: a section brought
    // back up before its neighbour went down would dial against a carrier the
    // wave is still tearing sessions off.
    expect(upAt).toBeGreaterThan(downAt)
    run.dispose()
  })

  it('adds no verification step to a Stop, which has nothing to verify', async () => {
    // The check reads "is this section still listed", which is true of a
    // stopped section as much as a running one; running it after a stop would
    // be a green step that measured nothing.
    const run = await sampled()

    run.harness.handlers.get('pppoeBatchAction')?.('b1', 'stop')
    await settle()

    expect(stepNames(run.harness).some((name) => name.startsWith('Verify'))).toBe(false)
    run.dispose()
  })
})

describe('a session stopped by hand', () => {
  it('reads as stopped rather than as one that failed to dial', async () => {
    // netifd reports a deliberate stop and a session whose pppd never got a
    // PADO the same way: the section is simply down. Only the module knows
    // which of the two this is, and the watchdog redials the other one.
    const run = await sampled()
    expect(statuses(run.harness)).toEqual(['dialing', 'dialing', 'dialing'])

    run.harness.handlers.get('pppoeConnAction')?.(['pd00002'], 'stop')
    await settle()

    expect(statuses(run.harness)).toEqual(['dialing', 'stopped', 'dialing'])
    run.dispose()
  })

  it('stops reading that way once it is started again', async () => {
    const run = await sampled()
    run.harness.handlers.get('pppoeConnAction')?.(['pd00002'], 'stop')
    await settle()
    expect(statuses(run.harness)).toEqual(['dialing', 'stopped', 'dialing'])

    run.harness.handlers.get('pppoeConnAction')?.(['pd00002'], 'start')
    await settle()

    // Left set, the row would claim a session the user has just restarted is
    // still stopped until the next time the router reported it up.
    expect(statuses(run.harness)).toEqual(['dialing', 'dialing', 'dialing'])
    run.dispose()
  })
})

describe('an action that cannot be run', () => {
  it('refuses a word that is not one of the three actions', async () => {
    const run = await sampled()

    expect(run.harness.handlers.get('pppoeBatchAction')?.('b1', 'restart')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not a PPPoE action')
    })
    expect(run.scripts).toEqual([])
    run.dispose()
  })

  it('refuses a batch it has no record of', async () => {
    const run = await sampled()

    expect(run.harness.handlers.get('pppoeBatchAction')?.('b9', 'stop')).toMatchObject({
      ok: false,
      error: 'no such PPPoE batch'
    })
    run.dispose()
  })

  it('refuses a selection of interfaces no batch of this module owns', async () => {
    // The row action and the bulk action arrive here as the same list, so a
    // single name gets the same filter. Acting on `wan` would take the router's
    // own uplink down.
    const run = await sampled()

    expect(run.harness.handlers.get('pppoeConnAction')?.(['wan'], 'stop')).toMatchObject({
      ok: false,
      error: expect.stringContaining('managed batch')
    })
    expect(run.harness.handlers.get('pppoeConnAction')?.([], 'stop')).toMatchObject({
      ok: false,
      error: 'nothing was selected'
    })
    expect(run.scripts).toEqual([])
    run.dispose()
  })
})
