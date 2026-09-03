// The capacity report, driven against routers this machine is not.
//
// The report's whole job is to be right about a router it is running on, and
// the ways it can be wrong are quiet ones: a ceiling that reads zero because a
// fact was missing rather than because the router is full; a fix offered for a
// kernel that has no flowtable, which leaves a firewall that will not load at
// the next boot; a number that moves when nothing about the router did.
//
// So the cases here are a router with nothing running, a router with both
// daemons answering, a router whose kernel cannot do what a fix would ask of
// it, and the four sizes at which the answer is supposed to change. The
// arithmetic is never checked against a number typed in here - it is worked out
// from `CONSTANTS` at assert time, so calibrating a constant on a rig does not
// turn this probe red.

import { seed, unlink, wipe, writes } from 'fs';
import { cursor } from 'uci';

import { CONSTANTS, compute, report as cachedReport } from 'bm.capacity';

import { check, report, resolves, says } from 'probe';

const K = {};

for (let one in CONSTANTS)
	K[one.name] = one.value;

let uci = cursor();

// The uci store is one store for the life of the process, so a case that left
// its sections behind would be seeding the next one.
function clear(config, kind) {
	let names = [];

	uci.foreach(config, kind, (section) => {
		push(names, section['.name']);
	});

	for (let name in names)
		uci.delete(config, name);
}

function sysctl(max, count, gc3) {
	seed('/proc/sys/net/netfilter/nf_conntrack_max', sprintf('%d\n', max));
	seed('/proc/sys/net/netfilter/nf_conntrack_count', sprintf('%d\n', count));
	seed('/proc/sys/net/ipv4/neigh/default/gc_thresh1', '1024\n');
	seed('/proc/sys/net/ipv4/neigh/default/gc_thresh2', '2048\n');
	seed('/proc/sys/net/ipv4/neigh/default/gc_thresh3', sprintf('%d\n', gc3));
}

function leases(count) {
	let out = '';

	for (let i = 0; i < count; i++)
		out += sprintf('1893456000 aa:bb:cc:dd:%02x:%02x 10.9.%d.%d name%d *\n',
			i / 250, i % 250, i / 250, 10 + (i % 240), i);

	seed('/tmp/dhcp.leases', out);
}

// A router that is fine: two ports, a kernel that can offload, fw4 loaded, both
// packages installed. Every case below starts here and breaks one thing.
function baseline(totalKb, availableKb) {
	wipe();

	seed('/proc/cpuinfo',
		'processor\t: 0\nmodel name\t: Intel(R) Celeron(R) J4125 CPU @ 2.00GHz\n' +
		'processor\t: 1\nmodel name\t: Intel(R) Celeron(R) J4125 CPU @ 2.00GHz\n');
	seed('/proc/meminfo', sprintf('MemTotal: %d kB\nMemFree: %d kB\nMemAvailable: %d kB\n',
		totalKb, availableKb, availableKb));
	seed('/proc/loadavg', '0.10 0.20 0.30 1/100 999\n');
	seed('/proc/sys/kernel/osrelease', '6.6.73\n');
	seed('/proc/modules', 'nft_flow_offload 16384 1 - Live 0x0000000000000000\n');
	seed('/etc/openwrt_release',
		"DISTRIB_RELEASE='25.12.5'\nDISTRIB_TARGET='x86/64'\nDISTRIB_ARCH='x86" + "_64'\n");
	seed('/tmp/sysinfo/model', 'QEMU Standard PC\n');
	seed('/usr/sbin/fw4', '');
	seed('/sys/cl' + 'ass/net/eth0/device', '');
	seed('/sys/cl' + 'ass/net/eth0/operstate', 'up\n');
	seed('/sys/cl' + 'ass/net/eth1/device', '');
	seed('/sys/cl' + 'ass/net/eth1/operstate', 'up\n');
	seed('/usr/share/bm/features/bm-wanbind.json',
		'{"name":"bm-wanbind","version":"2.4.0","ubus":"bm.wanbind","provides":["binding","direct"]}');
	seed('/usr/share/bm/features/bm-pppoe-pool.json',
		'{"name":"bm-pppoe-pool","version":"2.4.0","ubus":"bm.pppoe","provides":["pppoe"]}');

	sysctl(262144, 1000, 8192);
	leases(0);

	clear('bm_pppoe', 'member');
	clear('bm_pppoe', 'pool');
	clear('bm_wanbind', 'direct');
	clear('bm_wanbind', 'instance');
	clear('bm_wanbind', 'main');
	clear('firewall', 'zone');
	clear('firewall', 'defaults');
	clear('dhcp', 'dnsmasq');
	clear('dhcp', 'dhcp');

	uci.set('firewall', 'bmdefaults', 'defaults');
	uci.set('firewall', 'bmdefaults', 'flow_offloading', '1');
}

