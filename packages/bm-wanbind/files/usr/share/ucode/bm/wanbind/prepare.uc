// Everything a rule is no use without, and none of the rules.
//
// A binding on the wire is three things, and only one of them is an ip rule:
//
//   option ip4table   on the WAN's network section, so that WAN's routes land
//                     in a table of its own rather than in main
//   a forwarding      from the zone of the LAN the addresses are on to the
//                     WAN's zone, so fw4 lets the traffic through
//   an ip rule        which is `core.uc`'s, written on every pass
//
// The first two live here. They are UCI writes followed by a reload rather than
// netlink messages, they happen once rather than per pass, and both of them are
// shared by the two halves of this package - a one-to-one binding needs a
// forwarding from the LAN its address sits on, and an instance needs one from
// its LAN to every WAN in its pool. Two copies of that would be two chances to
// write a router two different ways from one configuration.
//
// Nothing here overwrites a value somebody else chose. `option ip4table` is
// written only when the WAN section has none: a different number there is an
// administrator's decision about their own router, and the honest response is
// to say so and let the binding be re-stamped, not to quietly take that
// interface's routes somewhere they were not put.
//
// Nothing here is ever taken back either, in one specific case worth stating:
// `option ip4table` stays when a binding is deleted. It is a statement about
// the WAN rather than about the binding - other bindings and every instance
// pool may be resting on it - and an interface losing its own routing table is
// a router-wide event that no single deletion should cause.
//
// The reloads are deferred by every caller that is preparing more than one
// thing, so a router coming up with five bindings and two instances reloads
// fw4 once rather than seven times.

import { cursor } from 'uci';

import { debug, err, notice } from 'bm.log';

import * as layout from 'bm.wanbind.layout';

/**
 * The firewall section a one-to-one binding's forwarding lives in.
 *
 * The prefix is what lets a sweep recognise its own work, and what stops it
 * touching a forwarding somebody wrote by hand.
 */
const FORWARD_PREFIX = 'bmd_';

/**
 * And the one a *pair of zones* lives in, which is what a forwarding actually
 * is.
 *
 * A forwarding says "traffic from this zone may go to that zone". It says
 * nothing about which binding wanted it, and fw4 does not care how many times
 * it is told: five hundred bindings whose LAN is `lan` and whose WANs are all
 * in `wan` need exactly one. Written per binding they were five hundred
 * identical sections, five hundred commits of /etc/config/firewall - which on a
 * router is five hundred writes to flash - and a ruleset with five hundred
 * copies of one rule in it.
 *
 * Numbered rather than named after the zones, because a zone name may contain
 * characters a section name may not - `guest-iot` is a perfectly ordinary zone
 * and `bmz_guest-iot` is not a section anything can address. The number is a
 * slot; the pair is in the section's own `src` and `dest`, which is where a
 * reader has to look anyway.
 */
const PAIR_PREFIX = 'bmz_';

/**
 * How many UCI writes one preparation pass may make.
 *
 * A router coming up cold with five hundred bindings on WANs that have no
 * routing tables has five hundred `option ip4table` lines to write. Doing them
 * all in one pass is one commit either way, but it is also a single callback
 * holding the daemon while it builds a forty-kilobyte write - and if anything
 * about it fails, five hundred bindings are unprepared rather than sixty-four.
 * The rest are done by the next pass, and the pass after that; a cold start
 * settles in a handful of passes instead of one, and nothing is left in a state
 * a later pass cannot pick up.
 */
const PREPARE_BUDGET = 64;

/**
 * And the one an instance's forwardings live in, numbered per destination zone.
 *
 * A binding has one WAN and therefore one forwarding. An instance has a pool,
 * and the WANs in it may sit in different firewall zones - a PPPoE pool in one,
 * a spare DHCP uplink in another - so it needs one forwarding per distinct
 * destination zone and a number to tell them apart.
 *
 * Deliberately not `bmd` with a digit after it: `bmd0_1` does not start with
 * `bmd_`, so the two sweeps below cannot see each other's sections, and the
 * module's own old sections (`bmf<slot>_<n>` and `bmd<slot>_<n>`, written over
 * SSH before 3.4.0) match neither.
 */
