// What this router has, what its configuration needs, and where it stops.
//
// Every number here is an estimate and the reply says so. What that means in
// practice is three rules this file keeps:
//
//  1. A ceiling is `min` over the things that can cap a router, and the reply
//     names which one did. "About nine hundred sessions, limited by memory" is
//     something somebody can act on; a bare number is not.
//  2. Every constant carries where it came from - measured on a rig, derived
//     from a kernel structure, a hard limit in code, or a threshold somebody
//     chose - and the ones that have not been measured yet say so in the reply
//     rather than passing for measurement.
//  3. A fact this router would not answer makes its dimension `null` and drops
//     out of the `min`. It never becomes a zero, because a zero is a ceiling
//     and "I could not read your memory" is not a reason to tell somebody their
//     router holds nothing.
//
// The report is read-only. Every fix it names is an existing verb (see
// `bm.capfind`), and this file never writes anything.

import { connect } from 'ubus';
import { cursor } from 'uci';

import { debug } from 'bm.log';
import { list as featureList } from 'bm.features';
import { RELEASE } from 'bm.version';
import { current as tuneCurrent, flowOffload, flowOffloadHw, recommended } from 'bm.tune';
import {
	FLOW_OFFLOAD_THRESHOLD,
	flowOffloadKernel,
	fw4 as fw4Facts,
	hardware as hardwareFacts,
	hwOffloadCapable,
	leaseCount,
	leaseLimits,
	pppoeDevices,
	shellFacts,
	uciBoolean
} from 'bm.facts';
import { issues as findIssues, requirements as findRequirements } from 'bm.capfind';

/**
 * Everything the arithmetic below rests on, with where each number came from.
 *
 * `source` is one of:
 *   measured  - a rig measured it. `calibrated` says whether that has happened.
 *   derived   - arithmetic on a kernel structure or on another constant here.
 *   ceiling   - a hard limit in code, with the file that holds it.
 *   chosen    - a margin somebody picked, and could pick differently.
 *   heuristic - a rule of thumb that has not been measured and may be wrong.
 *
 * Never adjusted at runtime. A report that tuned its own constants from the
 * router it was describing would agree with that router about everything,
 * including about being broken.
 */
export const CONSTANTS = [
	{ name: 'KB_PER_SESSION', value: 320, unit: 'KB', source: 'measured', calibrated: false,
	  calibrate: 'MemAvailable at 0/100/250/500 dialled sessions, least squares' },
	{ name: 'KB_PER_BINDING', value: 8, unit: 'KB', source: 'measured', calibrated: false,
	  calibrate: 'MemAvailable at 0/250/500 bindings, 500 sessions held' },
	{ name: 'KB_PER_CLIENT', value: 6, unit: 'KB', source: 'measured', calibrated: false,
	  calibrate: 'MemAvailable over 500 leases on a bound LAN' },
	{ name: 'RESERVE_PERCENT', value: 15, unit: '% of RAM', source: 'chosen', calibrated: true,
	  calibrate: '' },
	{ name: 'RESERVE_MIN_KB', value: 65536, unit: 'KB', source: 'chosen', calibrated: true,
	  calibrate: '' },
	{ name: 'CONNTRACK_BYTES', value: 320, unit: 'B', source: 'derived', calibrated: true,
	  calibrate: 'nf_conntrack objsize in /proc/slabinfo, plus its hash bucket' },
	{ name: 'FLOWS_PER_SEAT', value: 128, unit: 'entries', source: 'heuristic', calibrated: false,
	  calibrate: 'nf_conntrack_count divided by leases plus sessions at steady load' },
	{ name: 'FLOW_OFFLOAD_THRESHOLD', value: FLOW_OFFLOAD_THRESHOLD, unit: 'sessions',
	  source: 'heuristic', calibrated: false,
	  calibrate: 'throughput at 64 and 500 sessions, offload on and off' },
	{ name: 'DIRECT_PREF_SPAN', value: 1000, unit: 'priorities', source: 'ceiling', calibrated: true,
	  calibrate: 'bm/wanbind/config.uc' },
	{ name: 'MEMBER_MAX', value: 500, unit: 'members per pool', source: 'ceiling', calibrated: true,
	  calibrate: 'bm/pppoe/config.uc' },
	{ name: 'UBUS_MSG_MAX', value: 1048576, unit: 'B', source: 'ceiling', calibrated: true,
	  calibrate: 'libubus UBUS_MAX_MSGLEN' },
	{ name: 'DUMP_BYTES_PER_IFACE', value: 900, unit: 'B', source: 'measured', calibrated: false,
	  calibrate: 'ubus call network.interface dump, bytes, at 0/100/250/500 sessions' },
	{ name: 'DUMP_OVERHEAD_BYTES', value: 4096, unit: 'B', source: 'measured', calibrated: false,
	  calibrate: 'the same measurement, intercept' },
	{ name: 'FLASH_BASE_KB', value: 4096, unit: 'KB', source: 'derived', calibrated: true,
	  calibrate: 'snapshot budget plus an update staging directory' },
	{ name: 'FLASH_KB_PER_SESSION', value: 1, unit: 'KB', source: 'measured', calibrated: false,
	  calibrate: 'wc -c /etc/config/network divided by members' },
	{ name: 'LEASE_HEADROOM', value: 16, unit: 'leases', source: 'chosen', calibrated: true,
	  calibrate: '' },
	{ name: 'PASS_BUDGET_MS', value: 3000, unit: 'ms', source: 'chosen', calibrated: true,
	  calibrate: '' }
];

