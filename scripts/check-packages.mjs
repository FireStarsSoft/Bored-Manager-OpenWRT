/**
 * The router packages say one version, in three places, and every file a
 * Makefile promises to install exists.
 *
 * `packages/version.json` is the source of truth. `PKG_VERSION` in each
 * Makefile is what apk records and what a release manifest quotes; `RELEASE` in
 * `bm/version.uc` is what the router answers when the module asks. A router
 * reporting one number while the release claims another is only ever discovered
 * at the worst possible moment - during an update, by a user - so the three are
 * held together here, the same way `release.yml` holds a tag to
 * `openwrt/module.json`.
 *
 * The install-list check is the other half. A Makefile that copies a file which
 * is not in the tree fails at build time with a path and nothing else; failing
 * here names the Makefile line instead, before an SDK is even fetched.
 *
 * Nothing in this script parses ucode. That is `packages.yml`, which builds a
 * host ucode and precompiles every `.uc` file against the stubs in
 * `packages/ci/stubs/` - a check this one deliberately does not try to imitate.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages')

const rel = (file) => relative(ROOT, file).split('\\').join('/')

const failures = []

if (!existsSync(PACKAGES)) {
  console.log('ok    no packages/ tree in this checkout, nothing to check')
  process.exit(0)
}

const version = JSON.parse(readFileSync(join(PACKAGES, 'version.json'), 'utf8'))
const RELEASE = version.release
if (!/^\d+\.\d+\.\d+$/.test(RELEASE ?? '')) {
  console.error(`FAIL  packages/version.json: "${RELEASE}" is not a three-part version`)
  process.exit(1)
}
if (!Number.isInteger(version.apiVersion) || version.apiVersion < 1) {
  failures.push('packages/version.json: apiVersion must be a positive integer')
}

/** Every folder under packages/ that has a Makefile is a package. */
const names = readdirSync(PACKAGES)
  .filter((entry) => statSync(join(PACKAGES, entry)).isDirectory())
  .filter((entry) => existsSync(join(PACKAGES, entry, 'Makefile')))
  .sort()

if (!names.length) failures.push('packages/: no package folder has a Makefile')

/**
 * The files a Makefile's install rules copy, as repo-relative paths.
 *
 * Only `./files/...` operands are read: `$(1)/...` is the destination inside
 * the staging root and does not exist here. A `*` is expanded by the shell at
 * build time, so a pattern is checked by asking whether it matches anything
 * rather than whether that literal path exists.
 *
 * A pattern the Makefile itself guards with `$(wildcard ...)` is exempt. That
 * is how a directory which is currently empty but has to exist on the router -
 * the migration chain at schema 1 - is installed without make expanding a glob
 * that matches nothing into a literal argument.
 */
function installedSources(makefile, dir) {
  const guarded = new Set(
    [...makefile.matchAll(/\$\(wildcard\s+(\.\/files\/[^\s)]+)\)/g)].map((match) => match[1])
  )
  const out = []
  for (const match of makefile.matchAll(/\.\/files\/[^\s)$\\]+/g)) {
    const spec = match[0]
    if (guarded.has(spec)) continue
    out.push({ spec, path: join(dir, spec.slice(2)) })
  }
  return out
}

function matchesSomething(pattern) {
  const star = pattern.indexOf('*')
  if (star < 0) return existsSync(pattern)
  // Everything up to the last separator *before* the star. dirname() of that
  // prefix drops one level too many whenever the star is the whole basename,
  // which is what every one of these patterns actually looks like.
  const dir = pattern.slice(0, Math.max(pattern.lastIndexOf('/', star), pattern.lastIndexOf(sep, star)))
  if (!existsSync(dir)) return false
  const suffix = pattern.slice(pattern.lastIndexOf('*') + 1)
  return readdirSync(dir).some((entry) => entry.endsWith(suffix))
}

