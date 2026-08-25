// What every session is doing, and which of them have been down too long.
//
// Two sources, the same arrangement as the lease table in bm-wanbind:
//
//   events   `ubus listen network.interface` fires the moment netifd brings a
//            session up or drops it, which on a pool of five thousand is the
//            difference between knowing and polling
//   the dump `network.interface dump` on the counter pass, which is the whole
//            truth and is what corrects anything the events missed
//
// The watchdog queue is the reason the down list is kept as a queue rather than
// scanned. A session goes down, it is pushed with the time it went down; times
// only ever increase, so the queue is already in "down longest first" order and
// the front of it is the next candidate to redial. Entries are validated when
// they are reached rather than removed when a session comes back, so a session
// recovering costs nothing at all - which matters when a provider drops four
// thousand of them at once and brings them back a minute later.
//
// Redialling is the last resort, not the first. netifd retries a PPPoE session
// by itself and is better at it than anything here; `redial_after` is for the
// sessions it has given up on, which is why the default is two minutes rather
// than five seconds.

import { debug, notice } from 'bm.log';

import { sectionName } from 'bm.pppoe.config';

/** Everything known about one pool's sessions. */
export function create(one) {
	return {
		pool: one,
		sessions: {},
		// section -> the time it was last seen down, and the queue of the same
		// in the order they went down.
		downQueue: [],
		downHead: 0,
		events: 0,
		redials: 0,
		lastPassMs: 0,
		lastPassAt: 0
	};
};

/** Whether this interface name belongs to this pool. */
export function owns(st, name) {
	let one = st.pool;

	if (length(name) != length(one.prefix) + 5)
		return false;

	if (substr(name, 0, length(one.prefix)) != one.prefix)
		return false;

	let tail = substr(name, length(one.prefix));
	if (!match(tail, /^[0-9]{5}$/))
		return false;

	let seq = int(tail);
	return seq >= one.seqFrom && seq <= one.seqTo;
};

function markDown(st, section, now) {
	let session = st.sessions[section];

	// Already down and already queued: nothing to do. Re-queueing on every
	// event would let a flapping session fill the queue on its own.
	if (session.downSince)
		return;

	session.downSince = now;
	push(st.downQueue, { section: section, since: now });
};

/** Fold one interface's state into the table. */
export function observe(st, entry, now) {
	if (!owns(st, entry.name))
		return false;

	let session = st.sessions[entry.name];
	if (!session) {
		session = { section: entry.name, up: false, pending: false, since: 0, downSince: 0 };
		st.sessions[entry.name] = session;
	}

	session.pending = entry.pending === true;
	session.errorCode = entry.errorCode;
	session.ipv4 = entry.ipv4;
	session.table = entry.table;

	if (entry.up === true) {
		if (!session.up)
			session.since = now - (type(entry.uptime) == 'int' ? entry.uptime : 0);
		session.up = true;
		session.downSince = 0;
		return true;
	}

	session.up = false;
	// A session that is dialling is not a session that is down. Every pool has
	// some of them at any moment, and a watchdog that redialled them would be
	// interrupting exactly the thing it is trying to cause.
	if (!session.pending)
		markDown(st, entry.name, now);

	return true;
};

/**
 * One netifd event.
 *
 * Only the fact and the name are taken from it; everything else is left to the
 * next dump. `ifup` carries no address yet in some protocols and `ifdown`
 * carries nothing at all, and a table built from half-filled events would
 * disagree with the router in ways nobody could explain.
 */
export function event(st, action, name, now) {
	if (!owns(st, name))
		return false;

	st.events = st.events + 1;

	let session = st.sessions[name];
	if (!session) {
		session = { section: name, up: false, pending: false, since: 0, downSince: 0 };
		st.sessions[name] = session;
	}

	if (action == 'ifup') {
		session.up = true;
		session.pending = false;
		session.since = now;
		session.downSince = 0;
		return true;
	}

	if (action == 'ifdown') {
		session.up = false;
		session.pending = false;
		markDown(st, name, now);
		return true;
	}

	// `ifupdate` and anything else: the dump will say.
	return true;
};

/**
 * The sessions to redial now, at most `limit` of them.
 *
 * Front of the queue first, which is longest-down first. An entry whose session
 * has come back, or which has been superseded by a later one for the same
 * section, is dropped as it is reached - which is what makes recovery free.
 */
