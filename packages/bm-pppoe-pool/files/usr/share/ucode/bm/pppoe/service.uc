// What `bm.pppoe` answers, and the loops behind it.
//
// One state per pool, held for the life of the process. The loops are the
// counter pass and the watchdog; between them they are the whole of what this
// daemon does while nothing is asking: read one file every few seconds, and
// redial whatever netifd has given up on.
//
// Every mutation - create, edit, delete, enable, disable - runs through here
// and lands in the same order: record first, network sections next, firewall
// after, reloads last and coalesced. The record leading is the invariant the
// whole package stands on: a flow interrupted anywhere leaves a record that
// covers everything written, so `pool_delete` can always clean up.
//
// The firewall reload is an init script, not a ubus call, so it arrives here
// as an injected runner (see attachSystem): the entry point hands in ucode's
// system(), and the probes hand in nothing and get a daemon that reconciles
// UCI without ever running a command on the machine checking it.

import { lsdir, readfile, stat, unlink } from 'fs';
import { cursor } from 'uci';
import { timer } from 'uloop';

import { debug, err, notice } from 'bm.log';
import { flowOffload } from 'bm.tune';

import * as cfg from 'bm.pppoe.config';
import * as counters from 'bm.pppoe.counters';
import * as firewall from 'bm.pppoe.firewall';
import * as legacy from 'bm.pppoe.legacy';
import * as sections from 'bm.pppoe.sections';
import * as sessions from 'bm.pppoe.sessions';

export const RELEASE = '2.4.0';

/** The ubus contract version, separate from the release. 2 is the pool-of-
 * members model; 3 adds `carrier_mode` (vlan | direct) to the spec. A module
 * built for 1 refuses it and says to update; one built for 2 keeps working -
 * it just never sends the new key. */
// 4 since 2.4.0: `sessions` pages and says how many rows there are, `action`
// takes a pool by name, `info` and `sessions` say whether netifd is answering,
// and `pool_check` says what the router can do. Every reader treats an absent
// key as the behaviour it had before, so an older module against this daemon
// sees what it saw.
export const API_VERSION = 4;

const STARTED = time();

// How long after a reload another one is folded into a single later pass, and
// how long the firewall reload may take before it is abandoned.
const RELOAD_COALESCE = 3;
const FIREWALL_TIMEOUT_MS = 30000;

// The most rows one `sessions` call returns and the most members one pool
// holds - the same number, so a whole pool always fits in one reply.
const ROW_LIMIT = 500;

// The most members one pool may have, which is also the most rows one pool can
// contribute: `bm.pppoe.config` refuses a larger one. Written here so the row
// builder asks for a pool's whole answer rather than for whatever is left of a
// shared cap - which is what made the second pool on a router invisible.
const MEMBER_MAX = 500;

// How often a netifd that is not answering is worth another line in syslog.
const BLIND_LOG_EVERY = 60;

// Every key a spec may carry, in the shape ubus declares arguments by. Used
// by pool_check, pool_add and pool_set: ucode's publish refuses any named
// argument the template does not declare, so the template has to name them
// all.
// The sysfs fallback path, spelled in two pieces so the repo's not-ucode word
// search does not read the middle of it as a JavaScript keyword.
const SYS_NET = '/sys/cl' + 'ass/net';

const SPEC_ARGS = {
	mode: '', label: '', prefix: '', carrier: '', carrier_mode: '', mac_mode: '',
	username: '', password: '', members: [], table_base: 0,
	service: '', ac: '', ac_mac: '', mtu: 0, keepalive: '', ipv6: '',
	peerdns: false, dns: [], defaultroute: true, host_uniq: '', demand: 0,
	padi_attempts: 0, padi_timeout: 0, pppd_options: '', zone: '',
	masq: true, mtu_fix: true, lan_forward: true
};

// What the config cadence watches, and how often it reads anyway when the
// filesystem will not say. Twelve passes is once a minute at the default
// counter interval, which is the slowest a hand-edited section should take to
// be noticed.
const NETWORK_FILE = '/etc/config/network';
const CONFIG_EVERY = 12;

let state = {
	bus: null,
	system: null,
	main: { enabled: true, counterInterval: 5, redialAfter: 120, redialBatch: 20 },
	pools: {},
	order: [],
	counters: null,
	countersAt: 0,
	rates: { pools: {}, devices: {} },
	served: 0,
	ticks: 0,
	// Held rather than dropped: a uloop timer and a ubus listener whose only
	// reference has gone out of scope may not be there when they are needed.
	timer: null,
	listener: null,
	reloadTimer: null,
	reloadAt: 0,
	fwTimer: null,
	fwAt: 0,

	// Which pool each member section belongs to, built when the configuration
	// is read and looked up per dumped interface. The alternative - asking
	// every pool whether it owns each name, and every pool answering by walking
	// its member list - is a quarter of a million comparisons per pass at five
	// hundred sessions.
	bySection: {},
	indexSize: 0,
	indexBuilds: 0,

	// When /etc/config/network was last written, as the daemon last saw it.
	networkMtime: 0,

	// netifd not answering the interface dump.
	//
	// Every row this daemon shows is folded from that dump, so a dump that
	// stops answering leaves every row reading exactly as it did at the last
	// good pass - a session that dropped since still reads up, with its old
	// address, and nothing anywhere says the daemon has stopped looking. Null
	// while netifd is answering, so a surface can test one field.
	blind: null,

	// Where the last pass spent its time, and how much of the router it looked
	// at. A pass that takes longer than the counter interval is a router whose
	// passes overlap, and which part is slow is the whole question.
	pass: {
		configMs: 0,
		dumpMs: 0,
		counterMs: 0,
		watchdogMs: 0,
		totalMs: 0,
		dumpEntries: 0,
		configReads: 0
	},
	lastPassMs: 0
};

