// What `bm.wanbind` answers, and the loop behind it.
//
// One state per instance, held for the life of the process, and every call is a
// thin wrapper over the functions in engine.uc and reconcile.uc - the same ones
// `bmwan` calls at a console. There is one implementation of "bind this client",
// not a ubus one and a CLI one that drift until somebody notices they disagree
// about which WAN a laptop is on.
//
// The timer is the only thing here that runs by itself, and it does one full
// pass every `interval` seconds. Everything else costs nothing while nobody is
// asking and nobody's lease is changing, which is what lets this sit on a router
// that is also dialling five thousand PPPoE sessions.
//
// Two kinds of work are published here, and the difference is where the truth
// lives. An instance's assignments are this process's own memory - who holds
// which WAN right now is a thing only the running daemon knows, and `pin` and
// `unassign` move it. A one-to-one binding is not: it is a `config direct`
// section in /etc/config/bm_wanbind, and `bind` and `unbind` below write that
// file rather than any state in here. That is the whole point of the feature
// being on the router. Uninstall the module, unplug the laptop it ran on, and
// every binding is still in the file, still reconciled on the next pass and
// still there after a reboot - which a decision held in this process's memory
// would not be.

import { readfile } from 'fs';
import { cursor } from 'uci';
import { timer } from 'uloop';

import { err, notice } from 'bm.log';

import * as cfg from 'bm.wanbind.config';
import * as direct from 'bm.wanbind.direct';
import * as engine from 'bm.wanbind.engine';
import * as layout from 'bm.wanbind.layout';
import * as leases from 'bm.wanbind.leases';
import * as netlink from 'bm.wanbind.netlink';
import * as reconcile from 'bm.wanbind.reconcile';
import * as ruleset from 'bm.wanbind.rules';
import * as wans from 'bm.wanbind.wans';

export const RELEASE = '2.3.0';

/**
 * Where a WAN's own routing table is numbered from when this half has to give
 * one. The app's binding half uses the same base, so a router driven from both
 * ends keeps one convention rather than two.
 */
const WAN_TABLE_BASE = 10000;

/**
 * The ubus contract version, separate from the release.
 *
 * The module refuses to drive a version it does not know and falls back to
 * SSH rather than guessing, so this moves only when the shape of a call
 * changes in a way an older module cannot cope with.
 *
 * The binding methods added in 2.3.0 did not move it, and deliberately. An
 * older module never calls them, so nothing it does breaks; a newer one has to
 * know whether this router has them, and it learns that from `direct` in the
 * feature descriptor's `provides` rather than from a number it would have to
 * compare. A capability is a thing a router either offers or does not, which is
 * exactly the question being asked.
 */
export const API_VERSION = 1;

const STARTED = time();

// The one file this daemon writes. Named here rather than spelled at each call
// site so that no method can be made to write a different package: the section
// name a caller sends is checked against SECTION_NAME below, and the package it
// lands in is never anything a caller chose.
const PACKAGE = 'bm_wanbind';

// What UCI accepts as a named section, said out loud. Anything else has to be
// refused before it reaches `uci.set`, because a section name goes into a file
// this router parses on every boot and a caller does not get to decide what is
// in it. 32 is UCI's own limit on a section name.
const SECTION_NAME = /^[A-Za-z0-9_]{1,32}$/;

/**
 * The one-to-one bindings are kept in force whether or not the instance half is
 * switched on.
 *
 * `option enabled` on the main section is the instance half's switch - it says
 * no client on any LAN is to be handed a WAN out of a pool - and it predates
 * bindings by a release. A binding belongs to no instance: it is a section in
 * this router's own configuration saying one address leaves by one port, and
 * nothing about pooling being switched off says anything about that. So the
 * pass below runs the direct half either way.
 *
 * Answered as a field on `info` and `bindings` rather than left to be inferred,
 * because `enabled: false` is exactly what a surface would read as "this router
 * is doing nothing" - and it would then be wrong about every binding on it.
 */
const BINDINGS_MAINTAINED = true;

let state = {
	bus: null,
	main: { enabled: true, interval: 30 },
	instances: {},
	order: [],
	served: 0,
	ticks: 0,
	// Held rather than dropped on the floor. A uloop timer whose only reference
	// has gone out of scope is a timer that may not be there when it is due,
	// which is why every uloop script in the OpenWrt tree keeps one too.
	timer: null
};

/** Resident set size in kilobytes, or -1 when /proc did not say. */
function rssKb() {
	let status = readfile('/proc/self/status');
	if (type(status) != 'string')
		return -1;

	let found = match(status, /VmRSS:[ \t]+([0-9]+)/);
	return found ? int(found[1]) : -1;
}

/**
 * Read the config and build one state per instance.
 *
 * Done once, at start. A change to /etc/config/bm_wanbind restarts the service
 * - procd is told to watch the file - so there is no reload path here to get
 * wrong, and no window where half the process is running against the old
 * numbers and half against the new ones.
 */
export function load() {
	state.main = cfg.main();
	state.instances = {};
	state.order = [];

	for (let one in cfg.instances()) {
		if (!one.enabled) {
			notice('instance ' + one.id + ' is disabled; its rules will be removed');
			continue;
		}

		state.instances[one.id] = engine.create(one);
		push(state.order, one.id);
	}

	notice(sprintf('loaded %d instance(s), reconciling every %ds', length(state.order), state.main.interval));

	// The bindings are not loaded here - `bm.wanbind.config` re-reads them on
	// every pass, so a section added over ubus or by hand is in force at the
	// next one without anything having to be restarted. What is worth saying
	// once at start is how many there are and whether the band they are
	// numbered in is safe, because a band that is not is a refusal every future
	// `bind` will hit and this is the first place anybody would see it.
	let band = cfg.directBand();

	if (band.reason)
		err('direct_pref_base: ' + band.reason);

	notice(sprintf('%d binding(s) in the file, numbered in %d-%d', length(cfg.directBindings()), band.base, band.top));
};

export function attach(bus) {
	state.bus = bus;
};

