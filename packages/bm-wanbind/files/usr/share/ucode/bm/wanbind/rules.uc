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
// Both routes go over netlink, like everything else here. They used to be
// `ip -4 route replace`, on the argument that a line somebody can type at a
// shell is worth more than a socket message for the two most consequential
// writes in the package - which was fair until the cost turned up: the BusyBox
// `ip` every stock OpenWrt ships refuses a numeric routing table, so the one
// package that writes every rule over netlink was refusing to run on routers
// without `ip-full` for the sake of two lines. They are read back after writing
// for the same reason they always were.
//
// The second half of this file is the same two questions asked for one-to-one
// bindings: which rules on the router are theirs, and where an address that is
// being held has to be parked so that holding it means anything. A binding has
// no catch-all - it is about one address rather than about a LAN - but `hold`
// needs exactly the same `unreachable default`, and for exactly the same reason
// as the instance's: a rule pointing at an empty table does not fail, it falls
// through to main.

import { err, notice } from 'bm.log';

import * as netlink from 'bm.wanbind.netlink';
import * as wans from 'bm.wanbind.wans';

// The two route kinds this file writes, spelled out rather than read from
// `rtnl.const`: this module never imports rtnl - netlink.uc is the one place
// that does - and these are kernel constants that have not moved since the
// routing table gained types. RTN_UNREACHABLE answers a lookup with
// EHOSTUNREACH, which is what makes a parked address parked; RT_SCOPE_LINK is
// what marks a connected route as reachable without a gateway.
const UNREACHABLE = 7;
const LINK_SCOPE = 253;

// The router's own routing table: everything it knows how to reach directly,
// which is what a LAN-local escape sends traffic back to.
const MAIN_TABLE = 254;

/**
 * Whether a table really holds `unreachable default`, asked of the kernel.
 *
 * Read back after every write, because this one route is what stands between
 * an unassigned client and the router's own WAN. A write that was accepted and
 * did something subtly different is not a risk worth taking here, and a table
 * that quietly has no default at all is the failure that looks exactly like
 * everything working.
 */
function holdsUnreachableDefault(table) {
	let held = netlink.routes();

	if (held === null)
		return false;

	for (let one in held) {
		// An empty `dst` is a default route: the kernel answers a dump with the
		// destination already in CIDR form and says nothing at all for the one
		// that matches everything.
		if (one.table != table || length(one.dst))
			continue;

		if (one.kind == UNREACHABLE)
			return true;
	}

	return false;
}

/**
 * Take every route this package put in one table back out.
 *
 * `ip route flush table N` in two lines, and deliberately only the two shapes
 * written above: the unreachable default, and the connected routes beside it.
 * A blanket flush would also take out anything else that happens to share the
 * table - on a router where the catch-all table is 253 that is whatever
 * `default` holds, which is not this package's to empty.
 */
