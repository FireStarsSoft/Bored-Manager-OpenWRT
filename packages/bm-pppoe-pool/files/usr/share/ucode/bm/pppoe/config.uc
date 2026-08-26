// /etc/config/bm_pppoe, and the rules every pool is derived by.
//
// The file is the record and the record is the truth. The sections that dial
// live in /etc/config/network and the zone lives in /etc/config/firewall, but
// both are derived: given this file, the reconcilers can rebuild every one of
// them, and given only the router, "delete this pool" would have no answer
// beyond "delete every PPPoE interface", which is not the same thing.
//
// A pool is a mode, a carrier, one account or one account per member, and a
// list of VLANs. Everything else about a member - its section name, its tagged
// device, its routing table, its MAC - is computed from those by the functions
// here, never stored per member and never guessed anywhere else. Two spellings
// of one rule is how a delete misses a section.
//
// This file also holds the one validation gate. `pool_check`, `pool_create`,
// `pool_set` and every UI in front of them call the same `check()`, so a spec
// that passes the preview is the spec that applies, and a refusal is worded
// once, here, for all three surfaces.

import { cursor } from 'uci';

import { debug, err } from 'bm.log';

const PACKAGE = 'bm_pppoe';

// One VLAN is one member is one interface. 500 keeps a whole pool inside one
// `sessions` reply (ROW_LIMIT in service.uc) and one ubus message.
export const MEMBER_MAX = 500;

// A prefix of 1-4 characters plus at most four VLAN digits keeps the section
// name inside 8 characters, and `pppoe-` in front of it inside Linux's
// IFNAMSIZ of 15 visible characters.
const PREFIX = /^[a-z][a-z0-9]{0,3}$/;
const POOL_ID = /^[a-z][a-z0-9_]{0,30}$/;

// fw3 capped zone names at 11 characters; fw4 does not, but a name both would
// take is a name that survives a downgrade nobody planned.
const ZONE = /^[a-zA-Z0-9_]{1,11}$/;

const IFNAMSIZ = 15;

function flag(value, fallback) {
	if (type(value) == 'bool')
		return value;
	if (type(value) == 'int')
		return value != 0;
	if (type(value) != 'string' || !length(value))
		return fallback;

	return !(value in [ '0', 'no', 'off', 'false', 'disabled' ]);
};

function number(value, fallback) {
	if (type(value) == 'int')
		return value;
	if (type(value) == 'double')
		return int(value);
	if (type(value) != 'string' || !match(trim(value), /^[0-9]+$/))
		return fallback;
	return int(trim(value));
};

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
};

/** A UCI list read back: absent, one string, or an array. Always an array. */
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

/**
 * Whether a credential is safe to write into a config file.
 *
 * Byte by byte, and not by regex, for two separate reasons that both had to be
 * found by running it: ucode hands patterns straight to regcomp, which has no
 * \x escape and refuses the obvious spelling when the module is *loaded* - and
 * a subject reaches regexec as a NUL-terminated C string, so anything after a
 * NUL is invisible to any pattern at all. A loop over the bytes has neither
 * problem and costs nothing.
 */
export function safeValue(value) {
	if (type(value) != 'string' || length(value) < 1 || length(value) > 128)
		return false;

	for (let i = 0; i < length(value); i++) {
		// C0 controls and DEL: anything that could end a UCI line or a shell
		// word. Bytes above 127 are left alone - they are UTF-8 continuation
		// bytes, and a username with an accent in it is somebody's username.
		let byte = ord(value, i);
		if (byte < 32 || byte == 127)
			return false;
	}

	return true;
};

export function validPrefix(value) {
	return type(value) == 'string' && match(value, PREFIX) ? true : false;
};

export function validPoolId(value) {
	return type(value) == 'string' && match(value, POOL_ID) ? true : false;
};

export function validZone(value) {
	return type(value) == 'string' && match(value, ZONE) ? true : false;
};

function isIp4(value) {
	let parts = match(value, /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/);
	if (!parts)
		return false;

	for (let i = 1; i <= 4; i++) {
		if (int(parts[i]) > 255)
			return false;
	}

	return true;
};

function isIp6(value) {
	// Hex groups and colons, at least one colon, no whitespace. Deliberately
	// permissive: the router's resolver is the authority, and refusing a legal
	// spelling would be worse than passing one dnsmasq then refuses loudly.
	if (!match(value, /^[0-9a-fA-F:.]{2,45}$/))
		return false;

	return index(value, ':') >= 0;
};

export function validDns(value) {
	return isIp4(value) || isIp6(value);
};

export function validMac(value) {
	return type(value) == 'string' &&
		match(value, /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/) ? true : false;
};

// ---------------------------------------------------------------------------
// Derivation. One spelling per rule, quoted by both reconcilers, the status
// machine, the counters and the delete.

/**
 * FNV-1a, 32-bit, spelled out because ucode has no crypto and needs none here:
 * this is a spreading function, not a secret. Offset 2166136261, prime
 * 16777619, masked to 32 bits per step so the arithmetic never leaves int64.
 */
export function fnv1a(value) {
	let hash = 2166136261;

	for (let i = 0; i < length(value); i++) {
		hash = hash ^ ord(value, i);
		hash = (hash * 16777619) & 0xffffffff;
	}

	return hash;
};

/**
 * The MAC a member dials with when the pool says `mac_mode auto`.
 *
 * `02:` is locally administered and unicast. The next three octets hash the
 * carrier's own MAC and the pool id, so two pools on one carrier differ and
 * one pool re-created after a reboot does not. The last two are the VLAN, so
 * every member of a pool differs. Deterministic, so it is never stored: the
 * reconciler recomputes it and always lands on the same answer.
 */
