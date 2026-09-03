// A tiny kernel, rather than a stand-in for one. See ../README.md.
//
// This file used to answer `null` to everything, and the README was right that
// a stub is not a specification - but a stub that cannot be wrong is also a
// stub that cannot catch anything, and this one hid two real faults for as long
// as it existed. The first was `layout.defaultRouteDevices()` reading a route's
// device under `dev` where the real module answers `oif`: nothing here ever
// returned a route, so no probe could tell "this router has no default route"
// from "this code cannot read one at all". The second is the reason this file
// grew: a rule the daemon reports as written and the kernel does not hold is
// indistinguishable, against a stub that stores nothing, from a rule that
// landed - which is precisely the failure the verify pass exists to name.
//
// So it stores. `request()` dispatches on the command the way the kernel does:
// a dump answers an array, a write answers null and either keeps or refuses the
// change, and `error()` is one-shot exactly as the C module's is (it calls
// set_error(0, NULL) on the way out, so a second read of one failure is empty).
// `setDropAdds(true)` is the one thing a real kernel will not do on request:
// accept a write, report no error, and not hold the rule afterwards.
//
// The constants are real numbers under a string export alias. `const` is a
// ucode keyword so it cannot be a variable name, but `export { X as 'const' }`
// is legal and a wildcard import turns it into the `rtnl.const` property every
// caller here already reads. The values are Linux's own, because a probe that
// asserted against invented ones would pass while the daemon sent nonsense.

const CONSTANTS = {
	AF_INET: 2,
	AF_INET6: 10,

	RTM_NEWROUTE: 24,
	RTM_DELROUTE: 25,
	RTM_GETROUTE: 26,
	RTM_NEWRULE: 32,
	RTM_DELRULE: 33,
	RTM_GETRULE: 34,

	NLM_F_REQUEST: 1,
	NLM_F_ACK: 4,
	NLM_F_DUMP: 768,
	NLM_F_REPLACE: 256,
	NLM_F_EXCL: 512,
	NLM_F_CREATE: 1024,

	FR_ACT_UNSPEC: 0,
	FR_ACT_TO_TBL: 1,
	FR_ACT_BLACKHOLE: 6,
	FR_ACT_UNREACHABLE: 7,

	RTN_UNSPEC: 0,
	RTN_UNICAST: 1,
	RTN_BLACKHOLE: 6,
	RTN_UNREACHABLE: 7,

	RT_SCOPE_UNIVERSE: 0,
	RT_SCOPE_LINK: 253,
	RT_SCOPE_HOST: 254,
	RT_SCOPE_NOWHERE: 255,

	RT_TABLE_MAIN: 254,
	RT_TABLE_LOCAL: 255
};

export { CONSTANTS as 'const' };

// What the kernel is holding. `routes` is null until a probe seeds it, which is
// how "this router was never asked about" stays distinguishable from "this
// router has no routes"; `rules` starts empty because every rule in it got
// there by being written.
let routes = null;
let rules = [];
let rulesReadable = true;
let lastError = null;
let dropAdds = false;
let dumps = 0;

/** Seed the route table a dump will answer with. */
export function setRoutes(list) {
	routes = (type(list) == 'array') ? list : null;
};

/** Seed the rule table, as a probe would find one it did not write. */
export function setRules(list) {
	rules = [];
	for (let one in (type(list) == 'array') ? list : [])
		push(rules, { ...one });
};

/**
 * Whether a rule dump answers at all.
 *
 * `false` is a busy or missing netlink socket, and it is a state worth being
 * able to ask for on purpose: a pass that read "no answer" as "this router has
 * no rules" would write every binding again on every tick. The stored rules are
 * kept while it is off, so a probe can prove the refused pass left them alone.
 */
export function setRulesReadable(flag) {
	rulesReadable = (flag !== false);
};

/**
 * How many rule dumps have been asked for, and a way to start again at zero.
 *
 * A dump is the expensive read in this package: at a thousand rules it is a
 * netlink round trip per pass, and a pass that asks for one per instance rather
 * than one per pass is correct, invisible, and four times the cost. Nothing but
 * a counter can tell those apart.
 */
export function ruleDumps() {
	return dumps;
};

export function resetRuleDumps() {
	dumps = 0;
};

/** What the kernel holds now - the witness a probe asserts against. */
export function kernelRules() {
	let out = [];
	for (let one in rules)
		push(out, { ...one });
	return out;
};

/**
 * Accept every add and keep none of it.
 *
 * There is no way to ask a real kernel for this, and it is the one behaviour
 * the verify pass was written for: on a router carrying an older Bored Manager
 * module, a rule written by the daemon is deleted a second or two later by
 * something else, and from inside one pass that looks exactly like a write that
 * never landed.
 */
export function setDropAdds(flag) {
	dropAdds = (flag === true);
};

function fail(message) {
	lastError = message;
	return false;
}

// A rule is its priority, its selector and where it sends the packet - and the
// selector is two things, not one. A rule matching on destination is a different
// rule from one matching on source at the same priority, and a key that read
// only `src` made the LAN-local escapes - which have no source at all - collide
// with each other the moment there was more than one LAN: the second add found
// the first under the same key, answered EEXIST, and a daemon that had written
// four rules held one.
function ruleKey(one) {
	return sprintf('%d|%s|%s|%d', one.priority ?? 0, one.src ?? '', one.dst ?? '', one.table ?? 0);
}

function findRule(payload) {
	let want = ruleKey(payload);
	for (let i = 0; i < length(rules); i++) {
		if (ruleKey(rules[i]) == want)
			return i;
	}
	return -1;
}

