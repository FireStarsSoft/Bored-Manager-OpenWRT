// What `bm.pppoe` answers, and the two loops behind it.
//
// One state per pool, held for the life of the process. The loops are the
// counter pass and the watchdog, and between them they are the whole of what
// this daemon does while nothing is asking: read one file every few seconds,
// and redial whatever netifd has given up on.
//
// Session state does not come from a loop at all - it arrives as netifd events -
// which is what makes a pool of five thousand cost nothing to watch. The dump
// on the counter pass is the correction, not the source.

import { readfile, unlink } from 'fs';
import { timer } from 'uloop';

import { debug, err, notice } from 'bm.log';

import * as cfg from 'bm.pppoe.config';
import * as counters from 'bm.pppoe.counters';
import * as sections from 'bm.pppoe.sections';
import * as sessions from 'bm.pppoe.sessions';

export const RELEASE = '1.4.0';

/** The ubus contract version, separate from the release. */
export const API_VERSION = 1;

const STARTED = time();

// A create writes a pool's worth of sections and then tells netifd once. On a
// large pool that reload is seconds of netifd's time, so it is generous.
const RELOAD_TIMEOUT_MS = 120000;

// How long after a reload another one is folded into a single later pass.
const RELOAD_COALESCE = 3;

// The most rows one `sessions` call will return. Five thousand rows is not a
// table anybody reads and is a reply nothing wants to serialise.
const ROW_LIMIT = 500;

// The most accounts one inline call may carry.
//
// Inline is how credentials reach this daemon from LuCI, and it is safe for the
// reason the file is safe on the other path: a ubus call travels over a unix
// socket as a binary message and arrives here as a parsed object, so no part of
// it is ever an argument to a process and no part of it appears in
// /proc/<pid>/cmdline.
//
// What it is not is unlimited. A ubus message has a size ceiling, and writing
// five thousand sections inside one call would hold this daemon's event loop
// for the whole of it - during which nothing else is answered and no netifd
// event is read. So a large pool arrives as a create followed by appends, which
// is the shape the record was already written in: the pool exists from the
// first chunk onwards, and a create that stops half way leaves something
// `pool delete` can remove cleanly.
const INLINE_ACCOUNTS = 200;

let state = {
	bus: null,
	main: { enabled: true, counterInterval: 5, redialAfter: 120, redialBatch: 20 },
	pools: {},
	order: [],
	counters: null,
	countersAt: 0,
	rates: {},
	served: 0,
	ticks: 0,
	// Held rather than dropped: a uloop timer and a ubus listener whose only
	// reference has gone out of scope may not be there when they are needed.
	timer: null,
	listener: null,
	// The coalesced netifd reload. See reloadSoon().
	reloadTimer: null,
	reloadAt: 0
};

function rssKb() {
	let status = readfile('/proc/self/status');
	if (type(status) != 'string')
		return -1;

	let found = match(status, /VmRSS:[ \t]+([0-9]+)/);
	return found ? int(found[1]) : -1;
};

function each() {
	let out = [];
	for (let id in state.order)
		push(out, state.pools[id]);
	return out;
};

function text(value) {
	return type(value) == 'string' ? value : '';
};

/**
 * Read the pool records and build one session table per pool.
 *
 * Done at start and after every create or delete, because those are the only
 * two things that change which pools exist. A UCI edit by hand restarts the
 * service - procd is told to watch the file - so there is no reload path here
 * to get wrong.
 */
export function load() {
	state.main = cfg.main();

	let next = {};
	let order = [];

	for (let one in cfg.pools()) {
		// Kept across a reload so a pool that has not changed keeps everything
		// it knows: which sessions are up, how long they have been down, and
		// its place in the watchdog queue.
		let existing = state.pools[one.id];
		next[one.id] = (existing && existing.pool.prefix == one.prefix &&
			existing.pool.seqFrom == one.seqFrom && existing.pool.seqTo == one.seqTo)
			? existing
			: sessions.create(one);
		push(order, one.id);
	}

	state.pools = next;
	state.order = order;

	notice(sprintf('loaded %d pool(s), counters every %ds, redial after %ds',
		length(order), state.main.counterInterval, state.main.redialAfter));
};

export function attach(bus) {
	state.bus = bus;
};

