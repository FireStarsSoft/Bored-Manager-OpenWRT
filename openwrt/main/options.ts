import type { FormFieldOption } from '@shared/module-ui'
import type { OwrtHostData } from './store'
import type { RouterModel } from './types'

export type OpenWrtOptionKind = 'lan-ifaces' | 'carriers' | 'batches'

function uniqueSorted(options: FormFieldOption[]): FormFieldOption[] {
  const byValue = new Map<string, FormFieldOption>()
  for (const option of options) {
    if (option.value && !byValue.has(option.value)) byValue.set(option.value, option)
  }
  return [...byValue.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value)
  )
}

function isPhysicalCarrier(device: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,15}$/.test(device)) return false
  const lower = device.toLowerCase()
  return !(
    lower === 'lo' ||
    lower.startsWith('br-') ||
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

/**
 * Dropdown data comes only from the latest RAM model and the cached host
 * document. Opening a form never starts another SSH command.
 */
export function selectOptions(
  kind: unknown,
  model: RouterModel | null,
  data: OwrtHostData
): FormFieldOption[] {
  if (kind === 'batches') {
    return data.batches.map((batch) => ({
      value: batch.id,
      label: `${batch.name} (${batch.prefix}, ${batch.count})`
    }))
  }
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

  if (kind === 'carriers') {
    const usedBy = new Map<string, Set<string>>()
    const add = (device: string, iface: string): void => {
      if (!isPhysicalCarrier(device)) return
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
