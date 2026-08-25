/**
 * The sentences and thresholds more than one file has to agree on.
 *
 * Split out for the reason they were introduced at all: a condition described
 * twice becomes a condition described differently the moment either copy is
 * edited, and a user then reads one router's missing firewall in two
 * vocabularies. The checklist row, the create-form refusal, the install gate
 * and the running job all read from here.
 */

export const NOT_CONNECTED = 'Not connected to a router yet.'
export const NOT_OPENWRT =
  'The connected machine is not an OpenWRT router. Connect this machine entry directly to the router over SSH.'

/** Every row of a router that has not said a word yet reads this. */
export const UNANSWERED = 'The router has not answered yet.'

/**
 * The one sentence for a router with no apk database, read by all three places
 * that have to say it: this checklist's `pkgmgr` row, the install form's own
 * refusal, and `installHint` on every create form. They used to carry three
 * copies of "Neither opkg nor apk is present", which is how the card and the
 * form came to describe one router in two voices the moment one was edited.
 */
export const APK_REQUIRED =
  'No apk package database on this router. This module needs OpenWrt 25.12 or newer, which replaced opkg with apk.'

/**
 * The refusal for a router that is simply too old. Naming the release it runs
 * is the whole point: "no package manager" on a working 24.10 router sends the
 * user looking for a broken installer instead of at a firmware upgrade.
 */
export function opkgNotSupported(release: string): string {
  return `This module needs OpenWrt 25.12 or newer. This router runs ${
    release || 'an unknown release'
  } and still uses opkg.`
}

/** The first release that ships apk. Below it the module is untested, not broken. */
export const MIN_RELEASE = 25.12

/**
 * `24.10.2` as a number to compare, or null for anything that is not a release
 * number at all - a snapshot build calls itself `SNAPSHOT` or `r28417`. That is
 * exactly why no gate in this file is allowed to key off the version string:
 * the apk database on disk decides, and this only ever produces a warning.
 */
export function releaseNumber(release: string): number | null {
  const match = release.trim().match(/^(\d{2})\.(\d{2})/)
  return match ? Number(`${match[1]}.${match[2]}`) : null
}

/** Blocking requirements, in the order they are reported. */
export const CORE_TOOLS = ['ubus', 'uci', 'ip', 'netifd']

/**
 * Free kilobytes below which an install is refused outright / warned about.
 *
 * Exported because the install gate and the install job both have to agree
 * with this card: the check refuses below the first number, the running job
 * re-reads the overlay between packages and stops at the same one, and the
 * checklist row explains it. Three copies of 512 is how a user comes to read
 * "enough room" on one page and be refused on another.
 */
export const SPACE_BAD_KB = 512
export const SPACE_WARN_KB = 2_048

/**
 * One condition, one sentence. The readiness card, the PPPoE create gate and
 * the binding create gate all describe this same missing firewall, and used to
 * do it in three vocabularies - none of which said that this is the one
 * readiness failure the install flow deliberately cannot fix, so a user reading
 * "Firewall4: Not found" above an "Install missing packages" section went
 * looking for it there.
 */
export const FW4_MISSING =
  'Managed PPPoE pools and WAN binding both need nftables masquerading, which routers still on fw3 do not have. It cannot be installed from here: moving a router to fw4 is a firmware upgrade, done at a router shell.'
