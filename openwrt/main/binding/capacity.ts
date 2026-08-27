/**
 * Whether the router can actually serve the clients a pool implies.
 *
 * One-to-one binding follows DHCP leases, so a LAN whose dnsmasq ceiling is
 * lower than the number of devices it is about to be given hands out no lease
 * at all for the rest - and a device with no lease is a device the engine never
 * sees. The rest of this file is the same question about the kernel: a few
 * thousand linear fib rules, a conntrack table sized for a household, and a
 * neighbour cache that starts evicting under a pool it was never meant to hold.
 *
 * Split out of `check.ts`, which is the gate; this is one section of what that
 * gate asks.
 */
import type { ModuleCheckFinding } from '@shared/check'
import type { IfaceState, Lease } from '../types'
import { parseCidr, subnetContains } from '../util'
import {
  DHCP_SECTION,
  numericOption,
  sectionsOfType,
  uciOption
} from './uci-doc'
import type { DhcpPreparation, RouterPreparationProbe } from './types'

export interface CapacityContext {
  lan: string
  cidr: string
  pool: readonly IfaceState[]
  leases: readonly Lease[]
  /** Whether the form asked for the limits to be raised by the apply job. */
  raiseDhcpLimits: boolean
}

/**
 * Everything the probe can say about serving this LAN, appended to `findings`.
 * The return value is the one preparation the apply job may have to perform.
 */
export function planCapacity(
  probe: RouterPreparationProbe,
  context: CapacityContext,
  findings: ModuleCheckFinding[]
): DhcpPreparation | undefined {
  const dhcp = planDhcp(probe, context, findings)
  planKernel(probe, context, findings)
  return dhcp
}

function planDhcp(
  probe: RouterPreparationProbe,
  context: CapacityContext,
  findings: ModuleCheckFinding[]
): DhcpPreparation | undefined {
  const { lan, cidr, pool } = context
  const dhcpSections = sectionsOfType(probe.dhcp, 'dhcp', 'dhcp')
  const dhcpSection = dhcpSections.find(
    (section) => uciOption(probe.dhcp, 'dhcp', section, 'interface') === lan || section === lan
  )
  if (!dhcpSection) {
    findings.push({
      level: 'error',
      label: `LAN "${lan}" has no dnsmasq DHCP section`,
      detail: `One-to-one binding follows DHCP leases, so it needs a "config dhcp" section for ${lan} in /etc/config/dhcp.`
    })
    return undefined
  }
  if (!DHCP_SECTION.test(dhcpSection)) {
    findings.push({
      level: 'error',
      label: `DHCP section "${dhcpSection}" cannot be prepared safely`,
      // Its sibling for WAN sections has explained this since day one.
      detail: 'Its UCI section name contains unsupported characters.'
    })
    return undefined
  }
  const dnsmasqSection = sectionsOfType(probe.dhcp, 'dhcp', 'dnsmasq')[0]
  if (!dnsmasqSection || !DHCP_SECTION.test(dnsmasqSection)) {
    findings.push({
      level: 'error',
      label: 'No usable global dnsmasq section was found',
      detail: 'The lease ceiling is raised through the "config dnsmasq" section of /etc/config/dhcp, and this router has none under a usable section name.'
    })
    return undefined
  }

  const currentLanLimit = numericOption(
    uciOption(probe.dhcp, 'dhcp', dhcpSection, 'limit'),
    150
  )
  const currentGlobalLimit = numericOption(
    uciOption(probe.dhcp, 'dhcp', dnsmasqSection, 'dhcpleasemax'),
    1_000
  )
  const parsed = parseCidr(cidr)
  const leaseCount = context.leases.filter((lease) =>
    parsed ? subnetContains(parsed, lease.ip) : false
  ).length
  const expected = Math.max(pool.length, leaseCount)
  const addressCount = parsed
    ? parsed.prefix >= 31
      ? 2 ** (32 - parsed.prefix)
      : Math.max(0, 2 ** (32 - parsed.prefix) - 2)
    : expected
  const expectedClients = Math.min(addressCount, expected)
  const targetLan = Math.min(addressCount, Math.max(currentLanLimit, expectedClients))
  const targetGlobal = Math.max(currentGlobalLimit, targetLan + 64)

  let preparation: DhcpPreparation | undefined
  if (expectedClients > currentLanLimit || expectedClients > currentGlobalLimit) {
    preparation = {
      section: dhcpSection,
      dnsmasqSection,
      lanLimit: targetLan,
      globalLimit: targetGlobal
    }
    findings.push({
      level: 'warning',
      label: `dnsmasq limits are below the expected ${expectedClients} device(s)`,
      detail: context.raiseDhcpLimits
        ? `Apply will run: uci set dhcp.${dhcpSection}.limit='${targetLan}'; uci set dhcp.${dnsmasqSection}.dhcpleasemax='${targetGlobal}'; service dnsmasq restart.`
        : `Enable "Raise dnsmasq lease limits" or prepare them manually: dhcp.${dhcpSection}.limit=${targetLan}, dhcp.${dnsmasqSection}.dhcpleasemax=${targetGlobal}.`
    })
  }

  const ipv6Enabled =
    numericOption(uciOption(probe.network, 'network', lan, 'ip6assign'), 0) > 0 ||
    !['', 'disabled', '0'].includes(uciOption(probe.dhcp, 'dhcp', dhcpSection, 'ra')) ||
    !['', 'disabled', '0'].includes(uciOption(probe.dhcp, 'dhcp', dhcpSection, 'dhcpv6'))
  if (ipv6Enabled) {
    findings.push({
      level: 'warning',
      label: `IPv6 service is enabled on ${lan}`,
      detail: 'WAN Binding controls IPv4 only. Disable RA/DHCPv6 if clients must not bypass the IPv4 one-to-one policy.'
    })
  }
  return preparation
}