for (const name of names) {
  const dir = join(PACKAGES, name)
  const makefilePath = join(dir, 'Makefile')
  const makefile = readFileSync(makefilePath, 'utf8')

  const declared = makefile.match(/^PKG_VERSION:=(.+)$/m)?.[1]?.trim()
  if (declared !== RELEASE) {
    failures.push(
      `${rel(makefilePath)}: PKG_VERSION is ${declared ?? 'missing'}, but packages/version.json says ${RELEASE}`
    )
  }

  const pkgName = makefile.match(/^PKG_NAME:=(.+)$/m)?.[1]?.trim()
  if (pkgName !== name) {
    failures.push(
      `${rel(makefilePath)}: PKG_NAME is ${pkgName ?? 'missing'}, but the folder is called ${name} - the SDK builds by folder`
    )
  }

  // PKGARCH:=all is what makes one .apk per package rather than one per
  // target. Everything here is ucode or plain JavaScript, so anything else is a
  // mistake. A LuCI app says it as LUCI_PKGARCH, which is the same statement in
  // luci.mk's vocabulary - it is what luci.mk puts into PKGARCH.
  if (!/^\s*(?:LUCI_)?PKGARCH:=all\s*$/m.test(makefile)) {
    failures.push(
      `${rel(makefilePath)}: no PKGARCH:=all - nothing here is compiled, so one archive has to serve every target`
    )
  }

  // Taking back what it put on the router is the package's job, not the
  // module's: `apk del` at a router shell has to leave the same router behind
  // as pressing Uninstall in the app.
  if (!makefile.includes(`define Package/${name}/prerm`)) {
    failures.push(
      `${rel(makefilePath)}: no prerm - a package that cannot remove what it installed leaves the router half-configured with nothing to explain it`
    )
  }

  for (const { spec, path } of installedSources(makefile, dir)) {
    if (!matchesSomething(path)) {
      failures.push(`${rel(makefilePath)}: installs "${spec}", which matches no file in the tree`)
    }
  }
}

/** The one place the router reads its own version back out. */
const versionUc = join(PACKAGES, 'bm-agent', 'files', 'usr', 'share', 'ucode', 'bm', 'version.uc')
if (!existsSync(versionUc)) {
  failures.push('packages/bm-agent/.../bm/version.uc is missing')
} else {
  const source = readFileSync(versionUc, 'utf8')
  const declared = source.match(/export const RELEASE = '([^']+)'/)?.[1]
  if (declared !== RELEASE) {
    failures.push(
      `${rel(versionUc)}: RELEASE is ${declared ?? 'missing'}, but packages/version.json says ${RELEASE}`
    )
  }
  const api = source.match(/export const API_VERSION = (\d+)/)?.[1]
  if (Number(api) !== version.apiVersion) {
    failures.push(
      `${rel(versionUc)}: API_VERSION is ${api ?? 'missing'}, but packages/version.json says ${version.apiVersion}`
    )
  }
  // The number a downgrade is refused on, and the number the migration chain
  // counts up to. A manifest that quotes one value while the router refuses on
  // another is an update that stops half way with nothing to explain it.
  const schema = source.match(/export const CONFIG_SCHEMA = (\d+)/)?.[1]
  if (Number(schema) !== version.configSchema) {
    failures.push(
      `${rel(versionUc)}: CONFIG_SCHEMA is ${schema ?? 'missing'}, but packages/version.json says ${version.configSchema}`
    )
  }
}

/**
 * Every other place a version is written down agrees with it too.
 *
 * A package that carries its own `RELEASE`, and the feature descriptor it drops
 * into `/usr/share/bm/features/` for the agent to read, are both quoted back to
 * the module. Three numbers that can disagree is three chances for a router to
 * report one version while the release manifest claims another, which is the
 * sort of thing only ever discovered during an update, by a user.
 */
for (const name of names) {
  for (const file of walk(join(PACKAGES, name)).filter((one) => one.endsWith('.uc'))) {
    const declared = readFileSync(file, 'utf8').match(/export const RELEASE = '([^']*)'/)?.[1]
    if (declared !== undefined && declared !== RELEASE) {
      failures.push(`${rel(file)}: RELEASE is '${declared}', but packages/version.json says ${RELEASE}`)
    }
  }

  // `files/` for a plain package, `root/` for a LuCI one - luci.mk copies the
  // second onto the router. Both are checked, because a descriptor skipped for
  // living under the other name is a version nobody compares.
  const features = ['files', 'root']
    .map((prefix) => join(PACKAGES, name, prefix, 'usr', 'share', 'bm', 'features'))
    .find((dir) => existsSync(dir))
  if (!features) continue
  for (const entry of readdirSync(features).filter((one) => one.endsWith('.json'))) {
    const file = join(features, entry)
    let descriptor
    try {
      descriptor = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      failures.push(`${rel(file)}: is not valid JSON, so the agent would skip it silently`)
      continue
    }
    if (descriptor.name !== name) {
      failures.push(`${rel(file)}: names "${descriptor.name}", but it ships in ${name}`)
    }
    if (descriptor.version !== RELEASE) {
      failures.push(
        `${rel(file)}: version is ${JSON.stringify(descriptor.version)}, but packages/version.json says ${RELEASE}`
      )
    }
    if (!Array.isArray(descriptor.provides) || !descriptor.provides.length) {
      failures.push(`${rel(file)}: declares no capability, so installing it would tell the module nothing`)
    }
  }
}

