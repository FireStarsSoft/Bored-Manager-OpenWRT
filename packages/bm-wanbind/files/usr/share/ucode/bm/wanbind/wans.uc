// Which interfaces an instance owns, and which of them may take a client now.
//
// Read from netifd through ubus rather than from /etc/config/network, because
// the question is not what the router was configured to have but what it has:
// a PPPoE session that is dialling, one that came up thirty seconds ago and one
// that has been down since Tuesday are configured identically and are three
// completely different answers.
//
// The routing table comes from the same place for the same reason. `ip4table`
// in the dump is the table netifd is putting this interface's routes into right
// now; the number in UCI is what it will use after the next reload, and a rule
// pointing at that one sends the client nowhere until then.

import { debug } from 'bm.log';

// Interfaces that can carry a client. Anything else on the carrier - a bridge
// member, a relay, an unmanaged device - is not a WAN and is left alone.
const WAN_PROTOS = [ 'pppoe', 'dhcp', 'static' ];

function text(value) {
	return type(value) == 'string' ? value : '';
}

function number(value) {
	if (type(value) == 'int')
		return value;
	if (type(value) == 'string' && match(trim(value), /^[0-9]+$/))
		return int(trim(value));
	return 0;
}

/**
 * The most recent error netifd recorded, or ''.
 *
 * The last entry rather than the first: netifd appends, so the newest is the
 * one that describes why the interface is in the state it is in now.
 */
function errorCode(entry) {
	if (type(entry.errors) != 'array')
		return '';

	for (let i = length(entry.errors) - 1; i >= 0; i--) {
		let one = entry.errors[i];

		if (type(one) == 'string' && length(trim(one)))
			return trim(one);

		if (type(one) == 'object') {
			let code = text(one.code) || text(one.message);
			if (length(code))
				return code;
		}
	}

	return '';
}

function address(entry) {
	if (type(entry['ipv4-address']) != 'array')
		return null;

	for (let one in entry['ipv4-address']) {
		if (type(one) != 'object')
			continue;

		let addr = text(one.address);
		let mask = number(one.mask);
		if (length(addr) && mask >= 0 && mask <= 32)
			return { addr: addr, mask: mask };
	}

	return null;
}

/**
 * One netifd interface entry, as everything in this package reads it.
 *
 * Split out of the dump so that a question about one interface can be answered
 * by asking about one interface. Null when the entry has no name, which is not
 * an interface anything here can act on.
 */
function normalise(entry, name) {
	if (type(entry) != 'object' || type(name) != 'string' || !length(name))
		return null;

	let table = number(entry.ip4table);

	if (!table && type(entry.data) == 'object')
		table = number(entry.data.ip4table);

	return {
		name: name,
		proto: text(entry.proto),
		device: text(entry.device),
		l3Device: text(entry.l3_device),
		up: entry.up === true,
		pending: entry.pending === true,
		ipv4: address(entry),
		uptime: number(entry.uptime),
		errorCode: errorCode(entry),
		table: table > 0 ? table : null
	};
}

/**
 * Every interface netifd knows about, normalised.
 *
 * Null when ubus could not be asked, which is different from an empty list and
 * is treated differently everywhere: no answer means change nothing, an empty
 * answer means this router genuinely has no interfaces.
 */
export function dump(bus) {
	if (!bus)
		return null;

	let reply;
	try {
		reply = bus.call('network.interface', 'dump', {});
	}
	catch (e) {
		debug('network.interface dump failed: ' + e);
		return null;
	}

	if (type(reply) != 'object' || type(reply.interface) != 'array') {
		debug('network.interface dump gave nothing usable');
		return null;
	}

	let out = [];
	let seen = {};

	for (let entry in reply.interface) {
		if (type(entry) != 'object')
			continue;

		let one = normalise(entry, trim(text(entry.interface)));

		if (one == null || seen[one.name])
			continue;

		seen[one.name] = true;
		push(out, one);
	}

	return out;
};

