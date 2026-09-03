// ip rules, over netlink, without forking anything.
//
// This is the file that makes the package worth installing. A thousand bound
// clients is a thousand `ip -4 rule add` processes if you do it the obvious
// way - a fork, an exec, a dynamic link and a netlink round trip each - and
// perhaps a minute of a small router's CPU. Here it is a thousand messages on
// one socket that ucode already holds open, and about a second.
//
// The socket is opened by the rtnl module on first use and kept, so nothing
// here has to manage it.
//
// Everything is in CIDR throughout - `10.0.0.7/32` for a client, `10.0.0.0/24`
// for the LAN - because that is the form the kernel reports and the one form
// that can express both. An earlier draft took a bare address and appended
// `/32`; it worked for every client rule and silently could not match the
// catch-all, which is the one rule that matters most.
//
// Routes as well as rules, since 2.4.0. The `unreachable default` each parked
// address is aimed at, and the connected route that keeps the router itself
// reachable from the LAN it is blocking, used to be written by forking `ip` -
// which needed `ip-full` on the router for a numeric table and gave the package
// a dependency on a binary it otherwise never touched. They are the same three
// fields over the same socket, so they are written here.

import * as rtnl from 'rtnl';

import { debug, err } from 'bm.log';

// `const` is a keyword, so this cannot be destructured in an import - which is
// why the in-tree ucode that uses nl80211 spells it `nl80211.const.X` too.
const C = rtnl.const ?? {};

function arrayOr(value) {
	return (type(value) == 'array') ? value : [];
}

function objectOr(value) {
	return (type(value) == 'object') ? value : {};
}

/** A destination, with either spelling of "the default route" as ''. */
function defaultless(value) {
	let dst = (type(value) == 'string') ? value : '';
	return (dst == '0.0.0.0/0' || dst == 'default' || dst == '0.0.0.0') ? '' : dst;
}


/**
 * "Any scope", for a delete. rtnl exports it, but this module reads every
 * constant off `rtnl.const` at load and a build whose module does not carry one
 * would leave the field null - which the kernel reads as scope universe, and
 * then no connected route ever matches. 255 is the kernel's own number and has
 * not moved.
 */
const SCOPE_NOWHERE = (type(C.RT_SCOPE_NOWHERE) == 'int') ? C.RT_SCOPE_NOWHERE : 255;

/**
 * Clear whatever complaint is sitting in the socket, and say nothing about it.
 *
 * `rtnl.error()` is one-shot - the C module hands back the message and calls
 * `set_error(0, NULL)` on the way out - so an error nobody read stays there
 * until somebody does. Every write below therefore starts by discarding it,
 * because otherwise the failure of a *dump* three lines earlier is what the
 * next `add()` reports about a rule that went in perfectly.
 */
function clearError() {
	rtnl.error();
}

/** The last netlink complaint, worded for a log line. Reads and clears. */
function reason() {
	let text = rtnl.error();
	return (type(text) == 'string' && length(text)) ? text : 'netlink gave no reason';
}

/**
 * Every IPv4 rule on the router, as { pref, cidr, table }.
 *
 * Null - not an empty array - when the dump itself failed. The difference
 * matters: "this router has no rules" would make the reconcile pass decide
 * every assignment had been removed and write all of them again.
 */
export function rules() {
	let dump;

	try {
		dump = rtnl.request(C.RTM_GETRULE, C.NLM_F_DUMP, { family: C.AF_INET });
	}
	catch (e) {
		err('cannot read the router\'s ip rules: ' + e);
		return null;
	}

	if (type(dump) != 'array') {
		err('cannot read the router\'s ip rules: ' + reason());
		return null;
	}

	let out = [];
	for (let one in dump) {
		if (type(one) != 'object')
			continue;

		// No source or no table is not the shape this package writes, and no
		// priority means one of the kernel's own unnumbered entries.
		if (type(one.priority) != 'int' || type(one.src) != 'string' || type(one.table) != 'int')
			continue;

		push(out, { pref: one.priority, cidr: one.src, table: one.table });
	}

	return out;
};

function payload(pref, cidr, table) {
	return {
		family: C.AF_INET,
		priority: pref,
		// The kernel stores the prefix length out of this string, which is how
		// one field says both "this address" and "this network".
		src: cidr,
		table: table,
		// FR_ACT_TO_TBL is what `lookup <table>` means. Without it the kernel is
		// being asked for a rule with no action, which it will not take.
		action: C.FR_ACT_TO_TBL
	};
}

/**
 * Add one rule. True when the router has it afterwards.
 *
 * NLM_F_EXCL rather than a replace: two rules at one priority is a state the
 * kernel allows and nothing here wants, and being told one already existed is
 * more useful than ending up with two.
 */
