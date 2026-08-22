import type { ModuleActivate, ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { failedCheck } from '@shared/check'
import { BindingEngine } from './binding'
import { ConfigStore, RulesEditor } from './config'
import { Jobs } from './jobs'
import { selectOptions } from './options'
import { PppoeManager } from './pppoe'
import {
  emptyCapabilities,
  probeOpenWrt,
  type OpenWrtCapabilities
} from './probe'
import { Queries } from './queries'
import { FastSweep } from './service'
import { HostStore, type OwrtHostData } from './store'

const INTERVAL_KEY = 'openwrt'

const activate: ModuleActivate = (ctx: ModuleContext) => {
  const config = new ConfigStore(ctx)
  const store = new HostStore(ctx, () => config.effectiveRules())
  const jobs = new Jobs<OwrtHostData>(ctx, store)

  let pppoe!: PppoeManager<OwrtHostData>
  let binding!: BindingEngine
  const service = new FastSweep(ctx, config, store, {
    async onSample(model) {
      pppoe.onSample(model)
      await binding.onSample(model)
    },
    async onSlowSample(sample) {
      pppoe.slowTick(sample.t)
      await binding.reconcileWanTables(sample.uciTables)
    },
    bindingTotals() {
      return binding.snapshot().instances.reduce(
        (total, instance) => ({
          bound: total.bound + instance.devices.bound,
          waiting: total.waiting + instance.devices.waiting
        }),
        { bound: 0, waiting: 0 }
      )
    },
    pppoeTotals() {
      return pppoe.batches().reduce(
        (total, batch) => ({
          total: total.total + batch.count,
          up: total.up + batch.up,
          dialing: total.dialing + batch.dialing,
          error: total.error + batch.error,
          stopped: total.stopped + batch.stopped
        }),
        { total: 0, up: 0, dialing: 0, error: 0, stopped: 0 }
      )
    }
  })

  const sharedService = {
    model: () => service.latest,
    forceDump: () => service.forceDumpNextTick(),
    refreshNow: () => service.run(),
    pppoeErrors: () => service.pppoeErrorSnapshot(),
    pppoeUsers: () => service.pppoeUserSnapshot(),
    lanFirewallZone: () => 'lan'
  }
  pppoe = new PppoeManager(ctx, config, store, jobs, sharedService)

  binding = new BindingEngine(ctx, store, {
    rules: () => config.effectiveRules(),
    jobs,
    wanTables: () => service.uciTables,
    requestDump: () => service.forceDumpNextTick()
  })

  const queries = new Queries(
    () => service.latest,
    () => service.uciTables,
    config,
    store
  )
  const rules = new RulesEditor(
    ctx,
    config,
    () => store.read().batches.length > 0 || store.read().instances.length > 0
  )

  let capabilities: OpenWrtCapabilities = emptyCapabilities()
  let capabilityFlight: Promise<OpenWrtCapabilities> | null = null
  let capabilityGeneration = 0
  let stopped = false
  let applied: string | null = null
  let probing: string | null = null

  const uiSnapshot = (): { hintsOn: boolean } => ({
    hintsOn: config.read().ui.showHints
  })
  const emitUi = (): void => ctx.emit('ui', uiSnapshot())

  const refreshCapabilities = (): Promise<OpenWrtCapabilities> => {
    if (capabilityFlight) return capabilityFlight
    const generation = capabilityGeneration
    const pending = probeOpenWrt(ctx)
      .then((next) => {
        if (stopped || generation !== capabilityGeneration) return next
        capabilities = next
        ctx.emit('capabilities', next)
        if (next.problem) ctx.log(`openwrt: ${next.problem}`)
        return next
      })
      .finally(() => {
        if (capabilityFlight === pending) capabilityFlight = null
      })
    capabilityFlight = pending
    return pending
  }

  const startPollers = (): void => {
    const fastMs = Math.max(0, ctx.fastIntervalMs(INTERVAL_KEY))
    const slowSec = Math.max(0, ctx.slowIntervalSec(INTERVAL_KEY))
    const key = `${ctx.connected}|${fastMs}|${slowSec}`
    if (key === applied) return
    service.fastPoller.stop()
    service.slowPoller.stop()
    if (!ctx.connected) {
      applied = key
      probing = null
      return
    }
    if (probing === key) return
    probing = key
    void refreshCapabilities().then(
      (available) => {
        if (stopped || probing !== key || !ctx.connected) return
        if (available.problem) {
          probing = null
          return
        }
        applied = key
        probing = null
        if (fastMs > 0) service.fastPoller.start(fastMs)
        if (slowSec > 0) service.slowPoller.start(slowSec * 1_000)
        else if (Object.keys(service.uciTables).length === 0) void service.runSlow()
      },
      () => {
        if (probing === key) probing = null
      }
    )
  }

  // Reading methods never open SSH; visible tables may poll these frequently.
  ctx.handle('selectOptions', (kind: unknown) =>
    selectOptions(kind, service.latest, store.read())
  )
  ctx.handle('interfaceRows', () => queries.interfaceRows())
  ctx.handle('deviceRows', () => queries.deviceRows())
  ctx.handle('pppoeBatches', () => pppoe.batches())
  ctx.handle('pppoeRows', (batchId: unknown) => pppoe.rows(batchId))
  ctx.handle('bindingList', () => binding.list())
  ctx.handle('bindingRows', (id: unknown) => binding.rows(id))
  ctx.handle('bindingWaitingRows', (id: unknown) => binding.waitingRows(id))
  ctx.handle('bindingEventRows', (id: unknown) => binding.eventRows(id))
  ctx.handle('rulesEffective', () => rules.effective())

  ctx.handle('sweepNow', async (): Promise<OkResult> => {
    if (!ctx.connected) return { ok: false, error: 'not connected to a router' }
    const available = await refreshCapabilities()
    if (available.problem) return { ok: false, error: available.problem }
    applied = null
    probing = null
    startPollers()
    service.forceDumpNextTick()
    await service.run()
    return { ok: true }
  })
  ctx.handle('hintsToggle', (): OkResult => {
    config.toggleHints()
    emitUi()
    return { ok: true }
  })

  ctx.handle('pppoeBatchCheck', (values: unknown) => {
    if (!capabilities.hasPppoe) {
      return failedCheck(
        'PPPoE support is missing on this router',
        'Install ppp, ppp-mod-pppoe and kmod-pppoe, then run Check again in Module settings.'
      )
    }
    if (!capabilities.hasFw4) {
      return failedCheck(
        'Firewall4 is required for managed PPPoE pools',
        'The module verifies nftables masquerading before exposing these sessions to LAN clients.'
      )
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
    if (!capabilities.hasFw4) {
      return failedCheck(
        'Firewall4 is required for WAN Binding',
        'The selected WAN pool needs an nftables masquerading zone before clients can use it safely.'
      )
    }
    return binding.check(values)
  })
  ctx.handle('bindingApply', (payload: unknown) => binding.apply(payload))
  ctx.handle('bindingStart', (id: unknown) => binding.start(id))
  ctx.handle('bindingStop', (id: unknown) => binding.stop(id))
  ctx.handle('bindingDelete', (id: unknown) => binding.delete(id))
  ctx.handle('bindingUnassign', (id: unknown, mac: unknown) =>
    binding.unassign(id, mac)
  )
  ctx.handle('bindingReassign', (id: unknown, mac: unknown) =>
    binding.reassign(id, mac)
  )

  ctx.handle('rulesCheck', (values: unknown) => rules.check(values))
  ctx.handle('rulesApply', (payload: unknown) => rules.apply(payload))
  ctx.handle('rulesReset', () => rules.reset())
  ctx.handle('jobCancel', (id: unknown) => jobs.cancel(id))
  ctx.handle('jobsClear', () => jobs.clearFinished())

  emitUi()

  return {
    applyPollers() {
      startPollers()
    },

    reset() {
      applied = null
      probing = null
      capabilityGeneration += 1
      capabilityFlight = null
      capabilities = emptyCapabilities()
      service.reset()
      jobs.reset()
      pppoe.reset()
      binding.reset()
      rules.clear()
      store.reset()
      config.reset()
      emitUi()
    },

    snapshots() {
      return {
        capabilities,
        ui: uiSnapshot(),
        overview: service.overview,
        series: service.series,
        pppoe: pppoe.snapshot(),
        binding: binding.snapshot(),
        jobs: jobs.snapshot()
      }
    },

    slowTargets() {
      return [INTERVAL_KEY]
    },

    async refreshSlow() {
      if (!ctx.connected) return
      const available = await refreshCapabilities()
      if (!available.problem) await service.runSlow()
    },

    dispose() {
      stopped = true
      capabilityGeneration += 1
      capabilityFlight = null
      service.dispose()
      jobs.dispose()
      pppoe.dispose()
      binding.dispose()
      rules.clear()
      store.dispose()
    }
  }
}

export default activate
