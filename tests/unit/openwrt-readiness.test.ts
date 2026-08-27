import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import {
  buildReadiness,
  emptyAgentFacts,
  emptyCapabilities,
  probeOpenWrt,
  type OpenWrtCapabilities,
  type ProbeFacts
} from '../../openwrt/main/probe'
import { moduleHarness } from '../helpers/module-harness'

/**
 * What the module believes about a router before it touches it. The old probe
 * asked one question ("can I run at all?") and answered it with a sentence, so
 * a router that was merely missing an optional package looked exactly like a
 * machine that is not a router - and a router whose shell answered the question
 * badly looked like one that failed it.
 */

const ok = (stdout: string, stderr = '', code = 0): ModuleExecResult => ({
  code,
  stdout,
  stderr
})

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

const DF = [
  'Filesystem           1K-blocks      Used Available Use% Mounted on',
  '/dev/loop0                8192      2048      6144  25% /overlay'
]

interface ProbeOptions {
  openwrt?: boolean
  release?: string
  tools?: string[]
  ppp?: string[]
  pkg?: string[]
  uid?: string
  space?: string[]
  ipRule?: boolean
  /** The `===SERVICE===` body: `pidof` first, then whatever is running. */
  service?: string[]
  /** The `===CONFLICT===` body, `total` line included. */
  conflict?: string[]
  /**
   * What `bm.agent info` answers. The default is a healthy current agent, so
   * that `ready` in these tests means a router that is genuinely set up;
   * `null` is the router with none, which is its own case below.
   */
  agent?: Record<string, unknown> | null
}

/** A healthy, current agent, as the probe reads it back. */
const AGENT = { release: '1.2.0', apiVersion: 3, schema: 1, dataSchema: 1, provides: [] }

function probeOutput(options: ProbeOptions = {}): string {
  const openwrt = options.openwrt ?? true
  const release = options.release ?? '25.12.0'
  return [
    '===REL===',
    ...(openwrt ? ["DISTRIB_ID='OpenWrt'", `DISTRIB_RELEASE='${release}'`] : []),
    '===BOARD===',
    openwrt
      ? JSON.stringify({
          model: 'Test Router',
          release: { distribution: 'OpenWrt', version: release }
        })
      : '',
    '===TOOLS===',
    ...(options.tools ?? ROUTER_TOOLS),
    '===PPP===',
    ...(options.ppp ?? ['plugin', 'kmod', 'macvlan']),
    '===PKG===',
    ...(options.pkg ?? ['apkdb']),
    '===IDU===',
    options.uid ?? '0',
    '===SPACE===',
    ...(options.space ?? DF),
    '===IPRULE===',
    ...(options.ipRule ?? true ? ['ok'] : []),
    '===SERVICE===',
    ...(options.service ?? ['pidof', 'dnsmasq', 'netifd', 'nftok', 'fw4']),
    '===CONFLICT===',
    ...(options.conflict ?? ['total 0']),
    '===AGENT===',
    ...(options.agent === null ? [] : [JSON.stringify(options.agent ?? AGENT)]),
    // Last, and required: without it a half-carried answer parses as a whole
    // one, and the module reports a healthy router as a broken one.
    '===DONE==='
  ].join('\n')
}

const probe = async (options: ProbeOptions = {}): Promise<OpenWrtCapabilities> => {
  const harness = moduleHarness('openwrt', () => ok(probeOutput(options)))
  return probeOpenWrt(harness.ctx)
}

