/**
 * The two settings that decide whether a bound address can still reach its own
 * LAN.
 *
 * A one-to-one binding sends everything from an address to its WAN's routing
 * table, and that table knows only how to leave the building. The daemon writes
 * one escape rule per LAN to fix that, below every binding rule - and both of
 * the fields that control it are on this form, where a numeric reader would
 * have accepted the checkbox, ignored it, and reported it as saved.
 */
import { describe, expect, it } from 'vitest'
import { wanbindClient } from '../helpers/wanbind'

describe('the LAN-local settings reach the router', () => {
  it('sends the switch when it changes, and nothing when it does not', async () => {
    const client = wanbindClient()

    try {
      await client.tick()

      const off = client.manager.settingsCheck({ lan_local: false })
      expect(off.ok).toBe(true)

      await client.manager.settingsApply({ token: off.token, values: { lan_local: false } })

      const sent = client.daemon.payloads('settings_set').at(-1)
      expect(sent?.lan_local).toBe(false)

      // A form that resubmits what is already in force is not a change, and a
      // check that called it one would send every field on every save.
      const same = client.manager.settingsCheck({ lan_local: true })
      expect(same.ok).toBe(false)
      expect(same.findings?.[0]?.label).toContain('Nothing was entered')
    } finally {
      client.dispose()
    }
  })

  it('refuses a base that would put the escapes after the bindings', async () => {
    const client = wanbindClient()

    try {
      await client.tick()

      // 19_500 + 64 reaches 19_563, which is inside the one-to-one band that
      // starts at 19_000 - so every escape rule would be read after the
      // binding rule it exists to come before, and decide nothing.
      const bad = client.manager.settingsCheck({ local_pref_base: '19500' })

      expect(bad.ok).toBe(false)
      expect(bad.findings?.some((one) => one.label.includes('not below the one-to-one base'))).toBe(
        true
      )
    } finally {
      client.dispose()
    }
  })

  it('and accepts one that sits below them', async () => {
    const client = wanbindClient()

    try {
      await client.tick()

      const good = client.manager.settingsCheck({ local_pref_base: '17500' })
      expect(good.ok).toBe(true)

      await client.manager.settingsApply({ token: good.token, values: { local_pref_base: '17500' } })

      const sent = client.daemon.payloads('settings_set').at(-1)
      expect(sent?.local_pref_base).toBe(17_500)

      // Only what changed: a form about one number is not a form about the
      // other nine.
      expect(sent?.lan_local).toBeUndefined()
      expect(sent?.interval).toBeUndefined()
    } finally {
      client.dispose()
    }
  })
})
