// The two things that are not about any one client, and taking everything away.
//
// A client's rule says "this address looks up that WAN's table". The catch-all
// says what happens to everybody else, and it is the reason one-to-one binding
// means anything at all: without it a client with no WAN is not unbound, it is
// on whichever WAN the router's main table would have used - which is every
// unassigned client sharing one line, silently, exactly when the pool has run
// out and somebody would most want to know.
//
// So an instance installs two things once:
//
//   a route   `unreachable default` in its own table, so a lookup there fails
//   a rule    the LAN subnet -> that table, at a priority below every client
//
// and a client that has a WAN of its own is matched by its higher-priority rule
// first and never reaches it. Fail closed, in two lines.
//
// The route is written with `ip` rather than over netlink, which is a
// deliberate exception to the rest of this package. It happens once per
// instance rather than once per client, so there is nothing to gain; and it is
// the single most consequential thing here, so it is worth being a line
// somebody can read, type at a shell and compare against what the router says.
// It is read back after writing for the same reason.
//
// The second half of this file is the same two questions asked for one-to-one
// bindings: which rules on the router are theirs, and where an address that is
// being held has to be parked so that holding it means anything. A binding has
// no catch-all - it is about one address rather than about a LAN - but `hold`
// needs exactly the same `unreachable default`, and for exactly the same reason
// as the instance's: a rule pointing at an empty table does not fail, it falls
// through to main.

import { popen } from 'fs';

import { err, notice } from 'bm.log';

import * as netlink from 'bm.wanbind.netlink';
import * as wans from 'bm.wanbind.wans';

function shell(command) {
	let handle = popen(command + ' 2>&1', 'r');
	if (!handle)
		return { ok: false, output: '' };

	let output = handle.read('all');
	let status = handle.close();
	return { ok: status === 0, output: type(output) == 'string' ? trim(output) : '' };
}

/**
 * Put `unreachable default` in the instance's table, and check it is there.
 *
 * `replace` rather than `add` so this is safe to run on every start: a table
 * that already has it is left alone, and one holding something else as its
 * default route is corrected rather than gaining a second entry.
 */
export function unreachableDefault(instance, lanCidr, lanDevice) {
	let table = instance.catchAllTable;

	let written = shell(sprintf('ip -4 route replace unreachable default table %d', table));
	if (!written.ok) {
		err(sprintf('instance %s: cannot write the unreachable default in table %d: %s',
			instance.id, table, written.output));
		return false;
	}

	// The connected route, beside the blackhole and before the rule that selects
	// this table exists.
	//
	// The catch-all rule matches on *source*, and the subnet it matches contains
	// the router's own address - so a table holding nothing but `unreachable`
	// answers every packet the router itself sends to one of its own clients
	// with EHOSTUNREACH. That is the router going silent on the interface being
	// bound: no SSH, no ping, no DNS or DHCP replies from dnsmasq. Adding a fib
	// rule flushes the route cache, so it takes the live session with it.
	//
	// Fail-closed is untouched. Anything leaving this LAN still finds only
	// `unreachable default`, which is the whole point of the table; what is
	// restored is the traffic that never should have been in it - the router's
	// own, and clients talking to each other.
	if (lanCidr && lanDevice) {
		let local = shell(sprintf('ip -4 route replace %s dev %s scope link table %d',
			lanCidr, lanDevice, table));
		if (!local.ok) {
			err(sprintf('instance %s: cannot write the connected route for %s in table %d: %s - the router would stop answering on that LAN, so the catch-all is not being installed',
				instance.id, lanCidr, table, local.output));
			return false;
		}
	}

	// Read back rather than trusted. This is what stands between an unassigned
	// client and the router's own WAN, and `ip` returning zero having done
	// something subtly different is not a risk worth taking on the one line
	// that makes the whole feature true.
	let found = shell(sprintf('ip -4 route show table %d', table));
	if (!found.ok || !match(found.output, /unreachable[ \t]+default/)) {
		err(sprintf('instance %s: table %d does not hold an unreachable default after writing it - unassigned clients would use the router\'s own WAN',
			instance.id, table));
		return false;
	}

	return true;
};

/**
 * And take it away again, on the way out.
 *
 * The whole table rather than the default alone: the connected route beside it
 * belongs to this instance too, and leaving it would keep a table alive that
 * nothing maintains any more.
 */
export function removeUnreachableDefault(instance) {
	shell(sprintf('ip -4 route flush table %d', instance.catchAllTable));
};

/**
 * Install the catch-all rule, replacing anything else at its priority.
 *
 * All three fields are compared. A rule at the right priority pointing at the
 * wrong table is worse than no rule - it sends the whole LAN somewhere nobody
 * chose - so it is replaced rather than accepted.
 *
 * Returns true when the router ends up with it. False is reported by every
 * surface as the instance not being safe to run, because it is not.
 */
