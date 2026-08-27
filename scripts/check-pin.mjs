/**
 * The module's pinned package release is the one this tree ships.
 *
 * `openwrt/main/agent/manifest.ts` is the trust root for the install source an
 * ordinary user takes: the router downloads each `.apk` from `PINNED_BASE` and
 * checks it against a sha256 compiled into the module. That file is written by
 * `npm run pin:packages`, which can only run *after* the package release it
 * reads has been published - so there is a window, on every release, in which
 * `packages/version.json` has moved and the pin has not.
 *
 * A module released inside that window is the failure this script exists to
 * make impossible, and it is a quiet one. Nothing refuses: the install runs, the
 * hashes match, apk reports success - and the router ends up with the *previous*
 * release of the packages under a module that expects this one. 3.0.0 shipped
 * pinned to packages 1.4.1 and its own PPPoE pools therefore could not be
 * created at all, on a router the install had just called ready.
 *
 * So this is deliberately **not** part of `npm run check`. The commit that bumps
 * `packages/version.json` legitimately disagrees with the pin - that is the
 * whole point of the ordering in `pin-packages.mjs` - and failing it on a branch
 * would make the correct sequence impossible to commit. It runs on the module's
 * own release tag, in `release.yml`, which is the last moment the invariant can
 * be checked and the first moment it has to hold.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_FILE = join(ROOT, 'packages/version.json')
const MANIFEST_FILE = join(ROOT, 'openwrt/main/agent/manifest.ts')

const failures = []

// A checkout with no packages/ tree has nothing to pin to, and the module's
// own `hasPinnedRelease()` already answers that case with a sentence on the
// page rather than a broken install.
if (!existsSync(VERSION_FILE)) {
  console.log('ok    no packages/ tree in this checkout, nothing to pin against')
  process.exit(0)
}

const release = JSON.parse(readFileSync(VERSION_FILE, 'utf8')).release
const source = readFileSync(MANIFEST_FILE, 'utf8')

const pinned = source.match(/export const PINNED_RELEASE = '([^']*)'/)?.[1]
const base = source.match(/export const PINNED_BASE = '([^']*)'/)?.[1]
const files = [...source.matchAll(/^\s*file: '([^']+)'/gm)].map((match) => match[1])

if (pinned === undefined || base === undefined) {
  console.error('FAIL  openwrt/main/agent/manifest.ts: PINNED_RELEASE or PINNED_BASE is not there to read')
  process.exit(1)
}

// An empty pin is legal in a fresh checkout and is not legal in a release: the
// pinned source is the only one that needs neither an agent already on the
// router nor a file the user has to find, so a release without it hands most
// users no way in at all.
if (!pinned || !files.length) {
  failures.push(
    'openwrt/main/agent/manifest.ts pins nothing, so the module could not install the router packages. ' +
      `Run \`npm run pin:packages -- --release ${release}\` once pkg-v${release} is published.`
  )
} else if (pinned !== release) {
  failures.push(
    `openwrt/main/agent/manifest.ts is pinned to packages ${pinned}, but packages/version.json says ${release}. ` +
      `Publish pkg-v${release}, then \`npm run pin:packages -- --release ${release}\` and commit that.`
  )
}

// The base has to name that one release directory. `latest/download` would
// resolve somewhere else the day the next release is published, and the pinned
// hashes would then be hashes of files that are not there.
if (pinned === release && !base.includes(`/pkg-v${release}/`)) {
  failures.push(
    `openwrt/main/agent/manifest.ts: PINNED_BASE does not point at pkg-v${release}: ${base}`
  )
}

// Every archive name carries its version, so a rewrite that half finished -
// the release constant moved and the list did not - is caught here rather than
// by a checksum failure on somebody's router.
for (const file of files) {
  if (!file.includes(release)) {
    failures.push(
      `openwrt/main/agent/manifest.ts: pinned file ${file} is not from release ${release}`
    )
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  process.exit(1)
}

console.log(`ok    module pins router packages ${release}, ${files.length} archive(s), base pkg-v${release}`)
