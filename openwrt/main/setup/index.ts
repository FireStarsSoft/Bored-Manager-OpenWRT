/**
 * Installing what the router is missing, from the settings page.
 *
 * Until now the module could only say "install ppp, ppp-mod-pppoe and
 * kmod-pppoe yourself, then come back", which is a fine sentence and a poor
 * feature: the user has to find a shell, guess which package manager this
 * firmware ships, and then guess again whether it worked.
 *
 * The command line is built from `../packages.ts` and nothing else. No value
 * that arrives from the form ever reaches a shell - the three checkboxes select
 * *which* frozen group runs, never *what* runs - and every name is quoted on
 * the way out anyway.
 *
 * `plan.ts` is the gate an install has to pass and `install.ts` is the job that
 * follows it, together with every command string the module can produce and the
 * one reader that repeats a package manager's output back. `manager.ts` is the
 * object the module holds and `runtime.ts` is the state it carries. Import this
 * barrel, never a file inside it.
 */
export type { SetupDeps, SetupJobs } from './runtime'
export { SetupManager } from './manager'