export function macFor(carrierMac, poolId, vlan) {
	let hash = fnv1a(lc(trim(carrierMac)) + '|' + poolId);

	return sprintf('02:%02x:%02x:%02x:%02x:%02x',
		(hash >> 16) & 0xff, (hash >> 8) & 0xff, hash & 0xff,
		(vlan >> 8) & 0xff, vlan & 0xff);
};

/** Pool prefix + VLAN -> the interface section: `fpt` + 101 -> `fpt101`. */
export function sectionFor(prefix, vlan) {
	return sprintf('%s%d', prefix, vlan);
};

/** The kernel device pppd creates for that section. */
export function netdevFor(prefix, vlan) {
	return 'pppoe-' + sectionFor(prefix, vlan);
};

/** The `config device` section for a tagged member. VLAN 0 has none. */
export function deviceSection(poolId, vlan) {
	return sprintf('bmd_%s_%d', poolId, vlan);
};

/** What the member dials over: `eth4.101`, or the bare carrier for VLAN 0. */
export function deviceFor(carrier, vlan) {
	return (vlan >= 1 && vlan <= 4094) ? sprintf('%s.%d', carrier, vlan) : carrier;
};

/** The member record section in bm_pppoe: `<pool>_<vlan>`. */
export function memberSection(poolId, vlan) {
	return sprintf('%s_%d', poolId, vlan);
};

/** Routing table and metric, one per member: base + VLAN. */
export function tableFor(tableBase, vlan) {
	return tableBase + vlan;
};

/**
 * The VLAN a section name encodes for this prefix, or null when the name is
 * not one of ours. The one parser for the naming rule, shared by the status
 * machine, the counters and the ghost check - ucode builds no regex at run
 * time, so this is spelled as string arithmetic.
 */
export function vlanOfSection(prefix, name) {
	if (type(name) != 'string' || length(name) <= length(prefix))
		return null;

	if (substr(name, 0, length(prefix)) != prefix)
		return null;

	let tail = substr(name, length(prefix));
	if (!match(tail, /^[0-9]{1,4}$/))
		return null;

	// `fpt0101` is not VLAN 101: a leading zero would let two spellings name
	// one VLAN, and the writer never produces one.
	if (length(tail) > 1 && substr(tail, 0, 1) == '0')
		return null;

	let vlan = int(tail);
	return (vlan >= 0 && vlan <= 4094) ? vlan : null;
};

// ---------------------------------------------------------------------------
// The global section.

/** The one global section. Absent means the shipped defaults. */
export function main() {
	let out = { enabled: true, counterInterval: 5, redialAfter: 120, redialBatch: 20 };

	try {
		let uci = cursor();
		out.enabled = flag(uci.get(PACKAGE, 'main', 'enabled'), true);

		let interval = number(uci.get(PACKAGE, 'main', 'counter_interval'), 5);
		out.counterInterval = (interval >= 1 && interval <= 300) ? interval : 5;

		let redial = number(uci.get(PACKAGE, 'main', 'redial_after'), 120);
		out.redialAfter = (redial >= 0 && redial <= 86400) ? redial : 120;

		let batch = number(uci.get(PACKAGE, 'main', 'redial_batch'), 20);
		out.redialBatch = (batch >= 1 && batch <= 500) ? batch : 20;
	}
	catch (e) {
		debug('cannot read ' + PACKAGE + ': ' + e);
	}

	return out;
};

export function settingsRefusal(values) {
	if (exists(values, 'counter_interval')) {
		let interval = number(values.counter_interval, -1);
		if (interval < 1 || interval > 300)
			return 'counter_interval has to be 1 to 300 seconds';
	}

	if (exists(values, 'redial_after')) {
		let redial = number(values.redial_after, -1);
		if (redial < 0 || redial > 86400)
			return 'redial_after has to be 0 (off) to 86400 seconds';
	}

	if (exists(values, 'redial_batch')) {
		let batch = number(values.redial_batch, -1);
		if (batch < 1 || batch > 500)
			return 'redial_batch has to be 1 to 500';
	}

	return null;
};

// ---------------------------------------------------------------------------
// Reading the records back.

/** Every member section, grouped by the pool option it names. */
function memberMap() {
	let out = {};

	try {
		cursor().foreach(PACKAGE, 'member', (section) => {
			let poolId = text(section.pool);
			if (!length(poolId))
				return;

			let vlan = number(section.vlan, -1);
			if (vlan < 0 || vlan > 4094)
				return;

			if (!exists(out, poolId))
				out[poolId] = [];

			push(out[poolId], {
				vlan: vlan,
				username: text(section.username),
				password: text(section.password)
			});
		});
	}
	catch (e) {
		debug('cannot list members in ' + PACKAGE + ': ' + e);
	}

	for (let poolId in out)
		out[poolId] = sort(out[poolId], (a, b) => a.vlan - b.vlan);

	return out;
};