const INSTANCE_PREFIX = 'bmw_';

/**
 * What may be pasted into a UCI section name.
 *
 * Guarded rather than trusted even though a section name comes from UCI, which
 * has its own idea of a legal name: the value is concatenated into a section
 * name that a `uci delete` is later built from, and this is the only thing
 * between a hand-edited /etc/config and a token nobody meant.
 */
const SAFE_ID = /^[A-Za-z0-9_]{1,48}$/;

/**
 * The firewall sections a Bored Manager module older than 3.4.0 wrote over SSH.
 *
 * `bmf<slot>_<n>` for an instance and `bmd<slot>_<n>` for a one-to-one binding,
 * thirty-two of each per slot. Once this daemon owns binding they permit
 * traffic its own forwardings already permit, and nothing else on the router
 * will ever admit to having written them - so they are swept, but only after
 * the daemon's own forwarding for the same pair of zones is in the file.
 */
const LEGACY_SECTION = /^bm[fd][0-9]{1,4}_[0-9]{1,2}$/;

/** Where a WAN with no routing table of its own is given one. */
const WAN_TABLE_BASE = 10000;

/** How many distinct destination zones one instance may forward to. */
const MAX_INSTANCE_ZONES = 32;

let system = null;

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
}

function objectOr(value) {
	return type(value) == 'object' ? value : {};
}

function arrayOr(value) {
	return type(value) == 'array' ? value : [];
}

/**
 * Hand in the one thing here that is not a ubus call or a UCI write:
 * `/etc/init.d/firewall reload`.
 *
 * Injected rather than called directly so that every probe can drive this file
 * without a single command running on the machine checking it - and so that the
 * daemon has one attach point rather than one per module. That is not a
 * hypothetical tidiness: the runner was written, documented and never handed
 * in once already, and every forwarding the daemon wrote was committed to
 * /etc/config/firewall and never put in force, while the row read the file back
 * and reported it `ok`. A bound address was selected into its WAN's table by
 * the rule and then dropped by fw4, with nothing on any surface saying so.
 */
export function attachSystem(runner) {
	system = runner;
};

function reloadFirewall() {
	if (type(system) != 'function')
		return false;

	let status = system('/etc/init.d/firewall reload', 30000);
	return (status === 0);
}

function reloadNetwork(bus) {
	if (!bus)
		return false;

	try {
		bus.call('network', 'reload', {});
		return true;
	}
	catch (e) {
		debug('network reload failed: ' + e);
		return false;
	}
}

function restartDnsmasq() {
	if (type(system) != 'function')
		return false;

	let status = system('/etc/init.d/dnsmasq restart', 30000);
	return (status === 0);
}

function openConfig() {
	try {
		return cursor();
	}
	catch (e) {
		debug('cannot open /etc/config: ' + e);
		return null;
	}
}

/** The section a numbered zone pair lives in. */
function pairName(n) {
	return sprintf('%s%d', PAIR_PREFIX, n);
}

/** The slot number behind one of them, or -1. */
function pairIndex(name) {
	let one = text(name);

	if (substr(one, 0, length(PAIR_PREFIX)) != PAIR_PREFIX)
		return -1;

	let rest = substr(one, length(PAIR_PREFIX));

	return match(rest, /^[0-9]{1,6}$/) ? int(rest) : -1;
}

/** How a pair of zones is keyed everywhere in this file. */
export function pairKey(src, dest) {
	return text(src) + '|' + text(dest);
};

/** The binding id behind one of our firewall sections, or ''. */
function forwardingId(name) {
	let one = text(name);
	if (substr(one, 0, length(FORWARD_PREFIX)) != FORWARD_PREFIX)
		return '';

	return substr(one, length(FORWARD_PREFIX));
}

/** The firewall section one instance's nth forwarding lives in, or ''. */
export function instanceForwardingName(id, n) {
	let one = text(id);
	if (!match(one, SAFE_ID) || type(n) != 'int' || n < 0 || n >= MAX_INSTANCE_ZONES)
		return '';

	return sprintf('%s%s_%d', INSTANCE_PREFIX, one, n);
};

