import { describe, expect, it } from 'vitest'
import { buildProbeCommand } from '../../openwrt/main/probe'
import { DEFAULT_RULES } from '../../openwrt/main/config'

/**
 * The policy-routing probe has to fail a router this module cannot steer.
 *
 * Every other test in this repository feeds the probe's *output* to the parser,
 * which is the right shape for almost everything - and is exactly why this one
 * got through. The fault was in the command: `ip -4 rule show` was taken as
 * proof of policy routing, and a stock OpenWrt 25.12 image passes it. Its
 * `/sbin/ip` is a symlink to BusyBox, whose `ip` answers `rule show` and then
 * refuses the only thing this module ever asks of it:
 *
 *     ip: invalid argument '29999' to 'table'
 *     ip: invalid argument '29999' to 'table ID'
 *
 * A router like that reported "Policy routing: Present" and "Nothing is missing
 * on this router", accepted a binding instance, committed the firewall half of
 * it, and then failed on the first line that would have steered a packet - on
 * every retry, two seconds apart, for as long as the instance existed.
 *
 * So this asserts on the command text. It is the only place the mistake was
 * visible, because a probe that asks the wrong question gets a truthful answer.
 */

describe('what the probe accepts as policy routing', () => {
  const command = buildProbeCommand(DEFAULT_RULES.rulePrefBase)
  const section = command.slice(
    command.indexOf("'===IPRULE==='"),
    command.indexOf("'===SERVICE==='")
  )

  it('tests a numeric routing table, not just that `ip rule` answers', () => {
    expect(section).toContain('ip -4 rule show')
    // The half that tells iproute2 from BusyBox. Without it the section is
    // satisfied by an `ip` that cannot write a single rule this module needs.
    expect(section).toMatch(/ip -4 route show table \d+/)
  })

  it('requires both, so passing one is not enough', () => {
    // `&&` and not `;` or `||`: BusyBox passes the first test, so a section
    // that accepted either would go on reporting a router as ready.
    expect(section).toMatch(/ip -4 rule show[^\n]*&&[^\n]*ip -4 route show table/)
  })

  it('stays read-only', () => {
    // A probe runs on every slow tick against a router somebody is using. The
    // numeric-table question is answerable by reading, and the version that
    // answered it by adding a rule and deleting it again would be writing to
    // the policy table of every router this module has ever been pointed at.
    expect(section).not.toMatch(/\brule\s+add\b/)
    expect(section).not.toMatch(/\broute\s+(add|replace|del)\b/)
    expect(section).not.toMatch(/\brule\s+del\b/)
  })
})
