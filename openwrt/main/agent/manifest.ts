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

/** The package release these hashes came from. Empty when nothing is pinned.
 *  Still 2.1.0 until pkg-v2.2.0 is published and `npm run pin:packages` is run. */
export const PINNED_RELEASE = '2.1.0'

/** Where the files below live. One directory, one release, no redirects. */
export const PINNED_BASE = 'https://github.com/FireStarsSoft/Bored-Manager-OpenWRT/releases/download/pkg-v2.1.0/'

/**
 * Written by `npm run pin:packages`. Order is install order, which matters:
 * `bm-agent` first, because everything else declares itself to it.
 */
export const PINNED_PACKAGES: readonly PinnedPackage[] = [
  {
    name: 'bm-agent',
    file: 'bm-agent-2.1.0-r1.apk',
    sha256: '1e1ae43acd0a5e33c4377b2125bffbde649502bd33c035ce5e583f408a6e4226',
    size: 45488
  },
  {
    name: 'bm-pppoe-pool',
    file: 'bm-pppoe-pool-2.1.0-r1.apk',
    sha256: '459f2a80d1a8875fc4952e81393f4cc3eb6840edbef68d5e9040c80c5054b3d4',
    size: 41570
  },
  {
    name: 'bm-wanbind',
    file: 'bm-wanbind-2.1.0-r1.apk',
    sha256: 'f1a7eeb23fd0ef328486e6f62896e391fb64f2cd6adf58f96f5e6360d70874e1',
    size: 35456
  },
  {
    name: 'luci-app-bm',
    file: 'luci-app-bm-2.1.0-r1.apk',
    sha256: '5369b11ba70c24940f356a03548cc73fe40372fd134b097154617ec4c08b7999',
    size: 27350
  },
  {
    name: 'luci-i18n-bm-vi',
    file: 'luci-i18n-bm-vi-2.1.0.apk',
    sha256: 'b4e7fa1574413658812a67298cebaadda50374adb4f058514ad01045f8d49c9f',
    size: 13240
  }
]

/** The sentence every surface uses when there is nothing to install from here. */
export const NOTHING_PINNED =
  'This build of the module has no pinned package release, so there is nothing for it to download. Install from a bundle file or a path on the router instead, or update the module.'

export function hasPinnedRelease(): boolean {
  return PINNED_PACKAGES.length > 0 && PINNED_BASE.length > 0 && PINNED_RELEASE.length > 0
}