/** The instance id behind one of our instance sections, or ''. */
function instanceForwardingId(name) {
	let one = text(name);
	if (substr(one, 0, length(INSTANCE_PREFIX)) != INSTANCE_PREFIX)
		return '';

	let rest = substr(one, length(INSTANCE_PREFIX));
	let cut = -1;

	// The last underscore separates the id from the number, because an id may
	// contain underscores of its own and the number never does.
	for (let i = 0; i < length(rest); i++) {
		if (substr(rest, i, 1) == '_')
			cut = i;
	}

	if (cut < 1)
		return '';

	return substr(rest, 0, cut);
}

/**
 * The forwardings this file has written, by binding id.
 *
 * Read on every pass rather than remembered, for the reason everything else
 * here is read every pass: somebody deleting the section from LuCI or by hand
 * has to be something the next pass notices and puts back, and a cache would
 * make it something nothing ever notices at all.
 */
export function forwardings() {
	let rows = [];

	try {
		cursor().foreach('firewall', 'forwarding', (section) => {
			let name = text(section['.name']);
			let slot = pairIndex(name);
			let id = forwardingId(name);

			if (slot < 0 && !length(id))
				return;

			push(rows, {
				section: name,
				slot: slot,
				id: id,
				src: text(section.src),
				dest: text(section.dest)
			});
		});
	}
	catch (e) {
		debug('cannot read /etc/config/firewall: ' + e);
	}

	let out = { pairs: {}, rows: rows, next: 0 };

	// Numbered sections first, so that a pair covered by both a numbered
	// section and one of the old per-binding ones is reported as covered by the
	// numbered one - which is what makes the old one sweepable.
	for (let one in rows) {
		if (one.slot < 0)
			continue;

		if (one.slot >= out.next)
			out.next = one.slot + 1;

		let key = pairKey(one.src, one.dest);

		if (!exists(out.pairs, key))
			out.pairs[key] = { section: one.section, src: one.src, dest: one.dest, legacy: false };
	}

	for (let one in rows) {
		if (one.slot >= 0)
			continue;

		let key = pairKey(one.src, one.dest);

		if (!exists(out.pairs, key))
			out.pairs[key] = { section: one.section, src: one.src, dest: one.dest, legacy: true };
	}

	return out;
};

/** The same, for instances: id -> list of { section, src, dest }. */
export function instanceForwardings() {
	let out = {};

	try {
		cursor().foreach('firewall', 'forwarding', (section) => {
			let id = instanceForwardingId(section['.name']);
			if (!length(id))
				return;

			if (!(id in out))
				out[id] = [];

			push(out[id], {
				section: text(section['.name']),
				src: text(section.src),
				dest: text(section.dest)
			});
		});
	}
	catch (e) {
		debug('cannot read /etc/config/firewall: ' + e);
	}

	return out;
};

/**
 * A free routing table number for a WAN that has none.
 *
 * Refusing instead was how this package came to depend on the app for the one
 * thing it exists to do without it: `option ip4table` is not part of a stock
 * OpenWrt WAN, so on a router nobody had already prepared, every bind answered
 * with an instruction to go and hand-edit /etc/config/network.
 *
 * `taken` is every number already spoken for - the router's own three, every
 * table netifd reports, and every table a section is stamped with. Handed in
 * rather than read here so that one pass preparing several WANs cannot give two
 * of them the same number.
 */
export function freeWanTable(taken) {
	let claimed = objectOr(taken);

	for (let candidate = WAN_TABLE_BASE; candidate < WAN_TABLE_BASE + 1000; candidate++) {
		if (claimed[sprintf('%d', candidate)] !== true)
			return candidate;
	}

	return 0;
};

/** Perform whichever reloads a deferred preparation is still owed. */
export function applyReloads(out, bus) {
	if (out.network) {
		reloadNetwork(bus);
		out.network = false;
	}

	if (out.firewall) {
		out.firewall = false;

		if (!reloadFirewall()) {
			out.ok = false;
			out.reason = 'the firewall forwarding was written and fw4 was not reloaded, so it is not in force yet';
		}
	}

	return out;
};

function refusePrepare(reason, changed) {
	return { ok: false, changed: changed, network: false, firewall: false, reason: reason };
}

