/**
 * What a name is allowed to be before it reaches a shell.
 *
 * Every string this module writes into `/etc/config/*` passes through one of
 * these, and each one refuses rather than sanitising: a name that does not
 * match is a bug in the caller, and quietly repairing it would write a
 * section under a name nothing else in the module can find again.
 *
 * This file used to hold the whole PPPoE naming scheme - five-digit
 * sequences, `bmv<vid>` devices, table arithmetic. All of that lives on the
 * router now, in bm-pppoe-pool's config.uc, which derives and validates it in
 * one place for every surface. What stays here is what the binding half still
 * writes over SSH.
 */
const PREFIX_RE = /^[a-z][a-z0-9]{0,3}$/

export function execTimeout(value: number): number {
  return Number.isFinite(value) ? Math.max(1_000, Math.trunc(value)) : 60_000
}

/** The pool prefix rule, mirrored from the router so forms can pre-check it. */
export function isPppoePrefix(value: string): boolean {
  return PREFIX_RE.test(value)
}

/**
 * The sieve for a string this module writes as a UCI *value* rather than as a
 * name. `uciQuote` quotes, it does not strip: a control character inside a
 * value would survive into the config file and come straight back out on the
 * line `uci batch` echoes when it rejects a command. Written as a loop rather
 * than a character class so the characters it refuses are not in this file.
 */
export function isSafeUciValue(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/**
 * The sieve for a string this module writes as part of a UCI *name*, or into a
 * value the router will read back as one.
 *
 * Refuses rather than sanitising, for the reason at the top of this file: a
 * name that does not match is a bug in the caller, and quietly repairing it
 * would write a section under a name nothing else can find again.
 */
export function safeUciWord(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,32}$/.test(value)
}

/**
 * A UCI section name for one instance.
 *
 * The module's own instance ids are opaque strings it generated; UCI section
 * names may hold only letters, digits and underscores. `bm` plus the id with
 * everything else replaced is stable, collision-free for the ids this module
 * makes, and recognisable in `uci show bm_wanbind`.
 */
export function wanbindSection(id: string): string {
  return `bm${id.replace(/[^A-Za-z0-9_]/g, '')}`
}
