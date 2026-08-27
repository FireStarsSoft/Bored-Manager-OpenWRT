import { describe, expect, it } from 'vitest'
import { buildReadiness, emptyFacts, type OpenWrtCapabilities, type ProbeFacts } from '../../openwrt/main/probe'
import { AGENT_INFO } from '../helpers/router'

/**
 * "This router cannot do policy routing" is three different faults wearing one
 * sentence, and only one of them is fixed by installing a package.
 *
 * The module used to answer all three with the BusyBox paragraph and an offer
 * to install `ip-full`. So somebody whose install had already succeeded - the
 * package on disk, working when called directly, and simply not what `ip`
 * resolves to - was told to install it again, did, and got the same `partial`
 * job and the same red card. Nothing anywhere named the symlink.
 *
 * These are the three verdicts, and which of them may carry an install.
 */

/** A router that is fine apart from whatever the patch says. */
const facts = (patch: Partial<ProbeFacts> = {}): ProbeFacts => ({
  ...emptyFacts(),
  connected: true,
  probed: true,
  isOpenwrt: true,
  release: '25.12.0',
  board: 'Test Router',
  tools: ['ubus', 'uci', 'ip', 'netifd', 'fw4', 'nft', 'logread', 'pppd', 'dnsmasq', 'apk'],
  ppp: { plugin: true, kmod: true },
  pkgDb: { opkg: false, apk: true },
  uid: 0,
  overlayFreeKb: 8_192,
  hasIpRule: true,
  ip: { path: '/sbin/ip', real: '/sbin/ip', fullPresent: false, fullWorks: false },
  services: { dnsmasq: 'running', netifd: 'running', fw4: 'running' },
  foreignRulesRead: true,
  agent: { ...emptyFacts().agent, installed: true, running: true, ...AGENT_INFO },
  ...patch
})

const iprule = (caps: OpenWrtCapabilities): OpenWrtCapabilities['checks'][number] => {
  const found = caps.checks.find((entry) => entry.key === 'iprule')
  if (!found) throw new Error('no iprule check')
  return found
}

const firewallCard = (caps: OpenWrtCapabilities): string => {
  const card = caps.cards.find((entry) => entry.key === 'firewall')
  if (!card) throw new Error('no firewall card')
  return card.note
}

describe('the three reasons a router cannot steer by routing table', () => {
  it('offers the install only when the package is genuinely absent', () => {
    const caps = buildReadiness(facts({ hasIpRule: false }))
    const check = iprule(caps)

    expect(check.status).toBe('warn')
    expect(check.install).toBe('ipfull')
    expect(check.detail).toContain('BusyBox')
  })

  it('names the symlink, not a reinstall, when ip-full is there and unused', () => {
    // The router somebody has just installed ip-full on: apk succeeded, the
    // binary works when called by its own path, and `ip` still means BusyBox.
    const caps = buildReadiness(
      facts({
        hasIpRule: false,
        ip: {
          path: '/sbin/ip',
          real: '/bin/busybox',
          fullPresent: true,
          fullWorks: true
        }
      })
    )
    const check = iprule(caps)

    expect(check.status).toBe('warn')
    // The whole point: installing it again is not the answer, so the row must
    // not offer to.
    expect(check.install).toBeNull()
    expect(check.detail).toContain('/usr/libexec/ip-full')
    expect(check.detail).toContain('/bin/busybox')
    expect(check.detail).toContain('ln -sf /usr/libexec/ip-full /sbin/ip')
  })

  it('says no package can help when the kernel is the problem', () => {
    const caps = buildReadiness(
      facts({
        hasIpRule: false,
        ip: {
          path: '/sbin/ip',
          real: '/usr/libexec/ip-full',
          fullPresent: true,
          fullWorks: false
        }
      })
    )
    const check = iprule(caps)

    expect(check.status).toBe('warn')
    expect(check.install).toBeNull()
    expect(check.detail).toContain('kernel')
    expect(check.detail).toContain('No package fixes that')
    expect(check.detail).not.toContain('ln -sf')
  })

  it('doubts itself out loud when the binding daemon is running anyway', () => {
    // bm-wanbind writes rules over netlink and never touches the ip binary,
    // so a kernel-refuses verdict on a router whose daemon is binding clients
    // is almost certainly the probe being wrong, not the kernel being short a
    // feature - and the row has to say so rather than sending somebody to
    // reflash working firmware.
    const caps = buildReadiness(
      facts({
        hasIpRule: false,
        ip: {
          path: '/sbin/ip',
          real: '/usr/libexec/ip-full',
          fullPresent: true,
          fullWorks: false
        },
        agent: {
          ...facts().agent,
          provides: ['binding'],
          features: [
            { name: 'bm-wanbind', version: '2.0.1', apiVersion: 1, provides: ['binding'] }
          ]
        }
      })
    )
    const check = iprule(caps)

    expect(check.status).toBe('warn')
    expect(check.detail).toContain('bm-wanbind is running')
    expect(check.detail).toContain('netlink')
  })

  it('names the binary it found when policy routing works', () => {
    const check = iprule(buildReadiness(facts({ ip: { path: '/usr/sbin/ip', real: '/usr/libexec/ip-full', fullPresent: true, fullWorks: true } })))

    expect(check.status).toBe('ok')
    expect(check.detail).toContain('/usr/libexec/ip-full')
  })
})

