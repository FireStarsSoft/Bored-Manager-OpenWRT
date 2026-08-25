/**
 * Getting `.apk` files onto the router, and proving they are the right ones
 * before anything is installed.
 *
 * Everything here writes only into one directory made by `mktemp -d`, never a
 * path this module composed. A guessable name under /tmp can be pre-created as
 * a symlink by anything else on the router and turned into a write somewhere
 * else entirely (CWE-377); the fast sweep and the slow probe already use
 * `mktemp` for the same reason, and this writes far more interesting files than
 * either of them.
 *
 * The checksum comparison is the other half. A hash computed from the file that
 * was just fetched proves only that it arrived intact - so every hash here comes
 * from somewhere the download could not influence: the module's own pinned
 * table, or the manifest inside a bundle the user chose from their own machine.
 */
import type { ModuleExecResult } from '@shared/modules'
import { shQuote, splitSections } from '@shared/shell'
import type { AgentDomainDeps, StagedPackage } from './types'

const STAGE_TIMEOUT_MS = 120_000

/**
 * A plain archive name and nothing else.
 *
 * These reach a command line, so a name with a slash in it would put a file
 * outside the staging directory and a name with a space would become two
 * arguments. Everything is quoted anyway; this is the check that means the
 * quoting is a second line of defence rather than the only one.
 */
export const SAFE_ARCHIVE = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.apk$/

/** An absolute path to something that looks like a package, as typed by a user. */
export const SAFE_PATH = /^\/[^\0\n\r]{1,255}\.apk$/

/**
 * Turning the uploaded base64 back into an archive, on a router that may not
 * have a base64 command.
 *
 * `base64` looks like it must be there and is not: OpenWRT builds BusyBox with
 * `BUSYBOX_DEFAULT_BASE64` off, along with uuencode and uudecode, so a stock
 * 25.12 image has no base64 tool at all. Finding that out on the one install
 * path whose whole purpose is a router with no internet would be a poor way to
 * learn it.
 *
 * `ucode` is the fallback and is a better bet than it sounds. `b64dec` is one
 * of its built-ins - no module, no dependency - and firewall4 is written in
 * ucode and depends on it, so every default image has the interpreter. It is
 * also a hard dependency of `bm-agent` itself: a router without it cannot
 * complete this install whatever happens here, which is why the third branch
 * says so plainly instead of failing somewhere further along.
 *
 * Decoded from a file rather than a pipe so that the choice of decoder is not
 * also a choice about who reads stdin.
 */
const DECODE_UCODE =
  'import { readfile, writefile } from "fs"; ' +
  'let text = readfile("bundle.b64"); ' +
  'let raw = (type(text) == "string") ? b64dec(text) : null; ' +
  'exit((type(raw) == "string" && writefile("bundle.tar", raw) == length(raw)) ? 0 : 1);'

const DECODE =
  'if command -v base64 >/dev/null 2>&1; then base64 -d bundle.b64 > bundle.tar; ' +
  `elif [ -x /usr/bin/ucode ]; then /usr/bin/ucode -R -e '${DECODE_UCODE}'; ` +
  'else echo "this router has neither base64 nor ucode, so the bundle cannot be decoded on it" >&2; exit 97; fi'

export interface StageResult {
  ok: boolean
  dir: string
  files: StagedPackage[]
  error: string | null
  /** Lines worth showing in a check report, in order. */
  notes: string[]
}

function fail(error: string, dir = ''): StageResult {
  return { ok: false, dir, files: [], error, notes: [] }
}