function call(object, method, args) {
	if (!state.bus)
		return null;

	try {
		return state.bus.call(object, method, args ? args : {});
	}
	catch (e) {
		debug('ubus ' + object + ' ' + method + ' failed: ' + e);
		return null;
	}
};

/**
 * Tell netifd to read the configuration, at most once per run of writes.
 *
 * A pool larger than one ubus message arrives as a create followed by a run of
 * appends, and every one of them has written sections netifd has to be told
 * about. Telling it twenty-five times means twenty-five passes over the whole
 * of /etc/config/network - on a router already holding five thousand
 * interfaces, most of what a large pool costs - and twenty-four of those passes
 * are describing a pool that is not finished being written.
 *
 * Leading edge, so a single create behaves exactly as it always has: one
 * reload, before the call returns. What is coalesced is the run behind it. The
 * window opens when the previous reload *finished*, not when it started,
 * because a reload of a large config can easily outlast the window and every
 * chunk would then take the leading edge again.
 */
function reloadNetwork() {
	call('network', 'reload', {});
	state.reloadAt = time();
};

function reloadSoon() {
	if (time() - state.reloadAt >= RELOAD_COALESCE) {
		if (state.reloadTimer) {
			state.reloadTimer.cancel();
			state.reloadTimer = null;
		}

		reloadNetwork();
		return;
	}

	// Restarted rather than left alone, so a run of appends reloads once after
	// the last of them rather than once in the middle.
	if (state.reloadTimer) {
		state.reloadTimer.set(RELOAD_COALESCE * 1000);
		return;
	}

	state.reloadTimer = timer(RELOAD_COALESCE * 1000, () => {
		state.reloadTimer = null;
		try {
			reloadNetwork();
		}
		catch (e) {
			err('the deferred network reload failed: ' + e);
		}
	});
};

// ---------------------------------------------------------------------------
// The two loops.

/** Fold `network.interface dump` into every pool's session table. */
function refresh(now) {
	let reply = call('network.interface', 'dump', {});
	if (type(reply) != 'object' || type(reply.interface) != 'array')
		return false;

	for (let entry in reply.interface) {
		if (type(entry) != 'object')
			continue;

		let name = trim(text(entry.interface));
		if (!length(name))
			continue;

		let ipv4 = null;
		if (type(entry['ipv4-address']) == 'array' && length(entry['ipv4-address'])) {
			let first = entry['ipv4-address'][0];
			if (type(first) == 'object' && type(first.address) == 'string')
				ipv4 = { addr: first.address, mask: type(first.mask) == 'int' ? first.mask : 32 };
		}

		let errorCode = '';
		if (type(entry.errors) == 'array' && length(entry.errors)) {
			let last = entry.errors[length(entry.errors) - 1];
			if (type(last) == 'string')
				errorCode = last;
			else if (type(last) == 'object' && type(last.code) == 'string')
				errorCode = last.code;
		}

		let normalised = {
			name: name,
			up: entry.up === true,
			pending: entry.pending === true,
			uptime: type(entry.uptime) == 'int' ? entry.uptime : 0,
			ipv4: ipv4,
			errorCode: errorCode,
			table: type(entry.ip4table) == 'int' ? entry.ip4table : null
		};

		for (let st in each()) {
			if (sessions.observe(st, normalised, now))
				break;
		}
	}

	return true;
};

/** Redial whatever has been down longer than the router should tolerate. */
function watchdog(now) {
	if (!state.main.redialAfter)
		return 0;

	let started = 0;
	let budget = state.main.redialBatch;

	for (let st in each()) {
		if (budget <= 0)
			break;

		let due = sessions.dueForRedial(st, state.main.redialAfter, budget, now);
		sessions.announce(st, due);

		for (let section in due) {
			// down then up, because netifd will not re-dial an interface it
			// already considers up-but-failing, and `up` alone on a session in
			// that state does nothing at all.
			call('network.interface.' + section, 'down', {});
			call('network.interface.' + section, 'up', {});
			sessions.redialled(st, section, now);
			started++;
			budget--;
		}
	}

	return started;
};

