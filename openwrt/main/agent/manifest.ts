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
export const PINNED_RELEASE = '1.4.1'

/** Where the files below live. One directory, one release, no redirects. */
export const PINNED_BASE = 'https://github.com/FireStarsSoft/Bored-Manager-OpenWRT/releases/download/pkg-v1.4.1/'

/**
 * Written by `npm run pin:packages`. Order is install order, which matters:
 * `bm-agent` first, because everything else declares itself to it.
 */
export const PINNED_PACKAGES: readonly PinnedPackage[] = [
  {
    name: 'bm-agent',
    file: 'bm-agent-1.4.1-r1.apk',
    sha256: 'cdddfaf8ea8ca81cb204ea2a1d46cf7d177ac3442d36d944e41829b97f995289',
    size: 37340
  },
  {
    name: 'bm-pppoe-pool',
    file: 'bm-pppoe-pool-1.4.1-r1.apk',
    sha256: '608594ad825ae0d7e76d0335918a5fd31d926aada5da7be5527f0425e14bc597',
    size: 26046
  },
  {
    name: 'bm-wanbind',
    file: 'bm-wanbind-1.4.1-r1.apk',
    sha256: '3ce861a03912af67f173c32e2f9db522e373bf000f5f61f8cb0d8559bbaa3fc5',
    size: 35459
  },
  {
    name: 'luci-app-bm',
    file: 'luci-app-bm-1.4.1-r1.apk',
    sha256: 'eb9c9d96764dcbb5eb75861b7b16e1da06c6e2551d7af16292690ee26dec75d8',
    size: 20448
  },
  {
    name: 'luci-i18n-bm-vi',
    file: 'luci-i18n-bm-vi-1.4.1.apk',
    sha256: '0cee2199ae7dc7cfe173f5098856f578d46dfc02ea3827b9681e2e53b5b9b0d7',
    size: 11444
  }
]

/** The sentence every surface uses when there is nothing to install from here. */
export const NOTHING_PINNED =
  'This build of the module has no pinned package release, so there is nothing for it to download. Install from a bundle file or a path on the router instead, or update the module.'

export function hasPinnedRelease(): boolean {
  return PINNED_PACKAGES.length > 0 && PINNED_BASE.length > 0 && PINNED_RELEASE.length > 0
}
