/**
 * Every row this domain renders, built from what the router said.
 *
 * Nothing here decides anything and nothing here reaches the router. The
 * daemon hands over the instances it is keeping, the seats it has handed out,
 * the queue behind them and the one-to-one bindings it holds; this file turns
 * those into the shapes `types.ts` declares and does no arithmetic the router
 * could have done itself. That division is the whole arrangement of 3.4.0: a
 * builder that worked something out for itself would be a second opinion about
 * a router that has already answered, and two opinions about one binding is
 * exactly what the old pair of writers was.
 *
 * The one thing the daemon is not asked for is the live state of an interface,
 * and that half lives next door in `pool.ts` - it is the only code here that
 * reads the fast sweep rather than a reply, which is why it is a file of its
 * own rather than a section of this one.
 */
import type { ValueBadge } from '@shared/module-ui'
import type {
  WanbindAssignment,
  WanbindBindingsReply,
  WanbindInfo,
  WanbindInstanceConfig,
  WanbindWaiting
} from '../agent'
import { BADGE, badge, countBadges, statusBadges } from '../badges'
import type { RouterModel } from '../types'
import { poolWans, summarizeWans, wanState, wanView, type PoolWan } from './pool'
import type {
  BindingAssignmentRow,
  BindingDeviceSummary,
  BindingListRow,
  BindingWaitingRow,
  BindingWanSummary,
  DirectRow,
  DirectTotals
} from './types'

/**
 * Two of the daemon's shapes, named through the replies that carry them.
 *
 * Neither leaves the agent barrel under its own name - the newer
 * `WanbindBinding` cannot, because the 2.3.0 file still owns that spelling for
 * `direct/`, and reaching past a barrel is what the size gate refuses. Indexing
 * the reply is the same type by definition, so it cannot drift from the
 * contract the way a hand-copied interface would; both aliases go the day the
 * older file does.
 */
type InstanceState = WanbindInfo['instances'][number]
type RouterBinding = WanbindBindingsReply['bindings'][number]

/**
 * The router counts in whole seconds on its own wall clock; this side counts in
 * milliseconds on the app's. Every timestamp that arrives from the daemon is
 * multiplied on the way in, because passed through raw it reports every seat as
 * taken in 1970 - the same mistake `binding/router.ts` documents one folder
 * away, made once per surface until it was done in one place.
 */
function routerMs(seconds: number): number {
  return seconds > 0 ? seconds * 1_000 : 0
}

