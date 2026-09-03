/**
 * One reply from `bm.agent capacity`, turned into the payload the page renders.
 *
 * Nothing here sizes anything. The router did the arithmetic and this file
 * renders it: kilobytes to bytes because the renderer's `bytes` format wants
 * bytes, levels to chips, a ceiling to a percentage, a null to the word
 * "unknown". A second model on this side would be a second answer.
 *
 * The part that is not rendering, and is the reason this file is worth reading,
 * is `fixRows`. A reply is data that arrived over a wire; the fixes in it name
 * write paths on somebody's router. So a fix is copied into a row only when its
 * kind is one of five this module knows how to run *and* its arguments are ones
 * that kind may carry - a `tune_set` whose conntrack figure is outside the
 * tunable's own bounds is dropped, and an instance fix naming an instance this
 * same report does not list is dropped. A reply cannot ask this module to write
 * something it was not already willing to write.
 *
 * `FIELDS` is the other deliberate thing: every contract name the daemon uses
 * is written down once, so a rename on the router is one edit here rather than
 * a hunt through five files that each quietly read `undefined`.
 */
import type { ValueBadge } from '@shared/module-ui'
import type { AgentCapability } from '../probe'
import { agentAtLeast, CAPACITY_AGENT_RELEASE, type RawCapacity, type RawCapacityFinding } from '../agent'
import { BADGE, badge } from '../badges'
import type {
  CapacityFinding,
  CapacityFixKind,
  CapacityFixRow,
  CapacitySnapshot,
  CapacityTierRow,
  StabilityLevel
} from './types'

/** How often the tab asks, while somebody has it open. */
export const CAPACITY_INTERVAL_MS = 60_000

/**
 * How old a report may be and still be a thing to apply a fix against.
 *
 * A fix is decided from what the report said - which conntrack figure, which
 * instance, whether the kernel has a flowtable. Five minutes later the router
 * may have been changed by somebody else, and pressing a button built on the
 * old answer would write a number nobody chose.
 */
export const CAPACITY_REPORT_MAX_AGE_MS = 300_000

/** Every contract name, in one place. */
const FIELDS = {
  stability: 'stability',
  ceiling: 'ceiling',
  tiers: 'tiers',
  requirements: 'requirements',
  issues: 'issues'
} as const

const FIX_KINDS: ReadonlySet<string> = new Set<CapacityFixKind>([
  'tune_set',
  'wanbind_reconcile',
  'wanbind_settings_set',
  'wanbind_instance_set',
  'pool_reconcile'
])

/** `bm.tune`'s own bounds, mirrored so a bad figure is refused before it travels. */
const TUNE_BOUNDS: Readonly<Record<string, { min: number; max: number }>> = {
  conntrack_max: { min: 16_384, max: 4_194_304 },
  gc_thresh1: { min: 128, max: 1_048_576 },
  gc_thresh2: { min: 128, max: 1_048_576 },
  gc_thresh3: { min: 128, max: 1_048_576 }
}

const STABILITY_LABEL: Readonly<Record<StabilityLevel, string>> = {
  unknown: 'not enough is known',
  unstable: 'unstable',
  'at-risk': 'at risk',
  stable: 'stable'
}


function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}