/**
 * Kernel-side headroom. All advisory: none of it stops an instance existing.
 *
 * The remedy is the same page for all three now - Module settings, Router
 * limits - which reads them live, sizes a recommendation to this router and
 * applies through the agent or over SSH. The findings still carry the values,
 * because a report somebody screenshots has to stand on its own.
 */
function planKernel(
  probe: RouterPreparationProbe,
  context: CapacityContext,
  findings: ModuleCheckFinding[]
): void {
  const defaults = sectionsOfType(probe.firewall, 'firewall', 'defaults')[0]
  const flowOffload = defaults
    ? uciOption(probe.firewall, 'firewall', defaults, 'flow_offloading')
    : ''
  if (flowOffload !== '1') {
    findings.push({
      level: 'info',
      label: 'Software flow offload is disabled',
      detail:
        'For thousands of linear fib rules it cuts per-packet lookups considerably. Module settings, Router limits, has the switch - it commits the firewall config and reloads fw4.'
    })
  }
  const conntrack = probe.sysctl.get('net.netfilter.nf_conntrack_max') ?? 0
  if (conntrack < 262_144) {
    findings.push({
      level: 'info',
      label: `nf_conntrack_max is ${conntrack || 'unknown'}`,
      detail:
        'A large client pool wants 262144 or more, or the kernel starts dropping new connections when the table fills. Module settings, Router limits, applies and persists it.'
    })
  }
  const gc1 = probe.sysctl.get('net.ipv4.neigh.default.gc_thresh1') ?? 0
  const gc2 = probe.sysctl.get('net.ipv4.neigh.default.gc_thresh2') ?? 0
  const gc3 = probe.sysctl.get('net.ipv4.neigh.default.gc_thresh3') ?? 0
  if (Math.max(context.pool.length, context.leases.length) > 1_024 || gc3 < 8_192) {
    findings.push({
      level: 'info',
      label: `Neighbour thresholds are ${gc1 || '?'}/${gc2 || '?'}/${gc3 || '?'}`,
      detail:
        'More than 1024 clients wants at least 2048/4096/8192, or the ARP cache refuses new neighbours. Module settings, Router limits, applies and persists them.'
    })
  }
}
