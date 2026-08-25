/**
 * The vocabulary of this domain: the narrow slices it needs from the rest of
 * the module, and the shapes every surface renders.
 *
 * The dependency interfaces are deliberately smaller than the objects that
 * satisfy them - `PppoeConfigStore` names the one method of the config store
 * this half ever calls, and `PppoeService` names the read-only side of the
 * sampler - so a unit test can stand PPPoE up without the rest of the module.
 */
import type { ValueBadge } from '@shared/module-ui'
import type { JobSpec, OpenWrtJob } from '../jobs'
import type { ManagedLayout, PppoeBatchRecord } from '../records'
import type { PppoeInputRow, RouterModel } from '../types'

/**
 * Only the rules consumed here; ConfigStore.effectiveRules() may return more.
 * The layout is carried whole rather than field by field: it is what gets
 * stamped onto the batch record, and a batch that recorded four of the six
 * would read the other two live and drift the moment they changed.
 */
export interface PppoeRules extends ManagedLayout {
  ifacePrefix: string
  uciChunkSize: number
  chunkDelayMs: number
  execTimeoutSec: number
  maxBatchRows: number
  autoRedialAfterMin: number
}

/** The part of ConfigStore used by this manager. */
export interface PppoeConfigStore {
  effectiveRules(): PppoeRules
}

/** The part of OwrtHostData used here. Binding/event fields remain untouched. */
export interface PppoeStoreData {
  nextSeq: number
  batches: PppoeBatchRecord[]
}

export interface PppoeHostStore<TData extends PppoeStoreData = PppoeStoreData> {
  read(): TData
  update<TResult>(mutate: (data: TData) => TResult): TResult
  /**
   * A number that moves whenever the document might have changed. `read()`
   * hands back the same object before and after a mutation, so without this the
   * row cache cannot tell a batch that was just created from one that was
   * always there. Optional, and a store that does not offer one is simply never
   * cached against - a missing revision must not read as an unchanged one.
   */
  revision?(): number
  /** A topology write, past the debounce. Optional so a test double may omit it. */
  updateNow?<TResult>(mutate: (data: TData) => TResult): TResult
  withFirewall?<TResult>(run: () => Promise<TResult>): Promise<TResult>
  /**
   * Serialize a write to `/etc/config/network` against the binding half, which
   * writes `ip4table` onto the same file. `uci` has no locking: two commits
   * read the file, apply their own changes and write the whole thing back, so
   * the second one silently discards the first.
   */
  withNetwork?<TResult>(run: () => Promise<TResult>): Promise<TResult>
}

export interface PppoeJobs {
  start(spec: JobSpec): OpenWrtJob
  list(): OpenWrtJob[]
}

/**
 * Adapter over FastSweep/model cache. `model` must not perform SSH; rows and
 * summaries are deliberately cache-only. `refreshNow`, when supplied, should
 * run one forced fast sample after forceDump().
 */
export interface PppoeService {
  model(): RouterModel | null
  forceDump(): void
  refreshNow?(): Promise<void>
  pppoeUsers?(): Readonly<Record<string, string>>
  pppoeErrors?(): Readonly<Record<string, string>>
  lanFirewallZone?(): string
  event?(kind: string, text: string): void
  /**
   * The binding instances and the carriers they own, supplied by the wiring in
   * `index.ts` rather than imported: the two halves meet there, not in each
   * other. Absent - in a unit test that only exercises PPPoE - the delete path
   * simply has nothing to cross-check.
   */
  bindingCarriers?(): ReadonlyArray<{
    id: string
    name: string
    carrier: string
    running: boolean
  }>
}

/**
 * `missing` is a connection this module still owns a record for that the
 * router has no interface for at all - a create that aborted part way, or a
 * section removed by hand. It used to read as `stopped`, which is also what a
 * deliberate Stop looks like, so a half-finished batch looked idle rather than
 * broken and Delete had phantom sections nobody knew about.
 *
 * `unknown` is the answer before the router has been asked. No interface list
 * has been fetched for this host yet, so nothing is known about any session -
 * and that was reported as `stopped` too, which is a claim: it says somebody
 * took these sessions down. A freshly connected router with five thousand live
 * sessions read as five thousand stopped ones until the first dump landed.
 */
export type PppoeStatus = 'up' | 'dialing' | 'error' | 'stopped' | 'missing' | 'unknown'

export interface PppoeRow {
  id: string
  name: string
  batchId: string
  batch: string
  username: string
  status: PppoeStatus
  /** The code the session failed with, empty on every other status. */
  errorCode: string
  ip: string
  /** App-clock time the session came up, or 0 when it is not up. */
  upSince: number
}

export interface PppoeBatchSummary {
  id: string
  name: string
  carrier: string
  prefix: string
  vlan?: number
  count: number
  up: number
  dialing: number
  error: number
  stopped: number
  /** Configured here, absent on the router. See PppoeStatus. */
  missing: number
  /** Not yet asked about: no interface list has been read. See PppoeStatus. */
  unknown: number
  /** The batch's whole state as chips: what is wrong, or "All up". */
  stateBadges: ValueBadge[]
  createdAt: number
}

export interface PppoeDisplayRow {
  name: string
  batch: string
  username: string
  status: PppoeStatus
  statusBadges: ValueBadge[]
  errorCode: string
  ip: string
  upSince: number
}

export interface PppoeSnapshot {
  t: number
  batchCount: number
  total: number
  up: number
  dialing: number
  error: number
  stopped: number
  missing: number
  unknown: number
  /** Sessions a user would want to act on - errors plus the ones gone missing. */
  attention: number
}

/**
 * What the check froze behind its token: the exact credentials, the exact
 * range, and the exact rules they were reasoned about with. Nothing may be
 * re-read at apply time or the report the user approved stops describing what
 * is about to happen.
 */
export interface FrozenBatchPlan {
  name: string
  carrier: string
  prefix: string
  vlan?: number
  rows: readonly Readonly<PppoeInputRow>[]
  seqFrom: number
  seqTo: number
  rules: Readonly<PppoeRules>
}

export interface RouterInventory {
  carrierExists: boolean
  sections: Set<string>
  tables: Set<number>
  vlanDevices: Map<string, { ifname?: string; vid?: number; name?: string }>
}

export interface NetworkDeviceInventory {
  interfaceDevices: Map<string, string>
  deviceNames: Map<string, string>
  /** Every `network.<name>=interface` section that exists on the router now. */
  interfaceSections: Set<string>
  /** Every `firewall.<name>=zone` section that exists on the router now. */
  zoneSections: Set<string>
  /** Every `firewall.<name>=forwarding` section that exists on the router now. */
  forwardingSections: Set<string>
}