/**
 * Hand the one-to-one half the runner for the one thing here that is not a ubus
 * call: `/etc/init.d/firewall reload`.
 *
 * Forwarded from here rather than called on `bm.wanbind.direct` directly, so
 * the daemon has a single attach point beside `attach(bus)` and cannot acquire
 * a second one nobody remembers to call. That is exactly what happened: the
 * runner was written, documented, and never handed in - so every forwarding
 * this daemon wrote was committed to /etc/config/firewall and never put in
 * force, while the row read the file back and reported it `ok`. A bound address
 * was selected into its WAN's table by the rule and then dropped by fw4, and
 * nothing on any surface said so.
 */
export function attachSystem(runner) {
	direct.attachSystem(runner);
};

/** Every instance state, in config order. */
function each() {
	let out = [];
	for (let id in state.order)
		push(out, state.instances[id]);
	return out;
}

function summary(st) {
	let bound = 0;
	for (let name in st.wanOwner)
		bound++;

	return {
		id: st.instance.id,
		lan: st.instance.lan,
		carrier: st.instance.carrier,
		enabled: true,
		ready: st.ready,
		lanCidr: st.lanCidr,
		sticky: st.instance.sticky,
		remap: st.instance.remap,
		bound: bound,
		waiting: length(st.waiting),
		held: length(st.held),
		free: length(st.freeWans),
		devices: length(st.devices),
		lastPassAt: st.lastPassAt,
		lastPassMs: st.lastPassMs,
		reason: st.lastReason
	};
}

/**
 * One full pass over every instance, and over every one-to-one binding.
 *
 * The bindings are reconciled here rather than only when somebody asks, which
 * is what makes them the router's and not the module's: nothing has to be
 * attached for a binding written last month to still be pointing its address at
 * the right WAN after a reboot, a WAN failing, or a rule somebody removed by
 * hand.
 *
 * The return value is still one report per instance and says nothing about the
 * bindings, because a binding belongs to no instance and there is no row here
 * for it to go in. `bindings()` is where its state is read.
 *
 * The instance half is skipped when it is switched off, and the direct half is
 * not - see BINDINGS_MAINTAINED. That is the whole of what `option enabled 0`
 * does here: no pool, no client handed a WAN, and every binding in the file
 * still reconciled on this timer.
 */
export function pass() {
	let now = time();
	let out = [];

	if (state.main.enabled) {
		for (let st in each())
			push(out, reconcile.run(st, { bus: state.bus, now: now }));
	}

	// Deliberately after the instances. A binding's priority is below every
	// instance's client range, so the kernel reads it first whatever order they
	// were written in - but a pass that put bindings first would be writing
	// rules from a device list the instances are about to refresh.
	direct.run({ bus: state.bus, now: now });

	state.ticks = state.ticks + 1;
	return out;
};

/**
 * The reconcile timer: one object, re-armed from inside its own callback.
 *
 * Re-armed after the pass rather than run on a fixed interval, so a pass that
 * took longer than the interval - four thousand clients and a slow netifd - is
 * followed by a full interval of quiet rather than by another pass immediately.
 * A router that cannot keep up slows down instead of falling over.
 *
 * The pass is wrapped because this callback is the whole of the daemon's
 * liveness: an exception escaping it would take uloop down and leave a router
 * with rules nobody is maintaining, which is worse than any single bad pass.
 */
function schedule() {
	if (!state.timer) {
		state.timer = timer(state.main.interval * 1000, () => {
			try {
				pass();
			}
			catch (e) {
				err('reconcile pass failed: ' + e);
			}

			state.timer.set(state.main.interval * 1000);
		});
		return;
	}

	state.timer.set(state.main.interval * 1000);
}

export function start() {
	if (!netlink.usable())
		err('netlink is not answering; no ip rule can be written on this router');

	// Said at start rather than only in a comment, because the option is one
	// word in a file and what it does is now two different things to the two
	// halves. A pass still runs and the timer is still armed: the bindings are
	// the router's own and are kept in force, and only the pools are off.
	if (!state.main.enabled) {
		notice(sprintf('instances are switched off in /etc/config/bm_wanbind, so no client on any LAN will be handed a WAN. The %d one-to-one binding(s) in the file are not an instance and are still reconciled every %ds; `option enabled 1` on the main section brings the pools back',
			length(cfg.directConfigured()), state.main.interval));
	}

	pass();
	schedule();
};

// ---------------------------------------------------------------------------
// The published object.

function instanceFor(id) {
	if (!length(id)) {
		// One instance is the normal case, so a call that names none means "the
		// one" rather than being an error. Two and it has to be said.
		return (length(state.order) == 1) ? state.instances[state.order[0]] : null;
	}

	return state.instances[id];
}

function text(value) {
	return type(value) == 'string' ? value : '';
}

/**
 * A whole number out of whatever a caller sent, and 0 for anything else.
 *
 * ubus hands an integer straight through, but the same methods are reached from
 * LuCI and from a shell where a priority arrives as the string somebody typed,
 * and a `pref` silently read as 0 is a binding refused for having none. 0 is
 * the answer for "nothing usable was sent", which every caller here treats as
 * "not given" rather than as a number.
 */
function count(value) {
	if (type(value) == 'int')
		return value;

	if (type(value) == 'double')
		return int(value);

	if (type(value) == 'string' && match(trim(value), /^[0-9]+$/))
		return int(value);

	return 0;
}

/** Everything the module needs to decide whether to drive this router here. */
export function info() {
	let out = [];
	for (let st in each())
		push(out, summary(st));

	return {
		name: 'bm-wanbind',
		release: RELEASE,
		apiVersion: API_VERSION,

		// `enabled` is the instance half's switch and nothing else, which is not
		// what its name suggests to anything reading this answer - so the other
		// half says for itself whether it is being kept in force rather than
		// leaving a surface to infer it and get it backwards.
		enabled: state.main.enabled,
		bindingsMaintained: BINDINGS_MAINTAINED,
		interval: state.main.interval,
		started: STARTED,
		uptime: time() - STARTED,
		instances: out,

		// Everything in the file, including whatever this daemon refused and
		// whatever is switched off - neither of which has an entry in
		// `instances` above, because neither has any state to report. A page
		// that drew only `instances` would leave out exactly the rows somebody
		// opened it to fix.
		configured: cfg.configured()
	};
};

