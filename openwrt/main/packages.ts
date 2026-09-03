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

export type PackageGroupKey = 'pppoe' | 'macvlan' | 'ipfull' | 'dnsmasq'

/** The probe field a group satisfies, so "still missing" is checked, not assumed. */
export type PackageCapability = 'hasPppoe' | 'hasMacvlan' | 'hasIpRule' | 'hasDnsmasq'

export interface PackageGroup {
  key: PackageGroupKey
  title: string
  /** Installed one name per command, in this order. */
  packages: readonly string[]
  /** What the module cannot do while the group is missing. */
  purpose: string
  capability: PackageCapability
  /**
   * When true the group is installable from the form but never listed as
   * missing: a VLAN-only router without kmod-macvlan is not unfinished.
   */
  optional?: boolean
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
    key: 'macvlan',
    title: 'macvlan (per-slot MACs)',
    packages: ['kmod-macvlan'],
    purpose: 'Direct-mode pools that give each slot its own MAC',
    capability: 'hasMacvlan',
    optional: true
  },
  {
    key: 'ipfull',
    title: 'Policy routing',
    // A stock image symlinks `/sbin/ip` at BusyBox, whose `ip` answers
    // `rule show` but rejects a numeric routing table - and every rule and
    // route WAN binding writes names one. So the capability this installs is
    // not "ip rule" in general, it is numeric tables, which is what the probe
    // now tests for.
    packages: ['ip-full'],
    // Not "Per-device WAN binding" any more. That was true while this module
    // wrote the rules itself; bm-wanbind writes them over netlink and never
    // opens /sbin/ip, so this package buys the ability to read and change
    // policy routing at a shell rather than the feature working at all. It is
    // still offered - a router somebody administers by hand is better off with
    // it - and it is no longer named as what WAN Binding is missing.
    purpose: 'Reading and changing policy routing by hand at a router shell',
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