/**
 * A LuCI app's translations are versioned by the release, not by the clock.
 *
 * luci.mk builds one `luci-i18n-<basename>-<lang>` archive per directory under
 * po/, and versions them with PKG_PO_VERSION - which it derives from the last
 * commit that touched po/, or from file timestamps in a checkout with no git
 * history. Either way it is a number that changes on its own, and the release
 * manifest quotes one version per package. Pinning it to PKG_VERSION is what
 * lets `pack-bundle.mjs` say what is in the bundle.
 */
for (const name of names) {
  const dir = join(PACKAGES, name)
  if (!existsSync(join(dir, 'po'))) continue

  const makefile = readFileSync(join(dir, 'Makefile'), 'utf8')
  if (!/^PKG_PO_VERSION:=\$\(PKG_VERSION\)\s*$/m.test(makefile)) {
    failures.push(
      `${rel(join(dir, 'Makefile'))}: ships po/ but does not set PKG_PO_VERSION:=$(PKG_VERSION) - luci.mk would version the translation archives from the clock`
    )
  }

  // Every language has to be removable. The module takes a package off the
  // router by name, so a language nobody named is a package `apk del` leaves
  // behind - and it depends on the app, so the app cannot come off either.
  const uninstall = readFileSync(join(ROOT, 'openwrt', 'main', 'agent', 'uninstall.ts'), 'utf8')
  const basename = name.replace(/^luci-[a-z]+-/, '')
  for (const lang of readdirSync(join(dir, 'po')).filter((one) => one !== 'templates')) {
    const archive = `luci-i18n-${basename}-${lang.split('_')[0].toLowerCase()}`
    if (!uninstall.includes(archive)) {
      failures.push(
        `openwrt/main/agent/uninstall.ts: does not name ${archive}, which ${name} builds from po/${lang} - it would be left on the router`
      )
    }
  }
}

/**
 * A package that imports another package's ucode has to depend on it.
 *
 * `bm.state` resolving to a file in bm-agent is not the same as bm-agent being
 * on the router. apk would happily install a package whose modules are not
 * there, and the failure is a service that will not start with a compile error
 * in syslog.
 */
