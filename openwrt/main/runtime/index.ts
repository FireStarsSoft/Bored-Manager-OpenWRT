/**
 * The wiring layer: the only folder that is allowed to know every domain
 * exists.
 *
 * `container.ts` builds them and writes the dependency objects they meet
 * through, `readiness.ts` owns the capability verdict and the poller latch that
 * decides when anything runs at all, and `handlers.ts` is the list of method
 * names the renderer calls. Nothing under `probe/`, `setup/`, `pppoe/`,
 * `binding/` or `service/` may import this folder back. Import this barrel,
 * never a file inside it.
 */
export {
  createRuntime,
  disposeRuntime,
  emitUi,
  resetRuntime,
  snapshots,
  type OpenWrtRuntime
} from './container'
export { registerHandlers } from './handlers'
export {
  INTERVAL_KEY,
  refreshCapabilities,
  startPollers,
  type CapabilityLatch
} from './readiness'
