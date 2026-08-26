import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * How the three pages are grouped, as properties rather than as a screenshot.
 *
 * Every page used to be one column of stacked sections - seven of them on
 * Module settings, six on the Dashboard - which read as a single scroll however
 * wide the monitor was, and buried anything below the fold. They sit behind a
 * rail now, the same `subnav` block the app's own Settings page is built from.
 *
 * The other property here is the one the hints toggle only half had: a field's
 * `help` renders as an always-on paragraph and a module cannot gate it, so
 * every explanation lives in a `note` instead - and a note can be switched off.
 */

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '../../openwrt/ui')

interface Node {
  [key: string]: unknown
}

function specNamed(file: string): Node {
  return JSON.parse(readFileSync(join(UI, file), 'utf8')) as Node
}

function specFiles(): string[] {
  return [
    ...readdirSync(join(UI, 'pages')).map((name) => `pages/${name}`),
    ...readdirSync(join(UI, 'widgets')).map((name) => `widgets/${name}`)
  ].filter((name) => name.endsWith('.json'))
}

/** Every object anywhere in a spec, whatever nests it. */
function nodes(value: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(value)) {
    for (const item of value) nodes(item, out)
    return out
  }
  if (typeof value === 'object' && value !== null) {
    out.push(value as Node)
    for (const child of Object.values(value)) nodes(child, out)
  }
  return out
}

/** The rail a page is grouped by: the first `subnav` reached from its root. */
function rail(spec: Node): Node | null {
  return nodes(spec).find((node) => node['type'] === 'subnav') ?? null
}

function railIds(spec: Node): string[] {
  const found = rail(spec)
  if (!found) return []
  return ((found['items'] as Node[]) ?? []).map((item) => String(item['id']))
}

describe('every page is grouped by a rail', () => {
  const EXPECTED: Record<string, string[]> = {
    'pages/dashboard.json': ['overview', 'history', 'devices', 'interfaces'],
    'pages/settings.json': ['readiness', 'packages', 'jobs', 'display', 'rules'],
    'pages/automation.json': ['pppoe', 'binding', 'jobs', 'events']
  }

  for (const [file, ids] of Object.entries(EXPECTED)) {
    it(`${file} groups into ${ids.join(', ')}`, () => {
      expect(railIds(specNamed(file))).toEqual(ids)
    })
  }

  it('leaves the Overview widget flat', () => {
    // It is one card on a grid, not a page. A rail inside it would be a rail
    // inside a 300px box.
    expect(rail(specNamed('widgets/summary.json'))).toBeNull()
  })
})

describe('each automation owns its own configuration', () => {
  /** The `checkMethod`/`submit` targets reachable inside one rail item. */
  function methodsIn(spec: Node, id: string): Set<string> {
    const found = rail(spec)
    const item = ((found?.['items'] as Node[]) ?? []).find((entry) => entry['id'] === id)
    const out = new Set<string>()
    for (const node of nodes(item?.['blocks'])) {
      if (typeof node['checkMethod'] === 'string') out.add(node['checkMethod'])
      if (typeof node['applyMethod'] === 'string') out.add(node['applyMethod'])
      const submit = node['submit'] as Node | undefined
      if (submit && typeof submit['method'] === 'string') out.add(submit['method'])
    }
    return out
  }

  const automation = (): Node => specNamed('pages/automation.json')

  it('no longer has a Create tab holding both of them', () => {
    // "Create" carried the PPPoE form, the binding form, a second copy of the
    // package installer and a second copy of the job monitor - four unrelated
    // jobs in one tab, and neither automation's own tab could create anything.
    expect(railIds(automation())).not.toContain('create')
  })

  it('creates a PPPoE pool from the PPPoE tab', () => {
    const methods = methodsIn(automation(), 'pppoe')
    expect(methods.has('poolCreateCheck')).toBe(true)
    expect(methods.has('poolCreateApply')).toBe(true)
    // ...and only that automation's create form.
    expect(methods.has('bindingCheck')).toBe(false)
  })

  it('creates a binding instance from the WAN Binding tab', () => {
    const methods = methodsIn(automation(), 'binding')
    expect(methods.has('bindingCheck')).toBe(true)
    expect(methods.has('bindingApply')).toBe(true)
    expect(methods.has('poolCreateCheck')).toBe(false)
  })

  it('tunes each automation from its own tab', () => {
    // The pool daemon's watchdog is a router setting reached from the PPPoE
    // tab; binding behaviour still edits the module's own rules from its tab.
    expect(methodsIn(automation(), 'pppoe').has('pppoeSettingsCheck')).toBe(true)
    expect(methodsIn(automation(), 'binding').has('rulesCheck')).toBe(true)
  })

  it('keeps only what both automations share on the settings page', () => {
    const settings = specNamed('pages/settings.json')
    const found = rail(settings)
    const rules = ((found?.['items'] as Node[]) ?? []).find((entry) => entry['id'] === 'rules')
    const titles = nodes(rules?.['blocks'])
      .filter((node) => node['type'] === 'section')
      .map((node) => node['title'])

    expect(titles).toContain('Numbering and firewall layout')
    expect(titles).toContain('Housekeeping')
    expect(titles).not.toContain('Batch pacing and limits')
    expect(titles).not.toContain('Binding behaviour')
  })
})

