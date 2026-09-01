import { describe, expect, it } from 'vitest'
import type { ModuleExecOptions, ModuleExecResult } from '@shared/modules'
import {
  preparationProbe,
  type ExecDeps,
  type RouterPreparationProbe
} from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { routerLayout } from '../../openwrt/main/direct'
import type { IfaceState, RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * The router whose uplink says nothing about itself except `option gateway`.
 *
 * The interface classifier weighs several statements the router makes, and on
 * the router below every one of them is either silent or pointing the wrong
 * way: the uplink runs the static protocol exactly as a LAN does, carries a
 * private address exactly as a LAN does, has no dnsmasq stub to switch itself
 * off, and sits in a firewall zone that does not masquerade. That is a modem in
 * bridge mode behind another router, a double-NAT lab, an ISP handing out
 * RFC1918 - and the one line in the whole of /etc/config that separates it from
 * an inside network is the next hop it points at.
 *
 * The classifier has weighed that line since it was written. It could never
 * read it: the preparation dump's network filter kept section declarations,
 * ip4table and ip6assign and nothing else, so the key the branch asks for was
 * never in the document and the strongest piece of evidence about a static
 * uplink was dead code that looked alive.
 *
 * So these assertions deliberately do not hand the classifier a probe. They run
 * the shipped filter - lifted out of the script `preparationProbe` really sends
 * - over a whole `uci show` dump, and read the verdict off the far end. Nothing
 * about narrowing that grep again would look like it touched `direct/layout.ts`,
 * and this is the only thing that would notice.
 */

const ok = (stdout: string): ModuleExecResult => ({ code: 0, stdout, stderr: '' })

// ------------------------------------------------------------- the router

/** One router as `uci show` prints it, before anything filters a line out. */
interface Dump {
  ifaces: IfaceState[]
  dhcp: string[]
  network: string[]
  firewall: string[]
}

function iface(name: string, proto: string, device: string, addr: string): IfaceState {
  return {
    name,
    proto,
    device,
    l3Device: device,
    up: true,
    pending: false,
    autostart: true,
    uptimeSec: 4_000,
    ipv4: { addr, mask: 24 }
  }
}

const LOOPBACK_AND_GLOBALS = [
  'network.loopback=interface',
  "network.loopback.device='lo'",
  "network.loopback.proto='static'",
  "network.loopback.ipaddr='127.0.0.1'",
  "network.loopback.netmask='255.0.0.0'",
  'network.globals=globals',
  "network.globals.ula_prefix='fd42:8c1a:77::/48'",
  'network.@device[0]=device',
  "network.@device[0].name='br-lan'",
  "network.@device[0].type='bridge'"
]

const lanSection = (name: string, addr: string): string[] => [
  `network.${name}=interface`,
  `network.${name}.device='br-${name}'`,
  `network.${name}.proto='static'`,
  `network.${name}.ipaddr='${addr}'`,
  `network.${name}.netmask='255.255.255.0'`,
  `network.${name}.ip6assign='60'`
]

/** The uplink of a router that sits behind another one: static, private, routed. */
const staticWanSection = (gateway: boolean): string[] => [
  'network.wan=interface',
  "network.wan.device='eth1'",
  "network.wan.proto='static'",
  "network.wan.ipaddr='192.168.100.2'",
  "network.wan.netmask='255.255.255.0'",
  ...(gateway ? ["network.wan.gateway='192.168.100.1'"] : []),
  "network.wan.dns='192.168.100.1'",
  "network.wan.ip4table='201'"
]

const servesDhcp = (name: string): string[] => [
  `dhcp.${name}=dhcp`,
  `dhcp.${name}.interface='${name}'`,
  `dhcp.${name}.start='100'`,
  `dhcp.${name}.limit='150'`,
  `dhcp.${name}.leasetime='12h'`,
  `dhcp.${name}.ra='server'`
]

const zone = (index: number, name: string, network: string, masq = false): string[] => [
  `firewall.@zone[${index}]=zone`,
  `firewall.@zone[${index}].name='${name}'`,
  `firewall.@zone[${index}].network='${network}'`,
  `firewall.@zone[${index}].input='ACCEPT'`,
  ...(masq ? [`firewall.@zone[${index}].masq='1'`] : [])
]

const DNSMASQ = ['dhcp.@dnsmasq[0]=dnsmasq', "dhcp.@dnsmasq[0].leasefile='/tmp/dhcp.leases'"]

/**
 * A LAN and a static uplink, and nothing on the router that masquerades - the
 * upstream router is doing the NAT, which is what makes this a double NAT.
 */
const behindAnotherRouter: Dump = {
  ifaces: [
    iface('lan', 'static', 'br-lan', '192.168.1.1'),
    iface('wan', 'static', 'eth1', '192.168.100.2')
  ],
  dhcp: [...DNSMASQ, ...servesDhcp('lan')],
  network: [...LOOPBACK_AND_GLOBALS, ...lanSection('lan', '192.168.1.1'), ...staticWanSection(true)],
  firewall: [...zone(0, 'lan', 'lan'), ...zone(1, 'wan', 'wan')]
}

/**
 * The same router with a guest network that NATs its own clients, which is a
 * common way to write one. It makes the uplink's quiet zone read as *evidence
 * of a LAN*, so before the gateway line arrived this router did not merely fail
 * to place its uplink - it placed it on the inside.
 */
const withNattingGuest: Dump = {
  ifaces: [
    ...behindAnotherRouter.ifaces,
    iface('guest', 'static', 'br-guest', '192.168.3.1')
  ],
  dhcp: [...behindAnotherRouter.dhcp, ...servesDhcp('guest')],
  network: [...behindAnotherRouter.network, ...lanSection('guest', '192.168.3.1')],
  firewall: [...behindAnotherRouter.firewall, ...zone(2, 'guest', 'guest', true)]
}

// ------------------------------------------------------- the shipped filter

/**
 * The network filter as it stood while the gateway weight was unreachable.
 *
 * Written down here because the code that had it is gone, and because "the
 * verdict changed" is only worth reading beside the verdict it changed from.
 */
const FILTER_BEFORE = /^network\.[^.=]+=|\.(ip4table|ip6assign)=/

/**
 * The `grep -E` one section of the preparation script really runs, pulled off
 * the script `preparationProbe` sent rather than copied.
 *
 * A POSIX ERE and a JavaScript RegExp mean the same thing by everything these
 * patterns use - anchors, character classes, alternation and a group - so
 * running one here is running the router's filter, not an imitation of it.
 */
function shippedFilter(script: string, config: string): RegExp {
  const found = script.match(new RegExp(`uci -q show ${config} [^\\n]*?grep -E '([^']*)'`))
  if (!found) throw new Error(`the preparation script no longer greps ${config} through one -E`)
  return new RegExp(found[1])
}

const keep = (lines: readonly string[], filter: RegExp): string[] =>
  lines.filter((line) => filter.test(line))

function deps(ctx: ExecDeps['ctx']): ExecDeps {
  return { ctx, disposed: false, options: { rules: () => DEFAULT_RULES } }
}

/**
 * The router answers the real script, filtered the way the router would filter
 * it. `network` chooses which generation of the filter runs, and it is the only
 * thing that differs between the two readings of every dump below.
 */
async function probeOf(
  dump: Dump,
  network: 'shipped' | 'before' = 'shipped'
): Promise<RouterPreparationProbe> {
  const harness = moduleHarness('openwrt', () => ok(''))
  harness.exec.mockImplementation(async (_command: string, options?: ModuleExecOptions) => {
    const script = options?.stdin ?? ''
    return ok(
      [
        '===DHCP===',
        ...keep(dump.dhcp, shippedFilter(script, 'dhcp')),
        '===NETWORK===',
        ...keep(
          dump.network,
          network === 'shipped' ? shippedFilter(script, 'network') : FILTER_BEFORE
        ),
        '===FIREWALL===',
        ...keep(dump.firewall, shippedFilter(script, 'firewall')),
        '===SYSCTL===',
        'net.netfilter.nf_conntrack_max=65536'
      ].join('\n')
    )
  })
  return preparationProbe(deps(harness.ctx))
}

function model(dump: Dump): RouterModel {
  return {
    t: 1_700_000_000_000,
    sys: { uptimeSec: 4_000, load1: 0, memTotal: 0, memFree: 0 },
    ifaces: dump.ifaces,
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases: [],
    rules: [],
    rates: {}
  }
}

async function verdicts(dump: Dump, network: 'shipped' | 'before' = 'shipped') {
  const layout = routerLayout(model(dump), await probeOf(dump, network))
  return layout.byName
}

// --------------------------------------------------------------- the value

describe('the gateway the router states', () => {
  it('survives the preparation filter and arrives under the key the classifier asks for', async () => {
    // The whole failure was one key missing from one map. It is asserted by its
    // exact spelling because that is what `direct/layout.ts` looks up, and
    // because a filter that kept the line under any other name would be no use.
    const probe = await probeOf(behindAnotherRouter)

    expect(probe.network.values.get('network.wan.gateway')).toBe('192.168.100.1')
  })

  it('was not in the document before the filter was widened', async () => {
    const probe = await probeOf(behindAnotherRouter, 'before')

    expect(probe.network.values.get('network.wan.gateway')).toBeUndefined()
    // And the rest of the network reading is untouched, so the two probes differ
    // by this one line rather than by the filter having been rewritten.
    expect(probe.network.values.get('network.wan.ip4table')).toBe('201')
    expect(probe.network.values.get('network.lan.ip6assign')).toBe('60')
  })
})

// -------------------------------------------------------------- the verdict

describe('a static uplink on a private address, behind another router', () => {
  it('is placed on the outside of the router, and says which line placed it', async () => {
    const wan = (await verdicts(behindAnotherRouter)).get('wan')

    expect(wan?.role).toBe('uplink')
    expect(wan?.uplinkEvidence).toContain('/etc/config/network gives it a default gateway')
  })

  it('could not be placed at all before the gateway line reached it', async () => {
    // Not a wrong answer, but an unusable one: with nothing on either side of
    // the scale the interface is `unclear`, so the WAN pick is never refused and
    // an address on the upstream network is offered a binding it cannot have.
    const wan = (await verdicts(behindAnotherRouter, 'before')).get('wan')

    expect(wan?.role).toBe('unclear')
    expect(wan?.uplinkEvidence).toEqual([])
  })

  it('outweighs a quiet zone beside a guest network that masquerades', async () => {
    // The router where the old reading was not silent but wrong: the uplink's
    // zone does no NAT while the guest zone does, which the classifier reads as
    // evidence of an inside network. The gateway has to be worth more than that
    // for this router to come out right, and it is.
    const before = (await verdicts(withNattingGuest, 'before')).get('wan')
    const after = (await verdicts(withNattingGuest)).get('wan')

    expect(before?.role).toBe('lan')
    expect(after?.role).toBe('uplink')
  })

  it('leaves a LAN with no gateway a LAN, on both of those routers', async () => {
    // The control the fix is worthless without. Nothing here gives the LAN a
    // next hop, so the new signal must be silent about it and the verdict must
    // rest on what it rested on before.
    for (const dump of [behindAnotherRouter, withNattingGuest]) {
      const lan = (await verdicts(dump)).get('lan')

      expect(lan?.role).toBe('lan')
      expect(lan?.uplinkEvidence).toEqual([])
      expect(lan?.lanEvidence).toContain('/etc/config/dhcp has it handing out DHCP leases')
    }

    const guest = (await verdicts(withNattingGuest)).get('guest')
    expect(guest?.role).toBe('lan')
  })
})

// ----------------------------------------------------------------- the cost

describe('what widening the filter costs the dump it filters', () => {
  /**
   * The router the filter exists for: a few thousand managed PPPoE sections,
   * whose unfiltered `uci show network` is far past what one command can carry.
   */
  const dialled = (count: number): string[] => {
    const lines: string[] = [...LOOPBACK_AND_GLOBALS, ...lanSection('lan', '192.168.1.1'), ...staticWanSection(true)]
    for (let index = 0; index < count; index += 1) {
      const name = `pd${String(index).padStart(5, '0')}`
      lines.push(
        `network.${name}=interface`,
        `network.${name}.proto='pppoe'`,
        `network.${name}.device='eth1'`,
        `network.${name}.username='user${index}'`,
        `network.${name}.password='secret${index}'`,
        `network.${name}.ip4table='${20_000 + index}'`
      )
    }
    return lines
  }

  it('adds one line per interface that names a next hop, and none per dialled session', async () => {
    // A dialled interface is handed its gateway by its peer rather than told it
    // in the file, so the sections that run into the thousands here contribute
    // nothing. The cost of the new key is the router's hand-written statics,
    // which is why this is affordable inside a size-capped probe at all.
    const harness = moduleHarness('openwrt', () => ok(''))
    let script = ''
    harness.exec.mockImplementation(async (_command: string, options?: ModuleExecOptions) => {
      script = options?.stdin ?? ''
      return ok('===SYSCTL===')
    })
    await preparationProbe(deps(harness.ctx))

    const dump = dialled(2_000)
    const now = keep(dump, shippedFilter(script, 'network'))
    const previously = keep(dump, FILTER_BEFORE)

    expect(now.length - previously.length).toBe(1)
    expect(now).toContain("network.wan.gateway='192.168.100.1'")
    // And it is still a filter: the addresses, passwords and device names of two
    // thousand sessions stay on the router.
    expect(now.some((line) => line.includes('password'))).toBe(false)
    expect(now.some((line) => line.includes('ipaddr'))).toBe(false)
  })
})
