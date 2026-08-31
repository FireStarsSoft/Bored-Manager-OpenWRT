/**
 * A second `ip rule` parser, and the reason there has to be one.
 *
 * `main/parse.ts`'s `parseIpRules` is the reader the binding engine reconciles
 * against, and it is strict on purpose: it requires `(?:lookup|table)\s+(\d+)`
 * and a `from` match, because a rule that names neither is not an assignment it
 * could ever own. The consequence is that it silently drops every rule with a
 * *named* table (`lookup vpn`, from `/etc/iproute2/rt_tables`) and every rule
 * whose selector is an fwmark, an `iif` or an `oif` rather than a source
 * address - which is to say, precisely the foreign rules this monitor exists to
 * surface. Reusing it would have built the feature out of the one reader that
 * cannot see the thing the feature is for.
 *
 * So this parser:
 *
 * - keys rules and routes by the lookup token **as a string**, mapping the
 *   three well-known names for display only (`main` = 254, `default` = 253,
 *   `local` = 255) and never turning a name into a number it would then have to
 *   guess back;
 * - tolerates a selector with no `from` at all, recording the selector text so
 *   the classifier can report the rule honestly without attributing it to an
 *   address it does not name;
 * - keeps the line exactly as the router printed it, because the detail panel's
 *   whole job is to show a person the rule they are being told about.
 *
 * Nothing here judges anything. `classify.ts` decides who owns a rule; this
 * file only reads.
 */
import { splitSections } from '@shared/shell'
import { SCAN_MAX_RULES, SCAN_MAX_TABLES } from './command'
import type { ScanReadout, ScanRuleLine } from './types'

/** Router output is data, not a document; every string is capped before it is kept. */
const MAX_TEXT = 200

/**
 * The three tables the kernel names for itself. Kept as a display mapping
 * only: a rule that says `lookup main` and one that says `lookup 254` are the
 * same rule, and a reader shown two different tables would go looking for a
 * conflict that does not exist.
 *
 * A `Map` rather than an object literal because the key handed to it is a table
 * name out of `/etc/iproute2/rt_tables` - administrator-written text arriving
 * over a connection. On an object literal `lookup constructor` does not miss:
 * it resolves through the prototype to a function, sails past the `?? null`
 * that was supposed to catch an unknown name, and the row on somebody's screen
 * then named their routing table `function Object() { [native code] }`.
 */
export const WELL_KNOWN_TABLES: ReadonlyMap<string, number> = new Map([
  ['local', 255],
  ['main', 254],
  ['default', 253]
])

/**
 * The preference the kernel puts each of its own baseline rules at. A rule that
 * matches a name *and* its preference *and* selects nothing is the baseline
 * every Linux machine boots with; anything else claiming one of those tables is
 * somebody's policy rule and has to be reported.
 *
 * A `Map` for the reason above: this one is looked up by the table token too,
 * and `KERNEL_BASELINE.toString` on an object literal is a function being asked
 * whether it equals a preference number - a question that should never have
 * been askable of a rule table the router wrote.
 */
export const KERNEL_BASELINE: ReadonlyMap<string, number> = new Map([
  ['local', 0],
  ['main', 32_766],
  ['default', 32_767]
])

function cap(value: string): string {
  return value.trim().slice(0, MAX_TEXT)
}

/** `42` -> 42, `main` -> 254, an unknown name -> null. */
export function tableNumber(token: string): number | null {
  if (/^\d{1,7}$/.test(token)) {
    const value = Number(token)
    return Number.isSafeInteger(value) ? value : null
  }
  return WELL_KNOWN_TABLES.get(token) ?? null
}

/** `main (254)`, `42`, `vpn` - what a table is called in front of a user. */
export function tableLabel(token: string): string {
  if (!token) return 'no table'
  const number = tableNumber(token)
  if (number === null) return token
  for (const [name, value] of WELL_KNOWN_TABLES) {
    if (value === number) return `${name} (${number})`
  }
  return String(number)
}

/**
 * Whether this is one of the three rules the kernel installs on its own.
 *
 * Both halves of the test matter. Without the preference check a hand-written
 * `from all lookup main pref 100` - a real way to defeat every policy rule
 * below it - would be dismissed as the baseline. Without the selector check a
 * rule that narrows the baseline to one subnet would be too.
 */
export function isKernelBaseline(rule: ScanRuleLine): boolean {
  return (
    KERNEL_BASELINE.get(rule.table) === rule.pref &&
    rule.from === 'all' &&
    rule.selector === ''
  )
}

/**
 * What is left of a rule once its table and its `from all` are taken away: the
 * fwmark, the `iif`, the `ipproto`, whatever else it actually selects on. An
 * empty string means the rule selects on nothing but its source.
 */
