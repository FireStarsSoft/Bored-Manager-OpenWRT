// The network reconciler: /etc/config/network, made to match the record.
//
// Given a pool record, there is exactly one set of sections the router should
// have: one `config device` per tagged VLAN and one `config interface` per
// member, every option derived by config.uc's rules. This file computes that
// set, compares it with what is there, and writes only the difference - so a
// create, an edit and a repair are all the same operation, and running it
// twice writes nothing the second time.
//
// Two deliberate asymmetries:
//
//   `option auto` is state, not configuration. It is how Disable is spelled
//   (netifd keeps a disabled interface visible in its dump, where `disabled`
//   would hide it), it belongs to the user's last press of the button, and a
//   reconcile must not undo it. It is the one option carried over unchanged.
//
//   Removal is record-driven. Only sections derived from the previous record
//   are taken off; a section that merely looks like ours but is in no record
//   is a ghost - reported, never touched. Deleting by pattern would make a
//   typo in somebody's own config this package's fault.
//
// Nothing here logs a credential. The only thing that ever leaves this file
// about an account is which section refused it.

import { cursor } from 'uci';

import { err, notice } from 'bm.log';

import {
	deviceFor,
	deviceSection,
	macFor,
	safeValue,
	sectionFor,
	tableFor,
	vlanOfSection
} from 'bm.pppoe.config';

const NETWORK = 'network';

// Every interface option this reconciler owns. Anything else in one of our
// sections - `auto` above all - is left exactly as found.
const MANAGED = [
	'proto', 'device', 'username', 'password', 'ipv6', 'peerdns', 'dns',
	'defaultroute', 'ip4table', 'metric', 'mtu', 'keepalive', 'service',
	'ac', 'ac_mac', 'host_uniq', 'demand', 'padi_attempts', 'padi_timeout',
	'pppd_options'
];

const DEVICE_MANAGED = [ 'type', 'ifname', 'vid', 'name', 'macaddr' ];

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
};

/** Option equality, where a UCI list may come back as one string. */
function same(current, wanted) {
	if (type(wanted) == 'array') {
		let have = type(current) == 'array' ? current : (current == null ? [] : [ current ]);
		if (length(have) != length(wanted))
			return false;

		for (let i = 0; i < length(wanted); i++) {
			if (text(have[i]) != text(wanted[i]))
				return false;
		}

		return true;
	}

	return text(current) == text(wanted);
};

/**
 * The `config interface` options one member should have. Only what the pool
 * sets is written: an option pppd has a good default for is an option this
 * package does not repeat, so `uci show` reads as short as the pool is simple.
 */
function interfaceOptions(one, member) {
	let out = {
		proto: 'pppoe',
		device: deviceFor(one.carrier, member.vlan),
		username: one.mode == 'single' ? member.username : one.username,
		password: one.mode == 'single' ? member.password : one.password,
		ipv6: one.ipv6,
		peerdns: one.peerdns ? '1' : '0',
		defaultroute: one.defaultroute ? '1' : '0',
		ip4table: sprintf('%d', tableFor(one.tableBase, member.vlan)),
		metric: sprintf('%d', tableFor(one.tableBase, member.vlan))
	};

	if (!one.peerdns && length(one.dns))
		out.dns = one.dns;

	if (one.mtu)
		out.mtu = sprintf('%d', one.mtu);
	if (length(one.keepalive))
		out.keepalive = one.keepalive;
	if (length(one.service))
		out.service = one.service;
	if (length(one.ac))
		out.ac = one.ac;
	if (length(one.acMac))
		out.ac_mac = one.acMac;
	if (length(one.hostUniq))
		out.host_uniq = one.hostUniq;
	if (one.demand)
		out.demand = sprintf('%d', one.demand);
	if (one.padiAttempts)
		out.padi_attempts = sprintf('%d', one.padiAttempts);
	if (one.padiTimeout)
		out.padi_timeout = sprintf('%d', one.padiTimeout);
	if (length(one.pppdOptions))
		out.pppd_options = one.pppdOptions;

	return out;
};