export function stats() {
	let events = 0;
	let assigns = 0;
	let releases = 0;
	let queue = 0;
	let lastPassMs = 0;

	for (let st in each()) {
		events += st.events;
		assigns += st.assigns;
		releases += st.releases;
		queue += length(st.waiting);
		if (st.lastPassMs > lastPassMs)
			lastPassMs = st.lastPassMs;
	}

	return {
		rssKb: rssKb(),
		uptime: time() - STARTED,
		served: state.served,
		ticks: state.ticks,
		eventsHandled: events,
		assigned: assigns,
		released: releases,
		queueDepth: queue,
		lastPassMs: lastPassMs,

		// The other half's own numbers, kept separate rather than added into
		// the ones above. A binding and an instance assignment are not the same
		// unit and a total of the two would answer no question anybody has.
		direct: direct.summary()
	};
};

/** The rows a table shows: who is on which WAN. */
export function assignments(id) {
	let out = [];

	for (let st in each()) {
		if (length(id) && st.instance.id != id)
			continue;

		for (let wan in st.wanOwner) {
			let mac = st.wanOwner[wan];
			let device = st.devices[mac];
			if (!device)
				continue;

			push(out, {
				instance: st.instance.id,
				mac: mac,
				ip: device.ip,
				host: device.host,
				wan: wan,
				pref: device.pref,
				table: device.table,
				assignedAt: type(st.assignedAt[mac]) == 'int' ? st.assignedAt[mac] : 0
			});
		}
	}

	sort(out, (a, b) => (a.wan < b.wan) ? -1 : ((a.wan > b.wan) ? 1 : 0));
	return { assignments: out };
};

/** And who is not, with their place in the queue. */
export function waiting(id) {
	let out = [];

	for (let st in each()) {
		if (length(id) && st.instance.id != id)
			continue;

		for (let mac in st.waiting) {
			let device = st.devices[mac];

			push(out, {
				instance: st.instance.id,
				mac: mac,
				ip: device ? device.ip : '',
				host: device ? device.host : '',
				order: st.waiting[mac].order,
				since: st.waiting[mac].enqueuedAt,
				held: false,
				// A code beside the sentence, because a surface has to branch on
				// this and matching English is how a translation breaks a table.
				// `exhausted` is the one that is not about the queue at all: no
				// WAN coming free will help, the priority range has to be widened.
				why: match(st.lastReason, /ip rule priority/) ? 'exhausted' : 'queued',
				reason: st.lastReason
			});
		}

		for (let mac in st.held) {
			let device = st.devices[mac];
			push(out, {
				instance: st.instance.id,
				mac: mac,
				ip: device ? device.ip : '',
				host: device ? device.host : '',
				order: 0,
				since: 0,
				held: true,
				why: 'held',
				reason: 'held out of the pool by hand'
			});
		}
	}

	sort(out, (a, b) => a.order - b.order);
	return { waiting: out };
};

/** A lease event from /etc/hotplug.d/dhcp/. The fast path. */
export function lease(args) {
	let event = leases.fromEvent(args);
	if (!event)
		return { ok: false, reason: 'that is not a lease event this can act on' };

	let now = time();
	let handled = [];

	for (let st in each()) {
		let result = reconcile.lease(st, event, { now: now });
		if (result.ok)
			push(handled, { instance: st.instance.id, action: result.action, wan: result.wan });
	}

	// And every binding that follows a device rather than an address, for the
	// same reason the instances are told: a laptop that renews onto a different
	// address has a rule written for where it used to be, and thirty seconds of
	// that is thirty seconds out of the port somebody chose it out of.
	let bound = direct.lease(event, { now: now });

	if (bound.ok && type(bound.handled) == 'array') {
		for (let one in bound.handled)
			push(handled, { binding: one.id, action: one.action });
	}

	if (!length(handled))
		return { ok: true, action: 'ignored' };

	return { ok: true, handled: handled };
};

/** Put this client on that WAN, and keep it there while it is remembered. */
export function pin(args) {
	let st = instanceFor(text(args.instance));
	if (!st)
		return { ok: false, reason: 'name which instance - this router has more than one' };

	let mac = leases.normalizeMac(args.mac);
	if (!length(mac) || !st.devices[mac])
		return { ok: false, reason: 'no client on this LAN has that MAC address' };

	let wan = text(args.wan);
	if (!length(wan))
		return { ok: false, reason: 'name the WAN to move it to' };

	let table = st.tables[wan];
	if (type(table) != 'int')
		return { ok: false, reason: wan + ' is not a WAN this instance can hand out' };

	// Whoever has it now loses it and goes back in the queue. A pin is a
	// deliberate instruction about one client, so it outranks the other's claim
	// - but they are put in line rather than left with nothing and no record.
	let holder = st.wanOwner[wan];
	if (holder && holder != mac) {
		engine.unbind(st, holder);
		engine.enqueue(st, holder, time());
	}

	engine.unbind(st, mac);
	delete st.held[mac];
	st.devices[mac].prefer = wan;
	engine.enqueue(st, mac, time());

	let bound = engine.bind(st, mac, st.tables, { now: time(), prefer: wan });
	delete st.devices[mac].prefer;

	if (!bound)
		return { ok: false, reason: st.lastReason };

	engine.persist(st, time(), true);
	notice(sprintf('instance %s: %s pinned to %s', st.instance.id, mac, wan));
	return { ok: true, mac: mac, wan: wan };
};

/**
 * Move this client to a different WAN, whichever one is free.
 *
 * Not "unassign then release": that would free its WAN, put it back in the
 * queue, and the sticky map would hand it straight back the line it just came
 * off. This is remap for one client, on demand - forget the sticky choice, and
 * ask for anything but the WAN it has.
 */