/** A router with nothing wrong with it, as raw answers. */
const facts = (patch: Partial<ProbeFacts> = {}): ProbeFacts => ({
  connected: true,
  probed: true,
  isOpenwrt: true,
  release: '25.12.0',
  board: 'Test Router',
  tools: ['ubus', 'uci', 'ip', 'netifd', 'fw4', 'nft', 'logread', 'pppd', 'dnsmasq', 'apk'],
  ppp: { plugin: true, kmod: true, macvlan: true },
  pkgDb: { opkg: false, apk: true },
  uid: 0,
  overlayFreeKb: 8_192,
  hasIpRule: true,
  // A router whose `ip` is simply iproute2, with nothing unused beside it.
  // Flipping `hasIpRule` alone on this therefore describes the plain BusyBox
  // router; the two ip-full branches supply their own `ip` block.
  ip: { path: '/usr/sbin/ip', real: '/usr/sbin/ip', fullPresent: false, fullWorks: false },
  services: { dnsmasq: 'running', netifd: 'running', fw4: 'running' },
  foreignRules: [],
  foreignRuleCount: 0,
  foreignRulesRead: true,
  mwan3: { config: false, running: false },
  // A router that is fully set up, so `ready` here means ready. The router
  // with no agent is its own case, and says so by passing `emptyAgentFacts()`.
  agent: { ...emptyAgentFacts(), installed: true, running: true, ...AGENT },
  rulePrefBase: 20_000,
  transportError: '',
  ...patch
})

const check = (caps: OpenWrtCapabilities, key: string): OpenWrtCapabilities['checks'][number] => {
  const found = caps.checks.find((entry) => entry.key === key)
  if (!found) throw new Error(`no check named ${key}`)
  return found
}

