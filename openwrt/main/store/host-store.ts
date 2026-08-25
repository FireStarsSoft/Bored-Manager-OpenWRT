/**
 * The per-router document, cached in memory and written on a delay.
 *
 * This is the only file that talks to `ctx.hostDataGet` / `ctx.hostDataSet`.
 * Reading the shape is `schema.ts`; deciding what to sacrifice when a write is
 * refused is `trim.ts`.
 */
import type { ModuleContext } from '@shared/modules'
import type { OwrtRules } from '../config'
import { normalize, serializeHostData, type OwrtHostData } from './schema'
import { fitHostData, trim } from './trim'

const PERSIST_DEBOUNCE_MS = 10_000

/**
 * How many times a write may be deferred because the context is pointed at
 * another machine. A minute of retries covers a reconnect or one pass over a
 * pool; past that the change stays in memory until something writes again,
 * rather than leaving a timer ticking for the life of the process.
 */
const MAX_HOST_DEFERRALS = 6

/**
 * Cached per-router data with delayed writes. Reconcile may touch sticky
 * timestamps every fast tick; this store writes at most once per ten seconds.
 */
export class HostStore {
  private cache: OwrtHostData | null = null
  private cachedFor: string | null = null
  private rev = 0
  private dirty = false
  private deferrals = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private firewallChain: Promise<void> = Promise.resolve()
  private networkChain: Promise<void> = Promise.resolve()

  constructor(
    private ctx: ModuleContext,
    private rules: () => OwrtRules
  ) {}

  /**
   * A counter that moves whenever this document might have changed: any
   * mutation, and any point where the cache is replaced by another machine's.
   * Read by the caches in front of the row builders, which rebuild thousands of
   * rows out of it and otherwise have no way to tell a document that changed
   * from one that was mutated in place - `read()` hands back the same object
   * either way.
   */
  revision(): number {
    return this.rev
  }

  read(): OwrtHostData {
    const host = this.ctx.hostKey
    if (this.cache && this.cachedFor === host) return this.cache
    this.rev += 1
    // Write out whatever is still pending before the document it belongs to is
    // replaced. `flush()` only writes while `cachedFor` still matches the
    // context, so this is its last chance; the `cancelTimer()` that used to
    // stand here threw the scheduled write away without a word, and a switch
    // between two machines in a pool lost every event and every sticky
    // assignment made in the ten seconds before it.
    this.flush()
    this.cancelTimer()
    this.cache = normalize(this.ctx.hostDataGet())
    trim(this.cache, this.rules())
    this.cachedFor = host
    this.dirty = false
    return this.cache
  }

  update<T>(mutate: (data: OwrtHostData) => T): T {
    const data = this.read()
    const result = mutate(data)
    trim(data, this.rules())
    this.rev += 1
    this.dirty = true
    this.schedule()
    return result
  }

  /**
   * A topology write: a batch or a binding instance being created or deleted.
   *
   * These do not wait out the debounce. Ten seconds of history is a nuisance to
   * lose; ten seconds covering the record of a pool that now exists on the
   * router is the router's identity - the app comes back knowing nothing about
   * five thousand live PPPoE sections, and nothing in the module can find them
   * again.
   */
  updateNow<T>(mutate: (data: OwrtHostData) => T): T {
    const result = this.update(mutate)
    this.flush()
    return result
  }

  /**
   * Serialize writes to `/etc/config/network` across PPPoE and binding jobs.
   *
   * `uci` has no locking of its own: two `uci batch` runs that commit the same
   * config read it, apply their own changes, and write the whole file back, so
   * the one that finishes second silently discards everything the first wrote.
   * A binding preparation setting `ip4table` on a WAN while a PPPoE create is
   * committing a chunk is exactly that race, and it loses a hundred sections
   * with no error anywhere.
   *
   * Firewall writes get their own chain rather than sharing this one: they touch
   * a different file, and a pool create deliberately runs its zone preparation
   * while its chunks are still going.
   */
  async withNetwork<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.networkChain.then(run, run)
    this.networkChain = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  /** Serialize shared firewall rebuilds across PPPoE and binding jobs. */
  async withFirewall<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.firewallChain.then(run, run)
    this.firewallChain = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  /**
   * Flush now, retrying with the expendable rings cut down if the 512 KB cap
   * was reached. Core topology records are never dropped to make a write fit.
   */
  flush(): void {
    this.cancelTimer()
    if (!this.cache || !this.dirty) return
    if (this.cachedFor !== this.ctx.hostKey) {
      // `hostDataSet` writes to whatever the context points at now, so this
      // document cannot be written here without filing one router's records
      // under another. Keep it scheduled instead: the context moving away is
      // routinely temporary - a reconnect, or a pass over the pool - and
      // cancelling the timer above was what turned a pending write into a
      // permanent loss even when the same machine came back a second later.
      if (this.deferrals < MAX_HOST_DEFERRALS) {
        this.deferrals += 1
        this.schedule()
      }
      return
    }
    this.deferrals = 0
    const data = this.cache
    trim(data, this.rules())
    try {
      // Write exactly what `serializedBytes` measures. They used to disagree:
      // the budget was worked out against the compact form while the raw
      // object went to disk, so a document the estimate thought fit could be
      // half as large again as the 512 KB cap - and past roughly five
      // thousand sticky entries every flush failed, dirty stayed set, and
      // nothing created afterwards survived a restart.
      this.ctx.hostDataSet(serializeHostData(data))
      this.dirty = false
      return
    } catch (error) {
      this.ctx.log(
        `openwrt: host data did not fit; trimming history (${error instanceof Error ? error.message : String(error)})`
      )
    }

    fitHostData(data, this.rules())
    try {
      this.ctx.hostDataSet(serializeHostData(data))
      this.dirty = false
    } catch (error) {
      // Keep the in-memory state. A later mutation schedules another attempt.
      this.ctx.log(
        `openwrt: host data could not be saved (${error instanceof Error ? error.message : String(error)})`
      )
    }
  }

  reset(): void {
    this.flush()
    this.cancelTimer()
    this.cache = null
    this.cachedFor = null
    this.rev += 1
    this.dirty = false
    this.deferrals = 0
  }

  dispose(): void {
    this.flush()
    this.cancelTimer()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, PERSIST_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
