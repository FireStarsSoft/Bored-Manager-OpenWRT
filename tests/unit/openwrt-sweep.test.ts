import { describe, expect, it, vi } from 'vitest'
import { moduleHarness } from '../helpers/module-harness'
import activateOpenwrt from '../../openwrt/main/index'
import { FastSweep } from '../../openwrt/main/service'

/**
 * `sweepNow` used to await only `service.run()` - the fast pass. A manual
 * sweep therefore left `uciTables`, PPPoE log errors and PPPoE user maps at
 * whatever the last scheduled slow tick produced, even though the button is
 * the one place a user expects "refresh everything now". It now also awaits
 * `service.runSlow()`.
 */
describe('OpenWRT sweepNow', () => {
  it('re-runs the slow probe as well as the fast one', async () => {
    const runSpy = vi.spyOn(FastSweep.prototype, 'run').mockResolvedValue(undefined)
    const runSlowSpy = vi.spyOn(FastSweep.prototype, 'runSlow').mockResolvedValue(undefined)
    try {
      const probeStdout = [
        '===REL===',
        'DISTRIB_ID=OpenWrt',
        'DISTRIB_RELEASE=25.12.5',
        '===BOARD===',
        '{}',
        '===TOOLS===',
        'ubus',
        'uci',
        'ip',
        'netifd',
        '===PPP===',
        '',
        '===PKG===',
        'apkdb',
        '===DONE==='
      ].join('\n')
      const harness = moduleHarness('openwrt', () => ({ stdout: probeStdout, stderr: '', code: 0 }))
      activateOpenwrt(harness.ctx)
      const sweepNow = harness.handlers.get('sweepNow')!

      const result = await sweepNow()

      expect(result).toEqual({ ok: true })
      expect(runSpy).toHaveBeenCalledTimes(1)
      expect(runSlowSpy).toHaveBeenCalledTimes(1)
    } finally {
      runSpy.mockRestore()
      runSlowSpy.mockRestore()
    }
  })
})