function pool(id, prefix, zone, count) {
	uci.set('bm_pppoe', id, 'pool');
	uci.set('bm_pppoe', id, 'prefix', prefix);
	uci.set('bm_pppoe', id, 'zone', zone);

	for (let i = 0; i < count; i++) {
		let name = sprintf('%s%04d', id, i);

		uci.set('bm_pppoe', name, 'member');
		uci.set('bm_pppoe', name, 'pool', id);
		uci.set('bm_pppoe', name, 'vlan', sprintf('%d', 101 + i));
	}
}

function bindings(count) {
	for (let i = 0; i < count; i++) {
		let name = sprintf('bmdir_p%04d', i);

		uci.set('bm_wanbind', name, 'direct');
		uci.set('bm_wanbind', name, 'pref', sprintf('%d', 19000 + i));
		uci.set('bm_wanbind', name, 'ip', sprintf('10.9.%d.%d', i / 250, 10 + (i % 240)));
	}
}

function rowFor(found, key) {
	for (let one in found.requirements) {
		if (one.key == key)
			return one;
	}

	for (let one in found.issues) {
		if (one.key == key)
			return one;
	}

	return null;
}

function levelOf(found, key) {
	let row = rowFor(found, key);
	return (row == null) ? 'absent' : row.level;
}

resolves('capacity.compute on a router that answers nothing', () => {
	wipe();
	return compute({});
});

// ------------------------------------------------------- nothing is running

baseline(2097152, 1600000);
pool('fpt', 'fpt', 'bmwanpool', 200);
pool('vnp', 'vnp', 'bmwanpool', 200);
bindings(120);
uci.set('bm_wanbind', 'home', 'instance');
uci.set('bm_wanbind', 'home', 'lan', 'lan');

let off = compute({});

check('with no bus, bm-wanbind did not answer', off.load.answered.wanbind, false);
check('and neither did the pool daemon', off.load.answered.pppoe, false);
check('the members are counted off the files', off.load.configured.members, 400);
check('the bindings too', off.load.configured.bindings, 120);
check('and the instances', off.load.configured.instances, 1);
check('a ceiling is still worked out', type(off.ceiling.sessions), 'int');
check('and it is a number worth having', off.ceiling.sessions > 0, true);
check('the answer says it is an estimate', off.estimate, true);

// Installed and silent is a fault, not a footnote: every live figure on the
// report is missing while it lasts.
check('a daemon that is installed and silent is an error', levelOf(off, 'wanbind-down'), 'error');
check('for both of them', levelOf(off, 'pppoe-down'), 'error');
check('so the router is called unstable', off.stability.level, 'unstable');
says('and the reason names the daemon', off.stability.reason, /bm-(wanbind|pppoe-pool)/);

// The same router with neither package installed is a different answer, because
// nothing is failing - there is simply nothing there.
wipe();
seed('/proc/meminfo', 'MemTotal: 2097152 kB\nMemAvailable: 1600000 kB\n');
seed('/proc/cpuinfo', 'processor\t: 0\nmodel name\t: Intel(R) Celeron(R) J4125 CPU @ 2.00GHz\n');
seed('/proc/loadavg', '0.10 0.20 0.30 1/100 999\n');
seed('/usr/sbin/fw4', '');
sysctl(262144, 1000, 8192);

