/**
 * Every method name the renderer can call, in one list.
 *
 * The renderer reaches these by string, from `openwrt/module.json` and the UI
 * specs, so a name that is registered here and nowhere else is a dead button
 * nothing reports. Keeping the whole set in one file is what makes the two
 * lists comparable at a glance.
 *
 * Every one of them goes through `handle` rather than `ctx.handle`, which is
 * the module's single requirements gate: what a method needs from the router is
 * declared in `requirements.ts`, and nothing is registered that has not
 * declared it. The two hand-written `if` chains that used to guard the create
 * forms - and nothing else - are gone; `bindingApply` and `bindingStart` are
 * checked on exactly the same terms `bindingCheck` is, which they never were.
 *
 * Almost every entry is a single call into the domain that owns it. The ones
 * that are not fall into two groups, and both exist because the caller is a
 * JSON spec that cannot branch, filter or join for itself:
 *
 * - the dashboard's waiting queue, which is one table over every instance and
 *   so has to be joined from as many calls as there are instances.
 * - the refusals a page-wide table needs, where the row it acted on has no
 *   instance behind it at all.
 *
 * A drawer's open tab is not one of them any more: it arrives here as a scope
 * argument and is passed straight through, because what "needs attention"
 * means is a property of the rows, and it belongs beside them.
 */
import type { ModuleCheckFinding, ModuleCheckReport } from '@shared/check'
import type { OkResult } from '@shared/types'
import { selectOptions } from '../options'
import { installHint, requirementRefusal, requirementWarnings } from '../requirements'
import { emitUi, type OpenWrtRuntime } from './container'
import { refreshCapabilities, startPollers } from './readiness'

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
  'No WAN Binding instance manages this device, so there is no WAN to give it or take away. Create an instance for its LAN on the Automation page, under WAN Binding; devices on that LAN are assigned on the next sweep.'

function noInstance(idOrKeys: unknown): boolean {
  return !Array.isArray(idOrKeys) && !String(idOrKeys ?? '').trim()
}

function isReport(value: unknown): value is ModuleCheckReport {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as ModuleCheckReport).findings)
  )
}

/**
 * Fold the router-wide warnings into a report the domain just produced.
 *
 * They go first because they are about the router rather than about the values,
 * and a user reading a plan needs to know the plan may not be what actually
 * happens before they read what it is. `ok` is left exactly as the domain set
 * it: a competing ip rule is worth knowing about, not worth refusing over.
 */
function withWarnings(
  result: unknown,
  warnings: readonly ModuleCheckFinding[]
): unknown {
  if (result instanceof Promise) {
    return result.then((value) => withWarnings(value, warnings))
  }
  if (!isReport(result)) return result
  return { ...result, findings: [...warnings, ...result.findings] }
}

