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
// Only these two. The instance state itself is engine.uc's to read and write;
// what this file needs is the one thing that outlives an instance - the file
// under /etc/bm/state/ that remembers its sticky choices and its holds - so
// that deleting an instance does not leave a router remembering the WAN
// preferences of something that no longer exists.
import { read as readState, remove as removeState } from 'bm.state';

import * as cfg from 'bm.wanbind.config';
import * as direct from 'bm.wanbind.direct';
import * as engine from 'bm.wanbind.engine';
import * as layout from 'bm.wanbind.layout';
import * as leases from 'bm.wanbind.leases';
import * as monitor from 'bm.wanbind.monitor';
import * as netlink from 'bm.wanbind.netlink';
import * as prepare from 'bm.wanbind.prepare';
import * as reconcile from 'bm.wanbind.reconcile';
import * as ruleset from 'bm.wanbind.rules';
import * as wans from 'bm.wanbind.wans';

export const RELEASE = '2.4.0';

/**
 * Where a WAN's own routing table is numbered from when this half has to give
 * one. The app's binding half uses the same base, so a router driven from both
 * ends keeps one convention rather than two.
 */
const WAN_TABLE_BASE = 10000;

/**
 * What an instance is stamped with when whoever created it named no number.
 *
 * Defaults for a create, and nothing else. Every instance carries its own copy
 * of each of these in its own section and reads that copy for ever after, which
 * is exactly what makes them safe to change on a running router: moving one
 * decides what the next instance gets and says nothing about the ones already
 * in the file, whose rules were written against the numbers they carry.
 *
 * `config wanbind 'main'` may override any of them - that is what `settings_get`
 * answers with, and what the commented block in /etc/config/bm_wanbind
 * describes at a shell.
 */
const RULE_PREF_BASE = 20000;
const CATCH_ALL_PREF_BASE = 30000;
const CATCH_ALL_TABLE = 253;
const WAN_WARN_UPTIME = 5;
const WAN_ERROR_GRACE = 20;
const RELEASE_GRACE = 120;

/**
 * How far above `catch_all_pref_base` a new instance may be seated.
 *
 * One priority per instance, taken in order, so a router with three instances
 * numbers them 30000, 30001 and 30002 and a surface can say "slot 2" rather
 * than quoting a five-digit number nobody chose.
 */
const CATCH_ALL_SPAN = 1000;

// The room an instance needs between its client rules and its catch-all, which
// is also the largest number of clients it can seat. `bm.wanbind.config`
// refuses a narrower one; this is here so that a caller is told before the
// write rather than by the read-back afterwards.
const MIN_PREF_SPAN = 64;

// And the other two ceilings that file applies, for the same reason.
const MAX_CLIENTS_PER_WAN = 4096;
const MAX_TABLE = 65535;
const MAX_PREF = 0x7fffffff;

// Below this a full pass on a large LAN would overlap the previous one.
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 3600;

// The longest any of the three per-instance timers may be. A day is already far
// past the point where a number is a policy rather than a typo.
const MAX_GRACE = 86400;

/**
 * How much of the router's rule table `rules` reads.
 *
 * A monitor answer is one blob over ubus and a router with a five-thousand
 * session PPPoE pool has a rule per client, so the whole table is not always a
 * thing that fits. The default is what a caller who named no number gets, and
 * the maximum is what one who named a large one gets - reported as `capped`
 * rather than silently truncated, because a monitor that quietly stopped at two
 * thousand rules would be the one surface on this router that lies by omission.
 */
const RULES_LIMIT = 2000;
const RULES_LIMIT_MAX = 5000;

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
 *
 * 2.4.0 moves it, because this time an older module is broken by the change
 * rather than merely unaware of it. `stats` and `reconcile` renamed the key a
 * 2.3.0 module reads the binding numbers out of - `direct` is `core` now, since
 * one engine writes every rule on the router and a key called `direct` would be
 * read as being about one of the two kinds - and a module reading the old name
 * would report zero of everything and say nothing was wrong. The number is what
 * tells it to stop and say so instead.
 */
export const API_VERSION = 2;

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
	timer: null,

	// Whether netifd is answering, and for how long it has not been.
	//
	// A dump that fails is the one failure this daemon cannot work around: every
	// decision it makes is about interfaces, and a pass that read "no answer" as
	// "this router has no interfaces" would take every rule off. So the pass
	// stops instead - and stopping quietly is its own fault, because the rows go
	// on reading the way they read at the last good pass while nothing is
	// maintaining them. This is what says so.
	//
	// `loggedAt` is not reported. It exists so that a router whose netifd has
	// been gone for an hour writes one line a minute rather than one line every
	// thirty seconds.
	netifd: { ok: true, failures: 0, lastFailureAt: 0, reason: '', loggedAt: 0 },

	// The pass that has been asked for and has not run yet.
	//
	// Five hundred bindings arriving one ubus call at a time is five hundred
	// full passes - five hundred rule dumps and five hundred sweeps of the same
	// band - to reach a state one pass would have reached. So a request can ask
	// for a pass *soon* instead, and the ones that arrive while one is already
	// due are folded into it.
	soon: null,
	dueAt: 0,
	folded: 0,
	coalesced: 0,
	owed: {},
	lastPass: { kind: '', at: 0, folded: 0 }
};

// How often a netifd that is not answering is worth another line in syslog.
const NETIFD_LOG_EVERY = 60;

// How long a request that asked for a pass "soon" waits for company.
//
// A trailing edge that is never extended, which is the whole of the design: an
// extending window under a storm of hotplug events - a pool of five hundred
// sessions coming up after a reboot sends one per interface - would push the
// pass back for as long as the storm lasted, and the bindings would go
// unreconciled for exactly as long as the router was busiest. Fixed, the storm
// costs one pass every two seconds and every request is answered inside three.
const PASS_COALESCE_MS = 2000;

/**
 * How many bindings one `bind_many` may carry.
 *
 * Not a ubus limit - the reply is nowhere near the message ceiling at this size
 * - but a limit on one synchronous callback: two hundred sections is a commit
 * of about forty kilobytes and a read-back of the whole file, and a daemon
 * inside that callback is answering nothing else. The module sends five hundred
 * bindings as three calls, which is three commits rather than five hundred.
 */