describe('openwrt probe: asking the shell one question at a time', () => {
  it('looks each tool up on its own, because ash answers only the first one', async () => {
    // BusyBox ash implements `command -v` as a builtin that prints its first
    // operand and ignores the rest. Asked for all eight at once it answered
    // "/sbin/ubus", so the module concluded uci, ip and netifd were missing and
    // refused to manage a perfectly ordinary router.
    const harness = moduleHarness('openwrt', () => ok(probeOutput()))

    await probeOpenWrt(harness.ctx)

    const command = harness.exec.mock.calls[0]?.[0] ?? ''
    expect(command).not.toMatch(/command -v \w+ \w+/)
    expect(command).toContain('for t in')
    expect(command).toContain('command -v "$t"')
  })

  it('tests ip rule by running it, not by finding the binary', async () => {
    const harness = moduleHarness('openwrt', () => ok(probeOutput()))

    await probeOpenWrt(harness.ctx)

    // The `ip` in PATH may be the BusyBox applet, which has no rule support at
    // all - and WAN binding is nothing but ip rules.
    expect(harness.exec.mock.calls[0]?.[0] ?? '').toContain('ip -4 rule show')
    expect((await probe({ ipRule: false })).hasIpRule).toBe(false)
    expect((await probe()).hasIpRule).toBe(true)
  })

  it('reads free space off df, including the row busybox wrapped', async () => {
    const wrapped = await probe({
      space: [
        'Filesystem           1K-blocks      Used Available Use% Mounted on',
        '/dev/mapper/a-very-long-device-name',
        '                          8192      7000      1192  85% /overlay'
      ]
    })

    expect(wrapped.overlayFreeKb).toBe(1_192)
    expect((await probe()).overlayFreeKb).toBe(6_144)
    expect((await probe({ space: [] })).overlayFreeKb).toBe(-1)
  })

  it('finds Available by its header, not by counting fields from the right', async () => {
    // Counting back from the end assumed the mount point was a single field.
    // On a router with a space in one - a USB stick mounted at /mnt/usb disk -
    // every row shifted by one and 85 percent was read as 85 KB free, which
    // then blocked every install on a filesystem with plenty of room.
    const spaced = await probe({
      space: [
        'Filesystem           1K-blocks      Used Available Use% Mounted on',
        '/dev/sda1                 8192      2048      6144  25% /mnt/usb disk'
      ]
    })
    // Floored, never rounded: 511.6 reported as 512 is exactly the figure the
    // install gate treats as enough room to start.
    const fractional = await probe({
      space: [
        'Filesystem           1K-blocks      Used Available Use% Mounted on',
        '/dev/loop0                8192      7680     511.6  94% /overlay'
      ]
    })

    expect(spaced.overlayFreeKb).toBe(6_144)
    expect(fractional.overlayFreeKb).toBe(511)
  })

  it('treats a truncated answer as unread rather than as a broken router', async () => {
    // Past the executor's output cap stdout is simply cut. The tail sections
    // were then absent rather than empty, so this parsed as a complete verdict:
    // no package database, no ip rule support, no user id - a healthy router
    // reported as unmanageable, with hasIpRule=false latched, which refuses
    // every new binding until the next reconnect.
    const whole = probeOutput()
    const cut = whole.slice(0, whole.indexOf('===PKG==='))
    const harness = moduleHarness('openwrt', () => ok(cut, '[overflow] output limit reached', 125))

    const caps = await probeOpenWrt(harness.ctx)

    expect(caps.probed).toBe(false)
    expect(caps.state).toBe('checking')
    expect(caps.checks.every((entry) => entry.status === 'unknown')).toBe(true)
    expect(caps.missingPackages).toEqual([])
  })

  it('supports 25.12 with apk, and blocks anything that installs another way', async () => {
    // The gate is the database on disk, never the release string: a snapshot
    // build calls itself SNAPSHOT and would fail any version comparison while
    // shipping exactly the apk this module needs.
    const apk = await probe()
    const world = await probe({ pkg: ['apkworld'] })
    const snapshot = await probe({ release: 'SNAPSHOT r28417' })
    const opkg = await probe({
      release: '24.10.2',
      pkg: ['opkgdb'],
      tools: [...ROUTER_TOOLS.slice(0, -1), '/bin/opkg']
    })
    const neither = await probe({ pkg: [], tools: ROUTER_TOOLS.slice(0, -1) })

    expect(apk.pkgManager).toBe('apk')
    expect(apk.state).toBe('ready')
    // `/etc/apk/world` is the second signal, for a login that cannot stat the
    // installed database.
    expect(world.pkgManager).toBe('apk')
    expect(snapshot.state).toBe('ready')

    expect(opkg.pkgManager).toBeNull()
    expect(opkg.state).toBe('blocked')
    expect(opkg.problem).toBe(
      'This module needs OpenWrt 25.12 or newer. This router runs 24.10.2 and still uses opkg.'
    )
    // The card and the blocking sentence are the same string, so the settings
    // page cannot describe this router in two voices.
    expect(check(opkg, 'pkgmgr').detail).toBe(opkg.problem)
    expect(check(opkg, 'pkgmgr').status).toBe('bad')

    expect(neither.pkgManager).toBeNull()
    expect(neither.state).toBe('blocked')
    expect(neither.problem).toContain('No apk package database on this router.')
    expect(check(neither, 'pkgmgr').detail).toBe(neither.problem)
  })

  it('warns about a release below 25.12 without making the version the gate', async () => {
    // Only reachable on a router that has apk and still calls itself 24.10 -
    // a half-finished upgrade. It is a warning, not a refusal, because the
    // functional test said the installer is there.
    const caps = await probe({ release: '24.10.2' })

    expect(caps.state).toBe('ready')
    expect(check(caps, 'openwrt').status).toBe('warn')
    expect(check(caps, 'openwrt').detail).toContain('24.10.2')
    expect(check(caps, 'openwrt').detail).toContain('25.12')
  })

  it('reads the user id, so "install this for me" is not offered to a user who cannot', async () => {
    expect((await probe()).isRoot).toBe(true)
    const limited = await probe({ uid: '1000' })
    expect(limited.isRoot).toBe(false)
    expect(check(limited, 'root').status).toBe('warn')
    expect((await probe({ uid: '' })).uid).toBe(-1)
    expect(check(await probe({ uid: '' }), 'root').status).toBe('unknown')
  })
})