export function reassign(args) {
	let st = instanceFor(text(args.instance));
	if (!st)
		return { ok: false, reason: 'name which instance - this router has more than one' };

	let mac = leases.normalizeMac(args.mac);
	if (!length(mac) || !st.devices[mac])
		return { ok: false, reason: 'no client on this LAN has that MAC address' };

	let device = st.devices[mac];
	let previous = device.wan;

	if (!previous)
		return { ok: false, reason: 'that client has no WAN to be moved off' };

	engine.unbind(st, mac);
	delete st.sticky[mac];
	st.dirty = true;

	// The WAN it just left is free now, so without this it is the obvious
	// candidate and the client would land back where it started.
	device.avoid = previous;
	delete st.held[mac];
	engine.enqueue(st, mac, time());

	let wan = engine.bind(st, mac, st.tables, { now: time(), avoid: previous });
	delete device.avoid;

	if (!wan) {
		// It is in the queue and will be seated by the next pass or the next
		// lease event. Reported as a success with no WAN rather than as a
		// failure: the client was moved off the one it had, which is what was
		// asked for, and saying otherwise would invite somebody to press it
		// again and move nothing.
		engine.persist(st, time(), true);
		return { ok: true, mac: mac, from: previous, wan: null, reason: st.lastReason };
	}

	engine.persist(st, time(), true);
	notice(sprintf('instance %s: %s moved from %s to %s', st.instance.id, mac, previous, wan));
	return { ok: true, mac: mac, from: previous, wan: wan };
};

/** Take this client off its WAN and keep it off until somebody says otherwise. */
export function unassign(args) {
	let st = instanceFor(text(args.instance));
	if (!st)
		return { ok: false, reason: 'name which instance - this router has more than one' };

	let mac = leases.normalizeMac(args.mac);
	if (!length(mac))
		return { ok: false, reason: 'that is not a MAC address' };

	engine.unbind(st, mac);
	engine.dequeue(st, mac);
	st.held[mac] = true;

	// Written out now rather than at the next periodic flush: a hold that only
	// exists in memory is a hold that a restart quietly undoes, and a restart
	// happens every time /etc/config/bm_wanbind is edited.
	st.dirty = true;
	engine.persist(st, time(), true);

	notice(sprintf('instance %s: %s held out of the pool', st.instance.id, mac));
	return { ok: true, mac: mac };
};

/** And let it back in. */
export function release(args) {
	let st = instanceFor(text(args.instance));
	if (!st)
		return { ok: false, reason: 'name which instance - this router has more than one' };

	let mac = leases.normalizeMac(args.mac);
	if (!length(mac))
		return { ok: false, reason: 'that is not a MAC address' };

	if (!st.held[mac])
		return { ok: false, reason: 'that client is not being held' };

	delete st.held[mac];
	engine.enqueue(st, mac, time());

	st.dirty = true;
	engine.persist(st, time(), true);

	notice(sprintf('instance %s: %s put back in the pool', st.instance.id, mac));
	return { ok: true, mac: mac };
};

/**
 * Run a full pass now. What "Refresh" presses.
 *
 * Naming an instance narrows this to that instance and leaves the bindings
 * alone, because a binding belongs to no instance and reconciling one is not
 * part of what somebody asked about the other. Naming none does everything,
 * which is what the timer does too.
 */
export function reconcileNow(args) {
	let id = text(args.instance);
	let now = time();
	let out = [];

	for (let st in each()) {
		if (length(id) && st.instance.id != id)
			continue;

		push(out, reconcile.run(st, { bus: state.bus, now: now }));
	}

	if (length(id) && !length(out))
		return { ok: false, reason: 'no instance by that name' };

	return { ok: true, passes: out, direct: length(id) ? null : direct.run({ bus: state.bus, now: now }) };
};

/**
 * Take every rule off the router.
 *
 * What `bmwan flush` calls, and through it what `prerm` calls. It is offered
 * over ubus as well so the module can ask for it without shelling out, but the
 * CLI is the one that matters: `apk del bm-wanbind` has to leave the same
 * router behind whether or not anything is listening.
 */
export function flush(args) {
	let id = text(args.instance);
	let present = netlink.rules();

	if (present === null)
		return { ok: false, reason: 'the router\'s ip rules could not be read, so nothing was removed' };

	let removed = 0;
	let seen = {};

	for (let st in each()) {
		if (length(id) && st.instance.id != id)
			continue;

		removed += ruleset.flush(st.instance, present, st.lanCidr);
		st.ready = false;
		seen[st.instance.id] = true;
	}

	/*
	 * An instance this daemon holds no state for still has rules on the router.
	 * It was switched off after they were written, or the config was edited and
	 * it stopped being one of ours - and either way nothing walks past removing
	 * what it left, because reading the config is how the daemon decides what
	 * to look at and a section that is off is a section it does not read.
	 *
	 * `bmwan flush` has always read the file for exactly this reason. Doing
	 * less here would make the ubus path the one that leaves rules behind, and
	 * the ubus path is the one LuCI and the app have.
	 *
	 * Only instances the configuration still makes sense for. A refused one has
	 * a priority range that does not add up, and deleting by a range that does
	 * not add up is how you take somebody else's rules off.
	 */
	for (let one in cfg.instances()) {
		if (seen[one.id])
			continue;
		if (length(id) && one.id != id)
			continue;

		// No LAN subnet to scope by: the pool this instance would have built is
		// not built. `rules.ownedClientRules` falls back to the priority range
		// alone, which is what `bmwan flush` has always passed.
		removed += ruleset.flush(one, present, null);
	}

	/*
	 * And the one-to-one bindings, which belong to no instance.
	 *
	 * Only when no instance was named. `flush --instance NAME` is the first
	 * half of stopping or deleting that one instance, and taking every binding
	 * on the router off as a side effect of it would cut the connection of
	 * addresses that have nothing to do with the instance being stopped.
	 *
	 * A plain `flush` is the other thing entirely - the uninstall, and what the
	 * init script runs when the service stops - and it has to leave nothing
	 * behind. A binding's rule outliving the daemon is an address pointed at a
	 * table nobody maintains, which is the failure `prerm` exists to prevent.
	 */
	let bindings = length(id) ? { ok: true, removed: 0, swept: 0 } : direct.flush();

	return {
		// Not a success when half of it did not happen. A `prerm` that reported
		// ok while leaving every binding's rule on the router is how a package
		// removal turns into an address with a route to a table nothing
		// maintains and no service left to explain it.
		ok: bindings.ok === true,
		reason: (bindings.ok === true) ? null : text(bindings.reason),
		removed: removed + count(bindings.removed),
		bindings: count(bindings.removed),
		forwardings: count(bindings.swept)
	};
};

