/**
 * Every method name the renderer can call, in one list.
 *
 * The renderer reaches these by string, from `openwrt/module.json` and the UI
 * specs, so a name that is registered here and nowhere else is a dead button
 * nothing reports. Keeping the whole set in one file is what makes the two
 * lists comparable at a glance.
 *
 * Almost every entry is a single call into the domain that owns it. The ones
 * that are not fall into three groups, and all three exist because the caller
 * is a JSON spec that cannot branch, filter or join for itself:
 *
 * - the create gates. A form that asks for PPPoE or binding on a router
 *   missing the packages for it has to be refused here, before the domain turns
 *   a missing package into a configuration verdict the user cannot act on.
 * - the dashboard's waiting queue, which is one table over every instance and
 *   so has to be joined from as many calls as there are instances.
 * - the refusals a page-wide table needs, where the row it acted on has no
 *   instance behind it at all.
 *
 * A drawer's open tab is not one of them any more: it arrives here as a scope
 * argument and is passed straight through, because what "needs attention"
 * means is a property of the rows, and it belongs beside them.
 */
import { failedCheck } from '@shared/check'
import type { OkResult } from '@shared/types'
import { selectOptions } from '../options'
import { FW4_MISSING } from '../probe'
import { emitUi, type OpenWrtRuntime } from './container'
import { installHint, refreshCapabilities, startPollers, unprobed } from './readiness'

/**
 * Both device actions are addressed by the instance that owns the device. The
 * dashboard offers them on every DHCP lease it can see, and a device no
 * instance manages carries an empty id - which reached the binding engine as
 * "no valid device was selected", a refusal that names neither the device nor
 * anything to do about it.
 *
 * A bulk action sends an array of `instance|mac` keys instead, and the engine
 * discards the ones with no instance itself, so only the single-row form is
 * checked here.
 */
const UNMANAGED_DEVICE =
  'No WAN Binding instance manages this device, so there is no WAN to give it or take away. Create an instance for its LAN on the Automation page, Create tab; devices on that LAN are assigned on the next sweep.'

function noInstance(idOrKeys: unknown): boolean {
  return !Array.isArray(idOrKeys) && !String(idOrKeys ?? '').trim()
}