const providerOf = new Map()
for (const name of names) {
  const base = join(PACKAGES, name, 'files', 'usr', 'share', 'ucode')
  if (!existsSync(base)) continue
  for (const file of walk(base)) {
    if (file.endsWith('.uc')) providerOf.set(relative(base, file).split(sep).join('/'), name)
  }
}
for (const name of names) {
  const makefile = readFileSync(join(PACKAGES, name, 'Makefile'), 'utf8')
  const depends = new Set([...makefile.matchAll(/\+([a-z0-9-]+)/g)].map((match) => match[1]))

  for (const file of walk(join(PACKAGES, name)).filter((one) => one.endsWith('.uc'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const owner = providerOf.get(`${match[1].split('.').join('/')}.uc`)
      if (owner && owner !== name && !depends.has(owner)) {
        failures.push(
          `${rel(file)}: imports '${match[1]}' from ${owner}, but ${name}'s Makefile does not DEPEND on +${owner}`
        )
      }
    }
  }
}

/**
 * Every migration moves exactly one schema step, and the chain from 1 to the
 * current schema has no hole in it. The agent checks this too, on the router,
 * at the worst possible moment; checking it here means a release that cannot
 * bring a router forward never gets built.
 */
const migrations = join(PACKAGES, 'bm-agent', 'files', 'usr', 'share', 'bm', 'migrations')
const steps = new Map()
if (existsSync(migrations)) {
  for (const file of readdirSync(migrations).filter((entry) => entry.endsWith('.uc'))) {
    const source = readFileSync(join(migrations, file), 'utf8')
    const from = Number(source.match(/\bfrom:\s*(\d+)/)?.[1])
    const to = Number(source.match(/\bto:\s*(\d+)/)?.[1])
    if (!Number.isInteger(from) || to !== from + 1) {
      failures.push(
        `packages/.../migrations/${file}: does not declare { from: n, to: n + 1 } - a step that jumps cannot be resumed after a power cut`
      )
      continue
    }
    if (steps.has(from)) {
      failures.push(`packages/.../migrations/${file}: a second migration also starts at schema ${from}`)
    }
    steps.set(from, file)
  }
}
for (let at = 1; at < version.configSchema; at++) {
  if (!steps.has(at)) {
    failures.push(
      `packages/.../migrations/: nothing moves schema ${at} to ${at + 1}, so a router at ${at} could never reach ${version.configSchema}`
    )
  }
}

/** Everything here ends up on a router, where CRLF is a syntax error waiting. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}
for (const file of walk(PACKAGES)) {
  if (readFileSync(file, 'utf8').includes('\r\n')) {
    failures.push(`${rel(file)}: contains CRLF - a router shell reads that as part of the line`)
  }
}

/**
 * The JavaScript that is not ucode.
 *
 * ucode reads like JavaScript, which is exactly the problem: the things it does
 * not have are things fingers type without thinking, and every one of them is a
 * syntax error or a silent null on the router rather than here. `120_000` cost
 * an afternoon - ucode's lexer ends a number at the first non-digit, so that is
 * `120` followed by a label, and the whole module fails to compile.
 *
 * This is a word search, not a parser; `packages.yml` precompiles every file
 * with a real ucode and is the authority. What this buys is the answer arriving
 * on the machine the code was typed on, with the line in it, instead of in a CI
 * log twenty minutes later.
 *
 * Each entry is checked against the pinned ucode: the keyword list in
 * `lexer.c` (no `throw`, `new`, `class`, `typeof`, `finally`, `var`, `do`) and
 * the standard library in `lib.c` (`length(x)` and `push(a, v)` are functions,
 * not methods, and there is no `JSON`, `Math`, `Object`, `Array` or `Date`).
 */
const NOT_UCODE = [
  [/[0-9]_[0-9]/, 'digit separators - ucode ends a number at the first non-digit, so 120_000 is 120 followed by a label'],
  [/\bthrow\b/, '`throw` - ucode raises with die()'],
  [/\bnew\s+[A-Z]/, '`new` - ucode has no constructors'],
  [/\bclass\b/, '`class` - ucode has no classes'],
  [/\btypeof\b/, '`typeof` - ucode asks type()'],
  [/\binstanceof\b/, '`instanceof` - ucode has no prototype chain to ask about'],
  [/(^|[^.\w])var\s+\w/, '`var` - ucode declares with let and const'],
  [/\bfinally\b/, '`finally` - ucode try/catch has no finally clause'],
  [/\basync\b|\bawait\b/, 'async/await - ucode is synchronous'],
  [/\bundefined\b/, '`undefined` - ucode has only null, and in strict mode this reads an undeclared global'],
  [/\bdo\s*\{/, '`do { } while` - ucode has while and for only'],
  [/\.length\b/, '.length - ucode asks length(x); the property reads null'],
  [/\.(push|pop|shift|unshift|map|filter|forEach|join|slice|splice|sort|indexOf|includes)\s*\(/, 'an array method - ucode has these as functions, e.g. push(arr, value)'],
  [/\b(JSON|Math|Object|Array|Number|String|Date|Promise)\s*\./, 'a JavaScript global object - ucode has none of them']
]
/**
 * `export function f() { ... }` is closed with `};`, never `}`.
 *
 * A plain `function f() {}` declaration needs no terminator; an `export` is a
 * statement and does. Leaving the semicolon off is a syntax error reported
 * against whatever line happens to come next - "Unexpected token, expecting
 * ';'" pointing at a comment - so the message never names the real cause.
 *
 * Every ucode module in the OpenWrt tree closes them `};`. Not one closes them
 * `}`, which is how the rule was found in the first place.
 */
for (const file of walk(PACKAGES).filter((one) => one.endsWith('.uc'))) {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith('export function ')) continue
    let depth = 0
    let end = index
    for (; end < lines.length; end++) {
      depth += (lines[end].match(/\{/g) ?? []).length - (lines[end].match(/\}/g) ?? []).length
      if (depth === 0 && end > index) break
    }
    if (lines[end] === '}') {
      failures.push(
        `${rel(file)}:${end + 1}: an exported function is closed with "}" - ucode needs "};", and without it the next statement is a syntax error`
      )
    }
    index = end
  }
}

for (const file of walk(PACKAGES)) {
  if (!file.endsWith('.uc')) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    // Comments are prose about the router and say `new` and `do` all the time.
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
    for (const [pattern, why] of NOT_UCODE) {
      if (pattern.test(code)) failures.push(`${rel(file)}:${index + 1}: ${why}`)
    }
  })
}

