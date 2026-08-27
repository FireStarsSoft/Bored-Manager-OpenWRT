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
export const PINNED_RELEASE = '2.0.1'

/** Where the files below live. One directory, one release, no redirects. */
export const PINNED_BASE = 'https://github.com/FireStarsSoft/Bored-Manager-OpenWRT/releases/download/pkg-v2.0.1/'

/**
 * Written by `npm run pin:packages`. Order is install order, which matters:
 * `bm-agent` first, because everything else declares itself to it.
 */
export const PINNED_PACKAGES: readonly PinnedPackage[] = [
  {
    name: 'bm-agent',
    file: 'bm-agent-2.0.1-r1.apk',
    sha256: '0e1faa7c369c8d475dc6c9bbd51cc98e3575cee946b5c696fd3edc7277f16f2f',
    size: 38221
  },
  {
    name: 'bm-pppoe-pool',
    file: 'bm-pppoe-pool-2.0.1-r1.apk',
    sha256: '379e132a593c5b931d206a64642d2ff4178233a1a72df0fb1e8bae522e1df3a5',
    size: 41568
  },
  {
    name: 'bm-wanbind',
    file: 'bm-wanbind-2.0.1-r1.apk',
    sha256: 'df3a9c4307ede88edcaf6f9f5089d41a186c6f62bfdddca087496fcbba20da46',
    size: 35459
  },
  {
    name: 'luci-app-bm',
    file: 'luci-app-bm-2.0.1-r1.apk',
    sha256: '5eabe41429de09e7b77f035463ff77bfba9068995395f52f042043ffb0b0be79',
    size: 23872
  },
  {
    name: 'luci-i18n-bm-vi',
    file: 'luci-i18n-bm-vi-2.0.1.apk',
    sha256: 'bacdaf03ae6aa66710901fa9336431bb5f24b1c987bc9d2136420bc09722fe08',
    size: 11445
  }
]

/** The sentence every surface uses when there is nothing to install from here. */
export const NOTHING_PINNED =
  'This build of the module has no pinned package release, so there is nothing for it to download. Install from a bundle file or a path on the router instead, or update the module.'

export function hasPinnedRelease(): boolean {
  return PINNED_PACKAGES.length > 0 && PINNED_BASE.length > 0 && PINNED_RELEASE.length > 0
}
