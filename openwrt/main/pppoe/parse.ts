/**
 * The two readers every handler in this folder starts with. Values arrive as
 * `unknown` from the renderer and may be anything at all, so nothing below
 * trusts its input.
 */
import { textField } from '../util'

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The shared form reader, under the name this folder already calls it by. */
export { textField as text }
