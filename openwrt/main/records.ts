/**
 * The host-data shapes that two files each declared for themselves.
 *
 * `store.ts` owns per-router persistence and `jobs.ts` writes job history into
 * it, but the runner is deliberately kept free of a runtime dependency on the
 * store - it takes a structural `JobStore` instead - and `pppoe.ts` describes
 * the slice of host data it touches rather than importing the whole document.
 * Both are good reasons not to import `store.ts`, and neither is a reason to
 * restate a record. Structural typing hides the drift for as long as every
 * assignment between the two copies still happens to fit, so the caps below
 * were the real hazard: two plain numbers with the same value and different
 * names, where raising one and not the other leaves the runner trimming to ten
 * jobs while the store keeps twenty.
 */

/**
 * Where this module's objects live on a router: the routing tables the
 * binding half numbers from, the two `ip rule` preference ranges it claims,
 * and the firewall zone it masquerades bound WANs through.
 *
 * These five are stamped onto every binding instance at creation, and read
 * back from the record afterwards. Read live from config instead, the lock in
 * `RulesEditor` was the only thing between a running instance and a config
 * edit: change `tableBase` while assignments are live and the next reconcile
 * looks for its tables somewhere else entirely.
 *
 * PPPoE pools used to stamp this too. Their layout is the router's own now -
 * a pool records its `table_base` and its zone in `/etc/config/bm_pppoe`.
 */
export interface ManagedLayout {
  tableBase: number
  rulePrefBase: number
  catchAllPrefBase: number
  catchAllTable: number
  zoneName: string
}

export const MANAGED_LAYOUT_KEYS = [
  'tableBase',
  'rulePrefBase',
  'catchAllPrefBase',
  'catchAllTable',
  'zoneName'
] as const satisfies ReadonlyArray<keyof ManagedLayout>

/** Copy exactly the five, so a record never carries a snapshot of every rule. */
export function managedLayout(rules: ManagedLayout): ManagedLayout {
  return {
    tableBase: rules.tableBase,
    rulePrefBase: rules.rulePrefBase,
    catchAllPrefBase: rules.catchAllPrefBase,
    catchAllTable: rules.catchAllTable,
    zoneName: rules.zoneName
  }
}

/**
 * The layout a record was created under.
 *
 * Records written by an earlier build carry no `layout` at all, so they fall
 * back to the rules in force - which is exactly what that build did on every
 * use, and is the only answer available for them.
 */
export function recordLayout(
  record: { layout?: ManagedLayout } | null | undefined,
  live: ManagedLayout
): ManagedLayout {
  return record?.layout ?? managedLayout(live)
}

/** What a job can still be once it is no longer running. */
export type StoredJobState = 'done' | 'failed' | 'partial' | 'cancelled'
export type StoredJobItemState = 'ok' | 'warning' | 'error' | 'skipped' | 'cancelled'

export interface StoredJobItem {
  idx: number
  name: string
  status: StoredJobItemState
  message?: string
  /** App-clock time the step began; absent if it never started. */
  startedAt?: number
  ms?: number
}

export interface FinishedJob {
  id: string
  kind: string
  label: string
  state: StoredJobState
  startedAt: number
  finishedAt: number
  total: number
  done: number
  failed: number
  progressPct: number
  items: StoredJobItem[]
}

/** Ten jobs of thirty steps keeps history far inside the 512 KiB host-data budget. */
export const MAX_FINISHED_JOBS = 10
export const MAX_FINISHED_JOB_ITEMS = 30

function cloneItem(item: StoredJobItem): StoredJobItem {
  return {
    idx: item.idx,
    name: item.name,
    status: item.status,
    ...(item.message ? { message: item.message } : {}),
    ...(typeof item.startedAt === 'number' ? { startedAt: item.startedAt } : {}),
    ...(typeof item.ms === 'number' ? { ms: item.ms } : {})
  }
}

/** Ranked so trimming keeps what a user opens the history to find. */
function keepRank(status: StoredJobItem['status']): number {
  if (status === 'error' || status === 'cancelled') return 0
  return status === 'warning' ? 1 : 2
}

/**
 * Keep failures/warnings/cancellations first when trimming, then restore
 * display order. This also makes histories written by an older, less tightly
 * capped build safe to expose through the latest stream.
 *
 * `maxItems` lets the store tighten the cap when a write was refused; it is the
 * only caller that passes one, and it still gets the failures rather than the
 * first eight steps of a job that failed on the sixtieth.
 */
export function trimFinishedJob(job: FinishedJob, maxItems = MAX_FINISHED_JOB_ITEMS): FinishedJob {
  const cap = Math.max(1, Math.trunc(maxItems))
  const items = Array.isArray(job.items) ? job.items : []
  const selected =
    items.length <= cap
      ? items
      : [...items].sort((a, b) => keepRank(a.status) - keepRank(b.status)).slice(0, cap)
  return {
    ...job,
    items: selected.map(cloneItem).sort((a, b) => a.idx - b.idx)
  }
}

/**
 * The top of the `ip rule` preference range this module claims. Every binding
 * instance takes one catch-all preference from `catchAllPrefBase` upwards, the
 * collector filters the router's rule table at the same number, and nothing
 * above it is ever read or touched.
 *
 * It lives here because it was two constants in two folders - `binding/rules`
 * called it `MANAGED_PREF_CEILING` and `service/command` called it
 * `RULE_FILTER_END` - and raising one without the other would have made the
 * collector hide rules the binding engine still claims.
 */
export const MANAGED_PREF_CEILING = 30_000

/**
 * How wide the `ip rule` preference band a one-to-one binding draws from is.
 *
 * The band starts at `directPrefBase` and is required to end before every
 * instance's `rulePrefBase`. Both halves of that follow from the same kernel
 * rule - the lowest preference wins. Below the instance band, a hand-placed
 * binding beats the assignment an instance would hand the same address, which
 * is the whole point of naming an address by hand; and because
 * `readActualAssignments` and the free-preference loop in the planner both
 * start counting at `rulePrefBase`, a rule down here is invisible to the
 * instance planner rather than something it can adopt as its own and then
 * delete on the next tick for having no lease behind it.
 */
export const DIRECT_PREF_SPAN = 1_000

/**
 * How many binding instances, and how many one-to-one bindings, a per-router
 * document will hold.
 *
 * The number is about the 512 KB host-data budget rather than about routers.
 * The document is written whole, `fitHostData` may only spend the expendable
 * rings to make a refused write fit, and a topology record is deliberately
 * never one of those - so both arrays have to be bounded well inside the
 * budget or the flush simply starts failing and nothing created afterwards
 * survives a restart. Both arrays full come to roughly 370 KB of it, which
 * still leaves the sticky floor, the two event rings and the job history
 * somewhere to live; a thousand one-to-one records alone would take 360 KB and
 * leave the instances nowhere at all.
 *
 * It lives out here because the reader in `store/schema` and the create gate in
 * `direct/check` are the two places that have to agree on it, in two folders,
 * and they did not agree. The reader stopped at 512 records and dropped the
 * rest; the gate refused only once every preference in the thousand-wide band
 * was claimed. Bindings past the ceiling were therefore creatable, and vanished
 * from the module on the next read of the document while their `ip rule`, their
 * `bmd<slot>_` firewall sections and their `ip4table` claim stayed on the
 * router with nothing left that could name them, let alone remove them.
 */
export const MAX_STORED_BINDINGS = 512
