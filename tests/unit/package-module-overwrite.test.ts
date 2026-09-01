import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * The archive is named after the version in module.json, which means the file
 * this script writes is decided by a number a human has to remember to move.
 * Pack before bumping it and the target is the zip of the release that already
 * shipped - replaced by today's tree under yesterday's name, with a .sha256
 * rewritten beside it that no installer of the published version agrees with.
 * dist/ is gitignored, so nothing would surface it afterwards either.
 *
 * So these are statements about the refusal, not about the zip format: that an
 * existing archive stops the run untouched, that the message says which version
 * and what to do, and that --overwrite still allows the deliberate rebuild the
 * byte-reproducibility of the archive is there to make meaningful.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'package-module.mjs')

const temps: string[] = []

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** A module folder the installer's own rules accept, small enough to pack fast. */
function fixture(version: string): { module: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'bm-pack-'))
  temps.push(root)
  const module = join(root, 'demomod')
  mkdirSync(module, { recursive: true })
  writeFileSync(
    join(module, 'module.json'),
    `${JSON.stringify(
      { apiVersion: 2, id: 'demomod', name: 'Demo', version, entries: { main: 'main/index.ts' } },
      null,
      2
    )}\n`
  )
  mkdirSync(join(module, 'main'), { recursive: true })
  writeFileSync(join(module, 'main', 'index.ts'), 'export default () => ({})\n')
  writeFileSync(join(module, 'README.md'), '# Demo\n')
  writeFileSync(join(module, 'CHANGELOG.md'), '# Changelog\n')
  return { module, out: join(root, 'dist') }
}

function pack(module: string, out: string, ...flags: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, module, out, ...flags], { encoding: 'utf8' })
}

/** Runs the script expecting it to refuse, and hands back what it complained. */
function packExpectingRefusal(module: string, out: string, ...flags: string[]): string {
  try {
    pack(module, out, ...flags)
  } catch (error) {
    const failure = error as { status?: number; stderr?: string }
    expect(failure.status).toBe(1)
    return failure.stderr ?? ''
  }
  throw new Error('the script packed the archive instead of refusing')
}

describe('packing over an archive that is already there', () => {
  it('refuses, and leaves the existing zip and its sha256 exactly as they were', () => {
    const { module, out } = fixture('1.0.0')
    pack(module, out)
    const zip = join(out, 'demomod-1.0.0.zip')
    const released = readFileSync(zip)
    const releasedHash = readFileSync(`${zip}.sha256`, 'utf8')

    // The tree moves on, but module.json still says 1.0.0 - the whole scenario.
    writeFileSync(join(module, 'main', 'index.ts'), 'export default () => ({ changed: true })\n')

    const complaint = packExpectingRefusal(module, out)
    expect(complaint).toContain('demomod-1.0.0.zip already exists')
    expect(complaint).toContain('1.0.0')
    expect(complaint).toContain('--overwrite')
    expect(readFileSync(zip)).toEqual(released)
    expect(readFileSync(`${zip}.sha256`, 'utf8')).toBe(releasedHash)
  })

  it('names the bump as the first thing to do about it', () => {
    const { module, out } = fixture('1.0.0')
    pack(module, out)
    const complaint = packExpectingRefusal(module, out)
    expect(complaint).toContain('module.json')
    expect(complaint).toMatch(/bump/i)
  })

  it('packs the bumped version without complaint, because that file is not there yet', () => {
    const { module, out } = fixture('1.0.0')
    pack(module, out)
    writeFileSync(
      join(module, 'module.json'),
      `${JSON.stringify(
        { apiVersion: 2, id: 'demomod', name: 'Demo', version: '1.0.1', entries: { main: 'main/index.ts' } },
        null,
        2
      )}\n`
    )
    expect(pack(module, out)).toContain('demomod-1.0.1.zip')
  })

  it('rebuilds in place when --overwrite says so, and the same source still packs to the same bytes', () => {
    const { module, out } = fixture('2.0.0')
    pack(module, out)
    const zip = join(out, 'demomod-2.0.0.zip')
    const first = readFileSync(zip)

    pack(module, out, '--overwrite')
    expect(readFileSync(zip)).toEqual(first)

    writeFileSync(join(module, 'main', 'index.ts'), 'export default () => ({ changed: true })\n')
    pack(module, out, '--overwrite')
    expect(readFileSync(zip)).not.toEqual(first)
  })

  it('still takes the output folder as a positional with the flag present', () => {
    const { module, out } = fixture('3.0.0')
    const output = pack(module, out, '--overwrite')
    expect(output).toContain(join(out, 'demomod-3.0.0.zip'))
  })
})