function emptyTable(table) {
	let held = netlink.routes();

	if (held === null)
		return;

	for (let one in held) {
		if (one.table != table)
			continue;

		if (one.kind != UNREACHABLE && one.scope != LINK_SCOPE)
			continue;

		netlink.routeRemove({
			table: table,
			dst: netlink.routeDestination(one),
			oif: one.oif
		});
	}
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

	if (!netlink.routeReplace({ table: table, dst: '0.0.0.0/0', kind: UNREACHABLE })) {
		err(sprintf('instance %s: cannot write the unreachable default in table %d',
			instance.id, table));
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
		if (!netlink.routeReplace({ table: table, dst: lanCidr, oif: lanDevice, scope: LINK_SCOPE })) {
			err(sprintf('instance %s: cannot write the connected route for %s in table %d - the router would stop answering on that LAN, so the catch-all is not being installed',
				instance.id, lanCidr, table));
			return false;
		}
	}

	// Read back rather than trusted. This is what stands between an unassigned
	// client and the router's own WAN, and `ip` returning zero having done
	// something subtly different is not a risk worth taking on the one line
	// that makes the whole feature true.
	if (!holdsUnreachableDefault(table)) {
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
	emptyTable(instance.catchAllTable);
};

/**
 * The blocks one instance fences, which is its whole LAN or exactly its range.
 *
 * A whole-LAN instance is one block and always was. A scoped one is the minimal
 * set of blocks covering exactly its range, and "exactly" is the load-bearing
 * word: the planner only ever seats a lease inside the range, so a whole-LAN
 * catch-all under a scoped instance would fail-close every other device on that
 * LAN - blocked by an instance that is never going to give it a WAN, which is
 * a device taken off the network by the option chosen to leave it alone.
 */
export function catchAllCidrs(instance, lanCidr) {
	if (!length(instance.rangeFrom) || !length(instance.rangeTo))
		return length(lanCidr) ? [ lanCidr ] : [];

	return wans.rangeCidrs(instance.rangeFrom, instance.rangeTo);
};

/** The rules at one priority, as a sorted key set, for comparing groups. */
function groupKeys(rules, pref) {
	let keys = [];

	for (let one in rules) {
		if (one.pref == pref)
			push(keys, sprintf('%s|%d', one.cidr, one.table));
	}

	return sort(keys);
}

/**
 * Install the catch-all, replacing anything else at its priority.
 *
 * A whole *priority group* is compared rather than a single rule, because a
 * scoped instance writes several blocks at one number and the kernel is content
 * to hold any number of rules there. Comparing them as a set is also what stops
 * a settled router rewriting the group on every pass: several blocks come back
 * from a dump in whatever order the kernel walks them, and a comparison that
 * cared about order would tear the group down and rebuild it every thirty
 * seconds - with a window, each time, where the LAN is not fenced at all.
 *
 * All three fields are compared. A rule at the right priority pointing at the
 * wrong table is worse than no rule - it sends the whole LAN somewhere nobody
 * chose - so it is replaced rather than accepted.
 *
 * Returns true when the router ends up holding exactly the group. False is
 * reported by every surface as the instance not being safe to run, because it
 * is not.
 */
export function installCatchAll(instance, cidrs, rules) {
	let blocks = (type(cidrs) == 'array') ? cidrs : [ cidrs ];

	if (!length(blocks)) {
		err(sprintf('instance %s: there are no address blocks to fence, so no catch-all was installed',
			instance.id));
		return false;
	}

	let wanted = [];
	for (let cidr in blocks)
		push(wanted, sprintf('%s|%d', cidr, instance.catchAllTable));

	if (join(chr(10), sort(wanted)) == join(chr(10), groupKeys(rules, instance.catchAllPref)))
		return true;

	for (let one in rules) {
		if (one.pref != instance.catchAllPref)
			continue;

		notice(sprintf('instance %s: replacing the rule at priority %d (was %s -> table %d)',
			instance.id, one.pref, one.cidr, one.table));
		netlink.remove(one.pref, one.cidr, one.table);
	}

	for (let cidr in blocks) {
		if (!netlink.add(instance.catchAllPref, cidr, instance.catchAllTable)) {
			err(sprintf('instance %s: cannot install the catch-all rule for %s', instance.id, cidr));
			return false;
		}
	}

	notice(sprintf('instance %s: catch-all installed - %s falls through to table %d',
		instance.id, join(', ', blocks), instance.catchAllTable));
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
 * Since 2.4.0 the same argument runs one level finer. Two instances may share
 * a LAN when their address ranges are disjoint, so the subnet no longer tells
 * them apart either - the *scope* does. A client rule is this instance's when
 * its address is one this instance would ever seat, which for a whole-LAN
 * instance is the subnet and for a scoped one is the range.
 *
 * `lanCidr` may be null, and then the priority range is all there is to go on.
 * That is the console case: `bmwan flush` runs with the service stopped and
 * netifd may not be answering either, and taking too much off a router that is
 * being torn down is the safer end of that trade.
 */
export function ownedClientRules(rules, instance, lanCidr) {
	let out = [];
	let scoped = type(lanCidr) == 'string' && length(lanCidr);
	let ranged = length(instance.rangeFrom) && length(instance.rangeTo);

	for (let one in rules) {
		if (one.pref < instance.rulePrefBase || one.pref >= instance.catchAllPref)
			continue;

		if (scoped) {
			let ip = wans.hostAddress(one.cidr);
			if (!ip || !wans.contains(lanCidr, ip))
				continue;

			// Inside the LAN but outside the range is another instance's client
			// on the same LAN. Adopting it would have each of them delete the
			// other's rules on its own timer, which is the fault this whole
			// function exists to prevent, one level down.
			if (ranged && !wans.inRange(instance.rangeFrom, instance.rangeTo, ip))
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
	if (!netlink.routeReplace({ table: table, dst: '0.0.0.0/0', kind: UNREACHABLE })) {
		err(sprintf('cannot write the unreachable default in table %d', table));
		return false;
	}

	for (let one in (type(connected) == 'array' ? connected : [])) {
		if (!netlink.routeReplace({ table: table, dst: one.cidr, oif: one.device, scope: LINK_SCOPE })) {
			err(sprintf('cannot write the connected route for %s in table %d - a held address on that LAN will not reach its neighbours either',
				one.cidr, table));
		}
	}

	if (!holdsUnreachableDefault(table)) {
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
	emptyTable(table);
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
/**
 * Every network this router serves, as one sorted list of subnets.
 *
 * Taken from the classifier's own verdicts rather than from the configuration,
 * because the question is which networks the router is *on* - a LAN with no
 * address is not a network anything can reach, and one added by hand at a shell
 * is one the escapes have to cover on the next pass without anybody editing
 * this package's configuration.
 *
 * Sorted and de-duplicated so that the priority a given LAN's rule sits at does
 * not move when netifd happens to answer in a different order, which would make
 * every pass rewrite every escape.
 */
export function localEscapeCidrs(view) {
	let verdicts = (type(view) == 'object' && type(view.byName) == 'object') ? view.byName : {};
	let seen = {};
	let out = [];

	for (let name in keys(verdicts)) {
		let one = verdicts[name];

		if (type(one) != 'object' || one.role != 'lan')
			continue;

		let cidr = (type(one.cidr) == 'string') ? one.cidr : '';

		if (!length(cidr) || seen[cidr] === true)
			continue;

		seen[cidr] = true;
		push(out, cidr);
	}

	return sort(out);
};

/**
 * One rule per LAN, `to <that LAN> lookup main`, numbered from `base`.
 *
 * The whole band is compared against what the kernel holds and rewritten only
 * when the two differ, which is the same shape `installCatchAll` uses and for
 * the same reason: a pass that wrote its rules again every thirty seconds would
 * be a window, thirty times an hour, in which the address has no rule at all.
 *
 * An empty list is not a no-op - it is `lan_local 0`, or a router whose LANs
 * have no addresses, and it means the band must be empty.
 */
export function installLocalEscapes(base, top, cidrs, present) {
	let blocks = (type(cidrs) == 'array') ? cidrs : [];
	let held = (type(present) == 'array') ? present : [];

	let wanted = [];
	let n = 0;

	for (let cidr in blocks) {
		if (base + n > top) {
			err(sprintf('there are more LANs than the %d priorities from %d, so %s and anything after it has no escape rule and a bound address on it cannot reach its own network',
				top - base + 1, base, cidr));
			break;
		}

		push(wanted, sprintf('%d|%s|%d', base + n, cidr, MAIN_TABLE));
		n++;
	}

	let have = [];

	for (let one in held) {
		if (one.pref < base || one.pref > top)
			continue;

		push(have, sprintf('%d|%s|%d', one.pref, one.dst, one.table));
	}

	if (join(chr(10), sort(wanted)) == join(chr(10), sort(have)))
		return length(wanted);

	// Away and back rather than edited in place: a rule's priority is its
	// identity to the kernel, so a LAN that moved one place up the list is a
	// different rule at both numbers.
	for (let one in held) {
		if (one.pref < base || one.pref > top)
			continue;

		netlink.removeDest(one.pref, one.dst, one.table);
	}

	let written = 0;

	for (let key in wanted) {
		let parts = split(key, '|');

		if (!netlink.addDest(int(parts[0]), parts[1], int(parts[2]))) {
			err(sprintf('the LAN-local escape rule for %s could not be written, so a bound address on that network cannot reach it', parts[1]));
			continue;
		}

		written++;
	}

	if (written) {
		notice(sprintf('%d LAN-local escape rule(s) at %d-%d: traffic to %s is decided before any binding, so a bound machine still reaches the network it is on',
			written, base, base + written - 1, join(', ', blocks)));
	}

	return written;
};

/** Take the whole escape band off the router, whatever is in it. */
export function flushLocal(base, top, present) {
	let held = (type(present) == 'array') ? present : [];
	let removed = 0;

	for (let one in held) {
		if (one.pref < base || one.pref > top)
			continue;

		if (netlink.removeDest(one.pref, one.dst, one.table))
			removed++;
	}

	return removed;
};

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
