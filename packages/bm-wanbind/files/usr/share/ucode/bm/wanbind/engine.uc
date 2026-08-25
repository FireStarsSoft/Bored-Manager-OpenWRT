// One instance's memory, and the two operations everything else is built from.
//
// The shape here is the whole performance argument. Binding a client is a hash
// lookup, a pop off a free list and one netlink message - it does not depend on
// how many clients there are - so a lease event costs the same on a router with
// four clients and one with four thousand. That is what the module cannot do
// from the far end of an SSH connection, where the cheapest way to find out
// anything is to read the whole router back and work it out again.
//
// The structures:
//
//   devices     mac -> what is known about it, bound or not
//   wanOwner    wan -> the mac holding it, so "is this WAN free" is a lookup
//   freeWans    an array plus a position index, so taking a named one, taking
//               any one, and putting one back are all constant time
//   waitOrder   a FIFO with a head cursor and lazy deletion, so leaving the
//               queue costs nothing and joining it is a push
//   prefFree    ip rule priorities that have been handed back, as a stack
//
// Nothing here reads the router. It is given what the router said and returns
// what should be done about it, which is what lets reconcile.uc be the only
// file that has to think about ordering.

import { debug, notice } from 'bm.log';
import { read as readState, write as writeState } from 'bm.state';

import * as netlink from 'bm.wanbind.netlink';

/**
 * State written to /etc/bm/state/ is versioned separately from the package.
 *
 * A file this build cannot read is discarded rather than guessed at: the cost
 * is every client's sticky WAN, which is one evening of drift, and the cost of
 * guessing wrong is rules pointing at tables that mean something else.
 */
const STATE_SCHEMA = 1;

// A state file is written when the sticky map or an assignment time changed,
// and no more often than this. Both change only when a client actually moves,
// so a settled router writes nothing at all - which matters on flash.
const PERSIST_INTERVAL = 60;

export function stateName(instance) {
	return 'wanbind-' + instance.id;
};

/** Fresh, empty, for one instance. */
export function create(instance) {
	let st = {
		instance: instance,
		lanCidr: null,
		ready: false,

		devices: {},
		sticky: {},
		assignedAt: {},
		wanOwner: {},

		freeWans: [],
		freePos: {},

		waiting: {},
		waitOrder: [],
		waitHead: 0,
		nextOrder: 1,

		held: {},
		wanErrorSince: {},

		prefFree: [],
		prefNext: instance.rulePrefBase,

		// WAN name -> routing table, as the last full pass found them. The fast
		// path binds without reading the router, so this is how it knows which
		// table a free WAN owns.
		tables: {},

		dirty: false,
		persistedAt: 0,

		events: 0,
		assigns: 0,
		releases: 0,
		lastPassMs: 0,
		lastPassAt: 0,
		lastReason: ''
	};

	let saved = readState(stateName(instance));
	if (type(saved) == 'object' && saved.schema === STATE_SCHEMA) {
		if (type(saved.sticky) == 'object')
			st.sticky = saved.sticky;
		if (type(saved.assignedAt) == 'object')
			st.assignedAt = saved.assignedAt;
		// A hold is the one thing here that no rule on the router records: a
		// held client has no rule, which is the whole point of holding it. So
		// unlike everything else this cannot be read back from the router, and
		// without it in the file `bmwan unassign` lasted only until the next
		// restart - and a restart is routine, since procd restarts the daemon
		// whenever /etc/config/bm_wanbind changes.
		if (type(saved.held) == 'object')
			st.held = saved.held;
		debug('instance ' + instance.id + ': remembered ' + length(st.sticky) +
			' sticky choice(s) and ' + length(st.held) + ' hold(s)');
	}

	return st;
};

/**
 * Write the remembered state back, if it has moved and it has been long enough.
 *
 * Three things are kept, and the third is the interesting one. The sticky map
 * and the assignment times are conveniences. The held set is not: a held client
 * has no rule on the router - that is what holding it means - so it is the only
 * decision here that cannot be re-derived from the rules on the next pass.
 *
 * Everything else - which client holds which WAN, at which ip rule priority -
 * is deliberately absent. It is written on the router itself, in the rules, and
 * read back from there; a second copy in a file would only be a chance for the
 * two to disagree.
 */
