import { describe, expect, it } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import { fakeWanbind, instanceConfig, wanbindClient } from '../helpers/wanbind'

/**
 * The two things the create form still decides for itself about an instance,
 * and the one thing it deliberately no longer decides.
 *
 * Binding steers a client by source address only, so two instances that can see
 * the same addresses cannot be told apart. That has not changed and it never
 * will - what changed is who answers it. Until 3.4.0 this module worked out
 * which interfaces an instance owned, which subnets they covered and whether a
 * carrier was a VLAN riding on somebody else's bridge, all from a sample of
 * device names, and refused on its own reading. The router reads its own
 * interfaces now, with evidence per interface, and it refuses on the thing that
 * actually collides: **overlapping address ranges on one LAN**, which is a
 * different rule in kind from the one this file used to describe and is proved
 * against the real daemon by `wanbind-range` in `packages/ci/probes/` - "a
 * third that straddles them is refused", "a whole-LAN instance beside a scoped
 * one is refused", "switching one off moves the refusal to the next one it
 * overlaps".
 *
 * So what is left here is exactly what needs no router to answer, and both of
 * them would otherwise have no test at all: a name another instance already
 * carries, measured against the list the daemon last gave us, and one interface
 * named as both ends. Everything else is asked, and the answer is shown rather
 * than argued with.
 */

const HELD = instanceConfig({ id: 'bmi_held01', name: 'ISP A', lan: 'lan', carrier: 'eth1.835' })

async function checkWith(
  configured: ReturnType<typeof instanceConfig>[],
  values: Record<string, unknown>
): Promise<{ report: ModuleCheckReport; asked: Array<Record<string, unknown>> }> {
  const daemon = fakeWanbind({ configured })
  const client = wanbindClient({ daemon })
  // The list a name is measured against is the router's own - this module keeps
  // no record of an instance - so the check has to happen after a tick that
  // read one.
  await client.tick()
  const report = await client.manager.createCheck(values)
  client.dispose()
  return { report, asked: daemon.payloads('instance_check') }
}

const text = (report: ModuleCheckReport): string =>
  report.findings.map((finding) => `${finding.label} ${finding.detail ?? ''}`).join('\n')

describe('what the create form refuses without asking the router', () => {
  it('refuses a name another instance already carries', async () => {
    // The name reaches job labels, event rows and `ctx.log` on this side before
    // it is ever a UCI value on the router, and it is how every refusal on this
    // page identifies the instance in the way.
    const { report, asked } = await checkWith([HELD], {
      name: 'isp a',
      lan: 'guest',
      carrier: 'eth2'
    })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('An instance named "isp a" already exists')
    // And nothing was sent. A blocking finding on this side stops before the
    // round trip, which is what keeps a form that cannot be saved from asking
    // the router to weigh up its interfaces first.
    expect(asked).toHaveLength(0)
  })

  it('refuses one interface used as both ends', async () => {
    // The pool would be carried on the wire it is meant to serve, so every
    // client would be steered onto its own LAN. Nothing about the router is
    // needed to see it: it is the same name twice.
    const { report, asked } = await checkWith([], { name: 'X', lan: 'lan', carrier: 'lan' })

    expect(report.ok).toBe(false)
    expect(text(report)).toContain('The LAN logical interface and WAN carrier must be different')
    expect(asked).toHaveLength(0)
  })

  it('asks the router about everything else, rather than deciding it here', async () => {
    // The positive control, and the boundary in one: a form with a free name
    // and two different interfaces is not refused here - it is sent, with the
    // pair named, for the router to weigh against its own zones, subnets and
    // priorities. Without this every assertion above would pass on a gate that
    // had simply stopped accepting anything.
    const { report, asked } = await checkWith([HELD], {
      name: 'ISP B',
      lan: 'guest',
      carrier: 'eth2'
    })

    expect(report.ok).toBe(true)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ lan: 'guest', carrier: 'eth2', name: 'ISP B' })
  })
})