/**
 * One interface, asked about by name.
 *
 * The whole dump answers this question too, and at five hundred sessions it is
 * a reply of a few hundred kilobytes to find out one number. `network.interface
 * .<name> status` is the same fact for the cost of one interface.
 *
 * `{ ok: false }` covers both "netifd did not answer" and "netifd does not know
 * that name", and the caller must not read the second as a verdict: ubus does
 * not hand this binding a code it can tell them apart by, and a caller that
 * treated a busy socket as "there is no such interface" would refuse a binding
 * onto a WAN that is sitting right there. The one caller that cannot live with
 * the ambiguity falls back to the full dump.
 *
 * The name is checked before it is put in the path. A section name is a UCI
 * name, and anything else would be a call to an object nobody meant.
 */
export function status(bus, name) {
	if (!bus || type(name) != 'string' || !match(name, /^[A-Za-z0-9_]+$/))
		return { ok: false, iface: null };

	let reply;

	try {
		reply = bus.call('network.interface.' + name, 'status', {});
	}
	catch (e) {
		debug('network.interface.' + name + ' status failed: ' + e);
		return { ok: false, iface: null };
	}

	if (type(reply) != 'object')
		return { ok: false, iface: null };

	// The reply does not name the interface - the object it came from did - so
	// the name is put back here rather than read out of it.
	return { ok: true, iface: normalise(reply, name) };
};

/** `eth1` matches `eth1` and every VLAN of it, and nothing else. */
export function carrierMatches(device, carrier) {
	return device == carrier || substr(device, 0, length(carrier) + 1) == (carrier + '.');
};

/** `10.0.0.7` + 24 -> `10.0.0.0/24`. Null for anything that will not parse. */
export function network(addr, mask) {
	let parts = match(addr, /^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$/);
	if (!parts || mask < 0 || mask > 32)
		return null;

	let value = 0;
	for (let i = 1; i <= 4; i++) {
		let octet = int(parts[i]);
		if (octet < 0 || octet > 255)
			return null;
		value = value * 256 + octet;
	}

	// Built by subtraction rather than by shifting a mask, because ucode's
	// bitwise operators work on signed 64-bit values and `~0 << 8` is not a
	// number anybody wants to reason about at three in the morning.
	let size = 1;
	for (let i = 0; i < 32 - mask; i++)
		size = size * 2;

	let base = value - (value % size);

	return sprintf('%d.%d.%d.%d/%d',
		(base / 16777216) % 256, (base / 65536) % 256, (base / 256) % 256, base % 256, mask);
};

/**
 * An IPv4 address as a number, or null.
 *
 * Plain arithmetic rather than shifts, for the reason `network()` above gives:
 * ucode's bitwise operators are signed 64-bit, so every address from 128.0.0.0
 * up would compare as negative and a range starting there would decompose into
 * one block covering the internet.
 */
export function ipToInt(addr) {
	let parts = match(trim(text(addr)), /^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$/);
	if (!parts)
		return null;

	let value = 0;
	for (let i = 1; i <= 4; i++) {
		let octet = int(parts[i]);
		if (octet < 0 || octet > 255)
			return null;
		value = value * 256 + octet;
	}

	return value;
};

/** And back. */
export function intToIp(value) {
	if (type(value) != 'int' || value < 0 || value > 4294967295)
		return '';

	return sprintf('%d.%d.%d.%d',
		(value / 16777216) % 256, (value / 65536) % 256, (value / 256) % 256, value % 256);
};

/** 2^n, by multiplication. See `ipToInt` for why not a shift. */
function powerOfTwo(n) {
	let size = 1;
	for (let i = 0; i < n; i++)
		size = size * 2;
	return size;
}

/**
 * The smallest set of CIDR blocks that covers exactly `from`-`to`.
 *
 * This is what an instance scoped to an address range writes its catch-all as,
 * and "exactly" is the whole of why it is not simply the LAN. A range instance
 * only ever hands a WAN to a lease inside its range, so a whole-LAN catch-all
 * under one would blackhole every other device on that LAN - a fail-closed rule
 * over addresses the operator scoped the instance to leave alone. Covering the
 * range and nothing else is what makes the two halves agree.
 *
 * An empty list means the range cannot be expressed, and the caller refuses the
 * instance rather than writing part of it. Sixty-two blocks is the worst any
 * IPv4 range needs, so a loop still going at sixty-four is an arithmetic bug
 * rather than an awkward range - and this feeds a rule set, where spinning is
 * the one outcome worse than refusing.
 */
