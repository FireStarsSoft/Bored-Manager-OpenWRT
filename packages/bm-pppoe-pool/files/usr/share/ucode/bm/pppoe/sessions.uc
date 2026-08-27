// What every member is doing, and which of them have been down too long.
//
// The row list is driven by the record, not by what netifd mentions. A pool
// of forty VLANs is forty rows whatever the router is doing: a member whose
// section is missing from /etc/config/network is a row saying `unwritten`,
// not a row that vanished - which is the difference between a table somebody
// can act on and a table that hides exactly the members that need acting on.
//
// The status machine, in order, first answer wins:
//
//   unwritten   the record names it, /etc/config/network does not
//   stopped     `option auto '0'` - somebody pressed Disable, and it stays
//               pressed across reboots and reconciles
//   up          netifd says up with an IPv4 address
//   error       netifd reports an error code (NO_PADO, PEER_AUTH_FAILED...)
//   dialing     netifd says pending
//   down        everything else
//
// Live state arrives two ways, same as bm-wanbind's lease table: netifd
// events the moment they happen, and the dump on the counter pass as the
// correction. The watchdog queue is longest-down-first and validates entries
// as they are reached, so a provider dropping a thousand sessions and
// bringing them back costs nothing at all.

import { debug, err, notice } from 'bm.log';

import { macFor, memberDeviceFor, netdevFor, sectionFor, tableFor, vlanOfSection } from 'bm.pppoe.config';

/** Everything known about one pool's members. */
export function create(one) {
	return {
		pool: one,
		// section name -> live state as netifd last told it
		sessions: {},
		// section name -> { auto } for sections present in /etc/config/network
		written: {},
		ghosts: [],
		carrierMac: '',
		downQueue: [],
		downHead: 0,
		events: 0,
		redials: 0,
		lastPassAt: 0,
		lastPassMs: 0
	};
};

