/**
 * The object the container holds for the Capacity tab: one poller, one cached
 * payload, one stream, and the five ways a fix reaches the router.
 *
 * Gated the way the monitor is, and for the same reason: nothing on this router
 * reconciles against a capacity report, so a router nobody has the tab open on
 * must not pay a round trip a minute forever for a page no one is reading.
 * `refresh()` is the button beside that, and it runs whether or not anything is
 * watching, because a person pressing it is the thing watching.
 *
 * Nothing here decides anything about the router. It asks, it renders, and when
 * somebody presses a Fix it calls a write path that already existed - the same
 * one the Router limits form, the binding settings form and the pool page use.
 * There is no new way to write to a router in this folder, deliberately: a
 * report is a reply that arrived over a wire, and a report that could open a
 * write path of its own would be a router configuring itself from something it
 * was told.
 */
import type { ModulePoller } from '@shared/modules'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import {
  agentCapacity,
  type AgentDeps,
  type TuneWanted,
  type RawCapacity
} from '../agent'
import type { AgentCapability, OpenWrtCapabilities } from '../probe'
import { requirementRefusal } from '../requirements'
import { describeFixes } from './fixes'
import {
  CAPACITY_INTERVAL_MS,
  capacityAvailable,
  capacityNeedsUpdate,
  emptyCapacitySnapshot,
  normalizeCapacity,
  unavailableCapacity,
  withStaleness
} from './normalize'
import type { CapacityFixRow, CapacitySnapshot } from './types'

/** What a fix does once this side has decided it may. */
export interface CapacityWriters {
  tune: (wanted: TuneWanted) => Promise<OkResult>
  wanbindReconcile: () => Promise<OkResult>
  wanbindSettingsSet: (changes: Record<string, unknown>) => Promise<OkResult>
  wanbindInstanceSet: (id: string) => Promise<OkResult>
  poolReconcile: () => Promise<OkResult>
}

export interface CapacityDeps {
  ctx: ModuleContext
  agentDeps: () => AgentDeps
  agent: () => AgentCapability
  capabilities: () => OpenWrtCapabilities
  writers: CapacityWriters
  event: (text: string) => void
}

const NOT_CONNECTED = 'the router is not connected'

/** A method-not-found from an agent that predates the verb, in its own words. */
const NOT_FOUND = /method not found|not found/i

export class CapacityManager {
  private readonly deps: CapacityDeps
  private readonly poller: ModulePoller
  private payload: CapacitySnapshot = emptyCapacitySnapshot()
  private appliedMs: number | null = null
  private flight: Promise<void> | null = null
  private generation = 0
  private disposed = false

  constructor(deps: CapacityDeps) {
    this.deps = deps
    this.poller = deps.ctx.createPoller('openwrt:capacity', () => this.tick())
  }

  /** The payload, with its staleness worked out at the moment it is asked for. */
  snapshot(): CapacitySnapshot {
    return withStaleness(this.payload, Date.now())
  }

  applyPollers(): void {
    const caps = this.deps.capabilities()
    const usable = caps.probed && caps.problem === null
    const wanted =
      !this.disposed && this.deps.ctx.connected && usable ? CAPACITY_INTERVAL_MS : null

    if (wanted === this.appliedMs) return

    this.appliedMs = wanted
    this.poller.stop()
    if (wanted !== null) this.poller.start(wanted)
  }

  /** Ask now, whoever asked. A second press joins the call already in flight. */
  refresh(): Promise<void> {
    const existing = this.flight
    if (existing) return existing

    const pending = this.ask(true).finally(() => {
      if (this.flight === pending) this.flight = null
    })

    this.flight = pending
    return pending
  }

  reset(): void {
    this.payload = emptyCapacitySnapshot()
    this.flight = null
    this.generation += 1
    this.appliedMs = null
    this.poller.stop()
  }

  dispose(): void {
    this.disposed = true
    this.flight = null
    this.generation += 1
    this.appliedMs = null
    this.poller.stop()
  }

