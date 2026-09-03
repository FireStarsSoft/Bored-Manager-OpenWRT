/**
 * The router-wide scale limits, from the module's side.
 *
 * Two kernel tables overflow first when a router grows to thousands of PPPoE
 * sessions or bound clients, and both fail by dropping traffic with one line
 * in dmesg that nothing surfaces: conntrack ("nf_conntrack: table full,
 * dropping packet") and the neighbour cache ("neighbour: arp_cache: neighbour
 * table overflow!"). The module has *reported* them since 2.x - the binding
 * check prints the sysctl commands - and this is the half that was missing:
 * reading them live off the slow sweep, recommending values sized to this
 * router's own scale, and applying them.
 *
 * Who writes them is decided per apply, never captured. With bm-agent 2.1.0+
 * the router's own `tune_set` does it - one allowlisted call that writes
 * /proc/sys, pins /etc/sysctl.d/60-bm-scale.conf and owns the file from then
 * on. Without it the module falls back to SSH and writes the *same file*, so
 * the two halves converge on one reboot story instead of fighting over two.
 *
 * The check-then-apply shape is the same as the rules editor's, for the same
 * reason: these are router-wide values that affect every service on the box,
 * and the report the user reads - current, recommended, what will change, who
 * writes it - is frozen by the token the apply spends.
 */
import { failedCheck, hasBlockingFinding, createCheckSession, type ModuleCheckFinding, type ModuleCheckReport } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { agentAtLeast, TUNE_AGENT_RELEASE, tuneSet, type AgentDeps, type TuneWanted } from './agent'
import { isRecord, textField } from './util'

/** Where both writers pin the values; replayed by OpenWrt's sysctl init at boot. */
export const LIMITS_FILE = '/etc/sysctl.d/60-bm-scale.conf'

/** Writing four sysctls is instant; a fw4 reload behind flow offload is not. */
const APPLY_TIMEOUT_MS = 60_000

interface LimitKey {
  field: 'conntrackMax' | 'gcThresh1' | 'gcThresh2' | 'gcThresh3'
  sysctl: string
  min: number
  max: number
  label: string
}

/** The allowlist, mirrored from `bm.tune` on the router - same keys, same bounds. */
const KEYS: readonly LimitKey[] = [
  {
    field: 'conntrackMax',
    sysctl: 'net.netfilter.nf_conntrack_max',
    min: 16_384,
    max: 4_194_304,
    label: 'conntrack max'
  },
  {
    field: 'gcThresh1',
    sysctl: 'net.ipv4.neigh.default.gc_thresh1',
    min: 128,
    max: 1_048_576,
    label: 'gc_thresh1'
  },
  {
    field: 'gcThresh2',
    sysctl: 'net.ipv4.neigh.default.gc_thresh2',
    min: 128,
    max: 1_048_576,
    label: 'gc_thresh2'
  },
  {
    field: 'gcThresh3',
    sysctl: 'net.ipv4.neigh.default.gc_thresh3',
    min: 128,
    max: 1_048_576,
    label: 'gc_thresh3'
  }
]

const COUNT_KEY = 'net.netfilter.nf_conntrack_count'

/** What the container wires in; nothing here imports a domain. */
export interface LimitsDeps {
  ctx: ModuleContext
  /** For the agent path: `objectCall` reads capability per call, never captured. */
  agentDeps: AgentDeps
  /** The slow sweep's last reading of /proc/sys and the fw4 flag. */
  current(): {
    sysctl: Readonly<Record<string, number>>
    flowOffload: boolean | null
    /** Total RAM in kilobytes, or 0 when the sweep has not said. */
    memTotalKb?: number
  }
  /** This router's own scale, for the recommendations. */
  scale(): { clients: number; sessions: number }
  /** Kick the slow sweep so the page shows what the router now holds. */
  afterApply(): void
}

/** The next power of two at or above `value`, floored at 128. */
function pow2(value: number): number {
  let out = 128
  while (out < value && out < 4_194_304) out *= 2
  return out
}

