/**
 * The check gate: everything that has to be true before a batch may be
 * created, reported as findings a user can read, and - when it all holds - the
 * exact plan frozen behind a one-use token.
 *
 * The plan carries the passwords; the report never does. It also carries the
 * rules it was reasoned about with, because a report that promises "interfaces
 * pd00001…pd00500 in 5 chunks" stops being true the moment an operator edits
 * the chunk size, and `applyRulesFingerprint` is what makes apply notice.
 */
import {
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import { pppoeCarrierRefusal } from '../options'
import { parsePppoeList } from '../parse'
import type { PppoeInputRow } from '../types'
import {
  effectivePppoeChunkSize,
  isPppoePrefix,
  isSafeUciValue,
  pppoeSectionName,
  pppoeTableId,
  vlanSectionName
} from '../uci'
import { inspectRouter } from './inspect'
import { HARD_MAX_BATCH_ROWS } from './names'
import { asRecord, parseOptionalVlan, text, tokenValues } from './parse'
import { allocationLimit, findSequenceRange } from './range'
import { currentModel, timeoutMs, type PppoeRuntime } from './runtime'
import type { FrozenBatchPlan, PppoeRules, RouterInventory } from './types'

const PPP_BYTES_PER_SESSION = 2 * 1024 * 1024
const RAM_WARNING_SHARE = 0.6
const BATCH_NAME_MAX = 80
const CHECK_ERROR_SAMPLE = 20

function mib(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`
}

function sample(values: readonly string[]): string {
  return (
    values.slice(0, CHECK_ERROR_SAMPLE).join(', ') +
    (values.length > CHECK_ERROR_SAMPLE ? `, and ${values.length - CHECK_ERROR_SAMPLE} more` : '')
  )
}

/**
 * Which rows carry a control character, named by row and field and by nothing
 * else - the same sieve the batch name has always been held to, applied to the
 * two fields that reach `/etc/config/network` carrying credentials.
 *
 * The value is never quoted back. A password echoed into a check report is a
 * password in whatever keeps that report. `parsePppoeList` hands back rows
 * without their line numbers, so the position is counted in valid rows, which
 * is also the order the sessions are created in.
 */
function controlCharacterRows(rows: readonly Readonly<PppoeInputRow>[]): string[] {
  const out: string[] = []
  for (const [index, row] of rows.entries()) {
    const fields: string[] = []
    if (!isSafeUciValue(row.user)) fields.push('username')
    if (!isSafeUciValue(row.pass)) fields.push('password')
    if (fields.length) out.push(`row ${index + 1} (${fields.join(' and ')})`)
  }
  return out
}

/**
 * Every PPPoE username this router is already configured with: the ones the
 * slow probe read out of `/etc/config/network` and the ones this module put
 * there itself this session.
 *
 * Checking the pasted list against itself was only ever half the test. Two
 * batches created from two exports of the same customer list dial the same
 * account twice, and most access concentrators answer the second session by
 * dropping the first - which looks like a flapping line, not like a duplicate.
 */
function routerUsernames(runtime: PppoeRuntime): Set<string> {
  const out = new Set<string>()
  for (const user of Object.values(runtime.service.pppoeUsers?.() ?? {})) {
    if (user) out.add(user)
  }
  for (const user of runtime.usernames.values()) {
    if (user) out.add(user)
  }
  return out
}

/**
 * Every VLAN a batch will need a device for: the per-row overrides, plus the
 * batch-wide one when at least one row does not override it.
 */
export function requestedVlans(
  rows: readonly Readonly<PppoeInputRow>[],
  batchVlan?: number
): number[] {
  const vlans = new Set<number>()
  if (batchVlan !== undefined && rows.some((row) => row.vlan === undefined)) {
    vlans.add(batchVlan)
  }
  for (const row of rows) {
    if (row.vlan !== undefined) vlans.add(row.vlan)
  }
  return [...vlans]
}

export function vlanConflict(
  inventory: RouterInventory,
  carrier: string,
  vlan: number
): string | null {
  const section = vlanSectionName(vlan)
  const existing = inventory.vlanDevices.get(section)
  if (!existing) return null
  const expectedName = `${carrier}.${vlan}`
  if (
    existing.ifname === carrier &&
    existing.vid === vlan &&
    existing.name === expectedName
  ) {
    return null
  }
  return `${section} already describes ${existing.name || existing.ifname || 'another VLAN device'}`
}

/**
 * The rules the frozen plan was built against, reduced to the fields that
 * change what the report promised. `ifacePrefix` and `autoRedialAfterMin` are
 * left out on purpose: the first is already baked into the plan's own prefix,
 * and the second has nothing to do with the create.
 */
export function applyRulesFingerprint(rules: PppoeRules): string {
  return JSON.stringify([
    rules.tableBase,
    rules.catchAllTable,
    rules.uciChunkSize,
    rules.chunkDelayMs,
    rules.execTimeoutSec,
    rules.maxBatchRows,
    rules.zoneName,
    rules.zoneMode
  ])
}

/**
 * Parse and freeze the exact credentials/range behind a one-use ten-minute
 * token. The report contains counts and usernames-at-most, never passwords.
 */
export async function checkPppoe(
  runtime: PppoeRuntime,
  raw: unknown
): Promise<ModuleCheckReport> {
  // One wording for one condition: the binding check and the setup check both
  // say this, and all three used to phrase it differently.
  if (!runtime.ctx.connected) {
    return failedCheck('The router is not connected', 'Connect the machine entry and try again.')
  }
  const values = asRecord(raw)
  const rules = runtime.config.effectiveRules()
  const findings: ModuleCheckFinding[] = []
  const name = text(values, 'name')
  const carrier = text(values, 'carrier')
  const prefix = text(values, 'prefix') || rules.ifacePrefix
  const vlanResult = parseOptionalVlan(values)
  const file = typeof values.listFile === 'string' ? values.listFile : ''
  const pasted = typeof values.listText === 'string' ? values.listText : ''
  const source = file.trim() ? file : pasted
  const parsed = parsePppoeList(source)
  const maxRows = Math.min(HARD_MAX_BATCH_ROWS, Math.max(1, Math.trunc(rules.maxBatchRows)))

  if (!name || name.length > BATCH_NAME_MAX || !isSafeUciValue(name)) {
    findings.push({
      level: 'error',
      label: `Batch name must be 1-${BATCH_NAME_MAX} characters on one line`
    })
  } else if (runtime.store.read().batches.some((batch) => batch.name.toLowerCase() === name.toLowerCase())) {
    findings.push({ level: 'error', label: `A PPPoE batch called "${name}" already exists` })
  }
  // Not `isSafeDeviceName`: a dot is legal there because the binding half
  // carries its uplink on one, and this form builds its own VLAN devices.
  const carrierRefusal = pppoeCarrierRefusal(carrier)
  if (carrierRefusal) findings.push({ level: 'error', ...carrierRefusal })
  if (!isPppoePrefix(prefix)) {
    findings.push({
      level: 'error',
      label: 'Prefix must be 1-4 lowercase letters or digits and start with a letter'
    })
  }
  if (vlanResult.error) findings.push({ level: 'error', label: vlanResult.error })

  if (parsed.rows.length < 1 || parsed.rows.length > maxRows) {
    findings.push({
      level: 'error',
      label: `Account list must contain between 1 and ${maxRows} valid rows`,
      detail: parsed.rows.length ? `${parsed.rows.length} valid rows were parsed.` : 'No valid account row was found.'
    })
  }
  if (parsed.errors.length) {
    findings.push({
      level: 'error',
      label: `${parsed.errors.length} account line(s) are invalid`,
      detail: parsed.errors
        .slice(0, CHECK_ERROR_SAMPLE)
        .map((entry) => `line ${entry.line}: ${entry.reason}`)
        .join('; ')
        .concat(parsed.errors.length > CHECK_ERROR_SAMPLE ? `; and ${parsed.errors.length - CHECK_ERROR_SAMPLE} more` : '')
    })
  }
  const controlRows = controlCharacterRows(parsed.rows)
  if (controlRows.length) {
    findings.push({
      level: 'error',
      label: `${controlRows.length} account row(s) contain a control character`,
      detail:
        `${sample(controlRows)}. The value is deliberately not shown: a password ` +
        'quoted back here would travel with this report. Re-export the list as plain text.'
    })
  }
  if (parsed.duplicates.length) {
    findings.push({
      level: 'warning',
      label: `${parsed.duplicates.length} username(s) occur more than once`,
      detail:
        parsed.duplicates.slice(0, CHECK_ERROR_SAMPLE).join(', ') +
        (parsed.duplicates.length > CHECK_ERROR_SAMPLE ? ', …' : '') +
        '. Many access concentrators reject concurrent use of one account.'
    })
  }
  const configured = routerUsernames(runtime)
  const alreadyDialed = [...new Set(parsed.rows.map((row) => row.user))].filter((user) =>
    configured.has(user)
  )
  if (alreadyDialed.length) {
    findings.push({
      level: 'warning',
      label: `${alreadyDialed.length} username(s) are already configured on this router`,
      detail:
        `${sample(alreadyDialed)}. Dialing an account that is already up usually ends ` +
        'with the access concentrator dropping one of the two sessions.'
    })
  }

  if (hasBlockingFinding(findings)) return { ok: false, findings }

  let inventory: RouterInventory
  try {
    inventory = await inspectRouter(runtime, carrier, timeoutMs(rules))
  } catch (error) {
    return {
      ok: false,
      findings: [
        ...findings,
        {
          level: 'error',
          label: 'Could not inspect the router network configuration',
          detail: error instanceof Error ? error.message : String(error)
        }
      ]
    }
  }
  if (!inventory.carrierExists) {
    findings.push({
      level: 'error',
      label: `Carrier ${carrier} does not exist on the connected router`
    })
  }
  for (const vlan of requestedVlans(parsed.rows, vlanResult.value)) {
    if (`${carrier}.${vlan}`.length > 15) {
      findings.push({
        level: 'error',
        label: `VLAN device ${carrier}.${vlan} is longer than Linux IFNAMSIZ`
      })
      continue
    }
    const conflict = vlanConflict(inventory, carrier, vlan)
    if (conflict) {
      findings.push({
        level: 'error',
        label: `VLAN ${vlan} conflicts with existing UCI configuration`,
        detail: conflict
      })
    }
  }

  const range = findSequenceRange(
    parsed.rows.length,
    prefix,
    rules,
    runtime.store.read(),
    inventory
  )
  if (!range) {
    findings.push({
      level: 'error',
      label: 'No free PPPoE sequence/table range is available',
      detail: `The configured table range ends at sequence ${Math.max(0, allocationLimit(rules))}.`
    })
  }

  const model = currentModel(runtime)
  const wantedRam = parsed.rows.length * PPP_BYTES_PER_SESSION
  const memFree = model?.sys.memFree ?? 0
  if (memFree > 0 && wantedRam > memFree * RAM_WARNING_SHARE) {
    findings.push({
      level: 'warning',
      label: `${parsed.rows.length} pppd processes may use about ${mib(wantedRam)}`,
      detail: `The latest router sample reports ${mib(memFree)} free; this exceeds 60% of it.`
    })
  } else if (memFree > 0) {
    findings.push({
      level: 'pass',
      label: `Estimated PPP memory ${mib(wantedRam)} of ${mib(memFree)} currently free`
    })
  } else {
    findings.push({
      level: 'info',
      label: `Allow about ${mib(wantedRam)} of router RAM for these pppd processes`,
      detail: 'No usable free-memory sample is cached yet.'
    })
  }

  if (range) {
    const chunkSize = effectivePppoeChunkSize(parsed.rows.length, rules.uciChunkSize)
    const chunks = Math.ceil(parsed.rows.length / chunkSize)
    findings.push({
      level: 'pass',
      label: `Will create ${parsed.rows.length} interfaces ${pppoeSectionName(prefix, range.from)}…${pppoeSectionName(prefix, range.to)} on ${carrier}`,
      detail: `${chunks} UCI chunk${chunks === 1 ? '' : 's'} of up to ${chunkSize}, with ${rules.chunkDelayMs} ms between chunks.`
    })
    findings.push({
      level: 'info',
      label: `Routing tables ${pppoeTableId(rules.tableBase, range.from)}…${pppoeTableId(rules.tableBase, range.to)} are free`
    })
  }

  const lanZone = runtime.service.lanFirewallZone?.() ?? ''
  if (lanZone) {
    findings.push({
      level: 'pass',
      label: `LAN clients will reach the pool from firewall zone ${lanZone}`,
      detail: `Forwarding ${lanZone} → ${rules.zoneName} is created or updated as part of this job.`
    })
  } else {
    findings.push({
      level: 'warning',
      label: 'The LAN firewall zone could not be read; assuming "lan"',
      detail:
        'It is read from the router firewall configuration on each slow sweep, which may not have run yet. If this router calls its LAN zone something else, the sessions will dial but carry no client traffic until the forwarding is corrected.'
    })
  }

  const ok = !hasBlockingFinding(findings) && range !== null
  if (!ok || !range) return { ok: false, findings }
  const rows = Object.freeze(
    parsed.rows.map((row) =>
      Object.freeze({
        user: row.user,
        pass: row.pass,
        ...(row.vlan === undefined ? {} : { vlan: row.vlan })
      })
    )
  )
  const plan: FrozenBatchPlan = Object.freeze({
    name,
    carrier,
    prefix,
    ...(vlanResult.value === undefined ? {} : { vlan: vlanResult.value }),
    rows,
    seqFrom: range.from,
    seqTo: range.to,
    rules: Object.freeze({ ...rules })
  })
  return {
    ok: true,
    token: runtime.session.issue(tokenValues(values), plan),
    findings
  }
}
