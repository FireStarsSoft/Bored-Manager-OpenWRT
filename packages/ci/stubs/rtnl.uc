// Stub of ucode-mod-rtnl for the compile-time syntax check. See ../README.md.
//
// No `const`. The real module exports an object under that name - `RTM_NEWRULE`,
// `NLM_F_DUMP`, `FR_ACT_TO_TBL` and the rest live on it - and `const` is a ucode
// keyword, so there is no way to spell `export const const` here. It costs
// nothing: everything in this package reaches it as `rtnl.const.X` through
// `import * as rtnl`, which is a property lookup at run time and not a name the
// compiler ever checks - except at module scope, where `const C = rtnl.const`
// binds the null once and every lookup off it raises for the life of the
// process. The two files that do that read it as `?? {}` for exactly this
// reason, which is what lets a probe drive the route reading below.

/**
 * What the kernel is pretending to hold, if a probe has said so.
 *
 * Answering `null` to everything was the whole of this stub, and it hid a real
 * fault for as long as it existed: `layout.defaultRouteDevices()` read the
 * device off a route entry under `dev`, ucode's rtnl module answers with
 * `oif`, and because nothing here ever returned a route the probe could not
 * tell the difference between "no default route on this router" and "this code
 * cannot read one at all". A router shell found it in a second. Set the answer
 * with `setRoutes()` and the shape below is the shape a real dump has.
 */
let routes = null;

export function setRoutes(list) { routes = list; };

export function request(cmd, flags, payload) {
	return routes;
};
export function listener(callback, groups) { return null; };
export function error(numeric) { return null; };
