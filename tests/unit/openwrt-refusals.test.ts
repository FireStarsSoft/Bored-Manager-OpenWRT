import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { applyFirewallPlan, buildFirewallPlan } from '../../openwrt/main/uci'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'

/**
 * What the module says when it will not do the thing. A refusal that names no
 * cause and no next step is not much better than a crash: the user is stopped
 * and told nothing they can act on. Several of these pointed at controls that
 * do not exist ("Run Refresh"), or reported a missing package as a router
 * misconfiguration, or - sixteen times over - named an internal object.
 */

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 30): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const ROUTER_TOOLS = [
  '/sbin/ubus',
  '/sbin/uci',
  '/sbin/ip',
  '/sbin/fw4',
  '/sbin/logread',
  '/usr/sbin/nft',
  '/sbin/netifd',
  '/usr/sbin/pppd',
  '/usr/sbin/dnsmasq',
  '/usr/bin/apk'
]

interface RouterShape {
  /** `id -u`. Anything but 0 is a login that cannot install packages. */
  uid?: string
  /** The package database the probe finds, if any. */
  pkg?: string
}

/**
 * A healthy router, minus whatever `without` names. `ip-full` is special: the
 * `ip` binary is present on every OpenWRT build, and only the functional test
 * in `===IPRULE===` tells a BusyBox `ip` from one that can do policy routing.
 */
function probeOutput(without: string[] = [], shape: RouterShape = {}): string {
  const tools = ROUTER_TOOLS.filter(
    (path) => !without.includes(path.split('/').pop() ?? '')
  )
  const ipRule = without.includes('ip-full') ? [] : ['ok']
  return [
    '===REL===',
    "DISTRIB_ID='OpenWrt'",
    "DISTRIB_RELEASE='25.12.0'",
    '===BOARD===',
    JSON.stringify({ model: 'Test Router', release: { distribution: 'OpenWrt', version: '25.12.0' } }),
    '===TOOLS===',
    ...tools,
    '===PPP===',
    'plugin',
    'kmod',
    '===PKG===',
    ...(shape.pkg === '' ? [] : [shape.pkg ?? 'apkdb']),
    '===IDU===',
    shape.uid ?? '0',
    '===SPACE===',
    'Filesystem           1K-blocks      Used Available Use% Mounted on',
    '/dev/loop0                8192      2048      6144  25% /overlay',
    '===IPRULE===',
    ...ipRule,
    // The sentinel that tells a router which answered from one which never
    // did. Without it every capability reads unknown, and both create gates
    // answer "The router has not been checked yet" whatever the router said.
    '===DONE==='
  ].join('\n')
}

const CREATE = { name: 'Office', lan: 'lan', carrier: 'eth1' }

interface Module {
  bindingCheck(): Promise<ModuleCheckReport>
  pppoeCheck(): Promise<ModuleCheckReport>
  dispose(): void
}

/** Run the module far enough that its capability probe has answered. */
async function moduleWith(without: string[] = [], shape: RouterShape = {}): Promise<Module> {
  const module = moduleUnprobed(without, shape)
  await module.probe()
  return module
}

/**
 * The module as it exists between activation and the first probe answer, which
 * is what every surface sees for the first seconds after a machine connects.
 */
function moduleUnprobed(
  without: string[] = [],
  shape: RouterShape = {}
): Module & { probe(): Promise<void> } {
  const harness = moduleHarness('openwrt', () => ok(), { config: sharedModuleConfig(null) })
  harness.exec.mockImplementation(async (command) =>
    command.includes("echo '===REL==='") ? ok(probeOutput(without, shape)) : ok()
  )
  const runtime = activate(harness.ctx)
  const call = async (method: string, values: unknown): Promise<ModuleCheckReport> =>
    (await harness.handlers.get(method)?.(values)) as ModuleCheckReport
  return {
    // The host calls this once the module is enabled; nothing probes before it.
    probe: async () => {
      runtime.applyPollers?.()
      await settle()
    },
    bindingCheck: () => call('bindingCheck', CREATE),
    pppoeCheck: () => call('pppoeBatchCheck', { name: 'Home', carrier: 'eth1' }),
    dispose: () => runtime.dispose?.()
  }
}

