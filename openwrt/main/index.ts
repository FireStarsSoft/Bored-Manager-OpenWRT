/**
 * The module entry point the app loads.
 *
 * Everything it does is in `runtime/`: build the object graph, register the
 * method names the renderer calls, and hand back the six lifecycle hooks the
 * host drives the module through. Keeping this file to that shape is what makes
 * the hooks readable as a set - each one is a sentence about when it runs,
 * rather than the tail of a four-hundred-line function.
 */
import type { ModuleActivate, ModuleContext } from '@shared/modules'
import {
  INTERVAL_KEY,
  createRuntime,
  disposeRuntime,
  emitUi,
  refreshCapabilities,
  registerHandlers,
  resetRuntime,
  snapshots,
  startPollers
} from './runtime'

const activate: ModuleActivate = (ctx: ModuleContext) => {
  const runtime = createRuntime(ctx)
  registerHandlers(runtime)
  emitUi(runtime)

  return {
    applyPollers() {
      startPollers(runtime.latch)
    },

    reset() {
      resetRuntime(runtime)
    },

    snapshots() {
      return snapshots(runtime)
    },

    slowTargets() {
      return [INTERVAL_KEY]
    },

    async refreshSlow() {
      if (!ctx.connected) return
      const available = await refreshCapabilities(runtime.latch)
      if (!available.problem) await runtime.service.runSlow()
    },

    dispose() {
      disposeRuntime(runtime)
    }
  }
}

export default activate
