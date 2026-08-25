#!/usr/bin/env node
/**
 * Pack the built `.apk` files into one file a person can hand to a router.
 *
 * Usage:
 *   node scripts/pack-bundle.mjs <dir-of-apk-files> [output-dir]
 *
 * It writes three things into the output directory (`dist/` by default):
 *
 *   bm-packages.json                the release manifest, which is also what a
 *                                   router fetches when somebody asks it to
 *                                   check for an update
 *   bm-packages-<release>.apkbundle the same manifest and every .apk, as one
 *                                   base64 text file
 *   ...apkbundle.sha256             so a download can be held against something
 *
 * ## Why base64, and why one file
 *
 * The module can install these from the machine running the app, with no
 * GitHub release and no internet on the router at all - which is the whole
 * point of the bundle, and the thing the router-side updater cannot do. That
 * install path goes through a form, and the app's `file` input hands a module
 * the file's **text**: `FormField.accept` exists, `maxKb` exists, and
 * `pppoe/plan.ts` receives its uploaded account list as a `string`. Whether a
 * binary file survives that trip intact is not something to find out by
 * shipping it, so the bundle is text by construction. It also means somebody
 * can paste it into the box beside the file picker, which makes the path work
 * even where a browser will not cooperate.
 *
 * The tar inside is written here rather than shelled out to, for the same
 * reason `package-module.mjs` writes its own zip: a fixed mtime and fixed
 * ownership make the output byte-reproducible, so the same inputs always
 * produce the same sha256 and that hash is a property of the source rather than
 * of the machine that ran the build.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages')

/** The same fixed timestamp `package-module.mjs` uses, for the same reason. */
const FIXED_MTIME = 946_684_800 // 2000-01-01T00:00:00Z

/**
 * The app's `file` input defaults to a 1 MiB cap and the form asks for 2 MiB.
 * Four ucode packages base64-encode to a couple of hundred kilobytes, so
 * passing this is a sign something unexpected got in - a stray `.apk` for
 * another project, a kmod that should not be here.
 */
const BUNDLE_WARN_KB = 2_048

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

const [dirArg, outArg] = process.argv.slice(2)
if (!dirArg) {
  fail('usage: node scripts/pack-bundle.mjs <dir-of-apk-files> [output-dir]')
}

const apkDir = resolve(dirArg)
if (!existsSync(apkDir) || !statSync(apkDir).isDirectory()) {
  fail(`${apkDir} is not a folder`)
}

const outDir = resolve(outArg ?? join(ROOT, 'dist'))
mkdirSync(outDir, { recursive: true })

const version = JSON.parse(readFileSync(join(PACKAGES, 'version.json'), 'utf8'))
const RELEASE = version.release

/**
 * Which `.apk` belongs to which package.
 *
 * Matched against the folder names under `packages/` rather than parsed out of
 * the filename: an apk is called `<name>-<version>-r<n>.apk` and every one of
 * these names contains a dash, so splitting on dashes guesses. The folders are
 * the list of packages that exist, so they are what decides.
 */
const names = readdirSync(PACKAGES)
  .filter((entry) => existsSync(join(PACKAGES, entry, 'Makefile')))
  .sort()

/**
 * The archives a package folder produces beyond the one named after it.
 *
 * luci.mk builds a separate `luci-i18n-<basename>-<lang>` package for every
 * directory under po/, so a bundle assembled from folder names alone would
 * quietly leave every translation behind - and quietly is the problem: the app
 * would install successfully and simply be in English.
 *
 * Derived from po/ the same way luci.mk derives it, so adding a language is
 * adding a directory and nothing else. Their version is the release because the
 * Makefile pins PKG_PO_VERSION to PKG_VERSION; `check-packages.mjs` fails the
 * build if it ever stops doing that.
 */
function extraArchives(name) {
  const po = join(PACKAGES, name, 'po')
  if (!name.startsWith('luci-') || !existsSync(po)) return []

  const basename = name.replace(/^luci-[a-z]+-/, '')
  return readdirSync(po)
    .filter((entry) => entry !== 'templates' && statSync(join(po, entry)).isDirectory())
    .map((lang) => `luci-i18n-${basename}-${lang.split('_')[0].toLowerCase()}`)
    .sort()
}

const wanted = names.flatMap((name) => [name, ...extraArchives(name)])

const archives = readdirSync(apkDir).filter((entry) => entry.endsWith('.apk'))

