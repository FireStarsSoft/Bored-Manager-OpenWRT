/**
 * The check gate: turn form fields into a spec, let the router validate it,
 * and freeze the exact spec behind a one-use token.
 *
 * Validation itself lives on the router - `pool_check` in bm-pppoe-pool - so
 * the findings this module shows are the same sentences LuCI and `bmpppoe
 * check` show, worded once. What stays here is the parsing (VLAN ranges,
 * member lines, the keepalive pair) and the refusals that need no router at
 * all: an empty id, a line that does not split.
 *
 * The spec carries the passwords; the report never does. The token freezes
 * the spec so what is applied is exactly what was checked, and the UI blanks
 * the credential fields on apply (`omitOnApply`) so the token comparison
 * holds without the values travelling twice.
 */
import {
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import { poolCheck, type PoolSpec, type PoolSpecMember } from '../agent'
import { featureApi, PPPOE_DIRECT_API } from '../probe'
import { textField } from '../util'
import { agentDeps, type PppoeRuntime } from './runtime'
import { asRecord } from './parse'

function poolApi(runtime: PppoeRuntime): number {
  const capability = runtime.agent?.()
  return capability ? featureApi(capability, 'pppoe') : 0
}

export const POOL_ID = /^[a-z][a-z0-9_]{0,30}$/

const MEMBER_MAX = 500
const SHOWN_ERRORS = 8

/**
 * `101-150,200,0` -> `[0, 101..150, 200]`. Ranges and numbers, commas or
 * whitespace between them, 0 meaning untagged.
 */
export function parseVlanList(text: string): { vlans: number[]; errors: string[] } {
  const vlans: number[] = []
  const errors: string[] = []
  const seen = new Set<number>()

  for (const token of text.split(/[\s,]+/)) {
    if (!token) continue

    const range = token.match(/^([0-9]{1,4})-([0-9]{1,4})$/)
    const single = /^[0-9]{1,4}$/.test(token)

    let from: number
    let to: number
    if (range) {
      from = Number(range[1])
      to = Number(range[2])
    } else if (single) {
      from = to = Number(token)
    } else {
      errors.push(`"${token}" is not a VLAN or a range like 101-150`)
      continue
    }

    if (to < from || from < 0 || to > 4094) {
      errors.push(`"${token}" is outside 0-4094`)
      continue
    }
    if (to - from + 1 > MEMBER_MAX) {
      errors.push(`"${token}" spans more than ${MEMBER_MAX} VLANs`)
      continue
    }

    for (let vlan = from; vlan <= to; vlan++) {
      if (seen.has(vlan)) {
        errors.push(`VLAN ${vlan} appears twice`)
        break
      }
      seen.add(vlan)
      vlans.push(vlan)
    }
  }

  return { vlans, errors }
}

function splitLine(line: string): string[] {
  if (line.includes('\t')) return line.split(/\t+/).map((part) => part.trim())
  if (line.includes(',')) return line.split(',').map((part) => part.trim())
  if (line.includes(';')) return line.split(';').map((part) => part.trim())
  if (line.includes('|')) return line.split('|').map((part) => part.trim())
  return line.trim().split(/\s+/)
}

/**
 * One member per line: `vlan`, `vlan,user` or `vlan,user,pass`, separated by
 * a tab, a comma, a semicolon, a pipe or spaces; `#` starts a comment. The
 * short forms exist for edits: a member that keeps its VLAN keeps whatever it
 * does not restate, so a list can be reshaped without retyping secrets.
 */
export function parseMemberLines(text: string): { members: PoolSpecMember[]; errors: string[] } {
  const members: PoolSpecMember[] = []
  const errors: string[] = []
  const seen = new Set<number>()

  for (const [offset, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const fields = splitLine(line)
    if (fields.length < 1 || fields.length > 3) {
      errors.push(`line ${offset + 1}: expected VLAN, username and password`)
      continue
    }

    const vlan = Number(fields[0])
    if (!Number.isInteger(vlan) || vlan < 0 || vlan > 4094) {
      errors.push(`line ${offset + 1}: the VLAN has to be 0 to 4094`)
      continue
    }
    if (seen.has(vlan)) {
      errors.push(`line ${offset + 1}: VLAN ${vlan} appears twice`)
      continue
    }
    seen.add(vlan)

    const member: PoolSpecMember = { vlan }
    const user = fields[1] ?? ''
    const pass = fields[2] ?? ''
    if (user) member.user = user
    if (pass) member.pass = pass
    members.push(member)

    if (members.length > MEMBER_MAX) {
      errors.push(`more than ${MEMBER_MAX} members`)
      break
    }
  }

  return { members, errors }
}

function has(values: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key)
}

function numberField(
  values: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
  max: number,
  findings: ModuleCheckFinding[]
): number | undefined {
  const raw = values[key]
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!text) return undefined
  const value = Number(text)
  if (!Number.isInteger(value) || value < min || value > max) {
    findings.push({ level: 'error', label: `${label} must be a whole number ${min}-${max}` })
    return undefined
  }
  return value
}

