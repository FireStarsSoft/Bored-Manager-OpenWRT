/**
 * The release of the router packages this build of the module was pinned to,
 * and the only one it will install without being told where to look.
 *
 * ## The trust root, and why it is here rather than on the network
 *
 * `apk add --allow-untrusted` plus a sha256 taken from the same download only
 * proves the bytes arrived intact - it says nothing about who sent them. So
 * each way of installing has its own root, and this is the root of the one an
 * ordinary user takes:
 *
 * | Source | Trusted because |
 * |---|---|
 * | pinned | the hashes below are compiled into this module release |
 * | GitHub, by the router | the manifest is signed, and the agent has the key |
 * | a `.apkbundle` file | the person chose the file |
 * | a path on the router | it is already on the router |
 *
 * A hash here is checked on the router before `apk add` runs, so a mirror, a
 * proxy or a compromised release cannot substitute a package: it would have to
 * substitute this file, which means shipping a different module.
 *
 * ## Why the list can be empty
 *
 * It is written by `npm run pin:packages`, which reads a published
 * `bm-packages.json` and rewrites the constants below. It is empty in a
 * checkout where no package release has been published yet, and the pinned
 * source then refuses by name and points at the other three - which all work.
 * An invented hash would be worse than an empty list in every direction: it
 * cannot install, and it cannot say why.
 */

export interface PinnedPackage {
  /** Exactly as `packages/` names it, which is what the router installs. */
  name: string
  /** The file on the release, appended to `PINNED_BASE`. */
  file: string
  sha256: string
  size: number
}

/** The package release these hashes came from. Empty when nothing is pinned. */
export const PINNED_RELEASE = '2.4.0'

/** Where the files below live. One directory, one release, no redirects. */
export const PINNED_BASE = 'https://github.com/FireStarsSoft/Bored-Manager-OpenWRT/releases/download/pkg-v2.4.0/'

/**
 * Written by `npm run pin:packages`. Order is install order, which matters:
 * `bm-agent` first, because everything else declares itself to it.
 */
export const PINNED_PACKAGES: readonly PinnedPackage[] = [
  {
    name: 'bm-agent',
    file: 'bm-agent-2.4.0-r1.apk',
    sha256: '87ed9f9c056b14324f9f686ad3e202e68fe463b2fbb4820d98a9e49ed188aa82',
    size: 71547
  },
  {
    name: 'bm-pppoe-pool',
    file: 'bm-pppoe-pool-2.4.0-r1.apk',
    sha256: 'f457d8747a816a9e4aa32e76f1867a923f58c5325f0de8e9a6693d72d197c4cb',
    size: 50325
  },
  {
    name: 'bm-wanbind',
    file: 'bm-wanbind-2.4.0-r1.apk',
    sha256: '11dd87dcb81a14bf00c14e7e84e4169f0abfb887cd7f1456ba7a49d0121691be',
    size: 176856
  },
  {
    name: 'luci-app-bm',
    file: 'luci-app-bm-2.4.0-r1.apk',
    sha256: '6c09af6efc16b5b618eef44cdd9f815ba473f6a5a4b09682219f303aa2c06077',
    size: 39849
  },
  {
    name: 'luci-i18n-bm-vi',
    file: 'luci-i18n-bm-vi-2.4.0.apk',
    sha256: 'abcfc6e014ad2f3418cd137f320e1a7062bcc74b716f1a3a61e7cc6cc66a1fc3',
    size: 20937
  }
]

/** The sentence every surface uses when there is nothing to install from here. */
export const NOTHING_PINNED =
  'This build of the module has no pinned package release, so there is nothing for it to download. Install from a bundle file or a path on the router instead, or update the module.'

export function hasPinnedRelease(): boolean {
  return PINNED_PACKAGES.length > 0 && PINNED_BASE.length > 0 && PINNED_RELEASE.length > 0
}
