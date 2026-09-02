import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import activate from '../../openwrt/main/index'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import { BINDING_AGENT_INFO, OLD_BINDING_AGENT_INFO } from '../helpers/router'

/**
 * What the module says when it will not do the thing. A refusal that names no
 * cause and no next step is not much better than a crash: the user is stopped
 * and told nothing they can act on. Several of these pointed at controls that
 * do not exist ("Run Refresh"), or reported a missing package as a router
 * misconfiguration, or - sixteen times over - named an internal object.
 *
 * Every refusal below now comes through `activate()` and the requirement table
 * in `requirements.ts`, which is the only thing left that refuses a WAN Binding
 * create on this side: the engine that used to do its own gating is gone, and
 * `wanbind/plan.ts` behind it asks the router. The table's first entry for both
 * halves of binding is the daemon itself, so a router carrying the packages is
 * what makes every gate underneath it reachable at all - which is why the
 * fixtures below hand one over.
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
  /**
   * What `bm.agent info` answers, or nothing for a router with no agent at all.
   *
   * It matters far more than it used to. `bindingDaemon` is the first entry in
   * the binding create's requirement list and `pppoePool` is in the pool's, so
   * a router with no packages is refused about the packages and never reaches
   * the gate a test is about.
   */
  agent?: Record<string, unknown>
}

/**
 * A router carrying both feature packages, so the firmware-level gates
 * underneath them are the ones that answer.
 *
 * Spelled out rather than reached for from `BINDING_AGENT_INFO` alone because
 * both create forms are checked side by side below, and each wants its own
 * daemon there before it will discuss anything else.
 */
const BOTH_DAEMONS: Record<string, unknown> = {
  ...BINDING_AGENT_INFO,
  provides: ['binding', 'direct', 'pppoe'],
  features: [
    { name: 'bm-wanbind', version: '2.4.0', apiVersion: 2, provides: ['binding', 'direct'] },
    { name: 'bm-pppoe-pool', version: '2.0.0', apiVersion: 2, provides: ['pppoe'] }
  ]
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
    '===AGENT===',
    ...(shape.agent ? [JSON.stringify(shape.agent)] : []),
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
    pppoeCheck: () =>
      call('poolCreateCheck', { mode: 'multi', id: 'home', carrier: 'eth1', vlans: '101' }),
    dispose: () => runtime.dispose?.()
  }
}

const text = (report: ModuleCheckReport): string =>
  report.findings.map((finding) => `${finding.label} ${finding.detail ?? ''}`).join('\n')

describe('a missing package is not a router misconfiguration', () => {
  it('sends a router without dnsmasq to the installer, not to /etc/config/dhcp', async () => {
    const module = await moduleWith(['dnsmasq'], { agent: BINDING_AGENT_INFO })

    const report = await module.bindingCheck()

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('dnsmasq is missing on this router')
    // The finding it used to reach instead. Editing a DHCP section on a router
    // with no dnsmasq to configure is a wild goose chase.
    expect(text(report)).not.toContain('has no dnsmasq DHCP section')
    module.dispose()
  })

  it('still gates on the firewall, and no longer on the ip binary', async () => {
    const noFw4 = await moduleWith(['fw4'], { agent: BINDING_AGENT_INFO })
    // The daemon writes the firewall forwarding through fw4 exactly as this
    // module used to, so the router needing it did not change with who writes.
    expect(text(await noFw4.bindingCheck())).toContain('Firewall4 is required')
    noFw4.dispose()

    // What did change: with bm-wanbind installed no ip rule is written from
    // here at all - every bind is a ubus call and the daemon writes netlink -
    // so a router whose `ip` fails the numeric-table test must not have a
    // create refused over a binary nothing on this path uses.
    const noRules = await moduleWith(['ip-full'], { agent: BINDING_AGENT_INFO })
    expect(text(await noRules.bindingCheck())).not.toContain('steer traffic by routing table')
    noRules.dispose()
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
    expect(
      await hint(await moduleWith(['dnsmasq'], { agent: BINDING_AGENT_INFO }))
    ).toContain('Install missing packages')
  })

  it('names root as the reason, rather than sending a root problem to a shell', async () => {
    const detail = await hint(
      await moduleWith(['dnsmasq'], { uid: '1000', agent: BINDING_AGENT_INFO })
    )

    expect(detail).toContain('needs root')
    expect(detail).toContain('Connect this machine entry as root')
  })

  it('names the firmware that carries the installer when there is none', async () => {
    // A router with no apk database cannot be talked into installing anything,
    // so this is a blocking problem rather than an install hint - and the one
    // thing that would fix it is a release, not a command in a shell.
    const detail = await hint(
      await moduleWith(['dnsmasq', 'apk'], { pkg: '', agent: BINDING_AGENT_INFO })
    )

    expect(detail).toContain('No apk package database on this router')
    expect(detail).toContain('25.12')
  })

  it('points at the blocking problem first when there is one', async () => {
    const detail = await hint(await moduleWith(['dnsmasq', 'ubus'], { agent: BINDING_AGENT_INFO }))

    expect(detail).toContain('Something more basic is in the way first')
    // The blocker itself, and the fact that no install flow can supply it.
    expect(detail).toContain('ubus')
    expect(detail).toContain('cannot be installed from here')
  })
})