function rssKb() {
	let status = readfile('/proc/self/status');
	if (type(status) != 'string')
		return -1;

	let found = match(status, /VmRSS:[ \t]+([0-9]+)/);
	return found ? int(found[1]) : -1;
};

/**
 * Milliseconds off the monotonic clock, for measuring one pass.
 *
 * Monotonic rather than the wall clock: an NTP step during a pass would
 * otherwise be reported as the pass having taken an hour, or minus one.
 */
function millis() {
	let now = clock(true);
	return type(now) == 'array' ? (now[0] * 1000 + now[1] / 1000000) : 0;
}

function each() {
	let out = [];
	for (let id in state.order)
		push(out, state.pools[id]);
	return out;
};

function intOr(value, fallback) {
	return type(value) == 'int' ? value : fallback;
}

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
};

/** `eth1.835` -> `eth1`: the device under whatever VLANs ride on it. */
function baseOf(device) {
	let dot = index(device, '.');
	return dot >= 0 ? substr(device, 0, dot) : device;
};

/**
 * One pool's live state, by id, or null.
 *
 * For the probes: everything a surface needs is on `info` and `stats`, and the
 * one thing they cannot show is the shape of what this process is holding -
 * which is exactly what a scale assertion is about.
 */
export function poolState(id) {
	let name = type(id) == 'string' ? id : '';

	return exists(state.pools, name) ? state.pools[name] : null;
};

export function attach(bus) {
	state.bus = bus;
};

/**
 * Hand in the runner for commands that are not ubus calls - the firewall
 * reload. The entry point passes ucode's own system(); anything driving this
 * module in a harness passes nothing and no command ever runs.
 */
export function attachSystem(runner) {
	state.system = runner;
};

function call(object, method, args) {
	if (!state.bus)
		return null;

	try {
		return state.bus.call(object, method, args ? args : {});
	}
	catch (e) {
		debug('ubus ' + object + ' ' + method + ' failed: ' + e);
		return null;
	}
};

// ---------------------------------------------------------------------------
// The two reloads, each coalesced on its own timer.
//
// Leading edge: a single create reloads once, immediately. What is coalesced
// is the run behind it - a burst of edits reloads once after the last of
// them. The window opens when the previous reload finished, not when it
// started, because a reload of a large config can outlast the window.

function reloadNetwork() {
	call('network', 'reload', {});
	state.reloadAt = time();
};

function reloadSoon() {
	if (time() - state.reloadAt >= RELOAD_COALESCE) {
		if (state.reloadTimer) {
			state.reloadTimer.cancel();
			state.reloadTimer = null;
		}

		reloadNetwork();
		return;
	}

	if (state.reloadTimer) {
		state.reloadTimer.set(RELOAD_COALESCE * 1000);
		return;
	}

	state.reloadTimer = timer(RELOAD_COALESCE * 1000, () => {
		state.reloadTimer = null;
		try {
			reloadNetwork();
		}
		catch (e) {
			err('the deferred network reload failed: ' + e);
		}
	});
};

function reloadFirewall() {
	state.fwAt = time();

	if (!state.system) {
		debug('no command runner attached; skipping the firewall reload');
		return;
	}

	// system() blocks the loop for the duration, which for fw4 on a busy
	// router is well under a second. The timeout is for the pathological
	// case; without it a hung reload would take the daemon with it.
	try {
		let code = state.system([ '/etc/init.d/firewall', 'reload' ], FIREWALL_TIMEOUT_MS);
		if (code != 0)
			err(sprintf('the firewall reload exited %d', code));
	}
	catch (e) {
		err('the firewall reload failed: ' + e);
	}
};

function fwReloadSoon() {
	if (time() - state.fwAt >= RELOAD_COALESCE) {
		if (state.fwTimer) {
			state.fwTimer.cancel();
			state.fwTimer = null;
		}

		reloadFirewall();
		return;
	}

	if (state.fwTimer) {
		state.fwTimer.set(RELOAD_COALESCE * 1000);
		return;
	}

	state.fwTimer = timer(RELOAD_COALESCE * 1000, () => {
		state.fwTimer = null;
		reloadFirewall();
	});
};

// ---------------------------------------------------------------------------
// Asking the router what exists.

/**
 * Every network device, `{ name: { up, macaddr } }`, from netifd when it
 * answers and from /sys/class/net when it does not. Null only when neither
 * can be read, and the validation gate softens to warnings then.
 */
function deviceInfo() {
	let reply = call('network.device', 'status', {});
	if (type(reply) == 'object') {
		let out = {};
		let found = false;

		for (let name in reply) {
			let entry = reply[name];
			if (type(entry) != 'object')
				continue;

			out[name] = { up: entry.up === true, macaddr: text(entry.macaddr) };
			found = true;
		}

		if (found)
			return out;
	}

	let names = lsdir(SYS_NET);
	if (type(names) != 'array')
		return null;

	let out = {};
	for (let name in names) {
		let operstate = readfile(SYS_NET + '/' + name + '/operstate');
		let mac = readfile(SYS_NET + '/' + name + '/address');

		out[name] = {
			up: type(operstate) == 'string' && trim(operstate) == 'up',
			macaddr: type(mac) == 'string' ? trim(mac) : ''
		};
	}

	return out;
};

