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
// Deliberately only rules. The one `unreachable default` route each instance
// needs is written with `ip` in rules.uc, once, and read back to check.

import * as rtnl from 'rtnl';

import { debug, err } from 'bm.log';

// `const` is a keyword, so this cannot be destructured in an import - which is
// why the in-tree ucode that uses nl80211 spells it `nl80211.const.X` too.
const C = rtnl.const ?? {};

/** The last netlink complaint, worded for a log line. */
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
function failed() {
	let text = rtnl.error();
	return type(text) == 'string' && length(text) > 0;
}

export function add(pref, cidr, table) {
	try {
		rtnl.request(C.RTM_NEWRULE, C.NLM_F_CREATE | C.NLM_F_EXCL, payload(pref, cidr, table));
	}
	catch (e) {
		debug(sprintf('cannot add rule pref %d from %s table %d: %s', pref, cidr, table, e));
		return false;
	}

	if (failed()) {
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
	try {
		rtnl.request(C.RTM_DELRULE, 0, payload(pref, cidr, table));
	}
	catch (e) {
		debug(sprintf('cannot remove rule pref %d from %s table %d: %s', pref, cidr, table, e));
		return false;
	}

	if (failed()) {
		debug(sprintf('cannot remove rule pref %d from %s table %d: %s', pref, cidr, table, reason()));
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
