/**
 * Two structural rules for the main half, checked in CI.
 *
 * 1. No file over `FAIL_LINES`. The module was one 3,500-line file and two
 *    1,700-line ones; every bug fix in them started with a hunt. The point of
 *    the split is that it stays split, and nothing enforces that except a
 *    number that fails a build.
 * 2. Every cross-folder import targets a folder's barrel, never a file inside
 *    it. That is what lets a folder be rearranged without touching a single
 *    call site - which is exactly how the split was performed - and it is the
 *    only thing keeping the layering honest, since the app's own scope guard
 *    (`npm run compile`) only checks that the module stays inside itself.
 *
 * The allowlist below must be empty when this merges. It exists so a step can
 * be landed with one known exception named out loud rather than silently.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = join(ROOT, 'openwrt', 'main')

const WARN_LINES = 400
const FAIL_LINES = 600

/** Paths (repo-relative, forward slashes) allowed past FAIL_LINES. Keep empty. */
const OVERSIZE_ALLOWED = []
/** Deep imports allowed past the barrel rule. Keep empty. */
const DEEP_IMPORT_ALLOWED = []

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

const rel = (file) => relative(ROOT, file).split('\\').join('/')

/**
 * Every module specifier in a file, from `import`/`export ... from` and
 * `import(...)`. A regex rather than a parser on purpose: this runs before
 * `tsc`, so it has to work on a file that does not compile yet.
 */
function specifiers(source) {
  const out = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1])
  }
  return out
}

const files = walk(MAIN).sort()
const warnings = []
const failures = []

for (const file of files) {
  const path = rel(file)
  const source = readFileSync(file, 'utf8')

  if (source.includes('\r\n')) {
    failures.push(`${path}: contains CRLF; openwrt/ is hashed byte-for-byte and must stay LF`)
  }

  const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0)
  if (lines > FAIL_LINES && !OVERSIZE_ALLOWED.includes(path)) {
    failures.push(`${path}: ${lines} lines, over the ${FAIL_LINES}-line limit - split it by behaviour`)
  } else if (lines > WARN_LINES) {
    warnings.push(`${path}: ${lines} lines`)
  }

  // Which folder under main/ this file lives in, '' for a top-level file.
  const own = dirname(relative(MAIN, file).split('\\').join('/'))
  for (const spec of specifiers(source)) {
    if (!spec.startsWith('.')) continue
    const target = relative(MAIN, resolve(dirname(file), spec)).split('\\').join('/')
    const parts = target.split('/')
    // `../binding` is one segment: the barrel. `../binding/reconcile` is two,
    // and reaches past it. A file importing a sibling inside its own folder is
    // exactly what a folder is for, so only imports that cross one are checked.
    if (parts.length < 2) continue
    if (parts[0] === own) continue
    if (DEEP_IMPORT_ALLOWED.includes(`${path} -> ${spec}`)) continue
    failures.push(
      `${path}: imports "${spec}", reaching inside ${parts[0]}/ - import "${
        spec.split('/').slice(0, -1).join('/')
      }" and re-export it from that folder's index.ts instead`
    )
  }
}

for (const line of warnings) console.log(`warn  ${line} (over ${WARN_LINES})`)
if (failures.length) {
  for (const line of failures) console.error(`FAIL  ${line}`)
  console.error(`\n${failures.length} structural problem(s) in openwrt/main/.`)
  process.exit(1)
}
console.log(
  `ok    ${files.length} files in openwrt/main/, none over ${FAIL_LINES} lines, every cross-folder import via a barrel`
)