// ---------------------------------------------------------------------------
// One address, one WAN, written into the router's own configuration.
//
// Everything below reads and writes /etc/config/bm_wanbind rather than any
// state in this process, and re-reads it afterwards to find out what it did.
// `bm.wanbind.config` is the only thing that decides whether a binding is
// acceptable, so a section written from here is put through exactly the checks
// a section typed in by hand goes through - and a call that cannot pass them
// leaves the file the way it found it.

/**
 * A UCI cursor, or null - never an exception out of a ubus callback.
 *
 * `cursor()` answers null rather than raising when /etc/config cannot be
 * opened, so an unguarded one is a `uci.set` on null one read-only overlay
 * later - and that raise leaves the ubus callback it happened in, which is the
 * daemon's liveness rather than one failed call. Both outcomes are turned into
 * the single answer every caller below has a sentence for, which is the shape
 * `config.uc` and `direct.uc` already use for the same reason.
 */
function openConfig() {
	let uci = null;

	try {
		uci = cursor();
	}
	catch (e) {
		uci = null;
	}

	return uci;
}

/** The binding by that name as the file has it, refused ones included. */
function configuredBinding(id) {
	for (let one in cfg.directConfigured()) {
		if (one.id == id)
			return one;
	}

	return null;
}

/**
 * The routing table netifd says that WAN puts its default route in.
 *
 * Asked once, when a binding is created and there is no rule yet to disagree
 * with. It is never asked again: `bm.wanbind.config` reads a binding's `table`
 * exactly as written for the same reason it reads its `pref` that way - the
 * number is what the rule already on the router was written against, and
 * recomputing it from today's netifd would leave the real rule behind, unowned
 * and still carrying traffic.
 *
 * 0 when netifd could not be asked or that interface has no `ip4table`, which
 * is refused rather than guessed at.
 */
function wanTable(name) {
	let list = wans.dump(state.bus);

	if (list === null)
		return 0;

	for (let one in list) {
		if (one.name == name)
			return count(one.table);
	}

	return 0;
}

/**
 * The lowest ip rule priority in the band that nothing has claimed.
 *
 * Every configured binding is counted as holding its number, including the
 * disabled ones and the refused ones - which is wider than the collision check
 * in `bm.wanbind.config`, on purpose. That check asks which of two live rules
 * decides and can ignore a section writing no rule; this one is choosing a
 * number to write a *new* rule at, and a disabled binding is one `enabled '1'`
 * away from being live while a refused one may well have a rule on the router
 * already from before it was broken.
 */
function freePref(band) {
	let taken = {};

	for (let one in cfg.directConfigured()) {
		if (one.pref >= 1)
			taken[sprintf('%d', one.pref)] = true;
	}

	for (let pref = band.base; pref <= band.top; pref++) {
		if (!(sprintf('%d', pref) in taken))
			return pref;
	}

	return 0;
}

/**
 * Put the section back the way it was, after a write the config reader refused.
 *
 * The alternative is leaving the file in the state that was just refused, which
 * on an edit means the binding that was working before the call is now one that
 * writes no rule - a change that was reported as a failure having taken effect
 * anyway. `previous` is the record `directConfigured()` gave for that name
 * before the write, or null when there was no such section.
 *
 * Only what was actually set is written back. A refused section is restored
 * with the same fields missing that made it refusable, rather than gaining an
 * `option pref '0'` this daemon invented on its way past.
 */
function restore(id, previous) {
	// Nothing to answer here - the caller is already returning the refusal that
	// brought us in - so the only thing this can do about a config it cannot
	// open is say so where somebody will find it afterwards.
	let uci = openConfig();

	if (!uci) {
		err('binding ' + id + ': /etc/config could not be opened, so the refused write was left exactly as it is; check /etc/config/bm_wanbind by hand');
		return;
	}

	uci.delete(PACKAGE, id);

	if (previous) {
		uci.set(PACKAGE, id, 'direct');
		uci.set(PACKAGE, id, 'enabled', previous.enabled ? '1' : '0');

		if (length(previous.name) && previous.name != previous.id)
			uci.set(PACKAGE, id, 'name', previous.name);
		if (length(previous.ip))
			uci.set(PACKAGE, id, 'ip', previous.ip);
		if (length(previous.mac))
			uci.set(PACKAGE, id, 'mac', previous.mac);
		if (length(previous.wan))
			uci.set(PACKAGE, id, 'wan', previous.wan);
		if (length(previous.lan))
			uci.set(PACKAGE, id, 'lan', previous.lan);

		uci.set(PACKAGE, id, 'when_down', previous.whenDown);

		if (previous.pref >= 1)
			uci.set(PACKAGE, id, 'pref', sprintf('%d', previous.pref));
		if (previous.table >= 1)
			uci.set(PACKAGE, id, 'table', sprintf('%d', previous.table));
	}

	if (uci.commit(PACKAGE) === null)
		err('binding ' + id + ': the refused write could not be undone; check /etc/config/bm_wanbind by hand');
}

/**
 * Every binding in the file, with what the router is doing about it.
 *
 * The row is `bm.wanbind.direct`'s own, unchanged, wherever the last pass
 * produced one - one shape with one author, so that a field never means one
 * thing on this method and another on the LuCI page reading the same daemon.
 *
 * The rest is why this reads the file rather than only the pass. A binding the
 * pass has not reached - because it was written a second ago, because the first
 * pass has not run, because netifd was not answering when it did - is still a
 * binding somebody put in the file, and it is disproportionately the one they
 * are looking at a list to find. It appears with everything the file can say
 * about it and `state` empty, which is exactly what is true of it.
 *
 * `band` rides along because a caller about to add one needs to know which
 * priorities it may take, and whether it may take any at all.
 */