export function dueForRedial(st, after, limit, now) {
	if (after <= 0)
		return [];

	let out = [];

	while (st.downHead < length(st.downQueue) && length(out) < limit) {
		let entry = st.downQueue[st.downHead];
		let session = st.sessions[entry.section];

		// Stale: it came back up, or it went down again later and was queued
		// again with the newer time.
		if (!session || !session.downSince || session.downSince != entry.since) {
			st.downHead = st.downHead + 1;
			continue;
		}

		// The front has not waited long enough, so nothing behind it has either.
		if (now - entry.since < after)
			break;

		st.downHead = st.downHead + 1;
		push(out, entry.section);
	}

	// Everything before the head is spent; start the array again rather than
	// letting it grow for the life of the process.
	if (st.downHead >= length(st.downQueue)) {
		st.downQueue = [];
		st.downHead = 0;
	}

	return out;
};

/**
 * Put a redialled session back at the end of the queue.
 *
 * Called after the redial is asked for, with the current time, so a session
 * that does not come back is tried again one `redial_after` later rather than
 * on every pass. Without this a permanently dead account would be redialled as
 * fast as the watchdog runs, for ever.
 */
export function redialled(st, section, now) {
	let session = st.sessions[section];
	if (!session)
		return;

	st.redials = st.redials + 1;
	session.downSince = now;
	push(st.downQueue, { section: section, since: now });
};

/** How the pool looks, for a table or a summary. */
export function summary(st) {
	let up = 0;
	let dialing = 0;
	let down = 0;
	let error = 0;

	for (let name in st.sessions) {
		let session = st.sessions[name];
		if (session.up)
			up++;
		else if (session.pending)
			dialing++;
		else if (session.errorCode && length(session.errorCode))
			error++;
		else
			down++;
	}

	return {
		id: st.pool.id,
		prefix: st.pool.prefix,
		carrier: st.pool.carrier,
		count: st.pool.count,
		// The range, so that anything offering to extend a pool can say where
		// the next session would be numbered rather than making somebody work
		// it out from the count.
		seqFrom: st.pool.seqFrom,
		seqTo: st.pool.seqTo,
		tableBase: st.pool.tableBase,
		known: length(st.sessions),
		up: up,
		dialing: dialing,
		down: down,
		error: error,
		redials: st.redials,
		events: st.events,
		lastPassAt: st.lastPassAt,
		lastPassMs: st.lastPassMs
	};
};

/**
 * One row per session, optionally only the ones worth looking at.
 *
 * `scope` defaults to attention, and that is deliberate rather than lazy: five
 * thousand rows of "up" is not something anybody reads, and the question being
 * asked of this table is almost always "what is wrong".
 */
export function rows(st, scope, limit) {
	let out = [];
	let wanted = length(scope) ? scope : 'attention';

	for (let seq = st.pool.seqFrom; seq <= st.pool.seqTo; seq++) {
		if (length(out) >= limit)
			break;

		let name = sectionName(st.pool.prefix, seq);
		let session = st.sessions[name];

		let state = 'unknown';
		if (session)
			state = session.up ? 'up' : (session.pending ? 'dialing' : (length(session.errorCode || '') ? 'error' : 'down'));

		if (wanted == 'attention' && (state == 'up' || state == 'dialing'))
			continue;
		if (wanted == 'up' && state != 'up')
			continue;
		if (wanted == 'down' && state == 'up')
			continue;

		push(out, {
			section: name,
			seq: seq,
			state: state,
			// Deliberately no username and never a password. The module holds the
			// account list; this side only ever knew the credentials for as long
			// as it took to write them into uci.
			ipv4: session && session.ipv4 ? session.ipv4.addr : '',
			table: session ? session.table : null,
			since: session ? session.since : 0,
			downSince: session ? session.downSince : 0,
			error: session ? (session.errorCode || '') : ''
		});
	}

	return out;
};

/** Log one line per pass, at debug, so a busy router can be watched. */
export function trace(st) {
	let one = summary(st);
	debug(sprintf('pool %s: %d up, %d dialing, %d down, %d error',
		one.id, one.up, one.dialing, one.down, one.error));
};

/** And one line at notice when a redial actually happens. */
export function announce(st, sections) {
	if (!length(sections))
		return;

	notice(sprintf('pool %s: redialling %d session(s) that have been down too long, starting with %s',
		st.pool.id, length(sections), sections[0]));
};
