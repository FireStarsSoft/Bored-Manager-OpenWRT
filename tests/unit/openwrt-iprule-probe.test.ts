import { describe, expect, it } from 'vitest'
import { buildProbeCommand } from '../../openwrt/main/probe'
import { DEFAULT_RULES } from '../../openwrt/main/config'

/**
 * The policy-routing probe has to fail a router this module cannot steer -
 * and pass one it can. Both directions have now been wrong once.
 *
 * Every other test in this repository feeds the probe's *output* to the parser,
 * which is the right shape for almost everything - and is exactly why both
 * faults got through. The first was in what the command asked: `ip -4 rule
 * show` was taken as proof of policy routing, and a stock OpenWrt 25.12 image
 * passes it. Its `/sbin/ip` is a symlink to BusyBox, whose `ip` answers
 * `rule show` and then refuses the only thing this module ever asks of it:
 *
 *     ip: invalid argument '29999' to 'table'
 *     ip: invalid argument '29999' to 'table ID'
 *
 * A router like that reported "Policy routing: Present" and "Nothing is missing
 * on this router", accepted a binding instance, committed the firewall half of
 * it, and then failed on the first line that would have steered a packet.
 *
 * The second was in what the command accepted as a pass. The kernel creates
 * FIB tables lazily, so a numeric table nothing has written to yet does not
 * exist, and modern iproute2 answers the dump with exit 1 and
 *
 *     Error: ipv4: FIB table does not exist.
 *
 * - which is the kernel *parsing the numeric table and looking it up*, exactly
 * the capability under test. Requiring exit 0 read that as "no policy routing
 * in this firmware" on a healthy QEMU 25.12.5 router, whose own bm-wanbind was
 * binding clients over netlink at that very moment.
 *
 * So this asserts on the command text. It is the only place either mistake was
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
    // Stderr is captured (2>&1), because the FIB sentence below lives there.
    expect(section).toMatch(/ip -4 route show table \d+ 2>&1/)
  })

  it('requires both, so passing one is not enough', () => {
    // The verdict is nested inside the `rule show` gate: BusyBox passes that
    // first test, so a section that accepted either alone would go on
    // reporting a BusyBox router as ready. A kernel without multiple routing
    // tables fails `rule show` itself, which keeps the third verdict reachable.
    expect(section).toMatch(/if ip -4 rule show >\/dev\/null 2>&1; then if \[/)
  })

  it('treats a missing FIB table as proof of the capability, not its absence', () => {
    // Once for the `ip` in PATH, once for /usr/libexec/ip-full called
    // directly - the two verdicts (`ok`, `libexecok`) tolerate it separately.
    const matches = section.match(/fib table does not exist/g) ?? []
    expect(matches).toHaveLength(2)
    // BusyBox's refusal must stay a failure: the tolerance is one exact
    // sentence, never "any stderr will do".
    expect(section).not.toContain('invalid argument')
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
