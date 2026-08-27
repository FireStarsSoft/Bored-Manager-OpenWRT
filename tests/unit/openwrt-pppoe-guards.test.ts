import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import { PppoeManager } from '../../openwrt/main/pppoe'
import type { JobSpec, OpenWrtJob } from '../../openwrt/main/jobs'
import type { AgentCapability } from '../../openwrt/main/probe'
import { moduleHarness } from '../helpers/module-harness'

/**
 * The pool flows, driven against a scripted bm.pppoe.
 *
 * What is being proved is the module's half of the contract: forms become the
 * spec the daemon documents, credentials travel only inside the 0600 payload
 * file, the check's findings reach the report verbatim, the token pins what
 * was checked to what is applied, and the delete gate refuses while a binding
 * instance is distributing clients across the pool's carrier. The daemon's
 * own behaviour - validation, reconciliation, the firewall - is proved by the
 * ucode probes in packages/ci, against the real modules.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const DAEMON: AgentCapability = {
  installed: true,
  running: true,
  release: '2.0.0',
  apiVersion: 3,
  schema: 2,
  dataSchema: 2,
  provides: ['pppoe'],
  features: [{ name: 'bm-pppoe-pool', version: '2.0.0', apiVersion: 2, provides: ['pppoe'] }],
  guard: null,
  usable: true,
  problem: null,
  canGuard: true,
  canUpdate: true
}

interface Router {
  manager: PppoeManager
  /** Every JSON payload written into a /tmp file, in order. */
  payloads: unknown[]
  /** Every ubus method called, in order. */
  methods: string[]
  /** Every event line the module recorded. */
  events: string[]
  jobs: Array<{ label: string; state: string }>
}

/**
 * A router whose bm.pppoe answers from a script. The payload files are held
 * in memory the way tmpfs would hold them, and consumed the way the daemon
 * consumes them - a second read of the same path is a miss.
 */
const DAEMON_DIRECT: AgentCapability = {
  ...DAEMON,
  release: '2.2.0',
  features: [{ name: 'bm-pppoe-pool', version: '2.2.0', apiVersion: 3, provides: ['pppoe'] }]
}