function boolField(values: Record<string, unknown>, key: string): boolean | undefined {
  const raw = values[key]
  if (typeof raw === 'boolean') return raw
  if (raw === 'true' || raw === '1' || raw === 'on') return true
  if (raw === 'false' || raw === '0') return false
  return undefined
}

/**
 * The General / Advanced / Firewall keys, read out of whatever subset of them
 * this form carries. Partial on purpose: an edit form sends only its own
 * fields, and a key that was never on the form must keep its stored value -
 * which is what leaving it off the spec means to `pool_set`.
 */
function optionalKeys(
  values: Record<string, unknown>,
  spec: PoolSpec,
  findings: ModuleCheckFinding[]
): void {
  if (has(values, 'label')) spec.label = textField(values, 'label')
  if (has(values, 'service')) spec.service = textField(values, 'service')
  if (has(values, 'ac')) spec.ac = textField(values, 'ac')
  if (has(values, 'ac_mac')) spec.ac_mac = textField(values, 'ac_mac')

  if (has(values, 'mtu')) {
    spec.mtu = numberField(values, 'mtu', 'MTU', 576, 9_200, findings) ?? 0
    // An emptied field means "back to the pppd default", which the daemon
    // spells as 0; an invalid one already produced a finding.
    if (textField(values, 'mtu') === '') spec.mtu = 0
  }

  if (has(values, 'keepalive_failure') || has(values, 'keepalive_interval')) {
    const failure = textField(values, 'keepalive_failure')
    const interval = textField(values, 'keepalive_interval')
    if (failure && !/^[0-9]{1,5}$/.test(failure)) {
      findings.push({ level: 'error', label: 'LCP echo failure must be a whole number' })
    } else if (interval && !/^[0-9]{1,5}$/.test(interval)) {
      findings.push({ level: 'error', label: 'LCP echo interval must be a whole number' })
    } else {
      spec.keepalive = failure ? (interval ? `${failure} ${interval}` : failure) : ''
    }
  }

  if (has(values, 'ipv6')) {
    const ipv6 = textField(values, 'ipv6')
    spec.ipv6 = ipv6 === 'auto' || ipv6 === '1' ? ipv6 : '0'
  }

  const peerdns = boolField(values, 'peerdns')
  if (peerdns !== undefined) spec.peerdns = peerdns

  if (has(values, 'dns')) {
    const text = textField(values, 'dns')
    spec.dns = text ? text.split(/\s+/) : []
  }

  const defaultroute = boolField(values, 'defaultroute')
  if (defaultroute !== undefined) spec.defaultroute = defaultroute

  if (has(values, 'host_uniq')) spec.host_uniq = textField(values, 'host_uniq')
  if (has(values, 'demand')) {
    spec.demand = numberField(values, 'demand', 'Inactivity timeout', 0, 86_400, findings) ?? 0
  }
  if (has(values, 'padi_attempts')) {
    spec.padi_attempts = numberField(values, 'padi_attempts', 'PADI attempts', 0, 100, findings) ?? 0
  }
  if (has(values, 'padi_timeout')) {
    spec.padi_timeout = numberField(values, 'padi_timeout', 'PADI timeout', 0, 300, findings) ?? 0
  }
  if (has(values, 'pppd_options')) spec.pppd_options = textField(values, 'pppd_options')

  if (has(values, 'zone')) spec.zone = textField(values, 'zone')
  const masq = boolField(values, 'masq')
  if (masq !== undefined) spec.masq = masq
  const mtuFix = boolField(values, 'mtu_fix')
  if (mtuFix !== undefined) spec.mtu_fix = mtuFix
  const lanForward = boolField(values, 'lan_forward')
  if (lanForward !== undefined) spec.lan_forward = lanForward

  if (has(values, 'carrier') && textField(values, 'carrier')) {
    spec.carrier = textField(values, 'carrier')
  }
  if (has(values, 'mac_mode')) {
    spec.mac_mode = textField(values, 'mac_mode') === 'inherit' ? 'inherit' : 'auto'
  }
  if (has(values, 'table_base')) {
    const base = numberField(values, 'table_base', 'Table base', 1, 65_535, findings)
    if (base !== undefined) spec.table_base = base
  }
}