/** One pool section plus its members, as the record every caller passes. */
function poolFromSection(section, members) {
	let one = {
		id: text(section['.name']),
		mode: text(section.mode),
		label: text(section.label),
		prefix: text(section.prefix),
		carrier: text(section.carrier),
		macMode: text(section.mac_mode) == 'inherit' ? 'inherit' : 'auto',
		username: text(section.username),
		password: text(section.password),
		tableBase: number(section.table_base, 0),
		service: text(section.service),
		ac: text(section.ac),
		acMac: text(section.ac_mac),
		mtu: number(section.mtu, 0),
		keepalive: text(section.keepalive),
		ipv6: text(section.ipv6),
		peerdns: flag(section.peerdns, false),
		dns: listOf(section.dns),
		defaultroute: flag(section.defaultroute, true),
		hostUniq: text(section.host_uniq),
		demand: number(section.demand, 0),
		padiAttempts: number(section.padi_attempts, 0),
		padiTimeout: number(section.padi_timeout, 0),
		pppdOptions: text(section.pppd_options),
		zone: text(section.zone),
		masq: flag(section.masq, true),
		mtuFix: flag(section.mtu_fix, true),
		lanForward: flag(section.lan_forward, true),
		created: number(section.created, 0),
		members: members ? members : []
	};

	if (!(one.ipv6 in [ 'auto', '0', '1' ]))
		one.ipv6 = '0';

	return one;
};

/** Why a stored record cannot be used, or null. Light on purpose: the write
 * gate is check(); this only refuses what the reconcilers cannot even name. */
export function recordRefusal(one) {
	if (!(one.mode in [ 'multi', 'single' ]))
		return 'mode is neither multi nor single';

	if (!validPrefix(one.prefix))
		return 'prefix must be 1 to 4 characters, starting with a letter';

	if (!length(one.carrier))
		return 'no carrier is set, so there is nothing to dial over';

	if (one.tableBase < 1 || one.tableBase + 4094 > 65535)
		return sprintf('table base %d cannot seat every VLAN inside the routing table range', one.tableBase);

	if (!validZone(one.zone))
		return 'the firewall zone name is not 1 to 11 letters, digits or underscores';

	if (!length(one.members))
		return 'the pool has no member sections';

	return null;
};

/** Every v2 pool this router has a record of, in file order. */
export function pools() {
	let out = [];

	try {
		let members = memberMap();

		cursor().foreach(PACKAGE, 'pool', (section) => {
			// A pool written by the old model records a sequence range instead
			// of members. Those are legacy: listed by legacyPools(), deletable,
			// nothing else.
			if (length(text(section.seq_from)))
				return;

			let one = poolFromSection(section, members[text(section['.name'])]);

			let reason = recordRefusal(one);
			if (reason) {
				err('pool ' + one.id + ': ' + reason);
				return;
			}

			push(out, one);
		});
	}
	catch (e) {
		debug('cannot list pools in ' + PACKAGE + ': ' + e);
	}

	return out;
};

/** The pools written by the old model: a prefix and a sequence range. Only
 * pool_delete still understands them, through legacy.uc. */
export function legacyPools() {
	let out = [];

	try {
		cursor().foreach(PACKAGE, 'pool', (section) => {
			if (!length(text(section.seq_from)))
				return;

			let one = {
				id: text(section['.name']),
				prefix: text(section.prefix),
				carrier: text(section.carrier),
				seqFrom: number(section.seq_from, 0),
				seqTo: number(section.seq_to, 0),
				tableBase: number(section.table_base, 0),
				vlan: number(section.vlan, 0),
				created: number(section.created, 0)
			};

			one.count = one.seqTo >= one.seqFrom ? one.seqTo - one.seqFrom + 1 : 0;
			push(out, one);
		});
	}
	catch (e) {
		debug('cannot list legacy pools in ' + PACKAGE + ': ' + e);
	}

	return out;
};

export function pool(id) {
	for (let one in pools()) {
		if (one.id == id)
			return one;
	}

	return null;
};

export function legacyPool(id) {
	for (let one in legacyPools()) {
		if (one.id == id)
			return one;
	}

	return null;
};

/** Whether any pool section - either model - has this name. */
export function anyPool(id) {
	if (pool(id))
		return true;

	return legacyPool(id) != null;
};

// ---------------------------------------------------------------------------
// The spec: the JSON shape pool_check / pool_create / pool_set share.

/**
 * A member row from a spec: `{ vlan }` in multi mode, `{ vlan, user, pass }`
 * in single. Junk vlans come back as -1 so check() can name the row.
 */
function memberFromSpec(row) {
	if (type(row) != 'object')
		return { vlan: -1, username: '', password: '' };

	return {
		vlan: number(row.vlan, -1),
		username: text(row.user),
		password: text(row.pass)
	};
};

/**
 * A spec, however it arrived, as a record. No validation here beyond types:
 * check() is the gate, and it wants the whole picture rather than the first
 * refusal.
 */
export function fromSpec(id, spec) {
	let members = [];
	if (type(spec.members) == 'array') {
		for (let row in spec.members)
			push(members, memberFromSpec(row));
	}

	let one = {
		id: text(id),
		mode: text(spec.mode),
		label: text(spec.label),
		prefix: text(spec.prefix),
		carrier: text(spec.carrier),
		macMode: text(spec.mac_mode) == 'inherit' ? 'inherit' : 'auto',
		username: text(spec.username),
		password: text(spec.password),
		tableBase: number(spec.table_base, 10000),
		service: text(spec.service),
		ac: text(spec.ac),
		acMac: text(spec.ac_mac),
		mtu: number(spec.mtu, 0),
		keepalive: text(spec.keepalive),
		ipv6: text(spec.ipv6),
		peerdns: flag(spec.peerdns, false),
		dns: listOf(spec.dns),
		defaultroute: flag(spec.defaultroute, true),
		hostUniq: text(spec.host_uniq),
		demand: number(spec.demand, 0),
		padiAttempts: number(spec.padi_attempts, 0),
		padiTimeout: number(spec.padi_timeout, 0),
		pppdOptions: text(spec.pppd_options),
		zone: length(text(spec.zone)) ? text(spec.zone) : 'bmwanpool',
		masq: flag(spec.masq, true),
		mtuFix: flag(spec.mtu_fix, true),
		lanForward: flag(spec.lan_forward, true),
		created: time(),
		members: sort(members, (a, b) => a.vlan - b.vlan)
	};

	if (!(one.ipv6 in [ 'auto', '0', '1' ]))
		one.ipv6 = '0';

	return one;
};