export function persist(st, now, force) {
	if (!st.dirty)
		return false;

	if (!force && now - st.persistedAt < PERSIST_INTERVAL)
		return false;

	let ok = writeState(stateName(st.instance), {
		schema: STATE_SCHEMA,
		sticky: st.sticky,
		assignedAt: st.assignedAt,
		// A key added rather than a schema bumped: an older build reading this
		// file ignores what it does not know, which is the right answer - it
		// simply does not hold anybody.
		held: st.held
	});

	if (ok) {
		st.dirty = false;
		st.persistedAt = now;
	}

	return ok;
};

// ---------------------------------------------------------------------------
// The free-WAN pool. Array plus position index: take-named, take-any and
// put-back are all constant time, and the order is netifd's rather than
// anything this file invents.

export function poolHas(st, name) {
	// A key that is not there reads as null, and `0` is a real position - so
	// this is a null test and not a truth test.
	return st.freePos[name] !== null;
};

export function poolPut(st, name) {
	if (poolHas(st, name))
		return;

	st.freePos[name] = length(st.freeWans);
	push(st.freeWans, name);
};

export function poolReset(st, names) {
	st.freeWans = [];
	st.freePos = {};

	for (let name in names)
		poolPut(st, name);
};

function poolTakeAt(st, index) {
	let name = st.freeWans[index];
	if (type(name) != 'string')
		return null;

	// Swap the last entry into the hole rather than shifting everything after
	// it. The order of a free pool is not a promise, and this is what makes
	// removal constant time rather than linear.
	let last = pop(st.freeWans);
	delete st.freePos[name];

	if (last != name) {
		st.freeWans[index] = last;
		st.freePos[last] = index;
	}

	return name;
}

export function poolTakeNamed(st, name) {
	if (!poolHas(st, name))
		return null;

	return poolTakeAt(st, st.freePos[name]);
};

/**
 * Any free WAN, preferring not to hand back the one being moved away from.
 *
 * The first entry rather than a random one. The module draws randomly so that
 * two instances started at once do not fill the same WANs first; here there is
 * one pool and one decider, and taking the front is both cheaper and easier to
 * reason about when somebody asks why a particular client got a particular
 * line.
 */
export function poolTakeAny(st, avoid) {
	if (!length(st.freeWans))
		return null;

	let index = 0;
	if (avoid && st.freeWans[0] == avoid && length(st.freeWans) > 1)
		index = 1;

	return poolTakeAt(st, index);
};

// ---------------------------------------------------------------------------
// ip rule priorities. A stack of returned ones, then never-used ones counting
// up from the instance's base. Reusing a returned priority keeps the range
// dense, so a router that has churned through ten thousand clients has not
// walked its range to the ceiling.

function prefTake(st) {
	if (length(st.prefFree))
		return pop(st.prefFree);

	if (st.prefNext >= st.instance.catchAllPref)
		return null;

	let pref = st.prefNext;
	st.prefNext = st.prefNext + 1;
	return pref;
}

function prefPut(st, pref) {
	if (type(pref) == 'int' && pref >= st.instance.rulePrefBase && pref < st.instance.catchAllPref)
		push(st.prefFree, pref);
}

/** Take a specific priority, because the router already has a rule at it. */
export function prefClaim(st, pref) {
	if (type(pref) != 'int' || pref < st.instance.rulePrefBase || pref >= st.instance.catchAllPref)
		return false;

	// Anything at or below a claimed priority is no longer a fresh one.
	if (pref >= st.prefNext)
		st.prefNext = pref + 1;

	for (let i = 0; i < length(st.prefFree); i++) {
		if (st.prefFree[i] == pref) {
			st.prefFree[i] = st.prefFree[length(st.prefFree) - 1];
			pop(st.prefFree);
			break;
		}
	}

	return true;
};