function clean(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

async function run(
  deps: AgentDomainDeps,
  command: string,
  stdin?: string
): Promise<ModuleExecResult> {
  return deps.ctx.exec(command, stdin === undefined
    ? { timeoutMs: STAGE_TIMEOUT_MS }
    : { timeoutMs: STAGE_TIMEOUT_MS, stdin })
}

/**
 * Remove a directory this module made earlier.
 *
 * Guarded on the name rather than trusted: the only thing that should ever be
 * passed here is a path `mktemp` produced under /tmp, and anything else is a
 * bug that must not become an `rm -rf` on a router.
 */
export async function unstage(deps: AgentDomainDeps, dir: string): Promise<void> {
  if (!/^\/tmp\/bm-stage\.[A-Za-z0-9]{6,}$/.test(dir)) return
  try {
    await deps.ctx.exec(`rm -rf ${shQuote(dir)}`, { timeoutMs: 15_000 })
  } catch {
    // Tidying. A router that would not delete a temporary directory has bigger
    // problems, and none of them are made worse by leaving it there.
  }
}

async function makeDir(deps: AgentDomainDeps): Promise<string | null> {
  const result = await run(deps, `umask 077; mktemp -d /tmp/bm-stage.XXXXXX 2>/dev/null`)
  const dir = (result.stdout || '').trim().split(/\r?\n/)[0] ?? ''
  return /^\/tmp\/bm-stage\.[A-Za-z0-9]{6,}$/.test(dir) ? dir : null
}

/**
 * Hash every file in the directory, in one round trip, and match them against
 * what they were supposed to be.
 */
async function verify(
  deps: AgentDomainDeps,
  dir: string,
  expected: readonly StagedPackage[]
): Promise<{ ok: boolean; error: string | null }> {
  const names = expected.map((entry) => shQuote(`${dir}/${entry.file}`)).join(' ')
  const result = await run(deps, `cd ${shQuote(dir)} && sha256sum ${names} 2>&1`)

  if (result.code !== 0) {
    return { ok: false, error: `could not checksum the staged files: ${clean(result.stdout || result.stderr)}` }
  }

  const seen = new Map<string, string>()
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/)
    if (match) seen.set(match[2].replace(/^.*\//, ''), match[1])
  }

  for (const entry of expected) {
    const found = seen.get(entry.file)
    if (!found) return { ok: false, error: `${entry.file} is not in the staged files` }
    if (found !== entry.sha256) {
      return {
        ok: false,
        // Named as tampering rather than corruption, because that is the case
        // worth being alarmed about and the harmless one costs nothing to redo.
        error: `${entry.file} does not match the checksum it was published with - it was altered or truncated on the way here`
      }
    }
  }

  return { ok: true, error: null }
}

/**
 * Push a `.apkbundle` up the existing SSH connection, unpack it, and check
 * every file against the manifest that travelled inside it.
 *
 * The manifest is inside rather than beside on purpose: the router checks the
 * archives against the list they were shipped with, so a truncated upload is
 * caught here rather than by `apk` half way through an install.
 */
export async function stageBundle(
  deps: AgentDomainDeps,
  bundle: string
): Promise<StageResult> {
  const text = bundle.trim()
  if (!text) return fail('No bundle was supplied.')
  if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) {
    return fail(
      'That does not look like a .apkbundle: the file should be base64 text. Pick the .apkbundle from a packages release, not a .apk.'
    )
  }

  const dir = await makeDir(deps)
  if (!dir) return fail('Could not make a temporary directory on the router.')

  // Written by stdin rather than as an argument: a few hundred kilobytes of
  // base64 is far past any argument limit, and it keeps the payload out of
  // /proc/<pid>/cmdline, which is world-readable.
  const unpack = await run(
    deps,
    `cd ${shQuote(dir)} && umask 077 && cat > bundle.b64 && { ${DECODE} } && rm -f bundle.b64` +
      ' && tar -xf bundle.tar && rm -f bundle.tar && cat bm-packages.json',
    `${text}\n`
  )

  if (unpack.code !== 0) {
    await unstage(deps, dir)
    return fail(`The bundle would not unpack on the router: ${clean(unpack.stderr || unpack.stdout)}`)
  }

  let manifest: { release?: unknown; packages?: unknown }
  try {
    manifest = JSON.parse((unpack.stdout || '').trim()) as { release?: unknown; packages?: unknown }
  } catch {
    await unstage(deps, dir)
    return fail('The bundle unpacked but carries no readable bm-packages.json.')
  }

  const listed = Array.isArray(manifest.packages) ? manifest.packages : []
  const files: StagedPackage[] = []

  for (const raw of listed) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const file = typeof entry.file === 'string' ? entry.file : ''
    const sha256 = typeof entry.sha256 === 'string' ? entry.sha256 : ''

    if (!SAFE_ARCHIVE.test(file) || !/^[0-9a-f]{64}$/.test(sha256)) {
      await unstage(deps, dir)
      return fail('The bundle names a package this module will not touch - it is not a plain .apk with a sha256.')
    }

    files.push({
      name: typeof entry.name === 'string' ? entry.name : file,
      file,
      sha256,
      size: typeof entry.size === 'number' ? entry.size : 0
    })
  }

  if (!files.length) {
    await unstage(deps, dir)
    return fail('The bundle lists no packages.')
  }

  const checked = await verify(deps, dir, files)
  if (!checked.ok) {
    await unstage(deps, dir)
    return fail(checked.error ?? 'The bundle did not verify.')
  }

  return {
    ok: true,
    dir,
    files: ordered(files),
    error: null,
    notes: [
      `Unpacked and checksummed on the router; nothing has been installed yet.`,
      typeof manifest.release === 'string' && manifest.release
        ? `The bundle says it is release ${manifest.release}.`
        : 'The bundle does not name a release.'
    ]
  }
}