/**
 * A record as the flat spec every reader gets. Passwords are never in it:
 * `info` quotes this to two UIs and a CLI, and none of them ever needs a
 * password back - they need to know one is set.
 */
export function toSpec(one) {
	let members = [];
	for (let member in one.members)
		push(members, { vlan: member.vlan, username: member.username });

	return {
		id: one.id,
		mode: one.mode,
		label: one.label,
		prefix: one.prefix,
		carrier: one.carrier,
		mac_mode: one.macMode,
		username: one.username,
		hasPassword: length(one.password) > 0,
		table_base: one.tableBase,
		service: one.service,
		ac: one.ac,
		ac_mac: one.acMac,
		mtu: one.mtu,
		keepalive: one.keepalive,
		ipv6: one.ipv6,
		peerdns: one.peerdns,
		dns: one.dns,
		defaultroute: one.defaultroute,
		host_uniq: one.hostUniq,
		demand: one.demand,
		padi_attempts: one.padiAttempts,
		padi_timeout: one.padiTimeout,
		pppd_options: one.pppdOptions,
		zone: one.zone,
		masq: one.masq,
		mtu_fix: one.mtuFix,
		lan_forward: one.lanForward,
		created: one.created,
		memberList: members
	};
};

/**
 * A partial spec folded over an existing record - what pool_set applies.
 *
 * A key that is absent keeps the stored value. `members`, when present,
 * replaces the whole list; a member that keeps its VLAN without sending a
 * password keeps the stored one, so editing a label never means retyping five
 * hundred passwords. A pool password that is absent is likewise kept.
 */
export function mergeSpec(previous, spec) {
	let merged = {
		id: previous.id,
		mode: exists(spec, 'mode') && length(text(spec.mode)) ? text(spec.mode) : previous.mode,
		label: exists(spec, 'label') ? text(spec.label) : previous.label,
		prefix: exists(spec, 'prefix') && length(text(spec.prefix)) ? text(spec.prefix) : previous.prefix,
		carrier: exists(spec, 'carrier') && length(text(spec.carrier)) ? text(spec.carrier) : previous.carrier,
		macMode: exists(spec, 'mac_mode') && length(text(spec.mac_mode))
			? (text(spec.mac_mode) == 'inherit' ? 'inherit' : 'auto')
			: previous.macMode,
		username: exists(spec, 'username') ? text(spec.username) : previous.username,
		password: exists(spec, 'password') && length(text(spec.password)) ? text(spec.password) : previous.password,
		tableBase: exists(spec, 'table_base') ? number(spec.table_base, previous.tableBase) : previous.tableBase,
		service: exists(spec, 'service') ? text(spec.service) : previous.service,
		ac: exists(spec, 'ac') ? text(spec.ac) : previous.ac,
		acMac: exists(spec, 'ac_mac') ? text(spec.ac_mac) : previous.acMac,
		mtu: exists(spec, 'mtu') ? number(spec.mtu, 0) : previous.mtu,
		keepalive: exists(spec, 'keepalive') ? text(spec.keepalive) : previous.keepalive,
		ipv6: exists(spec, 'ipv6') ? text(spec.ipv6) : previous.ipv6,
		peerdns: exists(spec, 'peerdns') ? flag(spec.peerdns, false) : previous.peerdns,
		dns: exists(spec, 'dns') ? listOf(spec.dns) : previous.dns,
		defaultroute: exists(spec, 'defaultroute') ? flag(spec.defaultroute, true) : previous.defaultroute,
		hostUniq: exists(spec, 'host_uniq') ? text(spec.host_uniq) : previous.hostUniq,
		demand: exists(spec, 'demand') ? number(spec.demand, 0) : previous.demand,
		padiAttempts: exists(spec, 'padi_attempts') ? number(spec.padi_attempts, 0) : previous.padiAttempts,
		padiTimeout: exists(spec, 'padi_timeout') ? number(spec.padi_timeout, 0) : previous.padiTimeout,
		pppdOptions: exists(spec, 'pppd_options') ? text(spec.pppd_options) : previous.pppdOptions,
		zone: exists(spec, 'zone') && length(text(spec.zone)) ? text(spec.zone) : previous.zone,
		masq: exists(spec, 'masq') ? flag(spec.masq, true) : previous.masq,
		mtuFix: exists(spec, 'mtu_fix') ? flag(spec.mtu_fix, true) : previous.mtuFix,
		lanForward: exists(spec, 'lan_forward') ? flag(spec.lan_forward, true) : previous.lanForward,
		created: previous.created,
		members: previous.members
	};

	if (!(merged.ipv6 in [ 'auto', '0', '1' ]))
		merged.ipv6 = '0';

	if (type(spec.members) == 'array') {
		let stored = {};
		for (let member in previous.members)
			stored[sprintf('%d', member.vlan)] = member;

		let members = [];
		for (let row in spec.members) {
			let member = memberFromSpec(row);
			let before = stored[sprintf('%d', member.vlan)];

			if (before && !length(member.password))
				member.password = before.password;
			if (before && !length(member.username))
				member.username = before.username;

			push(members, member);
		}

		merged.members = sort(members, (a, b) => a.vlan - b.vlan);
	}

	return merged;
};