const text = (report: ModuleCheckReport): string =>
  report.findings.map((finding) => `${finding.label} ${finding.detail ?? ''}`).join('\n')

describe('a missing package is not a router misconfiguration', () => {
  it('sends a router without dnsmasq to the installer, not to /etc/config/dhcp', async () => {
    const module = await moduleWith(['dnsmasq'])

    const report = await module.bindingCheck()

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('dnsmasq is missing on this router')
    // The finding it used to reach instead. Editing a DHCP section on a router
    // with no dnsmasq to configure is a wild goose chase.
    expect(text(report)).not.toContain('has no dnsmasq DHCP section')
    module.dispose()
  })

  it('still gates on the two capabilities it always did', async () => {
    const noRules = await moduleWith(['ip-full'])
    expect(text(await noRules.bindingCheck())).toContain('steer traffic by routing table')
    noRules.dispose()

    const noFw4 = await moduleWith(['fw4'])
    expect(text(await noFw4.bindingCheck())).toContain('Firewall4 is required')
    noFw4.dispose()
  })
})

describe('a router nobody has looked at yet', () => {
  it('is not accused of missing what was never checked', async () => {
    // Every capability defaults to false before the probe answers, so both
    // create forms used to report a perfectly healthy router as missing PPPoE
    // and Firewall4 - and then hand out install instructions for them.
    const module = moduleUnprobed()

    for (const report of [await module.pppoeCheck(), await module.bindingCheck()]) {
      expect(report.ok).toBe(false)
      expect(text(report)).toContain('The router has not been checked yet')
      expect(text(report)).not.toContain('is missing on this router')
      expect(text(report)).not.toContain('Firewall4 is required')
    }

    // And once it has answered, the real verdict comes through.
    await module.probe()
    expect(text(await module.pppoeCheck())).not.toContain('has not been checked yet')
    module.dispose()
  })
})

describe('where to install a missing package', () => {
  /** All three reach `installHint` through the dnsmasq gate on binding check. */
  const hint = async (module: Module): Promise<string> => {
    const detail = text(await module.bindingCheck())
    module.dispose()
    return detail
  }

  it('offers to do it when the router can take it', async () => {
    expect(await hint(await moduleWith(['dnsmasq']))).toContain('Install missing packages')
  })

  it('names root as the reason, rather than sending a root problem to a shell', async () => {
    const detail = await hint(await moduleWith(['dnsmasq'], { uid: '1000' }))

    expect(detail).toContain('needs root')
    expect(detail).toContain('Connect this machine entry as root')
  })

  it('names the firmware that carries the installer when there is none', async () => {
    // A router with no apk database cannot be talked into installing anything,
    // so this is a blocking problem rather than an install hint - and the one
    // thing that would fix it is a release, not a command in a shell.
    const detail = await hint(await moduleWith(['dnsmasq', 'apk'], { pkg: '' }))

    expect(detail).toContain('No apk package database on this router')
    expect(detail).toContain('25.12')
  })

  it('points at the blocking problem first when there is one', async () => {
    const detail = await hint(await moduleWith(['dnsmasq', 'ubus']))

    expect(detail).toContain('Something more basic is in the way first')
    // The blocker itself, and the fact that no install flow can supply it.
    expect(detail).toContain('ubus')
    expect(detail).toContain('cannot be installed from here')
  })
})

describe('one missing firewall, one explanation', () => {
  it('says the same thing on both create forms, and that it is not installable', async () => {
    const module = await moduleWith(['fw4'])

    const binding = text(await module.bindingCheck())
    const pppoe = text(await module.pppoeCheck())

    for (const detail of [binding, pppoe]) {
      expect(detail).toContain('nftables masquerading, which routers still on fw3 do not have')
      // The one readiness failure the install flow deliberately cannot fix. It
      // never said so, on a page that also shows "Install missing packages".
      expect(detail).toContain('cannot be installed from here')
      expect(detail).toContain('firmware upgrade')
    }
    module.dispose()
  })
})

