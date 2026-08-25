import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * The bundle is how a router with no internet gets the packages: the module
 * reads this file from the machine running the app, pushes it over the existing
 * SSH connection and unpacks it there. So the thing under test is the format
 * itself - a tar written by hand, read by BusyBox, carrying its own checksums.
 *
 * The tar is parsed back here rather than shelled out to, because the failure
 * that matters is a header field one byte out of place: `tar -t` on a developer
 * machine is a GNU tar being generous, and BusyBox will not be.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'pack-bundle.mjs')
const RELEASE = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'version.json'), 'utf8')
).release as string

const temps: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bm-bundle-'))
  temps.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** Whatever `packages/` currently holds, so a new package needs no edit here. */
const PACKAGE_NAMES = readdirSync(join(ROOT, 'packages')).filter((name) =>
  existsSync(join(ROOT, 'packages', name, 'Makefile'))
)

/**
 * The archives a folder produces that are not named after it.
 *
 * luci.mk builds one `luci-i18n-<basename>-<lang>` package per directory under
 * po/, and the packer expects every one of them - a bundle that quietly left
 * the translations out would install an app that is simply in English. Derived
 * here the same way the packer derives it, so adding a language still needs no
 * edit in this file.
 */
const ARCHIVE_NAMES = PACKAGE_NAMES.flatMap((name) => {
  const po = join(ROOT, 'packages', name, 'po')
  if (!name.startsWith('luci-') || !existsSync(po)) return [name]

  const basename = name.replace(/^luci-[a-z]+-/, '')
  const languages = readdirSync(po)
    .filter((entry) => entry !== 'templates')
    .map((lang) => `luci-i18n-${basename}-${lang.split('_')[0].toLowerCase()}`)
  return [name, ...languages]
})

/** Every package folder needs an archive, so the fixture supplies one each. */
function fakeArchives(dir: string, bodies: Record<string, string> = {}): string {
  const apk = join(dir, 'apk')
  mkdirSync(apk, { recursive: true })
  for (const name of ARCHIVE_NAMES) {
    writeFileSync(join(apk, `${name}-${RELEASE}-r1.apk`), bodies[name] ?? `payload for ${name}\n`)
  }
  return apk
}

function pack(dir: string, apkDir: string): { out: string; bundle: Buffer } {
  const out = join(dir, 'out')
  execFileSync(process.execPath, [SCRIPT, apkDir, out], { encoding: 'utf8' })
  return { out, bundle: readFileSync(join(out, `bm-packages-${RELEASE}.apkbundle`)) }
}

interface TarEntry {
  name: string
  size: number
  mode: string
  uname: string
  mtime: number
  body: Buffer
}

/**
 * A ustar reader, strict on the two things a hand-written writer gets wrong:
 * the header checksum, and the padding that has to bring every entry back to a
 * 512-byte boundary.
 */
function readTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = []
  let at = 0
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512)
    if (header.every((byte) => byte === 0)) break

    const field = (offset: number, length: number): string =>
      header.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim()

    // Summed with the checksum field read as eight spaces, which is what the
    // writer has to have done before filling it in.
    let sum = 0
    for (let index = 0; index < 512; index++) {
      sum += index >= 148 && index < 156 ? 0x20 : header[index]
    }
    expect(parseInt(field(148, 8), 8)).toBe(sum)
    expect(field(257, 6)).toBe('ustar')

    const size = parseInt(field(124, 12), 8)
    const body = tar.subarray(at + 512, at + 512 + size)
    out.push({
      name: field(0, 100),
      size,
      mode: field(100, 8),
      uname: field(265, 32),
      mtime: parseInt(field(136, 12), 8),
      body: Buffer.from(body)
    })
    at += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