// ---------------------------------------------------------------------------
// The one validation gate.

function finding(findings, level, label, detail) {
	push(findings, { level: level, label: label, detail: detail ? detail : '' });
};

/**
 * Why this device may not carry a pool, or null. The same refusals the app's
 * dropdown applies, so a carrier the form would never offer is a carrier the
 * daemon refuses by the same sentence.
 */
export function carrierRefusal(name) {
	if (type(name) != 'string' || !length(name) || length(name) > IFNAMSIZ)
		return 'a carrier is a device name of at most 15 characters, such as eth1';

	if (!match(name, /^[A-Za-z0-9_][A-Za-z0-9_-]*$/)) {
		if (index(name, '.') >= 0)
			return name + ' is already a tagged VLAN device - name the base device and put the VLAN in the member list';

		return name + ' is not a name a network device can have';
	}

	let lower = lc(name);

	if (lower == 'lo')
		return 'the loopback reaches no ISP';

	if (substr(lower, 0, 3) == 'br-')
		return name + ' is a bridge, not an uplink';

	for (let prefix in [ 'pppoe-', 'ppp', 'ifb', 'tun', 'tap', 'wg', 'veth', 'docker', 'incus' ]) {
		if (substr(lower, 0, length(prefix)) == prefix)
			return name + ' cannot reach an ISP: loopback, tunnel, mirror and container devices are never carriers';
	}

	return null;
};

/** Every routing table a record's members would use, as `{ "10101": vlan }`. */
function tablesOf(one) {
	let out = {};
	for (let member in one.members)
		out[sprintf('%d', tableFor(one.tableBase, member.vlan))] = member.vlan;
	return out;
};

/** Every MAC a record's members would be assigned, when that is knowable. */
function macsOf(one, carrierMac) {
	let out = {};

	if (one.macMode != 'auto' || !validMac(carrierMac))
		return out;

	for (let member in one.members) {
		if (member.vlan >= 1)
			out[macFor(carrierMac, one.id, member.vlan)] = member.vlan;
	}

	return out;
};

/**
 * The whole gate. Returns `{ ok, findings }`; ok means no finding is an error.
 *
 * `opts`:
 *   creating   true for pool_create - the id must be free
 *   previous   the stored record for pool_set - immutables and high-risk
 *              changes are judged against it
 *   devices    `{ name: { up, macaddr } }` from netifd, or null when it could
 *              not be asked - existence checks soften to warnings then
 *   sections   every section name in /etc/config/network, `{ name: true }`,
 *              or null when unknown
 *   liveUp     `{ sectionName: true }` for members currently up, for the
 *              "this change redials" warnings
 *   others     every other pool record (callers pass pools() minus this id)
 */