export function bindings(id) {
	let live = {};

	for (let row in direct.bindings()) {
		if (type(row) == 'object' && length(text(row.id)))
			live[row.id] = row;
	}

	let out = [];

	for (let one in cfg.directConfigured()) {
		if (length(id) && one.id != id)
			continue;

		if (type(live[one.id]) == 'object') {
			push(out, live[one.id]);
			continue;
		}

		push(out, {
			id: one.id,
			name: one.name,
			enabled: one.enabled,
			usable: one.usable,
			targetKind: one.targetKind,
			label: one.label,
			wan: one.wan,
			lan: one.lan,
			lanCidr: '',
			lanZone: '',
			wanZone: '',
			whenDown: one.whenDown,
			// Nothing has looked at the router for this one, so there is no
			// rule to report and nothing that could be said about where its
			// traffic is going. 0 rather than the stamped number, which would
			// be this daemon claiming to have written a rule it has not.
			pref: one.pref,
			table: 0,
			stampedTable: one.table,
			wanTable: 0,
			state: '',
			// A MAC binding's address is whatever its lease says, and only a
			// pass reads leases. An address binding is its own answer.
			ip: (one.targetKind == 'ip') ? one.label : '',
			since: 0,
			reason: one.reason ? one.reason : 'no pass has reached this binding yet',
			shadowedBy: '',
			forwarding: '',
			needsForwarding: false,
			needsTable: false,
			evidence: ''
		});
	}

	return {
		bindings: out,
		band: cfg.directBand(),

		// Whether anything is keeping these rows true. A list of bindings read
		// off a daemon that is not reconciling them is a list of intentions, and
		// the difference is not visible in any row - so it is said here rather
		// than left to be worked out from `info`'s `enabled`, which is about
		// instances and would be read as being about these.
		maintained: BINDINGS_MAINTAINED
	};
};

/**
 * A routing table for a WAN that has none, and the option that makes it real.
 *
 * Numbered from WAN_TABLE_BASE upwards, which is where the app's own half
 * numbers them, so a router driven from both ends does not end up with two
 * conventions. Everything netifd is already putting routes into is off limits,
 * and so is the router's own `main` and `local`; a number already carried by a
 * binding is skipped too, because two WANs sharing a table is exactly the state
 * that sends one binding's traffic out of another's port.
 *
 * The write is committed and netifd is asked to reload the one interface. That
 * is a DHCP re-acquire on that WAN and nothing else - the option is a statement
 * about where its routes go, and no other interface's configuration is touched.
 */
function allocateWanTable(wan) {
	// Its own cursor, rather than one passed in: this runs before `bind()` opens
	// the one it writes the binding with, and threading it through would make the
	// order of two unrelated things matter.
	let uci = openConfig();

	if (!uci)
		return 0;

	// Keyed by the number written out, because ucode object literals take labels
	// and strings and not integers - `{ 254: true }` does not parse. `rules.uc`
	// keeps the same set the same way, for the same reason.
	let taken = {};
	let claim = function(n) {
		if (n > 0)
			taken[sprintf('%d', n)] = true;
	};

	// The router's own, which nothing may take.
	claim(254);
	claim(255);
	claim(253);

	for (let one in wans.dump(state.bus) ?? [])
		claim(one.table);

	for (let one in cfg.directConfigured() ?? [])
		claim(one.table);

	let table = 0;
	for (let candidate = WAN_TABLE_BASE; candidate < WAN_TABLE_BASE + 1000; candidate++) {
		if (!taken[sprintf('%d', candidate)]) {
			table = candidate;
			break;
		}
	}

	if (!table)
		return 0;

	if (!uci.set('network', wan, 'ip4table', sprintf('%d', table)) || !uci.commit('network')) {
		err(sprintf('could not write option ip4table on %s', wan));
		return 0;
	}

	// netifd has to re-read the section before the table exists to point at.
	//
	// `network.reload` rather than bouncing the interface: reload re-reads the
	// configuration and applies what changed, where a down/up is a DHCP release
	// and re-acquire on a WAN that may be carrying traffic. The option is a
	// statement about which table this interface's routes go in, and reload is
	// enough to make it true.
	if (state.bus)
		state.bus.call('network', 'reload', {});

	notice(sprintf('%s had no routing table of its own; gave it table %d', wan, table));
	return table;
};

/**
 * Add a binding, or change one that is there.
 *
 * One method for both because the router is the source of truth: the module
 * says what the section should contain and this makes the file say it, which
 * means a module that lost track of what it had already written converges
 * rather than creating a second binding for the same address.
 *
 * `pref` and `table` are stamped once and then left alone. A caller that sends
 * them - the module does, because its own records carry them - has them written
 * exactly as sent; a caller that does not gets one allocated here, and only
 * here, on the way in. An edit that omits them keeps the numbers the existing
 * section already has rather than allocating again, because the rule on the
 * router is at the old number and would otherwise be left behind.
 *
 * `name`, `lan` and `when_down` are read the same way, and everything a caller
 * does not send on an existing section is left as the section has it. The only
 * fields an edit must always carry are the ones that say what this binding is:
 * the target - `ip` or `mac` - and the `wan` it leaves by.
 */