/**
 * A file the user has already put on the router themselves.
 *
 * Nothing is verified against anything here, and the report says so: the trust
 * root for this source is that the file is already on the router, which is a
 * decision somebody made before this module was involved. What is checked is
 * that it exists, that it is a file, and that its name cannot do anything
 * interesting on a command line.
 */
export async function stagePath(deps: AgentDomainDeps, path: string): Promise<StageResult> {
  const wanted = path.trim()

  if (!SAFE_PATH.test(wanted)) {
    return fail('That has to be an absolute path to a .apk file on the router, e.g. /tmp/bm-agent-1.2.0-r1.apk.')
  }

  const result = await run(
    deps,
    `echo '===STAT==='; [ -f ${shQuote(wanted)} ] && wc -c < ${shQuote(wanted)}; echo '===SUM==='; sha256sum ${shQuote(wanted)} 2>/dev/null`
  )

  const sections = splitSections(result.stdout || '')
  const size = Number((sections.get('STAT') ?? '').trim())

  if (!Number.isFinite(size) || size <= 0) {
    return fail(`There is no readable file at ${wanted} on this router.`)
  }

  const sum = (sections.get('SUM') ?? '').trim().match(/^([0-9a-f]{64})/)
  const file = wanted.replace(/^.*\//, '')

  return {
    ok: true,
    // The file stays where the user put it; nothing is copied, so there is
    // nothing to clean up afterwards either.
    dir: '',
    files: [
      {
        name: file.replace(/-\d[\d.]*-r\d+\.apk$/, '') || file,
        file: wanted,
        sha256: sum ? sum[1] : '',
        size
      }
    ],
    error: null,
    notes: [
      `${wanted}, ${Math.max(1, Math.round(size / 1024))} KB.`,
      sum
        ? `sha256 ${sum[1]}. Nothing here checks that against a published value - the file is trusted because it is already on your router.`
        : 'The router could not checksum it, so it will be installed unverified.'
    ]
  }
}

/**
 * `bm-agent` first.
 *
 * Every other package declares itself to the agent by dropping a descriptor in
 * a directory the agent reads, and depends on the ucode modules the agent
 * ships. Installing in any other order works - apk resolves the whole set in
 * one command - but a failure part way through then leaves the harder half to
 * explain.
 */
export function ordered(files: readonly StagedPackage[]): StagedPackage[] {
  return [...files].sort((a, b) => {
    if (a.name === b.name) return 0
    if (a.name === 'bm-agent') return -1
    if (b.name === 'bm-agent') return 1
    return a.name < b.name ? -1 : 1
  })
}