/** A number the router gave, or null. Never a zero standing in for silence. */
function figure(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function bytes(kb: unknown): number | null {
  const value = figure(kb)
  return value === null ? null : value * 1024
}

function decimal(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** `true`/`false`/`null` as three words, because the third is a real answer. */
function tristate(value: unknown, yes = 'on', no = 'off'): string {
  if (value === true) return yes
  if (value === false) return no
  return 'unknown'
}

function pct(part: number, whole: number | null): number | null {
  if (whole === null || whole <= 0) return null
  return Math.min(100, Math.round((part / whole) * 100))
}

function statusOf(level: string): string {
  if (level === 'error') return 'bad'
  if (level === 'warning') return 'warn'
  return 'ok'
}

function levelBadges(level: string): ValueBadge[] {
  if (level === 'error') return [badge('problem', BADGE.bad)]
  if (level === 'warning') return [badge('warning', BADGE.warn)]
  if (level === 'pass') return [badge('ok', BADGE.good)]
  return [badge('note')]
}

function stabilityOf(value: unknown): StabilityLevel {
  const one = text(value)
  if (one === 'unstable' || one === 'at-risk' || one === 'stable') return one
  return 'unknown'
}

/**
 * Whether a fix's arguments are ones its kind is allowed to carry.
 *
 * The allowlist is per kind rather than per key, because the kinds are not
 * interchangeable: `wanbind_settings_set` may carry exactly one setting and
 * `wanbind_instance_set` may carry exactly one instance's raise. A reply that
 * asked for `enabled: false` under a settings fix would be asking this module
 * to switch the daemon off through a button labelled "fix".
 */
function fixArgs(
  kind: CapacityFixKind,
  args: Record<string, unknown>,
  instances: ReadonlySet<string>
): Record<string, string | number | boolean> | null {
  if (kind === 'wanbind_reconcile' || kind === 'pool_reconcile') return {}

  if (kind === 'wanbind_settings_set') {
    if (args.lan_local !== true) return null
    if (Object.keys(args).length !== 1) return null
    return { lan_local: true }
  }

  if (kind === 'wanbind_instance_set') {
    const id = text(args.id)
    if (!id || args.raise_dhcp_limits !== true) return null
    if (Object.keys(args).length !== 2) return null
    // Named in this same report, or it is an instance this module cannot see -
    // and a button that writes to one it cannot see is a button nobody can
    // check before pressing.
    if (!instances.has(id)) return null
    return { id, raise_dhcp_limits: true }
  }

  const out: Record<string, string | number | boolean> = {}

  for (const [key, value] of Object.entries(args)) {
    if (key === 'flow_offload') {
      if (value !== true) return null
      out.flow_offload = true
      continue
    }

    const bounds = TUNE_BOUNDS[key]
    if (!bounds) return null

    const number = figure(value)
    if (number === null || number < bounds.min || number > bounds.max) return null
    out[key] = number
  }

  return Object.keys(out).length > 0 ? out : null
}

function findingRows(
  raw: RawCapacityFinding[] | undefined,
  fixable: ReadonlySet<string>
): CapacityFinding[] {
  const out: CapacityFinding[] = []

  for (const one of raw ?? []) {
    const key = text(one.key)
    if (!key) continue

    const level = text(one.level) || 'info'

    out.push({
      key,
      level,
      status: statusOf(level),
      levelBadges: levelBadges(level),
      label: text(one.label),
      detail: text(one.detail),
      fixable: fixable.has(key)
    })
  }

  return out
}

/** Nothing has been asked yet, which is not the same as a router that cannot answer. */
export function emptyCapacitySnapshot(): CapacitySnapshot {
  return {
    state: 'unknown',
    at: 0,
    stale: false,
    estimate: true,
    reason: '',
    agentRelease: '',
    summary: {
      stability: '',
      reason: '',
      limitedBy: '',
      ceiling: '',
      tierNow: '',
      tierNext: '',
      calibratedOn: '',
      at: 0
    },
    hardware: {
      board: '',
      arch: '',
      target: '',
      cpuModel: '',
      cpus: null,
      kernel: '',
      memTotal: null,
      memAvailable: null,
      flashTotal: null,
      flashFree: null,
      nicCount: null,
      load1: 0,
      load5: 0,
      load15: 0
    },
    software: {
      release: '',
      agent: '',
      wanbind: '',
      pppoe: '',
      fw4: '',
      fw4Loaded: '',
      flowOffload: '',
      hwOffload: '',
      conntrackMax: null,
      conntrackCount: null,
      conntrackPct: null,
      gcThresh3: null,
      ipRules: null,
      leaseMax: null
    },
    load: {
      sessions: 0,
      bindings: 0,
      instances: 0,
      pools: 0,
      clients: 0,
      sessionsUp: 0,
      bound: 0,
      leases: 0,
      wanbind: '',
      pppoe: ''
    },
    needed: {
      mem: null,
      cpus: null,
      flash: null,
      flowOffload: '',
      conntrackMax: null,
      gcThresh3: null,
      leaseMax: null,
      pools: null,
      prefs: null
    },
    ceiling: {
      sessions: null,
      bindings: null,
      limitedBy: '',
      sessionsPct: null,
      bindingsPct: null,
      sentence: '',
      basis: ''
    },
    tier: { current: '', currentLabel: '', nextAt: null, nextChanges: [], rows: [] },
    stability: { level: 'unknown', label: STABILITY_LABEL.unknown, reason: '', attention: false },
    requirements: [],
    issues: [],
    fixes: [],
    fixCount: 0
  }
}

/** A router that cannot produce a report, and the sentence saying why. */
export function unavailableCapacity(reason: string, release: string): CapacitySnapshot {
  return { ...emptyCapacitySnapshot(), state: 'unavailable', reason, agentRelease: release }
}

/**
 * The sentence for a router whose agent predates the verb.
 *
 * Named rather than inlined at its three call sites: an agent that is too old,
 * one that answers "Method not found" anyway, and one that is not installed at
 * all all end in a person going to the same page.
 */
export function capacityNeedsUpdate(capability: AgentCapability): string {
  if (!capability.usable) {
    return 'There is no Bored Manager agent answering on this router, so nothing here can be worked out. Install the router packages from Module settings, Router packages.'
  }

  const release = text(capability.release) || 'an older release'

  return `This router's bm-agent is ${release}, and the capacity report arrived in ${CAPACITY_AGENT_RELEASE}. Update the router packages from Module settings, Router packages; everything else keeps working meanwhile.`
}

export function capacityAvailable(capability: AgentCapability): boolean {
  return agentAtLeast(capability, CAPACITY_AGENT_RELEASE)
}

function tierRows(raw: RawCapacity): CapacityTierRow[] {
  const table = raw[FIELDS.tiers]?.sessions
  const now = text(table?.current)
  const rows: CapacityTierRow[] = []

  // The sessions ladder, which is the one that changes what a router needs.
  // The bindings ladder is a line in the summary rather than a second table:
  // two ladders side by side reads as four tiers rather than two questions.
  const ladder: Array<{ id: string; range: string }> = [
    { id: 's0', range: 'up to 64 sessions' },
    { id: 's1', range: '65 to 500' },
    { id: 's2', range: '501 to 1000' },
    { id: 's3', range: 'over 1000' }
  ]

  for (const step of ladder) {
    const here = step.id === now
    const needs = here ? (table?.needs ?? []) : step.id === nextOf(now) ? (table?.next?.changes ?? []) : []

    rows.push({
      id: step.id,
      label: step.range,
      range: step.range,
      needs: needs.map((one) => text(one)).filter(Boolean),
      stateBadges: here ? [badge('you are here', BADGE.busy)] : []
    })
  }

  return rows
}

function nextOf(id: string): string {
  if (id === 's0') return 's1'
  if (id === 's1') return 's2'
  if (id === 's2') return 's3'
  return ''
}

/**
 * The whole reply, rendered.
 *
 * `now` is passed rather than taken, so a caller replaying a stored payload
 * gets the same staleness the tick that built it would have.
 */
export function normalizeCapacity(
  raw: RawCapacity,
  now: number,
  capability: AgentCapability
): CapacitySnapshot {
  const out = emptyCapacitySnapshot()
  const hardware = raw.hardware ?? {}
  const software = raw.software ?? {}
  const load = raw.load ?? {}
  const configured = load.configured ?? {}
  const live = load.live ?? {}
  const needed = raw.needed ?? {}
  const ceiling = raw[FIELDS.ceiling] ?? {}
  const stability = stabilityOf(raw[FIELDS.stability]?.level)

  // Every instance this report names, which is the set a fix may address.
  const instances = new Set<string>()
  const named = text(load.instanceId)
  if (named) instances.add(named)

  const fixes = fixRows(raw, instances)
  const fixable = new Set(fixes.map((one) => one.key))

  out.state = 'ready'
  // This machine's clock, not the router's.
  //
  // `raw.at` is `time()` on the router, and staleness is `now - at` measured
  // here - so a router whose clock is a year out made every report either
  // permanently stale (and every Fix permanently refused) or never stale (and
  // every Fix applied against whatever the report last said). The moment the
  // reply arrived is the thing staleness is actually about, and this side is
  // the only one that knows it.
  out.at = now
  out.agentRelease = text(capability.release)
  out.estimate = true

  out.hardware = {
    board: text(hardware.board) || 'unknown',
    arch: text(hardware.arch) || 'unknown',
    target: text(hardware.target) || 'unknown',
    cpuModel: text(hardware.cpuModel) || 'unknown',
    cpus: figure(hardware.cpus),
    kernel: text(hardware.kernel) || 'unknown',
    memTotal: bytes(hardware.memTotalKb),
    memAvailable: bytes(hardware.memAvailableKb),
    flashTotal: bytes(hardware.flashTotalKb),
    flashFree: bytes(hardware.flashFreeKb),
    nicCount: hardware.nicsKnown ? count(hardware.nicCount) : null,
    load1: decimal(hardware.load1),
    load5: decimal(hardware.load5),
    load15: decimal(hardware.load15)
  }

  const packages = software.packages ?? {}
  const conntrackMax = figure(software.conntrackMax)
  const conntrackCount = figure(software.conntrackCount)

  out.software = {
    release: text(software.release) || 'unknown',
    agent: text(packages.agent) || 'unknown',
    wanbind: text(packages.wanbind) || 'not installed',
    pppoe: text(packages.pppoe) || 'not installed',
    fw4: software.fw4 === true ? 'installed' : 'missing',
    fw4Loaded: tristate(software.fw4Loaded, 'loaded', 'not loaded'),
    flowOffload: tristate(software.flowOffload),
    hwOffload: `${tristate(software.hwOffload?.configured)}, this target ${text(software.hwOffload?.capable) || 'unknown'}`,
    conntrackMax,
    conntrackCount,
    conntrackPct:
      conntrackCount === null || conntrackMax === null ? null : pct(conntrackCount, conntrackMax),
    gcThresh3: figure(software.gcThresh3),
    ipRules: figure(live.ipRules),
    leaseMax: figure(software.leaseMax)
  }

  out.load = {
    sessions: count(configured.members),
    bindings: count(configured.bindings),
    instances: count(configured.instances),
    pools: (configured.pools ?? []).length,
    clients: count(load.clients),
    sessionsUp: count(live.sessionsUp),
    bound: count(live.bound),
    leases: count(live.leases),
    wanbind: load.answered?.wanbind ? 'answering' : 'not answering',
    pppoe: load.answered?.pppoe ? 'answering' : 'not answering'
  }

  out.needed = {
    mem: bytes(needed.memKb),
    cpus: figure(needed.cpus),
    flash: bytes(needed.flashKb),
    flowOffload: needed.flowOffload === true ? 'required at this size' : 'not required at this size',
    conntrackMax: figure(needed.conntrackMax),
    gcThresh3: figure(needed.gcThresh3),
    leaseMax: figure(needed.leaseMax),
    pools: figure(needed.pools),
    prefs: figure(needed.prefs)
  }

  const ceilingSessions = figure(ceiling.sessions)
  const ceilingBindings = figure(ceiling.bindings)
  const limitedBy = text(ceiling.limitedBy?.sessions)
  const basis = ceiling.basis ?? {}

  out.ceiling = {
    sessions: ceilingSessions,
    bindings: ceilingBindings,
    limitedBy,
    sessionsPct: pct(out.load.sessions, ceilingSessions),
    bindingsPct: pct(out.load.bindings, ceilingBindings),
    sentence: ceilingSentence(ceilingSessions, ceilingBindings, limitedBy, text(ceiling.limitedBy?.bindings)),
    basis:
      basis.calibrated === true
        ? `Calibrated on ${text(basis.calibratedOn) || 'a rig'}.`
        : 'Working numbers: no rig has measured this hardware yet, so treat the ceilings as a rough guide.'
  }

  const tiers = raw[FIELDS.tiers] ?? {}

  out.tier = {
    current: text(tiers.sessions?.current),
    currentLabel: text(tiers.sessions?.label),
    nextAt: figure(tiers.sessions?.next?.at),
    nextChanges: (tiers.sessions?.next?.changes ?? []).map((one) => text(one)).filter(Boolean),
    rows: tierRows(raw)
  }

  out.stability = {
    level: stability,
    label: STABILITY_LABEL[stability],
    reason: text(raw[FIELDS.stability]?.reason),
    attention: stability === 'unstable' || stability === 'at-risk'
  }

  out.requirements = findingRows(raw[FIELDS.requirements], fixable)
  out.issues = findingRows(raw[FIELDS.issues], fixable)
  out.fixes = fixes
  out.fixCount = fixes.length

  out.summary = {
    stability: `${out.stability.label} - ${out.stability.reason}`,
    reason: out.stability.reason,
    limitedBy: limitedBy || 'nothing measured',
    ceiling: out.ceiling.sentence,
    tierNow: out.tier.currentLabel,
    tierNext:
      out.tier.nextAt === null
        ? 'this is the last tier this release plans for'
        : `${out.tier.nextAt} sessions: ${out.tier.nextChanges.join('; ') || 'no change'}`,
    calibratedOn: out.ceiling.basis,
    at: out.at
  }

  return withStaleness(out, now)
}

function ceilingSentence(
  sessions: number | null,
  bindings: number | null,
  bySessions: string,
  byBindings: string
): string {
  const left =
    sessions === null
      ? 'The session ceiling could not be worked out'
      : `About ${sessions} sessions${bySessions ? `, limited by ${bySessions}` : ''}`
  const right =
    bindings === null
      ? 'and the binding ceiling could not either'
      : `and about ${bindings} bindings${byBindings ? `, limited by ${byBindings}` : ''}`

  return `${left} ${right}, on this hardware and these settings. An estimate.`
}

function fixRows(raw: RawCapacity, instances: ReadonlySet<string>): CapacityFixRow[] {
  const out: CapacityFixRow[] = []
  const seen = new Set<string>()

  for (const one of [...(raw[FIELDS.requirements] ?? []), ...(raw[FIELDS.issues] ?? [])]) {
    const key = text(one.key)
    const kind = text(one.fix?.kind)

    if (!key || !kind || seen.has(key)) continue
    if (!FIX_KINDS.has(kind)) continue

    const args = fixArgs(kind as CapacityFixKind, one.fix?.args ?? {}, instances)
    if (args === null) continue

    seen.add(key)
    out.push({
      key,
      kind: kind as CapacityFixKind,
      label: text(one.label),
      action: '',
      writer: '',
      args
    })
  }

  return out
}

/**
 * Whether a payload has aged out, worked out at read time rather than emitted.
 *
 * A tick does not fire when nobody has the tab open, so the payload a page
 * replays can be arbitrarily old - and `stale` is what stops a fix being
 * applied against it. Deciding it when the snapshot is asked for is the only
 * way that is right for a payload nobody has refreshed.
 */
export function withStaleness(snapshot: CapacitySnapshot, now: number): CapacitySnapshot {
  if (snapshot.state !== 'ready' || snapshot.at <= 0) return snapshot

  const stale = now - snapshot.at > CAPACITY_REPORT_MAX_AGE_MS

  return stale === snapshot.stale ? snapshot : { ...snapshot, stale }
}