/**
 * Whether the write that just went out actually failed.
 *
 * `rtnl.request` answers a *dump* with an array and a write with **null**, on
 * success as well as on failure - so the natural `if (!ok)` reads every rule
 * this module has ever written as a rule it could not write. On a real router
 * that meant an `err()` line per binding per pass saying the address "is not
 * going where its binding says", while the rule sat in the kernel exactly where
 * it belonged, and the pass counters stayed at zero for ever.
 *
 * The socket's own error is the only thing that distinguishes the two. Nothing
 * here can be inferred from the return value.
 */
function failed(answer) {
	if (answer === false)
		return true;

	let text = rtnl.error();
	return type(text) == 'string' && length(text) > 0;
}

export function add(pref, cidr, table) {
	let answer;

	// Before the write, not after it. See `clearError`: the message left by
	// whatever last failed - a dump on a busy socket, a delete of a rule that
	// was already gone - is otherwise read as this rule's failure.
	clearError();

	try {
		answer = rtnl.request(C.RTM_NEWRULE, C.NLM_F_CREATE | C.NLM_F_EXCL, payload(pref, cidr, table));
	}
	catch (e) {
		debug(sprintf('cannot add rule pref %d from %s table %d: %s', pref, cidr, table, e));
		return false;
	}

	if (failed(answer)) {
		debug(sprintf('cannot add rule pref %d from %s table %d: %s', pref, cidr, table, reason()));
		return false;
	}

	return true;
};

/**
 * Remove one rule.
 *
 * The same four fields the add used, because the kernel matches a delete
 * against what it is given: deleting by priority alone would take away a rule
 * somebody else happened to put at that number.
 */
export function remove(pref, cidr, table) {
	let answer;

	clearError();

	try {
		answer = rtnl.request(C.RTM_DELRULE, 0, payload(pref, cidr, table));
	}
	catch (e) {
		debug(sprintf('cannot remove rule pref %d from %s table %d: %s', pref, cidr, table, e));
		return false;
	}

	if (failed(answer)) {
		debug(sprintf('cannot remove rule pref %d from %s table %d: %s', pref, cidr, table, reason()));
		return false;
	}

	return true;
};

/**
 * The same payload, keyed on where a packet is going rather than where it came
 * from.
 *
 * Its own builder rather than a flag on the one above, because a rule carrying
 * both a source and a destination is a third thing that nothing here wants and
 * that a single mistyped argument would silently produce.
 */
function destPayload(pref, dst, table) {
	return {
		family: C.AF_INET,
		priority: pref,
		dst: dst,
		table: table,
		action: C.FR_ACT_TO_TBL
	};
}

/**
 * Add a rule that matches on destination. True when the router has it after.
 *
 * What this exists for is one sentence: an address bound to a WAN must still be
 * able to reach the networks this router itself serves. A binding's rule sends
 * *everything* from that address to the WAN's table, and that table knows only
 * how to leave the building - so a bound machine could reach the internet and
 * not the machine on the next desk, or the router's other LAN, and the traffic
 * went out of the WAN port addressed to a private network that would drop it.
 *
 * The daemon already understood this everywhere else: `installHold` writes the
 * connected routes beside the blackhole precisely so a held address can still
 * reach its neighbours, and an instance's catch-all table would take the router
 * off its own LAN without them. A bound address was the one case left out.
 */
export function addDest(pref, dst, table) {
	let answer;

	clearError();

	try {
		answer = rtnl.request(C.RTM_NEWRULE, C.NLM_F_CREATE | C.NLM_F_EXCL, destPayload(pref, dst, table));
	}
	catch (e) {
		debug(sprintf('cannot add rule pref %d to %s table %d: %s', pref, dst, table, e));
		return false;
	}

	if (failed(answer)) {
		debug(sprintf('cannot add rule pref %d to %s table %d: %s', pref, dst, table, reason()));
		return false;
	}

	return true;
};

/** And take one away again. */
export function removeDest(pref, dst, table) {
	let answer;

	clearError();

	try {
		answer = rtnl.request(C.RTM_DELRULE, 0, destPayload(pref, dst, table));
	}
	catch (e) {
		debug(sprintf('cannot remove rule pref %d to %s table %d: %s', pref, dst, table, e));
		return false;
	}

	if (failed(answer)) {
		debug(sprintf('cannot remove rule pref %d to %s table %d: %s', pref, dst, table, reason()));
		return false;
	}

	return true;
};

/**
 * Whether netlink is usable at all.
 *
 * Asked once at start-up so that a router where the socket cannot be opened
 * says so in one line, rather than failing on every rule for ever.
 */
