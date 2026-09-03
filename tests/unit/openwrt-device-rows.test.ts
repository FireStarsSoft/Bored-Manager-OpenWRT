/**
 * The dashboard's device table, which is the router's lease list with one
 * column saying where each machine goes out.
 *
 * That column is the only thing on it the daemon owns, and it was being worked
 * out here instead: from this module's own document, which holds no instances
 * any more, and from a window of ip rule priorities that excludes the one-to-one
 * band entirely. So a machine pinned to a WAN by hand read as unmanaged, and so
 * did every client an instance had seated.
 */
import { describe, expect, it } from 'vitest'
import {
  assignment,
  binding,
  fakeWanbind,
  instanceConfig,
  instanceState,
  wanbindClient
} from '../helpers/wanbind'
import { Queries } from '../../openwrt/main/queries'
import { ConfigStore } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'

const MODEL: RouterModel = {
  t: 0,
  sys: { uptimeSec: 1, load1: 0, memTotal: 1, memFree: 1 },
  ifaces: [
    {
      name: 'lan',
      proto: 'static',
      device: 'br-lan',
      l3Device: 'br-lan',
      up: true,
      pending: false,
      ipv4: { addr: '10.0.0.1', mask: 24 },
      autostart: true,
      uptimeSec: 100,
      errorCode: '',
      ip4Table: 0
    },
    {
      name: 'wan1',
      proto: 'pppoe',
      device: 'eth1',
      l3Device: 'pppoe-wan1',
      up: true,
      pending: false,
      ipv4: { addr: '203.0.113.5', mask: 32 },
      autostart: true,
      uptimeSec: 100,
      errorCode: '',
      ip4Table: 101
    }
  ],
  leases: [
    { mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.0.11', host: 'workshop', expires: 1_900_000_000 },
    { mac: 'aa:bb:cc:dd:ee:02', ip: '10.0.0.12', host: 'desk', expires: 1_900_000_000 }
  ],
  rules: [],
  poolDev: { rx: 0, tx: 0, count: 0 },
  rates: {}
}

async function rowsFrom(daemon: ReturnType<typeof fakeWanbind>) {
  const client = wanbindClient({ daemon })
  await client.tick()

  const config = new ConfigStore(client.harness.ctx)
  const store = new HostStore(client.harness.ctx, () => config.effectiveRules())
  const queries = new Queries(
    () => MODEL,
    () => ({}),
    config,
    store,
    {
      answered: () => client.manager.answered(),
      deviceView: () => client.manager.deviceView(),
      heldKeys: () => client.manager.heldKeys(),
      instanceLans: () => client.manager.instanceLans()
    }
  )

  const rows = queries.deviceRows()
  store.dispose()
  client.dispose()
  return rows
}

describe('a device row says where that machine actually goes out', () => {
  it('names the WAN a one-to-one binding pinned it to, and no instance', async () => {
    const daemon = fakeWanbind()
    daemon.state.bindings = [
      binding({ id: 'bmdir_a1', ip: '10.0.0.11', wan: 'wan1', state: 'bound' })
    ]

    const rows = await rowsFrom(daemon)
    const row = rows.find((one) => one.ip === '10.0.0.11')

    expect(row?.wan).toBe('wan1')
    expect(row?.bindingStatus).toBe('bound')

    // No instance, because none of this was an instance's decision - and a row
    // that named one would send somebody to a page that cannot change it.
    expect(row?.instanceId ?? '').toBe('')
  })

  it('and names the instance that seated it when one did', async () => {
    const daemon = fakeWanbind()
    daemon.state.configured = [instanceConfig({ id: 'bmi_aaa001', lan: 'lan' })]
    daemon.state.instances = [instanceState({ id: 'bmi_aaa001' })]
    daemon.state.assignments = [
      assignment({ instance: 'bmi_aaa001', mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.0.11', wan: 'wan1' })
    ]

    const rows = await rowsFrom(daemon)
    const row = rows.find((one) => one.ip === '10.0.0.11')

    expect(row?.wan).toBe('wan1')
    expect(row?.bindingStatus).toBe('bound')
    expect(row?.instanceId).toBe('bmi_aaa001')
  })

  it('and says a client on a running instance is waiting rather than unmanaged', async () => {
    const daemon = fakeWanbind()
    daemon.state.configured = [instanceConfig({ id: 'bmi_aaa001', lan: 'lan' })]
    daemon.state.instances = [instanceState({ id: 'bmi_aaa001' })]

    const rows = await rowsFrom(daemon)
    const row = rows.find((one) => one.ip === '10.0.0.12')

    // Waiting is a state somebody can act on - there is an instance, it is
    // running, and this machine has not been given a WAN yet. Unmanaged means
    // nothing is even trying, which is a different page and a different button.
    expect(row?.bindingStatus).toBe('waiting')
  })
})