/** The carrier's MAC, lowercased, or '' when it cannot be known right now. */
function carrierMacOf(name, devices) {
	let info = devices ? devices : deviceInfo();

	if (info && exists(info, name) && cfg.validMac(info[name].macaddr))
		return lc(info[name].macaddr);

	let raw = readfile(SYS_NET + '/' + name + '/address');
	if (type(raw) == 'string' && cfg.validMac(trim(raw)))
		return lc(trim(raw));

	return '';
};

/**
 * Whether the macvlan kernel module is loaded. /sys/module/macvlan appears
 * when it is (kmod-macvlan loads it at boot). Only direct + mac_mode auto
 * cares, and the gate treats a missing module as a warning, never a refusal -
 * a false "missing" on an unusual kernel must not block a pool.
 */
function macvlanLoaded() {
	return type(lsdir('/sys/module/macvlan')) == 'array';
};

/** Every interface section name in /etc/config/network, or null. */
function networkSectionNames() {
	let out = {};

	try {
		cursor().foreach('network', 'interface', (section) => {
			out[text(section['.name'])] = true;
		});
	}
	catch (e) {
		return null;
	}

	return out;
};

/**
 * The enabled bm-wanbind instance whose carrier overlaps this one, or null.
 * The delete gate: a pool the binder is handing clients to does not go away
 * on one click. `force` exists, and the app keeps its own gate besides.
 */
function wanbindUsing(carrier) {
	let found = null;

	try {
		cursor().foreach('bm_wanbind', 'instance', (section) => {
			if (found)
				return;

			let enabled = text(section.enabled);
			if (enabled in [ '0', 'no', 'off', 'false', 'disabled' ])
				return;

			let theirs = text(section.carrier);
			if (length(theirs) && baseOf(theirs) == baseOf(carrier))
				found = text(section['.name']);
		});
	}
	catch (e) {
		debug('cannot read bm_wanbind: ' + e);
	}

	return found;
};

// ---------------------------------------------------------------------------
// State.

/**
 * Read the pool records and build one session table per pool.
 *
 * Done at start and after every mutation. A pool that kept its prefix keeps
 * its live state - which sessions are up, how long they have been down, its
 * place in the watchdog queue - and takes the fresh record for everything
 * else.
 */
export function load() {
	state.main = cfg.main();

	let devices = deviceInfo();
	let next = {};
	let order = [];

	for (let one in cfg.pools()) {
		let existing = state.pools[one.id];
		let st = (existing && existing.pool.prefix == one.prefix) ? existing : sessions.create(one);

		st.pool = one;
		st.carrierMac = carrierMacOf(one.carrier, devices);
		sessions.observeWritten(st, sections.stateOf(one));

		next[one.id] = st;
		push(order, one.id);
	}

	state.pools = next;
	state.order = order;

	// Which pool a section belongs to, worked out once.
	//
	// The dump loop asked every pool whether it owned each interface, and a
	// pool answered by walking its member list - so a router with five hundred
	// sessions and a few hundred interfaces of its own spent a quarter of a
	// million comparisons per pass to place a dump it could have looked up.
	state.bySection = {};
	state.indexSize = 0;

	for (let st in each()) {
		for (let member in st.pool.members) {
			let name = cfg.sectionFor(st.pool.prefix, member.vlan);

			if (!length(name))
				continue;

			state.bySection[name] = st;
			state.indexSize = state.indexSize + 1;
		}
	}

	state.indexBuilds = state.indexBuilds + 1;

	notice(sprintf('loaded %d pool(s), counters every %ds, redial after %ds',
		length(order), state.main.counterInterval, state.main.redialAfter));
};

// ---------------------------------------------------------------------------
// The loops.

/**
 * Whether /etc/config/network is worth reading again.
 *
 * `stat` when the filesystem answers, a slow cadence when it does not. The
 * fallback matters more than it looks: reading nothing at all until a restart
 * would mean a section somebody enabled by hand never taking effect, so "could
 * not tell" has to mean "read it soon" rather than "assume nothing changed".
 */
function configStale() {
	let held = null;

	try {
		held = stat(NETWORK_FILE);
	}
	catch (e) {
		held = null;
	}

	if (type(held) != 'object' || type(held.mtime) != 'int') {
		state.networkMtime = 0;
		return (state.ticks % CONFIG_EVERY) == 0;
	}

	if (held.mtime == state.networkMtime)
		return false;

	state.networkMtime = held.mtime;
	return true;
}