/** Whether this interface name is one of this pool's members. */
export function owns(st, name) {
	let vlan = vlanOfSection(st.pool.prefix, name);
	if (vlan === null)
		return false;

	for (let member in st.pool.members) {
		if (member.vlan == vlan)
			return true;
	}

	return false;
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

/** Fold one dumped interface's state into the table. */
export function observe(st, entry, now) {
	if (!owns(st, entry.name))
		return false;

	let session = st.sessions[entry.name];
	if (!session) {
		session = { section: entry.name, up: false, pending: false, since: 0, downSince: 0, redials: 0 };
		st.sessions[entry.name] = session;
	}

	session.pending = entry.pending === true;
	session.errorCode = entry.errorCode;
	session.ipv4 = entry.ipv4;
	session.table = entry.table;
	session.autostart = entry.autostart !== false;

	if (entry.up === true) {
		if (!session.up)
			session.since = now - (type(entry.uptime) == 'int' ? entry.uptime : 0);
		session.up = true;
		session.downSince = 0;
		return true;
	}

	session.up = false;

	// A session that is dialling is not down, and one somebody disabled is
	// not either - the watchdog redialling a stopped session would be undoing
	// the one per-member state a person can set.
	if (!session.pending && session.autostart)
		markDown(st, entry.name, now);

	return true;
};

/**
 * One netifd event. Only the fact and the name are taken from it; everything
 * else is left to the next dump - `ifup` carries no address yet in some
 * protocols and `ifdown` carries nothing at all.
 */
export function event(st, action, name, now) {
	if (!owns(st, name))
		return false;

	st.events = st.events + 1;

	let session = st.sessions[name];
	if (!session) {
		session = { section: name, up: false, pending: false, since: 0, downSince: 0, redials: 0 };
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
		if (session.autostart !== false)
			markDown(st, name, now);
		return true;
	}

	// `ifupdate` and anything else: the dump will say.
	return true;
};

/**
 * Take the freshly read `{ written, ghosts }` from sections.stateOf().
 *
 * Ghosts are reported once per appearance rather than every pass: a warning
 * that repeats every five seconds is a warning nobody reads.
 */
export function observeWritten(st, state) {
	for (let name in state.ghosts) {
		if (!(name in st.ghosts)) {
			err(sprintf('section %s looks like pool %s but is in no record; leaving it alone',
				name, st.pool.id));
		}
	}

	st.written = state.written;
	st.ghosts = state.ghosts;
};

/** The status machine. One spelling, quoted by rows and by the summary. */
export function statusOf(st, section) {
	let written = st.written[section];
	if (!written)
		return 'unwritten';

	if (!written.auto)
		return 'stopped';

	let session = st.sessions[section];
	if (!session)
		return 'down';

	if (session.up && session.ipv4)
		return 'up';

	if (length(session.errorCode || ''))
		return 'error';

	if (session.pending)
		return 'dialing';

	return 'down';
};

/**
 * The members to redial now, at most `limit` of them, longest down first.
 * An entry whose session has come back, been disabled, or been superseded by
 * a later entry for the same section is dropped as it is reached.
 */
export function dueForRedial(st, after, limit, now) {
	if (after <= 0)
		return [];

	let out = [];

	while (st.downHead < length(st.downQueue) && length(out) < limit) {
		let entry = st.downQueue[st.downHead];
		let session = st.sessions[entry.section];

		// Stale: it came back up, went down again later, or is stopped now.
		if (!session || !session.downSince || session.downSince != entry.since ||
		    session.autostart === false) {
			st.downHead = st.downHead + 1;
			continue;
		}

		// A section no longer written is not netifd's to redial.
		if (!exists(st.written, entry.section)) {
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
 * Put a redialled session back at the end of the queue, so one that does not
 * come back is tried again one `redial_after` later rather than every pass.
 */
export function redialled(st, section, now) {
	let session = st.sessions[section];
	if (!session)
		return;

	st.redials = st.redials + 1;
	session.redials = (session.redials ? session.redials : 0) + 1;
	session.downSince = now;
	push(st.downQueue, { section: section, since: now });
};

/** Status counts for one pool, every member counted exactly once. */
export function tally(st) {
	let out = { members: length(st.pool.members), up: 0, dialing: 0, down: 0, error: 0, stopped: 0, unwritten: 0 };

	for (let member in st.pool.members) {
		let status = statusOf(st, sectionFor(st.pool.prefix, member.vlan));
		out[status] = out[status] + 1;
	}

	return out;
};

/**
 * One row per member, from the record, so the table never loses a row.
 *
 * `scope`: all, up, down (anything not up), attention (error and unwritten).
 * `rates` is the per-device bytes-per-second map from counters.rate().
 */
export function rows(st, scope, limit, rates, now) {
	let out = [];
	let wanted = length(scope) ? scope : 'all';
	let one = st.pool;

	for (let member in one.members) {
		if (length(out) >= limit)
			break;

		let section = sectionFor(one.prefix, member.vlan);
		let status = statusOf(st, section);

		if (wanted == 'attention' && !(status in [ 'error', 'unwritten' ]))
			continue;
		if (wanted == 'up' && status != 'up')
			continue;
		if (wanted == 'down' && status == 'up')
			continue;

		let session = st.sessions[section];
		let written = st.written[section];
		let rate = rates && exists(rates, section) ? rates[section] : null;

		push(out, {
			pool: one.id,
			section: section,
			vlan: member.vlan,
			device: memberDeviceFor(one, member.vlan),
			username: one.mode == 'single' ? member.username : one.username,
			mac: (one.macMode == 'auto' && member.vlan >= 1 && length(st.carrierMac))
				? macFor(st.carrierMac, one.id, member.vlan)
				: '',
			status: status,
			autostart: written ? written.auto : true,
			uptime: (session && session.up) ? (now - session.since) : 0,
			ip: (session && session.ipv4) ? session.ipv4.addr : '',
			table: tableFor(one.tableBase, member.vlan),
			errorCode: session ? (session.errorCode || '') : '',
			rxBps: rate ? rate.rxBps : 0,
			txBps: rate ? rate.txBps : 0,
			redials: (session && session.redials) ? session.redials : 0
		});
	}

	return out;
};

/** Log one line per pass, at debug, so a busy router can be watched. */
export function trace(st) {
	let counts = tally(st);
	debug(sprintf('pool %s: %d up, %d dialing, %d down, %d error, %d stopped, %d unwritten',
		st.pool.id, counts.up, counts.dialing, counts.down, counts.error, counts.stopped, counts.unwritten));
};

/** And one line at notice when a redial actually happens. */
export function announce(st, names) {
	if (!length(names))
		return;

	notice(sprintf('pool %s: redialling %d session(s) that have been down too long, starting with %s',
		st.pool.id, length(names), names[0]));
};

/** The kernel device a member's counters appear under. */
export function counterDevice(one, vlan) {
	return netdevFor(one.prefix, vlan);
};