/** One counter reading, and the rate since the last one. */
function meter(now) {
	// The whole record, not just the prefix: two pools may share a prefix with
	// different sequence ranges, and the sequence range is what tells their
	// interfaces apart.
	let pools = [];
	for (let st in each())
		push(pools, st.pool);

	let current = counters.read(pools);
	if (current === null)
		return;

	let seconds = state.countersAt ? (now - state.countersAt) : 0;
	let rates = {};

	for (let id in current) {
		rates[id] = counters.rate(state.counters ? state.counters[id] : null, current[id], seconds);
	}

	state.counters = current;
	state.countersAt = now;
	state.rates = rates;
};

export function pass() {
	let now = time();

	refresh(now);
	meter(now);
	watchdog(now);

	for (let st in each()) {
		st.lastPassAt = now;
		sessions.trace(st);
	}

	state.ticks = state.ticks + 1;
};

function schedule() {
	if (!state.timer) {
		state.timer = timer(state.main.counterInterval * 1000, () => {
			try {
				pass();
			}
			catch (e) {
				err('counter pass failed: ' + e);
			}

			state.timer.set(state.main.counterInterval * 1000);
		});
		return;
	}

	state.timer.set(state.main.counterInterval * 1000);
};

/**
 * Listen for netifd's own events.
 *
 * This is what makes a session coming up something the daemon knows in
 * milliseconds rather than at the next pass. The dump above is still read every
 * few seconds, because an event that was missed - a restart, a busy router - is
 * a session reported wrong until something corrects it.
 */
function listen() {
	if (!state.bus)
		return;

	try {
		state.listener = state.bus.listener('network.interface', (event, data) => {
			if (type(data) != 'object')
				return;

			let name = text(data.interface);
			let action = text(data.action);
			if (!length(name) || !length(action))
				return;

			let now = time();
			for (let st in each()) {
				if (sessions.event(st, action, name, now))
					break;
			}
		});
	}
	catch (e) {
		err('cannot listen for netifd events, falling back to the counter pass alone: ' + e);
	}
};

export function start() {
	if (!state.main.enabled) {
		notice('disabled in /etc/config/bm_pppoe; answering questions and watching nothing');
		return;
	}

	listen();
	pass();
	schedule();
};

// ---------------------------------------------------------------------------
// Creating and deleting.

/**
 * Read an account payload out of a 0600 file, and delete the file.
 *
 * The file is how credentials get onto the router without ever being an
 * argument to anything: the module writes it through the SSH connection it
 * already has, with `umask 077`, and passes only its path. It is unlinked
 * before a single section is written, so a create that fails half way does not
 * leave a readable copy of somebody's account list in /tmp.
 */
function takePayload(path) {
	if (!match(path, /^\/tmp\/[A-Za-z0-9._-]{1,64}$/))
		return { ok: false, reason: 'the payload has to be a plain file directly in /tmp' };

	let raw = readfile(path);
	unlink(path);

	if (type(raw) != 'string')
		return { ok: false, reason: 'the payload could not be read - it may already have been consumed' };

	let value;
	try {
		value = json(raw);
	}
	catch (e) {
		return { ok: false, reason: 'the payload is not valid JSON' };
	}

	if (type(value) != 'object' || type(value.accounts) != 'array')
		return { ok: false, reason: 'the payload carries no account list' };

	return { ok: true, payload: value };
};

/** Why this cannot be a new pool id, or null. */
function poolIdRefusal(id) {
	if (!match(id, /^[a-z][a-z0-9_]{0,30}$/))
		return 'a pool id has to be 1 to 31 lower case letters, digits or underscores';

	if (cfg.pool(id))
		return 'this router already has a pool called ' + id;

	return null;
};

/**
 * Why this range may not be written, or null.
 *
 * Two pools may not derive the same section names. A section is named from the
 * prefix and the sequence number and nothing else, so two pools sharing a
 * prefix with overlapping ranges name the same interfaces. Nothing further down
 * would notice: `sections.write` sets each one unconditionally, so the second
 * create silently rewrites the first pool's usernames, passwords and routing
 * tables, and the reload that follows redials those sessions on somebody else's
 * account. After that `sessions.owns` matches both pools to the same sections,
 * and deleting either one takes the other's interfaces with it.
 *
 * It is an easy mistake rather than an exotic one - adding capacity by creating
 * a second pool with the same prefix is the obvious thing to do, and getting
 * the starting sequence one too low is all it takes. `pool_append` exists so
 * that the obvious thing is also a supported one.
 *
 * The table range is deliberately not checked. Two pools sharing a routing
 * table is a routing question with legitimate answers; two pools sharing an
 * interface name has none.
 */