const K = {};

for (let one in CONSTANTS)
	K[one.name] = one.value;

/** How long an answer is worth serving again before the router is read afresh. */
const CACHE_TTL_S = 10;

/**
 * How long to wait for either daemon.
 *
 * Seconds - `connect(socket, timeout)` takes seconds and multiplies by a
 * thousand itself. Short, because this is a read somebody is waiting on and a
 * daemon that is wedged must not hold the agent's whole loop for the thirty
 * seconds a default connection would.
 */
const CALL_TIMEOUT_S = 2;

/** The four sizes at which what a router needs changes. */
const TIERS_SESSIONS = [
	{ id: 's0', upTo: 64, label: 'up to 64 sessions', needs: [
		'any OpenWrt 25.12 router with firewall4',
		'128 MB of memory',
		'one core'
	] },
	{ id: 's1', upTo: 500, label: '65 to 500 sessions', needs: [
		'fw4 flow offload on',
		'256 MB of memory or more',
		'two cores',
		'conntrack and the neighbour table sized for the load',
		'one pool holds at most 500 members',
		'pool firewall zones matched by device pattern, not by listing every session'
	] },
	{ id: 's2', upTo: 1000, label: '501 to 1000 sessions', needs: [
		'512 MB of memory or more',
		'four cores',
		'a second pool',
		'replies that fit: member lists off, rule pages on'
	] },
	{ id: 's3', beyond: 1000, label: 'over 1000 sessions', needs: [
		'more interfaces than the router\'s own interface list fits in one ubus message',
		'per-interface reads instead of that list, which is not what this release does',
		'1 GB of memory and a CPU of desktop grade',
		'several pools on several carriers'
	] }
];

const TIERS_BINDINGS = [
	{ id: 'b0', upTo: 64, label: 'up to 64 bindings', needs: [
		'LAN-local rules on, so a bound address still reaches its own network',
		'a DHCP lease ceiling above the client count'
	] },
	{ id: 'b1', upTo: 500, label: '65 to 500 bindings', needs: [
		'fw4 flow offload on',
		'the DHCP lease ceiling raised',
		'the neighbour table sized for the clients'
	] },
	{ id: 'b2', upTo: 1000, label: '501 to 1000 bindings', needs: [
		'band headroom: 1000 one-to-one priorities is the ceiling',
		'conntrack sized for the clients',
		'512 MB of memory or more'
	] },
	{ id: 'b3', beyond: 1000, label: 'over 1000 bindings', needs: [
		'not possible as one-to-one bindings: the priority band is 1000 wide',
		'an instance seats the rest from leases instead'
	] }
];

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
}

function number(value, fallback) {
	if (type(value) == 'int')
		return value;

	if (type(value) == 'string' && match(trim(value), /^[0-9]+$/))
		return int(trim(value));

	return fallback;
}

/**
 * A uci boolean with a default for "the option is not there at all", which is a
 * third answer `bm.facts`'s own reader does not have to give: an absent
 * `enabled` on a section means enabled, and an absent one elsewhere might not.
 */
function flag(value, fallback) {
	if (type(value) == 'bool')
		return value;

	let one = lc(text(value));

	if (!length(one))
		return fallback;

	return uciBoolean(one);
}