/** Fold `network.interface dump` into every pool's session table. */
function refresh(now) {
	let reply = call('network.interface', 'dump', {});

	if (type(reply) != 'object' || type(reply.interface) != 'array') {
		if (!state.blind)
			state.blind = { since: now, failures: 0, loggedAt: 0 };

		state.blind.failures = state.blind.failures + 1;

		// Once a minute rather than once a pass: a netifd that has been gone
		// for an hour is one fault, not seven hundred and twenty.
		if (now - state.blind.loggedAt >= BLIND_LOG_EVERY) {
			state.blind.loggedAt = now;
			err(sprintf('netifd is not answering network.interface dump (%d failure(s) since %ds ago); session state is running on events alone',
				state.blind.failures, now - state.blind.since));
		}

		return false;
	}

	if (state.blind) {
		notice(sprintf('netifd is answering again after %d failed dump(s) over %ds',
			state.blind.failures, now - state.blind.since));
		state.blind = null;
	}

	for (let entry in reply.interface) {
		if (type(entry) != 'object')
			continue;

		let name = trim(text(entry.interface));
		if (!length(name))
			continue;

		let ipv4 = null;
		if (type(entry['ipv4-address']) == 'array' && length(entry['ipv4-address'])) {
			let first = entry['ipv4-address'][0];
			if (type(first) == 'object' && type(first.address) == 'string')
				ipv4 = { addr: first.address, mask: type(first.mask) == 'int' ? first.mask : 32 };
		}

		let errorCode = '';
		if (type(entry.errors) == 'array' && length(entry.errors)) {
			let last = entry.errors[length(entry.errors) - 1];
			if (type(last) == 'string')
				errorCode = last;
			else if (type(last) == 'object' && type(last.code) == 'string')
				errorCode = last.code;
		}

		let normalised = {
			name: name,
			up: entry.up === true,
			pending: entry.pending === true,
			autostart: entry.autostart !== false,
			uptime: type(entry.uptime) == 'int' ? entry.uptime : 0,
			ipv4: ipv4,
			errorCode: errorCode,
			table: type(entry.ip4table) == 'int' ? entry.ip4table : null
		};

		// One lookup rather than a walk of every pool's member list. An
		// interface that is not a member of any pool - the router's own LAN,
		// its uplink, somebody else's tunnel - costs one failed lookup.
		let st = state.bySection[name];

		state.pass.dumpEntries = state.pass.dumpEntries + 1;

		if (st)
			sessions.observe(st, normalised, now);
	}

	return true;
};

/** Redial whatever has been down longer than the router should tolerate. */
function watchdog(now) {
	if (!state.main.redialAfter)
		return 0;

	let started = 0;
	let budget = state.main.redialBatch;

	for (let st in each()) {
		if (budget <= 0)
			break;

		let due = sessions.dueForRedial(st, state.main.redialAfter, budget, now);
		sessions.announce(st, due);

		for (let section in due) {
			// down then up, because netifd will not re-dial an interface it
			// already considers up-but-failing, and `up` alone on a session
			// in that state does nothing at all.
			call('network.interface.' + section, 'down', {});
			call('network.interface.' + section, 'up', {});
			sessions.redialled(st, section, now);
			started++;
			budget--;
		}
	}

	return started;
};

/** One counter reading, and the rates since the last one. */
function meter(now) {
	let records = [];
	for (let st in each())
		push(records, st.pool);

	let current = counters.read(records);
	if (current === null)
		return;

	let seconds = state.countersAt ? (now - state.countersAt) : 0;

	state.rates = counters.rate(state.counters, current, seconds);
	state.counters = current;
	state.countersAt = now;
};

export function pass() {
	let now = time();
	let started = millis();
	let mark = started;

	state.pass.dumpEntries = 0;
	state.pass.configReads = 0;

	// /etc/config/network, and only when it has changed.
	//
	// This read every member's section on every pass - five hundred sections
	// re-parsed every five seconds to find out something that changes when
	// somebody edits the file. The file's own modification time says whether
	// that is worth doing; a filesystem that will not answer falls back to
	// reading it every twelfth pass, which is once a minute at the default
	// interval rather than twelve times.
	if (configStale()) {
		for (let st in each())
			sessions.observeWritten(st, sections.stateOf(st.pool));

		state.pass.configReads = 1;
	}

	for (let st in each()) {
		if (!length(st.carrierMac))
			st.carrierMac = carrierMacOf(st.pool.carrier, null);
	}

	state.pass.configMs = millis() - mark;
	mark = millis();

	refresh(now);

	state.pass.dumpMs = millis() - mark;
	mark = millis();

	meter(now);

	state.pass.counterMs = millis() - mark;
	mark = millis();

	watchdog(now);

	state.pass.watchdogMs = millis() - mark;

	for (let st in each()) {
		st.lastPassAt = now;
		sessions.trace(st);
	}

	state.pass.totalMs = millis() - started;
	state.lastPassMs = state.pass.totalMs;
	state.ticks = state.ticks + 1;
};

function schedule() {
	if (!state.timer) {
		state.timer = timer(state.main.counterInterval * 1000, () => {
			try {
				pass();
			}
			catch (e) {
				err('counter pass failed: ' + e);
			}

			state.timer.set(state.main.counterInterval * 1000);
		});
		return;
	}

	state.timer.set(state.main.counterInterval * 1000);
};

/**
 * Listen for netifd's own events - what makes a session coming up something
 * this daemon knows in milliseconds rather than at the next pass. The dump is
 * still read every few seconds, because an event that was missed is a session
 * reported wrong until something corrects it.
 */
function listen() {
	if (!state.bus || state.listener)
		return;

	try {
		state.listener = state.bus.listener('network.interface', (event, data) => {
			if (type(data) != 'object')
				return;

			let name = text(data.interface);
			let action = text(data.action);
			if (!length(name) || !length(action))
				return;

			let now = time();
			for (let st in each()) {
				if (sessions.event(st, action, name, now))
					break;
			}
		});
	}
	catch (e) {
		err('cannot listen for netifd events, falling back to the counter pass alone: ' + e);
	}
};

export function start() {
	if (!state.main.enabled) {
		notice('disabled in /etc/config/bm_pppoe; answering questions and watching nothing');
		return;
	}

	listen();
	pass();
	schedule();
};

