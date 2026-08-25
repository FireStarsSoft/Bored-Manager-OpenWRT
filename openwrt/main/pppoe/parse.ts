/**
 * Reading the batch form. Every value here arrives as `unknown` from a handler
 * and may be anything at all, so nothing below trusts its input.
 *
 * The account list itself is parsed by `parsePppoeList` in the shared parser;
 * what stays here is the rest of the form and the one rule that matters for the
 * check token: `tokenValues` strips the credentials back out before the values
 * are hashed, so the token can be re-checked without the passwords being kept
 * anywhere but the frozen plan.
 */

import { textField } from '../util'

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The shared form reader, under the name this folder already calls it by. */
export { textField as text }

export function tokenValues(values: Record<string, unknown>): Record<string, unknown> {
  return { ...values, listFile: '', listText: '' }
}

export function parseOptionalVlan(
  values: Record<string, unknown>
): { value?: number; error?: string } {
  const raw = textField(values, 'vlan')
  if (!raw || raw === '0') return {}
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 4094) {
    return { error: 'Batch VLAN must be a whole number between 1 and 4094' }
  }
  return { value }
}
