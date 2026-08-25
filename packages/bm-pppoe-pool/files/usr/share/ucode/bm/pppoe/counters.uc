// Throughput, summed by pool, from one file.
//
// /proc/net/dev has a line per interface with sixteen counters on it. Reading
// it is one open and one read whatever the number of interfaces, so a pool of
// five thousand costs the same as a pool of five - which is the point. The
// module does the same sum with awk and then has to carry the result back over
// SSH on every tick; here the answer is already where it is wanted.
//
// The counters are the kernel's own and they wrap. Nothing here tries to detect
// a wrap: a rate computed across one is wrong once every few days at gigabit
// speeds and self-corrects on the next pass, and the alternative - remembering
// enough to guess - is worse than a single wrong number in a graph.

import { readfile } from 'fs';

/**
 * A PPPoE session's kernel device is `pppoe-<section>`.
 *
 * netifd names it that way for every `proto pppoe` interface, which is what
 * makes the sum a prefix match rather than a lookup: everything belonging to
 * pool `ppp` is `pppoe-ppp` followed by five digits.
 */
export function devicePrefix(prefix) {
	return 'pppoe-' + prefix;
};

/**
 * Which pool a device belongs to, or null.
 *
 * The same test `sessions.owns` makes, and it has to be: a pool owns a prefix
 * *and a sequence range*, so two pools sharing a prefix with different ranges
 * are a perfectly ordinary way to add capacity. Matching on the prefix alone
 * gave whichever pool came first in iteration order every byte of both, and the
 * other a flat zero - in `bmpppoe status` and in the app's throughput graph.
 *
 * The name is a device (`pppoe-ppp00007`), so the device prefix comes off
 * first and what is left has to be exactly the pool's prefix and five digits.
 */
function poolOf(pools, name) {
	for (let one in pools) {
		let want = devicePrefix(one.prefix);
		if (length(name) != length(want) + 5)
			continue;
		if (substr(name, 0, length(want)) != want)
			continue;

		let tail = substr(name, length(want));
		if (!match(tail, /^[0-9]{5}$/))
			continue;

		let seq = int(tail);
		if (seq >= one.seqFrom && seq <= one.seqTo)
			return one.id;
	}

	return null;
}

/**
 * Read and total by pool.
 *
 * `pools` is a list of `{ id, prefix, seqFrom, seqTo }`; the answer is
 * `{ poolId: { rxBytes, txBytes, rxPackets, txPackets, interfaces } }`. Null
 * when /proc/net/dev could not be read, which a caller must show as "no
 * reading" rather than as zero - a graph that drops to the floor because one
 * read failed is a support call.
 */
export function read(pools) {
	let text = readfile('/proc/net/dev');
	if (type(text) != 'string')
		return null;

	let out = {};

	for (let one in pools)
		out[one.id] = { rxBytes: 0, txBytes: 0, rxPackets: 0, txPackets: 0, interfaces: 0 };

	for (let line in split(text, '\n')) {
		// `  pppoe-ppp00007: 1234 56 0 0 ...`
		let parts = split(trim(line), ':');
		if (length(parts) < 2)
			continue;

		let name = trim(parts[0]);
		if (!length(name))
			continue;

		let id = poolOf(pools, name);
		if (id === null)
			continue;

		// join() rather than parts[1], because an interface name cannot contain
		// a colon but this is parsing a file and being wrong here is silent.
		let fields = split(trim(join(':', slice(parts, 1))), /[ \t]+/);
		if (length(fields) < 10)
			continue;

		let entry = out[id];
		entry.rxBytes += int(fields[0]);
		entry.rxPackets += int(fields[1]);
		entry.txBytes += int(fields[8]);
		entry.txPackets += int(fields[9]);
		entry.interfaces++;
	}

	return out;
};

/**
 * Bytes per second between two readings.
 *
 * Negative differences come back as zero rather than as a negative rate: the
 * only ways to get one are a counter wrap or an interface disappearing, and
 * neither is something a rate should report as traffic flowing backwards.
 */
export function rate(previous, current, seconds) {
	if (!previous || !current || seconds <= 0)
		return { rxBps: 0, txBps: 0 };

	let rx = current.rxBytes - previous.rxBytes;
	let tx = current.txBytes - previous.txBytes;

	return {
		rxBps: (rx > 0) ? (rx / seconds) : 0,
		txBps: (tx > 0) ? (tx / seconds) : 0
	};
};