function router(
  answer: (method: string, args: Record<string, unknown>, payload: unknown) => unknown,
  overrides: {
    bindingCarriers?: Array<{ id: string; name: string; carrier: string; running: boolean }>
    daemon?: AgentCapability
  } = {}
): Router {
  const harness = moduleHarness('openwrt', () => ok())
  const files = new Map<string, string>()
  const payloads: unknown[] = []
  const methods: string[] = []
  const events: string[] = []
  const jobs: Array<{ label: string; state: string }> = []
  let made = 0

  harness.exec.mockImplementation(async (command: string, options?: { stdin?: string }) => {
    if (command.includes('mktemp /tmp/bm-pool.XXXXXX')) {
      made += 1
      return ok(`/tmp/bm-pool.${String(made).padStart(6, 'A')}\n`)
    }
    const write = command.match(/cat > '(\/tmp\/bm-pool\.[A-Za-z0-9]{6})'/)
    if (write) {
      files.set(write[1]!, options?.stdin ?? '')
      payloads.push(JSON.parse(options?.stdin ?? 'null'))
      return ok()
    }
    if (command.startsWith('rm -f ')) return ok()

    const call = command.match(/^ubus -S call bm\.pppoe (\w+) '(.*)'$/s)
    if (call) {
      const method = call[1]!
      const args = JSON.parse(call[2]!.replace(/'\\''/g, "'")) as Record<string, unknown>
      methods.push(method)
      let payload: unknown = null
      if (typeof args.source === 'string') {
        const raw = files.get(args.source)
        files.delete(args.source)
        payload = raw === undefined ? undefined : JSON.parse(raw)
      }
      return ok(JSON.stringify(answer(method, args, payload)))
    }
    return ok()
  })

  const manager = new PppoeManager(
    harness.ctx,
    { effectiveRules: () => ({ execTimeoutSec: 60, tableBase: 10_000 }) },
    {
      start: (spec: JobSpec): OpenWrtJob => {
        const record = { label: spec.label, state: 'running' }
        jobs.push(record)
        // Run the items the way the real runner does: sequentially, abort on
        // the first failure, then the completion hook.
        void (async () => {
          let state = 'done'
          try {
            for (const item of spec.items) await item.run(() => false)
          } catch {
            state = 'failed'
          }
          record.state = state
          await spec.onFinished?.({ state } as never)
        })()
        return {
          id: 'job_1',
          kind: spec.kind,
          label: spec.label,
          state: 'running',
          startedAt: 0,
          total: spec.items.length,
          done: 0,
          failed: 0,
          progressPct: 0,
          items: []
        }
      },
      list: () => []
    },
    {
      forceDump: () => {},
      event: (kind, text) => events.push(`${kind}: ${text}`),
      ...(overrides.bindingCarriers
        ? { bindingCarriers: () => overrides.bindingCarriers! }
        : {})
    },
    () => overrides.daemon ?? DAEMON
  )

  return { manager, payloads, methods, events, jobs }
}

const settle = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** The daemon's own standing findings, echoed the way pool_check answers. */
function checkReply(ok: boolean, extra: unknown[] = []): unknown {
  return {
    ok,
    findings: [
      ...extra,
      { level: 'info', label: 'Tagged and untagged', detail: 'VLAN 0 is untagged.' }
    ]
  }
}

const MULTI_FORM = {
  mode: 'multi',
  id: 'fpt1',
  carrier: 'eth1',
  prefix: 'fpt',
  vlans: '101-102, 0',
  username: 'u@isp',
  password: 'pw',
  keepalive_failure: '5',
  keepalive_interval: '1',
  zone: 'bmwanpool',
  masq: true,
  mtu_fix: true,
  lan_forward: true
}

describe('the create gate', () => {
  it('composes the spec the daemon documents, and never puts the password on a command line', async () => {
    const run = router((method) =>
      method === 'pool_check' ? checkReply(true) : { ok: true }
    )

    const report = await run.manager.createCheck(MULTI_FORM)

    expect(report.ok).toBe(true)
    expect(report.token).toBeTruthy()
    // The spec travelled as a payload file, not as ubus arguments.
    expect(run.methods).toEqual(['pool_check'])
    expect(run.payloads[0]).toMatchObject({
      mode: 'multi',
      prefix: 'fpt',
      carrier: 'eth1',
      username: 'u@isp',
      password: 'pw',
      keepalive: '5 1',
      // In list order; the daemon sorts and validates, one gate for every UI.
      members: [{ vlan: 101 }, { vlan: 102 }, { vlan: 0 }],
      table_base: 10_000
    })
    // The daemon's standing note came through word for word.
    expect(report.findings.some((f) => f.label === 'Tagged and untagged')).toBe(true)
  })

  it('refuses locally on a list that does not parse, before any round trip', async () => {
    const run = router(() => checkReply(true))

    const report = await run.manager.createCheck({ ...MULTI_FORM, vlans: '101-xyz' })

    expect(report.ok).toBe(false)
    expect(run.methods).toEqual([])
    expect(report.findings.some((f) => f.label.includes('cannot be read'))).toBe(true)
  })

  it('hands the daemon refusal back as the report', async () => {
    const run = router((method) =>
      method === 'pool_check'
        ? checkReply(false, [{ level: 'error', label: 'Pool fpt1 already exists' }])
        : { ok: true }
    )

    const report = await run.manager.createCheck(MULTI_FORM)

    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.label === 'Pool fpt1 already exists')).toBe(true)
  })

  it('refuses Direct mode when the pool daemon is older than API 3', async () => {
    const run = router((method) =>
      method === 'pool_check' ? checkReply(true) : { ok: true }
    )

    const report = await run.manager.createCheck({
      ...MULTI_FORM,
      carrier_mode: 'direct',
      vlans: '1-3'
    })

    expect(report.ok).toBe(false)
    expect(run.methods).toEqual([])
    expect(report.findings.some((f) => f.label.includes('Direct carrier mode'))).toBe(true)
  })

  it('refuses VLAN 0 locally in Direct mode, before any round trip', async () => {
    const run = router(
      (method) => (method === 'pool_check' ? checkReply(true) : { ok: true }),
      { daemon: DAEMON_DIRECT }
    )

    const report = await run.manager.createCheck({
      ...MULTI_FORM,
      carrier_mode: 'direct',
      vlans: '0,1'
    })

    expect(report.ok).toBe(false)
    expect(run.methods).toEqual([])
    expect(report.findings.some((f) => f.label.includes('1-4094'))).toBe(true)
  })

  it('sends carrier_mode direct when the daemon speaks API 3', async () => {
    const run = router(
      (method) => (method === 'pool_check' ? checkReply(true) : { ok: true }),
      { daemon: DAEMON_DIRECT }
    )

    const report = await run.manager.createCheck({
      ...MULTI_FORM,
      carrier_mode: 'direct',
      mac_mode: 'inherit',
      vlans: '1-3'
    })

    expect(report.ok).toBe(true)
    expect(run.payloads[0]).toMatchObject({
      mode: 'multi',
      carrier_mode: 'direct',
      mac_mode: 'inherit',
      members: [{ vlan: 1 }, { vlan: 2 }, { vlan: 3 }]
    })
  })

  it('parses per-VLAN member lines in single mode', async () => {
    const run = router((method) =>
      method === 'pool_check' ? checkReply(true) : { ok: true }
    )

    const report = await run.manager.createCheck({
      mode: 'single',
      id: 'vnpt1',
      carrier: 'eth1',
      prefix: 'vnp',
      mac_mode: 'inherit',
      listText: '201,a@isp,p1\n202\tb@isp\tp2\n# comment'
    })

    expect(report.ok).toBe(true)
    expect(run.payloads[0]).toMatchObject({
      mode: 'single',
      mac_mode: 'inherit',
      members: [
        { vlan: 201, user: 'a@isp', pass: 'p1' },
        { vlan: 202, user: 'b@isp', pass: 'p2' }
      ]
    })
  })
})