function selectorText(body: string): string {
  return body
    .replace(/\b(?:lookup|table)\s+\S+/g, ' ')
    .replace(/\bfrom\s+\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * One `ip -4 rule show` line. Returns null for anything that is not a rule -
 * a blank line, or whatever a BusyBox `ip` prints when it disagrees.
 */
function parseRuleLine(raw: string): ScanRuleLine | null {
  const head = raw.match(/^\s*(\d{1,10})\s*:\s*(.*)$/)
  if (!head) return null
  const pref = Number(head[1])
  if (!Number.isSafeInteger(pref)) return null
  const body = head[2].trim()
  if (!body) return null
  const table = body.match(/\b(?:lookup|table)\s+([A-Za-z0-9_.-]{1,64})\b/)?.[1] ?? ''
  const from = body.match(/\bfrom\s+(\S{1,64})/)?.[1] ?? ''
  // `from all` is the kernel's way of writing "no source selector", so it is
  // recorded as printed and resolved to no address. A `/32` is dropped because
  // it is how `ip` writes a single host and nobody reads their own address
  // that way; a `/24` is kept, because there the prefix is the fact.
  const ip = from && from !== 'all' ? from.replace(/\/32$/, '') : ''
  return {
    pref,
    table,
    from,
    ip,
    selector: selectorText(body),
    text: cap(`${pref}:\t${body}`)
  }
}

/**
 * The `===ROUTES===` body: one `<token> <route>` line per captured route.
 *
 * The token is re-validated here even though the command validated it before
 * interpolation, for the reason every parser in this module re-validates: this
 * text arrives over a connection, and the only thing standing between it and a
 * row on somebody's screen is the reader.
 */
function parseRoutes(body: string): Record<string, string[]> {
  const routes = Object.create(null) as Record<string, string[]>
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const match = line.match(/^([A-Za-z0-9_.-]{1,64})\s+(.+)$/)
    if (!match) continue
    const list = routes[match[1]] ?? (routes[match[1]] = [])
    if (list.length < 16) list.push(cap(match[2]))
  }
  return routes
}

/**
 * The `===TABLES===` body: the lookup tokens the routes pass actually ran over,
 * one per line.
 *
 * Re-validated with the same character set and the same 64 the command guards
 * on, so a token this reader would not accept anywhere else cannot slip in
 * here and be counted as a table the scan looked at. Bounded by the same cap
 * as the router's own loop as well: the router promises sixty-four, and a
 * reply is data rather than a promise.
 */
function parseTables(body: string): string[] {
  const tokens = new Set<string>()
  for (const raw of body.split(/\r?\n/)) {
    const token = raw.trim()
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(token)) continue
    tokens.add(token)
    if (tokens.size >= SCAN_MAX_TABLES) break
  }
  return [...tokens]
}

/**
 * Read one scan reply.
 *
 * `ok` follows `===SCANOK===` and nothing else. A reply the executor truncated
 * loses its tail, so the sentinel goes missing and the scan reads as failed -
 * which is the correct answer: a partial rule table presented as the whole one
 * would tell a user that a rule they can see on their router is not there.
 *
 * The router's own cap is the other half of that, and it is the half that used
 * to pass silently: the script asks `head` for one line more than this side
 * keeps, so an arriving 501st rule is the reply saying "there was more". That
 * line is evidence and not a row - one rule out of a remainder nobody can
 * count would sit in the table looking like the end of it - so it is dropped
 * and `rulesTruncated` carries what it told us.
 */
export function parseScanOutput(stdout: string): ScanReadout {
  const sections = splitSections(stdout)
  const ok = (sections.get('SCANOK') ?? '').trim() === '1'
  const rules: ScanRuleLine[] = []
  let rulesTruncated = false
  for (const raw of (sections.get('RULES') ?? '').split(/\r?\n/)) {
    const rule = parseRuleLine(raw)
    if (!rule) continue
    // The cap is enforced here as well as on the router. A `head` that a
    // BusyBox build reads differently, or a future edit to the script, must not
    // be able to grow the array this side keeps.
    if (rules.length >= SCAN_MAX_RULES) {
      rulesTruncated = true
      break
    }
    rules.push(rule)
  }
  rules.sort((first, second) => first.pref - second.pref)

  const mainDefaults: string[] = []
  for (const raw of (sections.get('DEFAULT') ?? '').split(/\r?\n/)) {
    const line = cap(raw)
    if (line.startsWith('default') && mainDefaults.length < 8) mainDefaults.push(line)
  }

  return {
    ok,
    rules,
    rulesTruncated,
    mainDefaults,
    routes: parseRoutes(sections.get('ROUTES') ?? ''),
    // Taken from the router's own list and never derived from `rules`. The
    // rules this side can see are the low-preference start of the table, while
    // the router picked its sixty-four tokens out of all of it, so a set
    // reconstructed here would name tables that were never asked about and
    // miss the ones that were.
    queried: parseTables(sections.get('TABLES') ?? '')
  }
}