function listOf(value) {
	if (type(value) == 'array')
		return value;

	let one = text(value);

	return length(one) ? split(one, /[ \t]+/) : [];
}

function floor10(value) {
	let n = (type(value) == 'int') ? value : int(value);

	if (n < 0)
		return 0;

	return n - (n % 10);
}

// ---------------------------------------------------------------------------
// What is configured, read off the files rather than asked of the daemons.
//
// This is what makes `bmctl capacity` work on a router where neither daemon is
// running - which is the router somebody is most likely to be running it on.

function poolsConfigured(uci) {
	let out = { pools: [], members: 0, prefixes: {} };

	if (uci == null)
		return out;

	let byPool = {};

	try {
		uci.foreach('bm_pppoe', 'member', (section) => {
			let id = text(section.pool);

			if (!length(id))
				return;

			byPool[id] = (exists(byPool, id) ? byPool[id] : 0) + 1;
		});

		uci.foreach('bm_pppoe', 'pool', (section) => {
			let id = text(section['.name']);
			let members = exists(byPool, id) ? byPool[id] : 0;

			// The old model wrote a sequence range rather than member sections.
			let from = number(section.seq_from, 0);
			let to = number(section.seq_to, 0);

			if (!members && from > 0 && to >= from)
				members = to - from + 1;

			push(out.pools, {
				id: id,
				prefix: text(section.prefix),
				zone: text(section.zone),
				members: members
			});

			out.members += members;
			out.prefixes[text(section.prefix)] = id;
		});
	}
	catch (e) {
		debug('cannot read /etc/config/bm_pppoe: ' + e);
	}

	return out;
}

/**
 * How many addresses an instance's range covers, or 0 when it has none.
 *
 * Its own parser rather than bm-wanbind's, because the dependency only runs the
 * other way: the daemons import from this package and this package must not
 * import from them - they are optional, and ucode resolves an import at load.
 *
 * Bounded at the /16 an instance could plausibly seat. A range read out of a
 * hand-edited file could otherwise put a number in the lease requirement that
 * makes every other figure on the page look absurd.
 */
function rangeSize(from, to) {
	let a = match(trim(text(from)), /^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$/);
	let b = match(trim(text(to)), /^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$/);

	if (!a || !b)
		return 0;

	let low = 0;
	let high = 0;

	for (let i = 1; i <= 4; i++) {
		low = (low * 256) + int(a[i]);
		high = (high * 256) + int(b[i]);
	}

	if (high < low)
		return 0;

	let span = (high - low) + 1;

	return (span > 65536) ? 65536 : span;
}

function wanbindConfigured(uci) {
	let out = {
		instances: 0,
		bindings: 0,
		prefsClaimed: 0,
		rangedClients: 0,
		lanLocal: true,
		firstInstance: ''
	};

	if (uci == null)
		return out;

	try {
		uci.foreach('bm_wanbind', 'instance', (section) => {
			if (!flag(section.enabled, true))
				return;

			out.instances++;

			// The clients an instance seats out of a range, which is not the
			// same as the leases the router is handing out right now - a range
			// is a claim on addresses whether or not anything is using them,
			// and the DHCP ceiling has to cover it. Nothing assigned this, so
			// the lease requirement under-counted every range-scoped instance
			// by its whole range.
			out.rangedClients += rangeSize(section.range_from, section.range_to);

			if (!length(out.firstInstance))
				out.firstInstance = text(section['.name']);
		});

		uci.foreach('bm_wanbind', 'direct', (section) => {
			// Every section holds its number, disabled and refused ones
			// included: the band is what a new binding has to find a free
			// priority in, and a switched-off one is one `enabled 1` away from
			// wanting its own back.
			if (number(section.pref, 0) >= 1)
				out.prefsClaimed++;

			if (flag(section.enabled, true))
				out.bindings++;
		});

		out.lanLocal = flag(uci.get('bm_wanbind', 'main', 'lan_local'), true);
	}
	catch (e) {
		debug('cannot read /etc/config/bm_wanbind: ' + e);
	}

	return out;
}

