/**
 * A healthy router's answer to the capability probe, as one string.
 *
 * Every test that reaches a method which writes to the router needs one now:
 * the module routes each `ctx.handle` through the requirements gate in
 * `openwrt/main/requirements.ts`, and a router nobody has probed is refused
 * with "The router has not been checked yet" rather than let through. That is
 * the point of the gate - but it means a harness whose `exec` answers nothing
 * is no longer a stand-in for a working router, it is a stand-in for one the
 * module has never seen.
 *
 * Kept here rather than copied into each test file so that the next section the
 * probe grows is added in one place instead of fifteen.
 */

const TOOLS = [
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

export interface RouterProbeOptions {
  /**
   * Tool basenames to leave out, e.g. `['dnsmasq']`. `ip-full` is the one that
   * is not a basename: the `ip` binary is on every OpenWRT build, and only the
   * functional test in `===IPRULE===` tells a BusyBox `ip` from one that can do
   * policy routing - so naming it here empties that section instead.
   */
  without?: readonly string[]
  /** `id -u`. Anything but 0 is a login that cannot install packages. */
  uid?: string
  /** Services that are running. `pidof`/`nftok` say the question could be asked. */
  service?: readonly string[]
  /** The `===CONFLICT===` body, `total` line included. */
  conflict?: readonly string[]
  /**
   * What `bm.agent info` answers. Omitted means a router with no agent, which
   * is what every router looks like before the packages are installed - and
   * `null` says so explicitly for a test that is about exactly that.
   */
  agent?: Record<string, unknown> | null
  /**
   * The `===IPRULE===` body after the `ok` line: where `ip` resolves, and
   * whether an unused iproute2 sits beside it. Defaults to a router whose `ip`
   * simply is iproute2, so `without: ['ip-full']` on its own still describes
   * the plain BusyBox router it always did.
   *
   * Note the shell resolves the FIB question before the parser ever sees it:
   * a router whose table 29999 is merely empty ("FIB table does not exist")
   * prints `ok` on the router, so from here it is indistinguishable from one
   * whose table has routes - which is the point of the fix that made it so.
   */
  ipDetail?: readonly string[]
}

/** A healthy, current agent, as the probe would read it back. */
export const AGENT_INFO: Record<string, unknown> = {
  name: 'bm-agent',
  release: '1.2.0',
  apiVersion: 3,
  schema: 1,
  dataSchema: 1,
  provides: [],
  features: [],
  guard: { armed: false }
}

/** The same agent with the 2.x pool daemon beside it, features and all. */
export const POOL_AGENT_INFO: Record<string, unknown> = {
  ...AGENT_INFO,
  release: '2.0.0',
  schema: 2,
  dataSchema: 2,
  provides: ['pppoe'],
  features: [
    { name: 'bm-pppoe-pool', version: '2.0.0', apiVersion: 2, provides: ['pppoe'] }
  ]
}

/** The same agent with the binding daemon beside it, which binds over netlink. */
export const BINDING_AGENT_INFO: Record<string, unknown> = {
  ...AGENT_INFO,
  release: '2.0.1',
  schema: 2,
  dataSchema: 2,
  provides: ['binding'],
  features: [
    { name: 'bm-wanbind', version: '2.0.1', apiVersion: 1, provides: ['binding'] }
  ]
}

export function routerProbeOutput(options: RouterProbeOptions = {}): string {
  const without = options.without ?? []
  return [
    '===REL===',
    "DISTRIB_ID='OpenWrt'",
    "DISTRIB_RELEASE='25.12.0'",
    '===BOARD===',
    JSON.stringify({
      model: 'Test Router',
      release: { distribution: 'OpenWrt', version: '25.12.0' }
    }),
    '===TOOLS===',
    ...TOOLS.filter((path) => !without.includes(path.split('/').pop() ?? '')),
    '===PPP===',
    'plugin',
    'kmod',
    '===PKG===',
    'apkdb',
    '===IDU===',
    options.uid ?? '0',
    '===SPACE===',
    'Filesystem           1K-blocks      Used Available Use% Mounted on',
    '/dev/loop0                8192      2048      6144  25% /overlay',
    '===IPRULE===',
    ...(without.includes('ip-full') ? [] : ['ok']),
    ...(options.ipDetail ?? ['path /sbin/ip', 'real /sbin/ip']),
    '===SERVICE===',
    ...(options.service ?? ['pidof', 'dnsmasq', 'netifd', 'nftok', 'fw4']),
    '===CONFLICT===',
    ...(options.conflict ?? ['total 0']),
    '===AGENT===',
    ...(options.agent ? [JSON.stringify(options.agent)] : []),
    // The sentinel that tells a router which answered from one which never did.
    // Without it every capability reads unknown and every gate refuses.
    '===DONE==='
  ].join('\n')
}

/** True for the one command the probe sends, whatever else a test answers. */
export function isProbeCommand(command: string): boolean {
  return command.includes("echo '===REL==='")
}
