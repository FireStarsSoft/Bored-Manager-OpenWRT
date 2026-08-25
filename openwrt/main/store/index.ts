/**
 * The per-router document: its shape, its size budget, and the cache in front
 * of it.
 *
 * This barrel is the only entrance. Importing `./store/host-store` from outside
 * this folder is what `scripts/check-size.mjs` refuses, so the surface the rest
 * of the module depends on is exactly the list below.
 */
export {
  MAX_MODULE_EVENTS,
  MODULE_EVENT_SCOPES,
  emptyData,
  isModuleEventScope,
  normalize,
  serializeHostData,
  serializedBytes,
  type BindingInstanceRecord,
  type ModuleEventScope,
  type OwrtHostData,
  type PersistedHostData
} from './schema'
export { PERSIST_TARGET_BYTES, fitHostData, newestSticky, trim } from './trim'
export { HostStore } from './host-store'
