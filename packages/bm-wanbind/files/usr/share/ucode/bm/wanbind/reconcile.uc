// The full pass: from what the router says, to what it should say.
//
// Runs at start, every `interval` seconds, and whenever something asks for it.
// Lease events do not come through here - they are handled in constant time by
// engine.uc - so this is the self-healing layer rather than the working one:
// the pass that notices a rule somebody removed by hand, a WAN that came back,
// a lease that expired while the daemon was stopped, or a router that rebooted
// with its rules and its memory disagreeing.
//
// It is deliberately built by re-deriving ownership from the router's own ip
// rules rather than by trusting what this process remembers. That is what makes
// a restart free: the rules are the record, the lease file says whose address
// each one is, and the WAN table numbers say which line. A daemon that came up
// thirty seconds ago and one that has been running for a month reach the same
// answer from the same router.
//
// Nothing here is allowed to act on a missing answer. A dump that failed, a
// lease file that could not be read, a netlink socket that would not talk - all
// of them mean "change nothing this pass". Treating no answer as an empty
// answer would unbind every client on the router because one read failed.

import { debug, notice } from 'bm.log';

import * as engine from 'bm.wanbind.engine';
import * as leases from 'bm.wanbind.leases';
import * as netlink from 'bm.wanbind.netlink';
import * as rules from 'bm.wanbind.rules';
import * as wans from 'bm.wanbind.wans';

/**
 * Milliseconds off the monotonic clock, for measuring one pass.
 *
 * Monotonic on purpose: a router that gets its first NTP reply half way
 * through a reconcile would otherwise report a pass that took two hours or
 * minus one, and the number exists to be compared against a budget.
 */
function millis() {
	let now = clock(true);
	return type(now) == 'array' ? (now[0] * 1000 + now[1] / 1000000) : 0;
}

/** `10.0.0.7/32` -> `10.0.0.7`, and null for anything that is not a host rule. */
/**
 * Bring the device table up to date with the lease file.
 *
 * A lease that has gone is not acted on here. The client keeps its record and
 * its WAN until the release grace runs out, because most of the time a lease
 * disappearing is a laptop closing its lid rather than somebody leaving - and
 * handing their line to the next person in the queue every time would make the
 * queue the only thing anybody ever experienced.
 */
function refreshDevices(st, current, now) {
	if (current === null)
		return;

	for (let mac in current) {
		let lease = current[mac];
		engine.seen(st, mac, lease.ip, lease.host, now);
	}
}

/** Forget clients whose lease has been gone longer than the grace. */
function expire(st, current, now) {
	if (current === null)
		return 0;

	let gone = [];
	for (let mac in st.devices) {
		if (current[mac])
			continue;
		if (now - st.devices[mac].lastSeenAt < st.instance.releaseGrace)
			continue;

		push(gone, mac);
	}

	for (let mac in gone) {
		debug('instance ' + st.instance.id + ': releasing ' + mac + ', its lease has been gone for a while');
		engine.forget(st, mac);
	}

	return length(gone);
}

/**
 * Rebuild who holds what from the rules on the router.
 *
 * Every client rule is examined once and either adopted - it names an address
 * this instance knows and a table one of its WANs owns - or removed. Two rules
 * claiming the same WAN, or the same client, cannot both be right; the lower
 * priority wins because that is the one the kernel would have matched, so the
 * survivor is the rule that was actually in effect.
 */
function adopt(st, present, pool, now) {
	let byTable = {};
	for (let wan in pool) {
		if (type(wan.table) == 'int')
			byTable[sprintf('%d', wan.table)] = wan.name;
	}

	let byIp = {};
	for (let mac in st.devices) {
		let device = st.devices[mac];
		if (length(device.ip))
			byIp[device.ip] = mac;

		// Ownership is re-derived, so nothing is carried over from last pass.
		delete device.wan;
		delete device.pref;
		delete device.table;
	}

	st.wanOwner = {};
	st.prefFree = [];
	st.prefNext = st.instance.rulePrefBase;

	// Scoped to this instance's LAN, not merely to its priority range: the
	// ranges of two instances on one router overlap. See ownedClientRules.
	let owned = rules.ownedClientRules(present, st.instance, st.lanCidr);
	sort(owned, (a, b) => a.pref - b.pref);

	let strays = [];
	let adopted = 0;

	for (let one in owned) {
		let ip = wans.hostAddress(one.cidr);
		let wan = ip ? byTable[sprintf('%d', one.table)] : null;
		let mac = ip ? byIp[ip] : null;

		if (!wan || !mac || st.wanOwner[wan] || st.devices[mac].wan) {
			push(strays, one);
			continue;
		}

		let device = st.devices[mac];
		device.wan = wan;
		device.pref = one.pref;
		device.table = one.table;
		st.wanOwner[wan] = mac;
		engine.prefClaim(st, one.pref);
		engine.dequeue(st, mac);

		// A rule the router already had is what the sticky map should say, so a
		// daemon that restarted does not move everybody on its first pass.
		if (st.sticky[mac] != wan) {
			st.sticky[mac] = wan;
			st.dirty = true;
		}
		if (type(st.assignedAt[mac]) != 'int') {
			st.assignedAt[mac] = now;
			st.dirty = true;
		}

		adopted++;
	}

	for (let one in strays) {
		debug(sprintf('instance %s: removing rule pref %d from %s table %d - it belongs to nobody here',
			st.instance.id, one.pref, one.cidr, one.table));
		netlink.remove(one.pref, one.cidr, one.table);
	}

	return { adopted: adopted, removed: length(strays) };
}