function zonesConfigured(uci, pools) {
	let out = [];

	if (uci == null)
		return out;

	let wanted = {};

	for (let pool in pools.pools) {
		if (length(pool.zone))
			wanted[pool.zone] = true;
	}

	try {
		uci.foreach('firewall', 'zone', (section) => {
			let name = text(section.name);

			if (!exists(wanted, name))
				return;

			push(out, {
				name: name,
				networks: length(listOf(section.network)),
				devices: length(listOf(section.device))
			});
		});
	}
	catch (e) {
		debug('cannot read /etc/config/firewall: ' + e);
	}

	return out;
}

// ---------------------------------------------------------------------------
// What the daemons say, when they are answering.

function ask(bus, object, method, args) {
	if (!bus)
		return null;

	try {
		let reply = bus.call(object, method, (type(args) == 'object') ? args : {});
		return (type(reply) == 'object') ? reply : null;
	}
	catch (e) {
		debug(object + ' ' + method + ' did not answer: ' + e);
		return null;
	}
}

function askWanbind(bus) {
	let out = {
		answered: false, bound: 0, waiting: 0, ipRules: null, missingRules: 0,
		foreignInBands: 0, netifdOk: null, lanLocal: null, localUsable: null,
		localReason: '', release: '', lastPassMs: 0
	};

	// One call first. A daemon that is not there costs one timeout rather than
	// four, which on a two-second timeout is the difference between a page that
	// is slow and one that looks hung.
	let info = ask(bus, 'bm.wanbind', 'info', {});

	if (info == null)
		return out;

	out.answered = true;
	out.release = text(info.release);

	if (type(info.core) == 'object')
		out.bound = number(info.core.bound, 0);

	if (type(info.netifd) == 'object')
		out.netifdOk = (info.netifd.ok === true);

	if (type(info.local) == 'object') {
		out.lanLocal = (info.local.enabled === true);
		out.localUsable = (info.local.usable === true);
		out.localReason = text(info.local.reason);
	}

	let stats = ask(bus, 'bm.wanbind', 'stats', {});

	if (type(stats) == 'object' && type(stats.timings) == 'object')
		out.lastPassMs = number(stats.timings.totalMs, 0);

	let rules = ask(bus, 'bm.wanbind', 'rules', { limit: 1, reasons: false });

	if (type(rules) == 'object' && rules.read === true) {
		out.ipRules = number(rules.raw, number(rules.count, 0));

		if (type(rules.bands) == 'object')
			out.foreignInBands = number(rules.bands.foreign, 0);
	}

	let verify = ask(bus, 'bm.wanbind', 'verify', { instance: '' });

	if (type(verify) == 'object' && verify.read === true && type(verify.missing) == 'array')
		out.missingRules = length(verify.missing);

	return out;
}

function askPppoe(bus) {
	let out = { answered: false, up: 0, members: 0, blind: false, release: '', queueDepth: 0 };
	let info = ask(bus, 'bm.pppoe', 'info', { members: false });

	if (info == null)
		return out;

	out.answered = true;
	out.release = text(info.release);
	out.blind = (info.blind != null);

	for (let pool in (type(info.pools) == 'array') ? info.pools : []) {
		out.up += number(pool.up, 0);
		out.members += number(pool.members, 0);
	}

	let stats = ask(bus, 'bm.pppoe', 'stats', {});

	if (type(stats) == 'object')
		out.queueDepth = number(stats.queueDepth, 0);

	return out;
}

// ---------------------------------------------------------------------------
// The model.

