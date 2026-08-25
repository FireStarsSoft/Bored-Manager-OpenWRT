/**
 * The Router packages source that refuses, and why it has a file of its own.
 *
 * `openwrt/main/agent/manifest.ts` is written by `npm run pin:packages` before
 * a release is tagged, so in a released build the constants are filled in and
 * `hasPinnedRelease()` is true. The branch below can then never be reached by
 * a test that reads the real module - and it is the branch that matters most,
 * because it is the one an ordinary user meets if a release is ever cut
 * without the pin.
 *
 * `vi.mock` is hoisted for a whole file, which is why this is not simply
 * another `it` in openwrt-agent.test.ts: mocking there would take the pin away
 * from every other test in it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'

vi.mock('../../openwrt/main/agent/manifest', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../openwrt/main/agent/manifest')>()
  return {
    ...real,
    PINNED_RELEASE: '',
    PINNED_BASE: '',
    PINNED_PACKAGES: [],
    hasPinnedRelease: () => false
  }
})

const { default: activate } = await import('../../openwrt/main/index')
const { moduleHarness, sharedModuleConfig } = await import('../helpers/module-harness')
const { isProbeCommand, routerProbeOutput } = await import('../helpers/router')

const ok = (stdout = '', stderr = '', code = 0): ModuleExecResult => ({ code, stdout, stderr })

const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const HOST = {
  version: 1,
  nextSeq: 1,
  batches: [] as unknown[],
  instances: [] as unknown[],
  extraTables: [],
  stickyMap: [],
  events: [],
  moduleEvents: [],
  jobs: []
}

const report = (value: unknown): ModuleCheckReport => value as ModuleCheckReport
const text = (value: unknown): string =>
  report(value)
    .findings.map((finding) => `${finding.level} ${finding.label} ${finding.detail ?? ''}`)
    .join('\n')

describe('a module build with nothing pinned', () => {
  it('refuses the pinned source by name, and points at the ones that work', async () => {
    const harness = moduleHarness('openwrt', () => ok(), {
      hostData: HOST,
      config: sharedModuleConfig(null)
    })
    harness.exec.mockImplementation(async (command) =>
      isProbeCommand(command) ? ok(routerProbeOutput({ agent: null })) : ok()
    )
    const runtime = activate(harness.ctx)
    runtime.applyPollers?.()
    await settle()

    const result = await harness.handlers.get('agentInstallCheck')?.({ source: 'pinned' })

    // An invented hash would be worse in both directions: it cannot install and
    // it cannot explain itself.
    expect(report(result).ok).toBe(false)
    expect(text(result)).toContain('no pinned package release')
    expect(text(result)).toContain('bundle file or a path on the router')
    runtime.dispose?.()
  })
})