/** The largest power of two at or below `value`. */
function pow2Floor(value: number): number {
  let out = 128
  while (out * 2 <= value) out *= 2
  return out
}

/** What one tracked connection costs, near enough, with its hash bucket. */
const CONNTRACK_BYTES = 320

export interface LimitsRecommendation {
  conntrackMax: number
  gcThresh1: number
  gcThresh2: number
  gcThresh3: number
  memCapped: boolean
}

/**
 * Sized from what this router is actually carrying, with the shipped-kernel
 * defaults as the floor so an idle router is never told to shrink anything.
 *
 * The same arithmetic as `bm.tune`'s `recommended`, and deliberately so: the
 * router offers these numbers at a console and this offers them on a page, and
 * two answers to one question in front of somebody deciding whether to raise a
 * limit is worse than either. `openwrt-limits.test.ts` reads the table the
 * router's own probe writes, so the two cannot drift apart quietly.
 *
 * Conntrack counts flows, which both halves create. The neighbour cache counts
 * LAN devices, so it is sized from clients alone - a PPPoE session is NOARP and
 * adds no neighbour entry.
 *
 * `memTotalKb` is the ceiling and the reason one is needed: a conntrack table
 * is free while it is empty and real memory when it fills, so the
 * recommendation is capped at what an eighth of this router's RAM would hold. A
 * four-million-entry recommendation on a 128 MB router is not advice, it is an
 * out-of-memory reboot with a number attached.
 */
export function recommendLimits(
  clients: number,
  sessions: number,
  memTotalKb?: number
): LimitsRecommendation {
  const flows = Math.max(0, clients) + Math.max(0, sessions)
  // Bounded by what the sysctl itself accepts, which is the same allowlist the
  // router enforces: a recommendation the apply would refuse is not a
  // recommendation.
  const gcThresh3 = Math.min(1_048_576, Math.max(8_192, pow2(Math.max(1, clients) * 4)))

  let wanted = Math.min(4_194_304, Math.max(262_144, pow2(Math.max(500, flows)) * 512))
  let capped = false

  if (typeof memTotalKb === 'number' && memTotalKb > 0) {
    const cap = Math.max(16_384, pow2Floor((memTotalKb * 1024) / 8 / CONNTRACK_BYTES))
    if (wanted > cap) {
      wanted = cap
      capped = true
    }
  }

  return {
    conntrackMax: wanted,
    gcThresh1: gcThresh3 / 4,
    gcThresh2: gcThresh3 / 2,
    gcThresh3,
    memCapped: capped
  }
}

interface FrozenLimits {
  wanted: TuneWanted
  source: 'agent' | 'ssh'
  changed: string[]
}

export class LimitsManager {
  private session = createCheckSession<FrozenLimits>()

  constructor(private deps: LimitsDeps) {}

  /** What the form opens showing: the router's own values, live off the sweep. */
  effective(): Record<string, string | number | boolean> {
    const { sysctl, flowOffload, memTotalKb } = this.deps.current()
    const { clients, sessions } = this.deps.scale()
    const recommended = recommendLimits(clients, sessions, memTotalKb)

    const out: Record<string, string | number | boolean> = {
      sampled: Object.keys(sysctl).length > 0,
      flowOffload: flowOffload === true,
      source: this.source(),
      file: LIMITS_FILE,
      clients,
      sessions,
      recommendedConntrackMax: recommended.conntrackMax,
      recommendedGcThresh1: recommended.gcThresh1,
      recommendedGcThresh2: recommended.gcThresh2,
      recommendedGcThresh3: recommended.gcThresh3
    }

    for (const key of KEYS) {
      const value = sysctl[key.sysctl]
      out[key.field] = typeof value === 'number' ? value : ''
    }

    const count = sysctl[COUNT_KEY]
    out.conntrackCount = typeof count === 'number' ? count : ''
    const max = sysctl[KEYS[0].sysctl]
    out.usagePct =
      typeof count === 'number' && typeof max === 'number' && max > 0
        ? Math.round((count / max) * 100)
        : ''

    return out
  }