function findByPriority(payload) {
	let want = payload.priority ?? 0;
	for (let i = 0; i < length(rules); i++) {
		if ((rules[i].priority ?? 0) == want)
			return i;
	}
	return -1;
}

function addRule(flags, payload) {
	// EEXIST under NLM_F_EXCL is the answer a real kernel gives for a second
	// rule at one priority with the same selector, and the daemon reads it as
	// "somebody already put that there" rather than as a failure to write.
	if (findRule(payload) >= 0 && (flags & CONSTANTS.NLM_F_EXCL))
		return fail('RTNETLINK answers: File exists');

	if (dropAdds)
		return null;

	push(rules, {
		priority: payload.priority ?? 0,
		src: payload.src ?? '',
		dst: payload.dst ?? '',
		table: payload.table ?? 0,
		action: payload.action ?? CONSTANTS.FR_ACT_TO_TBL,
		family: payload.family ?? CONSTANTS.AF_INET
	});

	return null;
}

function removeRule(payload) {
	// By the whole selector when one is given, by priority alone when the
	// caller sent only that - which is what `ip rule del pref N` does. Either
	// selector counts as one: a delete naming a destination has to miss a rule
	// that carries a different one, or a flush sweeping a band by priority and
	// a delete aimed at one escape rule would be the same call.
	let at = (payload.src == null && payload.dst == null)
		? findByPriority(payload)
		: findRule(payload);

	if (at < 0)
		return fail('RTNETLINK answers: No such file or directory');

	let kept = [];
	for (let i = 0; i < length(rules); i++) {
		if (i != at)
			push(kept, rules[i]);
	}

	rules = kept;
	return null;
}

function routeKey(one) {
	return sprintf('%s|%d', one.dst ?? '', one.table ?? 0);
}

/**
 * Whether a delete request matches a route the way `fib_table_delete` does.
 *
 * Scope is the part that is easy to get wrong and impossible to notice: an
 * unspecified `rtm_scope` is zero, which is RT_SCOPE_UNIVERSE and a real value,
 * so the kernel compares it against the route's own and a link-scoped connected
 * route never matches. `ip route del` sends RT_SCOPE_NOWHERE, which is the one
 * value that means "any". A real router answered ENOENT and left the route in
 * place while the caller counted a success; a stub that matched on destination
 * alone had nothing to say about it.
 */
function deleteMatches(held, want) {
	if (routeKey(held) != routeKey(want))
		return false;

	let scope = (type(want.scope) == 'int') ? want.scope : 0;
	if (scope != CONSTANTS.RT_SCOPE_NOWHERE && (held.scope ?? 0) != scope)
		return false;

	if (type(want.oif) == 'string' && length(want.oif) && (held.oif ?? '') != want.oif)
		return false;

	return true;
}

function addRoute(flags, payload) {
	if (type(routes) != 'array')
		routes = [];

	let want = routeKey(payload);
	let kept = [];

	for (let one in routes) {
		if (routeKey(one) == want && (flags & CONSTANTS.NLM_F_REPLACE))
			continue;

		push(kept, one);
	}

	routes = kept;
	push(routes, { ...payload });
	return null;
}

function removeRoute(payload) {
	if (type(routes) != 'array')
		return fail('RTNETLINK answers: No such process');

	let kept = [];
	let hit = false;

	for (let one in routes) {
		if (!hit && deleteMatches(one, payload)) {
			hit = true;
			continue;
		}

		push(kept, one);
	}

	if (!hit)
		return fail('RTNETLINK answers: No such process');

	routes = kept;
	return null;
}

/**
 * One netlink round trip.
 *
 * The return values are the C module's: a dump answers an array, a write
 * answers `null` whether or not it worked, and only `error()` tells the two
 * apart. Anything that fails to parse answers `false`, which is what the real
 * module returns for STATE_ERROR.
 *
 * Dispatched on the **command**, never on the flags, and that is not a style
 * choice. `NLM_F_DUMP` is `NLM_F_ROOT | NLM_F_MATCH` = 0x300, and `NLM_F_EXCL`
 * is 0x200 - so `flags & NLM_F_DUMP` is true of every `RTM_NEWRULE` this
 * package sends. A first draft of this file tested the flags, read every add as
 * a dump, answered it with the rule table, and stored nothing: the daemon then
 * reported three rules written and none held, which is the exact fault the
 * read-back exists to catch, arriving from the stub rather than from a router.
 */
export function request(cmd, flags, payload) {
	let args = (type(payload) == 'object') ? payload : {};
	let bits = (type(flags) == 'int') ? flags : 0;

	if (cmd == CONSTANTS.RTM_GETRULE) {
		dumps++;

		if (!rulesReadable)
			return null;

		let out = [];
		for (let one in rules)
			push(out, { ...one });
		return out;
	}

	if (cmd == CONSTANTS.RTM_GETROUTE)
		return routes;

	if (cmd == CONSTANTS.RTM_NEWRULE)
		return addRule(bits, args);

	if (cmd == CONSTANTS.RTM_DELRULE)
		return removeRule(args);

	if (cmd == CONSTANTS.RTM_NEWROUTE)
		return addRoute(bits, args);

	if (cmd == CONSTANTS.RTM_DELROUTE)
		return removeRoute(args);

	return null;
};

export function listener(callback, groups) {
	return null;
};

/**
 * The last complaint, and then nothing.
 *
 * One-shot exactly as `uc_nl_error` is: it returns the message and clears the
 * slot, so code that reads it twice sees the failure once. Every caller that
 * wants a clean read has to clear it before the request rather than after.
 */
export function error(numeric) {
	let text = lastError;
	lastError = null;
	return text;
};