let bare = compute({});

check('a router with no packages is not accused of anything', levelOf(bare, 'wanbind-down'), 'absent');
check('nor of the other one', levelOf(bare, 'pppoe-down'), 'absent');

// ------------------------------------------------------------- what is missing

// Memory is the one fact the whole model rests on. Without it the answer is
// "unknown", which is a different thing from "nothing fits".
wipe();
seed('/proc/cpuinfo', 'processor\t: 0\nmodel name\t: Nothing\n');

let blind = compute({});

check('a router that will not say how much memory it has is unknown', blind.stability.level, 'unknown');
check('rather than being told it has none', blind.ceiling.dimensions.memory, null);
check('and the memory row does not claim a shortfall', levelOf(blind, 'memory'), 'info');

// A kernel too old for MemAvailable still gets a memory model - the estimate is
// the kernel's own, and it is labelled.
baseline(524288, 0);
seed('/proc/meminfo', 'MemTotal: 524288 kB\nMemFree: 300000 kB\nBuffers: 10000 kB\nCached: 40000 kB\n');

let older = compute({});

check('an older kernel is still sized', type(older.ceiling.dimensions.memory), 'object');
check('from an estimate that says so', older.hardware.memAvailableEstimated, true);

// No shell at all: `df` and `nft` are the only popen in the file.
baseline(524288, 400000);

let noshell = compute({});

check('with no shell, flash is unknown', noshell.hardware.flashFreeKb, null);
check('and the flash row is a note, not a fault', levelOf(noshell, 'flash'), 'absent');
check('the report is still built', noshell.ok, true);
check('and nothing was written to get it', writes(), 0);

// ------------------------------------------------------------ the ceilings

// Two gigabytes, so memory is not the constraint and conntrack is: 65536
// entries at 128 flows a seat is 512 seats, and 500 clients have taken theirs.
baseline(2097152, 1600000);
sysctl(65536, 1000, 8192);
pool('fpt', 'fpt', 'bmwanpool', 500);
bindings(500);
leases(500);

let tight = compute({});
let seats = K.UBUS_MSG_MAX; // placeholder, replaced below

seats = 65536 / K.FLOWS_PER_SEAT;

check('the conntrack table is read as seats', tight.ceiling.dimensions.conntrack.sessions,
	int(seats - 500));
check('and it is what caps this router', tight.ceiling.limitedBy.sessions, 'conntrack');
check('so the ceiling is that number', tight.ceiling.sessions, int(seats - 500));
check('the table is called too small', levelOf(tight, 'conntrack-max'), 'warning');

let fix = rowFor(tight, 'conntrack-max').fix;

check('with a fix that sets it', fix.kind, 'tune_set');
check('to a number this router can hold', fix.args.conntrack_max > 65536, true);

// Raise it and the next thing along takes over: one pool holds five hundred.
sysctl(262144, 1000, 8192);

let roomy = compute({});

check('a bigger table hands the limit to the pool', roomy.ceiling.limitedBy.sessions, 'pool');
check('which is one pool of five hundred', roomy.ceiling.sessions, K.MEMBER_MAX);
check('and a pool sitting on its ceiling says so', levelOf(roomy, 'pool-cap'), 'info');

// The one-to-one band is a thousand priorities wide and every section holds
// one, switched off or not.
baseline(2097152, 1600000);
bindings(950);

let crowded = compute({});

check('950 of the band is a warning', levelOf(crowded, 'band'), 'warning');
check('and the band is what caps the bindings', crowded.ceiling.limitedBy.bindings, 'band');
check('with what is left of it', crowded.ceiling.dimensions.band.bindings, K.DIRECT_PREF_SPAN - 950);

baseline(2097152, 1600000);
bindings(1000);

let full = compute({});

check('a full band is an error', levelOf(full, 'band'), 'error');
check('and nothing is left in it', full.ceiling.dimensions.band.bindings, 0);

// The router's own interface list, which every daemon and the firewall read.
// Past the size where it stops fitting in a ubus message they stop seeing it.
let dumpCeiling = int((K.UBUS_MSG_MAX - K.DUMP_OVERHEAD_BYTES) / K.DUMP_BYTES_PER_IFACE);

