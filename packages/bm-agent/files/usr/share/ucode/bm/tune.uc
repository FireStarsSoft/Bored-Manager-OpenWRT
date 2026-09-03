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

import { err } from 'bm.log';

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
 * Current state: each tunable as the kernel holds it right now, what the
 * drop-in pins across reboots, conntrack usage for headroom, and the fw4
 * flow-offload flag. Values are null where the question could not be asked,
 * which a surface shows as unknown rather than as zero.
 */
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

		uci.set('firewall', section, 'flow_offloading', on ? '1' : '0');
		if (uci.commit('firewall') === null)
			return { ok: false, reason: 'the firewall configuration would not commit' };

		let reloaded = false;
		if (access('/etc/init.d/firewall', 'x')) {
			let handle = popen('/etc/init.d/firewall reload 2>&1', 'r');
			if (handle) {
				handle.read('all');
				reloaded = handle.close() === 0;
			}
		}

		return { ok: true, value: on, reloaded: reloaded };
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