function neededFor(load, hardware, software) {
	let sessions = load.configured.members;
	let bindings = load.configured.bindings;
	let clients = load.clients;

	let advice = recommended({ clients: clients, sessions: sessions }, hardware.memTotalKb);
	let conntrackKb = (advice.conntrack_max * K.CONNTRACK_BYTES) / 1024;

	// What this router is using now, with the live load taken back out - so the
	// figure below is "what it would need", not "what it is using plus what it
	// would need again".
	let idleKb = null;

	if (type(hardware.memTotalKb) == 'int' && type(hardware.memAvailableKb) == 'int') {
		idleKb = hardware.memTotalKb - hardware.memAvailableKb
			- (load.live.sessionsUp * K.KB_PER_SESSION)
			- (load.live.bound * K.KB_PER_BINDING)
			- (load.live.leases * K.KB_PER_CLIENT);

		if (idleKb < 0)
			idleKb = 0;
	}

	let reserveKb = null;

	if (type(hardware.memTotalKb) == 'int') {
		reserveKb = (hardware.memTotalKb * K.RESERVE_PERCENT) / 100;

		if (reserveKb < K.RESERVE_MIN_KB)
			reserveKb = K.RESERVE_MIN_KB;
	}

	let memKb = null;

	if (idleKb != null && reserveKb != null) {
		memKb = idleKb + reserveKb + conntrackKb
			+ (sessions * K.KB_PER_SESSION)
			+ (bindings * K.KB_PER_BINDING)
			+ (clients * K.KB_PER_CLIENT);
	}

	let pools = length(load.configured.pools);
	let wantPools = (sessions > 0) ? ((sessions + K.MEMBER_MAX - 1) / K.MEMBER_MAX) : 0;

	return {
		memKb: (memKb == null) ? null : int(memKb),
		idleKb: (idleKb == null) ? null : int(idleKb),
		reserveKb: (reserveKb == null) ? null : int(reserveKb),
		conntrackFullKb: int(conntrackKb),
		cpus: (sessions > K.FLOW_OFFLOAD_THRESHOLD) ? ((sessions > 500) ? 4 : 2) : 1,
		flashKb: K.FLASH_BASE_KB + (sessions * K.FLASH_KB_PER_SESSION),
		flowOffload: (sessions > K.FLOW_OFFLOAD_THRESHOLD || bindings > K.FLOW_OFFLOAD_THRESHOLD),
		conntrackMax: advice.conntrack_max,
		gcThresh1: advice.gc_thresh1,
		gcThresh2: advice.gc_thresh2,
		gcThresh3: advice.gc_thresh3,
		conntrackMemCapped: advice.mem_capped,
		// The larger of the two, not their sum. `clients` is the live lease count
		// and `rangedClients` is the addresses an instance's range claims - and
		// on the router that raised this, they are the same addresses. Adding
		// them charged the router twice for every client the range exists to
		// seat, which on stock DHCP settings made an ordinary range-scoped
		// instance read `unstable` against a ceiling it was already inside; and
		// the fix offered raises the ceiling to about the range size, so it
		// could never clear the row it was offered for.
		//
		// What this does not model is two LANs: a range on one and the leases on
		// another are different addresses, and the larger of the two under-states
		// what the router as a whole hands out. Getting that right means a
		// per-LAN model, and the ceiling it would be compared against is itself a
		// mix of a router-wide `dhcpleasemax` and the lowest per-LAN `limit`. The
		// direction of the error is the milder one - this row advises, it does not
		// gate - and over-stating it was the failure that had to go.
		leaseMax: ((load.configured.rangedClients > clients)
			? load.configured.rangedClients
			: clients) + K.LEASE_HEADROOM,
		prefs: bindings,
		pools: (wantPools > pools) ? int(wantPools) : pools
	};
}

