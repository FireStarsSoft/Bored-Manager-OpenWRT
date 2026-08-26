/**
 * The module's own settings: what they are, how they are read back, and the
 * check/apply adapter the settings forms drive.
 *
 * Three files behind one door - `rules.ts` is the document shape and its
 * validation, `store.ts` the cached reader/writer, `editor.ts` the form
 * adapter. Import this barrel, never a file inside it.
 */
export {
  DEFAULT_RULES,
  RULE_BOUNDS,
  type OwrtConfig,
  type OwrtRules,
  type ZoneMode
} from './rules'
export { ConfigStore } from './store'
export { RulesEditor, type RulesTopology } from './editor'
