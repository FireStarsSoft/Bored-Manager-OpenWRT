/**
 * What a Fix row says it will do, and who does it.
 *
 * Both halves are on the row because a button that writes to somebody's router
 * has to be readable before it is pressed. "Set conntrack max to 262144 and
 * gc_thresh3 to 8192, pinned in /etc/sysctl.d/60-bm-scale.conf" is a sentence
 * somebody can decide about; "Fix" is not.
 *
 * The writer matters as much as the action. This module reaches a router two
 * ways - through the agent's own verbs, or over SSH - and which one it will use
 * depends on what the router has. A fix that reloads the firewall through the
 * agent and one that does it by writing a config file and running `fw4 reload`
 * over a shell have the same effect and different failure modes, and the person
 * pressing it should know which they are getting.
 */
import type { AgentCapability } from '../probe'
import { agentAtLeast, TUNE_AGENT_RELEASE, type TuneWanted } from '../agent'
import type { CapacityFixRow } from './types'

/** The agent's snake_case, translated to what `tuneSet` takes. */
export function translateTune(args: Record<string, string | number | boolean>): TuneWanted {
  const out: TuneWanted = {}

  if (typeof args.conntrack_max === 'number') out.conntrackMax = args.conntrack_max
  if (typeof args.gc_thresh1 === 'number') out.gcThresh1 = args.gc_thresh1
  if (typeof args.gc_thresh2 === 'number') out.gcThresh2 = args.gc_thresh2
  if (typeof args.gc_thresh3 === 'number') out.gcThresh3 = args.gc_thresh3
  if (args.flow_offload === true) out.flowOffload = true

  return out
}

function tuneAction(args: Record<string, string | number | boolean>): string {
  const parts: string[] = []

  if (typeof args.conntrack_max === 'number') parts.push(`conntrack max to ${args.conntrack_max}`)
  if (typeof args.gc_thresh1 === 'number') parts.push(`gc_thresh1 to ${args.gc_thresh1}`)
  if (typeof args.gc_thresh2 === 'number') parts.push(`gc_thresh2 to ${args.gc_thresh2}`)
  if (typeof args.gc_thresh3 === 'number') parts.push(`gc_thresh3 to ${args.gc_thresh3}`)

  const sysctls = parts.length
    ? `Set ${parts.join(', ')}, pinned in /etc/sysctl.d/60-bm-scale.conf so a reboot keeps them.`
    : ''

  // Both halves, when the fix carries both. Returning early on the offload
  // named one thing and wrote several - the row is the sentence somebody reads
  // before pressing a button that changes their router, and a fix that does
  // more than it says is the one kind of row this table must never produce.
  if (args.flow_offload !== true) return sysctls

  const offload =
    'Switch on fw4 software flow offload and reload the firewall, which briefly interrupts new connections. Established ones are re-evaluated once.'

  return sysctls ? `${offload} ${sysctls}` : offload
}

/** The row's two sentences, filled in from the kind and what this router has. */
export function describeFix(
  row: CapacityFixRow,
  capability: AgentCapability
): { action: string; writer: string } {
  const throughAgent = agentAtLeast(capability, TUNE_AGENT_RELEASE)

  if (row.kind === 'tune_set') {
    return {
      action: tuneAction(row.args),
      writer: throughAgent
        ? "the router's own bm-agent (tune_set)"
        : 'this module over SSH, writing the same file'
    }
  }

  if (row.kind === 'wanbind_reconcile') {
    return {
      action:
        'Ask bm-wanbind for a full pass now: it re-reads its configuration, re-checks every rule against the kernel and puts back whatever is missing.',
      writer: 'bm-wanbind, on the router'
    }
  }

  if (row.kind === 'wanbind_settings_set') {
    return {
      action:
        "Turn LAN-local rules back on, so a bound address still reaches this router's other networks instead of being sent out of its WAN addressed to a private network.",
      writer: 'bm-wanbind, on the router'
    }
  }

  if (row.kind === 'wanbind_instance_set') {
    const id = typeof row.args.id === 'string' ? row.args.id : 'the instance'

    return {
      action: `Raise dnsmasq's lease ceiling for ${id}'s LAN to the number of seats it can hand out. dnsmasq restarts, so clients renewing at that moment retry.`,
      writer: 'bm-wanbind, on the router'
    }
  }

  return {
    action:
      'Ask bm-pppoe-pool to re-read netifd, its counters and its firewall zones. A zone still naming its sessions one by one moves to one device pattern; the firewall reloads only if something changed.',
    writer: 'bm-pppoe-pool, on the router'
  }
}

/** The same, over a whole list. */
export function describeFixes(
  rows: CapacityFixRow[],
  capability: AgentCapability
): CapacityFixRow[] {
  return rows.map((row) => ({ ...row, ...describeFix(row, capability) }))
}