function dimensions(load, hardware, software, needed) {
	let out = {
		memory: null, cpu: null, pool: null, conntrack: null, neigh: null,
		lease: null, band: null, dump: null
	};

	let sessions = load.configured.members;
	let bindings = load.configured.bindings;
	let clients = load.clients;

	if (needed.memKb != null && type(hardware.memTotalKb) == 'int') {
		let spare = hardware.memTotalKb - needed.idleKb - needed.reserveKb - needed.conntrackFullKb;
		let forSessions = spare - (bindings * K.KB_PER_BINDING) - (clients * K.KB_PER_CLIENT);
		let forBindings = spare - (sessions * K.KB_PER_SESSION) - (clients * K.KB_PER_CLIENT);

		out.memory = {
			sessions: floor10((forSessions > 0 ? forSessions : 0) / K.KB_PER_SESSION),
			bindings: floor10((forBindings > 0 ? forBindings : 0) / K.KB_PER_BINDING)
		};
	}

	// No numeric CPU ceiling while offload is on, and that is deliberate: the
	// cost is per packet and per new flow, and this router does not know what
	// traffic it will carry. With offload off there is a number, and it is the
	// threshold the pool daemon already refuses past.
	if (software.flowOffload !== true || software.flowOffloadKernel === false) {
		out.cpu = { sessions: K.FLOW_OFFLOAD_THRESHOLD, bindings: K.FLOW_OFFLOAD_THRESHOLD };
	}

	let pools = length(load.configured.pools);
	out.pool = { sessions: K.MEMBER_MAX * ((pools > 0) ? pools : 1), bindings: null };

	// A total, like every other dimension here - "how many bindings fit", not
	// "how many are left". It was the remainder, and every dimension is compared
	// against the configured total by `stabilityOf`, so the ceiling fell by one
	// for every binding added and the comparison flipped at 501: exactly the
	// range the b2 tier calls ordinary. A router with six hundred bindings read
	// `unstable`, with a sentence about a ceiling of four hundred, printed under
	// a tier line saying 501 to 1000 is a size this release plans for.
	//
	// What the band actually costs is the priorities held by sections that are
	// not enabled bindings - switched off or refused - because those are one
	// `enabled 1` away from wanting their number back. Enabled ones are the
	// thing being counted, so they are not subtracted from their own ceiling.
	let heldByOthers = load.configured.prefsClaimed - load.configured.bindings;

	if (heldByOthers < 0)
		heldByOthers = 0;

	out.band = { sessions: null, bindings: K.DIRECT_PREF_SPAN - heldByOthers };

	if (type(software.conntrackMax) == 'int' && software.conntrackMax > 0) {
		let seats = software.conntrackMax / K.FLOWS_PER_SEAT;

		out.conntrack = {
			sessions: int((seats > clients) ? (seats - clients) : 0),
			bindings: int((seats > sessions) ? (seats - sessions) : 0)
		};
	}

	if (type(software.gcThresh3) == 'int' && software.gcThresh3 > 0) {
		let room = (software.gcThresh3 * 3) / 4;
		out.neigh = { sessions: null, bindings: int((room > 0) ? room : 0) };
	}

	if (type(software.leaseMax) == 'int' && software.leaseMax > 0)
		out.lease = { sessions: null, bindings: software.leaseMax };

	// The router's own interface list, which every daemon and the firewall read
	// on every pass. Past the size where it stops fitting in a ubus message they
	// do not see it late, they stop seeing it.
	let room = K.UBUS_MSG_MAX - K.DUMP_OVERHEAD_BYTES;
	out.dump = int(room / K.DUMP_BYTES_PER_IFACE);

	return out;
}

function ceilingOf(dims) {
	let order = [ 'memory', 'cpu', 'pool', 'conntrack', 'dump' ];
	let out = { sessions: null, bindings: null, limitedBy: { sessions: '', bindings: '' } };

	for (let name in order) {
		let one = dims[name];
		let value = null;

		if (name == 'dump')
			value = one;
		else if (type(one) == 'object' && type(one.sessions) == 'int')
			value = one.sessions;

		if (value == null)
			continue;

		if (out.sessions == null || value < out.sessions) {
			out.sessions = value;
			out.limitedBy.sessions = name;
		}
	}

	for (let name in [ 'band', 'memory', 'cpu', 'conntrack', 'neigh', 'lease' ]) {
		let one = dims[name];

		if (type(one) != 'object' || type(one.bindings) != 'int')
			continue;

		if (out.bindings == null || one.bindings < out.bindings) {
			out.bindings = one.bindings;
			out.limitedBy.bindings = name;
		}
	}

	return out;
}

function tierOf(table, n) {
	for (let one in table) {
		if (type(one.upTo) == 'int' && n <= one.upTo)
			return one;
	}

	return table[length(table) - 1];
}

function tiersFor(load, hardware, software, needed) {
	let sessions = tierOf(TIERS_SESSIONS, load.configured.members);
	let bindings = tierOf(TIERS_BINDINGS, load.configured.bindings);

	let nextOf = function(table, current) {
		let seen = false;

		for (let one in table) {
			if (seen)
				return one;

			if (one.id == current.id)
				seen = true;
		}

		return null;
	};

	let sessionsNext = nextOf(TIERS_SESSIONS, sessions);
	let bindingsNext = nextOf(TIERS_BINDINGS, bindings);

	return {
		sessions: {
			current: sessions.id,
			label: sessions.label,
			needs: sessions.needs,
			next: sessionsNext == null ? null : {
				at: (type(sessions.upTo) == 'int') ? (sessions.upTo + 1) : 0,
				label: sessionsNext.label,
				changes: sessionsNext.needs
			}
		},
		bindings: {
			current: bindings.id,
			label: bindings.label,
			needs: bindings.needs,
			next: bindingsNext == null ? null : {
				at: (type(bindings.upTo) == 'int') ? (bindings.upTo + 1) : 0,
				label: bindingsNext.label,
				changes: bindingsNext.needs
			}
		}
	};
}