const BIND_MANY_LIMIT = 200;

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
	let snap = cfg.snapshot({ log: true });

	state.main = cfg.main(snap);
	state.instances = {};
	state.order = [];

	for (let one in cfg.instances(snap)) {
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
	let band = cfg.directBand(snap);

	if (band.reason)
		err('direct_pref_base: ' + band.reason);

	notice(sprintf('%d binding(s) in the file, numbered in %d-%d', length(cfg.directBindings(snap)), band.base, band.top));
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
	prepare.attachSystem(runner);
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
	let seats = 0;
	let carrying = 0;
	let limit = (type(st.instance.clientsPerWan) == 'int') ? st.instance.clientsPerWan : 1;

	for (let name in st.wanOwners) {
		let load = engine.wanLoad(st, name);

		if (load < 1)
			continue;

		bound = bound + load;
		carrying++;
	}

	// What the pool could seat, or -1 for a pool with no limit. The pool itself
	// is what `free` counts; this is the ceiling that number is heading for.
	seats = (limit == 0) ? -1 : (length(st.freeWans) + carrying) * limit;

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
		clientsPerWan: limit,
		seats: seats,
		carrying: carrying,

		// Which addresses this instance is willing to bind, said twice because
		// the two readings are wanted by different surfaces. `range` is what
		// somebody typed, and it is null rather than a pair of empty strings on
		// an ordinary whole-LAN instance so that a page branches on one thing.
		// `cidrs` is the same fact as the blocks the fail-closed catch-all is
		// written as - so "which addresses does this instance fence" is
		// answerable without reading the router's rule table - and it is empty
		// until the first pass has run, which is the truth about it.
		range: (length(st.instance.rangeFrom) && length(st.instance.rangeTo))
			? { from: st.instance.rangeFrom, to: st.instance.rangeTo }
			: null,
		cidrs: st.scope,

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
 * The addresses a hand-placed binding already decides, as mac -> ip.
 *
 * Every binding's rule sits below every instance's client range, so the kernel
 * reaches it first. An instance that seated the same device anyway would write
 * a second rule the kernel never gets to, and would hold one of its WANs open
 * for traffic that leaves by the binding's instead - a client reported bound to
 * a line it does not use, and one fewer WAN for everybody actually waiting.
 *
 * Keyed by MAC because that is what an instance knows a device by, and resolved
 * from the pass's own rows rather than from the sections: a binding naming a
 * MAC is only on an address once a pass has read the leases, and a binding
 * whose WAN is down still decides its address - being held is not being absent.
 *
 * A disabled or refused binding reserves nothing. It writes no rule, so there
 * is nothing for an instance's rule to sit underneath.
 */
function reservedAddresses() {
	let out = {};

	for (let row in direct.bindings()) {
		if (type(row) != 'object' || row.enabled !== true || row.usable !== true)
			continue;

		let ip = (type(row.ip) == 'string') ? trim(row.ip) : '';
		if (!length(ip))
			continue;

		// The MAC when the binding follows one; otherwise the address itself is
		// the only key an instance could match on, and `reserved` is read by
		// address as well as by MAC for exactly that reason.
		let label = (type(row.label) == 'string') ? trim(row.label) : '';
		let mac = (row.targetKind == 'mac') ? lc(label) : '';

		out[length(mac) ? mac : ip] = ip;
	}

	return out;
}

/**
 * The LAN-local escape rules: one per LAN, consulted before every binding.
 *
 * A binding sends everything from an address to its WAN's routing table, and
 * that table knows only how to leave the building - so without these a bound
 * machine reaches the internet and not the printer on the next desk, and the
 * packet for the printer leaves by the WAN port addressed to a private network
 * that drops it.
 *
 * Off is a state as much as on is: `lan_local 0` means the band must be empty,
 * and a band that cannot be trusted to sit below the bindings is left alone
 * entirely rather than half written.
 */
function localEscapes(snap, view) {
	let local = cfg.localBand(snap);

	if (!local.usable)
		return 0;

	let present = netlink.destRules();

	if (present === null)
		return 0;

	let cidrs = local.enabled ? ruleset.localEscapeCidrs(view) : [];

	return ruleset.installLocalEscapes(local.base, local.top, cidrs, present);
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

	// One read of the configuration for the whole pass, and the only place that
	// asks for the refusals to be written to syslog: a bad section is a sentence
	// somebody has to act on, and it belongs in the log once a pass rather than
	// once per question anybody asks this daemon.
	let snap = cfg.snapshot({ log: true });

	// One read of netifd for the whole pass, for the same reason. Every instance
	// and the binding half all need the interface list; asking once per half was
	// five dumps on a router with four instances, each one a reply that grows
	// with every session dialled.
	let ifaces = wans.dump(state.bus);

	if (ifaces === null) {
		state.netifd.ok = false;
		state.netifd.failures = state.netifd.failures + 1;
		state.netifd.lastFailureAt = now;
		state.netifd.reason = sprintf('netifd did not answer, so every binding and every instance was left exactly as it was (%d time(s) since it last did)',
			state.netifd.failures);

		// Said out loud, but not thirty times a minute. A netifd that has been
		// gone for an hour is one fault, not a hundred and twenty.
		if (now - state.netifd.loggedAt >= NETIFD_LOG_EVERY) {
			state.netifd.loggedAt = now;
			err(state.netifd.reason);
		}

		// Every instance says it for itself as well. `info` is where somebody
		// looks when a page has stopped changing, and a row that reads exactly
		// as it did at the last good pass with nothing anywhere saying why is
		// the failure this whole block exists to deny.
		for (let st in each())
			st.lastReason = state.netifd.reason;

		state.ticks = state.ticks + 1;
		return out;
	}

	if (!state.netifd.ok) {
		notice(sprintf('netifd is answering again after %d failed dump(s)', state.netifd.failures));
		state.netifd.failures = 0;
		state.netifd.reason = '';
	}

	state.netifd.ok = true;
	state.netifd.loggedAt = 0;

	// Classified once as well. `layout.classify` is what decides which
	// interfaces are this router's own LANs and which are ways out of it, and
	// two passes over one dump answer the same question twice.
	let view = layout.classify(ifaces, layout.statements());

	// Before the instances and before the bindings, and that order is
	// load-bearing on the first pass after an upgrade: the escapes have to be
	// in the kernel before a rule that sends an address to a WAN's table is
	// verified against it, or there is a window in which a bound machine cannot
	// reach the network it is sitting on.
	localEscapes(snap, view);

	// Read before the instances run, from the rows the last binding pass left,
	// so that every instance on the router is told the same thing about which
	// addresses are already spoken for.
	let reserved = reservedAddresses();

	let ctx = {
		bus: state.bus,
		now: now,
		ifaces: ifaces,
		view: view,
		snap: snap,
		reserved: reserved
	};

	if (state.main.enabled) {
		for (let st in each())
			push(out, reconcile.run(st, ctx));
	}

	// Deliberately after the instances. A binding's priority is below every
	// instance's client range, so the kernel reads it first whatever order they
	// were written in - but a pass that put bindings first would be writing
	// rules from a device list the instances are about to refresh.
	direct.run(ctx);

	state.ticks = state.ticks + 1;
	return out;
};

/**
 * The one place a pass is run from, so that every pass is accounted for.
 *
 * `kind` is what asked for it - the timer, a coalesced request, a hotplug
 * event - and it is on `stats` because a router whose passes are all
 * `coalesced` is a router something is talking to constantly, which is a very
 * different picture from one ticking over on its timer.
 */
function runPass(kind) {
	let folded = state.folded;

	state.folded = 0;
	state.owed = {};

	let out = pass();

	state.lastPass = { kind: kind, at: time(), folded: folded };
	return out;
}

/**
 * Ask for a pass shortly, and fold this request into any already asked for.
 *
 * Answers when the pass is due, so a caller can tell somebody "in a moment"
 * rather than "done" - which is the honest answer and the one the surfaces
 * show.
 */
function passSoon(reason) {
	// Not through `text()`: that helper is declared further down this file, and
	// ucode resolves a name when it compiles the function that mentions it.
	let why = (type(reason) == 'string' && length(reason)) ? reason : 'request';

	state.folded = state.folded + 1;
	state.owed[why] = (exists(state.owed, why) ? state.owed[why] : 0) + 1;

	if (state.soon) {
		state.coalesced = state.coalesced + 1;
		return state.dueAt;
	}

	state.dueAt = time() + (PASS_COALESCE_MS / 1000);

	// Wrapped for the same reason the reconcile timer is: an exception escaping
	// a uloop callback takes the loop down and leaves a router with rules
	// nobody is maintaining.
	state.soon = timer(PASS_COALESCE_MS, () => {
		state.soon = null;

		try {
			runPass('coalesced');
		}
		catch (e) {
			err('reconcile pass failed: ' + e);
		}
	});

	return state.dueAt;
}

/** Whether netifd is answering, as every surface reads it. */
function netifdState() {
	return {
		ok: state.netifd.ok,
		failures: state.netifd.failures,
		lastFailureAt: state.netifd.lastFailureAt,
		reason: state.netifd.reason
	};
}

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
				runPass('timer');
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
	let snap = cfg.snapshot();

	if (!netlink.usable())
		err('netlink is not answering; no ip rule can be written on this router');

	// Said at start rather than only in a comment, because the option is one
	// word in a file and what it does is now two different things to the two
	// halves. A pass still runs and the timer is still armed: the bindings are
	// the router's own and are kept in force, and only the pools are off.
	if (!state.main.enabled) {
		notice(sprintf('instances are switched off in /etc/config/bm_wanbind, so no client on any LAN will be handed a WAN. The %d one-to-one binding(s) in the file are not an instance and are still reconciled every %ds; `option enabled 1` on the main section brings the pools back',
			length(cfg.directConfigured(snap)), state.main.interval));
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

/**
 * The same, with a real default behind it.
 *
 * `count()` answers 0 for "nothing usable was sent", which is right wherever 0
 * means "not given". It is wrong in the two places below: `clients_per_wan 0`
 * is a real value meaning no limit, and a UCI option that is simply absent has
 * to come back as the shipped default rather than as zero.
 */
function numberOr(value, fallback) {
	if (type(value) == 'int')
		return value;

	if (type(value) == 'double')
		return int(value);

	if (type(value) == 'string' && match(trim(value), /^[0-9]+$/))
		return int(trim(value));

	return fallback;
}

/**
 * Whether the caller sent this key at all.
 *
 * The whole of "absent means unchanged" rests on this rather than on
 * truthiness, and the difference is not academic: `clients_per_wan 0` is no
 * limit, an empty `range_from` is the whole LAN, and `enabled false` is a
 * deliberate stop. Every one of those is falsy and every one of them is a real
 * instruction, so a merge written the obvious way would silently keep the old
 * value for exactly the three edits somebody most wanted to make.
 */
function given(args, key) {
	return (type(args) == 'object') && exists(args, key);
}

function pickText(args, key, fallback) {
	return given(args, key) ? trim(text(args[key])) : fallback;
}

function pickNumber(args, key, fallback) {
	return given(args, key) ? numberOr(args[key], fallback) : fallback;
}

/**
 * A flag out of whatever the caller sent.
 *
 * ubus type-checks an argument against the template and hands a real boolean
 * through, but the same functions are reached from a shell and from LuCI, where
 * the answer to a checkbox is the string UCI stores. Reading '0' as true would
 * switch an instance back on that somebody had just switched off, which is the
 * kind of mistake nobody goes looking for in a method that reported success.
 */
function pickFlag(args, key, fallback) {
	if (!given(args, key))
		return fallback;

	let value = args[key];

	if (type(value) == 'bool')
		return value;

	if (type(value) == 'int')
		return value != 0;

	if (type(value) == 'string')
		return !(trim(value) in [ '', '0', 'no', 'off', 'false', 'disabled' ]);

	return fallback;
}

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

/**
 * `config wanbind 'main'` in full, with the shipped defaults filled in.
 *
 * The seven numbers are read here rather than in `bm.wanbind.config` because
 * that file's question is whether one *section* can be used, and none of these
 * is about a section. They are what a section is given when it is created and
 * says nothing for itself; an instance that already exists carries its own copy
 * and never looks at them again, which is the whole reason they can be changed
 * on a running router at all.
 *
 * `enabled` and `interval` come from `cfg.main()` rather than from a second
 * reader of the same two options, so this method and the running process cannot
 * come to different conclusions about whether anything is happening.
 * `direct_pref_base` comes from the band for the same reason: the clamping and
 * the refusal for that number already live there.
 *
 * `band` rides along because a caller about to write a priority needs to know
 * whether the band it would go in is safe at all, and that is a question about
 * the instances rather than about this section.
 */
function settingsRead(snap) {
	let main = cfg.main(snap);
	let band = cfg.directBand(snap);
	let local = cfg.localBand(snap);

	let out = {
		enabled: main.enabled,
		interval: main.interval,
		direct_pref_base: band.base,
		rule_pref_base: RULE_PREF_BASE,
		catch_all_pref_base: CATCH_ALL_PREF_BASE,
		catch_all_table: CATCH_ALL_TABLE,
		wan_table_base: WAN_TABLE_BASE,
		wan_warn_uptime: WAN_WARN_UPTIME,
		wan_error_grace: WAN_ERROR_GRACE,
		release_grace: RELEASE_GRACE,
		band: band,

		// Whether a bound address may still reach the networks this router
		// serves, and where the rules that let it sit. On by default: a binding
		// that cut a machine off its own LAN is not what anybody asked for when
		// they pinned it to a WAN.
		lan_local: local.enabled,
		local_pref_base: local.base,
		local: local
	};

	// Off the snapshot rather than out of a cursor of its own. The defaults
	// above are the shipped ones, so a router that lost /etc/config/bm_wanbind
	// still answers this question - it simply has no instances for the answer
	// to apply to, and `raw` is seven nulls.
	let raw = main.raw;

	out.rule_pref_base = numberOr(raw.rule_pref_base, RULE_PREF_BASE);
	out.catch_all_pref_base = numberOr(raw.catch_all_pref_base, CATCH_ALL_PREF_BASE);
	out.catch_all_table = numberOr(raw.catch_all_table, CATCH_ALL_TABLE);
	out.wan_table_base = numberOr(raw.wan_table_base, WAN_TABLE_BASE);
	out.wan_warn_uptime = numberOr(raw.wan_warn_uptime, WAN_WARN_UPTIME);
	out.wan_error_grace = numberOr(raw.wan_error_grace, WAN_ERROR_GRACE);
	out.release_grace = numberOr(raw.release_grace, RELEASE_GRACE);

	return out;
}

/** Everything the module needs to decide whether to drive this router here. */
/**
 * What the kernel did with the rules the last passes wrote.
 *
 * Lifted out of `stats` because `info` carries it too, and a second reading of
 * the same numbers a few lines apart is how two surfaces come to disagree about
 * whether this router is holding what it was told.
 *
 * `unverified` is the number that matters and the reason any of this exists: a
 * rule the socket accepted and the kernel is not holding a moment later is the
 * whole explanation for an address being on the wrong WAN while every row on
 * every page reads bound.
 */
function netlinkCounters() {
	let one = direct.summary();

	return {
		written: one.written,
		verified: one.written - one.unverified,
		unverified: one.unverified,
		removed: one.removed,
		lastUnverified: one.lastUnverified
	};
}

export function info() {
	let snap = cfg.snapshot();

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

		// The whole of `config wanbind 'main'`, the same object `settings_get`
		// answers with. Here as well because every surface that draws this
		// answer also has to decide what to offer as the default for a *new*
		// instance, and a second call to find that out is a second chance for
		// the two to be read a tick apart and disagree.
		settings: settingsRead(snap),

		instances: out,

		// Everything in the file, including whatever this daemon refused and
		// whatever is switched off - neither of which has an entry in
		// `instances` above, because neither has any state to report. A page
		// that drew only `instances` would leave out exactly the rows somebody
		// opened it to fix.
		configured: cfg.configured(snap),

		// The one-to-one half's own totals, and what the kernel did with the
		// last pass's writes. Both are on `stats` as well, and both are here
		// because this is the call every surface makes first: a page that had to
		// fetch `stats` to find out whether any binding exists would either make
		// two calls to draw one row or quietly leave the hand-placed bindings
		// out of its counts, which is what the first draft of the page did.
		core: direct.summary(),
		netlink: netlinkCounters(),

		// Whether the daemon can see the router at all. Everything above is a
		// decision made from netifd's interface list, so a page that drew them
		// without this would be showing the last good pass as though it were now.
		netifd: netifdState(),

		// And whether a bound address can still reach the networks this router
		// serves. A page that showed a row as bound while this was unusable
		// would be describing a machine that has the internet and cannot reach
		// the printer beside it.
		local: cfg.localBand(snap)
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

	// Read once. Two calls a few statements apart are two different routers as
	// far as anything comparing `written` against `unverified` is concerned.
	let core = direct.summary();
	let written = count(core.written);
	let unverified = count(core.unverified);

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
		//
		// Called `core` since 2.4.0, and `direct` before it. The name was
		// accurate while this engine wrote nothing but the hand-placed
		// bindings; it writes every rule this daemon puts on the router now, so
		// a key called `direct` would be read as being about one of the two
		// kinds of binding rather than about the engine underneath both.
		core: core,

		// What the kernel was still holding a moment after each write, which is
		// a different question from how many writes the socket accepted.
		//
		// It is here rather than left inside `core` because it is a fact about
		// this router rather than about the bindings on it: a rule that is
		// accepted and gone a moment later is the signature of something else
		// removing rules in this band, and this number is the answer to "why is
		// that address on the wrong WAN when every row reads bound".
		//
		// `verified` is derived rather than counted. Every write is read back,
		// so what did not come back missing landed.
		netlink: {
			written: written,
			verified: (written > unverified) ? written - unverified : 0,
			unverified: unverified,
			removed: count(core.removed),
			lastUnverified: (type(core.lastUnverified) == 'array') ? core.lastUnverified : []
		},

		// The same verdict `info` carries, because this is the call a watchdog
		// makes: every number above is a count of decisions taken from netifd's
		// interface list, and one that stopped moving because nothing can be
		// read is not the same as one that stopped moving because nothing
		// changed.
		netifd: netifdState(),

		// What asked for the last pass, and how many requests it answered.
		//
		// `owed` is what has asked since and is still waiting, so a router that
		// is being talked to faster than it can reconcile says which caller is
		// doing the talking rather than only that it is busy.
		pass: {
			kind: state.lastPass.kind,
			at: state.lastPass.at,
			folded: state.lastPass.folded,

			// What has asked since and is still waiting, which is a different
			// number from what the last pass answered: a router being talked to
			// faster than it reconciles has a `waiting` that never reaches zero.
			waiting: state.folded,
			coalesced: state.coalesced,
			pending: (state.soon != null),
			due: state.soon ? state.dueAt : 0,
			owed: state.owed
		}
	};
};

/** The rows a table shows: who is on which WAN. */
export function assignments(id) {
	let out = [];

	for (let st in each()) {
		if (length(id) && st.instance.id != id)
			continue;

		// One row per seat, not one per WAN: above one client per WAN a line
		// carries several people and a table that showed one of them would be
		// hiding the rest from every surface at once.
		for (let wan in st.wanOwners) {
			for (let mac in engine.wanHolders(st, wan)) {
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

		// Devices this instance is deliberately leaving alone. Listed rather
		// than left out, because a device that is on the LAN, has a lease, and
		// appears in none of this instance's tables is the hardest thing to
		// account for on the page - and the answer is not that something went
		// wrong, it is that somebody bound it by hand.
		// Read from the MAC-keyed set the pass resolves, not from what the
		// caller handed in: that one keys an address binding by its address, so
		// walking it here put a row on the page whose "device" column held an
		// IPv4 address and whose lease was never looked up.
		for (let mac in st.reservedMacs) {
			let device = st.devices[mac];

			push(out, {
				instance: st.instance.id,
				mac: mac,
				ip: device ? device.ip : text('' + st.reservedMacs[mac]),
				host: device ? device.host : '',
				order: 0,
				since: 0,
				held: false,
				why: 'reserved',
				reason: 'a one-to-one binding already decides this address, so this instance leaves it alone'
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

	// A pin is a deliberate instruction about one client, so it outranks
	// somebody else's claim on the line - but only when there is no room for
	// both. Above one client per WAN the ordinary case is that the pinned
	// device simply joins the others and nobody is moved at all.
	//
	// The newest holder is the one evicted, and only one of them: they have had
	// the line for the shortest time, and taking the whole WAN off everybody to
	// seat one person would be a far larger act than the button describes. They
	// go into the queue rather than being left with nothing and no record.
	if (!engine.wanRoom(st, wan) && !engine.onWan(st, wan, mac)) {
		let newest = null;
		let newestAt = 0;

		for (let holder in engine.wanHolders(st, wan)) {
			let at = (type(st.assignedAt[holder]) == 'int') ? st.assignedAt[holder] : 0;

			if (newest === null || at >= newestAt) {
				newest = holder;
				newestAt = at;
			}
		}

		if (newest) {
			engine.unbind(st, newest);
			engine.enqueue(st, newest, time());
		}
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

	// A request that names no instance and does not insist on an answer is a
	// nudge rather than a question, and nudges arrive in storms: the interface
	// hotplug hook sends one per session coming up, so a pool of five hundred
	// dialling after a reboot asks five hundred times for the same pass.
	//
	// `wait: true` is what a person pressing a button sends, and it still runs
	// the pass here and answers with what it did.
	if (!length(id) && args.wait !== true) {
		let due = passSoon('reconcile');

		return {
			ok: true,
			pending: true,
			due: due,
			folded: state.folded,
			passes: [],
			core: null
		};
	}

	// The same map the timer builds, and it has to be built here too.
	//
	// It was not, and the effect was invisible in exactly the way this release
	// is about: on the thirty-second timer an instance left a hand-bound address
	// alone, and on `Run a pass now` - the button, the module's own action, and
	// `bmwan reconcile` - it seated it, because `ctx.reserved` arrived undefined
	// and every address on the router read as free. One pass would undo what the
	// last one decided, on a router where nothing was misconfigured and no
	// message was printed.
	let reserved = reservedAddresses();

	// One reading of netifd and one classification of it, shared by every
	// instance and by the binding half, exactly as the timer's pass does it.
	// Asking per half was five dumps of the same router for one request.
	let ifaces = wans.dump(state.bus);

	if (ifaces === null)
		return { ok: false, reason: 'netifd did not answer, so nothing was changed' };

	let ctx = {
		bus: state.bus,
		now: now,
		ifaces: ifaces,
		view: layout.classify(ifaces, layout.statements()),
		snap: cfg.snapshot(),
		reserved: reserved
	};

	for (let st in each()) {
		if (length(id) && st.instance.id != id)
			continue;

		push(out, reconcile.run(st, ctx));
	}

	if (length(id) && !length(out))
		return { ok: false, reason: 'no instance by that name' };

	// `core` rather than `direct`, for the reason `stats` gives: one engine
	// writes every rule on this router now, and the key names the engine rather
	// than one of the two kinds of binding it writes for.
	return { ok: true, passes: out, core: length(id) ? null : direct.run(ctx) };
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
	let snap = cfg.snapshot();

	let id = text(args.instance);

	// A flush naming one instance takes that instance's rules off and nothing
	// else. The escapes are the router's, not any instance's, so only a flush
	// of everything takes them.
	if (!length(id)) {
		let local = cfg.localBand(snap);
		let held = netlink.destRules();

		if (held !== null)
			ruleset.flushLocal(local.base, local.top, held);
	}

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
	for (let one in cfg.instances(snap)) {
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

/** The binding by that name as the file has it, refused ones included. */
function configuredBinding(id, snap) {
	for (let one in cfg.directConfigured(snap)) {
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
	// One interface, asked about by name. The whole dump answers it too, and at
	// five hundred sessions that is a few hundred kilobytes of reply to read one
	// number out of - on the call somebody makes when they press Save.
	let one = wans.status(state.bus, name);

	if (one.ok && one.iface != null)
		return count(one.iface.table);

	// Either netifd did not answer or it does not know that name, and ubus does
	// not tell this binding which. The dump does, and this is the line that
	// decides what number goes into a section, so it asks.
	let list = wans.dump(state.bus);

	if (list === null)
		return 0;

	for (let row in list) {
		if (row.name == name)
			return count(row.table);
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
function freePref(band, snap, claimed) {
	let taken = {};

	for (let one in cfg.directConfigured(snap)) {
		if (one.pref >= 1)
			taken[sprintf('%d', one.pref)] = true;
	}

	// And the numbers handed out earlier in this same batch, which are in
	// nobody's file yet. Without them two hundred bindings written in one call
	// would every one of them be given the lowest free priority - two hundred
	// rules at one number, which is not an order the kernel breaks in any way
	// worth relying on.
	for (let key in keys((type(claimed) == 'object') ? claimed : {}))
		taken[key] = true;

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
 * Whether the router's rule table agrees with each of these rows.
 *
 * One dump for the whole list, and nothing written. A row that reads bound,
 * held or fallback is claiming a rule at a priority, and `verified` is true
 * when that exact rule is there. A row claiming none - disabled, refused,
 * waiting for a lease to name an address - has nothing to check and is true,
 * because the question is whether the router matches what the row says, and for
 * those rows it does.
 *
 * False therefore means one of two things and both are worth the same colour: a
 * rule this daemon believes it wrote is not on the router, or the rule table
 * could not be read at all and nothing was confirmed. `verify` next door is
 * where the difference is spelled out, and it writes nothing either.
 */
function markVerified(rows) {
	let held = netlink.rules();
	let seen = {};

	for (let one in (held === null) ? [] : held)
		seen[sprintf('%d|%s|%d', one.pref, one.cidr, one.table)] = true;

	for (let row in rows) {
		let claims = (row.state in [ 'bound', 'held', 'fallback' ]) &&
			row.pref >= 1 && row.table >= 1 && length(text(row.ip));

		row.verified = claims
			? (seen[sprintf('%d|%s/32|%d', row.pref, row.ip, row.table)] === true)
			: (held !== null);
	}

	return rows;
}

/**
 * The seats every instance is currently holding, as bindings.
 *
 * An instance is a generator of bindings rather than a different kind of thing:
 * it watches a LAN and hands out WANs, and what it produces on the wire is the
 * same address-to-table rule a hand-placed binding is. So the two belong in one
 * list, told apart by `source`, and a surface asking "what is bound on this
 * router" gets the answer rather than half of it and a second call to make.
 *
 * Their id is `<instance>:<mac>`, which is not a section name and is not meant
 * to be: nothing writes these, they exist for as long as the lease does, and
 * `unbind` refuses one by name rather than pretending it could remove it.
 *
 * `whenDown` is `hold` for all of them and is not a choice anybody made. An
 * instance's client that loses its WAN keeps its rule and is caught by the
 * instance's own fail-closed catch-all underneath, which is the same promise a
 * held binding makes by a different route.
 */
function derivedBindings() {
	let out = [];

	for (let st in each()) {
		for (let wan in st.wanOwners) {
			for (let mac in engine.wanHolders(st, wan)) {
				let device = st.devices[mac];

				if (!device)
					continue;

				push(out, {
					id: sprintf('%s:%s', st.instance.id, mac),
					name: length(text(device.host)) ? text(device.host) : mac,
					enabled: true,
					usable: true,
					source: st.instance.id,
					instance: st.instance.id,
					targetKind: 'mac',
					label: mac,
					mac: mac,
					host: text(device.host),
					wan: wan,
					lan: st.instance.lan,
					lanCidr: text(st.lanCidr),
					lanZone: '',
					wanZone: '',
					whenDown: 'hold',
					pref: device.pref,
					table: device.table,
					stampedTable: device.table,
					wanTable: device.table,
					state: 'bound',
					parkedBy: 'catch-all',
					ip: text(device.ip),
					since: (type(st.assignedAt[mac]) == 'int') ? st.assignedAt[mac] : 0,
					reason: sprintf('seated by instance %s', st.instance.id),
					shadowedBy: '',
					forwarding: '',
					needsForwarding: false,
					needsTable: false,
					evidence: ''
				});
			}
		}
	}

	return out;
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
export function bindings(id, source) {
	let snap = cfg.snapshot();

	let live = {};

	for (let row in direct.bindings()) {
		if (type(row) == 'object' && length(text(row.id)))
			live[row.id] = row;
	}

	let out = [];

	for (let one in cfg.directConfigured(snap)) {
		if (length(id) && one.id != id)
			continue;

		// Copied rather than pushed by reference: the two fields added below
		// this loop would otherwise be written into the pass's own rows, and a
		// read method quietly editing the state it is reporting on is a thing
		// nobody looks for when the numbers stop adding up.
		if (type(live[one.id]) == 'object') {
			push(out, { ...live[one.id], source: 'manual' });
			continue;
		}

		push(out, {
			id: one.id,
			// Every row here is one somebody placed by hand: a `config direct`
			// section is the only kind of binding this daemon holds, and an
			// instance's client assignments are answered by `assignments`
			// rather than here. The field exists so that a reader never has to
			// work that out - it is the same word the monitor labels a rule
			// with, and what a surface showing hand-placed and pool-assigned
			// addresses in one table sorts on.
			source: 'manual',
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

	for (let one in derivedBindings())
		push(out, one);

	let rows = markVerified(out);

	// Narrowed after the rows are built rather than before, so that `counts`
	// below is about the router rather than about the filter - a page showing
	// "3 by hand" beside a filtered list of one would be answering a question
	// nobody asked.
	let want = text(source);
	let wantId = text(id);
	let shown = [];
	let manual = 0;
	let derived = 0;
	let byState = {};

	for (let row in rows) {
		if (row.source == 'manual')
			manual++;
		else
			derived++;

		let key = length(row.state) ? row.state : 'pending';
		byState[key] = (type(byState[key]) == 'int' ? byState[key] : 0) + 1;

		if (length(want) && row.source != want)
			continue;

		if (length(wantId) && row.id != wantId)
			continue;

		push(shown, row);
	}

	// Every band a rule could legitimately sit in, so a reader does not have to
	// know this daemon's numbering to tell a binding from an instance's client.
	let bands = [];
	for (let one in cfg.configured(snap)) {
		push(bands, {
			id: one.id,
			base: one.rulePrefBase,
			top: one.catchAllPref - 1,
			catchAllPref: one.catchAllPref,
			catchAllTable: one.catchAllTable,
			scope: ruleset.catchAllCidrs(one, '')
		});
	}

	return {
		// One rule dump for the whole list, after it is built, so that the
		// question "is the router actually doing this" costs the same on a
		// router with one binding and one with two hundred.
		bindings: shown,

		// Whether anything was asked for, and therefore whether an empty list
		// means "this router holds none" or "none matched what you asked".
		// Those are different sentences and a surface cannot tell them apart
		// from the list alone - which is how a filtered view comes to state a
		// fact about the whole router.
		filtered: (length(want) > 0 || length(wantId) > 0),
		counts: { manual: manual, derived: derived, byState: byState },
		instances: bands,
		band: cfg.directBand(snap),

		// Whether anything is keeping these rows true. A list of bindings read
		// off a daemon that is not reconciling them is a list of intentions, and
		// the difference is not visible in any row - so it is said here rather
		// than left to be worked out from `info`'s `enabled`, which is about
		// instances and would be read as being about these.
		maintained: BINDINGS_MAINTAINED
	};
};

/**
 * Every routing table number something on this router is already routing
 * through.
 *
 * Four sources, and leaving any of them out is the same failure wearing a
 * different hat: two interfaces sharing one table is one connection's traffic
 * leaving by another's port. netifd's dump is what is true now; the `ip4table`
 * options in /etc/config/network are what will be true after the next reload,
 * and a table written a moment ago is in the second and not the first; a
 * binding's stamped table carries that binding's WAN.
 *
 * 254 and 255 are the router's own. 253 is deliberately not claimed here -
 * OpenWrt leaves `default` empty, which is exactly what makes it the natural
 * home for an `unreachable default` - so the two callers below add it or not
 * according to what they are choosing a number for.
 *
 * Keyed by the number written out, because ucode object literals take labels
 * and strings and not integers. `rules.uc` keeps the same set the same way.
 */
function routedTables(list, snap) {
	let taken = {};
	let uci = openConfig();

	let claim = function(n) {
		if (type(n) == 'int' && n > 0)
			taken[sprintf('%d', n)] = true;
	};

	claim(254);
	claim(255);

	for (let one in (type(list) == 'array') ? list : []) {
		claim(one.table);

		if (uci)
			claim(numberOr(uci.get('network', one.name, 'ip4table'), 0));
	}

	for (let one in cfg.directConfigured(snap))
		claim(one.table);

	return taken;
}

/**
 * Why this interface must not be treated as a way out of the router, or null.
 *
 * Every path that acts on a WAN name asks this first, and the reason it exists
 * is a router that lost a whole subnet. `bind` used to take the name on trust,
 * find no `option ip4table` on it, and write one - and the name it had been
 * given was a LAN. netifd reloaded, that LAN's connected route moved out of
 * `main` into a table of its own, and from that moment nothing else on the
 * router could reach the subnet: not the other LAN, not the router's own
 * services, not the person who had just typed the command. Thirty-five devices
 * re-ran DHCP. Nothing in the reply said anything had gone wrong.
 *
 * The check `bind_check` and `prepare` already make, made once more here at the
 * point where the damage would be done, because a refusal a caller may skip is
 * not a guard. A netifd that did not answer is not a verdict either way and is
 * left to the caller: `allocateWanTable` refuses on it, and `bind` does not,
 * because a binding written against a router that could not be read is one
 * whose rule simply does not appear until it can be.
 */
function wanRoleRefusal(wan, given) {
	let live = (type(given) == 'array') ? given : wans.dump(state.bus);

	if (live === null)
		return null;

	let view = layout.classify(live, layout.statements());
	let verdicts = (type(view.byName) == 'object') ? view.byName : {};
	let verdict = verdicts[wan];

	if (!verdict) {
		return sprintf('netifd knows no interface called %s. This wants the name of the section in /etc/config/network - wan, wan2 - and not the device underneath it, which is what eth1.101 and pppoe-wan2 are', wan);
	}

	if (verdict.role == 'lan') {
		return sprintf('%s is one of this router\'s own LANs, because %s. A binding that left by the network it is already on would send nothing anywhere - and giving it a routing table of its own, which is what preparing a WAN means, would take that subnet out of the router\'s main table and cut it off from everything else on this router',
			wan, layout.clauses(verdict.lanEvidence));
	}

	return null;
};

/**
 * The same, for choosing a table to give a WAN that has none.
 *
 * Two more are off limits here than when a catch-all table is being chosen. A
 * WAN may not be handed 253 or any instance's `catch_all_table`, because those
 * hold nothing but `unreachable default`: every client seated on that WAN would
 * be dropped while every row on every surface read bound.
 *
 * Handed to `prepare` rather than left to it, so that one call preparing four
 * WANs cannot give two of them the same number - `prepare` adds each one it
 * allocates as it goes, and this is what it starts from.
 */
function wanTablesTaken(list, snap) {
	let taken = routedTables(list, snap);

	taken['253'] = true;

	for (let one in cfg.configured(snap)) {
		if (one.catchAllTable > 0)
			taken[sprintf('%d', one.catchAllTable)] = true;
	}

	return taken;
}

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
function allocateWanTable(wan, snap, shared) {
	// Its own cursor, rather than one passed in: this runs before `bind()` opens
	// the one it writes the binding with, and threading it through would make the
	// order of two unrelated things matter.
	let uci = openConfig();

	if (!uci)
		return 0;

	// Whatever the section already says, before anything is chosen.
	//
	// netifd is not the whole answer to "does this WAN have a table": an option
	// written and not yet reloaded is in the file and not in the dump, so a
	// reader that asked only netifd would decide the interface had none and
	// write a second number over somebody else's. The number in the file wins
	// and nothing is written.
	let already = uci.get('network', wan, 'ip4table');

	if (already != null && numberOr('' + already, 0) > 0)
		return numberOr('' + already, 0);

	// A dump that failed is not a router with no routing tables. Reading it that
	// way would hand this WAN a number another interface is already using, which
	// is the one state that sends one binding's traffic out of another's port -
	// so a missing answer refuses rather than guesses.
	let live = wans.dump(state.bus);

	if (live === null) {
		err(sprintf('netifd did not answer, so %s was not given a routing table - nothing was written', wan));
		return 0;
	}

	// Keyed by the number written out, because ucode object literals take labels
	// and strings and not integers - `{ 254: true }` does not parse. `rules.uc`
	// keeps the same set the same way, for the same reason.
	// Asked here as well as at every caller, because this is the line that
	// writes the option. `live` is already in hand, so the classification costs
	// nothing, and what it prevents is the one write in this file that can take
	// a subnet off the router.
	let refusal = wanRoleRefusal(wan, live);

	if (refusal) {
		err(sprintf('%s was not given a routing table: %s', wan, refusal));
		return 0;
	}

	let taken = wanTablesTaken(live, snap);

	// And the numbers this batch has already handed out, which are in no file
	// yet: without them two bindings onto two untabled WANs in one call would
	// be given the same table, which is the one state that sends one binding's
	// traffic out of another's port.
	for (let key in keys((type(shared) == 'object') ? shared : {}))
		taken[key] = true;

	for (let one in cfg.directConfigured(snap) ?? []) {
		if (one.table > 0)
			taken[sprintf('%d', one.table)] = true;
	}

	let table = 0;
	for (let candidate = WAN_TABLE_BASE; candidate < WAN_TABLE_BASE + 1000; candidate++) {
		if (taken[sprintf('%d', candidate)] !== true) {
			table = candidate;
			break;
		}
	}

	if (!table)
		return 0;

	if (type(shared) == 'object')
		shared[sprintf('%d', table)] = true;

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
/**
 * Everything `bind` decides before it writes anything, decided once.
 *
 * Split out of `bind` so that a batch can make the same decisions for two
 * hundred bindings against one reading of the router and one reading of the
 * file - and so that the two paths cannot drift into deciding differently,
 * which would be two routers wearing one configuration.
 *
 * `ctx.claimed` and `ctx.targets` are what the batch has already handed out and
 * is not in any file yet: without them every entry in one call would be given
 * the same free priority.
 */
function bindPlan(args, ctx) {
	let snap = ctx.snap;

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
	for (let one in cfg.configured(snap)) {
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

	// Two entries in one batch naming the same section would be one section
	// written twice, and the caller would be told both succeeded.
	if (type(ctx.ids) == 'object') {
		if (ctx.ids[id] === true)
			return { ok: false, reason: sprintf('two entries in this batch are both called %s', id) };

		ctx.ids[id] = true;
	}

	// Before a priority is chosen, before a table is allocated, and before one
	// character is written. `bind_check` says the same thing, but a caller is
	// free not to ask it, and the cost of finding out afterwards is a subnet.
	let wanRefusal = wanRoleRefusal(wan, ctx.live);

	if (wanRefusal)
		return { ok: false, reason: wanRefusal };

	let previous = configuredBinding(id, snap);
	let band = cfg.directBand(snap);

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

		pref = freePref(band, snap, ctx.claimed);

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
			table = allocateWanTable(wan, snap, ctx.taken);

		if (!table) {
			return { ok: false, reason: sprintf('netifd reports no ip4table for %s, so there is no table for this binding to point at. Give that interface `option ip4table` in /etc/config/network - a WAN with no table of its own has no route this binding could send anything down', wan) };
		}
	}

	// Carried forward like every other field, and for the sharper version of the
	// same reason: an edit that says only "this address leaves by wan3 now" must
	// not also switch a binding back on that somebody deliberately switched off.
	// The default is only reached when there is no section yet, where "put it in
	// force" is what creating one means.
	let enabled = type(args.enabled) == 'bool'
		? args.enabled
		: (previous ? previous.enabled : true);

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

	let lan = trim(text(args.lan));
	if (!length(lan) && previous)
		lan = previous.lan;

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

	if (type(ctx.claimed) == 'object')
		ctx.claimed[sprintf('%d', pref)] = true;

	// Two entries following one address is the failure the config reader
	// refuses between sections: the lower-numbered rule decides and the other
	// is never reached, so one of the two does nothing while its row says
	// otherwise. Caught here so the batch says which entry, rather than the
	// read-back saying only that one of them is broken.
	if (type(ctx.targets) == 'object') {
		let key = length(ip) ? ('ip ' + ip) : ('mac ' + mac);

		if (ctx.targets[key] === true)
			return { ok: false, reason: sprintf('another entry in this batch already follows %s', length(ip) ? ip : mac) };

		ctx.targets[key] = true;
	}

	return {
		ok: true,
		spec: {
			id: id,
			ip: ip,
			mac: mac,
			wan: wan,
			lan: lan,
			name: name,
			whenDown: length(whenDown) ? whenDown : 'hold',
			enabled: enabled,
			pref: pref,
			table: table,
			previous: previous
		}
	};
}

/** One binding's fields into the cursor. No commit: the caller owns that. */
function writeBindSection(uci, spec) {
	let id = spec.id;

	uci.set(PACKAGE, id, 'direct');
	uci.set(PACKAGE, id, 'enabled', spec.enabled ? '1' : '0');

	if (length(spec.name) && spec.name != id)
		uci.set(PACKAGE, id, 'name', spec.name);
	else
		uci.delete(PACKAGE, id, 'name');

	// The two are exclusive, so setting one always removes the other. An edit
	// that moved a binding from an address to a MAC would otherwise leave both
	// in the section, which `bm.wanbind.config` refuses - correctly, and for a
	// reason that would have nothing to do with what was asked for.
	if (length(spec.ip)) {
		uci.set(PACKAGE, id, 'ip', spec.ip);
		uci.delete(PACKAGE, id, 'mac');
	}
	else {
		uci.set(PACKAGE, id, 'mac', spec.mac);
		uci.delete(PACKAGE, id, 'ip');
	}

	uci.set(PACKAGE, id, 'wan', spec.wan);

	if (length(spec.lan))
		uci.set(PACKAGE, id, 'lan', spec.lan);
	else
		uci.delete(PACKAGE, id, 'lan');

	uci.set(PACKAGE, id, 'when_down', spec.whenDown);
	uci.set(PACKAGE, id, 'pref', sprintf('%d', spec.pref));
	uci.set(PACKAGE, id, 'table', sprintf('%d', spec.table));

	return true;
}

export function bind(args) {
	let snap = cfg.snapshot();
	let planned = bindPlan(args, { snap: snap });

	if (!planned.ok)
		return { ok: false, reason: planned.reason };

	let spec = planned.spec;
	let id = spec.id;
	let uci = openConfig();

	if (!uci) {
		return { ok: false, reason: 'the binding was not written: /etc/config could not be opened, so nothing in /etc/config/bm_wanbind was changed. Check that the overlay is mounted and writable' };
	}

	writeBindSection(uci, spec);

	if (uci.commit(PACKAGE) === null) {
		return { ok: false, reason: 'the binding would not commit to /etc/config/bm_wanbind; the file may be read-only or the overlay full' };
	}

	// The file has changed, so the read this call arrived with describes a
	// router that no longer exists. Everything below asks what was actually
	// written, which is not the question every line above was asking.
	snap = cfg.snapshot();

	// Read back rather than trusted. Everything above is a field going into a
	// file; whether those fields are a binding this router can act on is one
	// question with one answer, and it is `bm.wanbind.config`'s.
	let written = configuredBinding(id, snap);

	if (!written || written.reason) {
		restore(id, spec.previous);
		return { ok: false, reason: written ? written.reason : 'the binding was written but cannot be read back out of /etc/config/bm_wanbind' };
	}

	// Now, rather than in up to `interval` seconds. Somebody who pressed this
	// is watching the address they just bound, and a rule that appears half a
	// minute later looks exactly like one that was never written.
	//
	// Unless a pass is already due, in which case this write joins it: running
	// one here and another two seconds later is two sweeps of every binding on
	// the router for one edit, and the caller is told when its rule will appear
	// rather than being told it already has.
	let due = 0;

	if (state.soon)
		due = passSoon('bind');
	else
		direct.run({ bus: state.bus, now: time() });

	notice(sprintf('binding %s: %s leaves by %s, pref %d, table %d, %s when it is down',
		id, written.label, written.wan, written.pref, written.table, written.whenDown));

	let answer = bindings(id);
	let row = length(answer.bindings) ? answer.bindings[0] : null;

	if (due)
		return { ok: true, pending: true, due: due, binding: row };

	return { ok: true, binding: row };
};

/**
 * Two hundred bindings, one commit, one pass.
 *
 * What this is for is the module handing over the bindings it used to write
 * itself: five hundred sections that each need reading back, and five hundred
 * separate `bind` calls would be five hundred commits to flash and five hundred
 * full passes over the same band. Two hundred is the batch: one callback, one
 * commit of about forty kilobytes, and one pass at the end of it.
 */
export function bindMany(args) {
	let list = (type(args.bindings) == 'array') ? args.bindings : [];

	if (!length(list))
		return { ok: false, reason: 'send bindings: a list of the same fields bind takes' };

	if (length(list) > BIND_MANY_LIMIT) {
		return {
			ok: false,
			reason: sprintf('bind_many takes at most %d bindings in one call and this one carries %d. Send it in batches: each batch is one commit and one pass',
				BIND_MANY_LIMIT, length(list))
		};
	}

	let snap = cfg.snapshot();
	let live = wans.dump(state.bus);
	let ctx = {
		snap: snap,
		live: live,
		view: (live === null) ? null : layout.classify(live, layout.statements()),
		claimed: {},
		targets: {},
		ids: {},
		taken: {}
	};

	let uci = openConfig();

	if (!uci)
		return { ok: false, reason: 'nothing was written: /etc/config could not be opened' };

	let specs = [];
	let results = [];

	for (let one in list) {
		let entry = (type(one) == 'object') ? one : {};
		let planned = bindPlan(entry, ctx);

		if (!planned.ok) {
			push(results, { id: trim(text(entry.id)), ok: false, pref: 0, table: 0, reason: planned.reason });
			continue;
		}

		writeBindSection(uci, planned.spec);
		push(specs, planned.spec);
		push(results, { id: planned.spec.id, ok: true, pref: planned.spec.pref, table: planned.spec.table, reason: '' });
	}

	if (length(specs) && uci.commit(PACKAGE) === null)
		return { ok: false, reason: 'the bindings would not commit to /etc/config/bm_wanbind; the file may be read-only or the overlay full' };

	// One read of the file for the whole batch, and every section in it put
	// through exactly the checks a section typed in by hand goes through. One
	// that does not survive them is put back the way it was found rather than
	// left half-written.
	snap = cfg.snapshot();

	let written = 0;
	let refused = 0;

	for (let spec in specs) {
		let back = configuredBinding(spec.id, snap);

		for (let row in results) {
			if (row.id != spec.id || !row.ok)
				continue;

			if (!back || back.reason) {
				restore(spec.id, spec.previous);
				row.ok = false;
				row.reason = back ? back.reason : 'the binding was written but cannot be read back out of /etc/config/bm_wanbind';
				refused++;
			}
			else {
				written++;
			}
		}
	}

	for (let row in results) {
		if (!row.ok && !length(row.reason))
			refused++;
	}

	let due = passSoon('bind_many');

	notice(sprintf('%d binding(s) written in one call, %d refused; a pass is due in %ds',
		written, length(results) - written, PASS_COALESCE_MS / 1000));

	return {
		ok: true,
		written: written,
		refused: length(results) - written,
		pending: true,
		due: due,
		results: results
	};
};

/** The same in reverse: a list of names off the router in one commit. */
export function unbindMany(args) {
	let list = (type(args.ids) == 'array') ? args.ids : [];

	if (!length(list))
		return { ok: false, reason: 'send ids: the section names to remove' };

	if (length(list) > BIND_MANY_LIMIT) {
		return {
			ok: false,
			reason: sprintf('unbind_many takes at most %d ids in one call and this one carries %d. Send it in batches: each batch is one commit and one pass',
				BIND_MANY_LIMIT, length(list))
		};
	}

	let snap = cfg.snapshot();
	let uci = openConfig();

	if (!uci)
		return { ok: false, reason: 'nothing was removed: /etc/config could not be opened' };

	let results = [];
	let removed = 0;

	for (let one in list) {
		let id = trim(text(one));

		if (!length(id) || !match(id, SECTION_NAME)) {
			push(results, { id: id, ok: false, reason: 'that is not a section name' });
			continue;
		}

		if (configuredBinding(id, snap) == null) {
			push(results, { id: id, ok: false, reason: sprintf('no binding called %s in /etc/config/bm_wanbind', id) });
			continue;
		}

		uci.delete(PACKAGE, id);

		// Out of the index the DHCP hook reads before the pass rather than
		// after it, exactly as `unbind` does: between the two, a lease event
		// for one of these addresses would still find a binding to move.
		direct.forget(id);

		push(results, { id: id, ok: true, reason: '' });
		removed++;
	}

	if (removed && uci.commit(PACKAGE) === null)
		return { ok: false, reason: 'the sections would not be removed from /etc/config/bm_wanbind' };

	let due = passSoon('unbind_many');

	notice(sprintf('%d binding(s) removed in one call; the pass that takes their rules off is due in %ds',
		removed, PASS_COALESCE_MS / 1000));

	return { ok: true, removed: removed, pending: true, due: due, results: results };
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
	let snap = cfg.snapshot();

	let id = trim(text(args.id));

	if (!length(id))
		return { ok: false, reason: 'name the binding to remove' };

	let one = configuredBinding(id, snap);

	if (!one)
		return { ok: false, reason: sprintf('no binding called %s in /etc/config/bm_wanbind', id) };

	let band = cfg.directBand(snap);
	let stray = (one.pref >= 1 && (one.pref < band.base || one.pref > band.top));

	let uci = openConfig();

	if (!uci) {
		return { ok: false, reason: sprintf('%s was left alone: /etc/config could not be opened, so nothing was removed from /etc/config/bm_wanbind and its rule is still in force', id) };
	}

	uci.delete(PACKAGE, id);

	if (uci.commit(PACKAGE) === null)
		return { ok: false, reason: sprintf('%s would not be removed from /etc/config/bm_wanbind', id) };

	// The file has changed, so the read this call arrived with describes a
	// router that no longer exists. Everything below asks what was actually
	// written, which is not the question every line above was asking.
	snap = cfg.snapshot();

	// Out of the index the DHCP hook reads, before the pass rather than after
	// it: between the two, a lease event for the address this call just unbound
	// would otherwise still find a binding to move.
	direct.forget(id);

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

// ---------------------------------------------------------------------------
// The instances, written from here.
//
// The binding half above writes /etc/config/bm_wanbind and re-reads it to find
// out what it did, and everything below does the same. What is different is
// that an instance already has rules on the router, written at numbers its own
// section carries, so the order of the steps is not a matter of taste: a
// section whose numbers move while its rules are still in place is an instance
// whose next pass finds none of its own work and writes a second complete set.
// See "Taking rules off before the config stops describing them" in
// packages/README.md - this is that rule, carried out rather than described.
//
// Nothing here restarts the daemon. procd does restart it when this file
// changes, which is how a hand edit takes effect and is deliberately not how
// these do: a restart drops every other instance's queue and takes every
// binding's rule off for the second or two it takes, and somebody editing one
// instance has not asked for that.

/** One finding: a level a surface can colour, a field it can point at, a sentence. */
function finding(level, label, detail) {
	return { level: level, label: label, detail: detail };
}

function hasError(findings) {
	for (let one in findings) {
		if (one.level == 'error')
			return true;
	}

	return false;
}

/**
 * What dnsmasq will hand out on this LAN, and where the two numbers live.
 *
 * Read here rather than in `bm.wanbind.prepare` because this is the half that
 * only looks. Raising the ceilings is opt-in, so the ordinary answer to one
 * that is too low is a sentence naming the exact `uci set` lines rather than a
 * write nobody asked for.
 *
 * The section-naming rule - a `config dhcp` with no `option interface` means
 * itself - is `prepare`'s spelling of it, and it is the one thing three
 * separate readers of /etc/config/dhcp have disagreed about before.
 */
function dhcpCeilings(lan) {
	let out = { section: '', global: '', limit: 0, ceiling: 0 };
	let uci = openConfig();

	if (!uci || !length(lan))
		return out;

	try {
		uci.foreach('dhcp', 'dhcp', (one) => {
			let name = text(one['.name']);
			let iface = text(one.interface);

			if ((length(iface) ? iface : name) == lan)
				out.section = name;
		});

		uci.foreach('dhcp', 'dnsmasq', (one) => {
			if (!length(out.global))
				out.global = text(one['.name']);
		});
	}
	catch (e) {
		// No /etc/config/dhcp, or one that will not parse. Both mean this
		// router cannot be asked, which is not the same as an answer of zero -
		// the caller checks for the section names before it says anything.
		return out;
	}

	if (length(out.section))
		out.limit = numberOr(uci.get('dhcp', out.section, 'limit'), 0);

	if (length(out.global))
		out.ceiling = numberOr(uci.get('dhcp', out.global, 'dhcpleasemax'), 0);

	return out;
}

/**
 * How many clients this instance could ever seat.
 *
 * The pool times the per-WAN limit, which is the number every surface shows -
 * except when the limit is 0, which is no limit, and then the pool is not the
 * ceiling at all. What bounds it there is how many addresses the instance's
 * scope holds, because every one of them could arrive and every one of them
 * would be seated on the same line.
 *
 * Counted by multiplication for the reason `wans.uc` gives about its own
 * arithmetic: ucode's shifts are signed 64-bit, and a wide block shifted rather
 * than multiplied comes back negative.
 */
function seatsFor(spec, pool, cidrs) {
	if (spec.clientsPerWan > 0)
		return length(pool) * spec.clientsPerWan;

	let addresses = 0;

	for (let cidr in (type(cidrs) == 'array') ? cidrs : []) {
		let parts = match(cidr, /^[0-9.]+\/([0-9]+)$/);
		if (!parts)
			continue;

		let size = 1;
		for (let i = 0; i < 32 - int(parts[1]); i++)
			size = size * 2;

		addresses = addresses + size;
	}

	return addresses;
}

/** The instance by that name as the file has it, refused ones included. */
function configuredInstance(id, snap) {
	for (let one in cfg.configured(snap)) {
		if (one.id == id)
			return one;
	}

	return null;
}

/**
 * One section exactly as UCI holds it, for putting back after a refused write.
 *
 * Raw options rather than the record `configured()` builds, and that is the
 * whole point of it. That record has every default filled in, so a section
 * restored from it would come back carrying an `option release_grace '120'`
 * this daemon invented on the way past - a section that reads the same today
 * and differently the day a default moves. What a person actually wrote is what
 * goes back, including the options they left out staying out.
 */
function rawSection(id) {
	let uci = openConfig();

	if (!uci)
		return null;

	let all = uci.get_all(PACKAGE, id);
	return (type(all) == 'object') ? all : null;
}

/**
 * Put a section back the way it was, after a write the config reader refused.
 *
 * `restore()` next door does the same job for a binding by naming each field;
 * this does it by copying, for the reason `rawSection` gives. `previous` is
 * null when there was no such section, and then this is simply the delete -
 * which is the correct undo of a create that was refused.
 */
function restoreSection(id, kind, previous) {
	// Nothing to answer here - the caller is already returning the refusal that
	// brought us in - so the only thing this can do about a config it cannot
	// open is say so where somebody will find it afterwards.
	let uci = openConfig();

	if (!uci) {
		err(sprintf('%s %s: /etc/config could not be opened, so the refused write was left exactly as it is; check /etc/config/bm_wanbind by hand', kind, id));
		return;
	}

	let kept = (type(previous) == 'object') ? previous : null;
	let sectionType = kept ? text(kept['.type']) : '';

	uci.delete(PACKAGE, id);

	if (kept && !length(sectionType)) {
		err(sprintf('%s %s: the section that was there had no type, so it could not be put back; check /etc/config/bm_wanbind by hand', kind, id));
	}
	else if (kept) {
		uci.set(PACKAGE, id, sectionType);

		for (let key in kept) {
			// UCI's own bookkeeping - .name, .type, .anonymous, .index - is not
			// an option, and setting one would write it into the file as one.
			if (substr(key, 0, 1) == '.')
				continue;

			uci.set(PACKAGE, id, key, kept[key]);
		}
	}

	if (uci.commit(PACKAGE) === null)
		err(sprintf('%s %s: the refused write could not be undone; check /etc/config/bm_wanbind by hand', kind, id));
}

/**
 * Why this name cannot be an instance, or null.
 *
 * The same three questions `bind` asks about a binding's name, pointed the
 * other way. The third is the one that matters: a `config direct` section of
 * the same name would be turned into an instance by the write below, which is
 * one address's hand-placed binding replaced by a whole LAN's pool - by a call
 * that was editing something else entirely.
 */
function refuseInstanceId(id, snap) {
	if (!length(id))
		return 'name the instance: the section name is its identity here, in the app, and in every log line about it';

	if (!match(id, SECTION_NAME))
		return sprintf('%s is not a name a UCI section can have; letters, digits and underscores, up to 32 of them', id);

	if (id == 'main')
		return 'main is this package\'s own settings section and is not an instance';

	for (let one in cfg.directConfigured(snap)) {
		if (one.id == id) {
			return sprintf('%s is already a one-to-one binding in /etc/config/bm_wanbind - one address nailed to one WAN port by hand. Give the instance another name', id);
		}
	}

	return null;
}



/**
 * The numbers a create is given when the caller named none.
 *
 * `rule_pref_base` follows the instances already on this router when there are
 * any, rather than the setting. Two instances numbering their clients from
 * different bases is legal and works; it is also one more thing for somebody
 * reading `ip -4 rule show` at three in the morning to hold in their head, and
 * nothing is bought by it. The setting is what a router with no instances uses.
 *
 * `catch_all_pref` is the lowest number from the base upwards that no section
 * in the file is using - disabled and refused ones included, because either may
 * have a rule at that priority on the router right now, and a second catch-all
 * written there would have the two rewriting each other on every pass. `slot`
 * is how far above the base it landed, which is the number a surface shows
 * instead of a five-digit priority nobody chose.
 *
 * `catch_all_table` is the setting unless something is actually routing through
 * it. Two instances sharing one is fine and ordinary - it holds nothing but
 * `unreachable default`, and both write the same route into it - so only real
 * traffic is in the way, and that means netifd's tables and the tables the
 * hand-placed bindings are stamped with.
 */
function allocateInstance(id, settings, configured, list) {
	let out = {
		rule_pref_base: settings.rule_pref_base,
		catch_all_pref: 0,
		catch_all_table: 0,
		slot: -1
	};

	let takenPref = {};
	let followed = 0;

	for (let one in configured) {
		if (one.id == id)
			continue;

		takenPref[sprintf('%d', one.catchAllPref)] = true;

		if (!followed && one.rulePrefBase >= 1)
			followed = one.rulePrefBase;
	}

	if (followed)
		out.rule_pref_base = followed;

	for (let candidate = settings.catch_all_pref_base;
		candidate < settings.catch_all_pref_base + CATCH_ALL_SPAN; candidate++) {
		if (takenPref[sprintf('%d', candidate)] !== true) {
			out.catch_all_pref = candidate;
			out.slot = candidate - settings.catch_all_pref_base;
			break;
		}
	}

	// Only what is actually carrying traffic is in the way. Two instances
	// sharing one catch-all table is fine and ordinary - it holds nothing but
	// `unreachable default`, and both write the same route into it - so the
	// other instances' choices are not claimed here.
	let takenTable = routedTables(list);

	for (let candidate = settings.catch_all_table;
		candidate > settings.catch_all_table - 16 && candidate > 0; candidate--) {
		if (takenTable[sprintf('%d', candidate)] !== true) {
			out.catch_all_table = candidate;
			break;
		}
	}

	return out;
}

/**
 * One spec out of what the caller sent and what the section already says.
 *
 * Absent means unchanged, everywhere, and on a create it means "allocate" for
 * the four numbers `allocateInstance` picks and "the main section's default"
 * for the three timers. Both are read through `given()` rather than through
 * truthiness - see there for the three edits that would otherwise silently do
 * nothing.
 *
 * The result is the record shape `bm.wanbind.config` builds, not the snake_case
 * the arguments arrive in, so that it can be handed straight to `wans.pool`,
 * `rules.catchAllCidrs` and `prepare.prepareInstance` without a second
 * translation for any of them to disagree about.
 */
function mergeInstance(id, args, live) {
	let previous = (type(live.previous) == 'object') ? live.previous : null;
	let settings = live.settings;

	let allocated = previous
		? {
			rule_pref_base: previous.rulePrefBase,
			catch_all_pref: previous.catchAllPref,
			catch_all_table: previous.catchAllTable,
			slot: (previous.catchAllPref >= settings.catch_all_pref_base)
				? previous.catchAllPref - settings.catch_all_pref_base : -1
		}
		: allocateInstance(id, settings, live.configured, live.list);

	let spec = {
		id: id,
		name: pickText(args, 'name', text(live.previousName)),
		enabled: pickFlag(args, 'enabled', previous ? previous.enabled : true),
		lan: pickText(args, 'lan', previous ? previous.lan : ''),
		carrier: pickText(args, 'carrier', previous ? previous.carrier : ''),
		sticky: pickFlag(args, 'sticky', previous ? previous.sticky : true),
		remap: pickFlag(args, 'remap', previous ? previous.remap : true),
		clientsPerWan: pickNumber(args, 'clients_per_wan', previous ? previous.clientsPerWan : 1),
		rangeFrom: pickText(args, 'range_from', previous ? previous.rangeFrom : ''),
		rangeTo: pickText(args, 'range_to', previous ? previous.rangeTo : ''),
		rulePrefBase: pickNumber(args, 'rule_pref_base', allocated.rule_pref_base),
		catchAllPref: pickNumber(args, 'catch_all_pref', allocated.catch_all_pref),
		catchAllTable: pickNumber(args, 'catch_all_table', allocated.catch_all_table),
		wanWarnUptime: pickNumber(args, 'wan_warn_uptime',
			previous ? previous.wanWarnUptime : settings.wan_warn_uptime),
		wanErrorGrace: pickNumber(args, 'wan_error_grace',
			previous ? previous.wanErrorGrace : settings.wan_error_grace),
		releaseGrace: pickNumber(args, 'release_grace',
			previous ? previous.releaseGrace : settings.release_grace),

		// Never written into the section. It is an instruction about this call -
		// go and raise somebody else's lease ceilings - rather than a fact about
		// the instance, and a router that had been asked once should not go on
		// raising them every time the instance is edited afterwards.
		raiseDhcpLimits: pickFlag(args, 'raise_dhcp_limits', false)
	};

	if (!length(spec.name))
		spec.name = id;

	return { spec: spec, allocated: allocated };
}

/**
 * Everything wrong with this spec, weighed against this router.
 *
 * Shared by `instance_check` and `instance_set` so that the sentence somebody
 * reads before pressing Save is the same sentence that would have refused the
 * write - a check that agreed and a write that then refused would be two
 * opinions with one name.
 *
 * `error` means nothing is written. `warning` means it will work and somebody
 * should look; `info` is what this call is about to do to the router beyond the
 * section itself. The classifier's own verdict is what decides the first of
 * those for the LAN, and the evidence is quoted rather than summarised: an
 * operator can check "it has a default route" against their own router where
 * they cannot check "it looks like an uplink".
 */
function instanceFindings(spec, previous, live) {
	let out = [];
	let list = (type(live.list) == 'array') ? live.list : null;
	let verdicts = (type(live.view) == 'object' && type(live.view.byName) == 'object')
		? live.view.byName : {};
	let configured = (type(live.configured) == 'array') ? live.configured : [];
	let settings = live.settings;

	if (list === null) {
		push(out, finding('warning', 'router', 'netifd did not answer, so nothing here has been weighed against this router\'s own interfaces - only the numbers were checked. The LAN, the pool and the range are all being taken on trust'));
	}

	// --- which side of the router the LAN is on.
	if (!length(spec.lan)) {
		push(out, finding('error', 'lan', 'no LAN is set, so there is no subnet to bind clients from and nothing for the fail-closed catch-all to cover'));
	}
	else if (list !== null) {
		let verdict = verdicts[spec.lan];

		if (!verdict) {
			push(out, finding('warning', 'lan', sprintf('netifd knows no interface called %s. This wants the name of the section in /etc/config/network - lan, lan_guest - and not the bridge device underneath it, which is what br-lan is', spec.lan)));
		}
		else if (verdict.role == 'uplink') {
			push(out, finding('error', 'lan', sprintf('%s is one of this router\'s ways out, because %s. An instance binds the clients of a LAN; pointed at an uplink it would fence the addresses on the far side of the router and hand them WANs out of a pool they are already in',
				spec.lan, layout.clauses(verdict.uplinkEvidence))));
		}
		else if (verdict.role == 'unclear') {
			push(out, finding('warning', 'lan', sprintf('this router cannot tell which side %s is on. It reads as a LAN because %s, and as a way out because %s. Check it before the catch-all fences a subnet nobody meant',
				spec.lan, layout.clauses(verdict.lanEvidence), layout.clauses(verdict.uplinkEvidence))));
		}
		else if (!length(text(verdict.zone))) {
			push(out, finding('warning', 'lan', sprintf('%s is in no firewall zone, so there is no source zone to forward its clients from and no forwarding will be written. Their rules would select them into a WAN\'s table and fw4 would drop the traffic, with nothing on any surface saying so', spec.lan)));
		}
	}

	// --- the pool.
	let pool = (list !== null) ? wans.pool(list, spec) : [];

	if (!length(spec.carrier)) {
		push(out, finding('error', 'carrier', 'no carrier is set, so there are no WANs to hand out'));
	}
	else if (list !== null && !length(pool)) {
		push(out, finding('warning', 'carrier', sprintf('no interface on this router sits on %s, so the pool is empty and every client would wait in the queue. A carrier is the device the WANs are on - eth1 - and every VLAN of it, eth1.101 and eth1.102, is in the pool with it',
			spec.carrier)));
	}

	let untabled = [];
	for (let one in pool) {
		if (!one.table)
			push(untabled, one.name);
	}

	if (length(untabled)) {
		push(out, finding('info', 'tables', sprintf('%d WAN(s) in this pool have no routing table of their own - %s. Each is given one from %d upwards in /etc/config/network and netifd is reloaded once; a WAN without one is a client whose rule points at an empty table and falls through to the default connection',
			length(untabled), join(', ', untabled), settings.wan_table_base)));
	}

	// --- the addresses this instance would claim.
	let lanCidr = (list !== null && length(spec.lan)) ? wans.lanCidr(list, spec.lan) : null;
	let ranged = length(spec.rangeFrom) && length(spec.rangeTo);

	if (length(spec.rangeFrom) && !length(spec.rangeTo))
		push(out, finding('error', 'range_to', 'range_from is set without range_to, so there is no range. Set both, or neither for the whole LAN'));

	if (length(spec.rangeTo) && !length(spec.rangeFrom))
		push(out, finding('error', 'range_from', 'range_to is set without range_from, so there is no range. Set both, or neither for the whole LAN'));

	if (ranged) {
		let low = wans.ipToInt(spec.rangeFrom);
		let high = wans.ipToInt(spec.rangeTo);

		if (low === null) {
			push(out, finding('error', 'range_from', sprintf('range_from %s is not an IPv4 address', spec.rangeFrom)));
		}
		else if (high === null) {
			push(out, finding('error', 'range_to', sprintf('range_to %s is not an IPv4 address', spec.rangeTo)));
		}
		else if (low > high) {
			push(out, finding('error', 'range_from', sprintf('range_from %s is above range_to %s; a range runs upwards', spec.rangeFrom, spec.rangeTo)));
		}
		else if (!length(wans.rangeCidrs(spec.rangeFrom, spec.rangeTo))) {
			push(out, finding('error', 'range_from', sprintf('range %s-%s cannot be written as a set of address blocks, so there is no catch-all that would cover exactly it - and a fence with a hole in it is worse than none',
				spec.rangeFrom, spec.rangeTo)));
		}
		else if (lanCidr && (!wans.contains(lanCidr, spec.rangeFrom) || !wans.contains(lanCidr, spec.rangeTo))) {
			push(out, finding('error', 'range_from', sprintf('range %s-%s is not inside %s\'s subnet %s, so no lease could ever fall in it and this instance would bind nobody',
				spec.rangeFrom, spec.rangeTo, spec.lan, lanCidr)));
		}
	}

	// What no section can see on its own: the other sections. `bm.wanbind.config`
	// makes the same test when it reads the file back, and refuses the *later*
	// section - which by then is this one, written. Saying it here is what keeps
	// the write from happening at all.
	let mineLow = ranged ? wans.ipToInt(spec.rangeFrom) : 0;
	let mineHigh = ranged ? wans.ipToInt(spec.rangeTo) : 4294967295;

	if (mineLow !== null && mineHigh !== null) {
		for (let one in configured) {
			if (one.id == spec.id || !one.enabled || one.reason || one.lan != spec.lan)
				continue;

			let whole = !(length(one.rangeFrom) && length(one.rangeTo));
			let theirLow = whole ? 0 : wans.ipToInt(one.rangeFrom);
			let theirHigh = whole ? 4294967295 : wans.ipToInt(one.rangeTo);

			if (theirLow === null || theirHigh === null)
				continue;

			if (mineLow > theirHigh || mineHigh < theirLow)
				continue;

			push(out, finding('error', 'range_from', sprintf('instance %s already binds %s on %s, and two instances cannot decide the same address - each would read the other\'s rules as strays and delete them, once a pass, for ever. Give this one a range that does not overlap, or a different LAN',
				one.id, whole ? 'the whole of it' : sprintf('%s-%s', one.rangeFrom, one.rangeTo), spec.lan)));
			break;
		}
	}

	// --- the numbers the rules are written at.
	if (spec.rulePrefBase < 1 || spec.rulePrefBase > MAX_PREF) {
		push(out, finding('error', 'rule_pref_base', sprintf('rule_pref_base %d is not an ip rule priority', spec.rulePrefBase)));
	}
	else if (spec.rulePrefBase <= settings.band.top) {
		push(out, finding('error', 'rule_pref_base', sprintf('rule_pref_base %d is inside the %d-%d band the hand-placed bindings are numbered in. The kernel takes the lowest matching rule, so down there a binding stops outranking this instance - and worse, this instance counts its own client priorities from here upwards, adopts that binding\'s rule as one of its assignments, finds no lease behind it and deletes it on the next pass',
			spec.rulePrefBase, settings.band.base, settings.band.top)));
	}

	if (spec.catchAllPref < 1) {
		push(out, finding('error', 'catch_all_pref', sprintf('every catch-all priority from %d to %d is already taken by an instance in this file, so there is none left to give a new one. Widen the band with `option catch_all_pref_base` on the main section, or delete an instance that is no longer wanted',
			settings.catch_all_pref_base, settings.catch_all_pref_base + CATCH_ALL_SPAN - 1)));
	}
	else if (spec.catchAllPref <= spec.rulePrefBase) {
		push(out, finding('error', 'catch_all_pref', sprintf('rule_pref_base %d is not below catch_all_pref %d, so there is no range to write client rules in',
			spec.rulePrefBase, spec.catchAllPref)));
	}
	else if (spec.catchAllPref - spec.rulePrefBase < MIN_PREF_SPAN) {
		push(out, finding('error', 'catch_all_pref', sprintf('only %d ip rule priorities between rule_pref_base %d and catch_all_pref %d; at least %d are needed, and that number is also the most clients this instance could ever seat',
			spec.catchAllPref - spec.rulePrefBase, spec.rulePrefBase, spec.catchAllPref, MIN_PREF_SPAN)));
	}

	for (let one in configured) {
		if (one.id == spec.id)
			continue;

		if (one.catchAllPref == spec.catchAllPref && spec.catchAllPref >= 1) {
			push(out, finding('error', 'catch_all_pref', sprintf('catch_all_pref %d is already instance %s\'s. The whole priority group is compared as a set, so each of the two would find the other\'s blocks sitting there and replace them, on every pass, for ever',
				spec.catchAllPref, one.id)));
			break;
		}
	}

	if (spec.catchAllTable < 1 || spec.catchAllTable > MAX_TABLE) {
		push(out, finding('error', 'catch_all_table', sprintf('catch_all_table %d is not a routing table number, and there was none free near %d to give this instance instead',
			spec.catchAllTable, settings.catch_all_table)));
	}
	else if (spec.catchAllTable == 254 || spec.catchAllTable == 255) {
		push(out, finding('error', 'catch_all_table', sprintf('catch_all_table %d is the router\'s own main or local table; putting an `unreachable default` in it would take the router off the network',
			spec.catchAllTable)));
	}
	else {
		for (let one in pool) {
			if (one.table == spec.catchAllTable) {
				push(out, finding('error', 'catch_all_table', sprintf('catch_all_table %d is %s\'s own routing table, and the catch-all writes `unreachable default` into it. Every client this instance seated on %s would be blocked while every row read bound',
					spec.catchAllTable, one.name, one.name)));
				break;
			}
		}
	}

	if (spec.clientsPerWan < 0 || spec.clientsPerWan > MAX_CLIENTS_PER_WAN) {
		push(out, finding('error', 'clients_per_wan', sprintf('clients_per_wan %d is not a number of clients; 1 gives each WAN to one device, a larger number is how many may share one, and 0 means no limit',
			spec.clientsPerWan)));
	}

	for (let one in [ [ 'wan_warn_uptime', spec.wanWarnUptime ], [ 'wan_error_grace', spec.wanErrorGrace ], [ 'release_grace', spec.releaseGrace ] ]) {
		if (one[1] < 0 || one[1] > MAX_GRACE) {
			push(out, finding('error', one[0], sprintf('%s %d is not a number of seconds; 0 to %d',
				one[0], one[1], MAX_GRACE)));
		}
	}

	// --- what dnsmasq will actually hand out, which bounds all of the above.
	let cidrs = ruleset.catchAllCidrs(spec, lanCidr ? lanCidr : '');
	let seats = seatsFor(spec, pool, cidrs);
	let dhcp = dhcpCeilings(spec.lan);

	if (seats > 0 && length(dhcp.section) && length(dhcp.global)) {
		// Absent means dnsmasq's own default of 150 rather than no limit, which
		// is the mistake worth avoiding here: a router that has never been
		// touched reads as unlimited and is the one most likely to run out.
		let limit = (dhcp.limit > 0) ? dhcp.limit : 150;
		let ceiling = (dhcp.ceiling > 0) ? dhcp.ceiling : 150;

		if (limit < seats || ceiling < seats) {
			push(out, finding(spec.raiseDhcpLimits ? 'info' : 'warning', 'dhcp', sprintf('this pool could seat %d clients and dnsmasq stops at %d on %s, %d on the router. It does not say so when it stops - it simply answers no more leases, and a client with no lease is a client with no rule%s:  uci set dhcp.%s.limit=%d ; uci set dhcp.%s.dhcpleasemax=%d ; uci commit dhcp ; /etc/init.d/dnsmasq restart',
				seats, limit, spec.lan, ceiling,
				spec.raiseDhcpLimits ? '. This call raises both, which is these two lines' : '. Raise both',
				dhcp.section, seats, dhcp.global, seats)));
		}
	}

	// --- and what this call is about to do beyond the section.
	if (previous && previous.enabled && !spec.enabled) {
		push(out, finding('info', 'enabled', sprintf('%s is being switched off, so its rules come off the router first - the catch-all with them. Its clients go back to whatever routing this router would have given them',
			spec.id)));
	}

	return out;
}

/**
 * What the rules already on the router were written against and is now moving.
 *
 * Six fields, and every one of them decides either where a rule sits or which
 * addresses count as this instance's. Change one while the rules are in place
 * and the next pass looks for its own work at the new numbers, finds none, and
 * writes a second complete set beside the first - so a move here is exactly
 * what makes `instance_set` flush before it writes rather than after.
 *
 * `enabled` going false is in the list for the same reason turned around: a
 * section that is switched off is one the daemon never reads again, and its
 * rules would stay on the router with nothing left that knew whose they were.
 */
function instanceMoves(spec, previous) {
	let out = [];

	if (!previous)
		return out;

	let pairs = [
		[ 'lan', previous.lan, spec.lan ],
		[ 'rule_pref_base', sprintf('%d', previous.rulePrefBase), sprintf('%d', spec.rulePrefBase) ],
		[ 'catch_all_pref', sprintf('%d', previous.catchAllPref), sprintf('%d', spec.catchAllPref) ],
		[ 'catch_all_table', sprintf('%d', previous.catchAllTable), sprintf('%d', spec.catchAllTable) ],
		[ 'range_from', previous.rangeFrom, spec.rangeFrom ],
		[ 'range_to', previous.rangeTo, spec.rangeTo ]
	];

	for (let one in pairs) {
		if (one[1] != one[2])
			push(out, { field: one[0], from: one[1], to: one[2] });
	}

	if (previous.enabled && !spec.enabled)
		push(out, { field: 'enabled', from: '1', to: '0' });

	return out;
}

/**
 * What the last pass decided, held up against what the kernel is holding.
 *
 * Reads and answers; writes nothing, deliberately. A pass that finds a rule
 * missing writes it again, which is the right thing for a pass and the wrong
 * thing for a question - somebody asking what the difference *is* has to be
 * able to ask twice and get the same answer both times.
 *
 * `missing` is a rule this daemon believes it wrote and the kernel is not
 * holding. That is not hypothetical: a Bored Manager module older than 3.4.0
 * sweeps the whole binding band every two seconds while it is connected and
 * deletes every rule no record of its own describes, which on a router this
 * daemon is binding is all of them.
 *
 * `extra` is the other direction - a rule sitting inside one of this daemon's
 * own claims that nothing here wants. Anything outside every claim appears in
 * neither list and is never counted: it belongs to another tool or to whoever
 * administers the router, and this method has no opinion about it.
 */
function verifyRules(id, snap) {
	let present = netlink.rules();

	if (present === null) {
		return {
			ok: false,
			read: false,
			checked: 0,
			present: 0,
			missing: [],
			extra: [],
			reason: 'the router\'s ip rules could not be read, so there was nothing to compare against'
		};
	}

	let held = {};
	for (let one in present)
		held[sprintf('%d|%s|%d', one.pref, one.cidr, one.table)] = true;

	let wanted = {};
	let order = [];

	let want = function(pref, cidr, table, who, source) {
		let key = sprintf('%d|%s|%d', pref, cidr, table);

		if (key in wanted)
			return;

		wanted[key] = { pref: pref, cidr: cidr, table: table, id: who, source: source };
		push(order, key);
	};

	for (let st in each()) {
		if (length(id) && st.instance.id != id)
			continue;

		for (let mac in st.devices) {
			let device = st.devices[mac];

			if (!device.wan || type(device.pref) != 'int' || type(device.table) != 'int')
				continue;

			if (!length(text(device.ip)))
				continue;

			want(device.pref, device.ip + '/32', device.table, mac, st.instance.id);
		}

		// The blocks the fail-closed catch-all is written as, which is the one
		// rule group whose absence is not one client going astray but a whole
		// LAN leaking out of the router's default connection.
		for (let cidr in st.scope)
			want(st.instance.catchAllPref, cidr, st.instance.catchAllTable, 'catch-all', st.instance.id);
	}

	// The hand-placed bindings belong to no instance, so a call that named one
	// leaves them out - the same rule `reconcile` follows for the same reason.
	if (!length(id)) {
		for (let row in direct.bindings()) {
			if (!(row.state in [ 'bound', 'held', 'fallback' ]))
				continue;

			if (row.pref < 1 || row.table < 1 || !length(text(row.ip)))
				continue;

			want(row.pref, row.ip + '/32', row.table, row.id, 'manual');
		}
	}

	let missing = [];
	let found = 0;

	for (let key in order) {
		if (held[key] === true)
			found++;
		else
			push(missing, wanted[key]);
	}

	let extra = [];
	let counted = {};

	let stray = function(one, source) {
		let key = sprintf('%d|%s|%d', one.pref, one.cidr, one.table);

		if (key in wanted || counted[key] === true)
			return;

		counted[key] = true;
		push(extra, { pref: one.pref, cidr: one.cidr, table: one.table, id: '', source: source });
	};

	for (let st in each()) {
		if (length(id) && st.instance.id != id)
			continue;

		for (let one in ruleset.ownedClientRules(present, st.instance, st.lanCidr))
			stray(one, st.instance.id);

		for (let one in present) {
			if (one.pref == st.instance.catchAllPref)
				stray(one, st.instance.id);
		}
	}

	if (!length(id)) {
		let band = cfg.directBand(snap);
		let stamped = {};

		for (let one in cfg.directConfigured(snap)) {
			if (one.pref >= 1)
				stamped[sprintf('%d', one.pref)] = true;
		}

		for (let one in ruleset.directOwned(present, band.base, band.top, stamped))
			stray(one, 'manual');
	}

	return {
		ok: (!length(missing) && !length(extra)),
		read: true,
		checked: length(order),
		present: found,
		missing: missing,
		extra: extra,
		reason: null
	};
}

/**
 * What would happen, without anything happening.
 *
 * The same merge, the same findings and the same allocation `instance_set`
 * runs, stopped one step before the write. That is the whole contract: a check
 * that said yes and a write that then refused would be two opinions wearing one
 * name, and the surfaces are built to put Save behind this answer.
 */
export function instanceCheck(args) {
	let snap = cfg.snapshot();

	let id = trim(text(args.id));
	let refusal = refuseInstanceId(id, snap);

	if (refusal) {
		return {
			ok: false,
			reason: refusal,
			findings: [ finding('error', 'id', refusal) ],
			allocated: null,
			effective: null,
			scope: null,
			pool: [],
			moves: []
		};
	}

	let settings = settingsRead(snap);
	let configured = cfg.configured(snap);
	let list = wans.dump(state.bus);

	// One reading of netifd for the whole answer. `layout.read()` would dump it
	// a second time, and two dumps a few milliseconds apart are two different
	// routers as far as anything comparing them is concerned.
	let view = (list === null)
		? { byName: {}, list: [], stated: false }
		: layout.classify(list, layout.statements());

	let previous = configuredInstance(id, snap);
	let raw = previous ? rawSection(id) : null;

	let merged = mergeInstance(id, args, {
		previous: previous,
		previousName: raw ? text(raw.name) : '',
		settings: settings,
		configured: configured,
		list: list
	});

	let findings = instanceFindings(merged.spec, previous, {
		list: list,
		view: view,
		settings: settings,
		configured: configured
	});

	let lanCidr = (list !== null && length(merged.spec.lan)) ? wans.lanCidr(list, merged.spec.lan) : null;
	let names = [];

	for (let one in (list !== null) ? wans.pool(list, merged.spec) : [])
		push(names, one.name);

	return {
		ok: !hasError(findings),
		findings: findings,
		allocated: merged.allocated,
		effective: merged.spec,

		// Null rather than an empty pair when the LAN has no address yet. The
		// blocks are what the catch-all is written as, and "we do not know"
		// must not be readable as "it fences nothing".
		scope: lanCidr ? { lanCidr: lanCidr, cidrs: ruleset.catchAllCidrs(merged.spec, lanCidr) } : null,
		pool: names,

		// What the rules on the router were written against and would move, so
		// that a surface can say "this takes its rules off first" before
		// somebody presses the button rather than afterwards.
		moves: instanceMoves(merged.spec, previous)
	};
};

/**
 * Create an instance, or change one that is there.
 *
 * One method for both, exactly as `bind` is: the router is the source of truth,
 * the caller says what the section should contain, and this makes the file say
 * it. A module that lost track of what it had already written converges rather
 * than creating a second instance for the same LAN.
 *
 * The order below is the whole of the method and none of it is arbitrary.
 *
 *   1. the name, before anything is read - a name that cannot be a section, or
 *      is already a binding, is refused before this touches the file
 *   2. the merge, absent meaning unchanged and, on a create, allocated
 *   3. the findings; one error and nothing at all is written
 *   4. the flush, if anything the rules were written against is moving. This is
 *      before the write and not after it, because after it the section no
 *      longer describes the rules that are on the router
 *   5. the write, then the read-back through the daemon's own reader. A section
 *      it refuses is put back exactly as it was
 *   6. the running process, rebuilt for this one id without a restart
 *   7. the two things on the router a rule is no use without
 *   8. a pass now, and then what the kernel is actually holding
 */
export function instanceSet(args) {
	let snap = cfg.snapshot();

	let id = trim(text(args.id));
	let refusal = refuseInstanceId(id, snap);

	if (refusal) {
		return {
			ok: false,
			reason: refusal,
			findings: [ finding('error', 'id', refusal) ],
			instance: null,
			flushed: 0,
			prepared: null,
			pass: null,
			verified: 0,
			unverified: 0
		};
	}

	let settings = settingsRead(snap);
	let configured = cfg.configured(snap);
	let list = wans.dump(state.bus);
	let view = (list === null)
		? { byName: {}, list: [], stated: false }
		: layout.classify(list, layout.statements());

	let previous = configuredInstance(id, snap);
	let raw = previous ? rawSection(id) : null;

	let merged = mergeInstance(id, args, {
		previous: previous,
		previousName: raw ? text(raw.name) : '',
		settings: settings,
		configured: configured,
		list: list
	});

	let spec = merged.spec;

	let findings = instanceFindings(spec, previous, {
		list: list,
		view: view,
		settings: settings,
		configured: configured
	});

	if (hasError(findings)) {
		return {
			ok: false,
			reason: 'the spec did not pass validation',
			findings: findings,
			instance: previous,
			flushed: 0,
			prepared: null,
			pass: null,
			verified: 0,
			unverified: 0
		};
	}

	// --- 4. Take the rules off before the file stops describing them.
	let moves = instanceMoves(spec, previous);
	let flushed = 0;

	if (previous && length(moves) && previous.usable) {
		let held = netlink.rules();

		// A dump that failed is no information about anything, and writing the
		// new numbers on top of rules that are still there would leave a second
		// complete set on the router with nothing left that knew whose the
		// first one was. Refusing the whole call is the only honest answer.
		if (held === null) {
			return {
				ok: false,
				reason: sprintf('%s was left exactly as it is: the router\'s ip rules could not be read, so the rules written against its old numbers could not be taken off first. Try again, or run `bmwan flush --instance %s` and then make the change',
					id, id),
				findings: findings,
				instance: previous,
				flushed: 0,
				prepared: null,
				pass: null,
				verified: 0,
				unverified: 0
			};
		}

		// By the numbers the *previous* section carries, which are what the
		// rules on the router were written against. That is the entire reason
		// this happens here and not after the write.
		flushed = ruleset.flush(previous, held, (list !== null) ? wans.lanCidr(list, previous.lan) : null);

		let was = state.instances[id];
		if (was)
			was.ready = false;
	}
	else if (previous && length(moves)) {
		// A section the reader already refuses is one this daemon never ran, so
		// there is nothing of its to flush - and flushing by a priority range
		// that does not add up is how somebody else's rules come off. Said out
		// loud rather than done quietly, because it may have had rules from
		// before it was broken.
		notice(sprintf('instance %s: its numbers were already refused (%s), so nothing was taken off the router before this edit. If it had rules from before it broke, `ip -4 rule show` will still show them',
			id, previous.reason));
	}

	// --- 5. The section.
	let uci = openConfig();

	if (!uci) {
		return {
			ok: false,
			reason: 'nothing was written: /etc/config could not be opened, so /etc/config/bm_wanbind is exactly as it was. Check that the overlay is mounted and writable',
			findings: findings,
			instance: previous,
			flushed: flushed,
			prepared: null,
			pass: null,
			verified: 0,
			unverified: 0
		};
	}

	uci.set(PACKAGE, id, 'instance');
	uci.set(PACKAGE, id, 'enabled', spec.enabled ? '1' : '0');

	// The label every surface shows. `bm.wanbind.config` has no use for it - an
	// instance is known by its section name everywhere this daemon speaks - so
	// it is the one field here that is written and never read back, and the one
	// with no refusal attached to it.
	if (length(spec.name) && spec.name != id)
		uci.set(PACKAGE, id, 'name', spec.name);
	else
		uci.delete(PACKAGE, id, 'name');

	uci.set(PACKAGE, id, 'lan', spec.lan);
	uci.set(PACKAGE, id, 'carrier', spec.carrier);
	uci.set(PACKAGE, id, 'sticky', spec.sticky ? '1' : '0');
	uci.set(PACKAGE, id, 'remap', spec.remap ? '1' : '0');
	uci.set(PACKAGE, id, 'clients_per_wan', sprintf('%d', spec.clientsPerWan));

	// Both or neither, always. One end without the other reads as a whole-LAN
	// instance and binds every address the operator meant to leave alone; it is
	// refused above, but an edit that cleared only one of them would write
	// exactly that section, so the two are set and removed as a pair.
	if (length(spec.rangeFrom) && length(spec.rangeTo)) {
		uci.set(PACKAGE, id, 'range_from', spec.rangeFrom);
		uci.set(PACKAGE, id, 'range_to', spec.rangeTo);
	}
	else {
		uci.delete(PACKAGE, id, 'range_from');
		uci.delete(PACKAGE, id, 'range_to');
	}

	// Stamped, every one of them, including the three that are only ever the
	// main section's defaults today. That is what makes those defaults safe to
	// change on a running router: an instance carries its own copy and reads
	// that copy for ever, so moving a default decides what the next instance
	// gets and says nothing about this one.
	uci.set(PACKAGE, id, 'rule_pref_base', sprintf('%d', spec.rulePrefBase));
	uci.set(PACKAGE, id, 'catch_all_pref', sprintf('%d', spec.catchAllPref));
	uci.set(PACKAGE, id, 'catch_all_table', sprintf('%d', spec.catchAllTable));
	uci.set(PACKAGE, id, 'wan_warn_uptime', sprintf('%d', spec.wanWarnUptime));
	uci.set(PACKAGE, id, 'wan_error_grace', sprintf('%d', spec.wanErrorGrace));
	uci.set(PACKAGE, id, 'release_grace', sprintf('%d', spec.releaseGrace));

	if (uci.commit(PACKAGE) === null) {
		restoreSection(id, 'instance', raw);
		return {
			ok: false,
			reason: 'the instance would not commit to /etc/config/bm_wanbind; the file may be read-only or the overlay full',
			findings: findings,
			instance: previous,
			flushed: flushed,
			prepared: null,
			pass: null,
			verified: 0,
			unverified: 0
		};
	}

	// The file has changed, so the read this call arrived with describes a
	// router that no longer exists. Everything below asks what was actually
	// written, which is not the question every line above was asking.
	snap = cfg.snapshot();

	// Read back rather than trusted. Everything above is a field going into a
	// file; whether those fields are an instance this router can act on is one
	// question with one answer, and it is `bm.wanbind.config`'s.
	let written = configuredInstance(id, snap);

	if (!written || written.reason) {
		restoreSection(id, 'instance', raw);
		return {
			ok: false,
			reason: written ? written.reason : 'the instance was written but cannot be read back out of /etc/config/bm_wanbind',
			findings: findings,
			instance: previous,
			flushed: flushed,
			prepared: null,
			pass: null,
			verified: 0,
			unverified: 0
		};
	}

	// --- 6. The running process, without restarting it.
	//
	// The state for this one id is thrown away and rebuilt, and the order is
	// re-read from the file so that a new instance takes its place in it. What
	// survives is what `engine.create` reads back out of /etc/bm/state - the
	// sticky choices and the holds - because those are the two decisions no
	// rule on the router records.
	delete state.instances[id];

	if (written.usable && written.enabled)
		state.instances[id] = engine.create(written);

	state.order = [];
	for (let one in cfg.configured(snap)) {
		if (state.instances[one.id])
			push(state.order, one.id);
	}

	// --- 7. The two things on the router a rule is no use without.
	let prepared = { tables: [], forwardings: 0, catchAll: [], dhcp: null };
	let pool = (list !== null) ? wans.pool(list, written) : [];

	if (written.enabled) {
		// `taken` seeded rather than left empty. `prepare` numbers a WAN with no
		// table of its own from wan_table_base upwards and adds each number it
		// hands out, but it has no way of knowing what the rest of the router is
		// already routing through - and the first free-looking number on an
		// unseeded run is the base itself, which is very often already another
		// WAN's.
		let done = prepare.prepareInstance(written, pool, view,
			{ bus: state.bus, defer: false, taken: wanTablesTaken(list, snap) });

		// Logged rather than returned as a failure. The section is written and
		// correct; what could not be done is a firewall forwarding or a routing
		// table, and the next pass tries again - where a refusal here would
		// leave the caller believing nothing had been written at all.
		if (!done.ok)
			err(sprintf('instance %s: %s', id, done.reason));

		if (spec.raiseDhcpLimits) {
			let lanCidr = (list !== null) ? wans.lanCidr(list, written.lan) : null;
			let wanted = seatsFor(written, pool, ruleset.catchAllCidrs(written, lanCidr ? lanCidr : ''));

			prepared.dhcp = prepare.raiseDhcpLimits(written.lan, wanted, { bus: state.bus });

			if (!prepared.dhcp.ok)
				err(sprintf('instance %s: %s', id, prepared.dhcp.reason));
		}
	}

	// A fresh cursor: `prepare` committed /etc/config/network through one of its
	// own, and the one opened above has its idea of that package from before.
	let after = openConfig();

	for (let one in pool) {
		push(prepared.tables, {
			wan: one.name,
			table: after ? numberOr(after.get('network', one.name, 'ip4table'), 0) : 0
		});
	}

	prepared.forwardings = length(prepare.instanceForwardings()[id] ?? []);

	// --- 8. A pass now, rather than in up to `interval` seconds. Somebody who
	// pressed this is watching the clients they just scoped, and a rule that
	// appears half a minute later looks exactly like one that was never written.
	let passes = pass();
	let report = null;

	if (state.main.enabled) {
		// `pass()` reports in `state.order` order, and a pass that failed
		// carries no instance name to match on - so the position in the list is
		// what identifies this one's row.
		for (let i = 0; i < length(state.order); i++) {
			if (state.order[i] == id && i < length(passes))
				report = passes[i];
		}
	}

	let running = state.instances[id];
	prepared.catchAll = (running && length(running.scope))
		? running.scope
		: ruleset.catchAllCidrs(written, (list !== null) ? (wans.lanCidr(list, written.lan) ?? '') : '');

	// And what the kernel is actually holding, which is a different question
	// from what the pass decided. A write the socket accepted and something else
	// removed a moment later looks, from inside a pass, exactly like one that
	// landed.
	let checked = verifyRules(id);

	notice(sprintf('instance %s: %s on %s over %s, %d client(s) per WAN, %s',
		id, written.enabled ? 'running' : 'stopped', written.lan, written.carrier,
		written.clientsPerWan,
		(length(written.rangeFrom) && length(written.rangeTo))
			? sprintf('%s-%s', written.rangeFrom, written.rangeTo) : 'the whole LAN'));

	return {
		ok: true,
		reason: null,
		findings: findings,
		instance: written,
		flushed: flushed,
		prepared: prepared,
		pass: report,
		read: checked.read,
		verified: checked.read ? checked.present : 0,
		unverified: checked.read ? length(checked.missing) : 0
	};
};

/**
 * Take an instance off the router: its rules, its firewall path, its section
 * and what it remembered.
 *
 * The order is the opposite of `unbind` next door, and the difference is worth
 * being explicit about because getting it wrong strands rules. A binding's rule
 * is found by sweeping a band the daemon owns outright, so deleting the section
 * first is how the rule is described as unwanted. An instance's rules are found
 * by the priority range written in its own section - delete that first and the
 * only description of what to remove has gone with it.
 *
 * What could not be finished is reported rather than papered over, in the same
 * shape `unbind` uses: `ok` stays true because the instance really is gone, and
 * `reason` is the sentence saying what is still on the router.
 */
export function instanceDelete(args) {
	let snap = cfg.snapshot();

	let id = trim(text(args.id));

	if (!length(id))
		return { ok: false, id: '', removed: 0, forwardings: 0, reason: 'name the instance to remove' };

	let one = configuredInstance(id, snap);

	if (!one) {
		return {
			ok: false,
			id: id,
			removed: 0,
			forwardings: 0,
			reason: sprintf('no instance called %s in /etc/config/bm_wanbind', id)
		};
	}

	let notes = [];
	let removed = 0;

	if (one.usable) {
		let held = netlink.rules();

		if (held === null) {
			return {
				ok: false,
				id: id,
				removed: 0,
				forwardings: 0,
				reason: sprintf('%s was left alone: the router\'s ip rules could not be read, so nothing could be taken off - and deleting the section first would lose the only description of which rules were its. Try again, or run `bmwan flush --instance %s` first',
					id, id)
			};
		}

		let list = wans.dump(state.bus);
		removed = ruleset.flush(one, held, (list !== null) ? wans.lanCidr(list, one.lan) : null);
	}
	else {
		push(notes, sprintf('its numbers were refused (%s), so no rule was removed by them - deleting by a priority range that does not add up is how somebody else\'s rules come off. Check `ip -4 rule show` for anything it left from before it broke',
			one.reason));
	}

	let forwardings = prepare.withdrawInstance(id, {});

	let uci = openConfig();

	if (!uci) {
		return {
			ok: false,
			id: id,
			removed: removed,
			forwardings: forwardings,
			reason: sprintf('%s had its rules taken off, but /etc/config could not be opened so the section is still in /etc/config/bm_wanbind - and the next pass will write every one of those rules again. Delete it by hand, or try again', id)
		};
	}

	uci.delete(PACKAGE, id);

	if (uci.commit(PACKAGE) === null) {
		return {
			ok: false,
			id: id,
			removed: removed,
			forwardings: forwardings,
			reason: sprintf('%s had its rules taken off and its section would not be removed from /etc/config/bm_wanbind, so the next pass will write them again', id)
		};
	}

	// The file has changed, so the read this call arrived with describes a
	// router that no longer exists. Everything below asks what was actually
	// written, which is not the question every line above was asking.
	snap = cfg.snapshot();

	delete state.instances[id];

	state.order = [];
	for (let row in cfg.configured(snap)) {
		if (state.instances[row.id])
			push(state.order, row.id);
	}

	// The one thing here that is not in the config and not on the wire: the
	// sticky map and the holds, which is the only state on this router that no
	// rule records. Left behind, it is a file naming an instance that no longer
	// exists - and, if the name is ever reused, one that would hand the new
	// instance's clients the WAN choices of the old one's.
	let saved = engine.stateName(one);

	if (readState(saved) !== null && !removeState(saved)) {
		push(notes, sprintf('what it remembered is still in /etc/bm/state/%s.json; an instance created with this name again would start from those sticky choices and those holds', saved));
	}

	notice(sprintf('instance %s removed, %d rule(s) and %d firewall forwarding(s) with it', id, removed, forwardings));

	return {
		ok: true,
		id: id,
		removed: removed,
		forwardings: forwardings,
		reason: length(notes) ? join('; ', notes) : null
	};
};

// ---------------------------------------------------------------------------
// The settings, the router's interfaces, and the two questions that only read.

/**
 * Change `config wanbind 'main'`.
 *
 * Absent means unchanged, as everywhere else here. Two of the ten do something
 * beyond being written:
 *
 * `interval` re-arms the timer through `schedule()`, so a router told to
 * reconcile every ten seconds does not wait out the old interval first.
 *
 * `enabled` going false takes every instance's rules off *before* the section
 * says so, and that ordering is the whole of why this method exists rather than
 * a `uci set`. The daemon decides what to look at by reading its config, so a
 * switched-off pool is one it never reads again - and its rules would stay on
 * the router with nothing left that knew whose they were, the catch-all
 * included, which is a LAN pointed at an unreachable table by nobody. The
 * hand-placed bindings are untouched: `enabled` is the instance half's switch
 * and says nothing about them.
 *
 * A band that is not usable afterwards is put back and refused. It is the one
 * setting whose being wrong is silent - every future `bind` is refused by a
 * sentence about a number nobody remembers changing.
 */
export function settingsSet(args) {
	let snap = cfg.snapshot();

	let previous = settingsRead(snap);

	let want = {
		enabled: pickFlag(args, 'enabled', previous.enabled),
		interval: pickNumber(args, 'interval', previous.interval),
		direct_pref_base: pickNumber(args, 'direct_pref_base', previous.direct_pref_base),
		rule_pref_base: pickNumber(args, 'rule_pref_base', previous.rule_pref_base),
		catch_all_pref_base: pickNumber(args, 'catch_all_pref_base', previous.catch_all_pref_base),
		catch_all_table: pickNumber(args, 'catch_all_table', previous.catch_all_table),
		wan_table_base: pickNumber(args, 'wan_table_base', previous.wan_table_base),
		wan_warn_uptime: pickNumber(args, 'wan_warn_uptime', previous.wan_warn_uptime),
		wan_error_grace: pickNumber(args, 'wan_error_grace', previous.wan_error_grace),
		release_grace: pickNumber(args, 'release_grace', previous.release_grace),
		lan_local: pickFlag(args, 'lan_local', previous.lan_local),
		local_pref_base: pickNumber(args, 'local_pref_base', previous.local_pref_base)
	};

	let refuse = function(reason) {
		return { ok: false, reason: reason, settings: previous };
	};

	if (want.interval < MIN_INTERVAL || want.interval > MAX_INTERVAL) {
		return refuse(sprintf('interval %d is outside %d-%d. Below %d a full pass on a large LAN would overlap the one before it, and nothing here changes that fast',
			want.interval, MIN_INTERVAL, MAX_INTERVAL, MIN_INTERVAL));
	}

	if (want.direct_pref_base < 1 || want.direct_pref_base + previous.band.span - 1 > MAX_PREF) {
		return refuse(sprintf('direct_pref_base %d cannot hold the %d ip rule priorities a binding band is',
			want.direct_pref_base, previous.band.span));
	}

	if (want.rule_pref_base < 1 || want.rule_pref_base > MAX_PREF)
		return refuse(sprintf('rule_pref_base %d is not an ip rule priority', want.rule_pref_base));

	if (want.direct_pref_base + previous.band.span > want.rule_pref_base) {
		return refuse(sprintf('direct_pref_base %d opens a band of %d that reaches %d, which is not below rule_pref_base %d. A binding numbered up there is adopted by an instance as one of its own client assignments, found to have no lease behind it, and deleted on the next pass',
			want.direct_pref_base, previous.band.span,
			want.direct_pref_base + previous.band.span - 1, want.rule_pref_base));
	}

	if (want.catch_all_pref_base - want.rule_pref_base < MIN_PREF_SPAN) {
		return refuse(sprintf('only %d ip rule priorities between rule_pref_base %d and catch_all_pref_base %d; at least %d are needed, and that number is also the most clients one instance could seat',
			want.catch_all_pref_base - want.rule_pref_base, want.rule_pref_base,
			want.catch_all_pref_base, MIN_PREF_SPAN));
	}

	// The escapes have to be read before every binding and before every
	// assignment, which is what being below both bases means. Refused rather
	// than corrected: a base that reaches into the binding band is the same as
	// having no escapes at all, silently, on a router where every page reads
	// bound.
	if (want.local_pref_base < 1 || want.local_pref_base + previous.local.span - 1 > MAX_PREF) {
		return refuse(sprintf('local_pref_base %d cannot hold the %d ip rule priorities the LAN-local band is',
			want.local_pref_base, previous.local.span));
	}

	if (want.local_pref_base + previous.local.span > want.direct_pref_base) {
		return refuse(sprintf('local_pref_base %d opens a band of %d that reaches %d, which is not below direct_pref_base %d. The LAN-local rules have to be read before every binding, or a bound address is sent out of its WAN addressed to a network on the other side of this router',
			want.local_pref_base, previous.local.span,
			want.local_pref_base + previous.local.span - 1, want.direct_pref_base));
	}

	if (want.catch_all_table < 1 || want.catch_all_table > MAX_TABLE)
		return refuse(sprintf('catch_all_table %d is not a routing table number', want.catch_all_table));

	if (want.catch_all_table == 254 || want.catch_all_table == 255) {
		return refuse(sprintf('catch_all_table %d is the router\'s own main or local table; putting an `unreachable default` in it would take the router off the network',
			want.catch_all_table));
	}

	if (want.wan_table_base < 1 || want.wan_table_base + 999 > MAX_TABLE) {
		return refuse(sprintf('wan_table_base %d cannot hold the thousand routing table numbers a WAN is given one out of; the highest is %d',
			want.wan_table_base, MAX_TABLE));
	}

	for (let one in [ [ 'wan_warn_uptime', want.wan_warn_uptime ], [ 'wan_error_grace', want.wan_error_grace ], [ 'release_grace', want.release_grace ] ]) {
		if (one[1] < 0 || one[1] > MAX_GRACE)
			return refuse(sprintf('%s %d is not a number of seconds; 0 to %d', one[0], one[1], MAX_GRACE));
	}

	// The rules come off before the config stops describing them. Every usable
	// instance, one at a time and by its own numbers, and the whole call is
	// refused if any of them cannot be done - which is what packages/README.md
	// says Stop does, said here in the one place that can do it.
	if (previous.enabled && !want.enabled) {
		for (let one in cfg.configured(snap)) {
			if (!one.usable)
				continue;

			let out = flush({ instance: one.id });

			if (!out.ok) {
				return refuse(sprintf('the pools were left switched on: %s\'s rules could not be taken off (%s), and switching off while they are still on the router leaves a LAN pointed at an unreachable table with nothing left maintaining it. Try again, or run `bmwan flush --instance %s` first',
					one.id, out.reason, one.id));
			}
		}
	}

	let raw = rawSection('main');
	let uci = openConfig();

	if (!uci) {
		return refuse('nothing was written: /etc/config could not be opened, so /etc/config/bm_wanbind is exactly as it was. Check that the overlay is mounted and writable');
	}

	uci.set(PACKAGE, 'main', 'wanbind');
	uci.set(PACKAGE, 'main', 'enabled', want.enabled ? '1' : '0');
	uci.set(PACKAGE, 'main', 'interval', sprintf('%d', want.interval));
	uci.set(PACKAGE, 'main', 'direct_pref_base', sprintf('%d', want.direct_pref_base));
	uci.set(PACKAGE, 'main', 'rule_pref_base', sprintf('%d', want.rule_pref_base));
	uci.set(PACKAGE, 'main', 'catch_all_pref_base', sprintf('%d', want.catch_all_pref_base));
	uci.set(PACKAGE, 'main', 'catch_all_table', sprintf('%d', want.catch_all_table));
	uci.set(PACKAGE, 'main', 'wan_table_base', sprintf('%d', want.wan_table_base));
	uci.set(PACKAGE, 'main', 'wan_warn_uptime', sprintf('%d', want.wan_warn_uptime));
	uci.set(PACKAGE, 'main', 'wan_error_grace', sprintf('%d', want.wan_error_grace));
	uci.set(PACKAGE, 'main', 'release_grace', sprintf('%d', want.release_grace));
	uci.set(PACKAGE, 'main', 'lan_local', want.lan_local ? '1' : '0');
	uci.set(PACKAGE, 'main', 'local_pref_base', sprintf('%d', want.local_pref_base));

	if (uci.commit(PACKAGE) === null)
		return refuse('the settings would not commit to /etc/config/bm_wanbind; the file may be read-only or the overlay full');

	// The file has changed, so the read this call arrived with describes a
	// router that no longer exists. Everything below asks what was actually
	// written, which is not the question every line above was asking.
	snap = cfg.snapshot();

	// Read back through the daemon's own readers rather than trusted, exactly
	// as a section is. The band is the one that can fail here: it is worked out
	// from where the instances have put their priority ranges, so a
	// direct_pref_base that is fine on its own may still reach one of them.
	let after = settingsRead(snap);

	if (!after.band.usable) {
		restoreSection('main', 'settings', raw);
		return refuse(after.band.reason);
	}

	// The two that are not only a value in a file.
	state.main = cfg.main(snap);
	schedule();

	// Switched back on: a pass now rather than in up to `interval` seconds,
	// for the reason `bind` runs one - somebody who pressed this is watching a
	// LAN full of clients that are not bound yet.
	if (!previous.enabled && after.enabled)
		pass();

	notice(sprintf('settings: pools are %s, reconciling every %ds', after.enabled ? 'on' : 'off', after.interval));

	return { ok: true, reason: null, settings: after };
};

/**
 * Every interface this router could bind through, and the devices they sit on.
 *
 * One netifd dump and one classification for the whole answer, which is what
 * makes this cheap enough for a form to open on. It is the union of three
 * questions a surface used to ask separately and then have to reconcile: what
 * netifd says, what this router reads each interface as, and what this daemon
 * is currently doing with it.
 *
 * `carriers` is the same list grouped by the device underneath, because a
 * carrier is what an instance names and a VLAN is not something anybody wants
 * to type out of `ip link`. A trailing `.101` is the VLAN tag, so `eth1.101`
 * and `eth1.102` are two WANs on the carrier `eth1` - which is exactly the
 * grouping `wans.pool` matches on.
 */
export function wanList() {
	let list = wans.dump(state.bus);

	if (list === null) {
		return {
			ok: false,
			reason: 'netifd did not answer, so nothing can be said about this router\'s interfaces. Try again, and if it keeps happening check that netifd is running - `ubus call network.interface dump`',
			wans: [],
			carriers: []
		};
	}

	let view = layout.classify(list, layout.statements());
	let verdicts = (type(view.byName) == 'object') ? view.byName : {};
	let settings = settingsRead();

	// Which instance owns which interface, and who is on it. Built from the
	// pool the same way the pass builds it, so a surface and a pass cannot
	// disagree about what is in a carrier.
	let owner = {};
	let holders = {};
	let warnUptime = {};

	for (let st in each()) {
		for (let one in wans.pool(list, st.instance)) {
			owner[one.name] = st.instance.id;
			warnUptime[one.name] = st.instance.wanWarnUptime;

			let who = [];
			for (let mac in engine.wanHolders(st, one.name))
				push(who, mac);

			holders[one.name] = who;
		}
	}

	let out = [];
	let byCarrier = {};
	let order = [];

	for (let one in list) {
		let verdict = verdicts[one.name];
		let device = length(one.device) ? one.device : one.l3Device;

		// The carrier is the device with its VLAN tag taken off, which is the
		// name an instance is configured with.
		let tagged = match(device, /^(.+)\.[0-9]+$/);
		let carrier = tagged ? tagged[1] : device;

		push(out, {
			name: one.name,
			proto: one.proto,
			device: one.device,
			l3Device: one.l3Device,
			carrier: carrier,
			up: one.up,
			pending: one.pending,
			uptime: one.uptime,
			errorCode: one.errorCode,
			ipv4: one.ipv4,
			table: (type(one.table) == 'int') ? one.table : 0,
			zone: verdict ? text(verdict.zone) : '',
			role: verdict ? verdict.role : 'unclear',

			// The classifier's own words, so that a refusal about this
			// interface can be checked against the router rather than argued
			// with. Whichever side it came down on is the side quoted.
			//
			// A list rather than the joined phrase `layout.clauses` builds: a
			// caller can always join a list, and cannot reliably take one apart.
			// The pickers show these under an option, where one clause per line
			// reads better than a sentence anyway.
			evidence: verdict
				? ((verdict.role == 'lan') ? verdict.lanEvidence : verdict.uplinkEvidence)
				: [],

			instance: text(owner[one.name]),
			holders: (type(holders[one.name]) == 'array') ? holders[one.name] : [],

			// The same word `assignments` and the LuCI table use. `dialing` is
			// deliberately not an error: a pool of five thousand PPPoE sessions
			// has some of them dialling at any moment, and a page that painted
			// those red would be red permanently.
			state: wans.state(one, numberOr(warnUptime[one.name], settings.wan_warn_uptime))
		});

		if (!length(carrier))
			continue;

		if (!(carrier in byCarrier)) {
			byCarrier[carrier] = { device: carrier, up: false, wans: [] };
			push(order, carrier);
		}

		push(byCarrier[carrier].wans, one.name);

		// Up when anything on it is up. A carrier is a piece of cable rather
		// than an interface, and the only thing anybody wants to know about it
		// here is whether choosing it would give an instance a pool at all.
		if (one.up)
			byCarrier[carrier].up = true;
	}

	let carriers = [];
	for (let name in order)
		push(carriers, byCarrier[name]);

	return { ok: true, reason: null, wans: out, carriers: carriers };
};

/**
 * What would be refused, or worth a second look, about a binding not yet made.
 *
 * The same shape `instance_check` has, for the same reason: a surface puts Save
 * behind this answer, so it has to be the answer `bind` would give. What it
 * cannot do is be exhaustive - `bind` writes the section and asks
 * `bm.wanbind.config` to read it back, and that reader is the only thing that
 * decides. This is everything that can be known before the write, which is all
 * of what a person can act on and none of what only the file can settle.
 */
export function bindCheck(args) {
	let snap = cfg.snapshot();

	let out = [];
	let id = trim(text(args.id));

	if (!length(id)) {
		push(out, finding('error', 'id', 'name the binding: the section name is its identity here, in the app, and in every log line about it'));
	}
	else if (!match(id, SECTION_NAME)) {
		push(out, finding('error', 'id', sprintf('%s is not a name a UCI section can have; letters, digits and underscores, up to 32 of them', id)));
	}
	else if (id == 'main') {
		push(out, finding('error', 'id', 'main is this package\'s own settings section and is not a binding'));
	}
	else {
		for (let one in cfg.configured(snap)) {
			if (one.id == id) {
				push(out, finding('error', 'id', sprintf('%s is already an instance in /etc/config/bm_wanbind - a whole LAN sharing a pool of WANs. Give the binding another name', id)));
				break;
			}
		}
	}

	let ip = trim(text(args.ip));
	let mac = trim(text(args.mac));
	let wan = trim(text(args.wan));
	let lan = trim(text(args.lan));

	if (length(ip) && length(mac)) {
		push(out, finding('error', 'target', 'send ip or mac, not both: a binding follows one thing, an address or a device wherever its lease puts it'));
	}
	else if (!length(ip) && !length(mac)) {
		push(out, finding('error', 'target', 'send ip or mac - there is nothing for this binding to follow'));
	}

	let whenDown = lc(trim(text(args.when_down)));

	if (length(whenDown) && !(whenDown in [ 'hold', 'fallback' ])) {
		push(out, finding('error', 'when_down', sprintf('when_down %s is neither hold nor fallback. hold parks the address on the unreachable table, so while its WAN is down it has no way out at all; fallback re-points it at the main table, so it leaves over whatever connection the router would have used anyway. There is no third answer - taking the rule away is fallback with nothing to say so',
			whenDown)));
	}

	let list = wans.dump(state.bus);
	let verdicts = {};

	if (list === null) {
		push(out, finding('warning', 'router', 'netifd did not answer, so the WAN and the LAN have not been weighed against this router\'s own interfaces - only the numbers were checked'));
	}
	else {
		let view = layout.classify(list, layout.statements());
		verdicts = (type(view.byName) == 'object') ? view.byName : {};
	}

	if (!length(wan)) {
		push(out, finding('error', 'wan', 'name the WAN this binding leaves through'));
	}
	else if (list !== null) {
		let verdict = verdicts[wan];

		if (!verdict) {
			push(out, finding('error', 'wan', sprintf('netifd knows no interface called %s. This wants the name of the section in /etc/config/network - wan, wan2 - and not the device underneath it, which is what eth1.101 and pppoe-wan2 are', wan)));
		}
		else if (verdict.role == 'lan') {
			push(out, finding('error', 'wan', sprintf('%s is one of this router\'s own LANs, because %s. A binding that left by the network it is already on would send nothing anywhere',
				wan, layout.clauses(verdict.lanEvidence))));
		}
		else if (verdict.role == 'unclear') {
			push(out, finding('warning', 'wan', sprintf('this router cannot tell which side %s is on. It reads as a way out because %s, and as a LAN because %s',
				wan, layout.clauses(verdict.uplinkEvidence), layout.clauses(verdict.lanEvidence))));
		}
	}

	// The table. Read from netifd rather than from /etc/config/network, because
	// the number in UCI is what netifd will use after the next reload and a rule
	// pointing at that one sends the address nowhere until then.
	let table = count(args.table);

	if (!table && length(wan) && list !== null) {
		for (let one in list) {
			if (one.name == wan)
				table = count(one.table);
		}

		if (!table) {
			push(out, finding('info', 'table', sprintf('%s has no routing table of its own, so it is given one from %d upwards - written into /etc/config/network as `option ip4table`, with one netifd reload. Nothing else on that interface is touched',
				wan, WAN_TABLE_BASE)));
		}
	}

	for (let one in cfg.instances(snap)) {
		if (table && table == one.catchAllTable) {
			push(out, finding('error', 'table', sprintf('table %d is instance %s\'s catch_all_table, which holds nothing but `unreachable default`. The rule would be written, the row would read bound, and every packet from this address would be dropped',
				table, one.id)));
			break;
		}
	}

	// The band, which is the whole of how a hand-placed binding beats a pool.
	let band = cfg.directBand(snap);
	let pref = count(args.pref);

	if (!band.usable) {
		push(out, finding('error', 'pref', band.reason));
	}
	else if (pref) {
		if (pref < band.base || pref > band.top) {
			push(out, finding('warning', 'pref', sprintf('pref %d is outside the %d-%d band this daemon sweeps. The rule is still written and still maintained - a binding keeps the number it was stamped with for ever - but nothing will ever tidy it up if the section is deleted while the daemon is not running',
				pref, band.base, band.top)));
		}

		for (let one in cfg.instances(snap)) {
			if (pref >= one.rulePrefBase) {
				push(out, finding('error', 'pref', sprintf('pref %d is not below instance %s\'s rule_pref_base %d. The lowest matching ip rule decides, so up there this binding no longer outranks the WAN that instance would assign - and worse, that instance adopts this rule as one of its own assignments, finds no lease behind it and removes it. Move it into %d-%d',
					pref, one.id, one.rulePrefBase, band.base, band.top)));
				break;
			}
		}

		for (let one in cfg.directConfigured(snap)) {
			if (one.id != id && one.enabled && one.pref == pref) {
				push(out, finding('error', 'pref', sprintf('pref %d is already binding %s\'s, and two ip rules at one priority is not an order anything can rely on',
					pref, one.id)));
				break;
			}
		}
	}
	else {
		let taken = {};

		for (let one in cfg.directConfigured(snap)) {
			if (one.id != id && one.pref >= 1)
				taken[sprintf('%d', one.pref)] = true;
		}

		let free = 0;
		for (let candidate = band.base; candidate <= band.top; candidate++) {
			if (!(sprintf('%d', candidate) in taken)) {
				free = candidate;
				break;
			}
		}

		if (!free) {
			push(out, finding('error', 'pref', sprintf('every ip rule priority from %d to %d is already claimed by a binding. Widen the band with `option direct_pref_base` on the main section, or remove a binding that is no longer wanted',
				band.base, band.top)));
		}
		else {
			push(out, finding('info', 'pref', sprintf('this binding is stamped with ip rule priority %d, and keeps it for as long as the section exists', free)));
		}
	}

	// The LAN, which is only the firewall half - a binding without one still
	// gets its rule, and its traffic is then dropped by fw4 with nothing on any
	// surface saying so, which is why this is said rather than left out.
	if (!length(lan)) {
		push(out, finding('warning', 'lan', 'no lan is set, so no firewall forwarding is written for this binding. Its rule selects the address into the WAN\'s table and fw4 decides separately whether that traffic may pass; set the interface the address sits behind and the forwarding is written with it'));
	}
	else if (list !== null && !verdicts[lan]) {
		push(out, finding('warning', 'lan', sprintf('netifd knows no interface called %s. This wants the section in /etc/config/network the address sits behind - lan, lan_guest - and not the bridge device, which is what br-lan is', lan)));
	}

	// And what the router knows about the device itself, which is the one thing
	// here that is neither a refusal nor a warning: a MAC with no lease is
	// perfectly legal and simply has no rule until the device appears.
	if (length(mac)) {
		let normalized = leases.normalizeMac(replace(mac, /-/g, ':'));

		if (!length(normalized)) {
			push(out, finding('error', 'mac', sprintf('mac %s is not a MAC address; six hex pairs, separated by colons', mac)));
		}
		else {
			let current = leases.fromFile();
			let found = (type(current) == 'object') ? current[normalized] : null;

			if (found) {
				push(out, finding('info', 'mac', sprintf('%s is on %s right now, so that is the address the rule is written for. It is re-read on every pass, so the binding follows the device if it comes back on a different one',
					normalized, found.ip)));
			}
			else {
				push(out, finding('info', 'mac', sprintf('no lease on this router is %s at the moment, so no rule is written until one is. The binding is still created and still in force - it is following a device rather than an address',
					normalized)));
			}
		}
	}

	return { ok: !hasError(out), findings: out };
};

/**
 * The router's whole ip rule table, and the routes behind it.
 *
 * `bm.wanbind.monitor` reads it and labels every row with who wrote it: this
 * daemon's bands and sections, the kernel's own three, and everything else as
 * foreign. Answering that here rather than leaving a surface to shell out for
 * `ip -4 rule show` is the point of the method - a table parsed out of a
 * command's output is a table that means whatever that command's formatting
 * meant on the day it was parsed.
 *
 * It reads and never writes. A rule it names as somebody else's stays exactly
 * where it is, including one that outranks everything this daemon does;
 * removing it is a decision for whoever put it there.
 */
export function ruleExplain(args) {
	let snap = cfg.snapshot();

	return monitor.explain({
		pref: count(args.pref),
		cidr: text(args.cidr),
		dst: text(args.dst),
		table: count(args.table),
		band: cfg.directBand(snap),
		local: cfg.localBand(snap),
		instances: cfg.configured(snap),
		bindings: direct.bindings(),
		assignments: assignments('').assignments,
		interfaces: wans.dump(state.bus) ?? []
	});
};

export function rulesReport(args) {
	let snap = cfg.snapshot();

	let limit = count(args.limit);

	if (limit < 1)
		limit = RULES_LIMIT;

	if (limit > RULES_LIMIT_MAX)
		limit = RULES_LIMIT_MAX;

	// Everything the monitor cannot read for itself: the sections, the band, and
	// this process's own memory of who is seated where. The two dumps it needs -
	// every rule and every route - it takes straight off netlink, so the answer
	// is the kernel's rather than a second-hand copy of it.
	//
	// `bindings` is the *pass's* rows and not the sections, because ownership is
	// what is being decided: a row carries the table its rule actually points at
	// right now, where a section carries the number it was stamped with, and a
	// held binding is exactly the case where those two differ.
	return monitor.report({
		limit: limit,
		offset: count(args.offset),

		// Both default the way a page wants them: the sentences are fetched for
		// the row somebody clicks on rather than for all of them, and netifd's
		// three rules per interface are one line rather than three.
		reasons: (args.reasons === true),
		collapse: (args.reasons === true) ? (args.collapse !== false) : (args.collapse !== false),
		band: cfg.directBand(snap),
		local: cfg.localBand(snap),
		instances: cfg.configured(snap),
		bindings: direct.bindings(),
		assignments: assignments('').assignments,

		// What netifd is routing, so the three rules it writes per interface
		// with an `ip4table` are read as the router routing itself rather than
		// as ninety-six strangers on a box dialling thirty-two sessions.
		interfaces: wans.dump(state.bus) ?? []
	});
};

/** What the last pass decided, against what the kernel is holding. Writes nothing. */
export function verify(args) {
	let out = verifyRules(text(args.instance));

	return {
		ok: out.ok,
		read: out.read,
		checked: out.checked,
		present: out.present,
		missing: out.missing,
		extra: out.extra,
		reason: out.reason
	};
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
	// `source` narrows to the hand-placed ones or to one instance's seats. It is
	// declared even though this daemon only has hand-placed bindings, and that
	// is not decoration: ubus checks a call against this template and refuses
	// the *whole call* on a key it does not carry, so a page that sends a filter
	// this daemon has not declared does not get an unfiltered list, it gets an
	// error that reads exactly like the daemon being broken.
	bindings: method({ id: '', source: '' }, (args) => bindings(text(args.id), text(args.source))),
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

	// The other half of `bind`: everything that can be known about a binding
	// before the section exists. A surface puts Save behind this, so it is the
	// same weighing `bind` would do rather than a second opinion.
	bind_check: method({
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
	}, (args) => bindCheck(args)),

	// What this router reads each of its interfaces as, with the evidence. The
	// module asks before it offers an address to bind, and asks the router
	// rather than deciding for itself, so that the two halves cannot come to
	// different conclusions about which side of the router an interface is on.
	layout: method({}, () => interfaces()),

	// The same dump read the other way round: what each interface is doing,
	// which instance has it, and who is on it. `layout` answers "which side of
	// the router is this on"; this answers "may I hand it to somebody".
	wans: method({}, () => wanList()),

	// The whole `config wanbind 'main'` section. The seven numbers on it are
	// defaults for instances created afterwards and nothing else - a section
	// already stamped keeps what it carries - which is what makes them safe to
	// change while the router is binding.
	settings_get: method({}, () => settingsRead()),
	settings_set: method({
		enabled: false,
		interval: 0,
		direct_pref_base: 0,
		rule_pref_base: 0,
		catch_all_pref_base: 0,
		catch_all_table: 0,
		wan_table_base: 0,
		wan_warn_uptime: 0,
		wan_error_grace: 0,
		release_grace: 0,

		// Whether a bound address may still reach the networks this router
		// serves, and where the rules that let it sit. Off is a real answer, so
		// the flag is a boolean and not a number that would read as "unchanged".
		lan_local: false,
		local_pref_base: 0
	}, (args) => settingsSet(args)),

	// One instance, created or edited. The template is declared once here and
	// spelled the same in LuCI's api.js and in the module, because ubus checks
	// every argument's type against it and rejects the whole call when one
	// disagrees - a priority sent as the string somebody typed does not arrive
	// as a number this daemon then reads leniently, it does not arrive at all.
	//
	// A key that is absent means "leave it as it is", which is why there is no
	// sentinel value for any of them: 0 is a real `clients_per_wan` and an
	// empty `range_from` is a real whole-LAN instance.
	instance_check: method({
		id: '',
		name: '',
		enabled: true,
		lan: '',
		carrier: '',
		sticky: true,
		remap: true,
		clients_per_wan: 0,
		range_from: '',
		range_to: '',
		rule_pref_base: 0,
		catch_all_pref: 0,
		catch_all_table: 0,
		wan_warn_uptime: 0,
		wan_error_grace: 0,
		release_grace: 0,
		raise_dhcp_limits: false
	}, (args) => instanceCheck(args)),
	instance_set: method({
		id: '',
		name: '',
		enabled: true,
		lan: '',
		carrier: '',
		sticky: true,
		remap: true,
		clients_per_wan: 0,
		range_from: '',
		range_to: '',
		rule_pref_base: 0,
		catch_all_pref: 0,
		catch_all_table: 0,
		wan_warn_uptime: 0,
		wan_error_grace: 0,
		release_grace: 0,
		raise_dhcp_limits: false
	}, (args) => instanceSet(args)),
	instance_delete: method({ id: '' }, (args) => instanceDelete(args)),

	// `wait` is what a person pressing a button sends: run the pass now and
	// answer with what it did. Without it the request is folded into the pass
	// that is already due, which is what the hotplug hooks want - they arrive
	// one per interface and would otherwise each buy a full pass.
	// The batch forms of the two above. What they are for is the module handing
	// over the bindings it used to write itself: five hundred separate calls
	// would be five hundred commits to flash and five hundred passes.
	bind_many: method({ bindings: [] }, (args) => bindMany(args)),
	unbind_many: method({ ids: [] }, (args) => unbindMany(args)),

	reconcile: method({ instance: '', wait: false }, (args) => reconcileNow(args)),
	flush: method({ instance: '' }, (args) => flush(args)),

	// The two that only read. `rules` is the monitor - every rule on the router
	// and who wrote it - and `verify` is the narrower question this daemon can
	// answer about itself: of the rules it decided on, which are actually there.
	rules: method({ limit: 0, offset: 0, reasons: false, collapse: true }, (args) => rulesReport(args)),

	// One rule, and why it is there. The list above stopped carrying a
	// paragraph per row - at fifteen hundred rules the sentences were most of
	// the reply - so this is how the one somebody clicked on gets explained.
	rule_explain: method({ pref: 0, cidr: '', dst: '', table: 0 }, (args) => ruleExplain(args)),

	verify: method({ instance: '' }, (args) => verify(args))
};