describe('the remedy a failing card carries', () => {
  /**
   * `install` has been on every check since the install flow existed and no
   * surface read it, so the three rows this module can actually fix were the
   * only ones whose detail named no next step - while every row it cannot fix
   * spelled one out. The card is where a user reads the fault, so the card is
   * where the fix belongs.
   */
  it('sends a root apk router to the install form', () => {
    const note = firewallCard(buildReadiness(facts({ hasIpRule: false })))

    expect(note).toContain('BusyBox')
    expect(note).toContain('Install missing packages')
    expect(note).toContain('Policy routing (ip-full)')
  })

  it('says what is in the way instead, when installing could not run', () => {
    // A non-root login cannot install anything, so "use the install form" is
    // the one sentence that is no use at all.
    const note = firewallCard(buildReadiness(facts({ hasIpRule: false, uid: 1_000 })))

    expect(note).toContain('needs root')
    expect(note).not.toContain('use "Install missing packages"')
  })

  it('adds nothing to a row no package can fix', () => {
    const note = firewallCard(
      buildReadiness(
        facts({
          hasIpRule: false,
          ip: { path: '/sbin/ip', real: '/bin/busybox', fullPresent: true, fullWorks: true }
        })
      )
    )

    expect(note).toContain('ln -sf')
    expect(note).not.toContain('Install missing packages')
  })
})

describe('what the install surfaces are told about the same three routers', () => {
  /**
   * The card and the install form have to agree, and for one release they did
   * not. The card was taught the three verdicts and stopped offering an install
   * for two of them; `missingPackages` went on being built from `hasIpRule`
   * alone, so Module settings still listed ip-full as missing with its box
   * ticked, `setupNeeded` held the router at "Needs attention" for ever, and
   * the new install prompt on the WAN Binding tab offered the same no-op job -
   * on the exact router whose card said reinstalling would not help.
   */
  const groups = (caps: OpenWrtCapabilities): string[] => [
    ...new Set(caps.missingPackages.map((entry) => entry.group))
  ]

  it('offers ip-full when it is genuinely absent', () => {
    const caps = buildReadiness(facts({ hasIpRule: false }))

    expect(groups(caps)).toContain('ipfull')
    expect(caps.missingFor.binding).toBe(true)
    expect(caps.setupNeeded).toBe(true)
  })

  it('offers nothing when the package is on disk and the link never switched', () => {
    const caps = buildReadiness(
      facts({
        hasIpRule: false,
        ip: { path: '/sbin/ip', real: '/bin/busybox', fullPresent: true, fullWorks: true }
      })
    )

    // Nothing to install, so nothing to hold the router at "Needs attention":
    // the remedy is a symlink, and the card is where it is written.
    expect(groups(caps)).not.toContain('ipfull')
    expect(caps.missingFor.binding).toBe(false)
    expect(caps.setupNeeded).toBe(false)
    expect(firewallCard(caps)).toContain('ln -sf')
  })

  it('offers nothing when the kernel has no policy routing', () => {
    const caps = buildReadiness(
      facts({
        hasIpRule: false,
        ip: { path: '/sbin/ip', real: '/usr/libexec/ip-full', fullPresent: true, fullWorks: false }
      })
    )

    expect(groups(caps)).not.toContain('ipfull')
    expect(caps.missingFor.binding).toBe(false)
    expect(caps.setupNeeded).toBe(false)
  })

  it('still offers the binding installer for the half of it that is installable', () => {
    // ip-full beyond help and dnsmasq simply absent. Binding needs both, and
    // one of them is still worth an install form.
    const caps = buildReadiness(
      facts({
        hasIpRule: false,
        ip: { path: '/sbin/ip', real: '/bin/busybox', fullPresent: true, fullWorks: true },
        tools: ['ubus', 'uci', 'ip', 'netifd', 'fw4', 'nft', 'logread', 'pppd', 'apk']
      })
    )

    expect(groups(caps)).not.toContain('ipfull')
    expect(groups(caps)).toContain('dnsmasq')
    expect(caps.missingFor.binding).toBe(true)
  })
})
