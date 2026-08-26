/**
 * The cached reader/writer for the module's own settings document.
 *
 * Config is shared by every router instance, so what is held here is only ever
 * a copy that is dropped the moment anything writes - see the comment on the
 * class itself.
 */
import type { ModuleContext } from '@shared/modules'
import { DEFAULT_RULES, normalize, type OwrtConfig, type OwrtRules } from './rules'

/**
 * Config is shared by all router instances, so the normalised document is kept
 * only until something writes it: `onConfigChange` fires for every instance of
 * the module, this one included, so a toggle made on another router drops this
 * copy instead of being overwritten by it. Without the cache, `effectiveRules()`
 * re-read and re-validated the file on every call - many times per fast tick,
 * since every batch, every rule number and every table poll asks for it.
 */
export class ConfigStore {
  private cache: OwrtConfig | null = null
  private rules: OwrtRules | null = null
  private readonly unsubscribe: () => void

  constructor(private ctx: ModuleContext) {
    this.unsubscribe = ctx.onConfigChange(() => {
      this.cache = null
      this.rules = null
    })
  }

  read(): OwrtConfig {
    return (this.cache ??= normalize(this.ctx.configGet()))
  }

  effectiveRules(): OwrtRules {
    return (this.rules ??= { ...DEFAULT_RULES, ...this.read().rules })
  }

  update<T>(mutate: (config: OwrtConfig) => T): T {
    const config = this.read()
    const result = mutate(config)
    const written = normalize(config)
    this.ctx.configSet(written)
    // The listener above has just cleared both; what was written is what the
    // next read should see.
    this.cache = written
    this.rules = null
    return result
  }

  setRules(rules: Partial<OwrtRules>): void {
    this.update((config) => {
      config.rules = rules
    })
  }

  /**
   * Set the flag outright. A checkbox already knows which state it wants, and
   * the toggle this replaced turned that into "whatever the opposite of the
   * server's copy is" - the wrong answer whenever the page was opened before
   * another surface changed it.
   */
  setHints(on: boolean): boolean {
    return this.update((config) => {
      config.ui.showHints = on
      return config.ui.showHints
    })
  }

  reset(): void {
    this.cache = null
    this.rules = null
  }

  /** Stop listening. The context drops the listener on revoke anyway; this is for a tidy dispose. */
  dispose(): void {
    this.unsubscribe()
    this.reset()
  }
}
