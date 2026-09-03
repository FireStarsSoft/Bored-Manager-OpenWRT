// The firewall reconciler: the zone, its memberships, and the LAN forwarding.
//
// This is the half the old model never had. The module wrote the zone over
// SSH when it created a batch, so a pool created any other way - LuCI, the
// CLI - dialled fine and carried not one client packet, because nothing put
// its interfaces in a zone. Here the zone is derived from the record by the
// same daemon that writes the interfaces, so there is no way to create a pool
// without its firewall.
//
// Ownership is by name. A pool names its zone; this file makes that zone
// exist, shaped the way a WAN pool needs (input and forward rejected, output
// accepted, masquerade and MTU fixing as the pool says), and keeps exactly
// the pool's members on its network list. Entries it cannot recognise as any
// pool's - a user's own additions to a shared zone - are carried over
// untouched, and a zone that still holds any of them is never deleted.
//
// The zone and forwarding the module used to write have the same spelling -
// zone named by the pool, forwarding section `bmfwd` - so a router configured
// by the old model is adopted, not duplicated.

import { cursor } from 'uci';

import { debug, err, notice } from 'bm.log';

import { vlanOfSection } from 'bm.pppoe.config';

const FIREWALL = 'firewall';

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
};

function listOf(value) {
	if (type(value) == 'array') {
		let out = [];
		for (let one in value) {
			let entry = text(one);
			if (length(entry))
				push(out, entry);
		}
		return out;
	}

	let entry = text(value);
	return length(entry) ? [ entry ] : [];
};

function sameList(current, wanted) {
	if (length(current) != length(wanted))
		return false;

	for (let i = 0; i < length(current); i++) {
		if (current[i] != wanted[i])
			return false;
	}

	return true;
};

/**
 * Whether bm-wanbind is configured on this router.
 *
 * The gate for tearing a zone down. An empty pool zone is still the zone the
 * binder's WANs masquerade through; deleting it while an instance exists
 * would take every bound client off the internet to tidy up a list. Enabled
 * or not is deliberately ignored - a disabled instance is somebody's
 * configuration, not their absence.
 */
export function wanbindPresent() {
	let found = false;

	try {
		cursor().foreach('bm_wanbind', 'instance', (section) => {
			found = true;
		});
	}
	catch (e) {
		// No config file means no binder. Anything else means unknown, and
		// unknown keeps the zone - the cost of keeping an empty zone is
		// nothing; the cost of deleting a needed one is every client.
		debug('cannot read bm_wanbind: ' + e);
	}

	return found;
};

/**
 * The zone LAN clients sit in, by looking for the one that holds the `lan`
 * network. Every stock OpenWrt calls it `lan`, but the name is configuration
 * like any other, and a forwarding whose src names a zone fw4 has never heard
 * of is silently dropped - every session dials, and not one packet crosses.
 */
export function lanZone(uci) {
	let found = '';

	uci.foreach(FIREWALL, 'zone', (section) => {
		if (length(found))
			return;

		if ('lan' in listOf(section.network)) {
			let name = text(section.name);
			found = length(name) ? name : text(section['.name']);
		}
	});

	return length(found) ? found : 'lan';
};

/**
 * Whether this network-list entry is spelled by any of these pools' naming
 * rule. By pattern, deliberately not by the current member list: the entry
 * a pool_set just removed a member for is exactly the one that has to read
 * as ours so it can be dropped. The pool's prefix namespace is reserved -
 * the create gate refuses a derived name that would collide - so an entry
 * that parses as `<prefix><vlan>` belongs to this package to add and remove.
 */
/** Whether this `list device` entry is the wildcard one of our pools writes. */
function ourPattern(pools, entry) {
	for (let one in pools) {
		if (entry == ('pppoe-' + one.prefix + '+'))
			return true;
	}

	return false;
};

function oursBy(pools, entry) {
	for (let one in pools) {
		if (vlanOfSection(one.prefix, entry) !== null)
			return true;
	}

	return false;
};

/** Every zone section, keyed by the name fw4 knows it by. */
function zonesByName(uci) {
	let out = {};

	uci.foreach(FIREWALL, 'zone', (section) => {
		let name = text(section.name);
		if (!length(name))
			name = text(section['.name']);

		if (length(name))
			out[name] = section;
	});

	return out;
};