/**
 * Everything one pool should have in /etc/config/network.
 *
 * `carrierMac` feeds the MAC rule and may be empty when the carrier could not
 * be asked - the device section is then written without `macaddr` rather than
 * with a hash of nothing, and the next reconcile with the MAC known adds it.
 */
export function desired(one, carrierMac) {
	let out = { devices: {}, interfaces: {} };

	for (let member in one.members) {
		if (member.vlan >= 1) {
			let device = {
				type: '8021q',
				ifname: one.carrier,
				vid: sprintf('%d', member.vlan),
				name: deviceFor(one.carrier, member.vlan)
			};

			if (one.macMode == 'auto' && length(text(carrierMac)))
				device.macaddr = macFor(carrierMac, one.id, member.vlan);

			out.devices[deviceSection(one.id, member.vlan)] = device;
		}

		out.interfaces[sectionFor(one.prefix, member.vlan)] = interfaceOptions(one, member);
	}

	return out;
};

/** Current sections of one UCI type, as `{ name: sectionObject }`. */
function sectionsOfType(uci, kind) {
	let out = {};

	uci.foreach(NETWORK, kind, (section) => {
		out[text(section['.name'])] = section;
	});

	return out;
};

/** Write one section to exactly the wanted options, returning whether any
 * write happened. Unmanaged options survive; managed ones not wanted go. */
function writeSection(uci, name, kind, wanted, current, managed) {
	let changed = false;

	if (!current) {
		uci.set(NETWORK, name, kind);
		changed = true;
	}

	for (let option in managed) {
		let want = exists(wanted, option) ? wanted[option] : null;

		if (want === null) {
			if (current && exists(current, option) && current[option] != null) {
				uci.delete(NETWORK, name, option);
				changed = true;
			}
			continue;
		}

		if (!current || !same(current[option], want)) {
			uci.set(NETWORK, name, option, want);
			changed = true;
		}
	}

	return changed;
};

/**
 * Make the router match the record.
 *
 * `previous` is the record being replaced - null on a create - and is what
 * removal is driven by: a section is deleted only when the previous record
 * derives it and the new one does not. The caller takes the removed members
 * down *before* calling this; netifd is not told about any of it until the
 * caller reloads.
 *
 * Returns { ok, added, removed, rewritten, reason? } where added and removed
 * are VLAN lists and rewritten counts kept members whose sections changed.
 */
export function reconcile(one, previous, carrierMac) {
	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		return { ok: false, added: [], removed: [], rewritten: 0, reason: 'cannot open uci: ' + e };
	}

	let want = desired(one, carrierMac);
	let interfaces = sectionsOfType(uci, 'interface');
	let devices = sectionsOfType(uci, 'device');

	// The last gate before a credential becomes a line in a config file. It
	// names the section, never the value - the value is a password.
	for (let name in want.interfaces) {
		let options = want.interfaces[name];
		if (!safeValue(options.username) || !safeValue(options.password)) {
			return {
				ok: false, added: [], removed: [], rewritten: 0,
				reason: name + ' has a username or password with a control character in it'
			};
		}
	}

	let added = [];
	let removed = [];
	let rewritten = 0;

	// Removals first, record-driven. Sections the previous record derives and
	// the new record does not, whether interface or tagged device.
	if (previous) {
		for (let member in previous.members) {
			let name = sectionFor(previous.prefix, member.vlan);
			if (exists(want.interfaces, name))
				continue;

			if (exists(interfaces, name)) {
				uci.delete(NETWORK, name);
				push(removed, member.vlan);
			}

			let device = deviceSection(previous.id, member.vlan);
			if (exists(devices, device))
				uci.delete(NETWORK, device);
		}
	}

	// Devices before the interfaces that name them: netifd resolves `device`
	// by name, and a name nothing defines is an interface that never dials.
	// Not counted: a member is counted by its interface, below.
	for (let name in want.devices)
		writeSection(uci, name, 'device', want.devices[name], devices[name], DEVICE_MANAGED);

	for (let name in want.interfaces) {
		let existed = exists(interfaces, name);
		let changed = writeSection(uci, name, 'interface', want.interfaces[name], interfaces[name], MANAGED);

		if (!existed)
			push(added, vlanOfSection(one.prefix, name));
		else if (changed)
			rewritten++;
	}

	if (uci.commit(NETWORK) === null) {
		err(sprintf('pool %s: the network configuration would not commit', one.id));
		return {
			ok: false, added: added, removed: removed, rewritten: rewritten,
			reason: 'the network configuration could not be committed'
		};
	}

	if (length(added) || length(removed) || rewritten) {
		notice(sprintf('pool %s: %d interface(s) added, %d removed, %d rewritten',
			one.id, length(added), length(removed), rewritten));
	}

	return { ok: true, added: added, removed: removed, rewritten: rewritten };
};