/**
 * How long each WAN has been failing, and who should be moved off it.
 *
 * The timer is what stops remap turning a five-second reconnect into every
 * client changing line. A WAN that has been in error for less than the grace is
 * simply a WAN nobody can be given; past the grace it is one whose client is
 * better off somewhere else.
 */
function errorTimers(st, pool, now) {
	let next = {};

	for (let wan in pool) {
		if (wans.state(wan, st.instance.wanWarnUptime) != 'error')
			continue;

		let since = st.wanErrorSince[wan.name];
		next[wan.name] = (type(since) == 'int') ? since : now;
	}

	st.wanErrorSince = next;
}

function remap(st, pool, now) {
	if (!st.instance.remap)
		return 0;

	let candidates = [];
	for (let name in st.wanErrorSince) {
		if (now - st.wanErrorSince[name] < st.instance.wanErrorGrace)
			continue;

		let mac = st.wanOwner[name];
		if (mac)
			push(candidates, { mac: mac, wan: name, since: st.wanErrorSince[name] });
	}

	// Longest-broken first, so a router with several failed WANs moves the
	// client who has been suffering longest before the one who just started.
	sort(candidates, (a, b) => a.since - b.since);

	let moved = 0;
	for (let one in candidates) {
		engine.unbind(st, one.mac);
		// Straight back into the queue with a note about where not to go. It
		// keeps its place at the back rather than jumping: a client whose WAN
		// failed is not more entitled to the next free line than one that has
		// been waiting since this morning.
		engine.enqueue(st, one.mac, now);
		st.devices[one.mac].avoid = one.wan;
		moved++;
	}

	return moved;
}

/** Everyone with a lease and no WAN goes in the queue, in lease-file order. */
function fillQueue(st, current, now) {
	if (current === null)
		return;

	for (let mac in current) {
		let device = st.devices[mac];
		if (!device || device.wan || st.held[mac])
			continue;

		engine.enqueue(st, mac, now);
	}
}

/** Hand out free WANs until one of the two runs out. */
function drain(st, pool, now) {
	let tables = {};
	let free = [];

	for (let wan in pool) {
		if (!wans.usable(wan, st.instance.wanWarnUptime))
			continue;
		if (st.wanOwner[wan.name])
			continue;

		tables[wan.name] = wan.table;
		push(free, wan.name);
	}

	// Tables for WANs that are taken are needed too: readdress and remap both
	// look one up for a WAN this pass did not hand out.
	for (let wan in pool) {
		if (type(wan.table) == 'int')
			tables[wan.name] = wan.table;
	}

	engine.poolReset(st, free);
	st.tables = tables;

	let bound = 0;
	while (length(st.freeWans)) {
		let mac = engine.nextWaiting(st);
		if (!mac)
			break;

		let device = st.devices[mac];
		if (!device || !length(device.ip) || st.held[mac]) {
			// Out of the queue rather than skipped, or the next pass would find
			// it again and do the same nothing. fillQueue puts it back the
			// moment it has a lease and is not held.
			engine.dequeue(st, mac);
			continue;
		}

		let options = { now: now };
		if (device.avoid)
			options.avoid = device.avoid;
		if (device.prefer)
			options.prefer = device.prefer;

		let wan = engine.bind(st, mac, tables, options);
		if (!wan) {
			// Not a queue problem - no priority left, or a WAN with no table of
			// its own. Stop handing out this pass; the client is still in
			// `st.waiting` and compactQueue puts it back at the head of the
			// array, so it keeps its place rather than going to the back for
			// something that was not its fault.
			break;
		}

		delete device.avoid;
		delete device.prefer;
		bound++;
	}

	engine.compactQueue(st);
	return { bound: bound, tables: tables };
}

/**
 * One full pass.
 *
 * Returns a short report, which is what `bmwan status` prints and what the
 * module reads. `ok: false` is always accompanied by a reason: a pass that did
 * nothing because the router would not answer must not look like a pass that
 * did nothing because there was nothing to do.
 */