describe('openwrt readiness: five states instead of one sentence', () => {
  it('is connecting before anything has been asked', () => {
    const caps = emptyCapabilities()

    expect(caps.state).toBe('connecting')
    expect(caps.ready).toBe(false)
    // Unchanged wording: the poller latch and every existing caller key off it.
    expect(caps.problem).toBe('Not connected to a router yet.')
  })

  it('is checking - not blocked - when the router said nothing back', () => {
    // Every page used to swap itself for an error panel here, during an
    // ordinary startup, because "we have not looked yet" and "this router is
    // unusable" were the same verdict.
    const caps = buildReadiness(facts({ probed: false, transportError: 'ssh channel closed' }))

    expect(caps.state).toBe('checking')
    expect(caps.problem).toBe('ssh channel closed')
    expect(caps.ready).toBe(false)
  })

  it('blames the transport for a silent answer instead of the router', () => {
    const caps = buildReadiness(facts({ probed: false, isOpenwrt: false, transportError: '' }))

    expect(caps.problem).toBe('The OpenWRT capability probe returned no data.')
    expect(caps.state).toBe('checking')
  })

  it('is blocked, with the wording it always had, on a machine that is not a router', () => {
    const caps = buildReadiness(facts({ isOpenwrt: false }))

    expect(caps.state).toBe('blocked')
    expect(caps.problem).toContain('not an OpenWRT router')
  })

  it('is blocked when a required tool is missing, and names it', () => {
    const caps = buildReadiness(facts({ tools: ['ubus', 'uci', 'ip'] }))

    expect(caps.state).toBe('blocked')
    expect(caps.problem).toContain('OpenWRT is missing required command(s): netifd.')
    // This sentence is shown directly above the install form's own section, so
    // it has to say that nothing there can supply a base-system command.
    expect(caps.problem).toContain('cannot be installed from here')
    expect(check(caps, 'netifd').status).toBe('bad')
    expect(check(caps, 'netifd').required).toBe(true)
  })

  it('says which half does the work, without calling either one a fault', () => {
    // Three states, three sentences. No agent is one row saying so and two
    // saying there is nothing to ask; an agent with neither package is a router
    // that has the safety net and does the work over SSH; an agent with both is
    // the router doing it itself. None of them is `bad`, because none of them
    // is broken.
    const none = buildReadiness(facts({ agent: emptyAgentFacts() }))
    expect(check(none, 'feature-binding').status).toBe('unknown')
    expect(check(none, 'feature-binding').detail).toContain('no agent to ask')

    const bare = buildReadiness(facts())
    expect(check(bare, 'feature-binding').status).toBe('warn')
    expect(check(bare, 'feature-binding').detail).toContain('bm-wanbind is not installed')
    expect(check(bare, 'feature-pppoe').detail).toContain('bm-pppoe-pool is not installed')

    const full = buildReadiness(
      facts({
        agent: {
          ...emptyAgentFacts(),
          installed: true,
          running: true,
          ...AGENT,
          provides: ['binding', 'pppoe'],
          features: [
            { name: 'bm-wanbind', version: '2.0.0', apiVersion: 1, provides: ['binding'] },
            { name: 'bm-pppoe-pool', version: '2.0.0', apiVersion: 2, provides: ['pppoe'] }
          ]
        }
      })
    )
    expect(check(full, 'feature-binding').status).toBe('ok')
    expect(check(full, 'feature-pppoe').status).toBe('ok')
    // Still not a failure anywhere: these rows never make a router unusable.
    expect(full.checks.some((entry) => entry.key.startsWith('feature-') && entry.status === 'bad'))
      .toBe(false)
  })

  it('says a 1.x pool package is an update, not a pool daemon', () => {
    // The capability name alone cannot tell the generations apart, and the
    // 1.x contract - numbered session runs - is one this module no longer
    // drives. The row says what to do rather than reading as installed.
    const stale = buildReadiness(
      facts({
        agent: {
          ...emptyAgentFacts(),
          installed: true,
          running: true,
          ...AGENT,
          provides: ['pppoe'],
          features: [
            { name: 'bm-pppoe-pool', version: '1.4.1', apiVersion: 1, provides: ['pppoe'] }
          ]
        }
      })
    )
    expect(check(stale, 'feature-pppoe').status).toBe('warn')
    expect(check(stale, 'feature-pppoe').detail).toContain('Update the router packages')
    expect(check(stale, 'feature-pppoe').detail).toContain('keep dialling')
  })

  it('is ready when everything answered, and asks for nothing', () => {
    const caps = buildReadiness(facts())

    expect(caps.state).toBe('ready')
    expect(caps.ready).toBe(true)
    expect(caps.problem).toBeNull()
    expect(caps.setupNeeded).toBe(false)
    expect(caps.missingPackages).toEqual([])
    // Every row except the ones about the router-side packages, which this
    // fixture's router does not have. Those are warnings and unknowns by
    // design - a router managed over SSH is not a router with a fault - and
    // each is covered on its own below.
    const routerSide = ['agent', 'guard', 'feature-binding', 'feature-pppoe']
    expect(
      caps.checks
        .filter((entry) => !routerSide.includes(entry.key))
        .every((entry) => entry.status === 'ok')
    ).toBe(true)
  })

  it('runs, but asks for attention, when an optional package is missing', () => {
    const caps = buildReadiness(facts({ ppp: { plugin: false, kmod: false } }))

    // Still ready: the collector must keep running. PPPoE Dialer is what is
    // unavailable, not the dashboard.
    expect(caps.ready).toBe(true)
    expect(caps.problem).toBeNull()
    expect(caps.state).toBe('attention')
    expect(caps.setupNeeded).toBe(true)
    expect(caps.missingPackages.map((entry) => entry.name)).toEqual([
      'ppp',
      'ppp-mod-pppoe',
      'kmod-pppoe'
    ])
    expect(caps.missingPackages.every((entry) => entry.group === 'pppoe')).toBe(true)
  })

  it('does not treat a missing macvlan as unfinished', () => {
    const caps = buildReadiness(facts({ ppp: { plugin: true, kmod: true, macvlan: false } }))

    expect(caps.ready).toBe(true)
    expect(caps.setupNeeded).toBe(false)
    expect(caps.missingPackages).toEqual([])
    expect(check(caps, 'macvlan').status).toBe('warn')
    expect(check(caps, 'pppoe').status).toBe('ok')
  })

  it('does not offer an install it cannot perform', () => {
    const noManager = buildReadiness(
      facts({ ppp: { plugin: false, kmod: false }, pkgDb: { opkg: false, apk: false }, tools: [
        'ubus',
        'uci',
        'ip',
        'netifd',
        'fw4',
        'nft',
        'logread',
        'pppd',
        'dnsmasq'
      ] })
    )
    const notRoot = buildReadiness(facts({ ppp: { plugin: false, kmod: false }, uid: 1_000 }))

    expect(noManager.setupNeeded).toBe(false)
    expect(notRoot.setupNeeded).toBe(false)
    // A router with no apk is refused outright rather than half-driven: the
    // install flow it would be offered speaks a package manager it does not
    // have. A non-root login is only a warning, since everything but the
    // install still works.
    expect(noManager.state).toBe('blocked')
    expect(check(noManager, 'pkgmgr').status).toBe('bad')
    expect(notRoot.state).toBe('attention')
    expect(check(notRoot, 'root').detail).toContain('uid 1000')
  })

  it('warns about ip rule and dnsmasq without dragging the router into attention', () => {
    const caps = buildReadiness(facts({ hasIpRule: false, uid: 1_000 }))

    expect(check(caps, 'iprule').status).toBe('warn')
    expect(check(caps, 'iprule').install).toBe('ipfull')
    // A warning is something a user may choose to live with; only a broken
    // feature is worth pulling them to the settings page for.
    expect(caps.state).toBe('ready')
  })

  it('refuses to call an install possible when there is no room for it', () => {
    const empty = buildReadiness(
      facts({ ppp: { plugin: false, kmod: false }, overlayFreeKb: 128 })
    )
    const tight = buildReadiness(facts({ ppp: { plugin: false, kmod: false }, overlayFreeKb: 1_024 }))
    const idle = buildReadiness(facts({ overlayFreeKb: 128 }))

    expect(check(empty, 'space').status).toBe('bad')
    expect(check(tight, 'space').status).toBe('warn')
    // Nothing to install: a nearly full overlay is not this module's business.
    expect(check(idle, 'space').status).toBe('warn')
    expect(check(buildReadiness(facts({ overlayFreeKb: -1 })), 'space').status).toBe('unknown')
  })

  it('marks fw4 broken rather than installable, since fw3 cannot be upgraded from here', () => {
    const caps = buildReadiness(facts({ tools: ['ubus', 'uci', 'ip', 'netifd', 'pppd', 'logread', 'dnsmasq', 'apk'] }))

    expect(check(caps, 'fw4').status).toBe('bad')
    expect(check(caps, 'fw4').install).toBeNull()
    expect(caps.missingPackages.some((entry) => entry.name.includes('fw'))).toBe(false)
    expect(caps.state).toBe('attention')
  })
})

