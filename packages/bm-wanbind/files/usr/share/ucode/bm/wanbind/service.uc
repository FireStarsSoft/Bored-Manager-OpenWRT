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

import { readfile } from 'fs';
import { timer } from 'uloop';

import { err, notice } from 'bm.log';

import * as cfg from 'bm.wanbind.config';
import * as engine from 'bm.wanbind.engine';
import * as leases from 'bm.wanbind.leases';
import * as netlink from 'bm.wanbind.netlink';
import * as reconcile from 'bm.wanbind.reconcile';
import * as ruleset from 'bm.wanbind.rules';

export const RELEASE = '2.2.0';

/**
 * The ubus contract version, separate from the release.
 *
 * The module refuses to drive a version it does not know and falls back to
 * SSH rather than guessing, so this moves only when the shape of a call
 * changes in a way an older module cannot cope with.
 */
export const API_VERSION = 1;

const STARTED = time();

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
};

export function attach(bus) {
	state.bus = bus;
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

/** One full pass over every instance. Returns one report per instance. */
export function pass() {
	let now = time();
	let out = [];

	for (let st in each())
		push(out, reconcile.run(st, { bus: state.bus, now: now }));

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

	if (!state.main.enabled) {
		notice('disabled in /etc/config/bm_wanbind; answering questions and writing nothing');
		return;
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

/** Everything the module needs to decide whether to drive this router here. */
export function info() {
	let out = [];
	for (let st in each())
		push(out, summary(st));

	return {
		name: 'bm-wanbind',
		release: RELEASE,
		apiVersion: API_VERSION,
		enabled: state.main.enabled,
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
		lastPassMs: lastPassMs
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

/** Run a full pass now. What "Refresh" presses. */
export function reconcileNow(args) {
	let id = text(args.instance);
	let now = time();
	let out = [];

	for (let st in each()) {
		if (length(id) && st.instance.id != id)
			continue;

		push(out, reconcile.run(st, { bus: state.bus, now: now }));
	}

	if (!length(out))
		return { ok: false, reason: 'no instance by that name' };

	return { ok: true, passes: out };
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

	return { ok: true, removed: removed };
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

	reconcile: method({ instance: '' }, (args) => reconcileNow(args)),
	flush: method({ instance: '' }, (args) => flush(args))
};