  /**
   * Validate, describe, and freeze. A blank field means "leave this as it
   * is", exactly as the rules editor reads one - the placeholders carry the
   * recommendations, so accepting them is pressing Check with the form empty
   * and the values typed in.
   */
  check(raw: unknown): ModuleCheckReport {
    if (!this.deps.ctx.connected) {
      return failedCheck(
        'No router is connected',
        'These are router-wide kernel values, so there has to be a router to read them from first.'
      )
    }

    const values = isRecord(raw) ? raw : {}
    const findings: ModuleCheckFinding[] = []
    const { sysctl, flowOffload, memTotalKb } = this.deps.current()
    const { clients, sessions } = this.deps.scale()
    const recommended = recommendLimits(clients, sessions, memTotalKb)

    if (Object.keys(sysctl).length === 0) {
      return failedCheck(
        'The router has not reported its limits yet',
        'They arrive with the slow sweep. Wait for it, or run Check now under Router readiness first.'
      )
    }

    // Resolve every key: what was typed, or what the router holds.
    const target: Record<string, number> = {}
    for (const key of KEYS) {
      const typed = textField(values, key.field)
      const live = sysctl[key.sysctl]

      if (!typed) {
        if (typeof live === 'number') target[key.field] = live
        continue
      }

      const value = Number(typed)
      if (!Number.isInteger(value)) {
        findings.push({
          level: 'error',
          label: `${key.label} must be a whole number`,
          detail: `You entered "${typed}".`
        })
      } else if (value < key.min || value > key.max) {
        findings.push({
          level: 'error',
          label: `${key.label} must be between ${key.min} and ${key.max}`,
          detail: `You entered ${value}.`
        })
      } else {
        target[key.field] = value
      }
    }

    // The three thresholds only make sense ordered: the kernel starts pruning
    // at the first, gets aggressive at the second and refuses new neighbours
    // at the third, so an inversion silently disables one of the stages.
    const t1 = target.gcThresh1
    const t2 = target.gcThresh2
    const t3 = target.gcThresh3
    if (t1 != null && t2 != null && t1 > t2) {
      findings.push({ level: 'error', label: 'gc_thresh1 cannot be above gc_thresh2' })
    }
    if (t2 != null && t3 != null && t2 > t3) {
      findings.push({ level: 'error', label: 'gc_thresh2 cannot be above gc_thresh3' })
    }

    const count = sysctl[COUNT_KEY]
    if (
      typeof count === 'number' &&
      target.conntrackMax != null &&
      target.conntrackMax <= count
    ) {
      findings.push({
        level: 'error',
        label: `conntrack max ${target.conntrackMax} is below the ${count} entries in use right now`,
        detail: 'Applying it would drop live connections on the spot. Raise it instead.'
      })
    }

    const wantOffload = values.flowOffload === true
    const offloadChanges = flowOffload !== null && wantOffload !== flowOffload

    const changed: string[] = []
    for (const key of KEYS) {
      const live = sysctl[key.sysctl]
      if (target[key.field] != null && target[key.field] !== live) changed.push(key.label)
    }
    if (offloadChanges) changed.push('flow offload')

    if (!hasBlockingFinding(findings) && changed.length === 0) {
      findings.push({
        level: 'error',
        label: 'Nothing here changes anything',
        detail: 'Every value matches what the router already holds. Type a new value, or take the recommendation from a placeholder.'
      })
    }

    // The context somebody reads this report for: how full, and what fits.
    if (typeof count === 'number' && typeof sysctl[KEYS[0].sysctl] === 'number') {
      const max = sysctl[KEYS[0].sysctl]
      const pct = max > 0 ? Math.round((count / max) * 100) : 0
      findings.push({
        level: pct >= 80 ? 'warning' : 'info',
        label: `Conntrack holds ${count} of ${max} entries (${pct}%)`,
        detail:
          pct >= 80
            ? 'When it fills, the kernel drops new connections with only a dmesg line to show for it.'
            : undefined
      })
    }
    findings.push({
      level: 'info',
      label: `Sized for this router - ${clients} client(s), ${sessions} session(s) - the recommendation is conntrack ${recommended.conntrackMax}, thresholds ${recommended.gcThresh1}/${recommended.gcThresh2}/${recommended.gcThresh3}`,
      detail: 'The placeholders carry the same numbers; a bigger deployment can go higher.'
    })

    const source = this.source()
    if (!hasBlockingFinding(findings)) {
      findings.push({
        level: 'pass',
        label: changed.length
          ? `${changed.length} value(s) will change: ${changed.join(', ')}`
          : 'Nothing will change',
        detail:
          source === 'agent'
            ? `Applied by the router's own bm-agent and pinned in ${LIMITS_FILE}, which survives reboots.`
            : `Applied over SSH and pinned in ${LIMITS_FILE}, which survives reboots. With router packages ${TUNE_AGENT_RELEASE}+ the router's own agent takes this over.`
      })
    }

    if (hasBlockingFinding(findings)) return { ok: false, findings }

    const wanted: TuneWanted = {
      conntrackMax: target.conntrackMax,
      gcThresh1: target.gcThresh1,
      gcThresh2: target.gcThresh2,
      gcThresh3: target.gcThresh3
    }
    if (offloadChanges) wanted.flowOffload = wantOffload

    return {
      ok: true,
      token: this.session.issue(raw, { wanted, source, changed }),
      findings
    }
  }

