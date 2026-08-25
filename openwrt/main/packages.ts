/**
 * Every package this module is ever allowed to install, and the reason each one
 * is here.
 *
 * This table is the whole allowlist. The install job builds its command line
 * only from names found in it, never from anything a user typed, so no value
 * arriving from a form can turn `apk add <name>` into a different command - and
 * `update` and `add` are the only two verbs the job will ever emit. Adding a
 * name here is the only way to make anything installable.
 *
 * Firewall4 is deliberately absent: a router still on fw3/iptables is not a
 * router this module can drive, and installing fw4 underneath a running fw3
 * would take the firewall down rather than fix anything.
 */

export type PackageGroupKey = 'pppoe' | 'ipfull' | 'dnsmasq'

/** The probe field a group satisfies, so "still missing" is checked, not assumed. */
export type PackageCapability = 'hasPppoe' | 'hasIpRule' | 'hasDnsmasq'

export interface PackageGroup {
  key: PackageGroupKey
  title: string
  /** Installed one name per command, in this order. */
  packages: readonly string[]
  /** What the module cannot do while the group is missing. */
  purpose: string
  capability: PackageCapability
}

export const PACKAGE_GROUPS: readonly PackageGroup[] = [
  {
    key: 'pppoe',
    title: 'PPPoE support',
    // All three go in together. The probe reads artefacts on disk rather than a
    // package list, so it cannot say which of the three is the missing one, and
    // both managers treat an install of something already present as a no-op.
    packages: ['ppp', 'ppp-mod-pppoe', 'kmod-pppoe'],
    purpose: 'Dialing PPPoE sessions',
    capability: 'hasPppoe'
  },
  {
    key: 'ipfull',
    title: 'Policy routing',
    // BusyBox ships a cut-down `ip` with no `rule` subcommand on some targets.
    // WAN binding is entirely built on ip rules, so it is dead without this.
    packages: ['ip-full'],
    purpose: 'Per-device WAN binding',
    capability: 'hasIpRule'
  },
  {
    key: 'dnsmasq',
    title: 'DHCP leases',
    packages: ['dnsmasq'],
    purpose: 'Discovering LAN devices from DHCP leases',
    capability: 'hasDnsmasq'
  }
]

const BY_KEY = new Map<string, PackageGroup>(PACKAGE_GROUPS.map((g) => [g.key, g]))

const ALLOWED = new Set<string>(PACKAGE_GROUPS.flatMap((g) => [...g.packages]))

export function packageGroup(key: unknown): PackageGroup | null {
  return typeof key === 'string' ? (BY_KEY.get(key) ?? null) : null
}

/** The gate every install command passes through. */
export function isInstallablePackage(name: unknown): name is string {
  return typeof name === 'string' && ALLOWED.has(name)
}
