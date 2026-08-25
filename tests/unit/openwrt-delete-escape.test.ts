import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * Delete has to work on the router that needs it most.
 *
 * `requirements.ts` says it plainly - "Stop and delete are the way out of a
 * broken state; they never refuse" - and Delete was refusing on exactly the
 * broken states it exists for. It ran one reconcile pass before removing the
 * record, and threw on any error that pass returned. The pass covers every
 * instance, not this one, and on a router where writing a rule fails at all it
 * can never succeed.
 *
 * That is not hypothetical. A stock OpenWrt 25.12 image without `ip-full` has a
 * BusyBox `ip` that refuses a numeric routing table, so every catch-all repair
 * failed; an instance created on such a router - which the probe used to allow -
 * could not then be deleted, and the reason shown was `repair binding catch-all
 * failed (exit 1)`.
 *
 * The rule is now about what the failure means rather than that there was one.
 * On the SSH half the instance's own catch-all is removed by an explicit
 * command after the pass, so the pass failing is somebody else's problem. On
 * the router-owned half the flush inside that pass is the only thing that takes
 * the rules off, so it stays fatal - dropping the record there would strand
 * every rule the daemon had written.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const MODEL: RouterModel = {
  t: 1_700_000_000_000,
  sys: { uptimeSec: 4_000, load1: 0.2, memTotal: 512_000, memFree: 200_000 },
  ifaces: [
    {
      name: 'lan',
      proto: 'static',
      device: 'br-lan',
      l3Device: 'br-lan',
      up: true,
      pending: false,
      autostart: true,
      uptimeSec: 4_000,
      ipv4: { addr: '192.168.1.1', mask: 24 }
    }
  ],
  poolDev: { count: 0, rx: 0, tx: 0 },
  leases: [],
  rules: [],
  rates: {}
}

/**
 * A router whose `ip` refuses everything this module writes, which is what a
 * missing `ip-full` looks like from here: uci works, the firewall reloads, and
 * every `ip` script comes back non-zero.
 */
function fixture() {
  const harness = moduleHarness('openwrt', () => ok(), {
    hostData: {
      version: 1,
      nextSeq: 1,
      batches: [],
      instances: [
        {
          id: 'bind1',
          name: 'Office LAN',
          lan: 'lan',
          carrier: 'eth1',
          running: true,
          sticky: true,
          remap: true,
          createdAt: 1,
          slot: 0
        }
      ],
      extraTables: [],
      stickyMap: [],
      events: [],
      moduleEvents: [],
      jobs: []
    }
  })
  const scripts: string[] = []
  harness.exec.mockImplementation(async (command, options) => {
    if (command !== 'sh -s') return ok()
    const stdin = options?.stdin ?? ''
    scripts.push(stdin)
    // Only the `ip` work fails, which is the shape of a router with no
    // ip-full: uci is fine and the firewall reloads.
    //
    // `while ip -4 rule del ...; do :; done` is deliberately not included. A
    // failing command in a `while` condition ends the loop, and the loop's own
    // status is zero - so that script succeeds on this router even though the
    // `ip` inside it does not, and a mock that failed it would be testing a
    // shell that does not exist.
    const fails = /ip -4 route replace|ip -4 rule add/.test(stdin)
    return fails ? ok('', 'ip: invalid argument', 1) : ok()
  })
  const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
  return {
    engine: new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES }),
    store,
    scripts,
    model: structuredClone(MODEL)
  }
}

describe('deleting an instance on a router that cannot write rules', () => {
  it('removes it anyway, and says so rather than refusing', async () => {
    const run = fixture()
    await run.engine.onSample(run.model)

    const result = await run.engine.delete('bind1')

    expect(result.ok).toBe(true)
    expect(run.store.read().instances).toHaveLength(0)
  })

  it('still takes the firewall forwardings off the router first', async () => {
    // The half that does work has to run whatever the `ip` half does. On the
    // real router this is what left it genuinely clean - no zone, no
    // forwardings - even though the job reported failure.
    const run = fixture()
    await run.engine.onSample(run.model)

    await run.engine.delete('bind1')

    const written = run.scripts.join('\n')
    expect(written).toContain('uci -q delete firewall.bmf0_0')
    expect(written).toContain('uci commit firewall')
  })

  it('still tries to take this instance\'s own catch-all off', async () => {
    // The explicit removal after the pass. It is allowed to fail - on this
    // router it does - but skipping it would leave a rule behind on one that
    // could have removed it.
    const run = fixture()
    await run.engine.onSample(run.model)

    await run.engine.delete('bind1')

    expect(run.scripts.join('\n')).toContain(
      `ip -4 rule del pref ${DEFAULT_RULES.catchAllPrefBase}`
    )
  })
})