function overlapRefusal(one, exceptId) {
	for (let other in cfg.pools()) {
		if (other.id == exceptId)
			continue;
		if (other.prefix != one.prefix)
			continue;
		if (one.seqFrom > other.seqTo || one.seqTo < other.seqFrom)
			continue;

		return sprintf('pool %s already holds %s%05d to %s%05d, and this range would overwrite its sessions',
			other.id, other.prefix, other.seqFrom, other.prefix, other.seqTo);
	}

	return null;
};

/**
 * The account list of an inline call, or a refusal.
 *
 * The cap is checked here rather than at the writer because the answer a caller
 * needs is not "that failed" but "send it in pieces, and here is how big a
 * piece may be".
 */
function accountRows(value) {
	if (type(value) != 'array' || !length(value))
		return { ok: false, reason: 'the call carries no account list' };

	if (length(value) > INLINE_ACCOUNTS) {
		return {
			ok: false,
			reason: sprintf('at most %d accounts in one call and %d were sent; create the pool with the first %d and add the rest',
				INLINE_ACCOUNTS, length(value), INLINE_ACCOUNTS)
		};
	}

	for (let row in value) {
		if (type(row) != 'object')
			return { ok: false, reason: 'an account row is not an object with a user and a pass' };
	}

	return { ok: true, accounts: value };
};

/**
 * Create a pool from a payload, however the payload arrived.
 *
 * Both callers reach here with the same object, so a pool created from a file
 * over SSH and a pool created from LuCI are the same pool: same checks, same
 * order, same record. What differs between them is only how the credentials
 * travelled, which is a question about the transport and not about the pool.
 *
 * The record is written before the interfaces, so a create interrupted anywhere
 * leaves a pool that `pool delete` can remove cleanly. The reverse order would
 * leave sections nothing knows the name of.
 */
function createPool(id, payload) {
	let refusal = poolIdRefusal(id);
	if (refusal)
		return { ok: false, reason: refusal };

	let one = {
		id: id,
		prefix: text(payload.prefix),
		carrier: text(payload.carrier),
		seqFrom: type(payload.seqFrom) == 'int' ? payload.seqFrom : 0,
		tableBase: type(payload.tableBase) == 'int' ? payload.tableBase : 0,
		vlan: type(payload.vlan) == 'int' ? payload.vlan : 0,
		created: time()
	};

	one.count = length(payload.accounts);
	one.seqTo = one.seqFrom + one.count - 1;

	if (!one.count)
		return { ok: false, reason: 'the payload lists no accounts' };

	// The same check `cfg.pools()` applies when it reads the file back.
	//
	// Without it a create can write a record the next read refuses and drops -
	// a table base that runs off the end of the routing table range, a carrier
	// nobody set - and a pool that has been dropped is a pool whose interfaces
	// nothing knows the names of any more. Two identical rules, one applied
	// only on the way in and one only on the way out, is how that happens.
	let unusable = cfg.refusal(one);
	if (unusable)
		return { ok: false, reason: unusable };

	let clash = overlapRefusal(one, null);
	if (clash)
		return { ok: false, reason: clash };

	if (!cfg.remember(one))
		return { ok: false, reason: 'the pool record could not be written, so nothing was created' };

	let written = sections.write(one, payload.accounts, null);
	if (!written.ok) {
		return {
			ok: false,
			reason: written.reason,
			written: written.written,
			// The record is left behind on purpose. It is the only thing that
			// knows the names of the sections that did get written, so it is
			// also the only way to remove them.
			id: id
		};
	}

	// One reload for the whole pool, or for the whole run of chunks it arrives
	// in. netifd re-reads the configuration and starts dialling; that is not
	// waited on, because a pool of five thousand takes minutes to come up and
	// the caller wants an answer now.
	reloadSoon();

	// Not deferred with it: this is a re-read of uci, it costs nothing, and
	// without it the `info` call that follows a create would not have the pool
	// in it yet.
	load();

	return { ok: true, id: id, created: written.written, seqFrom: one.seqFrom, seqTo: one.seqTo, count: one.count };
};