describe('the apply after the check', () => {
  async function checked(run: Router): Promise<ModuleCheckReport> {
    const report = await run.manager.createCheck(MULTI_FORM)
    expect(report.ok).toBe(true)
    return report
  }

  it('creates from the frozen spec and verifies against the router', async () => {
    const run = router((method) => {
      if (method === 'pool_check') return checkReply(true)
      if (method === 'pool_create') return { ok: true, id: 'fpt1', created: 3 }
      if (method === 'info') {
        return {
          name: 'bm-pppoe-pool',
          release: '2.0.0',
          apiVersion: 2,
          settings: { enabled: true, counter_interval: 5, redial_after: 120, redial_batch: 20 },
          started: 1,
          uptime: 1,
          pools: [{ ...POOL_TOLD, members: 3, memberList: [] }],
          legacy: []
        }
      }
      if (method === 'sessions') return { sessions: [], limit: 500 }
      return { ok: true }
    })
    const report = await checked(run)

    // The renderer blanks the omitOnApply fields when it applies - exactly
    // the fields this form carries, so no more and no fewer keys than the
    // check saw.
    const applied = await run.manager.createApply({
      token: report.token,
      values: { ...MULTI_FORM, password: '' }
    })
    await settle()

    expect(applied.ok).toBe(true)
    // The check, the create, then the verify step's read-back; the completion
    // hook refreshes once more, which is one extra info/sessions pair at most.
    expect(run.methods.slice(0, 4)).toEqual(['pool_check', 'pool_create', 'info', 'sessions'])
    // A fresh payload file for the create: the check consumed the first.
    expect(run.payloads).toHaveLength(2)
    expect(run.payloads[1]).toMatchObject({ username: 'u@isp', password: 'pw' })
    expect(run.jobs[0]?.state).toBe('done')
    // Nothing the module keeps carries the password.
    expect(JSON.stringify(run.events)).not.toContain('pw')
    expect(run.jobs[0]?.label).not.toContain('pw')
  })

  it('refuses a token whose values were edited after the check', async () => {
    const run = router((method) =>
      method === 'pool_check' ? checkReply(true) : { ok: true }
    )
    const report = await checked(run)

    const applied = await run.manager.createApply({
      token: report.token,
      values: { ...MULTI_FORM, password: '', vlans: '999' }
    })

    expect(applied.ok).toBe(false)
    expect(applied.error).toContain('check again')
    expect(run.methods).toEqual(['pool_check'])
  })
})

describe('editing a pool', () => {
  it('sends only the keys the form carried', async () => {
    const run = router((method) => {
      if (method === 'info') {
        return {
          name: 'bm-pppoe-pool',
          release: '2.0.0',
          apiVersion: 2,
          settings: { enabled: true, counter_interval: 5, redial_after: 120, redial_batch: 20 },
          started: 1,
          uptime: 1,
          pools: [POOL_TOLD],
          legacy: []
        }
      }
      if (method === 'sessions') return { sessions: [], limit: 500 }
      if (method === 'pool_check') return checkReply(true)
      if (method === 'pool_set') {
        return { ok: true, id: 'fpt1', changed: { added: [], removed: [], rewritten: 2 } }
      }
      return { ok: true }
    })
    await run.manager.refresh()

    const report = await run.manager.setCheck('fpt1', { label: 'Renamed', service: '' })
    expect(report.ok).toBe(true)

    const spec = run.payloads.at(-1) as Record<string, unknown>
    expect(spec).toEqual({ label: 'Renamed', service: '' })

    const applied = await run.manager.setApply('fpt1', {
      token: report.token,
      values: { label: 'Renamed', service: '' }
    })
    expect(applied.ok).toBe(true)
    expect(applied.data).toContain('2 rewritten')
  })
})