describe('refusals name a control that exists', () => {
  function engine(): BindingEngine {
    const harness = moduleHarness('openwrt', () => ok())
    const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
    return new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES })
  }

  it('points at "Refresh now", which is the label the button really carries', async () => {
    // There is no control called "Refresh" anywhere in the four specs; the two
    // that run a sweep are labelled "Refresh now" and "Check again".
    const report = await engine().check(CREATE)

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('Refresh now')
    expect(text(report)).not.toMatch(/Run Refresh(?! now)/)
  })

  it('tells a disconnected user what to do, on every page that can say it', async () => {
    const harness = moduleHarness('openwrt', () => ok(), { config: sharedModuleConfig(null) })
    harness.exec.mockImplementation(async (command) =>
      command.includes("echo '===REL==='") ? ok(probeOutput()) : ok()
    )
    // Probe a healthy router first, then pull the link. Capabilities keep the
    // last good answer, so these two gates are reachable - which is the only
    // way a user ever sees them.
    let connected = true
    Object.defineProperty(harness.ctx, 'connected', { get: () => connected })
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()
    connected = false

    const binding = (await harness.handlers.get('bindingCheck')?.(CREATE)) as ModuleCheckReport
    const pppoe = (await harness.handlers.get('pppoeBatchCheck')?.({
      name: 'Home',
      carrier: 'eth1'
    })) as ModuleCheckReport

    // The same condition used to be phrased three different ways, and only the
    // setup page said what to do about it.
    for (const report of [binding, pppoe]) {
      expect(report.ok).toBe(false)
      expect(text(report)).toContain('The router is not connected')
      expect(text(report)).toContain('Connect the machine entry and try again.')
    }
    runtime.dispose?.()
  })
})

describe('a warning names the control the user would change', () => {
  it('points the wildcard failure at the form, not at the rule key behind it', async () => {
    const harness = moduleHarness('openwrt', () => ok())
    // Everything the plan writes succeeds and only the nft count comes back
    // empty, which is the single condition that produces this warning.
    harness.exec.mockImplementation(async (command) =>
      // grep exits 1 on a legitimate zero count.
      command.includes('nft list ruleset') ? ok('0', '', 1) : ok()
    )
    const plan = buildFirewallPlan({
      zoneName: 'bmwanpool',
      prefix: 'pd',
      mode: 'wildcard',
      networkSections: [],
      chunkSize: 100
    })

    const result = await applyFirewallPlan(harness.ctx, plan, { timeoutMs: 60_000 })

    expect(result.ok).toBe(false)
    // The text reaches the user as a job item message and an event row, nowhere
    // near anything that would translate a stored rule key into a form field.
    expect(result.warning).toContain('Firewall membership mode')
    expect(result.warning).not.toContain('zoneMode')
  })
})

describe('the engine never names itself to a user', () => {
  it('says what actually happened instead of "binding engine stopped"', async () => {
    const harness = moduleHarness('openwrt', () => ok())
    const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
    const binding = new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES })
    await binding.onSample({
      t: 1_700_000_000_000,
      sys: { uptimeSec: 4_000, load1: 0, memTotal: 512_000, memFree: 200_000 },
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
    })
    // A module the host revoked mid-check: the sample is still in hand, so the
    // probe is what refuses. This message reaches the user as a check finding
    // detail and, on the apply path, as a job item message.
    binding.dispose()

    const report = await binding.check(CREATE)

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('Router preparation state could not be read')
    expect(text(report)).not.toContain('binding engine')
    expect(text(report)).toContain('the router disconnected, or the module was reset')
  })
})

/**
 * A tagged uplink is a carrier of its own. Plenty of ISPs hand the WAN over on
 * a VLAN, so `eth1.835` and `eth1.836` are two separate uplinks on one wire -
 * while `eth1` is every one of them at once, which is what makes it clash with
 * both rather than sit beside them.
 */