export function check(one, opts) {
	let findings = [];
	let creating = opts && opts.creating ? true : false;
	let previous = opts ? opts.previous : null;
	let devices = opts ? opts.devices : null;
	let sections = opts ? opts.sections : null;
	let liveUp = opts && opts.liveUp ? opts.liveUp : {};
	let others = opts && type(opts.others) == 'array' ? opts.others : [];

	// ---- identity
	if (!validPoolId(one.id))
		finding(findings, 'error', 'Pool id must be 1 to 31 lowercase letters, digits or underscores, starting with a letter');
	else if (creating && anyPool(one.id))
		finding(findings, 'error', 'This router already has a pool called ' + one.id);

	if (!(one.mode in [ 'multi', 'single' ]))
		finding(findings, 'error', 'Mode must be multi (one shared account) or single (one account per VLAN)');
	else if (previous && one.mode != previous.mode) {
		finding(findings, 'error', 'The mode of a pool cannot change',
			'A pool is created as ' + previous.mode + ' and stays that way. Delete it and create a new one to switch.');
	}

	if (length(one.label) && !safeValue(one.label))
		finding(findings, 'error', 'The label contains control characters or is longer than 128 characters');

	// ---- prefix
	if (!validPrefix(one.prefix)) {
		finding(findings, 'error', 'Prefix must be 1 to 4 lowercase letters or digits, starting with a letter',
			'The prefix names every interface: prefix fpt and VLAN 101 dial as fpt101 on device pppoe-fpt101.');
	}
	else {
		for (let other in others) {
			if (other.id != one.id && other.prefix == one.prefix) {
				finding(findings, 'error', 'Pool ' + other.id + ' already uses the prefix ' + one.prefix,
					'Two pools sharing a prefix would derive the same interface names.');
			}
		}
	}

	// ---- carrier
	let carrierProblem = carrierRefusal(one.carrier);
	if (carrierProblem) {
		finding(findings, 'error', 'Choose a valid carrier: ' + carrierProblem);
	}
	else if (devices) {
		if (!exists(devices, one.carrier)) {
			finding(findings, 'error', 'This router has no device called ' + one.carrier,
				'The carrier is the physical uplink the pool dials over.');
		}
		else if (!devices[one.carrier].up) {
			finding(findings, 'warning', 'Carrier ' + one.carrier + ' is down right now',
				'The pool can be created, but nothing will dial until the device comes up.');
		}
	}
	else {
		finding(findings, 'warning', 'The carrier could not be verified against the router\'s device list');
	}

	// ---- members
	if (!length(one.members)) {
		finding(findings, 'error', 'List at least one VLAN',
			'A pool without members is a pool with nothing to dial.');
	}
	else if (length(one.members) > MEMBER_MAX) {
		finding(findings, 'error', sprintf('At most %d members in one pool and %d were listed', MEMBER_MAX, length(one.members)));
	}

	let seen = {};
	let untagged = 0;
	for (let member in one.members) {
		if (member.vlan < 0 || member.vlan > 4094) {
			finding(findings, 'error', 'A VLAN has to be 0 to 4094',
				'VLAN 0 means untagged: the pool dials straight over the carrier.');
			continue;
		}

		let key = sprintf('%d', member.vlan);
		if (exists(seen, key))
			finding(findings, 'error', 'VLAN ' + key + ' is listed twice');
		seen[key] = true;

		if (member.vlan == 0)
			untagged++;
	}

	if (untagged > 1)
		finding(findings, 'error', 'Only one untagged member (VLAN 0) fits in a pool: there is only one bare carrier');

	// ---- cross-pool: (carrier, vlan) is unique on the router
	for (let other in others) {
		if (other.id == one.id || other.carrier != one.carrier)
			continue;

		let theirs = {};
		for (let member in other.members)
			theirs[sprintf('%d', member.vlan)] = true;

		for (let member in one.members) {
			if (exists(theirs, sprintf('%d', member.vlan))) {
				finding(findings, 'error',
					sprintf('VLAN %d on %s already belongs to pool %s', member.vlan, one.carrier, other.id),
					'One VLAN on one carrier can only be dialled by one pool - its member owns the tagged device and its MAC.');
			}
		}
	}

	// ---- credentials, per mode
	if (one.mode == 'multi') {
		if (!length(one.username) || !safeValue(one.username))
			finding(findings, 'error', 'Mode multi needs the shared account username');

		if (!length(one.password) || !safeValue(one.password))
			finding(findings, 'error', 'Mode multi needs the shared account password');

		if (one.macMode != 'auto') {
			finding(findings, 'error', 'Mode multi requires mac_mode auto',
				'Every session presents the same account, so each VLAN must present its own MAC - the BRAS separates them by it.');
		}

		if (length(one.members)) {
			finding(findings, 'warning',
				sprintf('%d session(s) will share one account', length(one.members)),
				'Confirm the ISP allows concurrent sessions on this account, and try 2-3 VLANs before creating the full list.');
		}

		if (untagged && length(one.members) > 1) {
			finding(findings, 'warning', 'The untagged member (VLAN 0) inherits the carrier MAC',
				'A pool that must give every session its own MAC should not carry an untagged member next to tagged ones.');
		}
	}
	else if (one.mode == 'single') {
		let accounts = {};
		for (let member in one.members) {
			if (member.vlan < 0)
				continue;

			if (!length(member.username) || !safeValue(member.username)) {
				finding(findings, 'error', sprintf('VLAN %d has no username', member.vlan),
					'Mode single carries one account per member: every row needs user and pass.');
				continue;
			}

			if (!length(member.password) || !safeValue(member.password)) {
				finding(findings, 'error', sprintf('VLAN %d has no password', member.vlan),
					'A member kept from the existing pool may omit it; a new member may not.');
				continue;
			}

			if (exists(accounts, member.username)) {
				finding(findings, 'warning',
					sprintf('VLANs %d and %d dial with the same username %s', accounts[member.username], member.vlan, member.username),
					'Two sessions on one account is what mode multi is for - most ISPs will drop one of them.');
			}
			else {
				accounts[member.username] = member.vlan;
			}
		}

		if (length(one.username) || length(one.password)) {
			finding(findings, 'info', 'The pool-level account is ignored in mode single',
				'Each member carries its own; the shared fields are only used by mode multi.');
		}
	}

	// ---- table range
	if (one.tableBase < 1 || one.tableBase > 65535) {
		finding(findings, 'error', 'Table base has to be 1 to 65535');
	}
	else {
		for (let member in one.members) {
			if (member.vlan < 0)
				continue;

			let table = tableFor(one.tableBase, member.vlan);
			if (table < 1 || table > 65535) {
				finding(findings, 'error',
					sprintf('VLAN %d would use routing table %d, which is beyond 65535', member.vlan, table),
					'Table = base + VLAN. Lower the base or the VLAN.');
			}
		}

		let mine = tablesOf(one);
		for (let other in others) {
			if (other.id == one.id)
				continue;

			let theirs = tablesOf(other);
			for (let table in mine) {
				if (exists(theirs, table)) {
					finding(findings, 'error',
						sprintf('Routing table %s collides with pool %s', table, other.id),
						'Each session owns its table; two pools writing one table would swap each other\'s routes.');
					break;
				}
			}
		}
	}

	// ---- derived names
	if (validPrefix(one.prefix)) {
		for (let member in one.members) {
			if (member.vlan < 0)
				continue;

			let netdev = netdevFor(one.prefix, member.vlan);
			if (length(netdev) > IFNAMSIZ) {
				finding(findings, 'error', netdev + ' is longer than Linux allows for an interface name');
			}

			let device = deviceFor(one.carrier, member.vlan);
			if (length(device) > IFNAMSIZ) {
				finding(findings, 'error', device + ' is longer than Linux allows for an interface name',
					'The carrier name plus the VLAN digits has to fit in 15 characters.');
			}
		}

		if (sections) {
			let owned = {};
			if (previous) {
				for (let member in previous.members)
					owned[sectionFor(previous.prefix, member.vlan)] = true;
			}

			for (let member in one.members) {
				if (member.vlan < 0)
					continue;

				let name = sectionFor(one.prefix, member.vlan);
				if (exists(sections, name) && !exists(owned, name)) {
					finding(findings, 'error',
						'Interface section ' + name + ' already exists on this router and is not part of this pool',
						'The pool would overwrite somebody else\'s interface. Choose another prefix.');
				}
			}
		}
	}

	// ---- MAC uniqueness
	if (devices && exists(devices, one.carrier) && validMac(devices[one.carrier].macaddr)) {
		let mine = macsOf(one, devices[one.carrier].macaddr);

		for (let other in others) {
			if (other.id == one.id)
				continue;

			let otherMac = (devices && exists(devices, other.carrier)) ? devices[other.carrier].macaddr : '';
			let theirs = macsOf(other, otherMac);

			for (let mac in mine) {
				if (exists(theirs, mac)) {
					finding(findings, 'error',
						sprintf('Generated MAC %s collides with pool %s', mac, other.id),
						'Two interfaces with one MAC on one segment take each other down.');
					break;
				}
			}
		}
	}

	// ---- the General / Advanced fields
	if (length(one.acMac) && !validMac(one.acMac))
		finding(findings, 'error', 'The access concentrator MAC is not a MAC address');

	if (one.mtu) {
		if (one.mtu < 576 || one.mtu > 9200)
			finding(findings, 'error', 'MTU has to be 576 to 9200, or empty for the pppd default');
		else if (one.mtu > 1492)
			finding(findings, 'info', 'PPPoE frames carry 8 bytes of header: an MTU above 1492 needs an ISP that supports RFC 4638');
	}

	if (length(one.keepalive) && !match(one.keepalive, /^[0-9]+( [0-9]+)?$/)) {
		finding(findings, 'error', 'Keepalive is "<failures> <interval>", both numbers',
			'pppd presumes the peer dead after that many missed LCP echoes sent that many seconds apart.');
	}

	if (length(one.hostUniq) && !match(one.hostUniq, /^([0-9a-fA-F]{2})+$/))
		finding(findings, 'error', 'Host-Uniq has to be raw hex bytes, such as dead12beef34');

	for (let server in one.dns) {
		if (!validDns(server))
			finding(findings, 'error', server + ' is not an IPv4 or IPv6 address');
	}

	if (length(one.dns) && one.peerdns) {
		finding(findings, 'info', 'The DNS list only applies while peerdns is off',
			'With peerdns on, the ISP\'s resolvers win and the list is ignored.');
	}

	if (one.demand < 0 || one.demand > 86400)
		finding(findings, 'error', 'Demand is idle seconds before hangup: 0 to 86400');

	if (one.padiAttempts < 0 || one.padiAttempts > 100)
		finding(findings, 'error', 'PADI attempts has to be 0 (default) to 100');

	if (one.padiTimeout < 0 || one.padiTimeout > 300)
		finding(findings, 'error', 'PADI timeout has to be 0 (default) to 300 seconds');

	if (length(one.pppdOptions)) {
		if (!safeValue(one.pppdOptions)) {
			finding(findings, 'error', 'Extra pppd options contain control characters');
		}
		else {
			finding(findings, 'warning', 'Extra pppd options are passed to pppd verbatim',
				'A wrong word here fails every session in the pool. ' + one.pppdOptions);
		}
	}

	for (let value in [ one.service, one.ac ]) {
		if (length(value) && !safeValue(value))
			finding(findings, 'error', 'Service and access concentrator names must be printable text');
	}

	// ---- firewall
	if (!validZone(one.zone)) {
		finding(findings, 'error', 'The firewall zone name has to be 1 to 11 letters, digits or underscores',
			'Kept inside fw3\'s old limit so the name survives every OpenWrt this could meet.');
	}

	// ---- high-risk edits, judged against the stored record
	if (previous) {
		if (one.carrier != previous.carrier) {
			finding(findings, 'warning', 'Changing the carrier redials every session in the pool',
				sprintf('All %d member(s) move from %s to %s and drop while they do.', length(one.members), previous.carrier, one.carrier));
		}

		if (one.tableBase != previous.tableBase) {
			finding(findings, 'warning', 'Changing the table base moves every routing table',
				'Binding rules that point at the old tables become stray; bm-wanbind clears them on its next pass, and clients re-bind.');
		}

		if (one.zone != previous.zone) {
			finding(findings, 'warning', 'Changing the zone moves every member\'s firewall membership',
				sprintf('Members leave %s and join %s; the old zone is removed when nothing else uses it.', previous.zone, one.zone));
		}

		if (one.macMode != previous.macMode) {
			finding(findings, 'warning', 'Changing the MAC mode redials every session',
				'The BRAS sees changed MACs; sessions drop and dial again presenting them.');
		}

		if (one.mode == 'multi' && length(one.password) && one.password != previous.password) {
			finding(findings, 'warning', 'Changing the password redials every session in the pool');
		}

		if (one.pppdOptions != previous.pppdOptions && length(one.pppdOptions)) {
			finding(findings, 'warning', 'Changed pppd options apply on the next dial of every session');
		}

		let kept = {};
		for (let member in one.members)
			kept[sprintf('%d', member.vlan)] = true;

		let dropped = [];
		for (let member in previous.members) {
			if (!exists(kept, sprintf('%d', member.vlan)) &&
			    exists(liveUp, sectionFor(previous.prefix, member.vlan)))
				push(dropped, member.vlan);
		}

		if (length(dropped)) {
			finding(findings, 'warning',
				sprintf('%d of the removed VLAN(s) are up right now', length(dropped)),
				'Their sessions are taken down and their interfaces removed with them.');
		}

		if (one.prefix != previous.prefix) {
			finding(findings, 'error', 'The prefix of a pool cannot change',
				'Every interface is named by it. Delete the pool and create a new one.');
		}
	}

	// ---- the standing note every report carries
	finding(findings, 'info', 'Tagged and untagged',
		'VLAN 0 dials untagged on the bare carrier. VLANs 1-4094 add an 802.1Q tag: the upstream must answer on that exact VLAN, and a wrong tag looks like a PADO timeout.');

	let ok = true;
	for (let one_ in findings) {
		if (one_.level == 'error')
			ok = false;
	}

	return { ok: ok, findings: findings };
};