/**
 * A regex literal has to be one POSIX regcomp will take, and one musl will
 * read the same way glibc does.
 *
 * ucode does not implement regular expressions. It hands the pattern to
 * regcomp with REG_EXTENDED and keeps the compiled result, so what is legal in
 * a ucode regex is exactly what is legal in POSIX ERE - which has no `\x`
 * escape and no `\d`, `\w`, `\s` or `\b`.
 *
 * Two different failures, and both were found by running the code:
 *
 * `\x` is refused by regcomp outright. That happens when the constant is built,
 * which is when the module is *loaded*, so `const UNSAFE = /[\x00-\x1f\x7f]/`
 * is a clean compile and a package that dies on the router with "Invalid
 * regular expression" before one line of it has run. It took the whole of
 * bm-pppoe-pool with it, and every module that imported it.
 *
 * `\d`, `\w`, `\s` and `\b` are worse, because they work. They are GNU
 * extensions: glibc accepts them, so a check on a developer machine or an
 * Ubuntu runner passes - and musl, which is what OpenWrt builds against, reads
 * `\w` as a literal `w`. The pattern compiles on the router and quietly matches
 * something else.
 *
 * `[[:cntrl:]]`, `[0-9]`, `[[:alpha:]]` and `[[:space:]]` are the spellings
 * that mean the same thing everywhere.
 */
const REGEX_ESCAPES = /\\([dDwWsSbBxX])/

/** Every regex literal in a ucode source, with the line it is on. */
function regexLiterals(source) {
  const found = []
  let line = 1
  let prev = ''

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]

    if (ch === '\n') { line++; prev = ''; continue }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      i--
      continue
    }

    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++
        i++
      }
      i++
      continue
    }

    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++
        if (source[i] === '\n') line++
        i++
      }
      prev = 'str'
      continue
    }

    if (ch === '/') {
      // A `/` after a value is division; after an operator, a `(` or a `,` it
      // opens a regex. `prev` is the last significant character before it.
      if (/[\w)\]]/.test(prev) || prev === 'str') { prev = '/'; continue }

      let body = ''
      let j = i + 1
      let closed = false
      let inClass = false

      for (; j < source.length && source[j] !== '\n'; j++) {
        if (source[j] === '\\') { body += source[j] + source[j + 1]; j++; continue }
        if (source[j] === '[') inClass = true
        else if (source[j] === ']') inClass = false
        else if (source[j] === '/' && !inClass) { closed = true; break }
        body += source[j]
      }

      if (closed) {
        found.push({ line, body })
        i = j
        prev = ')'
        continue
      }
    }

    if (!/\s/.test(ch)) prev = ch
  }

  return found
}

for (const file of walk(PACKAGES).filter((one) => one.endsWith('.uc'))) {
  for (const one of regexLiterals(readFileSync(file, 'utf8'))) {
    const hit = one.body.match(REGEX_ESCAPES)
    if (!hit) continue

    const why = /[xX]/.test(hit[1])
      ? `regcomp refuses it, and refuses it when the module is loaded rather than when it is compiled - use a POSIX class such as [[:cntrl:]]`
      : `a GNU extension: glibc takes it and musl, which is what the router runs, reads it as a literal "${hit[1]}" - use a POSIX class such as [0-9] or [[:space:]]`

    failures.push(`${rel(file)}:${one.line}: /${one.body}/ uses \\${hit[1]} - ${why}`)
  }
}

/**
 * Nothing is used above the line that declares it.
 *
 * ucode does not hoist. It resolves a name when it *compiles* the function that
 * mentions it, so a function whose body calls something declared further down
 * the same file compiles cleanly and then dies the first time that line runs:
 *
 *   Reference error: access to undeclared variable poolPut
 *
 * Which is why `packages.yml` cannot catch it - it compiles every file and this
 * compiles. Three of these were live at once, one of them in the commit-confirm
 * Undo path, where the cost of finding out is a router that did not come back.
 *
 * Verified against the pinned ucode rather than assumed: a module with
 * `function a() { return b(); }` above `function b() {}` raises on the first
 * call to a(), and the same is true of `const`. Declaring first always works,
 * so the rule is simply "callee above caller" and it is checked lexically.
 *
 * Strings and comments are blanked first, and an occurrence that is an object
 * key (`waiting:`) or a property (`st.waiting`) is not a read of the variable.
 */
