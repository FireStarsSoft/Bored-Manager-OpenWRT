// A netifd carrying a pool of dialled sessions, for the probes only.
//
// The pool daemon's whole hot path is `network.interface dump` folded into its
// session tables, and the shape of that reply is what decides whether the fold
// is a lookup or a walk. At three members either is instant. At five hundred,
// on a router that also has five hundred interfaces of its own, one of them is
// a quarter of a million comparisons per pass.
//
// So this builds the reply at that size, with the fields the daemon reads and
// nothing else, and counts being asked for it.

let calls = { dump: 0, status: 0, other: 0 };

export function counts() {
	return { ...calls };
};

export function resetCounts() {
	calls = { dump: 0, status: 0, other: 0 };
};

/** One dialled session, as netifd reports it. */
export function dumpEntry(section, vlan, table, up) {
	let entry = {
		interface: section,
		proto: 'pppoe',
		device: sprintf('eth1.%d', vlan),
		l3_device: 'pppoe-' + section,
		up: (up !== false),
		pending: false,
		autostart: true,
		uptime: (up !== false) ? 900 : 0,
		ip4table: table
	};

	if (up !== false) {
		entry['ipv4-address'] = [ {
			address: sprintf('100.70.%d.%d', vlan / 256, vlan % 256),
			mask: 32
		} ];
	}
	else {
		entry.errors = [ { code: 'AUTH_FAILED' } ];
	}

	return entry;
};

/**
 * A whole pool, plus however many interfaces belong to somebody else.
 *
 * The foreign ones are the point of the fixture rather than decoration: a fold
 * that placed an interface by walking every pool's member list pays for them on
 * every pass, and a lookup does not.
 */
export function dumpOf(prefix, firstVlan, count, opts) {
	let options = (type(opts) == 'object') ? opts : {};
	let out = [];

	push(out, {
		interface: 'lan',
		proto: 'static',
		device: 'br-lan',
		l3_device: 'br-lan',
		up: true,
		'ipv4-address': [ { address: '10.9.0.1', mask: 24 } ]
	});

	for (let i = 0; i < count; i++) {
		let vlan = firstVlan + i;
		push(out, dumpEntry(sprintf('%s%d', prefix, vlan), vlan, 10000 + vlan, true));
	}

	let foreign = (type(options.foreign) == 'int') ? options.foreign : 0;

	for (let i = 0; i < foreign; i++) {
		push(out, {
			interface: sprintf('other%03d', i),
			proto: 'static',
			device: sprintf('eth2.%d', 100 + i),
			l3_device: sprintf('eth2.%d', 100 + i),
			up: true,
			'ipv4-address': [ { address: sprintf('10.80.%d.1', i % 256), mask: 24 } ]
		});
	}

	return { interface: out };
};

/** Take a list of sections down in a dump that is already built. */
export function setDown(dump, names) {
	let wanted = {};

	for (let one in (type(names) == 'array') ? names : [])
		wanted[one] = true;

	for (let entry in dump.interface) {
		if (wanted[entry.interface] !== true)
			continue;

		entry.up = false;
		entry.uptime = 0;
		entry.errors = [ { code: 'AUTH_FAILED' } ];
		delete entry['ipv4-address'];
	}

	return dump;
};

/** A bus that answers from one dump and counts being asked. */
export function bus(dump, opts) {
	let options = (type(opts) == 'object') ? opts : {};

	return {
		call: function(object, method, args) {
			if (object == 'network.interface' && method == 'dump') {
				calls.dump++;
				return options.dumpNull ? null : dump;
			}

			let prefix = 'network.interface.';

			if (substr(object, 0, length(prefix)) == prefix && method == 'status') {
				calls.status++;

				if (options.statusNull)
					return null;

				let name = substr(object, length(prefix));

				for (let entry in dump.interface) {
					if (entry.interface == name)
						return entry;
				}

				return null;
			}

			calls.other++;
			return null;
		},

		listener: function(event, cb) {
			return { remove: function() { return true; } };
		}
	};
};