export function bind(args) {
	let id = trim(text(args.id));

	if (!length(id))
		return { ok: false, reason: 'name the binding: the section name is its identity here, in the app, and in every log line about it' };

	if (!match(id, SECTION_NAME)) {
		return { ok: false, reason: sprintf('%s is not a name a UCI section can have; letters, digits and underscores, up to 32 of them', id) };
	}

	if (id == 'main')
		return { ok: false, reason: 'main is this package\'s own settings section and is not a binding' };

	// A `config instance` by the same name would be turned into a binding by
	// the write below, which is a whole LAN's pool of WANs deleted by a call
	// that was adding one address.
	for (let one in cfg.configured()) {
		if (one.id == id) {
			return { ok: false, reason: sprintf('%s is already an instance in /etc/config/bm_wanbind - a whole LAN sharing a pool of WANs. Give the binding another name', id) };
		}
	}

	let ip = trim(text(args.ip));
	let mac = trim(text(args.mac));
	let wan = trim(text(args.wan));

	if (length(ip) && length(mac))
		return { ok: false, reason: 'send ip or mac, not both: a binding follows one thing, an address or a device wherever its lease puts it' };

	if (!length(ip) && !length(mac))
		return { ok: false, reason: 'send ip or mac - there is nothing for this binding to follow' };

	if (!length(wan))
		return { ok: false, reason: 'name the WAN this binding leaves through' };

	let previous = configuredBinding(id);
	let band = cfg.directBand();

	let pref = count(args.pref);
	let table = count(args.table);

	if (!pref && previous)
		pref = previous.pref;
	if (!table && previous)
		table = previous.table;

	if (!pref) {
		// The band is the only thing that keeps a binding's rule from being
		// read by an instance as one of its own client assignments, found to
		// have no lease behind it, and deleted. Numbering from a band that does
		// not hold is not a smaller version of that failure, it is that
		// failure, so nothing is allocated at all while it is unsafe.
		if (!band.usable)
			return { ok: false, reason: band.reason };

		pref = freePref(band);

		if (!pref) {
			return { ok: false, reason: sprintf('every ip rule priority from %d to %d is already claimed by a binding. Widen the band with `option direct_pref_base` on the main section, or remove a binding that is no longer wanted', band.base, band.top) };
		}
	}

	if (!table) {
		table = wanTable(wan);

		// Allocated here rather than refused, because refusing made the router
		// depend on the app for the one thing this package exists to do without
		// it. `option ip4table` is not part of a stock OpenWrt WAN, so on a
		// router nobody had already prepared, every `bmwan bind` at a shell
		// answered with an instruction to go and hand-edit /etc/config/network.
		// A binding needs a table of its own for that WAN; picking a free one is
		// arithmetic this half can do, and `writePreparation` already knows how
		// to write the option once a record carries the number.
		if (!table)
			table = allocateWanTable(wan);

		if (!table) {
			return { ok: false, reason: sprintf('netifd reports no ip4table for %s, so there is no table for this binding to point at. Give that interface `option ip4table` in /etc/config/network - a WAN with no table of its own has no route this binding could send anything down', wan) };
		}
	}

	let uci = openConfig();

	if (!uci) {
		return { ok: false, reason: 'the binding was not written: /etc/config could not be opened, so nothing in /etc/config/bm_wanbind was changed. Check that the overlay is mounted and writable' };
	}

	uci.set(PACKAGE, id, 'direct');
	// Carried forward like every other field, and for the sharper version of the
	// same reason: an edit that says only "this address leaves by wan3 now" must
	// not also switch a binding back on that somebody deliberately switched off.
	// The default is only reached when there is no section yet, where "put it in
	// force" is what creating one means.
	let enabled = type(args.enabled) == 'bool'
		? args.enabled
		: (previous ? previous.enabled : true);

	uci.set(PACKAGE, id, 'enabled', enabled ? '1' : '0');

	// An absent name, lan or when_down on a section that already exists carries
	// forward what the section has, exactly as `pref` and `table` do above. This
	// is one method for creating and for editing, and an edit that says only
	// "this address leaves by wan3 now" must not also be read as saying it has
	// no name, sits behind no LAN, and holds when its WAN goes down - which is
	// what an absent argument used to mean here, so a caller that sent every key
	// with the ones it did not care about left empty silently wiped three fields
	// per call.
	//
	// The price is that there is no way to empty one of these over this method,
	// for the same reason there is none to re-allocate a `pref`: absent means
	// unchanged. `uci delete bm_wanbind.<id>.lan` empties it, and the next pass
	// reads that.
	let name = trim(text(args.name));
	if (!length(name) && previous && previous.name != previous.id)
		name = previous.name;

	if (length(name) && name != id)
		uci.set(PACKAGE, id, 'name', name);
	else
		uci.delete(PACKAGE, id, 'name');

	// The two are exclusive, so setting one always removes the other. An edit
	// that moved a binding from an address to a MAC would otherwise leave both
	// in the section, which `bm.wanbind.config` refuses - correctly, and for a
	// reason that would have nothing to do with what was asked for.
	if (length(ip)) {
		uci.set(PACKAGE, id, 'ip', ip);
		uci.delete(PACKAGE, id, 'mac');
	}
	else {
		uci.set(PACKAGE, id, 'mac', mac);
		uci.delete(PACKAGE, id, 'ip');
	}

	uci.set(PACKAGE, id, 'wan', wan);

	let lan = trim(text(args.lan));
	if (!length(lan) && previous)
		lan = previous.lan;

	if (length(lan))
		uci.set(PACKAGE, id, 'lan', lan);
	else
		uci.delete(PACKAGE, id, 'lan');

	// Absent on a new binding means hold, the same as it does everywhere else
	// this word is read. A binding whose choice was lost fails closed rather
	// than quietly starting to let its address out over whatever connection the
	// router would have used, which is the one outcome its owner was promised
	// would not happen - and an edit that did not mention the word keeps the
	// choice the section already carries, which is that same promise a second
	// time: a call about the WAN is not a call about what happens when it fails.
	let whenDown = lc(trim(text(args.when_down)));
	if (!length(whenDown) && previous)
		whenDown = previous.whenDown;

	uci.set(PACKAGE, id, 'when_down', length(whenDown) ? whenDown : 'hold');

	uci.set(PACKAGE, id, 'pref', sprintf('%d', pref));
	uci.set(PACKAGE, id, 'table', sprintf('%d', table));

	if (uci.commit(PACKAGE) === null) {
		return { ok: false, reason: 'the binding would not commit to /etc/config/bm_wanbind; the file may be read-only or the overlay full' };
	}

	// Read back rather than trusted. Everything above is a field going into a
	// file; whether those fields are a binding this router can act on is one
	// question with one answer, and it is `bm.wanbind.config`'s.
	let written = configuredBinding(id);

	if (!written || written.reason) {
		restore(id, previous);
		return { ok: false, reason: written ? written.reason : 'the binding was written but cannot be read back out of /etc/config/bm_wanbind' };
	}

	// Now, rather than in up to `interval` seconds. Somebody who pressed this
	// is watching the address they just bound, and a rule that appears half a
	// minute later looks exactly like one that was never written.
	direct.run({ bus: state.bus, now: time() });

	notice(sprintf('binding %s: %s leaves by %s, pref %d, table %d, %s when it is down',
		id, written.label, written.wan, written.pref, written.table, written.whenDown));

	let answer = bindings(id);
	return { ok: true, binding: length(answer.bindings) ? answer.bindings[0] : null };
};