export function run(st, ctx) {
	let started = millis();
	let now = ctx.now;

	let list = wans.dump(ctx.bus);
	if (list === null)
		return { ok: false, reason: 'netifd did not answer, so nothing was changed' };

	let present = netlink.rules();
	if (present === null)
		return { ok: false, reason: 'the router\'s ip rules could not be read, so nothing was changed' };

	let lanCidr = wans.lanCidr(list, st.instance.lan);
	if (!lanCidr) {
		st.ready = false;
		return {
			ok: false,
			reason: sprintf('%s has no IPv4 address, so there is no subnet to bind clients from', st.instance.lan)
		};
	}

	st.lanCidr = lanCidr;

	// The safety net first, every pass. It is cheap when it is already there,
	// and the one ordering that must never happen is client rules on a router
	// whose unassigned clients are not blocked.
	let safe = rules.unreachableDefault(st.instance, lanCidr, wans.lanDevice(list, st.instance.lan)) &&
		rules.installCatchAll(st.instance, lanCidr, present);

	if (!safe) {
		st.ready = false;
		return { ok: false, reason: 'the fail-closed catch-all is not in place, so no client was bound' };
	}

	st.ready = true;

	let pool = wans.pool(list, st.instance);
	let current = leases.fromFile();

	// A lease file that would not read is no information, not an empty LAN.
	if (current === null)
		debug('instance ' + st.instance.id + ': ' + leases.LEASE_FILE + ' could not be read this pass');

	refreshDevices(st, current, now);
	let released = expire(st, current, now);

	// Only leases inside the LAN's own subnet. dnsmasq serves more than one
	// network on some routers, and a rule for an address this instance does not
	// own would take somebody else's client off their route.
	if (current !== null) {
		let foreign = [];
		for (let mac in current) {
			if (!wans.contains(lanCidr, current[mac].ip))
				push(foreign, mac);
		}

		for (let mac in foreign) {
			delete current[mac];
			engine.forget(st, mac);
		}
	}

	let taken = adopt(st, present, pool, now);
	errorTimers(st, pool, now);
	let moved = remap(st, pool, now);
	fillQueue(st, current, now);
	let handed = drain(st, pool, now);

	engine.persist(st, now, false);

	st.lastPassMs = millis() - started;
	st.lastPassAt = now;

	if (moved)
		notice(sprintf('instance %s: moved %d client(s) off a failing WAN', st.instance.id, moved));

	return {
		ok: true,
		instance: st.instance.id,
		lan: lanCidr,
		wans: length(pool),
		adopted: taken.adopted,
		removedStrays: taken.removed,
		released: released,
		remapped: moved,
		bound: handed.bound,
		waiting: length(st.waiting),
		passMs: st.lastPassMs
	};
};

/**
 * The fast path: one lease, handled without reading the router.
 *
 * Everything it needs is already in memory, which is the entire point - a lease
 * event costs the same on a router with four clients and one with four
 * thousand. What it cannot do is discover that a WAN came back or that somebody
 * deleted a rule; that is what the pass above is for, thirty seconds later.
 */
export function lease(st, event, ctx) {
	st.events = st.events + 1;

	if (!st.ready)
		return { ok: false, reason: 'this instance is not ready, so the event was noted and nothing else' };

	if (event.action == 'remove') {
		// Not released. The grace is what covers a client that will be back in
		// twenty seconds, and the reconcile pass is what ends it.
		let device = st.devices[event.mac];
		if (device)
			device.lastSeenAt = ctx.now;
		return { ok: true, action: 'noted' };
	}

	if (!length(event.ip) || !wans.contains(st.lanCidr, event.ip))
		return { ok: false, reason: 'that address is not on this instance\'s LAN' };

	let device = engine.seen(st, event.mac, '', event.host, ctx.now);

	if (device.wan) {
		if (device.ip == event.ip)
			return { ok: true, action: 'unchanged', wan: device.wan };

		engine.readdress(st, event.mac, event.ip);
		return { ok: true, action: 'readdressed', wan: device.wan };
	}

	device.ip = event.ip;

	if (st.held[event.mac])
		return { ok: true, action: 'held' };

	let options = { now: ctx.now };
	if (device.avoid)
		options.avoid = device.avoid;
	if (device.prefer)
		options.prefer = device.prefer;

	let wan = engine.bind(st, event.mac, st.tables, options);
	if (!wan) {
		engine.enqueue(st, event.mac, ctx.now);
		return { ok: true, action: 'queued', reason: st.lastReason };
	}

	delete device.avoid;
	delete device.prefer;
	notice(sprintf('instance %s: %s (%s) bound to %s', st.instance.id, event.mac, event.ip, wan));
	return { ok: true, action: 'bound', wan: wan };
};
