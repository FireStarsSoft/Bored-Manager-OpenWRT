/**
 * Three lists that have to be one list, checked in CI.
 *
 * A method reaches this module by string: `openwrt/module.json` declares the
 * names the app will let a spec call, `runtime/handlers.ts` registers what
 * actually answers them, and `main/requirements.ts` says what each one needs
 * from the router before it may run. Nothing in TypeScript connects the three -
 * they are a JSON array, a set of string literals and an object literal - so
 * the only thing that can stop them drifting apart is a build step that reads
 * all three and refuses when they disagree.
 *
 * That is the point of the whole registry. Before it, requirements were two
 * hand-written `if` chains inside the two create handlers, and a method added
 * afterwards arrived with no gate at all and nothing anywhere to notice. Now a
 * method that is registered but not declared, declared but not registered, or
 * registered without an entry saying what it needs, fails `npm run check`.
 *
 * The allowlists below must be empty when this merges. They exist so a step can
 * be landed with one known exception named out loud rather than silently.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'openwrt', 'module.json')
const HANDLERS = join(ROOT, 'openwrt', 'main', 'runtime', 'handlers.ts')
const REQUIREMENTS = join(ROOT, 'openwrt', 'main', 'requirements.ts')

/** Method names allowed to be registered without a manifest entry. Keep empty. */
const UNDECLARED_ALLOWED = []
/** Method names allowed to be declared without an entry in FEATURES. Keep empty. */
const UNGATED_ALLOWED = []

const failures = []

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const declared = new Set(manifest.methods ?? [])

const handlerSource = readFileSync(HANDLERS, 'utf8')
const requirementSource = readFileSync(REQUIREMENTS, 'utf8')

/**
 * What `handlers.ts` registers.
 *
 * `handle('name', ...)` is the gated form and the only one that may appear;
 * `ctx.handle(` is matched separately so that going round the gate is itself
 * the failure, rather than showing up later as a method with no requirements.
 * A regex rather than the TypeScript AST on purpose: this has to work on a file
 * that does not compile yet, the same way `check-size.mjs` does.
 */
const registered = new Set()
for (const match of handlerSource.matchAll(/(?<![.\w])handle\(\s*'([A-Za-z0-9_]+)'/g)) {
  registered.add(match[1])
}

// The gate is a wrapper around exactly one `ctx.handle`, inside `handle` itself.
const direct = [...handlerSource.matchAll(/ctx\.handle\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1])
for (const name of direct) {
  failures.push(
    `handlers.ts registers "${name}" with ctx.handle directly, going around the requirements gate - use handle(...) so requirementRefusal() runs first`
  )
}

/**
 * The keys of the `FEATURES` object literal, read from its own block so that
 * key-like strings elsewhere in the file - the `REQUIREMENTS` table, a comment,
 * a refusal - cannot be mistaken for method entries.
 */
const featureBlock = requirementSource.match(
  /export const FEATURES: Record<string, FeatureSpec \| null> = \{([\s\S]*?)\n\}/
)
if (!featureBlock) {
  console.error('FAIL  requirements.ts: could not find the FEATURES object literal')
  process.exit(1)
}
const gated = new Set()
for (const match of featureBlock[1].matchAll(/^ {2}([A-Za-z0-9_]+):/gm)) gated.add(match[1])

for (const name of [...registered].sort()) {
  if (declared.has(name) || UNDECLARED_ALLOWED.includes(name)) continue
  failures.push(
    `handlers.ts registers "${name}", which openwrt/module.json does not declare - nothing can call it, so it is a dead handler`
  )
}

for (const name of [...declared].sort()) {
  if (!registered.has(name) && !UNDECLARED_ALLOWED.includes(name)) {
    failures.push(
      `openwrt/module.json declares "${name}", which handlers.ts does not register - a spec calling it gets an unknown-method error`
    )
  }
  if (!gated.has(name) && !UNGATED_ALLOWED.includes(name)) {
    failures.push(
      `"${name}" has no entry in FEATURES - add one to openwrt/main/requirements.ts saying what it needs from the router, or \`null\` if it only reads`
    )
  }
}

for (const name of [...gated].sort()) {
  if (declared.has(name) || UNGATED_ALLOWED.includes(name)) continue
  failures.push(
    `FEATURES has an entry for "${name}", which is not a method openwrt/module.json declares - the two lists have drifted`
  )
}

/**
 * Every `RequirementKey` a feature names has to exist in the union that types
 * them. TypeScript catches this too, but only for a literal written inline; a
 * key held in one of the shared arrays at the top of the file is worth checking
 * against the source of truth rather than against a second copy of it.
 */
const keyUnion = requirementSource.match(
  /export type RequirementKey =([\s\S]*?)\n\n/
)
const knownKeys = new Set(
  keyUnion ? [...keyUnion[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]) : []
)
for (const match of featureBlock[1].matchAll(/requires: \[([^\]]*)\]/g)) {
  for (const key of [...match[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1])) {
    if (!knownKeys.has(key)) {
      failures.push(`FEATURES names requirement "${key}", which RequirementKey does not define`)
    }
  }
}

if (failures.length) {
  for (const line of failures) console.error(`FAIL  ${line}`)
  console.error(`\n${failures.length} requirement problem(s).`)
  process.exit(1)
}
console.log(
  `ok    ${declared.size} methods: every one declared, registered through the gate, and carrying a requirements entry`
)