export function durationLabel(msRaw: number): string {
  const seconds = Math.max(0, Math.floor(msRaw / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function emptyDeviceSummary(): BindingDeviceSummary {
  return { total: 0, bound: 0, waiting: 0 }
}

// -------------------------------------------------------------- instance rows

/**
 * Which addresses this instance serves, in the words the row can print.
 *
 * `whole LAN` is spelled out rather than left blank: an empty cell reads as
 * "not known yet" rather than as an answer, and a range instance showing only
 * its bridge name is how a device left outside the window came to look like a
 * seat the pass had lost.
 */
function scopeLabel(config: WanbindInstanceConfig): string {
  return config.rangeFrom && config.rangeTo
    ? `${config.rangeFrom} - ${config.rangeTo}`
    : 'whole LAN'
}

/**
 * The clients-per-WAN number as a sentence, because none of its three readings
 * follow from the digit - and 0 read as "none" rather than as "no limit" is the
 * one that makes a working instance look broken.
 */
function capacityLabel(clientsPerWan: number): string {
  if (clientsPerWan <= 0) return 'no limit'
  if (clientsPerWan === 1) return 'one client per WAN'
  return `${clientsPerWan} clients per WAN`
}

/**
 * What this instance is doing, as chips.
 *
 * A refused section says only that, in the words the one-to-one table already
 * uses for the same condition - it installs no rule, seats nobody and appears
 * in no other table, so counts of zero beside it would describe a healthy empty
 * instance rather than one the router threw out. A stopped one says only that
 * too. `running` on its own is the chip for the instant after a start, before
 * the first pass has anything to count.
 */
function instanceStateBadges(
  refused: boolean,
  running: boolean,
  wan: BindingWanSummary,
  devices: BindingDeviceSummary
): ValueBadge[] {
  if (refused) return [badge('the router refused it', BADGE.bad)]
  if (!running) return [badge('stopped')]
  const chips = countBadges([
    { label: 'WAN error', count: wan.error, color: BADGE.bad },
    { label: 'waiting', count: devices.waiting, color: BADGE.warn },
    { label: 'dialing', count: wan.dialing, color: BADGE.busy },
    { label: 'bound', count: devices.bound, color: BADGE.good }
  ])
  return chips.length ? chips : [badge('running', BADGE.good)]
}

function instanceRow(
  config: WanbindInstanceConfig,
  state: InstanceState | undefined,
  halfEnabled: boolean,
  model: RouterModel | null,
  carrying: ReadonlySet<string>
): BindingListRow {
  // Three facts, not one. A section switched on inside a daemon whose instance
  // half is switched off is seating nobody, and neither is one the daemon has
  // not managed to make ready - so "running" asks all three rather than
  // reporting the presence of the section, which is what `enabled` alone says.
  const running = halfEnabled && config.enabled && state?.ready === true
  const wan = summarizeWans(
    poolWans(model, config.lan, config.carrier),
    config.wanWarnUptime,
    carrying
  )
  const devices: BindingDeviceSummary = {
    total: state?.devices ?? 0,
    bound: state?.bound ?? 0,
    // Held devices are in the Waiting table beside the queued ones, so the
    // count that labels that table has to include them. Counting only the queue
    // put a row on screen that no number on the page accounted for.
    waiting: (state?.waiting ?? 0) + (state?.held ?? 0)
  }
  return {
    id: config.id,
    name: config.name || config.id,
    lan: config.lan,
    carrier: config.carrier,
    running,
    runningLabel: running ? 'running' : 'stopped',
    sticky: config.sticky,
    remap: config.remap,
    scope: scopeLabel(config),
    clientsPerWan: config.clientsPerWan,
    capacityLabel: capacityLabel(config.clientsPerWan),
    // The refusal first: a section the daemon would not read has no pass behind
    // it to have said anything else, and it is the only sentence that row will
    // ever get. `reason` on a section it did read is the last pass's own.
    reason: config.reason ?? state?.reason ?? '',
    stateBadges: instanceStateBadges(!config.usable, running, wan, devices),
    wan,
    devices,
    wanTotal: wan.total,
    wanAvailable: wan.available,
    wanBound: wan.bound,
    wanError: wan.error,
    wanWarning: wan.warning,
    wanDialing: wan.dialing,
    deviceTotal: devices.total,
    deviceBound: devices.bound,
    deviceWaiting: devices.waiting
  }
}

/**
 * Every instance the router is configured with, refused ones included.
 *
 * Built from `configured` rather than from `instances`, and that is the whole
 * reason both lists are in the reply: a section the daemon would not accept has
 * no running state at all, and a table drawn from the running ones would leave
 * the operator with an instance they created, cannot see and cannot delete.
 */
export function instanceRows(
  info: WanbindInfo | null,
  model: RouterModel | null,
  assignments: readonly WanbindAssignment[]
): BindingListRow[] {
  if (!info) return []
  const states = new Map<string, InstanceState>()
  for (const state of info.instances) states.set(state.id, state)

  // Which WANs are carrying somebody, from the seats rather than from any count
  // in the reply: above one client per WAN the number of seats and the number
  // of lines in use are different numbers, and the pool tile is about lines.
  const carrying = new Map<string, Set<string>>()
  for (const seat of assignments) {
    const set = carrying.get(seat.instance) ?? new Set<string>()
    set.add(seat.wan)
    carrying.set(seat.instance, set)
  }

  return info.configured.map((config) =>
    instanceRow(
      config,
      states.get(config.id),
      info.enabled,
      model,
      carrying.get(config.id) ?? EMPTY_NAMES
    )
  )
}

const EMPTY_NAMES: ReadonlySet<string> = new Set<string>()

// ------------------------------------------------------------ assignment rows

/**
 * One row per seat.
 *
 * `wanStatus` is the WAN's own condition with one word changed: a healthy line
 * that this device is on reads `bound` rather than `available`, because the
 * question the column answers is "is this device's connection working", and
 * `available` there would read as though nobody were using it.
 */
export function assignmentRows(
  info: WanbindInfo | null,
  model: RouterModel | null,
  assignments: readonly WanbindAssignment[],
  now: number
): BindingAssignmentRow[] {
  const warnByInstance = new Map<string, number>()
  for (const config of info?.configured ?? []) {
    warnByInstance.set(config.id, config.wanWarnUptime)
  }
  const wanByName = new Map<string, PoolWan>()
  for (const iface of model?.ifaces ?? []) wanByName.set(iface.name, wanView(iface))

  return assignments.map((seat) => {
    const wan = wanByName.get(seat.wan)
    // `missing` rather than a guess: the daemon says this device is on a WAN
    // the sweep cannot find, which is a real and alarming condition - an
    // interface renamed or deleted under a running instance - and inventing
    // `error` for it would file it beside every WAN that is merely down.
    const state = wan ? wanState(wan, warnByInstance.get(seat.instance) ?? 0) : 'missing'
    const wanStatus = state === 'available' ? 'bound' : state
    const assignedAt = routerMs(seat.assignedAt)
    return {
      key: `${seat.instance}|${seat.mac}`,
      instanceId: seat.instance,
      host: seat.host,
      mac: seat.mac,
      ip: seat.ip,
      wan: seat.wan,
      wanIp: wan?.ipv4 ?? '',
      wanStatus,
      wanStatusBadges: statusBadges(wanStatus),
      assignedAt,
      sinceLabel: assignedAt ? durationLabel(now - assignedAt) : ''
    }
  })
}

// --------------------------------------------------------------- waiting rows

/**
 * Why a device is not seated, in this module's four words rather than the
 * daemon's sentence.
 *
 * Keyed on `why`, which is the code the contract put there for exactly this:
 * the sentence beside it is prose and branching on it breaks the first time
 * either half rewords it. `reserved` is checked first because it outranks the
 * other three as an explanation - the address already has a WAN, from the
 * one-to-one half, and nothing on this page will ever move it.
 */
const WAITING_REASON: Readonly<Record<string, string>> = {
  reserved: 'bound one-to-one',
  held: 'unassigned by hand',
  exhausted: 'preferences exhausted',
  queued: 'waiting for a free WAN'
}

/**
 * What that condition looks like, in chips.
 *
 * Three of the four are not "waiting" in any sense somebody could act on, and
 * a table that chipped them all `waiting` was telling the operator to free a
 * WAN in three cases where freeing one changes nothing: a held device is out of
 * the pool because somebody put it there, a reserved one is already bound by
 * the other half, and an exhausted one has run out of rule priorities rather
 * than of lines. Exhausted gets the second chip for the reason every pair in
 * the one-to-one table does - the first names the condition, the second says
 * what will not fix it.
 */
function waitingBadges(why: string): ValueBadge[] {
  if (why === 'held') return statusBadges('held')
  if (why === 'reserved') return [badge('bound one-to-one')]
  if (why === 'exhausted') {
    return [...statusBadges('waiting'), badge('no priority left', BADGE.bad)]
  }
  return statusBadges('waiting')
}

function waitingLabel(why: string, held: boolean): string {
  if (held || why === 'held') return 'Held'
  if (why === 'reserved') return 'Reserved'
  return 'Waiting'
}

/**
 * The queue, and everybody else this instance is not serving.
 *
 * `position` is counted here rather than taken from the reply: the daemon's
 * `order` is a ticket number that only ever goes up, so printing it as a place
 * in the queue would tell the fourth person waiting that they are 1,207th.
 * Devices with no ticket - held, and reserved - get 0, which is the honest
 * statement that they are not in a queue at all.
 */
export function waitingRows(
  waiting: readonly WanbindWaiting[],
  now: number
): BindingWaitingRow[] {
  const places = new Map<string, number>()
  return waiting.map((entry) => {
    let position = 0
    if (entry.order > 0) {
      position = (places.get(entry.instance) ?? 0) + 1
      places.set(entry.instance, position)
    }
    const since = routerMs(entry.since)
    return {
      key: `${entry.instance}|${entry.mac}`,
      instanceId: entry.instance,
      mac: entry.mac,
      host: entry.host,
      ip: entry.ip,
      position,
      waitingSince: since,
      waitingFor: since ? durationLabel(now - since) : '',
      reason: WAITING_REASON[entry.why] ?? entry.reason,
      held: entry.held,
      heldLabel: waitingLabel(entry.why, entry.held),
      holdBadges: waitingBadges(entry.why)
    }
  })
}

// -------------------------------------------------------------- binding rows

/**
 * The two `When that WAN is down` choices, worded exactly as the create form
 * and the row's own edit form word them.
 *
 * The column used to print the stored value, and `fallback` is also the word
 * the State chips use for a binding whose WAN is down right now - so one table
 * carried the same word for a setting and for a condition, and a row reading
 * "fallback / fallback" said nothing at all.
 */
const WHEN_DOWN_LABELS: Readonly<Record<string, string>> = {
  hold: 'Keep it off the internet',
  fallback: 'Let it use the default connection'
}

/**
 * Whether this binding's rule points at the blackhole - the catch-all table
 * with nothing but an unreachable default in it.
 *
 * `held` is the obvious half. The other is a `stranded` binding whose owner
 * chose to park it: the device has walked off the LAN its firewall forwarding
 * was written from, and the daemon writes it exactly the rule a hold gets, so
 * the address has precisely as little way out. Asked once, from the row's own
 * two fields, because the Overview tile and the row's chips disagreeing about
 * one binding is what let a detained device be reported as nothing at all - and
 * the tile is counted from the rows, so it has to be answerable from a row.
 */
function parked(state: string, whenDown: string): boolean {
  return state === 'held' || (state === 'stranded' && whenDown === 'hold')
}

/**
 * What a state means, in chips.
 *
 * Each state that means something is wrong gets two, and the pair always has
 * the same shape: the first names the condition, the second names where the
 * address actually comes out. One word cannot carry both halves of what a hold
 * does, and the half that matters to whoever is reading the row is the second -
 * the address is not slow or degraded, it has no way out at all until its WAN
 * comes back.
 */
function bindingBadges(binding: RouterBinding): ValueBadge[] {
  const state = binding.state
  // Not a failure and not a state: the section was written and no pass has
  // reached it yet. Saying `waiting` here would put it beside the devices an
  // instance cannot seat, which is a different and permanent-looking thing.
  if (!state) return [badge('no pass yet')]
  if (state === 'bound') return statusBadges('bound')
  if (state === 'held') return [...statusBadges('held'), badge('no way out', BADGE.bad)]
  if (state === 'fallback') {
    // "default connection" alone read as though the binding had been taken off
    // the router. It has a rule, pointing at the main table, and that rule is
    // the whole reason the address reaches the default connection rather than
    // an instance catch-all - so the chip names it.
    return [badge('WAN down', BADGE.bad), badge('on the main table', BADGE.warn)]
  }
  if (state === 'stranded') {
    // The second chip used to read "no firewall path", which is true of both
    // halves and therefore says nothing about the only difference that matters:
    // a parked binding is off the internet, a fallen-back one is quietly
    // leaking past the metered line it was pinned to.
    return [
      badge('moved off its LAN', BADGE.bad),
      parked(state, binding.whenDown)
        ? badge('no way out', BADGE.bad)
        : badge('on the main table', BADGE.warn)
    ]
  }
  if (state === 'shadowed') {
    // The second chip names the other binding, because that row is the only
    // thing that can be edited or deleted to resolve this one, and a table of
    // two identical addresses gives no clue which of them is in force.
    return [
      badge('not in force', BADGE.bad),
      badge(
        binding.shadowedBy ? `held by ${binding.shadowedBy}` : 'address already bound',
        BADGE.warn
      )
    ]
  }
  if (state === 'refused') {
    // The second chip is the one that matters: a section the daemon would not
    // accept installs nothing at all, so the address is wherever it would have
    // been with no binding in the file. A single red chip reads as "broken and
    // detained", which is the opposite of what happened to the traffic.
    return [badge('the router refused it', BADGE.bad), badge('no rule written', BADGE.warn)]
  }
  if (state === 'waiting') return statusBadges('waiting')
  return [badge('disabled')]
}

/**
 * The kernel's main table by number, because that is how the daemon reads it
 * back over netlink - while `ip rule show` prints the word.
 */
const MAIN_TABLE = 254

/**
 * What the router has standing for this binding, written the way `ip rule show`
 * writes it, so the two can be held side by side by eye.
 *
 * The live table rather than the stamped one. A table of 0 is the daemon saying
 * there is no rule - a refused section, a disabled binding, or one whose
 * priority it could not allocate - and an invented line would be the one thing
 * worse than an empty cell.
 */
function ruleLine(binding: RouterBinding): string {
  if (!binding.ip || binding.table <= 0) return ''
  const table = binding.table === MAIN_TABLE ? 'main' : String(binding.table)
  return `from ${binding.ip}/32 lookup ${table} pref ${binding.pref}`
}

/**
 * The chip for a binding the router is steering with no firewall path behind
 * it, or null when there is nothing to say.
 *
 * Worded for what the reader has to do rather than with the daemon's token. The
 * two silent states are the ones that matter: they mean traffic leaves by the
 * rule and is then not forwarded or not masqueraded, on a row that otherwise
 * reads as working.
 */
function forwardingBadge(binding: RouterBinding): ValueBadge | null {
  if (!binding.enabled) return null
  switch (binding.forwarding) {
    case 'no-zone':
      // Not "no firewall path", which this table retired as ambiguous: it was
      // true of two conditions that call for different things, so it said
      // nothing about the one that mattered. This chip names the condition -
      // the router has no zone for one end of this binding - which is what a
      // person has to go and fix.
      return badge('no firewall zone', BADGE.bad)
    case 'no-lan':
      return badge('no LAN to forward from', BADGE.bad)
    case 'missing':
    case 'wrong':
      // Only once the rest of the binding is working: before that this is the
      // ordinary state of a binding between its create and the next pass.
      return binding.state === 'bound' ? badge('firewall path pending', BADGE.warn) : null
    default:
      return null
  }
}

/**
 * One binding as the table renders it - a seat an instance handed out and a
 * section somebody wrote by hand, through one builder.
 *
 * They differ in `source` and in nothing else, which is the point of having one
 * builder: the daemon reconciles both against the same rules and reports both
 * in the same shape, and a second builder is how a column comes to mean two
 * things depending on which kind of row it is on.
 *
 * `state` is passed through untouched, its empty value included. `direct/`
 * folded that into `waiting` or `disabled`, which was the right answer while
 * the empty state meant "this module has not got to it"; here it means the
 * router has not, and inventing a third word for it would leave the two halves
 * describing one condition differently.
 */
export function bindingRow(binding: RouterBinding, now: number): DirectRow {
  const since = routerMs(binding.since)
  const rule = ruleLine(binding)
  const badges = bindingBadges(binding)
  // Reported apart from the state because the two really are different
  // questions: a binding can be perfectly configured, accepted, carrying a rule
  // line in this very cell, and have nothing standing in the kernel. A row that
  // said `bound` through that is the most misleading thing this table could
  // say, so the chip goes on beside whatever the state is.
  if (rule && !binding.verified) badges.push(badge('no rule standing', BADGE.missing))
  // The other half of the same question, and the half that was silent.
  //
  // `no-zone` and `no-lan` are the daemon saying it will not even attempt a
  // forwarding for this binding - not that one failed - so nothing is logged
  // and nothing else on the row moves: the rule stands, `verified` is true and
  // the state is `bound`. `missing` and `wrong` are a forwarding the next pass
  // will write, which is ordinary and would be noise on every create, so they
  // are chipped only once the binding is otherwise working and the pass has
  // therefore already had its chance.
  const path = forwardingBadge(binding)
  if (path) badges.push(path)
  return {
    id: binding.id,
    // The daemon falls back to the section name itself, so this is belt and
    // braces - but an empty Name column is unreadable and a row nobody can
    // point at is not something to leave to another program's defaults.
    name: binding.name || binding.id,
    targetKind: binding.targetKind,
    target: binding.label,
    address: binding.ip,
    wan: binding.wan,
    // The **stamped** table, because the column is "which table this binding
    // was written for". What its rule points at now goes into `rule`, and on
    // this half the two can differ: the daemon re-points a WAN that changed
    // table, which is precisely the drift this pair of cells exists to show.
    table: binding.stampedTable || binding.wanTable,
    pref: binding.pref,
    whenDown: binding.whenDown,
    whenDownLabel: WHEN_DOWN_LABELS[binding.whenDown] ?? binding.whenDown,
    enabled: binding.enabled,
    state: binding.state,
    stateBadges: badges,
    since,
    sinceLabel: since ? durationLabel(now - since) : '',
    rule,
    forwarding: binding.forwarding,
    source: binding.source,
    verified: binding.verified,
    reason: binding.reason
  }
}

export function bindingRows(
  reply: WanbindBindingsReply | null,
  now: number
): DirectRow[] {
  return (reply?.bindings ?? []).map((binding) => bindingRow(binding, now))
}

/**
 * The numbers the Overview tiles and the one-to-one chart are drawn from.
 *
 * `held` counts the rule rather than the word: every binding whose rule points
 * at the blackhole, which is `held` and also a parked `stranded`. Counting the
 * state name alone left a device that had roamed onto another VLAN overnight
 * sitting on the unreachable table with the tile reporting nothing detained -
 * the one reading the tile exists to prevent.
 */
export function countDirectTotals(rows: readonly DirectRow[]): DirectTotals {
  return {
    total: rows.length,
    ok: rows.filter((row) => row.state === 'bound').length,
    held: rows.filter((row) => parked(row.state, row.whenDown)).length
  }
}
