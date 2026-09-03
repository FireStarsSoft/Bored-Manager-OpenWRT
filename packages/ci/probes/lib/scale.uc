// A router with five hundred of everything, built once and shared.
//
// The probes next door describe a box with four WANs and a handful of bindings,
// which is the right size for asking whether the arithmetic is correct. It is
// the wrong size for every question this file exists for: a pass that opens one
// cursor and a pass that opens five behave identically at four WANs, and the
// difference between them is the difference between a daemon that holds five
// hundred PPPoE sessions and one that spends its interval re-reading
// /etc/config/network.
//
// So the fixtures here are large and boring on purpose. Nothing in this file
// asserts anything; it builds the router the scale probes then measure the
// daemon against, and the counters it exposes - how many dumps, how many
// status calls - are what those probes read.

const LANS = [
	{ name: 'lan',        device: 'br-lan',   address: '10.9.0.1' },
	{ name: 'LAN_WIRED',  device: 'eth0',     address: '10.9.1.1' },
	{ name: 'guest',      device: 'br-guest', address: '10.9.2.1' },
	{ name: 'iot',        device: 'br-iot',   address: '10.9.3.1' }
];

// Where netifd's own three rules per routing table sit. Real numbers are
// netifd's to choose and it does not promise them; what the daemon recognises
// is the *shape* - the interface's own address to its table, traffic addressed
// to it to its table, and one bare rule for what the router itself sends. These
// bases keep all three clear of this package's own bands, so a fixture cannot
// prove the classifier right by putting netifd's rules where it was going to
// guess anyway.
const NETIFD_SRC_BASE = 10000;
const NETIFD_DST_BASE = 20000;
const NETIFD_OUT_BASE = 90000;

// The first routing table a dialled session gets, matching the pool default.
const WAN_TABLE_BASE = 10000;

/** `p017`, and the device is `pppoe-p017`. */
export function wanName(index) {
	return sprintf('p%03d', index);
};

export function wanDevice(index) {
	return 'pppoe-' + wanName(index);
};

/**
 * The address the ISP handed session `index`.
 *
 * Spread over a /16 so five hundred of them are five hundred distinct hosts:
 * addresses that repeated would make two interfaces indistinguishable to the
 * rule classifier, which is a fixture proving something about itself.
 */
export function wanAddress(index) {
	return sprintf('100.70.%d.%d', index / 256, index % 256);
};

export function wanTable(index) {
	return WAN_TABLE_BASE + index;
};

/** One LAN of the four, wrapping - `lanOf(5)` is the second. */
export function lanOf(index) {
	return LANS[index % length(LANS)];
};

/** `10.9.2.43` - an address on one of the four LANs, spread evenly. */
export function clientAddress(index) {
	let lan = lanOf(index);
	let host = 10 + (index / length(LANS));

	return sprintf('%s.%d', substr(lan.address, 0, length(lan.address) - 2), host);
};

export function clientMac(index) {
	return sprintf('02:00:%02x:%02x:%02x:01', (index / 65536) % 256, (index / 256) % 256, index % 256);
};

function lanEntry(one) {
	return {
		interface: one.name,
		proto: 'static',
		device: one.device,
		l3_device: one.device,
		up: true,
		uptime: 40000,
		'ipv4-address': [ { address: one.address, mask: 24 } ]
	};
}

function wanEntry(index) {
	return {
		interface: wanName(index),
		proto: 'pppoe',
		device: sprintf('eth1.%d', 100 + index),
		l3_device: wanDevice(index),
		up: true,
		uptime: 900 + index,
		ip4table: sprintf('%d', wanTable(index)),
		'ipv4-address': [ { address: wanAddress(index), mask: 32 } ]
	};
}

/**
 * The netifd dump: `nLan` of the four LANs, then `nPppoe` dialled sessions.
 *
 * The order is the order netifd answers in - LANs first, because they came up
 * at boot - and it matters to nothing here except that a reader which happened
 * to depend on it would be depending on something a real router will not keep.
 */
export function router(nLan, nPppoe) {
	let out = [];

	for (let i = 0; i < nLan && i < length(LANS); i++)
		push(out, lanEntry(LANS[i]));

	for (let i = 1; i <= nPppoe; i++)
		push(out, wanEntry(i));

	return out;
};

/**
 * The three rules the kernel holds for every interface with a table.
 *
 * Written the way a rule dump comes back rather than the way `ip rule` prints:
 * the bare third one carries no selector at all over netlink - not even the
 * `iif lo` the command line shows - which is the one detail that makes this
 * fixture worth having rather than inventing.
 */
