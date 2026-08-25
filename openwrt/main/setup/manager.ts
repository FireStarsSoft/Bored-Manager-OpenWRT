/**
 * The object the module holds: one runtime, and a method per thing the settings
 * page can ask for.
 *
 * Nothing is decided here. `check` reads the gates in `plan.ts` and `apply`
 * starts the job in `install.ts`; both are handed the same runtime, which is
 * what keeps the token that one issued spendable by the other and by nothing
 * else.
 */
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { applySetup } from './install'
import { checkSetup } from './plan'
import { createSetupRuntime, resetRuntime, type SetupDeps, type SetupRuntime } from './runtime'

export class SetupManager {
  private runtime: SetupRuntime

  constructor(ctx: ModuleContext, deps: SetupDeps) {
    this.runtime = createSetupRuntime(ctx, deps)
  }

  check(raw: unknown): Promise<ModuleCheckReport> {
    return checkSetup(this.runtime, raw)
  }

  apply(raw: unknown): OkResult {
    return applySetup(this.runtime, raw)
  }

  /** A token describes a router; a different router must not be able to spend it. */
  reset(): void {
    resetRuntime(this.runtime)
  }

  dispose(): void {
    resetRuntime(this.runtime)
  }
}