/**
 * Give one WAN a routing table of its own, if it has none.
 *
 * Answers `{ ok, wrote, table, reason }`. `wrote` false with `ok` true is the
 * ordinary case on a router that is already prepared, and it is what keeps this
 * from being something a pass does every thirty seconds.
 */
function ensureWanTable(uci, wan, stamped, taken, whose, opts) {
	if (uci.get('network', wan) == null) {
		return {
			ok: false,
			wrote: false,
			table: 0,
			reason: sprintf('/etc/config/network has no section called %s', wan)
		};
	}

	let written = uci.get('network', wan, 'ip4table');
	let already = (written == null) ? '' : text('' + written);

	if (length(already)) {
		if (stamped > 0 && already != sprintf('%d', stamped)) {
			return {
				ok: false,
				wrote: false,
				table: int(already),
				reason: sprintf('%s already puts its routes in table %s and %s is stamped with %d. Nothing was changed - one of the two has to move, and which is not a decision this daemon gets to make',
					wan, already, whose, stamped)
			};
		}

		return { ok: true, wrote: false, table: int(already), reason: '' };
	}

	let table = (stamped > 0) ? stamped : freeWanTable(taken);

	if (!table) {
		return {
			ok: false,
			wrote: false,
			table: 0,
			reason: sprintf('there is no free routing table to give %s', wan)
		};
	}

	if (!uci.set('network', wan, 'ip4table', sprintf('%d', table))) {
		return {
			ok: false,
			wrote: false,
			table: 0,
			reason: sprintf('could not give %s routing table %d in /etc/config/network', wan, table)
		};
	}

	// A caller preparing several bindings commits once at the end. On a router
	// coming up with five hundred of them that is the difference between one
	// write to flash and five hundred.
	let commitNow = (type(opts) != 'object') || (opts.commit !== false);

	if (commitNow && !uci.commit('network')) {
		return {
			ok: false,
			wrote: false,
			table: 0,
			reason: sprintf('could not give %s routing table %d in /etc/config/network', wan, table)
		};
	}

	taken[sprintf('%d', table)] = true;

	return { ok: true, wrote: true, table: table, reason: '' };
}

/**
 * Everything a batch of bindings needs written, in one cursor and one commit.
 *
 * The single-binding version below is this with one item in it, and that is not
 * a tidiness argument: written per binding, a router coming up with five
 * hundred of them opened five hundred cursors, wrote five hundred identical
 * firewall forwardings and committed /etc/config/firewall five hundred times -
 * five hundred writes to flash to say one thing fw4 needed telling once.
 *
 * Answers `{ ok, network, firewall, prepared, failed, writes, deferred }`.
 * `network` and `firewall` are the reloads owed, exactly as the single version
 * hands them back, so one caller can apply both once for the whole batch.
 */
