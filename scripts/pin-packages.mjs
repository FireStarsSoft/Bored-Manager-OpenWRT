#!/usr/bin/env node
/**
 * Pin this module build to a published router-package release.
 *
 * Usage:
 *   node scripts/pin-packages.mjs <bm-packages.json> [--base <url>]
 *   node scripts/pin-packages.mjs --release <version>   (fetches from GitHub)
 *
 * It rewrites the three constants in `openwrt/main/agent/manifest.ts`, which is
 * the trust root for the install source an ordinary user takes: the router
 * downloads each file and checks it against a sha256 that is compiled into the
 * module, so a mirror, a proxy or a replaced release cannot substitute a
 * package without also replacing the module.
 *
 * A command rather than a hand edit for one reason: hashes typed by a person
 * are hashes with a typo in them, and a typo here fails at `apk add` on
 * somebody else's router with a message about a checksum.
 *
 * ## The order that matters
 *
 * The packages release has to exist first, because this reads its manifest. So:
 * tag `pkg-v<version>`, wait for it to publish, run this, commit, then tag the
 * module's own `v<version>`. Pinning to a release that has not been published
 * yet produces a module that cannot install anything and says so on the page.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = resolve(ROOT, 'openwrt/main/agent/manifest.ts')

const REPO = 'FireStarsSoft/Bored-Manager-OpenWRT'

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
let file = ''
let base = ''
let release = ''

for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--base') base = args[++index] ?? ''
  else if (arg === '--release') release = args[++index] ?? ''
  else if (!file) file = arg
}

if (!file && !release) {
  fail('usage: node scripts/pin-packages.mjs <bm-packages.json> [--base <url>]\n' +
    '   or: node scripts/pin-packages.mjs --release <version>')
}

let manifest
if (file) {
  manifest = JSON.parse(readFileSync(resolve(file), 'utf8'))
} else {
  const url = `https://github.com/${REPO}/releases/download/pkg-v${release}/bm-packages.json`
  console.log(`fetching ${url}`)
  const answer = await fetch(url)
  if (!answer.ok) fail(`${url} answered ${answer.status}`)
  manifest = await answer.json()
}

if (typeof manifest.release !== 'string' || !Array.isArray(manifest.packages)) {
  fail('that is not a bm-packages.json: no release, or no package list')
}

// Defaults to the release the manifest names, which is the only correct answer
// when the hashes came from that release: a base pointing at `latest/download`
// would resolve to a different release the day after the next one is published,
// and the pinned hashes would then be hashes of files that are not there.
if (!base) {
  base = `https://github.com/${REPO}/releases/download/pkg-v${manifest.release}/`
}
if (!base.endsWith('/')) base += '/'

const packages = manifest.packages.map((entry) => {
  for (const field of ['name', 'file', 'sha256']) {
    if (typeof entry[field] !== 'string' || !entry[field]) {
      fail(`a package entry has no ${field}`)
    }
  }
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`${entry.file}: that is not a sha256`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*\.apk$/.test(entry.file)) {
    fail(`${entry.file}: not a plain archive name`)
  }
  return {
    name: entry.name,
    file: entry.file,
    sha256: entry.sha256,
    size: Number.isFinite(entry.size) ? entry.size : 0
  }
})

if (!packages.length) fail('that manifest lists no packages')

const source = readFileSync(MANIFEST, 'utf8')

function replaceConst(text, name, value) {
  const pattern = new RegExp(`(export const ${name}[^=]*= )[^\\n]*`)
  if (!pattern.test(text)) fail(`could not find ${name} in ${MANIFEST}`)
  return text.replace(pattern, `$1${value}`)
}

let next = replaceConst(source, 'PINNED_RELEASE', `'${manifest.release}'`)
next = replaceConst(next, 'PINNED_BASE', `'${base}'`)

const listed = packages
  .map(
    (entry) =>
      `  {\n` +
      `    name: '${entry.name}',\n` +
      `    file: '${entry.file}',\n` +
      `    sha256: '${entry.sha256}',\n` +
      `    size: ${entry.size}\n` +
      `  }`
  )
  .join(',\n')

next = next.replace(
  /(export const PINNED_PACKAGES: readonly PinnedPackage\[\] = )\[[\s\S]*?\]\n/,
  `$1[\n${listed}\n]\n`
)

writeFileSync(MANIFEST, next)

console.log(`==> ${MANIFEST}`)
console.log(`    release ${manifest.release}`)
console.log(`    base    ${base}`)
for (const entry of packages) {
  console.log(`    ${entry.name.padEnd(16)} ${entry.file}  ${entry.sha256.slice(0, 16)}…`)
}
console.log('\nRun `npm run check`, commit, then tag the module release.')
