/**
 * Reading the router: one cheap sweep on the fast poller, one heavier probe on
 * the slow one.
 *
 * `sweep.ts` is the object the module holds, `runtime.ts` is the state it
 * carries, and `fast.ts` and `slow.ts` are the two ticks. Around them sit the
 * pieces each tick needs: the commands themselves, the sections that take more
 * than a text reader, the overview payload, and the health record every surface
 * shows next to the numbers. The plain section readers are not here at all -
 * they live in `../parse.ts`, which the rest of the module shares. Import this
 * barrel, never a file inside it.
 */
export { buildFastSweepCommand, isManagedRange, type ManagedPppoeRange } from './command'
export { sampleHistory } from './history'
export type { FastSweepHooks } from './runtime'
export { FastSweep } from './sweep'