export function registerHandlers(runtime: OpenWrtRuntime): void {
  const {
    agent,
    ctx,
    binding,
    config,
    events,
    jobs,
    latch,
    pppoe,
    queries,
    rules,
    service,
    setup,
    store
  } = runtime

  /**
   * The module's one requirements gate.
   *
   * Nothing below calls `ctx.handle` directly. What a method needs is declared
   * in `requirements.ts`, and every registration passes through this, so a
   * capability that vanished after an instance was created stops the next call
   * with a sentence naming it instead of a shell error from the middle of a
   * reconcile - and a method added tomorrow cannot arrive without a gate,
   * because `npm run check` compares the two lists.
   *
   * The verdict is read here, on each call, rather than captured when the
   * handlers were registered: a probe lands under these, and a form checked a
   * second later has to see the new answer.
   */
  const handle = (method: string, fn: (...args: never[]) => unknown): void => {
    ctx.handle(method, (...args: never[]) => {
      const caps = latch.capabilities
      const refusal = requirementRefusal(method, caps)
      if (refusal) return refusal
      const warnings = requirementWarnings(method, caps)
      const result = fn(...args)
      return warnings.length ? withWarnings(result, warnings) : result
    })
  }

  // Reading methods never open SSH; visible tables may poll these frequently.
  handle('selectOptions', (kind: unknown) =>
    selectOptions(kind, service.latest, store.read())
  )
  handle('deviceRows', () => queries.deviceRows())
  handle('pppoeBatches', () => pppoe.batches())
  // The second argument is the drawer's open tab. Without it the drawer pushed
  // every row in the batch on every fast tick whether or not anybody was
  // reading them; what each tab means is decided by the folder that owns the
  // rows, not here.
  handle('pppoeRows', (batchId: unknown, scope: unknown) => pppoe.rows(batchId, scope))
  handle('pppoeAttentionRows', () => pppoe.attentionRows())
  handle('bindingRows', (id: unknown, scope: unknown) => binding.rows(id, scope))
  handle('bindingWaitingRows', (id: unknown) => {
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
  handle('bindingEventRows', (id: unknown) => binding.eventRows(id))
  handle('eventRows', (source: unknown, limit: unknown) => events.rows(source, limit))
  handle('rulesEffective', () => rules.effective())
  // The one sentence that says which condition is actually stopping an install
  // on this router, so the settings page stops listing three and leaving the
  // user to guess. Every create form's refusal already ends with it.
  handle('installHint', () => ({ hint: installHint(latch.capabilities, 'a package') }))

  handle('sweepNow', async (): Promise<OkResult> => {
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
  handle('hintsSet', (payload: unknown): OkResult => {
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

  handle('setupCheck', (values: unknown) => setup.check(values))
  handle('setupApply', (payload: unknown) => setup.apply(payload))

  // The router-side packages. Everything they offer has an SSH equivalent that
  // predates them, so none of it is required for the module to work - which is
  // exactly why the table keeps answering on a router that has none.
  handle('agentRows', () => agent.rows())
  handle('agentInstallCheck', (values: unknown) => agent.installCheck(values))
  handle('agentInstallApply', (payload: unknown) => agent.installApply(payload))
  handle('agentUninstallCheck', (values: unknown) => agent.uninstallCheck(values))
  handle('agentUninstallApply', (payload: unknown) => agent.uninstallApply(payload))

  // Both create gates used to spell their capability checks out here, in two
  // hand-written `if` chains that no apply or action shared. They are entries
  // in `requirements.ts` now, so the same conditions stop `pppoeBatchApply` and
  // `bindingStart` too - which is the whole point of the change.
  handle('pppoeBatchCheck', (values: unknown) => pppoe.batchCheck(values))
  handle('pppoeBatchApply', (payload: unknown) => pppoe.batchApply(payload))
  handle('pppoeBatchAction', (id: unknown, action: unknown) =>
    pppoe.batchAction(id, action)
  )
  handle('pppoeBatchDelete', (id: unknown) => pppoe.batchDelete(id))
  handle('pppoeConnAction', (names: unknown, action: unknown) =>
    pppoe.connAction(names, action)
  )

  // `dnsmasq` is in this one's requirements for a reason worth keeping written
  // down: without that gate a missing package reached binding.check() and came
  // back as a configuration verdict - "LAN has no dnsmasq DHCP section" - which
  // sends the user editing /etc/config/dhcp on a router that has no dnsmasq to
  // configure.
  handle('bindingCheck', (values: unknown) => binding.check(values))
  handle('bindingApply', (payload: unknown) => binding.apply(payload))
  // The row's edit form: `bindingUpdate(id, values)`, values last, the way
  // every other form-backed method on this list takes them.
  handle('bindingUpdate', (id: unknown, values: unknown) => binding.update(id, values))
  handle('bindingStart', (id: unknown) => binding.start(id))
  handle('bindingStop', (id: unknown) => binding.stop(id))
  handle('bindingDelete', (id: unknown) => binding.delete(id))
  handle('bindingUnassign', (id: unknown, mac: unknown) =>
    noInstance(id) ? { ok: false, error: UNMANAGED_DEVICE } : binding.unassign(id, mac)
  )
  handle('bindingReassign', (id: unknown, mac: unknown) =>
    noInstance(id) ? { ok: false, error: UNMANAGED_DEVICE } : binding.reassign(id, mac)
  )
  // The WAN name is the third argument because the row supplies the first two;
  // `ActionSpec.prompt` appends its value after `argsFromRow`.
  handle('bindingPin', (id: unknown, mac: unknown, wan: unknown) =>
    noInstance(id) ? { ok: false, error: UNMANAGED_DEVICE } : binding.pin(id, mac, wan)
  )

  handle('rulesCheck', (values: unknown) => rules.check(values))
  handle('rulesApply', (payload: unknown) => rules.apply(payload))
  handle('rulesReset', () => rules.reset())
  handle('jobCancel', (id: unknown) => jobs.cancel(id))
  handle('jobsClear', () => jobs.clearFinished())
}