/**
 * Create a pool from a 0600 file, which is deleted as it is read.
 *
 * The path for anything that reaches ubus by running `ubus call`, where the
 * arguments are a command line and a password among them would be world
 * readable for as long as the process lived. It is also the method that names a
 * file for this daemon to read and unlink as root, which is why the LuCI ACL
 * grants `pool_add` and not this one.
 */
export function poolCreate(args) {
	let id = text(args.id);

	// Checked before the payload is taken, because taking it deletes it. A pool
	// name that turns out to be wrong should cost a retry, not the account
	// list.
	let refusal = poolIdRefusal(id);
	if (refusal)
		return { ok: false, reason: refusal };

	let taken = takePayload(text(args.source));
	if (!taken.ok)
		return taken;

	return createPool(id, taken.payload);
};

/**
 * Create a pool from accounts sent inline.
 *
 * The path LuCI uses. See INLINE_ACCOUNTS for why credentials may travel this
 * way and why there is a limit on how many of them may travel at once.
 */
export function poolAdd(args) {
	let rows = accountRows(args.accounts);
	if (!rows.ok)
		return rows;

	return createPool(text(args.id), {
		prefix: text(args.prefix),
		carrier: text(args.carrier),
		seqFrom: type(args.seq_from) == 'int' ? args.seq_from : 0,
		tableBase: type(args.table_base) == 'int' ? args.table_base : 0,
		vlan: type(args.vlan) == 'int' ? args.vlan : 0,
		accounts: rows.accounts
	});
};

/**
 * Add sessions to the end of a pool that already exists.
 *
 * This is the answer to the trap `overlapRefusal` can only refuse. The obvious
 * way to add capacity is to create a second pool with the same prefix, and
 * getting the starting sequence one too low is all it takes to overwrite the
 * first pool's credentials. Extending the range means there is no second pool
 * and no arithmetic for anybody to get wrong.
 *
 * It is also how a pool larger than one ubus message is built: create with the
 * first chunk, append the rest. The record is widened before the chunk is
 * written, for the same reason it is written first on a create - it is the only
 * thing that knows the names of the interfaces, so it has to cover them before
 * they exist. A caller that goes away half way leaves a pool whose record is
 * wider than the sessions actually written, which `pool delete` removes
 * correctly and which the next append continues from.
 */
export function poolAppend(args) {
	let id = text(args.id);
	let one = cfg.pool(id);

	if (!one)
		return { ok: false, reason: 'no pool called ' + id };

	let rows = accountRows(args.accounts);
	if (!rows.ok)
		return rows;

	let added = {
		id: one.id,
		prefix: one.prefix,
		carrier: one.carrier,
		seqFrom: one.seqTo + 1,
		tableBase: one.tableBase,
		vlan: one.vlan,
		created: one.created,
		count: length(rows.accounts)
	};

	added.seqTo = added.seqFrom + added.count - 1;

	let clash = overlapRefusal(added, id);
	if (clash)
		return { ok: false, reason: clash };

	let grown = {
		id: one.id,
		prefix: one.prefix,
		carrier: one.carrier,
		seqFrom: one.seqFrom,
		seqTo: added.seqTo,
		tableBase: one.tableBase,
		vlan: one.vlan,
		created: one.created
	};

	// The widened record has to survive being read back, the same as a new one.
	let unusable = cfg.refusal(grown);
	if (unusable)
		return { ok: false, reason: unusable };

	if (!cfg.remember(grown))
		return { ok: false, reason: 'the pool record could not be widened, so nothing was created' };

	let written = sections.write(added, rows.accounts, null);
	if (!written.ok)
		return { ok: false, reason: written.reason, written: written.written, id: id };

	reloadSoon();
	load();

	return {
		ok: true,
		id: id,
		created: written.written,
		seqFrom: added.seqFrom,
		seqTo: added.seqTo,
		count: one.count + added.count
	};
};