/**
 * The member list of whichever mode this form speaks. `multi` takes a VLAN
 * list; `single` takes member lines, from the pasted text or an uploaded
 * file - the file wins when both are given, same as the old form.
 */
function memberKeys(
  values: Record<string, unknown>,
  mode: 'multi' | 'single',
  spec: PoolSpec,
  findings: ModuleCheckFinding[],
  carrierMode: 'vlan' | 'direct'
): void {
  if (mode === 'multi') {
    if (!has(values, 'vlans')) return
    const parsed = parseVlanList(textField(values, 'vlans'))
    if (parsed.errors.length) {
      findings.push({
        level: 'error',
        label: `${parsed.errors.length} ${carrierMode === 'direct' ? 'slot' : 'VLAN'} entr${parsed.errors.length === 1 ? 'y' : 'ies'} cannot be read`,
        detail: parsed.errors.slice(0, SHOWN_ERRORS).join('; ')
      })
      return
    }
    if (carrierMode === 'direct' && parsed.vlans.some((vlan) => vlan < 1)) {
      findings.push({
        level: 'error',
        label: 'Direct mode numbers its sessions 1-4094',
        detail: 'There is no VLAN 0: every member dials the carrier itself.'
      })
      return
    }
    spec.members = parsed.vlans.map((vlan) => ({ vlan }))
    return
  }

  const file = typeof values.listFile === 'string' ? values.listFile : ''
  const pasted = typeof values.listText === 'string' ? values.listText : ''
  if (!has(values, 'listFile') && !has(values, 'listText')) return

  const parsed = parseMemberLines(file.trim() ? file : pasted)
  if (parsed.errors.length) {
    findings.push({
      level: 'error',
      label: `${parsed.errors.length} member line(s) cannot be read`,
      detail: parsed.errors.slice(0, SHOWN_ERRORS).join('; ')
    })
    return
  }
  if (carrierMode === 'direct' && parsed.members.some((member) => member.vlan < 1)) {
    findings.push({
      level: 'error',
      label: 'Direct mode numbers its sessions 1-4094',
      detail: 'There is no VLAN 0: every member dials the carrier itself.'
    })
    return
  }
  spec.members = parsed.members
}

/**
 * The values a token is issued against. The UI marks the credential-bearing
 * fields `omitOnApply`, so the renderer blanks them when it calls apply; the
 * issue side blanks the same keys, and the comparison holds without the
 * secrets being held a second time.
 */
export function tokenValues(values: Record<string, unknown>): Record<string, unknown> {
  const out = { ...values }
  // Only the keys this form actually carried: adding one the renderer never
  // sends back would make the apply-side comparison miss for ever.
  for (const key of ['listFile', 'listText', 'password']) {
    if (has(out, key)) out[key] = ''
  }
  return out
}

function findingsOf(reply: { findings?: unknown }): ModuleCheckFinding[] {
  if (!Array.isArray(reply.findings)) return []
  return reply.findings
    .filter(
      (entry): entry is { level: string; label: string; detail?: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { label?: unknown }).label === 'string'
    )
    .map((entry) => ({
      level:
        entry.level === 'error' || entry.level === 'warning' || entry.level === 'pass'
          ? entry.level
          : 'info',
      label: entry.label,
      ...(entry.detail ? { detail: entry.detail } : {})
    }))
}

/** Ask the router, fold its findings in, and freeze the spec when it passes. */
async function checkWithDaemon(
  runtime: PppoeRuntime,
  id: string,
  spec: PoolSpec,
  creating: boolean,
  values: Record<string, unknown>,
  local: ModuleCheckFinding[]
): Promise<ModuleCheckReport> {
  const reply = await poolCheck(agentDeps(runtime), id, spec)

  if (!reply.ok && !reply.data) {
    return {
      ok: false,
      findings: [
        ...local,
        {
          level: 'error',
          label: 'The router could not check this pool',
          detail: reply.error ?? 'It did not answer.'
        }
      ]
    }
  }

  const findings = [...local, ...findingsOf(reply.data ?? {})]
  const ok = reply.data?.ok === true && !hasBlockingFinding(findings)
  if (!ok) return { ok: false, findings }

  return {
    ok: true,
    token: runtime.session.issue(tokenValues(values), {
      id,
      spec: Object.freeze(spec),
      creating
    }),
    findings
  }
}