/**
 * Take every section a pool's record derives off the router.
 *
 * By derived name rather than by scanning for PPPoE interfaces, so a router
 * that had sessions before this package arrived keeps them. A name that is
 * not there is not an error: a pool half written by a create that failed is
 * exactly the case this has to clean up.
 */
export function removeAll(one) {
	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		return { ok: false, removed: 0, reason: 'cannot open uci: ' + e };
	}

	let interfaces = sectionsOfType(uci, 'interface');
	let devices = sectionsOfType(uci, 'device');
	let removed = 0;

	for (let member in one.members) {
		let name = sectionFor(one.prefix, member.vlan);
		if (exists(interfaces, name)) {
			if (uci.delete(NETWORK, name) !== null)
				removed++;
		}
	}

	// Device sections by name prefix rather than by the current member list:
	// an earlier shape of the pool may have left one for a VLAN the record no
	// longer carries, and this is the last chance to take it with us.
	for (let name in devices) {
		let stem = 'bmd_' + one.id + '_';
		if (length(name) <= length(stem) || substr(name, 0, length(stem)) != stem)
			continue;

		if (match(substr(name, length(stem)), /^[0-9]{1,4}$/))
			uci.delete(NETWORK, name);
	}

	if (uci.commit(NETWORK) === null) {
		// Reported rather than swallowed, because of what the caller does
		// next: poolDelete forgets the record on success, and the record is
		// the only thing naming these sections. Losing it while they are
		// still in /etc/config/network leaves credentials nothing can list.
		err(sprintf('pool %s: the network configuration would not commit', one.id));
		return {
			ok: false, removed: removed,
			reason: 'the network configuration could not be committed, so the pool record is being kept'
		};
	}

	notice(sprintf('pool %s: removed %d interface(s)', one.id, removed));

	return { ok: true, removed: removed };
};

/**
 * What of a pool is actually written right now, and what merely looks like it.
 *
 * `written` maps each member's section name to `{ auto }` when the section is
 * in /etc/config/network - the input to the status machine, where a missing
 * section is a member shown as `unwritten` rather than a row that vanishes.
 * `ghosts` are sections that match the pool's naming rule but are in no
 * record: never touched, reported so somebody finds the rubbish.
 */
export function stateOf(one) {
	let out = { written: {}, ghosts: [] };

	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		return out;
	}

	let mine = {};
	for (let member in one.members)
		mine[sectionFor(one.prefix, member.vlan)] = true;

	uci.foreach(NETWORK, 'interface', (section) => {
		let name = text(section['.name']);

		if (exists(mine, name)) {
			out.written[name] = { auto: text(section.auto) != '0' };
			return;
		}

		if (vlanOfSection(one.prefix, name) !== null && text(section.proto) == 'pppoe')
			push(out.ghosts, name);
	});

	return out;
};

/** Set or clear `option auto '0'` - how Disable and Enable are spelled. */
export function setAutostart(names, enabled) {
	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		return { ok: false, reason: 'cannot open uci: ' + e };
	}

	for (let name in names) {
		if (enabled)
			uci.delete(NETWORK, name, 'auto');
		else
			uci.set(NETWORK, name, 'auto', '0');
	}

	if (uci.commit(NETWORK) === null)
		return { ok: false, reason: 'the network configuration could not be committed' };

	return { ok: true };
};