baseline(4194304, 3500000);
sysctl(4194304, 1000, 65536);
pool('a', 'aaa', 'bmwanpool', 500);
pool('b', 'bbb', 'bmwanpool', 500);
pool('c', 'ccc', 'bmwanpool', 500);

let huge = compute({});

check('the interface dump has a size of its own', huge.ceiling.dimensions.dump, dumpCeiling);
check('and 1500 sessions is past it', levelOf(huge, 'dump-size'), 'error');
says('the row says what stops working', rowFor(huge, 'dump-size').detail,
	/stop seeing interfaces/);

// ------------------------------------------------------------ flow offload

baseline(2097152, 1600000);
uci.set('firewall', 'bmdefaults', 'flow_offloading', '0');
pool('fpt', 'fpt', 'bmwanpool', K.FLOW_OFFLOAD_THRESHOLD);

let atThreshold = compute({});

check('at the threshold offload is not demanded', levelOf(atThreshold, 'flow-offload'), 'pass');

baseline(2097152, 1600000);
uci.set('firewall', 'bmdefaults', 'flow_offloading', '0');
pool('fpt', 'fpt', 'bmwanpool', K.FLOW_OFFLOAD_THRESHOLD + 1);

let needsOffload = compute({});

check('one over it, offload is required', levelOf(needsOffload, 'flow-offload'), 'error');
check('and there is a switch for it', rowFor(needsOffload, 'flow-offload').fix.kind, 'tune_set');
check('which is the offload flag', rowFor(needsOffload, 'flow-offload').fix.args.flow_offload, true);
check('with offload off there is a CPU ceiling', needsOffload.ceiling.dimensions.cpu.sessions,
	K.FLOW_OFFLOAD_THRESHOLD);

// A kernel with no flowtable. Turning the option on here leaves a firewall that
// fails to load at the next boot, so the row says what to install instead and
// offers nothing to press.
baseline(2097152, 1600000);
uci.set('firewall', 'bmdefaults', 'flow_offloading', '0');
seed('/proc/modules', 'pppoe 16384 1 - Live 0x0000000000000000\n');
seed('/lib/modules/6.6.73/pppoe.ko', 'x');
seed('/lib/modules/6.6.73/modules.builtin', 'kernel/net/ipv4/ip_tunnel.ko\n');
pool('fpt', 'fpt', 'bmwanpool', 200);

let noModule = compute({});

check('a kernel without the flowtable knows it', noModule.software.flowOffloadKernel, false);
check('the row is still an error', levelOf(noModule, 'flow-offload'), 'error');
check('and it offers nothing to press', rowFor(noModule, 'flow-offload').fix, null);
says('it names what to install', rowFor(noModule, 'flow-offload').detail, /kmod-nft-offload/);

// With offload on, there is deliberately no numeric CPU ceiling: the cost is
// per packet and per new flow, and this router does not know its traffic.
baseline(2097152, 1600000);
pool('fpt', 'fpt', 'bmwanpool', 300);

let offloaded = compute({});

check('with offload on there is no CPU number', offloaded.ceiling.dimensions.cpu, null);
check('and the offload row passes', levelOf(offloaded, 'flow-offload'), 'pass');

// ------------------------------------------------------------------- leases

baseline(2097152, 1600000);
bindings(200);
leases(200);

let leaseShort = compute({});

check('dnsmasq stops at 150 unless told otherwise', leaseShort.software.leaseMax, 150);
check('which for 200 clients is an error', levelOf(leaseShort, 'lease-max'), 'error');
check('and the lease ceiling caps the bindings', leaseShort.ceiling.limitedBy.bindings, 'lease');

uci.set('dhcp', 'cfg01', 'dnsmasq');
uci.set('dhcp', 'cfg01', 'dhcpleasemax', '1500');

let halfRaised = compute({});

check('raising dnsmasq alone raises nothing: the LAN still stops at 150',
	halfRaised.software.leaseMax, 150);