/**
 * Take a binding off the router: the section, and then a pass to clear up.
 *
 * The order is the opposite of `bmwan instance delete`, and the difference is
 * worth being explicit about because getting it wrong on the other half strands
 * rules. An instance's rules are found by the priority range written in its own
 * section, so deleting the section first loses the only description of what to
 * remove. A binding's rule is not: the pass owns the whole direct band, works
 * out what should be in it from the sections that are there, and removes
 * everything in it that nothing asked for. Deleting the section is therefore
 * how the rule is described as unwanted, and the pass immediately afterwards is
 * what carries it out - rule, firewall forwarding and all.
 *
 * The one gap is a binding whose priority was written outside the band by hand.
 * The pass does not sweep out there, so the rule stays; that is reported rather
 * than papered over, because the alternative is deleting a rule at a number
 * this daemon has no claim to.
 */
export function unbind(args) {
	let id = trim(text(args.id));

	if (!length(id))
		return { ok: false, reason: 'name the binding to remove' };

	let one = configuredBinding(id);

	if (!one)
		return { ok: false, reason: sprintf('no binding called %s in /etc/config/bm_wanbind', id) };

	let band = cfg.directBand();
	let stray = (one.pref >= 1 && (one.pref < band.base || one.pref > band.top));

	let uci = openConfig();

	if (!uci) {
		return { ok: false, reason: sprintf('%s was left alone: /etc/config could not be opened, so nothing was removed from /etc/config/bm_wanbind and its rule is still in force', id) };
	}

	uci.delete(PACKAGE, id);

	if (uci.commit(PACKAGE) === null)
		return { ok: false, reason: sprintf('%s would not be removed from /etc/config/bm_wanbind', id) };

	let after = direct.run({ bus: state.bus, now: time() });
	let removed = after.ok ? count(after.removed) : 0;

	notice(sprintf('binding %s removed, %d rule(s) with it', id, removed));

	return {
		ok: true,
		id: id,
		removed: removed,
		swept: after.ok ? count(after.swept) : 0,
		// Not null when there is something the caller has to do by hand, and
		// null when there is not. Both of these leave the section gone.
		reason: stray
			? sprintf('the section is gone, but %s was written at ip rule priority %d, outside the %d-%d band this daemon sweeps. Check `ip -4 rule show` and remove that rule by hand', id, one.pref, band.base, band.top)
			: (after.ok ? null : sprintf('the section is gone, but the rules could not be tidied up: %s. The next pass will do it', after.reason))
	};
};

/**
 * What this router thinks each of its interfaces is, and why.
 *
 * Read here rather than worked out by whoever is asking, because the answer has
 * to be the one the daemon itself acts on. A surface that offered a LAN address
 * the daemon reads as being on the way out would be offering a binding that
 * cannot be made - and the evidence below is what turns that from an argument
 * into something an operator can check.
 *
 * A refusal rather than an empty list when netifd did not answer. An empty list
 * says this router has no interfaces at all, and everything reading it would
 * act on that.
 */
export function interfaces() {
	let out = layout.read(state.bus);

	if (out === null) {
		return { ok: false, reason: 'netifd did not answer, so nothing can be said about this router\'s interfaces. Try again, and if it keeps happening check that netifd is running - `ubus call network.interface dump`' };
	}

	return { ok: true, interfaces: out.list, stated: out.stated };
};

function method(args, fn) {
	// Accepted on every method because LuCI's dispatcher appends the session id
	// to whatever a page sends, and ucode's publish refuses any named argument
	// the template does not declare. Stripped before the handler runs; the
	// hotplug hook never sends it, so `lease` is unchanged.
	args.ubus_rpc_session = '';

	return {
		call: function(req) {
			state.served = state.served + 1;
			let given = type(req.args) == 'object' ? req.args : {};
			delete given.ubus_rpc_session;
			return fn(given);
		},
		args: args
	};
}

export const methods = {
	info: method({}, () => info()),
	stats: method({}, () => stats()),

	// The hook's call. Named for what it carries rather than for what it makes
	// happen, because what it makes happen is the daemon's decision.
	lease: method({ action: '', mac: '', ip: '', host: '' }, (args) => lease(args)),

	assignments: method({ instance: '' }, (args) => assignments(text(args.instance))),
	waiting: method({ instance: '' }, (args) => waiting(text(args.instance))),

	pin: method({ instance: '', mac: '', wan: '' }, (args) => pin(args)),
	reassign: method({ instance: '', mac: '' }, (args) => reassign(args)),
	unassign: method({ instance: '', mac: '' }, (args) => unassign(args)),
	release: method({ instance: '', mac: '' }, (args) => release(args)),

	// The one-to-one bindings. `pin` above moves a client inside an instance's
	// pool for as long as this daemon remembers it; `bind` writes a section
	// that outlives the daemon, the module and the reboot.
	//
	// `pref` and `table` are declared as integers rather than as the strings
	// UCI stores, because ubus checks an argument's type against this template
	// and rejects the whole call when it disagrees. A number is what a caller
	// carrying its own stamped numbers has - `count()` still accepts the string
	// a shell would send, for the day one of these is reached another way.
	bindings: method({ id: '' }, (args) => bindings(text(args.id))),
	bind: method({
		id: '',
		name: '',
		ip: '',
		mac: '',
		wan: '',
		lan: '',
		when_down: '',
		pref: 0,
		table: 0,
		enabled: true
	}, (args) => bind(args)),
	unbind: method({ id: '' }, (args) => unbind(args)),

	// What this router reads each of its interfaces as, with the evidence. The
	// module asks before it offers an address to bind, and asks the router
	// rather than deciding for itself, so that the two halves cannot come to
	// different conclusions about which side of the router an interface is on.
	layout: method({}, () => interfaces()),

	reconcile: method({ instance: '' }, (args) => reconcileNow(args)),
	flush: method({ instance: '' }, (args) => flush(args))
};
