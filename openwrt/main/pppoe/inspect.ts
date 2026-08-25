/**
 * The three questions this domain asks the router directly, outside a job's
 * normal UCI batch: what already exists before a create, how many of the new
 * interfaces netifd actually lists, and which device/zone sections a delete may
 * touch.
 *
 * All three read `uci show` and `ubus` output only. None of them can carry a
 * PPPoE password, which is why the exit code alone is reported on failure -
 * `stdout` never reaches an Error, a job item or the log from here either.
 */
import { uciQuote } from '../parse'
import { isSafeDeviceName } from '../uci'
import { currentModel, type PppoeRuntime } from './runtime'
import type { NetworkDeviceInventory, RouterInventory } from './types'

function parseQuotedValue(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).split("'\\''").join("'")
  }
  return value
}

export async function inspectRouter(
  runtime: PppoeRuntime,
  carrier: string,
  timeout: number
): Promise<RouterInventory> {
  if (!isSafeDeviceName(carrier)) throw new Error('carrier is not a safe interface name')
  const script = [
    `if ip link show dev ${uciQuote(carrier)} >/dev/null 2>&1; then`,
    "  echo '===CARRIER===1'",
    'else',
    "  echo '===CARRIER===0'",
    'fi',
    "echo '===NETWORK==='",
    "uci -q show network 2>/dev/null | grep -E '=interface$|\\.ip4table=|^network\\.bmv[0-9]+(=device|\\.(ifname|vid|name)=)' || true"
  ].join('\n')
  const result = await runtime.ctx.exec('sh -s', {
    stdin: `${script}\n`,
    timeoutMs: timeout
  })
  if (result.code !== 0) throw new Error(`router inventory failed (exit ${result.code})`)

  const sections = new Set<string>()
  const tables = new Set<number>()
  const vlanDevices = new Map<string, { ifname?: string; vid?: number; name?: string }>()
  for (const line of result.stdout.split(/\r?\n/)) {
    const section = /^network\.([^.=]+)=interface$/.exec(line.trim())
    if (section?.[1]) sections.add(section[1])
    const table = /^network\.[^.=]+\.ip4table=(.+)$/.exec(line.trim())
    if (table?.[1]) {
      const value = Number(parseQuotedValue(table[1]))
      if (Number.isInteger(value) && value > 0) tables.add(value)
    }
    const declaration = /^network\.(bmv\d+)=device$/.exec(line.trim())
    if (declaration?.[1] && !vlanDevices.has(declaration[1])) {
      vlanDevices.set(declaration[1], {})
    }
    const property = /^network\.(bmv\d+)\.(ifname|vid|name)=(.+)$/.exec(line.trim())
    if (property?.[1] && property[2] && property[3]) {
      const current = vlanDevices.get(property[1]) ?? {}
      const value = parseQuotedValue(property[3])
      if (property[2] === 'ifname') current.ifname = value
      else if (property[2] === 'name') current.name = value
      else {
        const vid = Number(value)
        if (Number.isInteger(vid)) current.vid = vid
      }
      vlanDevices.set(property[1], current)
    }
  }
  return {
    carrierExists: result.stdout.includes('===CARRIER===1'),
    sections,
    tables,
    vlanDevices
  }
}

export async function visibleInterfaceCount(
  runtime: PppoeRuntime,
  names: readonly string[],
  timeout: number
): Promise<number> {
  const wanted = new Set(names)
  const cached = new Set((currentModel(runtime)?.ifaces ?? []).map((iface) => iface.name))
  let count = names.reduce((sum, name) => sum + (cached.has(name) ? 1 : 0), 0)
  if (count === names.length) return count

  const result = await runtime.ctx.exec('ubus -S call network.interface dump', {
    timeoutMs: timeout
  })
  if (result.code !== 0) throw new Error(`interface verification failed (exit ${result.code})`)
  try {
    const decoded = JSON.parse(result.stdout) as { interface?: Array<{ interface?: unknown }> }
    count = 0
    for (const iface of Array.isArray(decoded.interface) ? decoded.interface : []) {
      if (typeof iface.interface === 'string' && wanted.has(iface.interface)) count += 1
    }
    return count
  } catch {
    throw new Error('interface verification returned invalid JSON')
  }
}

export async function inspectNetworkDevices(
  runtime: PppoeRuntime,
  timeout: number
): Promise<NetworkDeviceInventory> {
  const result = await runtime.ctx.exec('sh -s', {
    stdin:
      "uci -q show network 2>/dev/null | grep -E '=interface$|=device$|\\.device=|\\.name=' || true\n" +
      "uci -q show firewall 2>/dev/null | grep -E '=zone$|=forwarding$' || true\n",
    timeoutMs: timeout
  })
  if (result.code !== 0) throw new Error(`network device inventory failed (exit ${result.code})`)
  const interfaceDevices = new Map<string, string>()
  const deviceNames = new Map<string, string>()
  const deviceSections = new Set<string>()
  const interfaceSections = new Set<string>()
  const zoneSections = new Set<string>()
  const forwardingSections = new Set<string>()
  for (const line of result.stdout.split(/\r?\n/)) {
    const declaration = /^network\.([^.=]+)=device$/.exec(line.trim())
    if (declaration?.[1]) deviceSections.add(declaration[1])
    const section = /^network\.([^.=]+)=interface$/.exec(line.trim())
    if (section?.[1]) interfaceSections.add(section[1])
    const zone = /^firewall\.([^.=]+)=zone$/.exec(line.trim())
    if (zone?.[1]) zoneSections.add(zone[1])
    const forwarding = /^firewall\.([^.=]+)=forwarding$/.exec(line.trim())
    if (forwarding?.[1]) forwardingSections.add(forwarding[1])
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    const device = /^network\.([^.=]+)\.device=(.+)$/.exec(line.trim())
    if (device?.[1] && device[2]) interfaceDevices.set(device[1], parseQuotedValue(device[2]))
    const name = /^network\.([^.=]+)\.name=(.+)$/.exec(line.trim())
    if (name?.[1] && name[2] && deviceSections.has(name[1])) {
      deviceNames.set(name[1], parseQuotedValue(name[2]))
    }
  }
  return { interfaceDevices, deviceNames, interfaceSections, zoneSections, forwardingSections }
}