uci.set('dhcp', 'lan', 'dhcp');
uci.set('dhcp', 'lan', 'interface', 'lan');
uci.set('dhcp', 'lan', 'limit', '1000');

let leaseRaised = compute({});

check('a raised ceiling is read', leaseRaised.software.leaseMax, 1000);
check('and the row passes', levelOf(leaseRaised, 'lease-max'), 'pass');

// -------------------------------------------------------------------- tiers

baseline(2097152, 1600000);
pool('fpt', 'fpt', 'bmwanpool', 300);
bindings(20);

let mid = compute({});

check('300 sessions is the second tier', mid.tiers.sessions.current, 's1');
check('20 bindings is the first', mid.tiers.bindings.current, 'b0');
check('the next session tier starts at 501', mid.tiers.sessions.next.at, 501);
check('the next binding tier at 65', mid.tiers.bindings.next.at, 65);
check('and what changes there is listed', length(mid.tiers.sessions.next.changes) > 0, true);

baseline(2097152, 1600000);
unlink('/usr/share/bm/features/bm-wanbind.json');
unlink('/usr/share/bm/features/bm-pppoe-pool.json');

let empty = compute({});

check('a router carrying nothing is in the first tier', empty.tiers.sessions.current, 's0');
check('and is stable', empty.stability.level, 'stable');

// ---------------------------------------------------------- daemons answering

baseline(2097152, 1600000);
pool('fpt', 'fpt', 'bmwanpool', 500);
bindings(400);
leases(400);
uci.set('firewall', 'bmwanpool', 'zone');
uci.set('firewall', 'bmwanpool', 'name', 'bmwanpool');
uci.set('firewall', 'bmwanpool', 'network', 'fpt101 fpt102 fpt103 fpt104 fpt105 fpt106 fpt107 ' +
	'fpt108 fpt109 fpt110 fpt111 fpt112 fpt113 fpt114 fpt115 fpt116 fpt117 fpt118 fpt119 fpt120 ' +
	'fpt121 fpt122 fpt123 fpt124 fpt125 fpt126 fpt127 fpt128 fpt129 fpt130 fpt131 fpt132 fpt133 ' +
	'fpt134 fpt135 fpt136 fpt137 fpt138 fpt139 fpt140 fpt141 fpt142 fpt143 fpt144 fpt145 fpt146 ' +
	'fpt147 fpt148 fpt149 fpt150 fpt151 fpt152 fpt153 fpt154 fpt155 fpt156 fpt157 fpt158 fpt159 ' +
	'fpt160 fpt161 fpt162 fpt163 fpt164 fpt165 fpt166');
sysctl(1048576, 200000, 65536);

let asked = [];

let bus = {
	call: function(object, method, args) {
		push(asked, { object: object, method: method, args: args });

		if (object == 'bm.wanbind' && method == 'info') {
			return {
				ok: true, release: '2.3.0',
				core: { bound: 398 },
				netifd: { ok: true, failures: 0 },
				local: { enabled: false, usable: true, reason: '' }
			};
		}

		if (object == 'bm.wanbind' && method == 'stats')
			return { ok: true, timings: { totalMs: 21000 } };

		if (object == 'bm.wanbind' && method == 'rules')
			return { ok: true, read: true, raw: 1806, count: 900, bands: { foreign: 2 } };

		if (object == 'bm.wanbind' && method == 'verify')
			return { ok: true, read: true, missing: [ 'a', 'b', 'c' ], extra: [] };

		if (object == 'bm.pppoe' && method == 'info') {
			return {
				ok: true, release: '2.4.0', blind: null,
				pools: [ { id: 'fpt', up: 496, members: 500 } ]
			};
		}

		if (object == 'bm.pppoe' && method == 'stats')
			return { ok: true, queueDepth: 4 };

		return null;
	},
	disconnect: function() { return true; }
};

let live = compute({ bus: bus });

