// The router-wide limits that decide whether thousands of sessions fit, and
// the one writer for them.
//
// Two tables overflow first when a router scales to thousands of PPPoE
// sessions or bound clients, and both fail by dropping traffic with one line
// in dmesg that nothing surfaces: conntrack ("nf_conntrack: table full,
// dropping packet") and the neighbour cache ("neighbour: arp_cache: neighbour
// table overflow!"). The values below are the four sysctls that size them.
//
// Everything here is an allowlist. A caller names a value for a key written
// in this file; nothing a caller sends can become a path or a shell word.
// Writes go straight to /proc/sys through the filesystem - no shell - and are
// persisted to one drop-in under /etc/sysctl.d/, which OpenWrt's sysctl init
// replays at boot. That file is runtime-owned the way /etc/bm/ is: no package
// ships it, apk never touches it, and uninstalling leaves it - it is the
// operator's configuration by then, exactly like /etc/config/bm_agent.
//
// The guard snapshot deliberately does not cover it. Snapshots are the UCI
// this project writes; a restore that quietly shrank conntrack back would
// undo a capacity fix nobody asked it to touch.

import { access, popen, readfile, writefile } from 'fs';
import { cursor } from 'uci';

import { debug, err } from 'bm.log';

export const CONF = '/etc/sysctl.d/60-bm-scale.conf';

// id -> where it lives and what a sane value looks like. Bounds are wide on
// purpose: they refuse typos (a conntrack_max of 3, a gc_thresh3 of 2^31),
// not tuning choices. Every entry costs kernel memory, which is why the
// ceiling is not "whatever fits in the field".
const TUNABLES = [
	{
		id: 'conntrack_max',
		sysctl: 'net.netfilter.nf_conntrack_max',
		path: '/proc/sys/net/netfilter/nf_conntrack_max',
		min: 16384,
		max: 4194304
	},
	{
		id: 'gc_thresh1',
		sysctl: 'net.ipv4.neigh.default.gc_thresh1',
		path: '/proc/sys/net/ipv4/neigh/default/gc_thresh1',
		min: 128,
		max: 1048576
	},
	{
		id: 'gc_thresh2',
		sysctl: 'net.ipv4.neigh.default.gc_thresh2',
		path: '/proc/sys/net/ipv4/neigh/default/gc_thresh2',
		min: 128,
		max: 1048576
	},
	{
		id: 'gc_thresh3',
		sysctl: 'net.ipv4.neigh.default.gc_thresh3',
		path: '/proc/sys/net/ipv4/neigh/default/gc_thresh3',
		min: 128,
		max: 1048576
	}
];

const COUNT_PATH = '/proc/sys/net/netfilter/nf_conntrack_count';

// What one tracked connection costs, near enough. A conntrack entry is about
// 320 bytes with its hash bucket, and the recommendation below is capped at
// what an eighth of this router's memory would hold if the table filled.
const CONNTRACK_BYTES = 320;

/** One /proc/sys value as an int, or null when it cannot be read. */
function readSysctl(path) {
	let text = readfile(path);
	if (type(text) != 'string')
		return null;

	let found = match(trim(text), /^([0-9]+)$/);
	return found ? int(found[1]) : null;
};

/** The drop-in parsed back, `sysctl name -> value`, {} when absent. */
function persisted() {
	let out = {};
	let text = readfile(CONF);
	if (type(text) != 'string')
		return out;

	for (let line in split(text, '\n')) {
		let found = match(trim(line), /^([a-z0-9._]+)=([0-9]+)$/);
		if (found)
			out[found[1]] = int(found[2]);
	}

	return out;
};

/** fw4's flow_offloading flag: true, false, or null when uci did not answer. */
/**
 * Whether fw4's software flow offload is on.
 *
 * Exported because it is a fact about the router that two other packages need
 * and neither should read for itself: a second reader of the same option is a
 * second answer waiting to disagree with this one.
 */