/** Every forwarding section this package owns: `bmfwd`, `bmfwd_<zone>`. */
function ownForwardings(uci) {
	let out = {};

	uci.foreach(FIREWALL, 'forwarding', (section) => {
		let name = text(section['.name']);

		if (name == 'bmfwd' || (length(name) > 6 && substr(name, 0, 6) == 'bmfwd_'))
			out[name] = { src: text(section.src), dest: text(section.dest) };
	});

	return out;
};

/**
 * Make the firewall match the records.
 *
 * `pools` is every pool that should exist afterwards; `retiring` is the one
 * being deleted right now, or null. The retiring pool's memberships are
 * removed like any other stale entry - its prefix still recognises them -
 * and its zone is torn down when nothing else keeps it.
 *
 * Returns { ok, changed, reason? }; `changed` is what tells the caller a
 * firewall reload is worth asking for.
 */
export function reconcile(pools, retiring) {
	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		return { ok: false, changed: false, reason: 'cannot open uci: ' + e };
	}

	let everyPool = [];
	for (let one in pools)
		push(everyPool, one);
	if (retiring)
		push(everyPool, retiring);

	// What each zone should carry: masquerade and MTU fixing are the union of
	// what its pools ask - a shared zone masquerades if any pool needs it.
	let wanted = {};
	let order = [];

	for (let one in pools) {
		if (!exists(wanted, one.zone)) {
			wanted[one.zone] = { masq: false, mtuFix: false, lanForward: false, networks: [], devices: [] };
			push(order, one.zone);
		}

		let zone = wanted[one.zone];
		zone.masq = zone.masq || one.masq;
		zone.mtuFix = zone.mtuFix || one.mtuFix;
		zone.lanForward = zone.lanForward || one.lanForward;

		// One device pattern for the whole pool, rather than one network entry
		// per member.
		//
		// fw4's interface hotplug runs `fw4 -q network <name>` on every `ifup`,
		// and when that name is in a zone's `list network` it reloads the whole
		// firewall. A pool of five hundred sessions coming up after a reboot is
		// therefore up to five hundred full firewall reloads, each one parsing
		// a netifd dump of a few hundred kilobytes and rendering the ruleset
		// again. Nothing in this package caused it and nothing said so.
		//
		// `pppoe-<prefix>+` is fw4's own wildcard - it turns a trailing `+`
		// into `*` when it renders - so the zone matches every session's device
		// by name, including ones that dial after the ruleset was built. The
		// hotplug then finds the interface in no zone's network list and does
		// nothing.
		let pattern = 'pppoe-' + one.prefix + '+';

		if (!(pattern in zone.devices))
			push(zone.devices, pattern);
	}

	let zones = zonesByName(uci);
	let lan = lanZone(uci);
	let changed = false;

	// Zones the pools name: shaped, and their network list rebuilt as the
	// foreign entries in their current order plus our members in ours.
	for (let name in order) {
		let want = wanted[name];
		let current = zones[name];
		let section = current ? text(current['.name']) : name;

		if (!current) {
			uci.set(FIREWALL, section, 'zone');
			uci.set(FIREWALL, section, 'input', 'REJECT');
			uci.set(FIREWALL, section, 'output', 'ACCEPT');
			uci.set(FIREWALL, section, 'forward', 'REJECT');
			changed = true;
		}

		if (!current || text(current.name) != name) {
			uci.set(FIREWALL, section, 'name', name);
			changed = true;
		}

		let masq = want.masq ? '1' : '0';
		if (!current || text(current.masq) != masq) {
			uci.set(FIREWALL, section, 'masq', masq);
			changed = true;
		}

		let mtuFix = want.mtuFix ? '1' : '0';
		if (!current || text(current.mtu_fix) != mtuFix) {
			uci.set(FIREWALL, section, 'mtu_fix', mtuFix);
			changed = true;
		}

		// Whatever else is in the zone keeps its place; what this package put
		// there is replaced by the pattern below. A router upgraded from the
		// per-member list therefore loses five hundred entries and gains one,
		// in one pass, and that pass is the last firewall reload the pool ever
		// causes on its own.
		let networks = [];
		for (let entry in (current ? listOf(current.network) : [])) {
			if (!oursBy(everyPool, entry))
				push(networks, entry);
		}

		if (!current || !sameList(listOf(current.network), networks)) {
			if (length(networks))
				uci.set(FIREWALL, section, 'network', networks);
			else
				uci.delete(FIREWALL, section, 'network');
			changed = true;
		}

		let devices = [];
		for (let entry in (current ? listOf(current.device) : [])) {
			if (!ourPattern(everyPool, entry))
				push(devices, entry);
		}
		for (let entry in want.devices)
			push(devices, entry);

		if (!current || !sameList(listOf(current.device), devices)) {
			if (length(devices))
				uci.set(FIREWALL, section, 'device', devices);
			else
				uci.delete(FIREWALL, section, 'device');
			changed = true;
		}
	}

	// Zones the pools no longer name, but which still hold entries shaped
	// like ours: the zone a pool_set just moved away from, the zone of the
	// pool being deleted. Our entries go; the zone goes with them when it is
	// empty, unclaimed, and the binder does not exist.
	for (let name in zones) {
		if (exists(wanted, name))
			continue;

		let current = zones[name];
		let section = text(current['.name']);
		let networks = [];
		let devices = [];
		let dropped = false;

		for (let entry in listOf(current.network)) {
			if (oursBy(everyPool, entry))
				dropped = true;
			else
				push(networks, entry);
		}

		for (let entry in listOf(current.device)) {
			if (ourPattern(everyPool, entry))
				dropped = true;
			else
				push(devices, entry);
		}

		if (!dropped)
			continue;

		changed = true;

		if (length(devices))
			uci.set(FIREWALL, section, 'device', devices);
		else
			uci.delete(FIREWALL, section, 'device');

		if (length(networks)) {
			uci.set(FIREWALL, section, 'network', networks);
			continue;
		}

		uci.delete(FIREWALL, section, 'network');

		if (!wanbindPresent()) {
			uci.delete(FIREWALL, section);
			notice('removed the empty firewall zone ' + name);
		}
	}

	// One forwarding per zone that wants the LAN let in. The first keeps the
	// spelling the module used - `bmfwd` - which is what adopts a router the
	// old model configured; a second zone gets its own name beside it.
	let forwardings = ownForwardings(uci);
	let neededNames = {};
	let first = true;

	for (let name in order) {
		if (!wanted[name].lanForward)
			continue;

		let section = first ? 'bmfwd' : 'bmfwd_' + name;
		first = false;
		neededNames[section] = true;

		let current = forwardings[section];
		if (!current) {
			uci.set(FIREWALL, section, 'forwarding');
			changed = true;
		}

		if (!current || current.src != lan) {
			uci.set(FIREWALL, section, 'src', lan);
			changed = true;
		}

		if (!current || current.dest != name) {
			uci.set(FIREWALL, section, 'dest', name);
			changed = true;
		}
	}

	for (let name in forwardings) {
		if (!exists(neededNames, name)) {
			uci.delete(FIREWALL, name);
			changed = true;
		}
	}

	if (changed && uci.commit(FIREWALL) === null) {
		err('the firewall configuration would not commit');
		return { ok: false, changed: false, reason: 'the firewall configuration could not be committed' };
	}

	return { ok: true, changed: changed };
};

/**
 * Remove named entries from every zone's network list - the legacy delete's
 * half of this file, where the naming rule is the old five-digit one that
 * `vlanOfSection` deliberately does not match.
 */
export function dropMemberships(names) {
	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		return { ok: false, changed: false, reason: 'cannot open uci: ' + e };
	}

	let gone = {};
	for (let name in names)
		gone[name] = true;

	let edits = [];
	uci.foreach(FIREWALL, 'zone', (section) => {
		let current = listOf(section.network);
		let kept = [];

		for (let entry in current) {
			if (!exists(gone, entry))
				push(kept, entry);
		}

		if (length(kept) != length(current))
			push(edits, { section: text(section['.name']), networks: kept });
	});

	for (let edit in edits) {
		if (length(edit.networks))
			uci.set(FIREWALL, edit.section, 'network', edit.networks);
		else
			uci.delete(FIREWALL, edit.section, 'network');
	}

	if (length(edits) && uci.commit(FIREWALL) === null) {
		err('the firewall configuration would not commit');
		return { ok: false, changed: false, reason: 'the firewall configuration could not be committed' };
	}

	return { ok: true, changed: length(edits) > 0 };
};