export function rangeCidrs(from, to) {
	let low = ipToInt(from);
	let high = ipToInt(to);

	if (low === null || high === null || low > high)
		return [];

	let blocks = [];
	let current = low;

	for (let guard = 0; guard < 64; guard++) {
		// Widen while the block still starts exactly here and still ends inside
		// the range.
		let prefix = 32;
		while (prefix > 0) {
			let wider = prefix - 1;
			let size = powerOfTwo(32 - wider);
			let base = current - (current % size);

			if (base != current || base + size - 1 > high)
				break;

			prefix = wider;
		}

		push(blocks, sprintf('%s/%d', intToIp(current), prefix));

		let next = current + powerOfTwo(32 - prefix);
		if (next > high)
			return blocks;

		current = next;
	}

	return [];
};

/** Whether `ip` falls between `from` and `to`, both ends included. */
export function inRange(from, to, ip) {
	let low = ipToInt(from);
	let high = ipToInt(to);
	let value = ipToInt(ip);

	if (low === null || high === null || value === null)
		return false;

	return value >= low && value <= high;
};

/** The LAN's own subnet, as `10.0.0.0/24`, or null. */
export function lanCidr(list, name) {
	if (type(list) != 'array')
		return null;

	for (let one in list) {
		if (one.name != name || !one.ipv4)
			continue;

		// The network address, not the router's own: the catch-all rule matches
		// every client on the LAN, and `from 10.0.0.1/24` would be read by the
		// kernel as the same thing but is a lie about what it means.
		return network(one.ipv4.addr, one.ipv4.mask);
	}

	return null;
};

/**
 * The interface the LAN's own subnet is reachable on, or null.
 *
 * `l3Device` and not `device`: the connected route this feeds has to name the
 * thing that carries IP, which on a bridged LAN is `br-lan` rather than any one
 * of its ports. Null when the interface has no address, because a route written
 * against a guessed device is worse than the blackhole it is there to soften.
 */
export function lanDevice(list, name) {
	if (type(list) != 'array')
		return null;

	for (let one in list) {
		if (one.name != name || !one.ipv4)
			continue;

		return one.l3Device || one.device || null;
	}

	return null;
};

/** Whether `ip` is inside `cidr`. Both are trusted to be well formed. */
export function contains(cidr, ip) {
	let parts = match(cidr, /^([0-9.]+)\/([0-9]+)$/);
	if (!parts)
		return false;

	return network(ip, int(parts[2])) == cidr;
};

/**
 * The address out of a single-host rule, or null.
 *
 * A client rule is written as `<ip>/32`; anything else at the same priority is
 * a rule about a subnet - another instance's catch-all, most likely - and is
 * deliberately not a client address.
 */
export function hostAddress(cidr) {
	let parts = match(cidr, /^([0-9.]+)\/32$/);
	return parts ? parts[1] : null;
};

/** The WANs one instance owns, in netifd's order. */
export function pool(list, instance) {
	if (type(list) != 'array')
		return [];

	let out = [];
	for (let one in list) {
		if (one.name == instance.lan || one.name == 'loopback')
			continue;
		if (!(one.proto in WAN_PROTOS))
			continue;
		if (!carrierMatches(one.device, instance.carrier) && !carrierMatches(one.l3Device, instance.carrier))
			continue;

		push(out, one);
	}

	return out;
};

/**
 * What a surface should call this WAN.
 *
 * `dialing` is not an error and is deliberately its own answer: a pool of five
 * thousand PPPoE sessions has some of them dialling at any moment, and a page
 * that painted those red would be red permanently.
 */
export function state(wan, warnUptime) {
	if (wan.pending)
		return 'dialing';
	if (!wan.up || length(wan.errorCode))
		return 'error';
	if (!wan.ipv4 || wan.table === null || wan.uptime < warnUptime)
		return 'warning';
	return 'available';
};

/**
 * Whether this WAN may be handed to a client.
 *
 * Stricter than "up". A session that came up two seconds ago has an address and
 * a route and still drops the first packets through it, so `warnUptime` is what
 * stops a client being bound to a WAN that is not carrying traffic yet - which
 * looks exactly like a broken binding to the person using it.
 */
export function usable(wan, warnUptime) {
	return state(wan, warnUptime) == 'available';
};