describe('openwrt readiness cards', () => {
  it('groups the checklist into cards a status block can render', () => {
    const caps = buildReadiness(facts({ ppp: { plugin: true, kmod: false }, hasIpRule: false }))

    expect(caps.cards.map((card) => card.key)).toEqual([
      'core',
      'firewall',
      'pppoe',
      'extras',
      'install',
      'agent'
    ])
    const pppoe = caps.cards[2]
    expect(pppoe.status).toBe('bad')
    expect(pppoe.subtitle).toBe('0/2 ok')
    expect(pppoe.note).toContain('kernel PPPoE support')
    // The worst check decides the card, not the count.
    expect(caps.cards[1].status).toBe('warn')
    expect(caps.cards[0].status).toBe('ok')
    expect(caps.cards[0].note).toContain('every required tool answered')
  })

  it('pins the chips that are not ok, so the card filter shows the faults', () => {
    // A BusyBox `ip`: it refuses a numeric routing table, so policy routing is
    // a fault - but it lists rules perfectly well, so the competing-rule scan
    // ran and its answer stands. The two used to be one verdict, and reading
    // the second off the first blanked this row on exactly the routers where a
    // competing rule matters most.
    const caps = buildReadiness(facts({ hasIpRule: false }))
    const firewall = caps.cards[1]

    expect(firewall.checks).toEqual([
      { label: 'Firewall4 (fw4 + nft)', status: 'ok', pinned: false },
      { label: 'Policy routing (ip rule)', status: 'warn', pinned: true },
      { label: 'Competing policy routing', status: 'ok', pinned: false }
    ])
  })

  it('pins competing rules as unknown when the scan itself did not run', () => {
    // The scan not running is its own fact. `unknown` pins too - a blank on
    // this card is a fault, not a clean bill of health.
    const caps = buildReadiness(facts({ foreignRulesRead: false }))

    expect(caps.cards[1].checks).toContainEqual({
      label: 'Competing policy routing',
      status: 'unknown',
      pinned: true
    })
  })
})