describe('deleting a pool', () => {
  it('refuses while a binding instance is running on the pool carrier', async () => {
    const run = router(
      (method) => {
        if (method === 'info') {
          return {
            name: 'bm-pppoe-pool',
            release: '2.0.0',
            apiVersion: 2,
            settings: { enabled: true, counter_interval: 5, redial_after: 120, redial_batch: 20 },
            started: 1,
            uptime: 1,
            pools: [POOL_TOLD],
            legacy: []
          }
        }
        if (method === 'sessions') return { sessions: [], limit: 500 }
        return { ok: true }
      },
      {
        bindingCarriers: [{ id: 'b1', name: 'Office', carrier: 'eth1.835', running: true }]
      }
    )
    await run.manager.refresh()

    const refused = await run.manager.delete('fpt1')

    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('Office')
    expect(refused.error).toContain('Stop it first')
    expect(run.methods).not.toContain('pool_delete')
  })

  it('deletes through the daemon and verifies it is gone', async () => {
    let deleted = false
    const run = router((method) => {
      if (method === 'pool_delete') {
        deleted = true
        return { ok: true, id: 'fpt1', removed: 2 }
      }
      if (method === 'info') {
        return {
          name: 'bm-pppoe-pool',
          release: '2.0.0',
          apiVersion: 2,
          settings: { enabled: true, counter_interval: 5, redial_after: 120, redial_batch: 20 },
          started: 1,
          uptime: 1,
          pools: deleted ? [] : [POOL_TOLD],
          legacy: []
        }
      }
      if (method === 'sessions') return { sessions: [], limit: 500 }
      return { ok: true }
    })
    await run.manager.refresh()

    const outcome = await run.manager.delete('fpt1')
    await settle()

    expect(outcome.ok).toBe(true)
    expect(run.methods).toContain('pool_delete')
    expect(run.jobs[0]?.state).toBe('done')
  })
})

describe('the member actions', () => {
  it('refuses an action the daemon does not have', async () => {
    const run = router(() => ({ ok: true }))

    const outcome = await run.manager.connAction(['fpt101'], 'reboot')

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('up, down, redial, enable or disable')
    expect(run.methods).toEqual([])
  })

  it('sends rows and bulk selections through the same call', async () => {
    const run = router((method) =>
      method === 'action'
        ? { ok: true, action: 'disable', sections: ['fpt101'] }
        : method === 'info'
          ? {
              name: 'bm-pppoe-pool',
              release: '2.0.0',
              apiVersion: 2,
              settings: { enabled: true, counter_interval: 5, redial_after: 120, redial_batch: 20 },
              started: 1,
              uptime: 1,
              pools: [],
              legacy: []
            }
          : { sessions: [], limit: 500 }
    )

    const outcome = await run.manager.connAction('fpt101', 'disable')

    expect(outcome.ok).toBe(true)
    expect(run.methods[0]).toBe('action')
  })
})

/** The flat pool entry `info` answers with, reused by several scripts. */
const POOL_TOLD = {
  id: 'fpt1',
  mode: 'multi',
  label: '',
  prefix: 'fpt',
  carrier: 'eth1.835',
  mac_mode: 'auto',
  username: 'u@isp',
  hasPassword: true,
  table_base: 10_000,
  service: '',
  ac: '',
  ac_mac: '',
  mtu: 0,
  keepalive: '',
  ipv6: '0',
  peerdns: false,
  dns: [],
  defaultroute: true,
  host_uniq: '',
  demand: 0,
  padi_attempts: 0,
  padi_timeout: 0,
  pppd_options: '',
  zone: 'bmwanpool',
  masq: true,
  mtu_fix: true,
  lan_forward: true,
  created: 1_700_000_000,
  memberList: [
    { vlan: 101, username: '' },
    { vlan: 102, username: '' }
  ],
  members: 2,
  up: 2,
  dialing: 0,
  down: 0,
  error: 0,
  stopped: 0,
  unwritten: 0,
  createdAt: 1_700_000_000,
  rate: { rxBps: 0, txBps: 0 }
}
