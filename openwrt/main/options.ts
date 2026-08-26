import type { FormFieldOption } from '@shared/module-ui'
import type { OwrtHostData } from './store'
import type { RouterModel } from './types'

export type OpenWrtOptionKind =
  | 'lan-ifaces'
  | 'carriers'
  | 'binding-carriers'

function uniqueSorted(options: FormFieldOption[]): FormFieldOption[] {
  const byValue = new Map<string, FormFieldOption>()
  for (const option of options) {
    if (option.value && !byValue.has(option.value)) byValue.set(option.value, option)
  }
  return [...byValue.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value)
  )
}

/** Linux IFNAMSIZ: past 15 visible characters netifd truncates in silence. */
const MAX_DEVICE_NAME = 15
const DEVICE_BASE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/
const VLAN_TAG = /^\d{1,4}$/

/**
 * A device name split into the device and the VLAN tags riding on it, or null
 * when it is not a name a carrier could have.
 *
 * The dot is the whole point: many ISPs hand out the uplink on a tagged VLAN,
 * so `wan.835` is the carrier, and nothing downstream had to change for it -
 * `carrierMatches` already puts a WAN on `eth1.835` inside `eth1`, and
 * `carrierScopesOverlap` already knows `eth1.835` and `eth1.836` are two
 * different uplinks. It is only accepted as a VLAN tag, so a stray dot cannot
 * turn a name the kernel would refuse into an option in a dropdown.
 */
function carrierParts(device: string): { base: string; tags: string[] } | null {
  if (device.length > MAX_DEVICE_NAME) return null
  const [base = '', ...tags] = device.split('.')
  if (!DEVICE_BASE.test(base)) return null
  if (!tags.every((tag) => VLAN_TAG.test(tag))) return null
  return { base, tags }
}

/**
 * Devices that reach no ISP whatever is tagged on top of them: the loopback,
 * the netdev this module creates *over* a carrier rather than beside one, and
 * the tunnel, mirror and container families.
 */
function isExcludedDevice(base: string): boolean {
  const lower = base.toLowerCase()
  return (
    lower === 'lo' ||
    lower.startsWith('pppoe-') ||
    lower.startsWith('ifb') ||
    lower.startsWith('tun') ||
    lower.startsWith('tap') ||
    lower.startsWith('wg') ||
    lower.startsWith('veth') ||
    lower.startsWith('docker') ||
    lower.startsWith('incus')
  )
}

/** A refusal worded for the check report, so the gate can say why. */
export interface CarrierRefusal {
  label: string
  detail: string
}

/**
 * Why a device may not be a PPPoE batch carrier, or null when it may be one.
 *
 * The dropdown and the check gate ask this one question, because they used to
 * answer it differently. The dropdown has always refused a tagged device - that
 * form takes a VLAN of its own and builds `<carrier>.<vid>` itself - while the
 * gate only asked `isSafeDeviceName`, where a dot is legal because the binding
 * half needs it there. So a hand-submitted `carrier=eth1.835` with VLAN 100 got
 * through a form that would never have offered it, and built device
 * `eth1.835.100` under section `bmv100` - a section whose whole job is to say
 * "VLAN 100 on the carrier" and which now describes something else.
 */
export function pppoeCarrierRefusal(device: string): CarrierRefusal | null {
  const parts = carrierParts(device)
  if (!parts) {
    // The submitted value is deliberately not quoted back: it is the one field
    // here that reached us unparsed, and a report is rendered, not escaped.
    return {
      label: 'Choose a valid carrier interface',
      detail: `A carrier is a device name of at most ${MAX_DEVICE_NAME} characters, such as eth1.`
    }
  }
  if (parts.tags.length > 0) {
    return {
      label: `Carrier ${device} is already a tagged VLAN device`,
      detail:
        `Choose ${parts.base} instead and set the VLAN in this form: it builds ` +
        `${parts.base}.<vid> itself, so a tagged carrier would dial on ` +
        `${device}.<vid>, a device nothing here created.`
    }
  }
  if (parts.base.toLowerCase().startsWith('br-')) {
    return {
      label: `Carrier ${device} is a bridge, not an uplink`,
      detail: 'Choose the device the ISP is reached through, or the VLAN riding on it.'
    }
  }
  if (isExcludedDevice(parts.base)) {
    return {
      label: `Carrier ${device} cannot reach an ISP`,
      detail: 'Loopback, tunnel, mirror and container devices are never carriers.'
    }
  }
  return null
}

function isPppoeCarrier(device: string): boolean {
  return pppoeCarrierRefusal(device) === null
}

/**
 * The WAN Binding carrier, which may be a VLAN as well as the device beneath
 * it. A bare bridge is still refused - a bridge is a LAN, not a WAN uplink -
 * but a tagged VLAN riding on one can be exactly that, which is how a router
 * carrying the ISP VLAN on the LAN bridge is wired.
 */
export function isBindingCarrier(device: string): boolean {
  const parts = carrierParts(device)
  if (!parts) return false
  if (parts.tags.length === 0 && parts.base.toLowerCase().startsWith('br-')) return false
  return !isExcludedDevice(parts.base)
}

/**
 * Dropdown data comes only from the latest RAM model and the cached host
 * document. Opening a form never starts another SSH command.
 */
export function selectOptions(
  kind: unknown,
  model: RouterModel | null,
  _data: OwrtHostData
): FormFieldOption[] {
  if (!model) return []

  if (kind === 'lan-ifaces') {
    return uniqueSorted(
      model.ifaces
        .filter(
          (iface) =>
            iface.name !== 'loopback' &&
            iface.name !== 'wan' &&
            iface.proto === 'static' &&
            iface.ipv4 != null &&
            !iface.l3Device.startsWith('pppoe-')
        )
        .map((iface) => ({
          value: iface.name,
          label: `${iface.name} — ${iface.ipv4?.addr}/${iface.ipv4?.mask}${
            iface.device ? ` on ${iface.device}` : ''
          }`
        }))
    ).slice(0, 500)
  }

  if (kind === 'carriers' || kind === 'binding-carriers') {
    // Two dropdowns, two rules: only the binding form may take a tagged device.
    const accepts = kind === 'carriers' ? isPppoeCarrier : isBindingCarrier
    const usedBy = new Map<string, Set<string>>()
    const add = (device: string, iface: string): void => {
      if (!accepts(device)) return
      const names = usedBy.get(device) ?? new Set<string>()
      names.add(iface)
      usedBy.set(device, names)
    }
    for (const iface of model.ifaces) {
      add(iface.device, iface.name)
      if (iface.proto !== 'pppoe') add(iface.l3Device, iface.name)
    }
    // A raw carrier can exist before it has a UCI interface section.
    for (const device of Object.keys(model.rates)) add(device, '')
    return uniqueSorted(
      [...usedBy].map(([device, names]) => {
        const labels = [...names].filter(Boolean).slice(0, 3)
        return {
          value: device,
          label: labels.length ? `${device} — ${labels.join(', ')}` : device
        }
      })
    ).slice(0, 500)
  }
  return []
}