  /** Spend the token and write, by whichever half owns the write right now. */
  async apply(raw: unknown): Promise<OkResult> {
    const payload = isRecord(raw) ? raw : {}
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) {
      return { ok: false, error: 'that check expired or the form changed - check again' }
    }
    if (!this.deps.ctx.connected) {
      return { ok: false, error: 'the router is not connected' }
    }

    const frozen = taken.payload
    const result = frozen.source === 'agent'
      ? await this.applyThroughAgent(frozen.wanted)
      : await this.applyOverSsh(frozen.wanted)

    if (result.ok) {
      this.deps.ctx.log(
        `openwrt: router limits applied via ${frozen.source}: ${frozen.changed.join(', ') || 'no-op'}`
      )
      this.deps.afterApply()
    }
    return result
  }

  /**
   * Write a set of tunables, by whichever half owns the write right now.
   *
   * The one place a limit reaches the router. The form goes through `apply`,
   * which spends a token first; the pool page's one-touch button and the
   * capacity fixes come here directly, because there is no form to have gone
   * stale. All three end up on the same two writers and log the same line.
   */
  async applyWanted(wanted: TuneWanted, what: string): Promise<OkResult> {
    if (!this.deps.ctx.connected) {
      return { ok: false, error: 'the router is not connected' }
    }

    const source = this.source()
    const result =
      source === 'agent' ? await this.applyThroughAgent(wanted) : await this.applyOverSsh(wanted)

    if (!result.ok) return result

    this.deps.ctx.log(`openwrt: ${what} via ${source}`)
    this.deps.afterApply()

    return result
  }

  /**
   * Switch fw4's software flow offload on, and nothing else.
   *
   * The pool create check refuses a pool of more than sixty-four sessions while
   * this is off - every session installs three routing rules and without a
   * flowtable the kernel walks the whole list for every packet, which is what
   * caps the router and looks exactly like a slow ISP. This is the button that
   * sentence points at, so that the answer to "turn it on" is a click rather
   * than a shell.
   *
   * It goes through the same writer the form does, so the router is changed one
   * way and the reasoning about agent-or-SSH lives in one place.
   */
  async enableFlowOffload(): Promise<OkResult> {
    if (!this.deps.ctx.connected) {
      return { ok: false, error: 'the router is not connected' }
    }

    const result = await this.applyWanted({ flowOffload: true }, 'fw4 flow offload switched on')

    if (!result.ok) return result

    return {
      ok: true,
      data: 'Flow offload is on and fw4 was reloaded. Check the pool again.'
    }
  }

  clear(): void {
    this.session.clear()
  }

  /** Who would write, if the apply ran now. */
  private source(): 'agent' | 'ssh' {
    return agentAtLeast(this.deps.agentDeps.capability(), TUNE_AGENT_RELEASE) ? 'agent' : 'ssh'
  }

  private async applyThroughAgent(wanted: TuneWanted): Promise<OkResult> {
    const answer = await tuneSet(this.deps.agentDeps, wanted)
    if (!answer.ok) {
      const reason = answer.error ?? 'the agent did not answer'
      return {
        ok: false,
        error: /method not found/i.test(reason)
          ? `This router's bm-agent predates tune_set. Update the router packages to ${TUNE_AGENT_RELEASE} or newer, or reconnect so the module falls back to SSH.`
          : reason
      }
    }
    const data = answer.data
    if (data && data.ok === false) {
      return { ok: false, error: data.reason ?? 'the router refused the values' }
    }
    return { ok: true, data: `Applied and pinned in ${LIMITS_FILE} by the router's own agent.` }
  }

  /**
   * The fallback writer: the same file, the same keys, over the connection
   * the module already has. Values were validated integers before the token
   * was issued, so nothing here interpolates anything a user typed.
   */
  private async applyOverSsh(wanted: TuneWanted): Promise<OkResult> {
    const pairs: Array<[string, number]> = []
    for (const key of KEYS) {
      const value = wanted[key.field]
      if (typeof value === 'number') pairs.push([key.sysctl, Math.trunc(value)])
    }

    const lines = ['set -eu', 'mkdir -p /etc/sysctl.d']

    // Rewritten only when there is something to write into it.
    //
    // An apply that carries no sysctl at all is not hypothetical: it is exactly
    // what the one-touch "Enable flow offload" button sends, and what a capacity
    // fix for the offload sends. Redirecting an empty block over the file
    // truncated it, silently un-pinning every limit the module had written - the
    // values stayed live in the kernel until the next reboot and then went,
    // which is the worst shape a fault like this can take. The agent's own
    // writer never did this; only the SSH fallback did.
    //
    // Every key this module writes it rewrites whole, so the merge is: keep
    // whatever is in the file that is not one of ours, then append ours.
    if (pairs.length) {
      const drop = pairs.map(([name]) => `-e '^${name}='`).join(' ')

      lines.push(`touch ${LIMITS_FILE}`)
      lines.push(`KEPT="$(grep -v ${drop} -e '^# Written by Bored Manager' ${LIMITS_FILE} || true)"`)
      lines.push('{')
      lines.push(
        `printf '%s\\n' '# Written by Bored Manager. bm-agent ${TUNE_AGENT_RELEASE}+ owns this file when installed.'`
      )
      lines.push(`[ -n "$KEPT" ] && printf '%s\\n' "$KEPT" || true`)
      for (const [name, value] of pairs) {
        lines.push(`printf '%s\\n' '${name}=${value}'`)
      }
      lines.push(`} > ${LIMITS_FILE}.new`)
      lines.push(`mv ${LIMITS_FILE}.new ${LIMITS_FILE}`)
    }
    for (const [name, value] of pairs) {
      lines.push(`sysctl -w ${name}=${value} >/dev/null`)
    }
    if (typeof wanted.flowOffload === 'boolean') {
      lines.push(
        `uci set firewall.@defaults[0].flow_offloading='${wanted.flowOffload ? 1 : 0}'`,
        'uci commit firewall',
        '/etc/init.d/firewall reload >/dev/null 2>&1 || true'
      )
    }

    const result = await this.deps.ctx.exec('sh -s', {
      stdin: `${lines.join('\n')}\n`,
      timeoutMs: APPLY_TIMEOUT_MS
    })
    if (result.code !== 0) {
      const said = (result.stderr || result.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      return {
        ok: false,
        error: `the router refused the write (exit ${result.code})${said ? `: ${said}` : ''}. A kernel without conntrack loaded refuses its sysctl - check "lsmod | grep conntrack".`
      }
    }
    return { ok: true, data: `Applied over SSH and pinned in ${LIMITS_FILE}.` }
  }
}