// ---------------------------------------------------------------------------
// Writing the record.

/** The option written for a boolean. UCI has no booleans, only spellings. */
function bit(value) {
	return value ? '1' : '0';
};

/**
 * Record a pool: the pool section and one member section per VLAN.
 *
 * Written before the network sections and the firewall are, and removed after
 * they are: a record with no sections is a pool that can be deleted cleanly,
 * and sections with no record are sections nothing knows how to delete.
 *
 * The section is rewritten whole - deleted and set again - so an option that
 * is no longer set does not survive from the previous shape of the pool.
 */
export function remember(one) {
	try {
		let uci = cursor();

		uci.delete(PACKAGE, one.id);
		uci.set(PACKAGE, one.id, 'pool');
		uci.set(PACKAGE, one.id, 'mode', one.mode);
		if (length(one.label))
			uci.set(PACKAGE, one.id, 'label', one.label);
		uci.set(PACKAGE, one.id, 'prefix', one.prefix);
		uci.set(PACKAGE, one.id, 'carrier', one.carrier);
		uci.set(PACKAGE, one.id, 'mac_mode', one.macMode);

		if (one.mode == 'multi') {
			uci.set(PACKAGE, one.id, 'username', one.username);
			uci.set(PACKAGE, one.id, 'password', one.password);
		}

		uci.set(PACKAGE, one.id, 'table_base', sprintf('%d', one.tableBase));

		if (length(one.service))
			uci.set(PACKAGE, one.id, 'service', one.service);
		if (length(one.ac))
			uci.set(PACKAGE, one.id, 'ac', one.ac);
		if (length(one.acMac))
			uci.set(PACKAGE, one.id, 'ac_mac', one.acMac);
		if (one.mtu)
			uci.set(PACKAGE, one.id, 'mtu', sprintf('%d', one.mtu));
		if (length(one.keepalive))
			uci.set(PACKAGE, one.id, 'keepalive', one.keepalive);

		uci.set(PACKAGE, one.id, 'ipv6', one.ipv6);
		uci.set(PACKAGE, one.id, 'peerdns', bit(one.peerdns));
		if (length(one.dns))
			uci.set(PACKAGE, one.id, 'dns', one.dns);
		uci.set(PACKAGE, one.id, 'defaultroute', bit(one.defaultroute));

		if (length(one.hostUniq))
			uci.set(PACKAGE, one.id, 'host_uniq', one.hostUniq);
		if (one.demand)
			uci.set(PACKAGE, one.id, 'demand', sprintf('%d', one.demand));
		if (one.padiAttempts)
			uci.set(PACKAGE, one.id, 'padi_attempts', sprintf('%d', one.padiAttempts));
		if (one.padiTimeout)
			uci.set(PACKAGE, one.id, 'padi_timeout', sprintf('%d', one.padiTimeout));
		if (length(one.pppdOptions))
			uci.set(PACKAGE, one.id, 'pppd_options', one.pppdOptions);

		uci.set(PACKAGE, one.id, 'zone', one.zone);
		uci.set(PACKAGE, one.id, 'masq', bit(one.masq));
		uci.set(PACKAGE, one.id, 'mtu_fix', bit(one.mtuFix));
		uci.set(PACKAGE, one.id, 'lan_forward', bit(one.lanForward));
		uci.set(PACKAGE, one.id, 'created', sprintf('%d', one.created));

		// Member sections: every stored one of this pool goes, the new list
		// comes back. Collected before deleting, because deleting inside a
		// foreach over the same type is asking the iterator to keep its place
		// in a list being edited under it.
		let stale = [];
		uci.foreach(PACKAGE, 'member', (section) => {
			if (text(section.pool) == one.id)
				push(stale, text(section['.name']));
		});
		for (let name in stale)
			uci.delete(PACKAGE, name);

		for (let member in one.members) {
			let name = memberSection(one.id, member.vlan);
			uci.set(PACKAGE, name, 'member');
			uci.set(PACKAGE, name, 'pool', one.id);
			uci.set(PACKAGE, name, 'vlan', sprintf('%d', member.vlan));

			if (one.mode == 'single') {
				uci.set(PACKAGE, name, 'username', member.username);
				uci.set(PACKAGE, name, 'password', member.password);
			}
		}

		// The return is tested, not the exception: ucode's uci module never
		// raises past the cursor, every failure stashes a code and returns
		// null. A commit that silently failed would leave interfaces written
		// with no record naming them - the exact state this file prevents.
		if (uci.commit(PACKAGE) === null) {
			err('cannot record pool ' + one.id + ': the configuration would not commit');
			return false;
		}

		return true;
	}
	catch (e) {
		err('cannot record pool ' + one.id + ': ' + e);
		return false;
	}
};

/** Forget a pool: its member sections and then the pool section itself. */
export function forget(id) {
	try {
		let uci = cursor();

		let members = [];
		uci.foreach(PACKAGE, 'member', (section) => {
			if (text(section.pool) == id)
				push(members, text(section['.name']));
		});
		for (let name in members)
			uci.delete(PACKAGE, name);

		uci.delete(PACKAGE, id);
		uci.commit(PACKAGE);
		return true;
	}
	catch (e) {
		err('cannot remove the record of pool ' + id + ': ' + e);
		return false;
	}
};