const packages = []
for (const name of wanted) {
  const matches = archives.filter((entry) => entry.startsWith(`${name}-`))
  if (matches.length === 0) {
    fail(`no .apk for ${name} in ${apkDir} - build every package before packing a bundle`)
  }
  if (matches.length > 1) {
    // Two builds of the same package in one folder is how a bundle comes to
    // carry the version nobody meant. There is no rule for picking between
    // them that is better than refusing.
    fail(`${matches.length} archives for ${name} in ${apkDir}: ${matches.join(', ')}`)
  }
  const file = matches[0]
  const bytes = readFileSync(join(apkDir, file))
  packages.push({
    name,
    version: RELEASE,
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    // The schema the package's own configuration and state are written at, so
    // a router can refuse an install that would take it backwards.
    configSchema: version.configSchema ?? 1,
    bytes
  })
}

const manifest = {
  manifestSchema: 1,
  release: RELEASE,
  apiVersion: version.apiVersion,
  // The oldest agent that can apply this release. An update engine reads it
  // before downloading anything, so a router two releases behind is told to
  // take the intermediate step rather than half-applying this one.
  minAgentVersion: version.minAgentVersion ?? RELEASE,
  packages: packages.map(({ bytes: _bytes, ...entry }) => entry)
}

const manifestText = `${JSON.stringify(manifest, null, 2)}\n`

// ---------------------------------------------------------------------------
// A POSIX ustar archive, written by hand.
//
// BusyBox tar reads this; that is the only reader that matters. Every header
// field that could carry the clock or the build machine's identity is fixed
// instead, which is what makes two builds of the same source produce the same
// bytes.
// ---------------------------------------------------------------------------

const BLOCK = 512

function octal(value, width) {
  // width - 1 digits and a NUL: the form every tar implementation accepts,
  // including the ones that do not read the space-terminated variant.
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function header(name, size) {
  const buf = Buffer.alloc(BLOCK)
  if (Buffer.byteLength(name) > 100) fail(`name too long for a ustar header: ${name}`)
  buf.write(name, 0, 100, 'utf8')
  buf.write(octal(0o644, 8), 100, 8, 'ascii')
  buf.write(octal(0, 8), 108, 8, 'ascii') // uid
  buf.write(octal(0, 8), 116, 8, 'ascii') // gid
  buf.write(octal(size, 12), 124, 12, 'ascii')
  buf.write(octal(FIXED_MTIME, 12), 136, 12, 'ascii')
  buf.write('        ', 148, 8, 'ascii') // checksum field, spaces while summing
  buf.write('0', 156, 1, 'ascii') // regular file
  buf.write('ustar\0', 257, 6, 'ascii')
  buf.write('00', 263, 2, 'ascii')
  buf.write('root', 265, 32, 'ascii')
  buf.write('root', 297, 32, 'ascii')

  let sum = 0
  for (const byte of buf) sum += byte
  // Six octal digits, a NUL and a space - the layout GNU tar writes and every
  // reader accepts. Written after the sum, over the spaces that were counted.
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return buf
}

function entry(name, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  const padding = Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK)
  return Buffer.concat([header(name, body.length), body, padding])
}

const parts = [entry('bm-packages.json', manifestText)]
for (const item of packages) parts.push(entry(item.file, item.bytes))
// Two zero blocks end an archive. Without them BusyBox tar reports a truncated
// file and extracts nothing.
parts.push(Buffer.alloc(BLOCK * 2))

const tar = Buffer.concat(parts)
// One long line would be one enormous token for anything that reads this back;
// 76 columns is what base64 has always wrapped at, and `base64 -d` on the
// router does not care either way.
const encoded = `${tar.toString('base64').replace(/(.{76})/g, '$1\n').trimEnd()}\n`

const bundleName = `bm-packages-${RELEASE}.apkbundle`
const bundlePath = join(outDir, bundleName)
const manifestPath = join(outDir, 'bm-packages.json')

writeFileSync(manifestPath, manifestText)
writeFileSync(bundlePath, encoded)

const bundleSha = createHash('sha256').update(readFileSync(bundlePath)).digest('hex')
writeFileSync(`${bundlePath}.sha256`, `${bundleSha}  ${bundleName}\n`)

const kb = Math.ceil(encoded.length / 1024)
console.log(`==> ${bundlePath}`)
console.log(`    ${packages.length} package(s) at ${RELEASE}, ${kb} KB encoded`)
for (const item of packages) {
  console.log(`    ${item.name.padEnd(16)} ${item.file}  ${item.sha256.slice(0, 16)}…`)
}
console.log(`    sha256 ${bundleSha}`)
console.log(`==> ${manifestPath}`)
if (kb > BUNDLE_WARN_KB) {
  console.error(
    `WARNING: ${kb} KB is over the ${BUNDLE_WARN_KB} KB the upload form accepts - something unexpected is in ${basename(apkDir)}`
  )
}