/**
 * A binary in PATH is not a running service, and one ip rule at a lower
 * preference beats everything this module writes. Both faults used to be
 * invisible: the first showed an empty device table with no reason given, the
 * second a green dashboard while the traffic left by another WAN.
 */
describe('openwrt readiness: running services and competing rules', () => {
  it('separates an installed dnsmasq from a running one', async () => {
    const stopped = await probe({ service: ['pidof', 'netifd', 'nftok', 'fw4'] })

    // Still installed - offering to install it again would be nonsense.
    expect(stopped.hasDnsmasq).toBe(true)
    expect(stopped.missingPackages.some((entry) => entry.name === 'dnsmasq')).toBe(false)
    expect(stopped.services.dnsmasq).toBe('stopped')
    expect(check(stopped, 'dnsmasq').status).toBe('warn')
    expect(check(stopped, 'dnsmasq').detail).toContain('service is not running')
    expect(check(stopped, 'dnsmasq').detail).toContain('service dnsmasq start')

    const running = await probe()
    expect(running.services.dnsmasq).toBe('running')
    expect(check(running, 'dnsmasq').status).toBe('ok')
  })

  it('will not call a service stopped on a router that has no pidof', async () => {
    // The sentinel is the whole point: without it every router missing one
    // BusyBox applet is told its dnsmasq and its netifd are both down.
    const caps = await probe({ service: ['nftok', 'fw4'] })

    expect(caps.services.dnsmasq).toBe('unknown')
    expect(caps.services.netifd).toBe('unknown')
    expect(check(caps, 'dnsmasq').status).toBe('ok')
    expect(check(caps, 'dnsmasq').detail).toContain('no pidof')
    expect(check(caps, 'netifdrun').status).toBe('unknown')
    // Nothing about a missing applet may make the router unmanageable.
    expect(caps.problem).toBeNull()
    expect(caps.ready).toBe(true)
  })

  it('reports netifd installed but not running as a fault worth pulling the user in for', async () => {
    const caps = await probe({ service: ['pidof', 'dnsmasq', 'nftok', 'fw4'] })

    expect(check(caps, 'netifd').status).toBe('ok')
    expect(check(caps, 'netifdrun').status).toBe('bad')
    expect(check(caps, 'netifdrun').detail).toContain('not running')
    // A `bad` check on a working router is what `attention` is for; it must not
    // become `problem`, which would stop the collector on a router that runs.
    expect(caps.problem).toBeNull()
    expect(caps.state).toBe('attention')
  })

  it('tells fw4 installed-but-unloaded apart from a router still on fw3', async () => {
    const unloaded = await probe({ service: ['pidof', 'dnsmasq', 'netifd', 'nftok'] })

    expect(unloaded.hasFw4).toBe(true)
    expect(check(unloaded, 'fw4').status).toBe('warn')
    expect(check(unloaded, 'fw4').detail).toContain('service firewall start')

    // The fw3 router keeps the refusal it always had, wording and all.
    const fw3 = await probe({
      tools: ['/sbin/ubus', '/sbin/uci', '/sbin/ip', '/sbin/netifd', '/usr/sbin/dnsmasq', '/usr/bin/apk'],
      service: ['pidof', 'dnsmasq', 'netifd']
    })
    expect(fw3.hasFw4).toBe(false)
    expect(check(fw3, 'fw4').status).toBe('bad')
    expect(check(fw3, 'fw4').detail).toContain('fw3')
    // No nft to load a ruleset with, so "not loaded" is not an answer anyone has.
    expect(fw3.services.fw4).toBe('unknown')
  })

  it('names mwan3 rather than listing the preferences it wrote', async () => {
    const caps = await probe({
      conflict: [
        'mwan3conf',
        'mwan3run',
        'rule 1001: from all fwmark 0x100/0x3f00 lookup 1',
        'total 1'
      ]
    })

    expect(caps.mwan3).toEqual({ config: true, running: true })
    const conflict = check(caps, 'conflict')
    expect(conflict.status).toBe('warn')
    expect(conflict.detail).toContain('mwan3')
    expect(conflict.detail).toContain('and running')
    expect(conflict.detail).toContain('lowest preference wins')
    // A warning, never a refusal: someone chose to run mwan3 on this router.
    expect(caps.ready).toBe(true)
    expect(caps.problem).toBeNull()
  })

  it('reports a foreign rule below the managed window, and how many there were', async () => {
    const caps = await probe({
      conflict: [
        'rule 100: from 192.168.9.0/24 lookup 42',
        'rule 200: from all iif eth2 lookup 43',
        'rule 300: from all lookup 44',
        'rule 400: from all lookup 45',
        // The count comes from awk, not from the lines that survived the cap.
        'total 9'
      ]
    })

    expect(caps.foreignRuleCount).toBe(9)
    expect(caps.foreignRules).toHaveLength(4)
    // Ascending: the lowest preference is the one that actually decides.
    expect(caps.foreignRules[0]).toEqual({ pref: 100, text: 'from 192.168.9.0/24 lookup 42' })
    const conflict = check(caps, 'conflict')
    expect(conflict.status).toBe('warn')
    expect(conflict.detail).toContain('9 ip rule(s)')
    expect(conflict.detail).toContain('100: from 192.168.9.0/24 lookup 42')
    expect(conflict.detail).toContain('and 6 more')
  })

  it('says nothing about competing rules when the scan produced no count', async () => {
    // No `total` line means the awk never reached its END block - the scan did
    // not run, and a body with no rules in it is then evidence of nothing at
    // all rather than of a clean router.
    const caps = await probe({ conflict: [] })

    expect(check(caps, 'conflict').status).toBe('unknown')
    expect(check(caps, 'conflict').detail).toContain('Nothing could be read back')
  })

  it('still reports competing rules on a router whose ip cannot do numeric tables', async () => {
    // The case that made this its own fact. `ipRule: false` is a BusyBox `ip`,
    // which fails policy routing and lists rules perfectly well - so the count
    // it produced is real and is worth showing. Reading this row off the
    // policy-routing verdict hid a competing rule behind a missing package.
    const caps = await probe({
      ipRule: false,
      conflict: ['rule 100: from all lookup 42', 'total 1']
    })

    expect(caps.hasIpRule).toBe(false)
    expect(check(caps, 'conflict').status).toBe('warn')
    expect(caps.foreignRuleCount).toBe(1)
  })

  it('calls a clean router clean, and names the preference it checked below', async () => {
    const caps = await probe()

    expect(caps.foreignRuleCount).toBe(0)
    expect(check(caps, 'conflict').status).toBe('ok')
    expect(check(caps, 'conflict').detail).toContain('20000')
    expect(caps.state).toBe('ready')
  })

  it('filters on the router, at the preference base actually configured', async () => {
    const harness = moduleHarness('openwrt', () => ok(probeOutput()))

    const caps = await probeOpenWrt(harness.ctx, 12_345)

    const command = harness.exec.mock.calls[0]?.[0] ?? ''
    // Router-side, because an unfiltered `ip rule show` on a router with a
    // thousand bound clients dwarfs everything else this probe collects.
    expect(command).toContain('-v B=12345')
    expect(command).toContain("echo '===CONFLICT==='")
    expect(caps.rulePrefBase).toBe(12_345)
  })

  it('falls back to the shipped base rather than filtering against nothing', async () => {
    const harness = moduleHarness('openwrt', () => ok(probeOutput()))

    // An empty `-v B=` would make the comparison `$1+0 < 0` and report every
    // router on earth as free of competing rules.
    await probeOpenWrt(harness.ctx, 0)

    expect(harness.exec.mock.calls[0]?.[0] ?? '').toContain('-v B=20000')
  })

  it('claims nothing about a router that never answered', () => {
    const caps = emptyCapabilities()

    expect(caps.services).toEqual({ dnsmasq: 'unknown', netifd: 'unknown', fw4: 'unknown' })
    expect(caps.foreignRules).toEqual([])
    expect(caps.mwan3).toEqual({ config: false, running: false })
    expect(check(caps, 'conflict').detail).toBe('The router has not answered yet.')
  })
})