export function usable() {
	return rules() !== null;
};

/**
 * Which of a set of rules the kernel is actually holding.
 *
 * The write said it worked. This asks whether it is there, and the difference
 * is not pedantry: on a router carrying a Bored Manager module older than
 * 3.4.0, every rule this daemon writes into the one-to-one band is removed
 * again a second or two later by that module's own sweep, and from inside one
 * pass that is indistinguishable from a socket that never carried the message.
 * The report used to say "written: 12" either way. It says "written: 12,
 * unverified: 12" now, and the log line names what is doing it.
 *
 * One dump for the whole set rather than one per rule. `read` false means the
 * dump itself failed, which is not evidence about any rule - the caller counts
 * nothing rather than reporting every write as lost.
 */
export function verifyPresent(list) {
	let wanted = arrayOr(list);

	if (!length(wanted))
		return { read: true, present: [], missing: [] };

	let held = rules();

	if (held === null)
		return { read: false, present: [], missing: [] };

	let seen = {};
	for (let one in held)
		seen[sprintf('%d|%s|%d', one.pref, one.cidr, one.table)] = true;

	let present = [];
	let missing = [];

	for (let one in wanted) {
		if (seen[sprintf('%d|%s|%d', one.pref, one.cidr, one.table)] === true)
			push(present, one);
		else
			push(missing, one);
	}

	return { read: true, present: present, missing: missing };
};

/**
 * Every IPv4 rule on the router, including the ones this package never writes.
 *
 * `rules()` above drops anything without a source or a table, because those are
 * not the shape this package writes and the reconcile pass has no use for them.
 * The monitor is the opposite question - what else is steering traffic on this
 * router, and why is that address not on the default connection - so nothing is
 * dropped here. The kernel's own unnumbered entries come back with `pref` 0 and
 * an empty `cidr`, which is what they are.
 */
export function allRules() {
	let dump;

	try {
		dump = rtnl.request(C.RTM_GETRULE, C.NLM_F_DUMP, { family: C.AF_INET });
	}
	catch (e) {
		err('cannot read the router\'s ip rules: ' + e);
		return null;
	}

	if (type(dump) != 'array') {
		err('cannot read the router\'s ip rules: ' + reason());
		return null;
	}

	let out = [];
	for (let one in dump) {
		if (type(one) != 'object')
			continue;

		// The destination selector as well as the source. Nothing this package
		// writes uses one, which is exactly why it has to be read: netifd puts
		// a `to <address>` rule on every interface with a routing table of its
		// own, and a reader that saw only sources would report each of them as
		// a rule selecting nothing at all.
		push(out, {
			pref: (type(one.priority) == 'int') ? one.priority : 0,
			cidr: (type(one.src) == 'string') ? one.src : '',
			dst: (type(one.dst) == 'string') ? one.dst : '',
			table: (type(one.table) == 'int') ? one.table : 0,
			action: (type(one.action) == 'int') ? one.action : 0,
			iif: (type(one.iif) == 'string') ? one.iif : '',
			oif: (type(one.oif) == 'string') ? one.oif : '',
			fwmark: (type(one.fwmark) == 'int') ? one.fwmark : 0
		});
	}

	return out;
};

/**
 * Every rule that matches on a destination and nothing else.
 *
 * Which is what a LAN-local escape is: no source, a destination network, and a
 * table to send it to. `rules()` above drops them - it keeps only what has a
 * source, because that is the shape the reconcile pass writes - so the escapes
 * need a reader of their own rather than a widened one. Widening `rules()`
 * would put netifd's own `to <interface address> lookup <its table>` rules in
 * front of a flush that sweeps a band by priority, and that flush would take
 * them off the router.
 */
export function destRules() {
	let all = allRules();

	if (all === null)
		return null;

	let out = [];

	for (let one in all) {
		if (length(one.cidr) || !length(one.dst) || one.table <= 0)
			continue;

		push(out, { pref: one.pref, dst: one.dst, table: one.table });
	}

	return out;
};

/**
 * Every IPv4 route on the router, from every table.
 *
 * The device is read from `oif`, which is the key ucode's rtnl module answers
 * with - `dev` collects nothing at all, and an empty list is indistinguishable
 * from a router with no routes, so that mistake is silent. It cost a release
 * once; see the classifier next door.
 */
