// Stub of ucode-mod-rtnl for the compile-time syntax check. See ../README.md.
//
// No `const`. The real module exports an object under that name - `RTM_NEWRULE`,
// `NLM_F_DUMP`, `FR_ACT_TO_TBL` and the rest live on it - and `const` is a ucode
// keyword, so there is no way to spell `export const const` here. It costs
// nothing: everything in this package reaches it as `rtnl.const.X` through
// `import * as rtnl`, which is a property lookup at run time and not a name the
// compiler ever checks.

export function request(cmd, flags, payload) { return null; };
export function listener(callback, groups) { return null; };
export function error(numeric) { return null; };