  /**
   * Run one fix by the key of the finding it belongs to.
   *
   * The key, not the arguments. A caller sends the name of a row this module
   * published and this side looks up what that row said it would do - so a page
   * cannot ask for a write the report never offered, and the confirmation
   * somebody read is the thing that runs.
   */
  async fix(rawKey: unknown): Promise<OkResult> {
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    const snapshot = this.snapshot()
    const row = snapshot.fixes.find((one) => one.key === key)

    if (!row) {
      return {
        ok: false,
        error: `no finding called "${key}" in the last capacity report - press Refresh, then choose a fix from the rows it shows`
      }
    }

    if (snapshot.state !== 'ready') {
      return { ok: false, error: snapshot.reason || 'there is no capacity report to act on yet' }
    }

    if (snapshot.stale) {
      const age = Math.round((Date.now() - snapshot.at) / 60_000)
      return {
        ok: false,
        error: `the last capacity report is ${age} minutes old, and a fix is applied against what it said - press Refresh and try again`
      }
    }

    if (!this.deps.ctx.connected) return { ok: false, error: NOT_CONNECTED }

    // The daemon fixes borrow the gate of the write path they actually take, so
    // a router with no bm-wanbind refuses with the sentence that names the
    // package rather than with one invented here.
    const gate = this.gateFor(row)
    if (gate) return gate

    const result = await this.run(row)
    if (!result.ok) return result

    this.deps.event(`capacity fix: ${row.label || row.key}`)
    await this.refresh()

    return { ok: true, data: `${row.action} The report has been asked again.` }
  }

  private gateFor(row: CapacityFixRow): OkResult | null {
    if (row.kind === 'tune_set') return null

    const name = row.kind === 'pool_reconcile' ? 'pppoePoolAction' : 'bindingSettingsApply'
    const refusal = requirementRefusal(name, this.deps.capabilities())

    if (!refusal) return null
    if ('ok' in refusal) return refusal as OkResult

    // A check report, from a method the table calls a check. Its title is the
    // sentence; the rest of the report has nowhere to go on an action.
    return { ok: false, error: String((refusal as { title?: string }).title ?? '') }
  }

  private run(row: CapacityFixRow): Promise<OkResult> {
    const writers = this.deps.writers

    if (row.kind === 'tune_set') {
      const wanted: TuneWanted = {}

      if (typeof row.args.conntrack_max === 'number') wanted.conntrackMax = row.args.conntrack_max
      if (typeof row.args.gc_thresh1 === 'number') wanted.gcThresh1 = row.args.gc_thresh1
      if (typeof row.args.gc_thresh2 === 'number') wanted.gcThresh2 = row.args.gc_thresh2
      if (typeof row.args.gc_thresh3 === 'number') wanted.gcThresh3 = row.args.gc_thresh3
      if (row.args.flow_offload === true) wanted.flowOffload = true

      return writers.tune(wanted)
    }

    if (row.kind === 'wanbind_reconcile') return writers.wanbindReconcile()
    if (row.kind === 'wanbind_settings_set') return writers.wanbindSettingsSet({ lan_local: true })
    if (row.kind === 'wanbind_instance_set') {
      return writers.wanbindInstanceSet(String(row.args.id ?? ''))
    }

    return writers.poolReconcile()
  }

  private async tick(): Promise<void> {
    const ctx = this.deps.ctx

    if (this.disposed || !ctx.connected) return
    // Nobody is looking at it. See the file header.
    if (!ctx.streamActive('capacity')) return
    if (this.deps.capabilities().problem) return

    await this.refresh()
  }

  /**
   * One round trip, and the decision about whether to make it.
   *
   * A router whose agent predates the verb is answered from here without a call
   * at all: the sentence is the same one the reply would produce, and asking a
   * router a question it cannot answer once a minute is a failed call in the
   * log every minute for as long as it stays connected.
   */
  private async ask(refresh: boolean): Promise<void> {
    const generation = this.generation
    const capability = this.deps.agent()

    if (!capacityAvailable(capability)) {
      this.publish(unavailableCapacity(capacityNeedsUpdate(capability), capability.release ?? ''))
      return
    }

    const reply = await agentCapacity(this.deps.agentDeps(), refresh)

    if (!this.current(generation)) return

    if (!reply.ok || !reply.data) {
      const error = reply.error ?? 'the router refused the capacity report without saying why'

      if (NOT_FOUND.test(error)) {
        this.publish(unavailableCapacity(capacityNeedsUpdate(capability), capability.release ?? ''))
        return
      }

      // A failed call keeps the last good report and says what failed. The
      // numbers on it describe the router as it was, which is true and stale;
      // replacing them with nothing would read as a router that has stopped
      // having any capacity at all.
      this.publish({ ...this.payload, reason: error })
      this.deps.ctx.log(`openwrt: ${error}`)
      return
    }

    const raw = reply.data as RawCapacity

    if (raw.ok === false) {
      this.publish({ ...this.payload, reason: raw.reason ?? 'the router could not work it out' })
      return
    }

    const next = normalizeCapacity(raw, Date.now(), capability)

    this.publish({ ...next, fixes: describeFixes(next.fixes, capability) })
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private publish(next: CapacitySnapshot): void {
    this.payload = next
    this.deps.ctx.emit('capacity', next)
  }
}