function stabilityOf(rows, load, ceiling, hardware) {
	if (type(hardware.memTotalKb) != 'int') {
		return {
			level: 'unknown',
			reason: 'This router did not answer the basic questions about its own hardware, so nothing here is grounded.'
		};
	}

	for (let one in rows) {
		if (one.level == 'error')
			return { level: 'unstable', reason: one.label };
	}

	let sessions = load.configured.members;
	let bindings = load.configured.bindings;

	if (type(ceiling.sessions) == 'int' && sessions > ceiling.sessions) {
		return {
			level: 'unstable',
			reason: sprintf('%d sessions are configured against an estimated ceiling of about %d', sessions, ceiling.sessions)
		};
	}

	if (type(ceiling.bindings) == 'int' && bindings > ceiling.bindings) {
		return {
			level: 'unstable',
			reason: sprintf('%d bindings are configured against an estimated ceiling of about %d', bindings, ceiling.bindings)
		};
	}

	for (let one in rows) {
		if (one.level == 'warning')
			return { level: 'at-risk', reason: one.label };
	}

	if (type(ceiling.sessions) == 'int' && sessions * 5 > ceiling.sessions * 4) {
		return {
			level: 'at-risk',
			reason: sprintf('%d sessions against an estimated ceiling of about %d', sessions, ceiling.sessions)
		};
	}

	return {
		level: 'stable',
		reason: sprintf('%d session(s) and %d binding(s) fit with headroom on this hardware and these settings',
			sessions, bindings)
	};
}

// ---------------------------------------------------------------------------

/** Read the router and work all of it out. No cache; `report` has that. */
export function compute(options) {
	let opts = (type(options) == 'object') ? options : {};
	let bus = opts.bus ?? null;
	let uci = null;

	try {
		uci = cursor();
	}
	catch (e) {
		debug('cannot open uci: ' + e);
	}

	let shell = shellFacts();
	let hardware = hardwareFacts(shell);
	let fw = fw4Facts(shell);
	let tune = tuneCurrent();
	let limits = leaseLimits();

	let packages = { agent: RELEASE, wanbind: null, pppoe: null, luci: null };

	for (let one in featureList()) {
		if (one.name == 'bm-wanbind') packages.wanbind = text(one.version);
		if (one.name == 'bm-pppoe-pool') packages.pppoe = text(one.version);
		if (one.name == 'luci-app-bm') packages.luci = text(one.version);
	}

	let software = {
		release: hardware.openwrt,
		packages: packages,
		fw4: fw.present,
		fw4Loaded: fw.loaded,
		flowOffload: flowOffload(),
		flowOffloadKernel: flowOffloadKernel(hardware.kernel),
		hwOffload: { configured: flowOffloadHw(), capable: hwOffloadCapable(hardware.target) },
		conntrackMax: tune.values.conntrack_max,
		conntrackCount: tune.values.conntrack_count,
		gcThresh1: tune.values.gc_thresh1,
		gcThresh2: tune.values.gc_thresh2,
		gcThresh3: tune.values.gc_thresh3,
		leaseMax: (limits.dnsmasq < limits.lan) ? limits.dnsmasq : limits.lan,
		leaseMaxDefault: (limits.dnsmasqDefault && limits.lanDefault)
	};

	let pools = poolsConfigured(uci);
	let binder = wanbindConfigured(uci);
	let wanbind = askWanbind(bus);
	let pppoe = askPppoe(bus);
	let leases = leaseCount();

	// Live where a daemon answered, and the configuration where none did - so a
	// router with both daemons stopped still gets a report about the router it
	// is configured to be.
	let sessionsUp = pppoe.answered ? pppoe.up : (pppoeDevices() ?? 0);
	let bound = wanbind.answered ? wanbind.bound : 0;

	let load = {
		configured: {
			pools: pools.pools,
			members: pools.members,
			instances: binder.instances,
			bindings: binder.bindings,
			prefsClaimed: binder.prefsClaimed,
			rangedClients: binder.rangedClients,
			zones: zonesConfigured(uci, pools)
		},
		live: {
			sessionsUp: sessionsUp,
			bound: bound,
			leases: leases ?? 0,
			ipRules: wanbind.ipRules,
			conntrackCount: software.conntrackCount
		},
		answered: { wanbind: wanbind.answered, pppoe: pppoe.answered },
		clients: 0,
		instanceId: binder.firstInstance
	};

	load.clients = leases ?? binder.bindings;

	if (load.clients < binder.bindings)
		load.clients = binder.bindings;

	if (load.clients < 1)
		load.clients = 1;

	let needed = neededFor(load, hardware, software);
	let dims = dimensions(load, hardware, software, needed);
	let ceiling = ceilingOf(dims);

	let daemons = {
		release: wanbind.release,
		netifdOk: wanbind.netifdOk,
		blind: pppoe.blind,
		lanLocal: wanbind.answered ? wanbind.lanLocal : binder.lanLocal,
		localUsable: wanbind.localUsable,
		localReason: wanbind.localReason,
		localWritable: (wanbind.answered && wanbind.localUsable === true),
		missingRules: wanbind.missingRules,
		foreignInBands: wanbind.foreignInBands,
		queueDepth: pppoe.queueDepth,
		lastPassMs: wanbind.lastPassMs
	};

	let ctx = {
		hardware: hardware,
		software: software,
		load: load,
		needed: needed,
		ceiling: { dimensions: dims },
		daemons: daemons,
		K: K
	};

	let requirements = findRequirements(ctx);
	let issues = findIssues(ctx);
	let everything = [];

	for (let one in requirements)
		push(everything, one);

	for (let one in issues)
		push(everything, one);

	let calibrated = true;

	for (let one in CONSTANTS) {
		if (one.source == 'measured' && !one.calibrated)
			calibrated = false;
	}

	return {
		ok: true,
		at: time(),

		// Never absent, and never true in the sense a measurement is: the
		// ceiling below is where this router is expected to stop being stable,
		// not where it will.
		estimate: true,

		hardware: hardware,
		software: software,
		load: load,
		needed: needed,
		requirements: requirements,
		issues: issues,
		tiers: tiersFor(load, hardware, software, needed),
		ceiling: {
			sessions: ceiling.sessions,
			bindings: ceiling.bindings,
			limitedBy: ceiling.limitedBy,
			dimensions: dims,
			basis: {
				kbPerSession: K.KB_PER_SESSION,
				kbPerBinding: K.KB_PER_BINDING,
				kbPerClient: K.KB_PER_CLIENT,
				reserveKb: needed.reserveKb,
				calibrated: calibrated,
				calibratedOn: calibrated ? '' : 'nothing yet - these are working numbers until a rig measures them',
				arch: hardware.arch,
				archMatch: true,
				definition: 'sessions is how many would fit with the bindings and clients unchanged; bindings is the same the other way round'
			}
		},
		stability: stabilityOf(everything, load, ceiling, hardware),
		constants: CONSTANTS
	};
};