export function flowOffload() {
	try {
		let value = null;
		cursor().foreach('firewall', 'defaults', (section) => {
			value = section.flow_offloading;
		});

		if (value == null)
			return false;

		return type(value) == 'string' ? value == '1' : value == true;
	}
	catch (e) {
		return null;
	}
};

/**
 * The same for hardware offload, which is a different option and a different
 * question: not every target honours it, and on the ones that do it is a choice
 * rather than a fix - so this is reported and never offered as one.
 */
export function flowOffloadHw() {
	try {
		let uci = cursor();
		let value = null;

		uci.foreach('firewall', 'defaults', (entry) => {
			if (value == null)
				value = entry.flow_offloading_hw;
		});

		if (value == null)
			return false;

		let one = trim('' + value);

		return (one == '1' || one == 'true' || one == 'yes' || one == 'on');
	}
	catch (e) {
		return null;
	}
};

/**
 * Current state: each tunable as the kernel holds it right now, what the
 * drop-in pins across reboots, conntrack usage for headroom, and the fw4
 * flow-offload flag. Values are null where the question could not be asked,
 * which a surface shows as unknown rather than as zero.
 */
/** The next power of two at or above `value`, floored at 128. */
function pow2(value) {
	let n = 128;

	while (n < value && n < 4194304)
		n = n * 2;

	return n;
}

/** The largest power of two at or below `value`. */
function pow2Floor(value) {
	let n = 128;

	while (n * 2 <= value)
		n = n * 2;

	return n;
}

/**
 * What this router's kernel tables should be sized at for a given load.
 *
 * One function, and the module and the capacity report both read it rather than
 * carrying the arithmetic a second time - two copies of a formula are two
 * answers waiting to disagree in front of somebody deciding whether to raise a
 * limit.
 *
 * The memory ceiling is the part worth stating: a conntrack table is only free
 * while it is empty, and a full one at 320 bytes an entry is real memory. So
 * the recommendation is capped at what an eighth of this router's RAM would
 * hold, and says when that cap is what decided it - a 4 GB recommendation on a
 * 128 MB router is not advice, it is an out-of-memory reboot with a number
 * attached.
 */
/**
 * What this router is carrying: DHCP leases, and PPPoE members in the pool
 * configuration.
 *
 * Read here rather than asked of the two daemons, because `bmctl tune` runs on
 * a router where neither may be started and the answer still has to be the
 * right size.
 */
export function scale() {
	let clients = 0;
	let sessions = 0;

	let leases = readfile('/tmp/dhcp.leases');

	if (type(leases) == 'string') {
		for (let line in split(leases, chr(10))) {
			if (match(trim(line), /^[0-9]+[ 	]/))
				clients++;
		}
	}

	try {
		cursor().foreach('bm_pppoe', 'member', () => { sessions++; });
	}
	catch (e) {
		debug('cannot count pool members: ' + e);
	}

	return { clients: clients, sessions: sessions };
};

/** How much memory this router has, in kilobytes, or null. */
export function memory() {
	let text = readfile('/proc/meminfo');

	if (type(text) != 'string')
		return null;

	let found = match(text, /MemTotal:[ 	]+([0-9]+)/);

	return found ? int(found[1]) : null;
};

export function recommended(load, memTotalKb) {
	let clients = (type(load) == 'object' && type(load.clients) == 'int' && load.clients > 0) ? load.clients : 0;
	let sessions = (type(load) == 'object' && type(load.sessions) == 'int' && load.sessions > 0) ? load.sessions : 0;
	let flows = clients + sessions;

	let want = pow2((flows > 500) ? flows : 500) * 512;

	if (want < 262144)
		want = 262144;

	if (want > 4194304)
		want = 4194304;

	let cap = 4194304;
	let capped = false;

	if (type(memTotalKb) == 'int' && memTotalKb > 0) {
		cap = pow2Floor((memTotalKb * 1024) / 8 / CONNTRACK_BYTES);

		if (cap < 16384)
			cap = 16384;
	}

	if (want > cap) {
		want = cap;
		capped = true;
	}

	// The neighbour table is about clients and not about sessions: a PPP
	// interface is NOARP, so a dialled session adds no neighbour entry.
	let gc3 = pow2(clients * 4);

	if (gc3 < 8192)
		gc3 = 8192;

	// Bounded by what the sysctl itself accepts, which is the allowlist above:
	// a recommendation `apply` would refuse is not a recommendation.
	if (gc3 > 1048576)
		gc3 = 1048576;

	return {
		conntrack_max: want,
		gc_thresh1: gc3 / 4,
		gc_thresh2: gc3 / 2,
		gc_thresh3: gc3,
		flows: flows,
		mem_cap: cap,
		mem_capped: capped
	};
};

