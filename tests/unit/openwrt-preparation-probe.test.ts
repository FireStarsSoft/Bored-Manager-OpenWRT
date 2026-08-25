import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { BindingEngine } from '../../openwrt/main/binding'
import { DEFAULT_RULES } from '../../openwrt/main/config'
import { HostStore } from '../../openwrt/main/store'
import type { RouterModel } from '../../openwrt/main/types'
import { moduleHarness } from '../helpers/module-harness'

/**
 * The binding check reads the router's dhcp, network and firewall configuration
 * in one command. It used to ask for all three in full and accept whatever came
 * back as long as the exit code was zero. On a router carrying a few thousand
 * managed PPPoE sections that dump runs past the executor's output cap, and a
 * truncated `uci show` still parses as a perfectly well-formed document - one
 * that is simply missing sections. The check would then say something confident
 * and wrong: that the LAN has no DHCP section, or that a WAN it is about to
 * bind no longer exists.
 */

const ok = (stdout: string, stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const DHCP_DUMP = [
  "dhcp.@dnsmasq[0]=dnsmasq",
  "dhcp.@dnsmasq[0].domainneeded='1'",
  "dhcp.@dnsmasq[0].localise_queries='1'",
  "dhcp.@dnsmasq[0].rebind_protection='1'",
  "dhcp.@dnsmasq[0].leasefile='/tmp/dhcp.leases'",
  "dhcp.@dnsmasq[0].dhcpleasemax='150'",
  'dhcp.lan=dhcp',
  "dhcp.lan.interface='lan'",
  "dhcp.lan.start='100'",
  // Deliberately below the device count in `routerModel`, so the check has to
  // read both this and `dhcpleasemax` to reach its verdict.
  "dhcp.lan.limit='2'",
  "dhcp.lan.leasetime='12h'",
  "dhcp.lan.ra='server'",
  'dhcp.wan=dhcp',
  "dhcp.wan.interface='wan'",
  "dhcp.wan.ignore='1'",
  'dhcp.odhcpd=odhcpd',
  "dhcp.odhcpd.maindhcp='0'"
].join('\n')

const NETWORK_HEAD = [
  'network.loopback=interface',
  "network.loopback.device='lo'",
  "network.loopback.proto='static'",
  'network.globals=globals',
  "network.globals.ula_prefix='fd42::/48'",
  'network.@device[0]=device',
  "network.@device[0].name='br-lan'",
  "network.@device[0].type='bridge'",
  'network.lan=interface',
  "network.lan.device='br-lan'",
  "network.lan.proto='static'",
  "network.lan.ipaddr='192.168.1.1'",
  "network.lan.netmask='255.255.255.0'",
  "network.lan.ip6assign='60'",
  'network.wan=interface',
  "network.wan.device='eth1'",
  "network.wan.proto='dhcp'",
  "network.wan.ip4table='201'"
].join('\n')

const FIREWALL_DUMP = [
  'firewall.@defaults[0]=defaults',
  "firewall.@defaults[0].syn_flood='1'",
  "firewall.@defaults[0].input='ACCEPT'",
  "firewall.@defaults[0].flow_offloading='0'",
  'firewall.@zone[0]=zone',
  "firewall.@zone[0].name='lan'",
  "firewall.@zone[0].network='lan'",
  "firewall.@zone[0].input='ACCEPT'",
  'firewall.@zone[1]=zone',
  "firewall.@zone[1].name='wan'",
  "firewall.@zone[1].network='wan'",
  "firewall.@zone[1].masq='1'",
  'firewall.@rule[0]=rule',
  "firewall.@rule[0].name='Allow-DHCP-Renew'",
  "firewall.@rule[0].src='wan'",
  "firewall.@rule[0].proto='udp'",
  'firewall.@forwarding[0]=forwarding',
  "firewall.@forwarding[0].src='lan'",
  "firewall.@forwarding[0].dest='wan'"
].join('\n')

const SYSCTL_DUMP = [
  'net.netfilter.nf_conntrack_max=65536',
  'net.ipv4.neigh.default.gc_thresh1=1024',
  'net.ipv4.neigh.default.gc_thresh2=4096',
  'net.ipv4.neigh.default.gc_thresh3=8192'
].join('\n')

/** One managed PPPoE section as `uci show network` prints it. */
function pppoeSection(index: number): string {
  const name = `pd${String(index).padStart(5, '0')}`
  return [
    `network.${name}=interface`,
    `network.${name}.proto='pppoe'`,
    `network.${name}.device='eth1'`,
    `network.${name}.username='user${index}@isp'`,
    `network.${name}.password='secret${index}'`,
    `network.${name}.ipv6='0'`,
    `network.${name}.defaultroute='0'`,
    `network.${name}.ip4table='${10_000 + index}'`
  ].join('\n')
}

function networkDump(pppoeCount = 0): string {
  const parts = [NETWORK_HEAD]
  for (let index = 1; index <= pppoeCount; index++) parts.push(pppoeSection(index))
  return parts.join('\n')
}

/**
 * Pull a `grep -E` pattern back out of the script the module actually sent, so
 * these tests filter the fixtures exactly the way the router will. Failing to
 * find one is itself the assertion that the dump is still bounded.
 */
function filterFor(script: string, config: string): RegExp {
  const found = script.match(
    new RegExp(`^uci -q show ${config} 2>/dev/null \\| grep -E '(.+)' \\|\\| true$`, 'm')
  )
  if (!found) throw new Error(`the preparation script no longer filters the ${config} dump`)
  return new RegExp(found[1] ?? '')
}

function applyFilter(script: string, config: string, dump: string): string {
  const pattern = filterFor(script, config)
  return dump.split('\n').filter((line) => pattern.test(line)).join('\n')
}

interface ProbeReply {
  dhcp?: string
  network?: string
  firewall?: string
  /** Off means the reply stops where the router ran out of output. */
  sysctl?: boolean
  /** Off returns the dumps whole, as the module used to ask for them. */
  filter?: boolean
}

function probeReply(script: string, options: ProbeReply = {}): string {
  const filter = options.filter ?? true
  const pick = (config: string, dump: string): string =>
    filter ? applyFilter(script, config, dump) : dump
  const out = [
    '===DHCP===',
    pick('dhcp', options.dhcp ?? DHCP_DUMP),
    '===NETWORK===',
    pick('network', options.network ?? networkDump()),
    '===FIREWALL===',
    pick('firewall', options.firewall ?? FIREWALL_DUMP)
  ]
  if (options.sysctl ?? true) out.push('===SYSCTL===', SYSCTL_DUMP)
  return out.join('\n')
}

function routerModel(): RouterModel {
  return {
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
      },
      {
        name: 'wan',
        proto: 'dhcp',
        device: 'eth1',
        l3Device: 'eth1',
        up: true,
        pending: false,
        autostart: true,
        uptimeSec: 4_000,
        ipv4: { addr: '10.0.0.2', mask: 24 }
      }
    ],
    poolDev: { count: 0, rx: 0, tx: 0 },
    leases: [
      { expires: 0, mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.20', host: 'desk' },
      { expires: 0, mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.1.21', host: 'phone' },
      { expires: 0, mac: 'aa:bb:cc:dd:ee:03', ip: '192.168.1.22', host: 'tv' }
    ],
    rules: [],
    rates: { 'br-lan': { rx: 0, tx: 0 }, eth1: { rx: 0, tx: 0 } }
  }
}

interface Harness {
  check(): Promise<{ ok: boolean; findings: Array<{ level: string; label: string; detail?: string }> }>
  scripts: string[]
}

/** `reply` is handed the script the engine sent and returns the router's answer. */
function harnessFor(reply: (script: string) => ModuleExecResult): Harness {
  const scripts: string[] = []
  const harness = moduleHarness('openwrt', () => ok(''))
  harness.exec.mockImplementation(async (command, execOptions) => {
    const stdin = execOptions?.stdin ?? ''
    if (command === 'sh -s' && stdin.includes("echo '===DHCP==='")) {
      scripts.push(stdin)
      return reply(stdin)
    }
    return ok('')
  })
  const store = new HostStore(harness.ctx, () => DEFAULT_RULES)
  const engine = new BindingEngine(harness.ctx, store, { rules: () => DEFAULT_RULES })
  return {
    scripts,
    check: async () => {
      await engine.onSample(routerModel())
      const report = await engine.bindingCheck({
        name: 'Home',
        lan: 'lan',
        carrier: 'eth1',
        raiseDhcpLimits: true
      })
      return report as Awaited<ReturnType<Harness['check']>>
    }
  }
}

const summarise = (findings: Array<{ level: string; label: string }>): string[] =>
  findings.map((finding) => `${finding.level}: ${finding.label}`)

describe('the binding check filters the configuration it asks for', () => {
  it('reaches the same verdict from the filtered dump as from the whole one', async () => {
    const whole = harnessFor((script) => ok(probeReply(script, { filter: false })))
    const cut = harnessFor((script) => ok(probeReply(script)))

    const fromWhole = await whole.check()
    const fromCut = await cut.check()

    expect(summarise(fromCut.findings)).toEqual(summarise(fromWhole.findings))
    expect(fromCut.ok).toBe(fromWhole.ok)

    // Equality is only worth anything if both runs got far enough to read the
    // dumps: one finding per configuration the filter touches.
    expect(summarise(fromCut.findings)).toEqual(
      expect.arrayContaining([
        'pass: LAN lan uses firewall zone lan',
        'info: Software flow offload is disabled',
        'warning: dnsmasq limits are below the expected 3 device(s)',
        'warning: IPv6 service is enabled on lan'
      ])
    )
  })

  it('keeps every key its readers ask for', async () => {
    const harness = harnessFor((script) => ok(probeReply(script)))
    await harness.check()
    const script = harness.scripts[0] ?? ''

    const surviving = (config: string, dump: string): string[] =>
      applyFilter(script, config, dump).split('\n')

    // Section declarations, so `sectionsOfType` and `sectionTypes.has` still work.
    expect(surviving('dhcp', DHCP_DUMP)).toContain('dhcp.lan=dhcp')
    expect(surviving('dhcp', DHCP_DUMP)).toContain('dhcp.@dnsmasq[0]=dnsmasq')
    expect(surviving('network', networkDump(1))).toContain('network.wan=interface')
    expect(surviving('network', networkDump(1))).toContain('network.pd00001=interface')
    expect(surviving('firewall', FIREWALL_DUMP)).toContain('firewall.@zone[0]=zone')
    expect(surviving('firewall', FIREWALL_DUMP)).toContain('firewall.@defaults[0]=defaults')

    // Every option the probe's readers actually look up.
    expect(surviving('dhcp', DHCP_DUMP)).toEqual(
      expect.arrayContaining([
        "dhcp.lan.interface='lan'",
        "dhcp.lan.limit='2'",
        "dhcp.lan.ra='server'",
        "dhcp.@dnsmasq[0].dhcpleasemax='150'"
      ])
    )
    expect(surviving('network', networkDump(1))).toEqual(
      expect.arrayContaining([
        "network.wan.ip4table='201'",
        "network.pd00001.ip4table='10001'",
        "network.lan.ip6assign='60'"
      ])
    )
    expect(surviving('firewall', FIREWALL_DUMP)).toEqual(
      expect.arrayContaining([
        "firewall.@zone[0].name='lan'",
        "firewall.@zone[0].network='lan'",
        "firewall.@zone[1].masq='1'",
        "firewall.@defaults[0].flow_offloading='0'"
      ])
    )
  })

  it('drops the bulk of a large pool instead of carrying it', async () => {
    const harness = harnessFor((script) => ok(probeReply(script)))
    await harness.check()
    const script = harness.scripts[0] ?? ''

    const dump = networkDump(1_000)
    const kept = applyFilter(script, 'network', dump)
    // Eight lines per managed section become two: the declaration and the
    // table. Anything that still reads a third key has to say so here.
    expect(kept.split('\n').length).toBeLessThan(dump.split('\n').length / 3)
    expect(kept).not.toContain('username')
    expect(kept).not.toContain('password')
  })
})

describe('the binding check refuses a truncated dump', () => {
  it('says so when the executor reports the output cap', async () => {
    const harness = harnessFor(() => ok('===DHCP===\ndhcp.lan=dhcp', '', 125))
    const report = await harness.check()

    expect(report.ok).toBe(false)
    expect(
      report.findings.some((finding) => (finding.detail ?? '').includes('cut off'))
    ).toBe(true)
  })

  it('says so when the cap is only mentioned on stderr', async () => {
    const harness = harnessFor(() =>
      ok('===DHCP===\ndhcp.lan=dhcp', 'sh: [overflow] output truncated', 0)
    )
    const report = await harness.check()

    expect(report.ok).toBe(false)
    expect(
      report.findings.some((finding) => (finding.detail ?? '').includes('cut off'))
    ).toBe(true)
  })

  it('catches a silent cut rather than reading half a router as the whole one', async () => {
    // Exit 0, nothing on stderr, and the dump stops partway through: the DHCP
    // section that arrived has the global dnsmasq entry but not the LAN pool.
    const harness = harnessFor((script) =>
      ok(
        probeReply(script, {
          dhcp: ["dhcp.@dnsmasq[0]=dnsmasq", "dhcp.@dnsmasq[0].dhcpleasemax='150'"].join('\n'),
          sysctl: false
        })
      )
    )
    const report = await harness.check()

    expect(report.ok).toBe(false)
    expect(
      report.findings.some((finding) => (finding.detail ?? '').includes('cut off'))
    ).toBe(true)
    expect(summarise(report.findings)).not.toContain(
      'error: LAN "lan" has no dnsmasq DHCP section'
    )
  })

  it('decodes exit 20 as the missing-uci sentinel the script meant it to be', async () => {
    // The script ends `command -v uci >/dev/null || exit 20` for exactly this
    // case. Reporting it as "OpenWRT UCI probe failed (exit 20)" turned the one
    // router state the sentinel was written to identify into a bare number.
    const harness = harnessFor(() => ok('', '', 20))
    const report = await harness.check()

    expect(report.ok).toBe(false)
    const detail = report.findings.map((finding) => finding.detail ?? '').join('\n')
    expect(detail).toContain('no uci command')
    expect(detail).not.toContain('exit 20')
    // uci is base-system, so pointing at the package installer would be a lie.
    expect(detail).not.toContain('Install missing packages')
  })

  it('still reports an exit code it has no meaning for', async () => {
    const harness = harnessFor(() => ok('', '', 3))
    const report = await harness.check()

    expect(report.ok).toBe(false)
    expect(
      report.findings.some((finding) => (finding.detail ?? '').includes('exit 3'))
    ).toBe(true)
  })
})