export function prepareMany(items, view, ctx) {
	let options = objectOr(ctx);
	let taken = objectOr(options.taken);
	let list = arrayOr(items);

	let out = {
		ok: true,
		network: false,
		firewall: false,
		prepared: [],
		failed: [],
		writes: 0,
		deferred: 0,
		reason: ''
	};

	if (!length(list))
		return out;

	let uci = openConfig();

	if (!uci) {
		out.ok = false;
		out.reason = 'cannot open /etc/config';
		return out;
	}

	// One walk of /etc/config/firewall for the whole batch, and the pairs it
	// found are updated as this loop writes so that two bindings wanting the
	// same pair write it once.
	let present = forwardings();
	let verdicts = objectOr(objectOr(view).byName);
	let next = present.next;
	let wroteNetwork = false;
	let wroteFirewall = false;

	for (let one in list) {
		if (type(one) != 'object' || one.usable !== true) {
			push(out.failed, { id: text(one ? one.id : ''), reason: 'this binding is not usable, so there is nothing to prepare for it' });
			continue;
		}

		// The budget is spent, and the rest wait for the next pass. Reported
		// rather than silently dropped: a caller that thought it had prepared
		// five hundred bindings and had prepared sixty-four would be wrong
		// about the router in a way nothing else would ever say.
		if (out.writes >= PREPARE_BUDGET) {
			out.deferred = out.deferred + 1;
			continue;
		}

		let verdict = verdicts[one.wan];

		if (verdict && verdict.role == 'lan') {
			push(out.failed, {
				id: one.id,
				reason: sprintf('%s is one of this router own LANs, because %s - nothing will be written for a binding that leaves by the network it is already on',
					one.wan, layout.clauses(verdict.lanEvidence))
			});
			continue;
		}

		let table = ensureWanTable(uci, one.wan, one.table, taken, 'this binding', { commit: false });

		if (!table.ok) {
			push(out.failed, { id: one.id, reason: table.reason });
			continue;
		}

		if (table.wrote) {
			out.writes = out.writes + 1;
			wroteNetwork = true;
		}

		if (!length(one.lan)) {
			push(out.failed, {
				id: one.id,
				reason: sprintf('no lan is set on this binding, so there is no source zone to write a forwarding from. Set option lan to the interface %s sits behind',
					one.label)
			});
			continue;
		}

		let lanVerdict = verdicts[one.lan];
		let lanZone = lanVerdict ? text(lanVerdict.zone) : '';
		let wanZone = verdict ? text(verdict.zone) : '';

		if (!length(lanZone) || !length(wanZone)) {
			push(out.failed, {
				id: one.id,
				reason: sprintf('%s is in %s and %s is in %s, and a forwarding needs both',
					one.lan, length(lanZone) ? ('zone ' + lanZone) : 'no firewall zone',
					one.wan, length(wanZone) ? ('zone ' + wanZone) : 'no firewall zone')
			});
			continue;
		}

		let key = pairKey(lanZone, wanZone);

		// Already there - written by an earlier pass, by an earlier item in
		// this very batch, or by one of the old per-binding sections, which is
		// still a forwarding and still in force.
		if (exists(present.pairs, key)) {
			push(out.prepared, one.id);
			continue;
		}

		let section = pairName(next);

		uci.set('firewall', section, 'forwarding');
		uci.set('firewall', section, 'src', lanZone);
		uci.set('firewall', section, 'dest', wanZone);

		present.pairs[key] = { section: section, src: lanZone, dest: wanZone, legacy: false };
		next = next + 1;
		out.writes = out.writes + 1;
		wroteFirewall = true;

		push(out.prepared, one.id);
	}

	// One commit each, at the end, however many bindings were prepared.
	if (wroteNetwork) {
		if (uci.commit('network'))
			out.network = true;
		else {
			out.ok = false;
			out.reason = 'the routing tables could not be written to /etc/config/network';
		}
	}

	if (wroteFirewall) {
		if (uci.commit('firewall'))
			out.firewall = true;
		else {
			out.ok = false;
			out.reason = 'the firewall forwarding could not be written to /etc/config/firewall';
		}
	}

	return out;
};

/**
 * Give one binding the two things on the router a rule is no use without.
 *
 * Called by the pass when it finds either missing, and by the ubus `bind` path
 * so that a binding created from the app or from LuCI works before the next
 * tick rather than after it. Both callers reach the same code, because a create
 * that prepared the router differently from a reconcile would be two routers
 * wearing one configuration.
 *
 * `ctx.defer` returns the reloads as flags for a caller that is preparing
 * several things at once. Without it they happen here.
 */
export function prepare(one, view, ctx) {
	let options = objectOr(ctx);
	let many = prepareMany([ one ], view, options);

	let out = {
		ok: many.ok && !length(many.failed),
		changed: [],
		network: many.network,
		firewall: many.firewall,
		reason: length(many.failed) ? many.failed[0].reason : many.reason
	};

	if (options.defer === true)
		return out;

	return applyReloads(out, options.bus);
};

/**
 * Everything one instance needs written: a table per pool WAN, and a forwarding
 * from its LAN to every zone its pool sits in.
 *
 * This is the half that used to be done by the app over SSH, and moving it here
 * is the whole of what makes an instance work on a router nothing is connected
 * to. The zones are collected from the pool rather than named in the config,
 * because which zone a WAN is in is a fact about the router that can change
 * without the instance changing at all.
 *
 * Answers the same shape `prepare` does, so one caller can deal with both.
 */