export function current() {
	let values = {};
	for (let entry in TUNABLES)
		values[entry.id] = readSysctl(entry.path);

	values.conntrack_count = readSysctl(COUNT_PATH);
	values.flow_offload = flowOffload();

	return { ok: true, values: values, persisted: persisted(), file: CONF };
};

/** Every reason `wanted` must not be applied, checked before anything is. */
function refusal(wanted) {
	let known = { flow_offload: true };
	for (let entry in TUNABLES)
		known[entry.id] = true;

	// A key nobody spelled here must refuse, not vanish: a caller that typoed
	// gc_tresh3 has to hear so, or the limit they meant to raise stays put.
	for (let name in keys(wanted)) {
		if (!exists(known, name))
			return 'unknown key "' + name + '" - one of: ' + join(', ', sort(keys(known)));
	}

	for (let entry in TUNABLES) {
		if (!exists(wanted, entry.id))
			continue;

		let value = wanted[entry.id];
		if (type(value) != 'int' || value < entry.min || value > entry.max) {
			return sprintf('%s has to be %d to %d', entry.id, entry.min, entry.max);
		}
	}

	// The three thresholds only make sense ordered: the kernel starts pruning
	// at thresh1, gets aggressive at thresh2 and refuses new entries at
	// thresh3, so an inversion silently disables one of the stages.
	let merged = {};
	for (let entry in TUNABLES) {
		merged[entry.id] = exists(wanted, entry.id)
			? wanted[entry.id]
			: readSysctl(entry.path);
	}

	let t1 = merged.gc_thresh1;
	let t2 = merged.gc_thresh2;
	let t3 = merged.gc_thresh3;
	if (t1 != null && t2 != null && t1 > t2)
		return 'gc_thresh1 cannot be above gc_thresh2';
	if (t2 != null && t3 != null && t2 > t3)
		return 'gc_thresh2 cannot be above gc_thresh3';

	// A table smaller than what is already in it drops live connections the
	// moment it is written. The module's own check said so before it sent the
	// call; nothing said so to `bmctl tune` or to LuCI, which reach this
	// function directly.
	if (exists(wanted, 'conntrack_max')) {
		let inUse = readSysctl(COUNT_PATH);

		if (inUse != null && wanted.conntrack_max < inUse) {
			return sprintf('conntrack_max %d is below the %d connections this router is tracking right now, and the ones that did not fit would be dropped',
				wanted.conntrack_max, inUse);
		}
	}

	return null;
};

/** Rewrite the drop-in so `changes` survive a reboot; keeps other lines. */
function persist(changes) {
	let pinned = persisted();
	for (let name in changes)
		pinned[name] = changes[name];

	let lines = [
		'# Written by bm-agent (bmctl tune / ubus bm.agent tune_set).',
		'# Sized for large PPPoE/WAN-binding deployments; replayed at boot.'
	];
	for (let name in sort(keys(pinned)))
		push(lines, name + '=' + pinned[name]);

	let written = writefile(CONF, join('\n', lines) + '\n');
	return written != null;
};

/**
 * fw4's software flow offload, written through UCI so it survives sysupgrade
 * config backups the way every other firewall option does. Reload goes
 * through popen so a harness with a stubbed filesystem skips it instead of
 * reloading the machine the tests run on.
 */