export function installCatchAll(instance, lanCidr, rules) {
	let strays = [];

	for (let one in rules) {
		if (one.pref != instance.catchAllPref)
			continue;

		if (one.cidr == lanCidr && one.table == instance.catchAllTable)
			return true;

		push(strays, one);
	}

	for (let stray in strays) {
		notice(sprintf('instance %s: replacing the rule at priority %d (was %s -> table %d)',
			instance.id, stray.pref, stray.cidr, stray.table));
		netlink.remove(stray.pref, stray.cidr, stray.table);
	}

	if (!netlink.add(instance.catchAllPref, lanCidr, instance.catchAllTable)) {
		err(sprintf('instance %s: cannot install the catch-all rule for %s', instance.id, lanCidr));
		return false;
	}

	notice(sprintf('instance %s: catch-all installed - %s falls through to table %d',
		instance.id, lanCidr, instance.catchAllTable));
	return true;
};

/**
 * Every rule that is this instance's, as the router has them.
 *
 * The priority range alone is not enough, and getting that wrong is expensive.
 * Every instance on a router shares one `rule_pref_base` and differs only in
 * where its catch-all sits, so instance 1's range - the base up to *its*
 * catch-all - strictly contains the whole of instance 0's range and instance
 * 0's catch-all with it. Claiming by priority alone therefore means each pass
 * adopts what it can of the other instance's rules and removes the rest as
 * strays, catch-all included. Two instances on one router would take each
 * other's clients off the network, once every thirty seconds.
 *
 * So a rule is this instance's only if it is also about one of this instance's
 * clients: a single host inside the LAN subnet it binds. Two instances can
 * never share a LAN interface - the app refuses it, and there is nothing
 * sensible for it to mean - so the subnets are what separate them.
 *
 * `lanCidr` may be null, and then the priority range is all there is to go on.
 * That is the console case: `bmwan flush` runs with the service stopped and
 * netifd may not be answering either, and taking too much off a router that is
 * being torn down is the safer end of that trade.
 */
export function ownedClientRules(rules, instance, lanCidr) {
	let out = [];
	let scoped = type(lanCidr) == 'string' && length(lanCidr);

	for (let one in rules) {
		if (one.pref < instance.rulePrefBase || one.pref >= instance.catchAllPref)
			continue;

		if (scoped) {
			let ip = wans.hostAddress(one.cidr);
			if (!ip || !wans.contains(lanCidr, ip))
				continue;
		}

		push(out, one);
	}

	return out;
};

/**
 * Take everything this instance installed off the router.
 *
 * What `prerm` runs, and what stopping an instance runs. Order matters: the
 * client rules go first and the catch-all last, so at no point is the LAN
 * pointed at an unreachable table with nothing above it - which would be a
 * moment of every client having no route at all rather than a working one.
 */
export function flush(instance, rules, lanCidr) {
	let removed = 0;

	for (let one in ownedClientRules(rules, instance, lanCidr)) {
		if (netlink.remove(one.pref, one.cidr, one.table))
			removed++;
	}

	for (let one in rules) {
		if (one.pref == instance.catchAllPref && netlink.remove(one.pref, one.cidr, one.table))
			removed++;
	}

	removeUnreachableDefault(instance);

	notice(sprintf('instance %s: removed %d rule(s) and the unreachable default in table %d',
		instance.id, removed, instance.catchAllTable));

	return removed;
};

// ---------------------------------------------------------------------------
// One-to-one bindings.

/**
 * Where a held address is parked when no instance already offers a table.
 *
 * 253 is `default` in the kernel's own numbering and OpenWrt leaves it empty,
 * which makes it the natural home for `unreachable default` - the instance half
 * says the same thing about its own catch-all and ships 253 as that default.
 * The rest count downwards, and only because a router where 253 is already in
 * use is a router where refusing to hold anything would be the worse answer.
 */
const HOLD_CANDIDATES = [ 253, 252, 251, 250, 249, 248, 247, 246, 245, 244 ];

function claimTable(taken, value) {
	if (type(value) == 'int' && value > 0)
		taken[sprintf('%d', value)] = true;
}

function tableClaimed(taken, value) {
	return taken[sprintf('%d', value)] === true;
}

/**
 * The routing table a held one-to-one binding is parked in.
 *
 * An instance's `catch_all_table` first, when the router has one. It already
 * holds an `unreachable default` maintained by the instance half, the
 * configuration reader already refuses any binding whose own table collides
 * with it, and one blackhole table on a router is one thing to explain rather
 * than two.
 *
 * Otherwise a table nothing else on this router is using. Everything netifd is
 * putting routes into is off limits, and so is every table a usable binding is
 * stamped with - writing `unreachable default` into a WAN's own table would not
 * park one address, it would take every binding on that WAN off the network in
 * the name of holding one of them.
 *
 * `reason` is a sentence when there is nowhere left. The caller does not treat
 * that as "hold means fallback": it leaves every held rule exactly where it is,
 * because quietly letting an address out over the default connection is the one
 * thing `hold` was chosen to prevent.
 */