export function registerHandlers(runtime: OpenWrtRuntime): void {
  const { ctx, binding, config, events, jobs, latch, pppoe, queries, rules, service, setup, store } =
    runtime

  // Reading methods never open SSH; visible tables may poll these frequently.
  ctx.handle('selectOptions', (kind: unknown) =>
    selectOptions(kind, service.latest, store.read())
  )
  ctx.handle('deviceRows', () => queries.deviceRows())
  ctx.handle('pppoeBatches', () => pppoe.batches())
  // The second argument is the drawer's open tab. Without it the drawer pushed
  // every row in the batch on every fast tick whether or not anybody was
  // reading them; what each tab means is decided by the folder that owns the
  // rows, not here.
  ctx.handle('pppoeRows', (batchId: unknown, scope: unknown) => pppoe.rows(batchId, scope))
  ctx.handle('pppoeAttentionRows', () => pppoe.attentionRows())
  ctx.handle('bindingRows', (id: unknown, scope: unknown) => binding.rows(id, scope))
  ctx.handle('bindingWaitingRows', (id: unknown) => {
    const wanted = String(id ?? '').trim()
    if (wanted) return binding.waitingRows(wanted)
    // Asked with no instance by the dashboard. Why a device is waiting - held
    // by hand, out of preferences, or simply queued - was computed on every
    // pass and readable only by opening the right instance's drawer, so the
    // instance each row belongs to is carried alongside it.
    const instances = binding.snapshot().instances
    const names = new Map(instances.map((instance) => [instance.id, instance.name]))
    return instances.flatMap((instance) =>
      binding
        .waitingRows(instance.id)
        .map((row) => ({ ...row, instance: names.get(row.instanceId) ?? '' }))
    )
  })
  ctx.handle('bindingEventRows', (id: unknown) => binding.eventRows(id))
  ctx.handle('eventRows', (source: unknown, limit: unknown) => events.rows(source, limit))
  ctx.handle('rulesEffective', () => rules.effective())
  // The one sentence that says which condition is actually stopping an install
  // on this router, so the settings page stops listing three and leaving the
  // user to guess. Every create form's refusal already ends with it.
  ctx.handle('installHint', () => ({ hint: installHint(latch.capabilities, 'a package') }))

  ctx.handle('sweepNow', async (): Promise<OkResult> => {
    if (!ctx.connected) {
      // Every other refusal in this module ends with what to do about it; this
      // one used to be four words and a dead end.
      return {
        ok: false,
        error: 'not connected to a router - connect this machine entry, then refresh again'
      }
    }
    const available = await refreshCapabilities(latch)
    if (available.problem) return { ok: false, error: available.problem }
    latch.applied = null
    latch.probing = null
    startPollers(latch, available)
    service.forceDumpNextTick()
    await Promise.all([service.run(), service.runSlow()])
    return { ok: true }
  })
  ctx.handle('hintsSet', (payload: unknown): OkResult => {
    // A checkbox sends what it wants, not a request to flip whatever is stored:
    // the old toggle answered "the opposite of the server's copy", which is the
    // wrong answer whenever the page was opened before another surface changed
    // it. A `form` submit hands over its whole values object, so read the flag
    // out of that as well as accepting it bare.
    const value =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).hintsOn
        : payload
    config.setHints(value === true || value === 'true' || value === 'on' || value === '1')
    emitUi(runtime)
    return { ok: true }
  })

  ctx.handle('setupCheck', (values: unknown) => setup.check(values))
  ctx.handle('setupApply', (payload: unknown) => setup.apply(payload))

  ctx.handle('pppoeBatchCheck', (values: unknown) => {
    // Read at call time: the verdict changes under this handler whenever a
    // probe lands, and a form checked a second later must see the new one.
    const caps = latch.capabilities
    const waiting = unprobed(caps)
    if (waiting) return waiting
    if (!caps.hasPppoe) {
      return failedCheck(
        'PPPoE support is missing on this router',
        installHint(caps, 'ppp, ppp-mod-pppoe and kmod-pppoe')
      )
    }
    if (!caps.hasFw4) {
      return failedCheck('Firewall4 is required for managed PPPoE pools', FW4_MISSING)
    }
    return pppoe.batchCheck(values)
  })
  ctx.handle('pppoeBatchApply', (payload: unknown) => pppoe.batchApply(payload))
  ctx.handle('pppoeBatchAction', (id: unknown, action: unknown) =>
    pppoe.batchAction(id, action)
  )
  ctx.handle('pppoeBatchDelete', (id: unknown) => pppoe.batchDelete(id))
  ctx.handle('pppoeConnAction', (names: unknown, action: unknown) =>
    pppoe.connAction(names, action)
  )

  ctx.handle('bindingCheck', (values: unknown) => {
    const caps = latch.capabilities
    const waiting = unprobed(caps)
    if (waiting) return waiting
    if (!caps.hasFw4) {
      return failedCheck('Firewall4 is required for WAN Binding', FW4_MISSING)
    }
    if (!caps.hasIpRule) {
      // Binding is nothing but ip rules. Without rule support the instance
      // would be created, start cleanly and steer no traffic at all.
      return failedCheck(
        'The ip command on this router has no rule support',
        installHint(caps, 'ip-full')
      )
    }
    if (!caps.hasDnsmasq) {
      // Without this gate a missing package reached binding.check() and came
      // back as a configuration verdict - "LAN has no dnsmasq DHCP section" -
      // which sends the user editing /etc/config/dhcp on a router that has no
      // dnsmasq to configure.
      return failedCheck('dnsmasq is missing on this router', installHint(caps, 'dnsmasq'))
    }
    return binding.check(values)
  })
  ctx.handle('bindingApply', (payload: unknown) => binding.apply(payload))
  // The row's edit form: `bindingUpdate(id, values)`, values last, the way
  // every other form-backed method on this list takes them.
  ctx.handle('bindingUpdate', (id: unknown, values: unknown) => binding.update(id, values))
  ctx.handle('bindingStart', (id: unknown) => binding.start(id))
  ctx.handle('bindingStop', (id: unknown) => binding.stop(id))
  ctx.handle('bindingDelete', (id: unknown) => binding.delete(id))
  ctx.handle('bindingUnassign', (id: unknown, mac: unknown) =>
    noInstance(id) ? { ok: false, error: UNMANAGED_DEVICE } : binding.unassign(id, mac)
  )
  ctx.handle('bindingReassign', (id: unknown, mac: unknown) =>
    noInstance(id) ? { ok: false, error: UNMANAGED_DEVICE } : binding.reassign(id, mac)
  )
  // The WAN name is the third argument because the row supplies the first two;
  // `ActionSpec.prompt` appends its value after `argsFromRow`.
  ctx.handle('bindingPin', (id: unknown, mac: unknown, wan: unknown) =>
    noInstance(id) ? { ok: false, error: UNMANAGED_DEVICE } : binding.pin(id, mac, wan)
  )

  ctx.handle('rulesCheck', (values: unknown) => rules.check(values))
  ctx.handle('rulesApply', (payload: unknown) => rules.apply(payload))
  ctx.handle('rulesReset', () => rules.reset())
  ctx.handle('jobCancel', (id: unknown) => jobs.cancel(id))
  ctx.handle('jobsClear', () => jobs.clearFinished())
}