function setFlowOffload(on) {
	try {
		let uci = cursor();
		let section = null;
		uci.foreach('firewall', 'defaults', (entry) => {
			section = entry['.name'];
		});

		if (!section)
			return { ok: false, reason: 'no firewall defaults section, so flow offload has nowhere to go' };

		let was = uci.get('firewall', section, 'flow_offloading');

		uci.set('firewall', section, 'flow_offloading', on ? '1' : '0');
		if (uci.commit('firewall') === null)
			return { ok: false, reason: 'the firewall configuration would not commit' };

		if (!access('/etc/init.d/firewall', 'x')) {
			// Written and not applied, which is the honest answer: the flag is
			// in force at the next boot and is not now.
			return { ok: true, value: on, reloaded: false,
				reason: 'there is no /etc/init.d/firewall to reload, so the setting is written and not in force until the next boot' };
		}

		let handle = popen('/etc/init.d/firewall reload 2>&1', 'r');

		if (!handle) {
			return { ok: true, value: on, reloaded: false,
				reason: 'the firewall could not be reloaded, so the setting is written and not in force yet' };
		}

		handle.read('all');

		if (handle.close() === 0)
			return { ok: true, value: on, reloaded: true, reason: '' };

		// fw4 refused the ruleset and the option is already committed, so on a
		// router whose kernel has no flowtable this left a firewall that fails
		// to load at the next boot - which is a router with no firewall at all.
		// Put back, committed again, reloaded again, and the caller is told,
		// rather than handed an `ok` that only meant "written".
		if (was == null)
			uci.delete('firewall', section, 'flow_offloading');
		else
			uci.set('firewall', section, 'flow_offloading', was);

		uci.commit('firewall');

		let again = popen('/etc/init.d/firewall reload 2>&1', 'r');

		if (again) {
			again.read('all');
			again.close();
		}

		return {
			ok: false,
			value: !on,
			reloaded: false,
			reason: 'fw4 would not load the ruleset with flow offload ' + (on ? 'on' : 'off') + ', so the setting was put back. The kernel may have no flowtable support - kmod-nft-offload is what provides it'
		};
	}
	catch (e) {
		return { ok: false, reason: 'flow offload could not be written: ' + e };
	}
};

/**
 * Apply an allowlisted subset and pin it across reboots.
 *
 * The write is /proc/sys through the filesystem and is verified by reading it
 * back, because a kernel without conntrack loaded answers the write with an
 * error nothing else would report. `flow_offload` is the one non-sysctl here:
 * it is UCI (fw4), so it commits and reloads the firewall - through the shell
 * only for the reload, with nothing of the caller's in the command.
 */
export function apply(wanted) {
	let reason = refusal(wanted);
	if (reason)
		return { ok: false, reason: reason };

	let applied = {};
	let pinning = {};
	let failed = [];

	for (let entry in TUNABLES) {
		if (!exists(wanted, entry.id))
			continue;

		writefile(entry.path, sprintf('%d\n', wanted[entry.id]));
		let now = readSysctl(entry.path);

		if (now == wanted[entry.id]) {
			applied[entry.id] = now;
			pinning[entry.sysctl] = now;
		}
		else {
			push(failed, entry.id);
		}
	}

	if (length(failed)) {
		err('tune: ' + join(', ', failed) + ' would not apply');
		return {
			ok: false,
			reason: join(', ', failed) + ' would not apply - the kernel refused the write, ' +
				'which usually means the matching module (nf_conntrack) is not loaded',
			applied: applied
		};
	}

	let pinnedOk = true;
	if (length(keys(pinning)))
		pinnedOk = persist(pinning);

	let offload = null;
	if (exists(wanted, 'flow_offload') && type(wanted.flow_offload) == 'bool') {
		offload = setFlowOffload(wanted.flow_offload);
		if (!offload.ok)
			return { ok: false, reason: offload.reason, applied: applied, persisted: pinnedOk };
	}

	return {
		ok: true,
		applied: applied,
		persisted: pinnedOk,
		file: CONF,
		flowOffload: offload ? offload.value : null,
		reloaded: offload ? offload.reloaded : false
	};
};