// ---------------------------------------------------------------------------
// The waiting queue. Order of arrival, which is the only fair answer when a
// pool has run out: the client that has been waiting longest goes next.

export function enqueue(st, mac, now) {
	if (st.waiting[mac] || st.held[mac])
		return;

	st.waiting[mac] = { enqueuedAt: now, order: st.nextOrder };
	st.nextOrder = st.nextOrder + 1;
	push(st.waitOrder, mac);
};

export function dequeue(st, mac) {
	// The array entry is left behind and skipped when it is reached. Removing
	// it would be a linear scan on a queue that may be thousands long, and the
	// only cost of leaving it is a string until the next compaction.
	delete st.waiting[mac];
};

/** The next MAC still genuinely waiting, or null. */
export function nextWaiting(st) {
	while (st.waitHead < length(st.waitOrder)) {
		let mac = st.waitOrder[st.waitHead];
		st.waitHead = st.waitHead + 1;

		if (st.waiting[mac])
			return mac;
	}

	// Everything before the head is gone; start the array again rather than
	// letting it grow for the life of the process.
	st.waitOrder = [];
	st.waitHead = 0;
	return null;
};

/**
 * Rebuild the queue array from the queue map, in arrival order.
 *
 * Called once at the end of a pass, never on the fast path. Rebuilding rather
 * than filtering is deliberate: the array and the map drift in exactly one way
 * - a client the drain loop took off the front and could not seat is still in
 * the map and no longer in the array - and rebuilding from the map is the only
 * form of this that cannot silently lose somebody. It is O(n log n) on the
 * number waiting, once every thirty seconds, against a fast path that stays
 * constant time.
 */
export function compactQueue(st) {
	let kept = [];
	for (let mac in st.waiting)
		push(kept, mac);

	sort(kept, (a, b) => st.waiting[a].order - st.waiting[b].order);

	st.waitOrder = kept;
	st.waitHead = 0;
};

// ---------------------------------------------------------------------------
// Binding and unbinding. Both are constant time and both do exactly one thing
// to the router.

/**
 * Give `mac` a WAN. Returns the WAN name, or null with the reason recorded.
 *
 * `options.prefer` is a hand-placed pin and outranks everything, including the
 * sticky choice: it is a request about this device rather than a policy about
 * all of them. `options.avoid` is what remap passes - the WAN that just failed.
 */
export function bind(st, mac, wanTables, options) {
	let device = st.devices[mac];
	if (!device || !length(device.ip))
		return null;

	if (device.wan)
		return device.wan;

	let opts = type(options) == 'object' ? options : {};
	let wan = null;

	if (opts.prefer)
		wan = poolTakeNamed(st, opts.prefer);

	if (!wan && !opts.prefer && st.instance.sticky && st.sticky[mac])
		wan = poolTakeNamed(st, st.sticky[mac]);

	if (!wan)
		wan = poolTakeAny(st, opts.avoid);

	if (!wan) {
		st.lastReason = 'every WAN in the pool is taken or unusable';
		return null;
	}

	let table = wanTables[wan];
	if (type(table) != 'int') {
		// Put it straight back: a WAN with no routing table cannot carry a rule,
		// and leaving it out of the pool would lose it until the next reset.
		poolPut(st, wan);
		st.lastReason = wan + ' has no routing table of its own';
		return null;
	}

	let pref = prefTake(st);
	if (pref === null) {
		poolPut(st, wan);
		st.lastReason = sprintf('no ip rule priority left between %d and %d',
			st.instance.rulePrefBase, st.instance.catchAllPref);
		return null;
	}

	if (!netlink.add(pref, device.ip + '/32', table)) {
		poolPut(st, wan);
		prefPut(st, pref);
		st.lastReason = 'the router refused the ip rule';
		return null;
	}

	// The clock is stamped only when the WAN is actually different. A client
	// that reconnects to the same line has not started a new session as far as
	// anybody reading the table is concerned, and resetting the counter every
	// time a laptop woke up would make "how long has this been bound" useless.
	let moved = st.sticky[mac] != wan;

	device.wan = wan;
	device.pref = pref;
	device.table = table;
	st.wanOwner[wan] = mac;
	dequeue(st, mac);

	if (moved) {
		st.sticky[mac] = wan;
		st.dirty = true;
	}

	if (moved || type(st.assignedAt[mac]) != 'int') {
		st.assignedAt[mac] = opts.now;
		st.dirty = true;
	}

	st.assigns = st.assigns + 1;
	return wan;
};