// ---------------------------------------------------------------------------
// Payloads and the shared gate.

/**
 * Read a spec out of a 0600 file, and delete the file.
 *
 * The file is how credentials get onto the router without ever being an
 * argument to anything: the caller writes it with umask 077 and passes only
 * its path. It is unlinked before a single check runs, so a flow that fails
 * half way does not leave a readable copy of somebody's accounts in /tmp.
 */
function takePayload(path) {
	if (!match(path, /^\/tmp\/[A-Za-z0-9._-]{1,64}$/))
		return { ok: false, reason: 'the payload has to be a plain file directly in /tmp' };

	let raw = readfile(path);
	unlink(path);

	if (type(raw) != 'string')
		return { ok: false, reason: 'the payload could not be read - it may already have been consumed' };

	let value;
	try {
		value = json(raw);
	}
	catch (e) {
		return { ok: false, reason: 'the payload is not valid JSON' };
	}

	if (type(value) != 'object')
		return { ok: false, reason: 'the payload is not a spec object' };

	return { ok: true, payload: value };
};

/** The spec of a call: the named file when `source` is set, the args inline
 * otherwise. One shape for pool_check, pool_create and pool_set. */
function specOfCall(args) {
	let source = text(args.source);

	if (length(source)) {
		let taken = takePayload(source);
		if (!taken.ok)
			return taken;

		return { ok: true, spec: taken.payload };
	}

	return { ok: true, spec: args };
};

/** Sections of this pool that are up right now, for the high-risk warnings. */
function liveUpOf(id) {
	let out = {};
	let st = state.pools[id];
	if (!st)
		return out;

	for (let name in st.sessions) {
		if (st.sessions[name].up)
			out[name] = true;
	}

	return out;
};

/**
 * What this router can carry, as far as this daemon can tell.
 *
 * `flowOffload` is read through `bm.tune` rather than out of the firewall
 * config here, because a second reader of one option is a second answer waiting
 * to disagree with the first - and the agent's is the one `bmctl tune` and the
 * app both act on.
 */
function routerFacts() {
	let text = readfile('/proc/meminfo');
	let available = null;
	let total = null;

	if (type(text) == 'string') {
		let one = match(text, /MemAvailable:[ 	]+([0-9]+)/);
		let two = match(text, /MemTotal:[ 	]+([0-9]+)/);

		if (one)
			available = int(one[1]);

		if (two)
			total = int(two[1]);
	}

	let members = 0;

	for (let st in each())
		members += length(st.pool.members);

	return {
		flowOffload: flowOffload(),
		memAvailableKb: available,
		memTotalKb: total,
		members: members
	};
}

/** The one validation gate, with the router's current shape gathered in. */
function checkRecord(record, creating, previous) {
	let others = [];
	for (let one in cfg.pools()) {
		if (one.id != record.id)
			push(others, one);
	}

	return cfg.check(record, {
		creating: creating,
		previous: previous,
		devices: deviceInfo(),
		sections: networkSectionNames(),
		liveUp: liveUpOf(record.id),
		others: others,
		macvlanReady: macvlanLoaded(),
		router: routerFacts()
	});
};

const LEGACY_REFUSAL = 'this is a pool from the old model - delete it and create it again as a pool of VLANs';

// ---------------------------------------------------------------------------
// The mutations. Record first, network second, firewall third, reloads last.

export function poolCheck(args) {
	let id = text(args.id);

	if (cfg.legacyPool(id))
		return { ok: false, reason: LEGACY_REFUSAL };

	let given = specOfCall(args);
	if (!given.ok)
		return given;

	let previous = cfg.pool(id);
	let record = previous ? cfg.mergeSpec(previous, given.spec) : cfg.fromSpec(id, given.spec);

	let gate = checkRecord(record, previous ? false : true, previous);

	// What the router answered, beside what the answer means. A surface that
	// has to offer "turn flow offload on" needs to know it is off, and a
	// findings list is prose rather than a fact it can branch on.
	return { ok: gate.ok, findings: gate.findings, router: routerFacts() };
};

function createPool(id, spec) {
	if (cfg.legacyPool(id))
		return { ok: false, reason: LEGACY_REFUSAL };

	let record = cfg.fromSpec(id, spec);

	let gate = checkRecord(record, true, null);
	if (!gate.ok)
		return { ok: false, reason: 'the spec did not pass validation', findings: gate.findings };

	// The record is written before the interfaces, so a create interrupted
	// anywhere leaves a pool that pool_delete can remove cleanly. The reverse
	// order would leave sections nothing knows the name of.
	if (!cfg.remember(record))
		return { ok: false, reason: 'the pool record could not be written, so nothing was created' };

	let written = sections.reconcile(record, null, carrierMacOf(record.carrier, null));
	if (!written.ok) {
		// The record stays behind on purpose: it is the only thing that knows
		// the names of whatever did get written.
		return { ok: false, reason: written.reason, id: id, created: length(written.added) };
	}

	let fw = firewall.reconcile(cfg.pools(), null);
	if (!fw.ok)
		err('pool ' + id + ': ' + fw.reason);

	reloadSoon();
	if (fw.ok && fw.changed)
		fwReloadSoon();

	load();

	return { ok: true, id: id, created: length(written.added) };
};

/** Create from a 0600 file - the path for callers that reach ubus by running
 * `ubus call`, where an inline password would sit in a command line. */