let cache = { at: 0, reply: null, busy: false };

function mono() {
	let now = clock(true);
	return type(now) == 'array' ? now[0] : 0;
}

/**
 * The same, with an answer kept for a few seconds.
 *
 * Two surfaces poll this - a page every thirty seconds, the app every minute -
 * and the read itself is a dozen files, four uci packages and up to six ubus
 * calls. Held briefly, a five-second poll costs no more than a thirty-second
 * one; and `busy` covers the case a synchronous ubus call makes possible, where
 * a second request arrives while this one is inside a nested loop waiting on a
 * daemon.
 */
export function report(options) {
	let opts = (type(options) == 'object') ? options : {};
	let now = mono();

	if (opts.refresh !== true && cache.reply != null && (now - cache.at) < CACHE_TTL_S)
		return { ...cache.reply, cachedAt: cache.at, fresh: false };

	if (cache.busy) {
		if (cache.reply != null)
			return { ...cache.reply, cachedAt: cache.at, fresh: false, stale: true };

		return { ok: false, reason: 'a capacity report is already being worked out; ask again in a moment' };
	}

	cache.busy = true;

	let answer;

	try {
		answer = compute(opts);
	}
	catch (e) {
		cache.busy = false;
		return { ok: false, reason: 'the capacity report could not be worked out: ' + e };
	}

	cache.busy = false;
	cache.reply = answer;
	cache.at = now;

	return { ...answer, cachedAt: now, fresh: true };
};

/** A connection of this file's own, with a timeout a person will wait for. */
export function openBus() {
	try {
		return connect(null, CALL_TIMEOUT_S);
	}
	catch (e) {
		debug('cannot connect to ubus: ' + e);
		return null;
	}
};