describe('a carrier can be a VLAN on a device', () => {
  const iface = (name: string, device: string, over: Partial<IfaceState> = {}): IfaceState => ({
    name,
    proto: 'static',
    device,
    l3Device: device,
    up: true,
    pending: false,
    autostart: true,
    uptimeSec: 4_000,
    ...over
  })

  const SAMPLE: RouterModel = {
    t: 1_700_000_000_000,
    sys: { uptimeSec: 4_000, load1: 0, memTotal: 512_000, memFree: 200_000 },
    ifaces: [
      iface('lan', 'br-lan', { ipv4: { addr: '192.168.1.1', mask: 24 } }),
      iface('guest', 'br-guest', { ipv4: { addr: '192.168.2.1', mask: 24 } }),
      iface('office', 'br-office', { ipv4: { addr: '192.168.3.1', mask: 24 } }),
      iface('wan835', 'eth1.835', { proto: 'dhcp', ipv4: { addr: '198.51.100.5', mask: 24 } }),
      iface('wan836', 'eth1.836', { proto: 'dhcp', ipv4: { addr: '198.51.100.6', mask: 24 } })
    ],
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases: [],
    rules: [],
    // The ISP VLAN on the LAN bridge, seen on the wire before anything gave it
    // an interface section of its own.
    rates: { 'br-lan.10': { rx: 0, tx: 0 } }
  }

  const held = (name: string, lan: string, carrier: string, slot: number): unknown => ({
    id: `bind_${slot}`,
    name,
    lan,
    carrier,
    running: false,
    sticky: true,
    remap: true,
    createdAt: 1,
    slot
  })

  /** The create gate, on a router that already carries `instances`. */
  async function checkWith(
    instances: unknown[],
    values: Record<string, unknown>
  ): Promise<ModuleCheckReport> {
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: {
        version: 1,
        nextSeq: 1,
        batches: [],
        instances,
        extraTables: [],
        stickyMap: [],
        events: [],
        moduleEvents: [],
        jobs: []
      }
    })
    const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
    const binding = new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES })
    await binding.onSample(SAMPLE)
    const report = await binding.check(values)
    binding.dispose()
    return report
  }

  it('lets two VLANs on one wire be two instances', async () => {
    const report = await checkWith([held('ISP A', 'guest', 'eth1.835', 0)], {
      name: 'ISP B',
      lan: 'lan',
      carrier: 'eth1.836'
    })

    expect(text(report)).toContain('Exactly two exclusive interfaces: lan + eth1.836')
    expect(text(report)).not.toContain('already owned by another binding instance')
  })

  it('refuses the bare device beneath them, which is both of them at once', async () => {
    const report = await checkWith(
      [held('ISP A', 'guest', 'eth1.835', 0), held('ISP B', 'office', 'eth1.836', 1)],
      { name: 'ISP C', lan: 'lan', carrier: 'eth1' }
    )

    expect(report.ok).toBe(false)
    const detail = text(report)
    expect(detail).toContain('An interface is already owned by another binding instance')
    // Both holders, so the user is not sent to find the second one afterwards.
    expect(detail).toContain('ISP A')
    expect(detail).toContain('ISP B')
  })

  it('takes a VLAN on a bridge, but never the bridge itself', async () => {
    const bridge = await checkWith([], { name: 'X', lan: 'guest', carrier: 'br-lan' })
    expect(bridge.ok).toBe(false)
    expect(text(bridge)).toContain('Carrier "br-lan" is not a device an instance can bind to')

    const tagged = await checkWith([], { name: 'X', lan: 'guest', carrier: 'br-lan.10' })
    expect(text(tagged)).not.toContain('is not a device an instance can bind to')
    expect(text(tagged)).toContain('Exactly two exclusive interfaces: guest + br-lan.10')
  })

  it('still refuses a name netifd would truncate', async () => {
    const report = await checkWith([], {
      name: 'X',
      lan: 'lan',
      carrier: 'eth1234567890.10'
    })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('within the 15 characters Linux allows')
  })
})