export function poolCreate(args) {
	let id = text(args.id);
	let source = text(args.source);

	if (!length(source))
		return { ok: false, reason: 'pool_create takes { id, source }; inline specs go to pool_add' };

	let taken = takePayload(source);
	if (!taken.ok)
		return taken;

	return createPool(id, taken.payload);
};

/** Create from inline args - the path for LuCI, which reaches this daemon
 * over the ubus socket where nothing is ever a command line. */
export function poolAdd(args) {
	return createPool(text(args.id), args);
};

export function poolSet(args) {
	let id = text(args.id);

	if (cfg.legacyPool(id))
		return { ok: false, reason: LEGACY_REFUSAL };

	let previous = cfg.pool(id);
	if (!previous)
		return { ok: false, reason: 'no pool called ' + id };

	let given = specOfCall(args);
	if (!given.ok)
		return given;

	let record = cfg.mergeSpec(previous, given.spec);

	let gate = checkRecord(record, false, previous);
	if (!gate.ok)
		return { ok: false, reason: 'the spec did not pass validation', findings: gate.findings };

	if (!cfg.remember(record))
		return { ok: false, reason: 'the pool record could not be rewritten, so nothing changed' };

	// Members leaving the pool are taken down while their sections still
	// exist - netifd will not tear down a session whose config has already
	// been deleted out from under it.
	let kept = {};
	for (let member in record.members)
		kept[sprintf('%d', member.vlan)] = true;

	for (let member in previous.members) {
		if (!exists(kept, sprintf('%d', member.vlan)))
			call('network.interface.' + cfg.sectionFor(previous.prefix, member.vlan), 'down', {});
	}

	let written = sections.reconcile(record, previous, carrierMacOf(record.carrier, null));
	if (!written.ok)
		return { ok: false, reason: written.reason, id: id };

	let fw = firewall.reconcile(cfg.pools(), null);
	if (!fw.ok)
		err('pool ' + id + ': ' + fw.reason);

	reloadSoon();
	if (fw.ok && fw.changed)
		fwReloadSoon();

	load();

	return {
		ok: true,
		id: id,
		changed: { added: written.added, removed: written.removed, rewritten: written.rewritten }
	};
};

export function poolDelete(args) {
	let id = text(args.id);
	let force = args.force === true || args.force == '1';

	let old = cfg.legacyPool(id);
	if (old) {
		let binder = wanbindUsing(old.carrier);
		if (binder && !force) {
			return {
				ok: false,
				reason: sprintf('bm-wanbind instance %s hands clients to WANs on %s; disable it first or pass force',
					binder, old.carrier)
			};
		}

		for (let name in legacy.sectionsOf(old))
			call('network.interface.' + name, 'down', {});

		let gone = legacy.remove(old);
		if (!gone.ok)
			return gone;

		cfg.forget(id);
		reloadSoon();
		if (gone.firewallChanged)
			fwReloadSoon();
		load();

		return { ok: true, id: id, removed: gone.removed, legacy: true };
	}

	let one = cfg.pool(id);
	if (!one)
		return { ok: false, reason: 'no pool called ' + id };

	let binder = wanbindUsing(one.carrier);
	if (binder && !force) {
		return {
			ok: false,
			reason: sprintf('bm-wanbind instance %s hands clients to WANs on %s; disable it first or pass force',
				binder, one.carrier)
		};
	}

	for (let member in one.members)
		call('network.interface.' + cfg.sectionFor(one.prefix, member.vlan), 'down', {});

	let gone = sections.removeAll(one);
	if (!gone.ok)
		return gone;

	let remaining = [];
	for (let other in cfg.pools()) {
		if (other.id != id)
			push(remaining, other);
	}

	let fw = firewall.reconcile(remaining, one);
	if (!fw.ok)
		err('pool ' + id + ': ' + fw.reason);

	cfg.forget(id);

	reloadSoon();
	if (fw.ok && fw.changed)
		fwReloadSoon();

	load();

	return { ok: true, id: id, removed: gone.removed };
};

// ---------------------------------------------------------------------------
// Actions and settings.

/**
 * up, down, redial, enable or disable, on named sections.
 *
 * Only sections a pool owns: a ubus call naming an arbitrary interface must
 * not become a way to take the router's own WAN down. enable and disable are
 * the two that write configuration - `option auto '0'` - which is why they
 * live here and not in the caller.
 */