export function prepareInstance(instance, pool, view, ctx) {
	let options = objectOr(ctx);
	let taken = objectOr(options.taken);
	let changed = [];
	let owedNetwork = false;
	let out;

	let id = text(instance.id);
	if (!match(id, SAFE_ID))
		return refusePrepare(sprintf('%s cannot be used as a firewall section name', id), changed);

	let verdicts = objectOr(objectOr(view).byName);
	let uci = openConfig();

	if (!uci)
		return refusePrepare('cannot open /etc/config', changed);

	// --- a routing table per WAN in the pool.
	//
	// Every one of them, not only the first: an instance hands each client a
	// different WAN, so a pool member without a table of its own is a client
	// whose rule points at an empty table and falls through to main - bound on
	// every surface, on the default connection in fact.
	for (let wan in arrayOr(pool)) {
		let table = ensureWanTable(uci, wan.name, wan.table ? wan.table : 0, taken,
			sprintf('instance %s', id));

		if (!table.ok) {
			out = { ok: false, changed: changed, network: owedNetwork, firewall: false, reason: table.reason };
			return (options.defer === true) ? out : applyReloads(out, options.bus);
		}

		if (table.wrote) {
			push(changed, sprintf('%s now puts its routes in table %d', wan.name, table.table));
			owedNetwork = true;
		}
	}

	// --- a forwarding from the LAN's zone to every zone the pool sits in.
	let lanVerdict = verdicts[instance.lan];
	let lanZone = lanVerdict ? text(lanVerdict.zone) : '';

	if (!length(lanZone)) {
		out = {
			ok: false,
			changed: changed,
			network: owedNetwork,
			firewall: false,
			reason: sprintf('%s is in no firewall zone, so there is no source zone to forward its clients from',
				instance.lan)
		};
		return (options.defer === true) ? out : applyReloads(out, options.bus);
	}

	let zones = [];
	let seen = {};

	for (let wan in arrayOr(pool)) {
		let verdict = verdicts[wan.name];
		let zone = verdict ? text(verdict.zone) : '';

		if (!length(zone) || zone == lanZone || seen[zone] === true)
			continue;

		seen[zone] = true;
		push(zones, zone);
	}

	if (length(zones) > MAX_INSTANCE_ZONES) {
		out = {
			ok: false,
			changed: changed,
			network: owedNetwork,
			firewall: false,
			reason: sprintf('this pool sits in %d firewall zones and %d is the most one instance forwards to',
				length(zones), MAX_INSTANCE_ZONES)
		};
		return (options.defer === true) ? out : applyReloads(out, options.bus);
	}

	// Written as a numbered set rather than one section per zone name, so that
	// a pool losing a zone leaves no section behind: the whole set is rewritten
	// from index 0 and everything above the new length is deleted.
	let owedFirewall = false;
	let existing = objectOr(instanceForwardings())[id];
	let held = {};

	for (let one in arrayOr(existing))
		held[one.section] = one;

	for (let i = 0; i < length(zones); i++) {
		let section = instanceForwardingName(id, i);
		let was = held[section];

		if (was && was.src == lanZone && was.dest == zones[i])
			continue;

		uci.set('firewall', section, 'forwarding');
		uci.set('firewall', section, 'src', lanZone);
		uci.set('firewall', section, 'dest', zones[i]);
		push(changed, sprintf('%s -> %s is forwarded', lanZone, zones[i]));
		owedFirewall = true;
	}

	for (let i = length(zones); i < MAX_INSTANCE_ZONES; i++) {
		let section = instanceForwardingName(id, i);

		if (!(section in held))
			continue;

		uci.delete('firewall', section);
		owedFirewall = true;
	}

	if (owedFirewall && !uci.commit('firewall')) {
		out = {
			ok: false,
			changed: changed,
			network: owedNetwork,
			firewall: false,
			reason: sprintf('could not write the firewall forwardings for instance %s', id)
		};
		return (options.defer === true) ? out : applyReloads(out, options.bus);
	}

	out = { ok: true, changed: changed, network: owedNetwork, firewall: owedFirewall, reason: '' };
	return (options.defer === true) ? out : applyReloads(out, options.bus);
};