describe('each automation tab is grouped by its own rail', () => {
  /** The nested `subnav` an automation tab's blocks consist of, if any. */
  function nestedRail(spec: Node, id: string): Node | null {
    const found = rail(spec)
    const item = ((found?.['items'] as Node[]) ?? []).find((entry) => entry['id'] === id)
    const blocks = (item?.['blocks'] as Node[]) ?? []
    const first = blocks[0]
    return first && first['type'] === 'subnav' ? first : null
  }

  const itemIds = (nested: Node | null): unknown[] =>
    ((nested?.['items'] as Node[]) ?? []).map((item) => item['id'])

  it('groups the PPPoE tab into pools, create and daemon settings', () => {
    // Operate, create and tune are three different errands. On one scroll the
    // second and third lived below a table that can be a thousand rows tall.
    const nested = nestedRail(specNamed('pages/automation.json'), 'pppoe')
    expect(itemIds(nested)).toEqual(['pools', 'create', 'daemon'])
    expect(nested?.['initial']).toBe('pools')
  })

  it('groups the WAN Binding tab into instances, create and behaviour', () => {
    const nested = nestedRail(specNamed('pages/automation.json'), 'binding')
    expect(itemIds(nested)).toEqual(['instances', 'create', 'behaviour'])
    expect(nested?.['initial']).toBe('instances')
  })

  it('leaves nothing outside those rails', () => {
    // A block sitting beside the nested rail would show on every view of the
    // tab - which is the one-long-scroll problem coming back one block at a
    // time.
    for (const id of ['pppoe', 'binding']) {
      const found = rail(specNamed('pages/automation.json'))
      const item = ((found?.['items'] as Node[]) ?? []).find((entry) => entry['id'] === id)
      expect(((item?.['blocks'] as Node[]) ?? []).length).toBe(1)
    }
  })
})

describe('the hints toggle reaches everything it claims to', () => {
  it('leaves no inline field help anywhere', () => {
    // `FormField.help` renders as an always-on paragraph under its field and
    // nothing in the spec language can gate it, so fifty of them stayed on
    // screen with the toggle switched off. The prose lives in notes now.
    for (const file of specFiles()) {
      const helps = nodes(specNamed(file)).filter((node) => typeof node['help'] === 'string')
      expect({ file, helps: helps.length }).toEqual({ file, helps: 0 })
    }
  })

  it('gives every form an explanation that can be switched off', () => {
    for (const file of ['pages/settings.json', 'pages/automation.json']) {
      const spec = specNamed(file)
      const forms = nodes(spec).filter((node) => node['type'] === 'form' || node['type'] === 'checkForm')
      const fieldNotes = nodes(spec).filter(
        (node) => node['type'] === 'note' && node['title'] === 'What each field means'
      )
      // One per form that has anything to explain. The hints toggle is the only
      // thing between them and the reader.
      expect(fieldNotes.length).toBeGreaterThan(0)
      expect(forms.length).toBeGreaterThanOrEqual(fieldNotes.length)
    }
  })

  it('never gates a state banner on the toggle', () => {
    // Turning hints off must not hide "this router cannot be managed" or "the
    // numbers below are frozen". Those are not hints, and a page that went
    // quiet about them would be lying rather than tidy.
    const STATE_TITLES = [
      'Waiting for the router',
      'Waiting for a connection',
      'Nothing has been read off this router yet',
      'The numbers below are frozen',
      'Everything else on this page is still live',
      'Compatibility mode: no Bored Manager agent on this router'
    ]
    for (const file of specFiles()) {
      for (const node of nodes(specNamed(file))) {
        const when = node['when'] as Node | undefined
        const source = when?.['source'] as Node | undefined
        if (source?.['path'] !== 'hintsOn') continue
        const titles = nodes(node['blocks']).map((child) => child['title'])
        expect(titles.filter((title) => STATE_TITLES.includes(String(title)))).toEqual([])
      }
    }
  })
})

describe('the dashboard charts can be reached at more than one range', () => {
  it('offers several windows rather than pinning one', () => {
    // All four charts hardcoded a six-hour window, which overrode the range
    // picker the app draws above the page - so the control was visible and
    // inert, and every chart was six hours wide whatever anyone pressed.
    const windows = new Set<number>()
    for (const node of nodes(specNamed('pages/dashboard.json'))) {
      if (node['type'] === 'chart' && typeof node['window'] === 'number') {
        windows.add(node['window'])
      }
    }
    expect(windows.size).toBeGreaterThan(1)
  })
})