describe('the offline bundle', () => {
  it('is base64 text a form can carry, wrapped rather than one enormous line', () => {
    const dir = workspace()
    const { bundle } = pack(dir, fakeArchives(dir))
    const text = bundle.toString('utf8')

    // The app's `file` input hands a module the file's text, so anything that
    // is not text is a gamble taken on a user's router.
    expect(text).toMatch(/^[A-Za-z0-9+/=\n]+$/)
    expect(text.split('\n')[0].length).toBe(76)
    expect(Buffer.from(text, 'base64').length).toBeGreaterThan(0)
  })

  it('carries a manifest and one archive per package, checksums included', () => {
    const dir = workspace()
    const { bundle } = pack(dir, fakeArchives(dir, { 'bm-agent': 'agent bytes\n' }))
    const entries = readTar(Buffer.from(bundle.toString('utf8'), 'base64'))

    const manifestEntry = entries.find((entry) => entry.name === 'bm-packages.json')
    expect(manifestEntry).toBeDefined()
    const manifest = JSON.parse(manifestEntry!.body.toString('utf8'))

    expect(manifest.manifestSchema).toBe(1)
    expect(manifest.release).toBe(RELEASE)
    expect(manifest.packages.length).toBe(entries.length - 1)

    for (const entry of manifest.packages) {
      const archive = entries.find((item) => item.name === entry.file)
      expect(archive, `${entry.file} is named in the manifest but not in the tar`).toBeDefined()
      // The reason the manifest is inside the bundle rather than beside it: the
      // router checks each file against the list it was shipped with, so a
      // truncated upload is caught before anything reaches `apk add`.
      expect(createHash('sha256').update(archive!.body).digest('hex')).toBe(entry.sha256)
      expect(archive!.size).toBe(entry.size)
    }
  })

  it('ends with the two zero blocks BusyBox needs to call the archive complete', () => {
    const dir = workspace()
    const { bundle } = pack(dir, fakeArchives(dir))
    const tar = Buffer.from(bundle.toString('utf8'), 'base64')

    expect(tar.length % 512).toBe(0)
    expect(tar.subarray(tar.length - 1024).every((byte) => byte === 0)).toBe(true)
  })

  it('carries nothing from the machine that built it', () => {
    const dir = workspace()
    const { bundle } = pack(dir, fakeArchives(dir))
    const entries = readTar(Buffer.from(bundle.toString('utf8'), 'base64'))

    for (const entry of entries) {
      // A build clock or a builder's uid in the header would make two builds of
      // the same source differ, and then a published sha256 says nothing about
      // the source at all.
      expect(entry.mtime).toBe(946_684_800)
      expect(entry.uname).toBe('root')
      expect(entry.mode).toBe('0000644')
    }
  })

  it('packs to the same bytes twice', () => {
    const dir = workspace()
    const apk = fakeArchives(dir)
    const first = pack(dir, apk).bundle
    const second = pack(workspace(), apk).bundle

    expect(createHash('sha256').update(second).digest('hex')).toBe(
      createHash('sha256').update(first).digest('hex')
    )
  })

  it('writes the manifest beside the bundle, for a release to attach', () => {
    const dir = workspace()
    const { out } = pack(dir, fakeArchives(dir))

    const manifest = JSON.parse(readFileSync(join(out, 'bm-packages.json'), 'utf8'))
    expect(manifest.release).toBe(RELEASE)
    // A router asked to check for an update fetches exactly this file.
    expect(manifest.minAgentVersion).toBeTruthy()
    expect(readFileSync(join(out, `bm-packages-${RELEASE}.apkbundle.sha256`), 'utf8')).toContain(
      `bm-packages-${RELEASE}.apkbundle`
    )
  })

  it('refuses to guess when a package has no archive, or two', () => {
    const dir = workspace()
    const apk = join(dir, 'empty')
    mkdirSync(apk, { recursive: true })

    expect(() => pack(dir, apk)).toThrow(/no \.apk for bm-agent/)

    const doubled = fakeArchives(workspace())
    writeFileSync(join(doubled, `bm-agent-${RELEASE}-r2.apk`), 'a second build\n')
    // Picking one would be picking the version nobody meant.
    expect(() => pack(workspace(), doubled)).toThrow(/2 archives for bm-agent/)
  })
})