/** The same for an instance, which has a numbered set of them. */
export function withdrawInstance(id, ctx) {
	let options = objectOr(ctx);
	let one = text(id);

	if (!match(one, SAFE_ID))
		return 0;

	let uci = openConfig();

	if (!uci)
		return 0;

	let removed = 0;

	for (let i = 0; i < MAX_INSTANCE_ZONES; i++) {
		let section = instanceForwardingName(one, i);

		if (uci.get('firewall', section) == null)
			continue;

		uci.delete('firewall', section);
		removed++;
	}

	if (!removed)
		return 0;

	if (!uci.commit('firewall')) {
		err(sprintf('the firewall forwardings for instance %s could not be removed', one));
		return 0;
	}

	if (options.defer !== true && !reloadFirewall())
		err(sprintf('the firewall forwardings for instance %s were removed and fw4 was not reloaded, so they are still in force', one));

	notice(sprintf('instance %s: %d firewall forwarding(s) removed', one, removed));
	return removed;
};

/**
 * Every binding forwarding this file owns whose section has gone.
 *
 * `keep` is the set of ids the config still has, refused ones included: a
 * section refused for a bad priority is still one somebody is about to correct,
 * and taking its firewall path away in the meantime would turn one mistake into
 * two.
 *
 * One reload for however many are removed, and none at all when none are - a
 * sweep that reloaded fw4 on a settled router every thirty seconds would cost
 * more than everything else this daemon does put together.
 */
export function sweep(wanted) {
	let want = objectOr(wanted);
	let present = forwardings();
	let removed = 0;

	let uci = openConfig();

	if (!uci)
		return 0;

	for (let one in present.rows) {
		let key = pairKey(one.src, one.dest);
		let chosen = present.pairs[key];
		let drop = false;

		if (one.slot >= 0) {
			// A numbered section for a pair nothing wants, or a second one for
			// a pair another section already covers - which is what a migration
			// interrupted half way through leaves behind.
			drop = (want[key] !== true) || (chosen && chosen.section != one.section);
		}
		else {
			// One of the old per-binding sections. It goes when nothing wants
			// the pair any more, or when a numbered section has taken it over -
			// and not before, because until then it is the only thing letting
			// that traffic through.
			drop = (want[key] !== true) || (chosen != null && chosen.legacy !== true);
		}

		if (!drop)
			continue;

		uci.delete('firewall', one.section);
		removed++;
	}

	if (!removed)
		return 0;

	if (!uci.commit('firewall')) {
		err('firewall forwardings this daemon no longer needs could not be removed');
		return 0;
	}

	if (!reloadFirewall())
		err('firewall forwardings were removed and fw4 was not reloaded, so they are still in force');

	return removed;
};

/** The same for instances, whose forwardings come in numbered sets. */
export function sweepInstances(keep) {
	let kept = objectOr(keep);
	let removed = 0;

	for (let id in instanceForwardings()) {
		if (kept[id] !== true)
			removed = removed + withdrawInstance(id, { defer: true });
	}

	if (removed)
		reloadFirewall();

	return removed;
};

/**
 * The forwardings a Bored Manager module older than 3.4.0 wrote over SSH.
 *
 * They permit exactly what this daemon's own forwardings permit once it owns
 * binding, and nothing left on the router will ever admit to having written
 * them - so somebody upgrading is left with thirty-two dead sections per slot
 * in their firewall configuration and no way to know what they were.
 *
 * Swept only where this daemon has a forwarding of its own carrying the same
 * pair of zones. That is the whole safety of it: while the two overlap, one of
 * them going changes nothing; without that test an upgrade that had not yet
 * written its own forwardings would take the traffic down between the two.
 */