check('both daemons answered', live.load.answered.wanbind, true);
check('the pool daemon too', live.load.answered.pppoe, true);
check('the live sessions are the daemon\'s, not sysfs\'s', live.load.live.sessionsUp, 496);
check('and the bound count is the daemon\'s', live.load.live.bound, 398);
check('the rule count is what the kernel holds', live.load.live.ipRules, 1806);

// The pool's member list is 500 entries and nobody here needs it: asking for it
// is most of a megabyte across a bus with a megabyte to give.
let sawMembersFalse = false;

for (let one in asked) {
	if (one.object == 'bm.pppoe' && one.method == 'info' && one.args.members === false)
		sawMembersFalse = true;
}

check('the pool was asked without its member lists', sawMembersFalse, true);

check('rules the daemon decided and the kernel does not have is an error',
	levelOf(live, 'verify-missing'), 'error');
check('with a pass to put them back', rowFor(live, 'verify-missing').fix.kind, 'wanbind_reconcile');
check('somebody else writing in these bands is a warning', levelOf(live, 'foreign-rules'), 'warning');
check('a redial queue is a warning', levelOf(live, 'queue'), 'warning');
check('a pass over its budget is a warning', levelOf(live, 'pass-slow'), 'warning');
check('files newer than the running service is a warning', levelOf(live, 'running-stale'), 'warning');
says('and it says what to do about it', rowFor(live, 'running-stale').detail, /restart/);
check('a zone naming its interfaces one by one is a warning',
	levelOf(live, 'zone-network-list'), 'warning');
check('with a pass that moves it to a pattern',
	rowFor(live, 'zone-network-list').fix.kind, 'pool_reconcile');
check('LAN-local switched off is worth a note', levelOf(live, 'local-off'), 'info');
check('and it can be switched back on', rowFor(live, 'local-off').fix.kind, 'wanbind_settings_set');
check('by that key alone', rowFor(live, 'local-off').fix.args.lan_local, true);

// A daemon that does not answer costs one timeout, not four.
let counted = [];

let deaf = {
	call: function(object, method, args) {
		push(counted, object + ' ' + method);

		if (object == 'bm.pppoe' && method == 'info')
			return { ok: true, release: '2.4.0', pools: [] };

		return null;
	},
	disconnect: function() { return true; }
};

compute({ bus: deaf });

let wanbindCalls = 0;

for (let one in counted) {
	if (index(one, 'bm.wanbind') == 0)
		wanbindCalls++;
}

check('a silent daemon is asked once and then left alone', wanbindCalls, 1);

// netifd not answering is an error about both daemons at once.
let dark = {
	call: function(object, method, args) {
		if (object == 'bm.wanbind' && method == 'info')
			return { ok: true, release: '2.4.0', core: { bound: 0 }, netifd: { ok: false, failures: 9 } };

		if (object == 'bm.pppoe' && method == 'info')
			return { ok: true, release: '2.4.0', blind: { since: 100, failures: 9 }, pools: [] };

		return null;
	},
	disconnect: function() { return true; }
};

let blindNetifd = compute({ bus: dark });

check('netifd not answering is an error', levelOf(blindNetifd, 'netifd-blind'), 'error');
check('and so is a pool daemon running on events alone', levelOf(blindNetifd, 'pppoe-blind'), 'error');
check('which makes the router unstable', blindNetifd.stability.level, 'unstable');

// ------------------------------------------------------------- the answer itself

baseline(2097152, 1600000);
pool('fpt', 'fpt', 'bmwanpool', 500);
bindings(500);
leases(500);

let big = compute({});

check('a full router still answers inside a ubus message',
	length(sprintf('%J', big)) < 16384, true);

// Nothing here writes. A report that changed the router it was describing would
// agree with it about everything, including about being broken.
check('and it wrote nothing at all', writes(), 0);

// --------------------------------------------------------------------- cache

let first = cachedReport({ refresh: true });
let second = cachedReport({});

check('the first answer is fresh', first.fresh, true);
check('the second is the same one', second.fresh, false);
check('taken at the same moment', second.cachedAt, first.cachedAt);

let third = cachedReport({ refresh: true });

check('and asking again on purpose works it out again', third.fresh, true);

report();