export function netifdRules(entries) {
	let out = [];
	let n = 0;

	for (let entry in entries) {
		let table = 0;

		if (type(entry.ip4table) == 'string')
			table = int(entry.ip4table);

		if (!table)
			continue;

		let address = entry['ipv4-address'][0].address;

		push(out, { priority: NETIFD_SRC_BASE + n, src: address + '/32', table: table, action: 1 });
		push(out, { priority: NETIFD_DST_BASE + n, dst: address + '/32', table: table, action: 1 });
		push(out, { priority: NETIFD_OUT_BASE + n, table: table, action: 1 });

		n++;
	}

	return out;
};

/** The kernel's own three, which every router has and nothing here writes. */
export function kernelRules() {
	return [
		{ priority: 0, table: 255, action: 1 },
		{ priority: 32766, table: 254, action: 1 },
		{ priority: 32767, table: 253, action: 1 }
	];
};

/**
 * `count` one-to-one bindings in /etc/config/bm_wanbind, as a router would hold
 * them after somebody created them one at a time.
 *
 * Every fourth follows a MAC rather than an address, because the two are read
 * by different code all the way down to the rule that comes out, and a fixture
 * of five hundred addresses would exercise one half of it five hundred times.
 */
export function manualSections(uci, count, prefBase, wans) {
	let base = (type(prefBase) == 'int' && prefBase > 0) ? prefBase : 19000;
	let sessions = (type(wans) == 'int' && wans > 0) ? wans : 1;
	let out = [];

	for (let i = 0; i < count; i++) {
		let id = sprintf('bmdir_%03d', i);
		let slot = (i % sessions) + 1;

		uci.set('bm_wanbind', id, 'direct');
		uci.set('bm_wanbind', id, 'name', sprintf('desk %d', i));
		uci.set('bm_wanbind', id, 'enabled', '1');
		uci.set('bm_wanbind', id, 'wan', wanName(slot));
		uci.set('bm_wanbind', id, 'lan', lanOf(i).name);
		uci.set('bm_wanbind', id, 'when_down', 'hold');
		uci.set('bm_wanbind', id, 'pref', sprintf('%d', base + i));
		uci.set('bm_wanbind', id, 'table', sprintf('%d', wanTable(slot)));

		if (i % 4 == 3)
			uci.set('bm_wanbind', id, 'mac', clientMac(i));
		else
			uci.set('bm_wanbind', id, 'ip', clientAddress(i));

		push(out, id);
	}

	return out;
};

/**
 * The `config interface` sections the pool daemon writes for its members.
 *
 * A dialled session is a network section carrying its own routing table, and
 * the preparation half reads /etc/config/network rather than netifd for that
 * number - what netifd is using now and what it will use after the next reload
 * are different questions, and the one being answered here is what to write.
 */
export function networkSections(uci, count) {
	for (let i = 1; i <= count; i++) {
		let name = wanName(i);

		uci.set('network', name, 'interface');
		uci.set('network', name, 'proto', 'pppoe');
		uci.set('network', name, 'device', sprintf('eth1.%d', 100 + i));
		uci.set('network', name, 'ip4table', sprintf('%d', wanTable(i)));
	}

	return count;
};

/** `count` rows of /tmp/dhcp.leases, in dnsmasq's own format. */
export function leases(count) {
	let lines = [];

	for (let i = 0; i < count; i++) {
		push(lines, sprintf('1893456000 %s %s client%03d *',
			clientMac(i), clientAddress(i), i));
	}

	push(lines, '');

	return join('\n', lines);
};

// What the daemon asked netifd for, rather than what netifd answered. One dump
// per pass is the whole design of the pass rewrite; one per instance is the
// same behaviour and four times the cost, and nothing but a counter tells them
// apart.
let calls = { dump: 0, status: 0, reload: 0, other: 0 };

export function busCounts() {
	return { ...calls };
};

export function resetBusCounts() {
	calls = { dump: 0, status: 0, reload: 0, other: 0 };
};

/**
 * A netifd that answers from `entries`, and counts being asked.
 *
 * `opts.dumpNull` is netifd not answering the dump at all, which is a state the
 * daemon has to survive without deciding the router has no interfaces;
 * `opts.statusNull` is the same for the per-interface read.
 */
export function busFor(entries, opts) {
	let options = (type(opts) == 'object') ? opts : {};
	let byName = {};

	for (let entry in entries)
		byName[entry.interface] = entry;

	return {
		call: function(object, method, args) {
			if (object == 'network.interface' && method == 'dump') {
				calls.dump++;
				return options.dumpNull ? null : { interface: entries };
			}

			if (object == 'network' && method == 'reload') {
				calls.reload++;
				return {};
			}

			// `network.interface.<name> status`, which is one interface rather
			// than the whole dump - the read left in place for the two
			// questions that are genuinely about one WAN.
			let prefix = 'network.interface.';

			if (substr(object, 0, length(prefix)) == prefix && method == 'status') {
				calls.status++;

				if (options.statusNull)
					return null;

				let name = substr(object, length(prefix));
				return exists(byName, name) ? byName[name] : null;
			}

			calls.other++;
			return null;
		}
	};
};