/** The create gate: both sub-tabs land here, told apart by `mode`. */
export async function checkPool(runtime: PppoeRuntime, raw: unknown): Promise<ModuleCheckReport> {
  if (!runtime.ctx.connected) {
    return failedCheck('The router is not connected', 'Connect the machine entry and try again.')
  }

  const values = asRecord(raw)
  const findings: ModuleCheckFinding[] = []
  const mode = textField(values, 'mode') === 'single' ? 'single' : 'multi'
  const id = textField(values, 'id')

  if (!POOL_ID.test(id)) {
    findings.push({
      level: 'error',
      label: 'Pool id must be 1-31 lowercase letters, digits or underscores, starting with a letter'
    })
  }

  const spec: PoolSpec = { mode }

  const prefix = textField(values, 'prefix')
  if (prefix) spec.prefix = prefix
  const carrier = textField(values, 'carrier')
  if (carrier) spec.carrier = carrier

  if (mode === 'multi') {
    spec.username = textField(values, 'username')
    const password = typeof values.password === 'string' ? values.password : ''
    if (password) spec.password = password
  }

  const carrierMode = textField(values, 'carrier_mode') === 'direct' ? 'direct' : 'vlan'
  const api = poolApi(runtime)
  if (carrierMode === 'direct' && api < PPPOE_DIRECT_API) {
    findings.push({
      level: 'error',
      label: 'Direct carrier mode needs bm-pppoe-pool 2.2.0 or newer',
      detail: 'Update the router packages from Router packages, in Module settings.'
    })
  } else if (api >= PPPOE_DIRECT_API) {
    spec.carrier_mode = carrierMode
  }

  const base = numberField(values, 'table_base', 'Table base', 1, 65_535, findings)
  spec.table_base = base ?? runtime.config.effectiveRules().tableBase

  memberKeys(values, mode, spec, findings, carrierMode)
  if (!spec.members?.length) {
    findings.push({
      level: 'error',
      label: mode === 'multi'
        ? (carrierMode === 'direct' ? 'List at least one slot' : 'List at least one VLAN')
        : 'List at least one member line',
      detail:
        mode === 'multi'
          ? (carrierMode === 'direct'
            ? 'Slot numbers 1-4094: 1-32,40. There is no VLAN 0.'
            : 'Ranges and numbers: 101-150,200. VLAN 0 means untagged, at most once.')
          : 'One per line: VLAN, username, password.'
    })
  }
  optionalKeys(values, spec, findings)

  if (hasBlockingFinding(findings)) return { ok: false, findings }

  return checkWithDaemon(runtime, id, spec, true, values, findings)
}

/**
 * The edit gate. `id` names the pool; the values are whichever sub-form was
 * submitted, and only the keys it carried travel - everything else keeps its
 * stored value on the router.
 */
export async function checkPoolEdit(
  runtime: PppoeRuntime,
  idRaw: unknown,
  raw: unknown
): Promise<ModuleCheckReport> {
  if (!runtime.ctx.connected) {
    return failedCheck('The router is not connected', 'Connect the machine entry and try again.')
  }

  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  if (!POOL_ID.test(id)) {
    return failedCheck('No pool was named', 'Open the pool row and use its own forms.')
  }

  const pool = (runtime.cache.info?.pools ?? []).find((entry) => entry.id === id)
  if (!pool) {
    return failedCheck(
      `No pool called ${id} is known right now`,
      'Refresh and try again; if it was just deleted, there is nothing to edit.'
    )
  }

  const values = asRecord(raw)
  const findings: ModuleCheckFinding[] = []
  const spec: PoolSpec = {}

  if (has(values, 'username')) spec.username = textField(values, 'username')
  const password = typeof values.password === 'string' ? values.password : ''
  if (password) spec.password = password

  const carrierMode = textField(values, 'carrier_mode') === 'direct'
    ? 'direct'
    : pool.carrier_mode === 'direct'
      ? 'direct'
      : 'vlan'
  if (has(values, 'carrier_mode') && textField(values, 'carrier_mode') === 'direct' && poolApi(runtime) < PPPOE_DIRECT_API) {
    findings.push({
      level: 'error',
      label: 'Direct carrier mode needs bm-pppoe-pool 2.2.0 or newer',
      detail: 'Update the router packages from Router packages, in Module settings.'
    })
  }

  memberKeys(values, pool.mode, spec, findings, carrierMode)
  optionalKeys(values, spec, findings)

  if (hasBlockingFinding(findings)) return { ok: false, findings }

  return checkWithDaemon(runtime, id, spec, false, values, findings)
}