/** Remove a pool: its interfaces first, then its record. */
export function poolDelete(args) {
	let id = text(args.id);
	let one = cfg.pool(id);

	if (!one)
		return { ok: false, reason: 'no pool called ' + id };

	let removed = sections.remove(one);
	if (!removed.ok)
		return removed;

	cfg.forget(id);
	reloadSoon();
	load();

	return { ok: true, id: id, removed: removed.removed };
};

// ---------------------------------------------------------------------------
// The published object.

export function info() {
	let out = [];
	for (let st in each()) {
		let one = sessions.summary(st);
		one.rate = state.rates[st.pool.id] ? state.rates[st.pool.id] : { rxBps: 0, txBps: 0 };
		push(out, one);
	}

	return {
		name: 'bm-pppoe-pool',
		release: RELEASE,
		apiVersion: API_VERSION,
		enabled: state.main.enabled,
		counterInterval: state.main.counterInterval,
		redialAfter: state.main.redialAfter,
		started: STARTED,
		uptime: time() - STARTED,
		pools: out
	};
};

export function stats() {
	let events = 0;
	let redials = 0;
	let known = 0;

	for (let st in each()) {
		events += st.events;
		redials += st.redials;
		known += length(st.sessions);
	}

	return {
		rssKb: rssKb(),
		uptime: time() - STARTED,
		served: state.served,
		ticks: state.ticks,
		eventsHandled: events,
		redials: redials,
		sessions: known,
		// Named for what it is rather than for what it measures: this daemon has
		// no queue of work, it has a queue of things that are broken.
		queueDepth: known
	};
};

export function sessionRows(args) {
	let id = text(args.id);
	let scope = text(args.scope);
	let out = [];

	for (let st in each()) {
		if (length(id) && st.pool.id != id)
			continue;

		for (let row in sessions.rows(st, scope, ROW_LIMIT)) {
			row.pool = st.pool.id;
			push(out, row);
		}
	}

	return { sessions: out, limit: ROW_LIMIT };
};

/** start, stop or redial one session, or a named list of them. */
export function action(args) {
	let what = text(args.action);
	if (!(what in [ 'up', 'down', 'redial' ]))
		return { ok: false, reason: 'the action has to be up, down or redial' };

	let names = type(args.sections) == 'array' ? args.sections : [];
	if (!length(names))
		return { ok: false, reason: 'name at least one section' };

	if (length(names) > ROW_LIMIT)
		return { ok: false, reason: sprintf('at most %d sections in one call', ROW_LIMIT) };

	let done = [];

	for (let name in names) {
		let owner = null;
		for (let st in each()) {
			if (sessions.owns(st, name)) {
				owner = st;
				break;
			}
		}

		// Only sections this daemon knows are in one of its pools. A ubus call
		// naming an arbitrary interface must not become a way to take the
		// router's own WAN down.
		if (!owner)
			continue;

		if (what == 'down' || what == 'redial')
			call('network.interface.' + name, 'down', {});
		if (what == 'up' || what == 'redial')
			call('network.interface.' + name, 'up', {});

		push(done, name);
	}

	if (!length(done))
		return { ok: false, reason: 'none of those sections belong to a pool on this router' };

	return { ok: true, action: what, sections: done };
};

export function reconcileNow() {
	pass();
	return { ok: true, pools: length(state.order) };
};

function method(args, fn) {
	return {
		call: function(req) {
			state.served = state.served + 1;
			return fn(type(req.args) == 'object' ? req.args : {});
		},
		args: args
	};
};

export const methods = {
	info: method({}, () => info()),
	stats: method({}, () => stats()),

	sessions: method({ id: '', scope: '' }, (args) => sessionRows(args)),

	// `source` is a path, never the accounts themselves. See takePayload.
	pool_create: method({ id: '', source: '' }, (args) => poolCreate(args)),

	// Inline credentials, for callers that reach ubus over the socket rather
	// than by running `ubus call`. See INLINE_ACCOUNTS.
	pool_add: method({
		id: '', prefix: '', carrier: '', seq_from: 0, table_base: 0, vlan: 0, accounts: []
	}, (args) => poolAdd(args)),

	pool_append: method({ id: '', accounts: [] }, (args) => poolAppend(args)),
	pool_delete: method({ id: '' }, (args) => poolDelete(args)),

	action: method({ action: '', sections: [] }, (args) => action(args)),
	reconcile: method({}, () => reconcileNow())
};