function blankNonCode(source) {
  const out = source.split('')
  const n = source.length
  let i = 0
  let prev = ''

  const wipe = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '
  }

  while (i < n) {
    const c = source[i]
    const d = source[i + 1]

    if (c === '/' && d === '/') {
      let j = i
      while (j < n && source[j] !== '\n') j++
      wipe(i, j)
      i = j
      continue
    }
    if (c === '/' && d === '*') {
      let j = i + 2
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++
      wipe(i, Math.min(j + 2, n))
      i = j + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === c) break
        j++
      }
      wipe(i, Math.min(j + 1, n))
      i = j + 1
      prev = 'x'
      continue
    }
    // A `/` only starts a regex where a value could start.
    if (c === '/' && !/[)\]}\w$]/.test(prev)) {
      let j = i + 1
      let closed = false
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === '/') {
          closed = true
          break
        }
        j++
      }
      if (closed) {
        wipe(i, j + 1)
        i = j + 1
        prev = 'x'
        continue
      }
    }

    if (!/\s/.test(c)) prev = c
    i++
  }

  return out.join('')
}

for (const file of walk(PACKAGES).filter((one) => one.endsWith('.uc'))) {
  const lines = blankNonCode(readFileSync(file, 'utf8')).split('\n')

  /** name -> the line it becomes usable on; 0 for an import. */
  const declaredAt = new Map()
  const functions = []

  lines.forEach((line, index) => {
    const declaration = line.match(/^(?:export\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/)
    if (declaration) {
      if (!declaredAt.has(declaration[1])) declaredAt.set(declaration[1], index + 1)
      if (/^(?:export\s+)?function\s/.test(line)) {
        functions.push({ name: declaration[1], line: index + 1 })
      }
      return
    }
    const star = line.match(/^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/)
    if (star) declaredAt.set(star[1], 0)
    const named = line.match(/^import\s+\{(.+?)\}\s+from/)
    if (named) {
      for (const piece of named[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/).pop().trim()
        if (name) declaredAt.set(name, 0)
      }
    }
  })

  for (const fn of functions) {
    let depth = 0
    let opened = false
    let end = fn.line - 1
    for (; end < lines.length; end++) {
      if (lines[end].includes('{')) opened = true
      depth += (lines[end].match(/\{/g) ?? []).length - (lines[end].match(/\}/g) ?? []).length
      if (opened && depth === 0) break
    }

    const body = lines.slice(fn.line - 1, end + 1).join('\n')

    // Parameters and locals shadow a later top-level name, so they are not it.
    const bound = new Set()
    const signature = body.match(/^[^(]*\(([^)]*)\)/)
    if (signature) {
      for (const piece of signature[1].split(',')) {
        const name = piece.trim().split(/[=\s]/)[0]
        if (name) bound.add(name)
      }
    }
    for (const match of body.matchAll(/\b(?:let|const|for)\s*\(?\s*(?:let\s+)?([A-Za-z_$][\w$]*)/g)) {
      bound.add(match[1])
    }

    for (const [name, at] of declaredAt) {
      if (at <= fn.line || bound.has(name) || name === fn.name) continue

      const uses = new RegExp(`(^|[^.\\w$])${name}\\b(\\s*:)?`, 'g')
      let match
      while ((match = uses.exec(body)) !== null) {
        if (match[2]) continue // `name:` is an object key
        const offset = match.index + match[1].length
        const at1 = fn.line + body.slice(0, offset).split('\n').length - 1
        failures.push(
          `${rel(file)}:${at1}: ${fn.name}() uses "${name}", which is not declared until line ${at} - ucode does not hoist, so this raises the first time the line runs`
        )
        break
      }
    }
  }
}

/**
 * Every `import` resolves, names something the other file exports, and - for
 * ucode's own modules - is paid for in the Makefile.
 *
 * ucode resolves imports while compiling, so the first two are what `packages.
 * yml` catches when it precompiles the tree. This repeats them because the
 * third one it cannot catch at all: CI compiles against the empty stubs in
 * `packages/ci/stubs/`, so `import { ... } from 'rtnl'` succeeds there whether
 * or not `+ucode-mod-rtnl` is in DEPENDS. On a router it is the difference
 * between a service and a line in syslog.
 *
 * The module name maps to a path the same way ucode does it: dots become
 * slashes against `/usr/share/ucode/`, so `bm.snapshot` is
 * `.../ucode/bm/snapshot.uc`.
 */
const UCODE_MODULES = new Set([
  // package/utils/ucode/Makefile on openwrt-25.12: one ucode-mod-* per entry.
  'debug', 'digest', 'fs', 'io', 'log', 'math', 'nl80211', 'resolv',
  'rtnl', 'socket', 'struct', 'ubus', 'uci', 'uloop', 'zlib'
])

/** What one .uc file exports, by name. `export default` is not used here. */
function exportsOf(text) {
  const out = new Set()
  for (const m of text.matchAll(/^\s*export\s+(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    out.add(m[1])
  }
  return out
}

const ucodeDirs = names
  .map((name) => join(PACKAGES, name, 'files', 'usr', 'share', 'ucode'))
  .filter((dir) => existsSync(dir))

for (const name of names) {
  const dir = join(PACKAGES, name)
  const makefile = readFileSync(join(dir, 'Makefile'), 'utf8')
  const depends = new Set(
    [...makefile.matchAll(/\+ucode-mod-([a-z0-9]+)/g)].map((match) => match[1])
  )

  for (const file of walk(dir).filter((one) => one.endsWith('.uc'))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
      const [, what, from] = match

      if (UCODE_MODULES.has(from)) {
        if (!depends.has(from)) {
          failures.push(
            `${rel(file)}: imports '${from}' but ${name}'s Makefile does not DEPEND on +ucode-mod-${from} - CI compiles against a stub and would not notice`
          )
        }
        continue
      }

      // Anything else has to be a file in this repo, found the way ucode finds
      // it: dots to slashes, under some package's /usr/share/ucode.
      const suffix = join(...from.split('.')) + '.uc'
      const target = ucodeDirs.map((base) => join(base, suffix)).find((one) => existsSync(one))
      if (!target) {
        failures.push(`${rel(file)}: imports '${from}', which is no module in packages/ and no ucode module`)
        continue
      }

      // `* as ns` takes everything; a brace list has to name real exports.
      if (/^\*\s+as\s/.test(what)) continue
      const available = exportsOf(readFileSync(target, 'utf8'))
      const braces = what.match(/^\{(.*)\}$/s)
      if (!braces) continue
      for (const piece of braces[1].split(',')) {
        const wanted = piece.trim().split(/\s+as\s+/)[0].trim()
        if (wanted && !available.has(wanted)) {
          failures.push(`${rel(file)}: imports { ${wanted} } from '${from}', which does not export it`)
        }
      }
    }
  }
}

/**
 * The LuCI app's three files agree with each other and with the daemons.
 *
 * A LuCI view is loaded by a browser, from a router, by somebody who is
 * probably there because the app could not reach it - so the failures worth
 * catching here are the ones that are invisible until then. A menu entry
 * pointing at a view that does not exist is a blank page. A `require` naming a
 * class that is not there is a blank page. And an ACL granting a method the
 * daemon does not publish - or missing one a view calls - is a page that draws
 * and then refuses one button, with "Permission denied" in a console nobody has
 * open.
 *
 * The published methods are read from the ucode itself, so this cannot drift:
 * renaming a ubus method fails the build in the ACL rather than at a click.
 */
const LUCI_APPS = names.filter((name) => name.startsWith('luci-'))

/** What luci-base ships, as `require` names. Only what these views use. */
const LUCI_BASE_CLASSES = new Set([
  'baseclass', 'dom', 'form', 'fs', 'network', 'poll', 'request',
  'rpc', 'ui', 'uci', 'validation', 'view'
])

/** `export const methods = { name: method(...) }` in one daemon's service. */
function publishedMethods(file) {
  if (!existsSync(file)) return null
  const source = readFileSync(file, 'utf8')
  const block = source.slice(source.indexOf('export const methods = {'))
  return new Set([...block.matchAll(/^\t([A-Za-z_][\w]*):\s*method\(/gm)].map((m) => m[1]))
}

const PUBLISHED = {
  'bm.agent': publishedMethods(
    join(PACKAGES, 'bm-agent', 'files/usr/share/ucode/bm/agent.uc'.split('/').join(sep))
  ),
  'bm.wanbind': publishedMethods(
    join(PACKAGES, 'bm-wanbind', 'files/usr/share/ucode/bm/wanbind/service.uc'.split('/').join(sep))
  ),
  'bm.pppoe': publishedMethods(
    join(PACKAGES, 'bm-pppoe-pool', 'files/usr/share/ucode/bm/pppoe/service.uc'.split('/').join(sep))
  )
}

for (const name of LUCI_APPS) {
  const dir = join(PACKAGES, name)
  const resources = join(dir, 'htdocs', 'luci-static', 'resources')

  // 1. Every file parses. A view is wrapped in a function by luci.js before it
  //    is evaluated, which is what makes its top-level `return` legal - so it
  //    is wrapped the same way here rather than parsed as a module.
  const scripts = existsSync(resources) ? walk(resources).filter((one) => one.endsWith('.js')) : []
  for (const file of scripts) {
    try {
      new Function('window', 'document', 'L', 'E', '_', readFileSync(file, 'utf8'))
    } catch (error) {
      failures.push(`${rel(file)}: does not parse - ${error.message}`)
    }
  }

  // 2. Every `require` resolves: a luci-base class, or a file in this package.
  const provided = new Set(
    scripts.map((file) =>
      relative(resources, file).split(sep).join('.').replace(/\.js$/, '')
    )
  )
  for (const file of scripts) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^'require ([\w.]+)(?: as \w+)?';$/gm)) {
      const wanted = match[1]
      if (!LUCI_BASE_CLASSES.has(wanted) && !provided.has(wanted)) {
        failures.push(
          `${rel(file)}: requires '${wanted}', which is neither a luci-base class nor a file in ${name}`
        )
      }
    }
  }

  // 3. Every menu entry points at a view that exists, and declares the ACL.
  const menu = join(dir, 'root', 'usr', 'share', 'luci', 'menu.d', `${name}.json`)
  const acl = join(dir, 'root', 'usr', 'share', 'rpcd', 'acl.d', `${name}.json`)

  if (!existsSync(menu)) {
    failures.push(`${rel(dir)}: has no menu.d/${name}.json, so nothing would appear in LuCI`)
    continue
  }
  if (!existsSync(acl)) {
    failures.push(`${rel(dir)}: has no acl.d/${name}.json, so every call would be refused`)
    continue
  }

  const entries = JSON.parse(readFileSync(menu, 'utf8'))
  for (const [path, node] of Object.entries(entries)) {
    if (node.action?.type !== 'view') continue
    const view = join(resources, 'view', ...node.action.path.split('/')) + '.js'
    if (!existsSync(view)) {
      failures.push(`${rel(menu)}: "${path}" points at view/${node.action.path}, which is not in the tree`)
    }
  }

  // 4. The ACL names only methods the daemons publish, and every method the
  //    views call is in it.
  const grants = JSON.parse(readFileSync(acl, 'utf8'))[name] ?? {}
  const granted = new Map()
  for (const side of ['read', 'write']) {
    for (const [object, methods] of Object.entries(grants[side]?.ubus ?? {})) {
      if (!granted.has(object)) granted.set(object, new Set())
      for (const method of methods) granted.get(object).add(method)
    }
  }

  for (const [object, methods] of granted) {
    const published = PUBLISHED[object]
    if (!published) continue
    for (const method of methods) {
      if (!published.has(method)) {
        failures.push(
          `${rel(acl)}: grants ${object} ${method}, which that daemon does not publish`
        )
      }
    }
  }

  for (const file of scripts) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/declare\((AGENT|WANBIND|PPPOE),\s*'([\w]+)'/g)) {
      const object = { AGENT: 'bm.agent', WANBIND: 'bm.wanbind', PPPOE: 'bm.pppoe' }[match[1]]
      if (!granted.get(object)?.has(match[2])) {
        failures.push(
          `${rel(file)}: calls ${object} ${match[2]}, which ${name}'s ACL does not grant`
        )
      }
    }
  }
}

if (failures.length) {
  for (const line of failures) console.error(`FAIL  ${line}`)
  console.error(`\n${failures.length} problem(s) in packages/.`)
  process.exit(1)
}
console.log(
  `ok    ${names.length} router package(s) at ${RELEASE}, api ${version.apiVersion}: versions agree, every installed file present`
)
