import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import { harnessOverHostData, hostDataDocument, type HostDataDocument } from '../helpers/host-data'
import { sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import { POOL_AGENT_INFO, routerProbeOutput } from '../helpers/router'

/**
 * Everything here is one question asked four times: was it written, or was it
 * only ever in memory?
 *
 * Asking a handler whether a record is there proves nothing on its own - the
 * answer comes out of the store's in-memory cache and would be identical if
 * every write had been thrown away. So each of these writes through one
 * document, drops everything holding it, and asks something that has just
 * started up against that document instead.
 *
 * Two of the four this file used to ask about have gone to the router. An
 * instance and a one-to-one binding are `/etc/config/bm_wanbind` sections from
 * packages 2.4.0, and the sticky map went with them: the daemon holds who is on
 * which WAN and this module places nobody. What is left on this side is job
 * history - the only account of what the module did to the router - and the
 * instance records `wanbind/handover.ts` has yet to hand over, which are read,
 * offered to the daemon and then deleted. The `layout` stamped on one of those
 * is the whole reason the handover works: it is what tells the daemon which
 * priorities the rules already standing were written at, so it adopts them
 * rather than writing a second set somewhere else and sweeping the first a
 * moment later.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// ------------------------------------------------------------- PPPoE + jobs
//
// The batch record itself no longer lives in this document - the pool of
// record is /etc/config/bm_pppoe on the router, kept by bm-pppoe-pool - so
// the restart question left with it. What still has to survive a restart on
// this side is the job history the create leaves behind.

/** A router whose pool daemon accepts a one-member create. */
function pppoeRouter(doc: HostDataDocument): ModuleHarness {
  const harness = harnessOverHostData('openwrt', () => ok(), doc, {
    config: sharedModuleConfig(null)
  })
  harness.exec.mockImplementation(async (command) => {
    if (command.includes("echo '===REL==='")) {
      return ok(routerProbeOutput({ agent: POOL_AGENT_INFO }))
    }
    if (command.includes('mktemp /tmp/bm-pool.XXXXXX')) return ok('/tmp/bm-pool.doc001\n')
    if (command.includes("cat > '/tmp/bm-pool.")) return ok()
    if (command.includes('bm.pppoe pool_check')) {
      return ok(JSON.stringify({ ok: true, findings: [] }))
    }
    if (command.includes('bm.pppoe pool_create')) {
      return ok(JSON.stringify({ ok: true, id: 'fpt1', created: 1 }))
    }
    if (command.includes('bm.pppoe info')) {
      return ok(
        JSON.stringify({
          name: 'bm-pppoe-pool',
          release: '2.0.0',
          apiVersion: 2,
          settings: { enabled: true, counter_interval: 5, redial_after: 120, redial_batch: 20 },
          started: 1,
          uptime: 1,
          pools: [
            {
              id: 'fpt1',
              mode: 'multi',
              label: '',
              prefix: 'fpt',
              carrier: 'eth1',
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
              created: 1,
              memberList: [{ vlan: 101, username: '' }],
              members: 1,
              up: 0,
              dialing: 0,
              down: 1,
              error: 0,
              stopped: 0,
              unwritten: 0,
              createdAt: 1,
              rate: { rxBps: 0, txBps: 0 }
            }
          ],
          legacy: []
        })
      )
    }
    if (command.includes('bm.pppoe sessions')) {
      return ok(JSON.stringify({ sessions: [], limit: 500 }))
    }
    return ok()
  })
  return harness
}

describe('a PPPoE create after the module is restarted', () => {
  it('brings the job that created it back out of the document', async () => {
    const doc = hostDataDocument()
    const first = pppoeRouter(doc)
    const running = activate(first.ctx)
    running.applyPollers?.()
    await settle()

    const values = { mode: 'multi', id: 'fpt1', carrier: 'eth1', prefix: 'fpt', vlans: '101' }
    const report = (await first.handlers.get('poolCreateCheck')?.(values)) as {
      ok: boolean
      token?: string
    }
    expect(report.ok).toBe(true)
    expect(
      await first.handlers.get('poolCreateApply')?.({ token: report.token, values })
    ).toMatchObject({ ok: true })
    await settle()

    // Job history is written on the ten-second debounce, so the flush that
    // dispose performs is the only thing that can have saved it.
    running.dispose?.()
    expect(doc.writes).toBeGreaterThan(0)

    const second = pppoeRouter(doc)
    const restarted = activate(second.ctx)
    const jobs = (restarted.snapshots?.() as { jobs: { finished: Array<{ label: string; state: string }> } })
      .jobs

    expect(jobs.finished.map((job) => job.label)).toContain('Create pool fpt1 (1 interface)')
    expect(jobs.finished[0].state).toBe('done')
    restarted.dispose?.()
  })
})

// ---------------------------------------------------- a record awaiting handover

/** The layout an instance created before 3.4.0 was stamped with. */
const STAMPED = {
  tableBase: DEFAULT_RULES.tableBase,
  rulePrefBase: DEFAULT_RULES.rulePrefBase,
  catchAllPrefBase: DEFAULT_RULES.catchAllPrefBase,
  catchAllTable: DEFAULT_RULES.catchAllTable,
  zoneName: DEFAULT_RULES.zoneName
}

function storeOver(doc: HostDataDocument): HostStore {
  const harness = harnessOverHostData('openwrt', () => ok(), doc)
  return new HostStore(harness.ctx, () => DEFAULT_RULES)
}

describe('a binding instance record after the module is restarted', () => {
  it('keeps the numbering it was installed under, all five values or none', async () => {
    const doc = hostDataDocument()
    const first = storeOver(doc)

    // Write-through, the way an instance create was: a crash inside the
    // ten-second debounce would otherwise bring the module back believing it
    // owns no LAN while the rules it wrote are still on the router.
    first.updateNow((data) => {
      data.instances.push({
        id: 'bind1',
        name: 'Office LAN',
        lan: 'lan',
        carrier: 'eth1',
        running: true,
        sticky: true,
        remap: true,
        createdAt: 1,
        slot: 0,
        layout: { ...STAMPED }
      })
    })
    expect(doc.writes).toBeGreaterThan(0)

    // Read back through a second store rather than off the document, because
    // the store is what the handover reads and it is where a value can be
    // dropped in silence: the reader takes all five or none, so a stamp that
    // came back half-read would have the daemon adopt one number and allocate
    // the other - two copies of every rule, and the first set left with no
    // owner.
    const second = storeOver(doc)
    expect(second.read().instances[0]?.layout).toEqual(STAMPED)
    first.dispose()
    second.dispose()
  })
})