describe('one missing firewall, one explanation', () => {
  it('says the same thing on both create forms, and that it is not installable', async () => {
    const module = await moduleWith(['fw4'], { agent: BOTH_DAEMONS })

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
  it('sends a router with no binding daemon to the page that installs one', async () => {
    // The first gate on both binding forms, and the one every router without
    // the packages meets. It has to name somewhere a person can go: there is no
    // control called "Refresh" anywhere in the four specs, and a refusal that
    // named the object doing the refusing was worth even less.
    const module = await moduleWith()

    const detail = text(await module.bindingCheck())

    expect(detail).toContain('The binding daemon this module drives is not on this router')
    expect(detail).toContain('Router packages')
    expect(detail).toContain('Module settings')
    // Nothing internal reaches a person: not the object, not the folder, not
    // the transport it would have used.
    expect(detail).not.toMatch(/binding engine|BindingManager|ubus/)
    module.dispose()
  })

  it('tells a router on the older packages to update them, not to install them', async () => {
    // The one router that has the package and still cannot be driven: 2.3.0
    // owns instances and one-to-one bindings and speaks the contract before
    // this one. Telling somebody to install a package they can see installed is
    // how a sentence stops being read.
    const module = await moduleWith([], { agent: OLD_BINDING_AGENT_INFO })

    const detail = text(await module.bindingCheck())

    expect(detail).toContain('speaks version 1 of its contract')
    expect(detail).toContain('Update the router packages')
    // And it says what is still happening meanwhile, because the rules on the
    // router are standing and being maintained by the daemon either way.
    expect(detail).toContain('keep working meanwhile')
    module.dispose()
  })

  it('tells a disconnected user what to do, on every page that can say it', async () => {
    const harness = moduleHarness('openwrt', () => ok(), { config: sharedModuleConfig(null) })
    // The pool daemon is on this router, so the pool gate lets the check
    // through to the one refusal this test is about: the connection.
    harness.exec.mockImplementation(async (command) =>
      command.includes("echo '===REL==='") ? ok(probeOutput([], { agent: BOTH_DAEMONS })) : ok()
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
    const pppoe = (await harness.handlers.get('poolCreateCheck')?.({
      mode: 'multi',
      id: 'home',
      carrier: 'eth1',
      vlans: '101'
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

describe('a missing pool daemon points at Router packages', () => {
  it('names the install page rather than a package manager command alone', async () => {
    // A healthy router with no Bored Manager agent: the dialing stack and the
    // firewall are all there, so what stops the pool form is the daemon that
    // owns pools - and the way forward is the page that installs it.
    const module = await moduleWith()

    const report = await module.pppoeCheck()

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('The pool daemon this module drives is not on this router')
    expect(text(report)).toContain('Router packages')
    module.dispose()
  })
})
