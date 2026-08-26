// Throughput, per member and summed by pool, from one file.
//
// /proc/net/dev has a line per interface with sixteen counters on it. Reading
// it is one open and one read whatever the number of interfaces, so a pool of
// five hundred costs the same as a pool of five - which is the point. The
// module used to do this sum with awk over SSH on every tick; here the answer
// is already where it is wanted, and it is kept per device as well as per
// pool because the new table shows a rate on every row.
//
// The counters are the kernel's own and they wrap. Nothing here tries to
// detect a wrap: a rate computed across one is wrong once every few days at
// gigabit speeds and self-corrects on the next pass, and the alternative -
// remembering enough to guess - is worse than a single wrong number.

import { readfile } from 'fs';

import { vlanOfSection } from 'bm.pppoe.config';

/**
 * Which pool a kernel device belongs to, and which member.
 *
 * A member's device is `pppoe-<prefix><vlan>` - netifd names it that way for
 * every `proto pppoe` interface - so the prefix comes off and the tail has to
 * be one of the pool's VLANs. Matching the member list and not just the
 * prefix keeps a ghost section's traffic out of the pool's numbers.
 */
function ownerOf(pools, name) {
	if (length(name) <= 6 || substr(name, 0, 6) != 'pppoe-')
		return null;

	let section = substr(name, 6);

	for (let one in pools) {
		let vlan = vlanOfSection(one.prefix, section);
		if (vlan === null)
			continue;

		for (let member in one.members) {
			if (member.vlan == vlan)
				return { id: one.id, section: section };
		}
	}

	return null;
};

/**
 * Read and total. `pools` is the record list; the answer is
 *
 *   { pools:   { id: { rxBytes, txBytes, rxPackets, txPackets, interfaces } },
 *     devices: { section: { rxBytes, txBytes } } }
 *
 * Null when /proc/net/dev could not be read, which a caller must show as "no
 * reading" rather than as zero - a graph that drops to the floor because one
 * read failed is a support call.
 */
export function read(pools) {
	let raw = readfile('/proc/net/dev');
	if (type(raw) != 'string')
		return null;

	let out = { pools: {}, devices: {} };

	for (let one in pools)
		out.pools[one.id] = { rxBytes: 0, txBytes: 0, rxPackets: 0, txPackets: 0, interfaces: 0 };

	for (let line in split(raw, '\n')) {
		// `  pppoe-fpt101: 1234 56 0 0 ...`
		let parts = split(trim(line), ':');
		if (length(parts) < 2)
			continue;

		let name = trim(parts[0]);
		if (!length(name))
			continue;

		let owner = ownerOf(pools, name);
		if (owner === null)
			continue;

		// join() rather than parts[1], because an interface name cannot
		// contain a colon but this is parsing a file and being wrong here is
		// silent.
		let fields = split(trim(join(':', slice(parts, 1))), /[ \t]+/);
		if (length(fields) < 10)
			continue;

		let rxBytes = int(fields[0]);
		let txBytes = int(fields[8]);

		let entry = out.pools[owner.id];
		entry.rxBytes += rxBytes;
		entry.rxPackets += int(fields[1]);
		entry.txBytes += txBytes;
		entry.txPackets += int(fields[9]);
		entry.interfaces++;

		out.devices[owner.section] = { rxBytes: rxBytes, txBytes: txBytes };
	}

	return out;
};

function bps(previous, current, seconds) {
	if (!previous || !current || seconds <= 0)
		return { rxBps: 0, txBps: 0 };

	let rx = current.rxBytes - previous.rxBytes;
	let tx = current.txBytes - previous.txBytes;

	// Negative differences come back as zero rather than as a negative rate:
	// the only ways to get one are a counter wrap or an interface
	// disappearing, and neither is traffic flowing backwards.
	return {
		rxBps: (rx > 0) ? (rx / seconds) : 0,
		txBps: (tx > 0) ? (tx / seconds) : 0
	};
};

/**
 * Bytes per second between two read() results, pool by pool and device by
 * device. Shapes match read(): `{ pools: { id: rate }, devices: { section:
 * rate } }`, with zeroes wherever either side is missing.
 */
export function rate(previous, current, seconds) {
	let out = { pools: {}, devices: {} };

	if (!current)
		return out;

	for (let id in current.pools) {
		out.pools[id] = bps(previous ? previous.pools[id] : null, current.pools[id], seconds);
	}

	for (let section in current.devices) {
		out.devices[section] = bps(previous ? previous.devices[section] : null, current.devices[section], seconds);
	}

	return out;
};