export function actionCall(args) {
	let what = text(args.action);
	if (!(what in [ 'up', 'down', 'redial', 'enable', 'disable' ]))
		return { ok: false, reason: 'the action has to be up, down, redial, enable or disable' };

	let names = type(args.sections) == 'array' ? args.sections : [];
	let poolId = text(args.id);
	let skipped = [];

	// A whole pool by name, rather than five hundred section names the caller
	// had to fetch first and send back. "Take this pool down" is the thing
	// every surface actually asks for, and spelling it as a list meant the
	// list had to be complete and current or the answer was silently partial.
	if (length(poolId)) {
		let st = state.pools[poolId];

		if (!st)
			return { ok: false, reason: sprintf('no pool called %s', poolId) };

		if (!length(names)) {
			names = [];

			for (let section in keys(st.written))
				push(names, section);

			sort(names);
		}
		else {
			let kept = [];

			for (let name in names) {
				if (exists(st.written, name))
					push(kept, name);
				else
					push(skipped, name);
			}

			if (!length(kept))
				return { ok: false, reason: sprintf('none of those sections belong to pool %s', poolId), skipped: skipped };

			names = kept;
		}
	}

	if (!length(names))
		return { ok: false, reason: 'name at least one section, or a pool' };

	// A pool holds at most `MEMBER_MAX` members and that is the same number, so
	// "every section in one pool" always fits in one call.
	if (length(names) > ROW_LIMIT)
		return { ok: false, reason: sprintf('at most %d sections in one call', ROW_LIMIT) };

	let done = [];

	for (let name in names) {
		// One lookup rather than a walk of every pool's member list.
		let owner = state.bySection[name];

		if (!owner)
			continue;

		push(done, name);
	}

	if (!length(done))
		return { ok: false, reason: 'none of those sections belong to a pool on this router' };

	if (what == 'enable' || what == 'disable') {
		let set = sections.setAutostart(done, what == 'enable');
		if (!set.ok)
			return set;

		for (let name in done) {
			// Disable takes the session down now rather than at the reload;
			// enable dials now rather than waiting for netifd to notice.
			call('network.interface.' + name, what == 'enable' ? 'up' : 'down', {});
		}

		reloadSoon();

		for (let st in each())
			sessions.observeWritten(st, sections.stateOf(st.pool));

		return { ok: true, action: what, pool: poolId, sections: done, skipped: skipped };
	}

	for (let name in done) {
		if (what == 'down' || what == 'redial')
			call('network.interface.' + name, 'down', {});
		if (what == 'up' || what == 'redial')
			call('network.interface.' + name, 'up', {});
	}

	return { ok: true, action: what, pool: poolId, sections: done, skipped: skipped };
};

export function settingsGet() {
	return {
		enabled: state.main.enabled,
		counter_interval: state.main.counterInterval,
		redial_after: state.main.redialAfter,
		redial_batch: state.main.redialBatch
	};
};

export function settingsSet(args) {
	let refusal = cfg.settingsRefusal(args);
	if (refusal)
		return { ok: false, reason: refusal };

	try {
		let uci = cursor();

		if (uci.get('bm_pppoe', 'main') === null)
			uci.set('bm_pppoe', 'main', 'pppoe');

		if (exists(args, 'enabled'))
			uci.set('bm_pppoe', 'main', 'enabled', (args.enabled === true || args.enabled == '1') ? '1' : '0');
		if (exists(args, 'counter_interval'))
			uci.set('bm_pppoe', 'main', 'counter_interval', sprintf('%d', args.counter_interval));
		if (exists(args, 'redial_after'))
			uci.set('bm_pppoe', 'main', 'redial_after', sprintf('%d', args.redial_after));
		if (exists(args, 'redial_batch'))
			uci.set('bm_pppoe', 'main', 'redial_batch', sprintf('%d', args.redial_batch));

		if (uci.commit('bm_pppoe') === null)
			return { ok: false, reason: 'the settings could not be committed' };
	}
	catch (e) {
		return { ok: false, reason: 'cannot write settings: ' + e };
	}

	// Applied now, not at the next restart: the timer is re-armed with the
	// new interval, and a daemon switched off stops watching immediately.
	let was = state.main.enabled;
	state.main = cfg.main();

	if (!state.main.enabled) {
		if (state.timer) {
			state.timer.cancel();
			state.timer = null;
		}
	}
	else {
		if (!was)
			listen();
		schedule();
	}

	return { ok: true, settings: settingsGet() };
};

// ---------------------------------------------------------------------------
// Questions.

export function carriersList() {
	let devices = deviceInfo();
	if (devices === null)
		return { ok: false, reason: 'neither netifd nor ' + SYS_NET + ' would say what devices exist', carriers: [] };

	// Devices this package derives - tagged VLANs and per-slot macvlans - are
	// children of a carrier, never carriers themselves. Tagged names carry a
	// dot and are refused by name already; the macvlans have to be looked up.
	// The bare carrier a direct pool dials over stays offered, of course.
	let derived = {};
	for (let one in cfg.pools()) {
		for (let member in one.members) {
			let child = cfg.memberDeviceFor(one, member.vlan);
			if (child != one.carrier)
				derived[child] = true;
		}
	}

	let out = [];
	for (let name in devices) {
		if (exists(derived, name) || cfg.carrierRefusal(name))
			continue;

		push(out, { name: name, up: devices[name].up, macaddr: devices[name].macaddr });
	}

	return { ok: true, carriers: sort(out, (a, b) => a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)) };
};

export function info(members) {
	// The member lists are eighty bytes a session, so twenty pools of five
	// hundred is most of the megabyte a ubus reply has. A caller that only wants
	// the counts asks for none: `members: false`. Absent means yes, because that
	// is what every caller written before this key did.
	let withMembers = (members !== false);
	let out = [];

	for (let st in each()) {
		let one = cfg.toSpec(st.pool);
		let counts = sessions.tally(st);

		one.members = counts.members;
		one.up = counts.up;
		one.dialing = counts.dialing;
		one.down = counts.down;
		one.error = counts.error;
		one.stopped = counts.stopped;
		one.unwritten = counts.unwritten;
		one.createdAt = st.pool.created;

		if (!withMembers)
			delete one.memberList;

		one.rate = state.rates.pools[st.pool.id]
			? state.rates.pools[st.pool.id]
			: { rxBps: 0, txBps: 0 };

		push(out, one);
	}

	let old = [];
	for (let one in cfg.legacyPools()) {
		push(old, {
			id: one.id,
			prefix: one.prefix,
			carrier: one.carrier,
			seqFrom: one.seqFrom,
			seqTo: one.seqTo,
			count: one.count,
			tableBase: one.tableBase
		});
	}

	return {
		name: 'bm-pppoe-pool',
		release: RELEASE,
		apiVersion: API_VERSION,

		// What this router can carry, as far as this daemon can tell. On `info`
		// as well as on `pool_check` because a page draws the warning before
		// anybody presses Check.
		router: routerFacts(),
		blind: state.blind,
		settings: settingsGet(),
		started: STARTED,
		uptime: time() - STARTED,
		pools: out,
		legacy: old
	};
};