export function routes() {
	let dump;

	try {
		dump = rtnl.request(C.RTM_GETROUTE, C.NLM_F_DUMP, { family: C.AF_INET });
	}
	catch (e) {
		debug('cannot read the router\'s routes: ' + e);
		return null;
	}

	if (type(dump) != 'array') {
		debug('cannot read the router\'s routes: ' + reason());
		return null;
	}

	let out = [];
	for (let one in dump) {
		if (type(one) != 'object')
			continue;

		// `dst` arrives already carrying its prefix - `12.10.10.0/24` - and
		// `dst_len` is not answered at all, which is worth stating because the
		// obvious reading is the other way round. Checked against a real
		// router: a default route comes back with `dst` null and nothing else
		// to say it is a default, so the empty string is what means "everything
		// with nowhere better to go" here.
		//
		// `0.0.0.0/0` is normalised to that same empty string, because it is the
		// spelling a default is *written* with and anything echoing back what it
		// was given answers with it. One test downstream rather than two is
		// worth more than being literal about which half answered.
		push(out, {
			table: (type(one.table) == 'int') ? one.table : 0,
			dst: defaultless(one.dst),
			oif: (type(one.oif) == 'string') ? one.oif : '',
			gateway: (type(one.gateway) == 'string') ? one.gateway : '',
			kind: (type(one.type) == 'int') ? one.type : 0,
			scope: (type(one.scope) == 'int') ? one.scope : 0
		});
	}

	return out;
};

/** The destination of one route as a caller may send it back. */
export function routeDestination(one) {
	let dst = (type(one) == 'object' && type(one.dst) == 'string') ? one.dst : '';
	return length(dst) ? dst : '0.0.0.0/0';
};

/**
 * Write one route, replacing whatever is at that destination in that table.
 *
 * Both routes this package needs are written through here: the `unreachable
 * default` a parked address is aimed at, and the connected route that keeps the
 * router itself reachable from a LAN whose devices are all pointed at that
 * table. Both used to be `popen('ip -4 route replace ...')`, which meant the
 * package depended on an `ip` that takes a numeric table - the BusyBox applet
 * does not - for two lines, having written every rule over netlink already.
 *
 * `NLM_F_CREATE | NLM_F_REPLACE` is what `ip route replace` is: write it if it
 * is missing, overwrite it if it is not, and never fail for either reason. That
 * matters because this runs on every pass that parks anything.
 */
export function routeReplace(spec) {
	let one = objectOr(spec);
	let message = {
		family: C.AF_INET,
		table: one.table,
		dst: (type(one.dst) == 'string') ? one.dst : '0.0.0.0/0',
		type: (type(one.kind) == 'int') ? one.kind : C.RTN_UNICAST
	};

	if (type(one.oif) == 'string' && length(one.oif))
		message.oif = one.oif;

	if (type(one.gateway) == 'string' && length(one.gateway))
		message.gateway = one.gateway;

	if (type(one.scope) == 'int')
		message.scope = one.scope;

	let answer;

	clearError();

	try {
		answer = rtnl.request(C.RTM_NEWROUTE, C.NLM_F_CREATE | C.NLM_F_REPLACE, message);
	}
	catch (e) {
		debug(sprintf('cannot write route %s table %d: %s', message.dst, message.table, e));
		return false;
	}

	if (failed(answer)) {
		debug(sprintf('cannot write route %s table %d: %s', message.dst, message.table, reason()));
		return false;
	}

	return true;
};

/**
 * Take one route back out.
 *
 * `scope` is sent as RT_SCOPE_NOWHERE, which is what `ip route del` sends and
 * what the kernel reads as "any scope". Without it `rtm_scope` is zero -
 * RT_SCOPE_UNIVERSE - and `fib_table_delete` compares that against the route's
 * own scope, so a link-scoped connected route is never matched and the delete
 * answers ENOENT while the route sits there. On a real router that was the
 * connected route beside a catch-all surviving every teardown, in a table
 * nothing would ever look at again.
 */
export function routeRemove(spec) {
	let one = objectOr(spec);
	let message = {
		family: C.AF_INET,
		table: one.table,
		dst: (type(one.dst) == 'string' && length(one.dst)) ? one.dst : '0.0.0.0/0',
		scope: SCOPE_NOWHERE
	};

	if (type(one.oif) == 'string' && length(one.oif))
		message.oif = one.oif;

	let answer;

	clearError();

	try {
		answer = rtnl.request(C.RTM_DELROUTE, 0, message);
	}
	catch (e) {
		debug(sprintf('cannot remove route %s table %d: %s', message.dst, message.table, e));
		return false;
	}

	// A route that was not there is not a failure to remove one, and this runs
	// on every teardown of a table that may never have been armed.
	if (failed(answer)) {
		debug(sprintf('cannot remove route %s table %d: %s', message.dst, message.table, reason()));
		return false;
	}

	return true;
};