export function sweepLegacy(ctx) {
	let options = objectOr(ctx);
	let uci = openConfig();

	if (!uci)
		return 0;

	// Every pair of zones this daemon is currently forwarding.
	let mine = {};

	for (let id in forwardings()) {
		let one = forwardings()[id];
		mine[one.src + ' -> ' + one.dest] = true;
	}

	for (let id in instanceForwardings()) {
		for (let one in instanceForwardings()[id])
			mine[one.src + ' -> ' + one.dest] = true;
	}

	let stale = [];

	try {
		uci.foreach('firewall', 'forwarding', (section) => {
			let name = text(section['.name']);

			if (!match(name, LEGACY_SECTION))
				return;

			if (mine[text(section.src) + ' -> ' + text(section.dest)] !== true)
				return;

			push(stale, name);
		});
	}
	catch (e) {
		debug('cannot read /etc/config/firewall: ' + e);
		return 0;
	}

	if (!length(stale))
		return 0;

	for (let name in stale)
		uci.delete('firewall', name);

	if (!uci.commit('firewall')) {
		err('the firewall forwardings left by an older Bored Manager module could not be removed');
		return 0;
	}

	if (options.defer !== true)
		reloadFirewall();

	notice(sprintf('removed %d firewall forwarding(s) left by a Bored Manager module older than 3.4.0; this daemon own forwardings already permit the same traffic',
		length(stale)));

	return length(stale);
};

/**
 * Raise the dnsmasq lease ceilings a LAN needs before an instance can fill it.
 *
 * Opt-in, and off by default. An instance follows DHCP leases, so a LAN whose
 * dnsmasq `limit` is the stock 150 cannot hand out more than 150 addresses
 * however many WANs the pool has - and the failure is silent, because dnsmasq
 * simply stops answering rather than saying anything. But the ceilings are also
 * somebody's own configuration, so raising them is asked for rather than
 * assumed.
 *
 * Answers `{ ok, wrote, reason }`.
 */
export function raiseDhcpLimits(lan, wanted, ctx) {
	let options = objectOr(ctx);
	let uci = openConfig();

	if (!uci)
		return { ok: false, wrote: false, reason: 'cannot open /etc/config' };

	let section = '';
	let global = '';

	try {
		// A `config dhcp` section with no `option interface` means itself, which
		// is the one rule three separate readers of this file have disagreed
		// about before.
		uci.foreach('dhcp', 'dhcp', (one) => {
			let name = text(one['.name']);
			let iface = text(one.interface);

			if ((length(iface) ? iface : name) == lan)
				section = name;
		});

		uci.foreach('dhcp', 'dnsmasq', (one) => {
			if (!length(global))
				global = text(one['.name']);
		});
	}
	catch (e) {
		return { ok: false, wrote: false, reason: 'cannot read /etc/config/dhcp: ' + e };
	}

	if (!length(section) || !match(section, SAFE_ID)) {
		return {
			ok: false,
			wrote: false,
			reason: sprintf('there is no usable `config dhcp` section for %s in /etc/config/dhcp, so its lease ceiling cannot be raised here',
				lan)
		};
	}

	if (!length(global) || !match(global, SAFE_ID)) {
		return {
			ok: false,
			wrote: false,
			reason: 'there is no usable `config dnsmasq` section in /etc/config/dhcp, so the global lease ceiling cannot be raised here'
		};
	}

	let want = (type(wanted) == 'int' && wanted > 0) ? wanted : 0;

	if (!want)
		return { ok: true, wrote: false, reason: '' };

	let limit = text(uci.get('dhcp', section, 'limit'));
	let ceiling = text(uci.get('dhcp', global, 'dhcpleasemax'));
	let wrote = false;

	if (!length(limit) || int(limit) < want) {
		uci.set('dhcp', section, 'limit', sprintf('%d', want));
		wrote = true;
	}

	if (!length(ceiling) || int(ceiling) < want) {
		uci.set('dhcp', global, 'dhcpleasemax', sprintf('%d', want));
		wrote = true;
	}

	if (!wrote)
		return { ok: true, wrote: false, reason: '' };

	if (!uci.commit('dhcp'))
		return { ok: false, wrote: false, reason: 'could not write the lease ceilings to /etc/config/dhcp' };

	if (options.defer !== true && !restartDnsmasq()) {
		return {
			ok: false,
			wrote: true,
			reason: 'the lease ceilings were written and dnsmasq was not restarted, so they are not in force yet'
		};
	}

	notice(sprintf('%s: dnsmasq lease ceilings raised to %d', lan, want));
	return { ok: true, wrote: true, reason: '' };
};