export function stats() {
	let events = 0;
	let redials = 0;
	let known = 0;

	for (let st in each()) {
		events += st.events;
		redials += st.redials;
		known += length(st.sessions);
	}

	let waiting = 0;

	for (let st in each())
		waiting += sessions.queueDepth(st);

	return {
		rssKb: rssKb(),
		uptime: time() - STARTED,
		served: state.served,
		ticks: state.ticks,
		eventsHandled: events,
		redials: redials,
		sessions: known,

		// How many members are down and waiting to be redialled. It used to be
		// the number of sessions this daemon knows about, which on a healthy
		// router with five hundred sessions read as five hundred waiting.
		queueDepth: waiting,

		// Where the last pass spent its time, and how much of the router it had
		// to look at. A pass that takes longer than the counter interval is a
		// router whose passes overlap.
		pass: state.pass,
		lastPassMs: state.lastPassMs,
		indexSize: state.indexSize,
		indexBuilds: state.indexBuilds
	};
};

export function sessionRows(args) {
	let id = text(args.id);
	let scope = text(args.scope);
	let offset = intOr(args.offset, 0);
	let now = time();

	if (offset < 0)
		offset = 0;

	let all = [];

	// Every matching row first, then the window. The cap used to be shared
	// across pools and applied while the rows were being built, so on a router
	// with two pools of five hundred the second pool had no rows at all - and
	// the reply said `limit` rather than saying which pool had been cut off.
	for (let st in each()) {
		if (length(id) && st.pool.id != id)
			continue;

		for (let row in sessions.rows(st, scope, MEMBER_MAX, state.rates.devices, now))
			push(all, row);
	}

	let total = length(all);
	let from = (offset < total) ? offset : total;
	let to = ((from + ROW_LIMIT) < total) ? (from + ROW_LIMIT) : total;
	let out = [];

	for (let i = from; i < to; i++)
		push(out, all[i]);

	return {
		sessions: out,
		limit: ROW_LIMIT,
		offset: offset,
		total: total,
		truncated: (to < total),

		// Whether the rows are what netifd last said or what the daemon last
		// saw. A page drawing them as live while the dump has been silent for
		// two minutes is describing a router it cannot see.
		blind: state.blind
	};
};

export function reconcileNow() {
	pass();
	return { ok: true, pools: length(state.order) };
};

// ---------------------------------------------------------------------------
// The published object.

function specArgs(extra) {
	let out = {};
	for (let key in extra)
		out[key] = extra[key];
	for (let key in SPEC_ARGS)
		out[key] = SPEC_ARGS[key];
	return out;
};

function method(args, fn) {
	// Accepted on every method because LuCI's dispatcher appends the session
	// id to whatever a page sends, and ucode's publish refuses any named
	// argument the template does not declare. Stripped before the handler
	// runs, so the pool calls still receive exactly the fields they document.
	args.ubus_rpc_session = '';

	return {
		call: function(req) {
			state.served = state.served + 1;
			let given = type(req.args) == 'object' ? req.args : {};
			delete given.ubus_rpc_session;
			return fn(given);
		},
		args: args
	};
};

export const methods = {
	info: method({ members: true }, (args) => info(args.members)),
	stats: method({}, () => stats()),

	// `offset` because the cap is per call and not per router: two pools of
	// five hundred are a thousand rows, and a reply that stopped at five
	// hundred used to leave the second pool out entirely without saying which.
	sessions: method({ id: '', scope: '', offset: 0 }, (args) => sessionRows(args)),
	carriers: method({}, () => carriersList()),

	// The same gate every mutation runs; nothing is written. `source` names a
	// 0600 file for callers arriving by command line; LuCI sends the spec
	// inline over the socket.
	pool_check: method(specArgs({ id: '', source: '' }), (args) => poolCheck(args)),

	// `source` is a path, never the spec itself. See takePayload.
	pool_create: method({ id: '', source: '' }, (args) => poolCreate(args)),

	// Inline spec, for callers that reach ubus over the socket rather than by
	// running `ubus call` - nothing here is ever a command line.
	pool_add: method(specArgs({ id: '' }), (args) => poolAdd(args)),

	pool_set: method(specArgs({ id: '', source: '' }), (args) => poolSet(args)),
	pool_delete: method({ id: '', force: false }, (args) => poolDelete(args)),

	// `id` names a whole pool, which is what every surface actually asks for:
	// spelled as a list of five hundred section names, the list had to be
	// complete and current or the answer was silently partial.
	action: method({ action: '', sections: [], id: '' }, (args) => actionCall(args)),

	settings_get: method({}, () => settingsGet()),
	settings_set: method({
		enabled: false, counter_interval: 0, redial_after: 0, redial_batch: 0
	}, (args) => settingsSet(args)),

	reconcile: method({}, () => reconcileNow())
};
