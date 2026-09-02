// The two numbers everything else quotes, and the comparison that orders them.
//
// RELEASE is what was installed. API_VERSION is the contract with the module:
// the module refuses to drive an agent whose API version it does not know and
// goes back to SSH rather than guessing, so this moves only when the shape of a
// call changes in a way an older module cannot cope with. Installing a newer
// agent must not, on its own, take a working router away from an older app.
//
// RELEASE has to match PKG_VERSION in the Makefile and packages/version.json.
// `npm run packages:check` fails the build when they disagree.

export const RELEASE = '2.4.0';
export const API_VERSION = 3;

// The shape of the data on disk - configuration and the agent's own state.
// A third number rather than a reuse of one above, because it moves for a
// third reason: a release that only fixes a bug touches neither, a release
// that adds a ubus call touches API_VERSION, and only a release that changes
// what is written to /etc touches this. It is what a downgrade is refused on,
// and what the migration chain counts up to.
//
// 2 is the pool-of-members shape of /etc/config/bm_pppoe: pools carry a mode
// and per-VLAN member sections instead of a sequence range. Old pool sections
// are left in place for delete-only handling; the step to 2 stamps and moves
// nothing, but it has to exist so the chain is unbroken.
//
// 3 is the scoped instance in /etc/config/bm_wanbind: `config instance` may
// carry `range_from`/`range_to` and `clients_per_wan`. Nothing is moved by the
// step - every section written before it means the whole LAN and one client per
// WAN, which is what an absent option already reads as. It moves because the
// gate has to run the other way: a 2.3.0 build reading a section with a range
// would bind the whole LAN behind a whole-LAN catch-all and blackhole every
// address outside the range, silently, on a router somebody had deliberately
// scoped. Refusing to start is the only honest answer to that.
export const CONFIG_SCHEMA = 3;

// `1.2.10` -> [1, 2, 10]. Anything that is not three dotted numbers - a build
// somebody hand-edited, an empty string from a file that was not there - comes
// back null, and every caller treats null as "cannot be compared" rather than
// as zero. Reading an unparseable version as 0.0.0 would make it older than
// everything, which is the exact wrong answer for a downgrade check.
export function parse(text) {
	if (type(text) != 'string')
		return null;

	let parts = match(trim(text), /^([0-9]+)\.([0-9]+)\.([0-9]+)$/);
	return parts ? [ int(parts[1]), int(parts[2]), int(parts[3]) ] : null;
};

// -1, 0 or 1, or null when either side could not be parsed. Null is deliberate:
// a caller deciding whether an update is a downgrade has to be able to tell
// "older" from "no idea", and refuse on the second rather than proceed.
export function compare(left, right) {
	let a = parse(left);
	let b = parse(right);

	if (!a || !b)
		return null;

	for (let i = 0; i < 3; i++) {
		if (a[i] != b[i])
			return (a[i] < b[i]) ? -1 : 1;
	}

	return 0;
};

// True when `candidate` is strictly newer than `current`. Unknown on either
// side is not newer: an update the agent cannot reason about is one it does not
// take.
export function isNewer(candidate, current) {
	return compare(candidate, current) === 1;
};