/**
 * Take `mac`'s WAN away and put both it and the priority back in the pools.
 *
 * The rule goes first. A WAN handed back to the pool while its old rule is
 * still on the router is a WAN two clients can hold, which is the one thing
 * one-to-one binding must never do.
 */
export function unbind(st, mac) {
	let device = st.devices[mac];
	if (!device || !device.wan)
		return false;

	if (type(device.pref) == 'int' && length(device.ip))
		netlink.remove(device.pref, device.ip + '/32', device.table);

	if (st.wanOwner[device.wan] == mac)
		delete st.wanOwner[device.wan];

	poolPut(st, device.wan);
	prefPut(st, device.pref);

	delete device.wan;
	delete device.pref;
	delete device.table;

	st.releases = st.releases + 1;
	return true;
};

/** The tidy-up when a rule write failed half way and nothing is on the router. */
function unbindAfterFailure(st, mac) {
	let device = st.devices[mac];
	if (!device)
		return;

	if (device.wan) {
		if (st.wanOwner[device.wan] == mac)
			delete st.wanOwner[device.wan];
		poolPut(st, device.wan);
	}

	prefPut(st, device.pref);
	delete device.wan;
	delete device.pref;
	delete device.table;
	st.lastReason = 'a rule write failed and the client was put back in the queue';
}

/**
 * Move a bound client onto a new address without letting go of its WAN.
 *
 * A client that renews onto a different address has not changed anything about
 * which line it should be on, so releasing and rebinding would put its WAN back
 * in the pool for an instant and hand it to whoever was next in the queue. The
 * new rule is written before the old one is removed, so at no moment does the
 * client have none.
 */
export function readdress(st, mac, ip) {
	let device = st.devices[mac];
	if (!device || !device.wan || device.ip == ip)
		return false;

	let pref = prefTake(st);
	if (pref === null) {
		// No room for the overlap. Correctness over elegance: take the old rule
		// off and write the new one at the same priority, which leaves a gap of
		// microseconds rather than leaving the client on its old address.
		netlink.remove(device.pref, device.ip + '/32', device.table);
		if (netlink.add(device.pref, ip + '/32', device.table)) {
			device.ip = ip;
			return true;
		}

		// Neither rule is on the router now. Give everything back and let the
		// client go round the queue again rather than pretending it is bound.
		// The address is recorded either way: the next pass has to try with
		// where the client actually is, not with where it used to be.
		device.ip = ip;
		unbindAfterFailure(st, mac);
		return false;
	}

	if (!netlink.add(pref, ip + '/32', device.table)) {
		prefPut(st, pref);
		return false;
	}

	netlink.remove(device.pref, device.ip + '/32', device.table);
	prefPut(st, device.pref);

	device.ip = ip;
	device.pref = pref;
	notice(sprintf('instance %s: %s moved to %s, still on %s', st.instance.id, mac, ip, device.wan));
	return true;
};

/** Record what a lease said, whether or not anything is done about it. */
export function seen(st, mac, ip, host, now) {
	let device = st.devices[mac];

	if (!device) {
		device = { mac: mac, ip: ip, host: host, lastSeenAt: now };
		st.devices[mac] = device;
		return device;
	}

	device.lastSeenAt = now;
	if (length(host))
		device.host = host;
	if (length(ip))
		device.ip = ip;

	return device;
};

/** Forget a client entirely: its rule, its WAN, its place in the queue. */
export function forget(st, mac) {
	unbind(st, mac);
	dequeue(st, mac);
	delete st.devices[mac];
};