export function holdTable(instances, bindings, ifaces) {
	let taken = {};

	// The router's own two, which nothing may blackhole.
	claimTable(taken, 254);
	claimTable(taken, 255);

	for (let one in (type(ifaces) == 'array' ? ifaces : []))
		claimTable(taken, one.table);

	for (let one in (type(bindings) == 'array' ? bindings : [])) {
		if (one.usable && one.enabled)
			claimTable(taken, one.table);
	}

	for (let ins in (type(instances) == 'array' ? instances : [])) {
		if (!tableClaimed(taken, ins.catchAllTable))
			return { table: ins.catchAllTable, shared: true, reason: null };
	}

	for (let candidate in HOLD_CANDIDATES) {
		if (!tableClaimed(taken, candidate))
			return { table: candidate, shared: false, reason: null };
	}

	return {
		table: null,
		shared: false,
		reason: sprintf('every routing table between %d and %d is already carrying routes, so there is nowhere on this router to park a held address. A held binding keeps whatever rule it already had rather than being let out onto the default connection',
			HOLD_CANDIDATES[length(HOLD_CANDIDATES) - 1], HOLD_CANDIDATES[0])
	};
};

/**
 * Put `unreachable default` in the hold table, and check it is there.
 *
 * `replace` rather than `add`, so this is safe on every pass: a table that
 * already holds it is left alone, and one holding something else as its default
 * route is corrected rather than gaining a second entry. Read back afterwards
 * for the reason the instance half reads its own back - `ip` returning zero
 * having done something subtly different is not a risk worth taking on the one
 * line that makes holding mean anything.
 *
 * `connected` is the LANs held addresses sit on, and it is a softer thing than
 * the instance's connected route. That one is required, because the instance's
 * catch-all matches a whole subnet including the router's own address and
 * without it the router goes silent on the LAN. A binding's rule matches a
 * single /32, so the router itself is never affected; what these routes buy is
 * a held device still being able to reach the printer beside it, which is not
 * what "this address has no way out" was meant to take away. So a failure here
 * is logged and the hold still goes in.
 */
export function installHold(table, connected) {
	let written = shell(sprintf('ip -4 route replace unreachable default table %d', table));
	if (!written.ok) {
		err(sprintf('cannot write the unreachable default in table %d: %s', table, written.output));
		return false;
	}

	for (let one in (type(connected) == 'array' ? connected : [])) {
		let local = shell(sprintf('ip -4 route replace %s dev %s scope link table %d',
			one.cidr, one.device, table));

		if (!local.ok) {
			err(sprintf('cannot write the connected route for %s in table %d: %s - a held address on that LAN will not reach its neighbours either',
				one.cidr, table, local.output));
		}
	}

	let found = shell(sprintf('ip -4 route show table %d', table));
	if (!found.ok || !match(found.output, /unreachable[ \t]+default/)) {
		err(sprintf('table %d does not hold an unreachable default after writing it - a held address parked there would leave over the router\'s default connection',
			table));
		return false;
	}

	return true;
};

/**
 * And take it away again, on the way out.
 *
 * Only ever called for a table this package chose for itself. A hold table that
 * is really an instance's catch-all belongs to that instance, and flushing it
 * would take every unassigned client on its LAN out onto the router's own WAN -
 * which is precisely what the instance half exists to prevent.
 */
export function removeHold(table) {
	shell(sprintf('ip -4 route flush table %d', table));
};

/**
 * Every rule on the router that belongs to the one-to-one bindings.
 *
 * Two claims, not one. The band is where new bindings are numbered, so a rule
 * in it that no section wants is a stray to be removed - a binding somebody
 * deleted, or one this daemon wrote before it was restarted with a shorter
 * config. `stamped` is every priority a section actually names, and it is what
 * makes moving `direct_pref_base` survivable: a binding written under the old
 * band keeps its number for ever, so reading the router back from today's band
 * alone would leave its rule unowned, unmaintained and still steering traffic.
 *
 * Nothing outside both is touched. The instance half's rules sit above this
 * band by construction - `directBand()` refuses a band that reaches an
 * instance's `rule_pref_base` - and a rule at a priority nothing here names
 * belongs to another tool or to the person administering the router.
 */
export function directOwned(rules, base, top, stamped) {
	let out = [];
	let claimed = type(stamped) == 'object' ? stamped : {};

	for (let one in rules) {
		if ((one.pref >= base && one.pref <= top) || claimed[sprintf('%d', one.pref)] === true)
			push(out, one);
	}

	return out;
};

/**
 * Take every one of them off the router.
 *
 * What `bmwan flush` reaches and what `prerm` reaches through it. There is no
 * ordering to be careful about here, unlike the instance flush next door: a
 * binding's rule is the whole of what it installs on the wire, so removing them
 * in any order leaves each address exactly where it would have been without the
 * binding at all.
 */
export function directFlush(rules, base, top, stamped) {
	let removed = 0;

	for (let one in directOwned(rules, base, top, stamped)) {
		if (netlink.remove(one.pref, one.cidr, one.table))
			removed++;
	}

	return removed;
};
