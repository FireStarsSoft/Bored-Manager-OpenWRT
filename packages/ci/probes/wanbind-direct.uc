// One address, one port - and every way that can go wrong on a real router.
//
// The reconcile pass for one-to-one bindings is the file this drives, and it is
// worth driving hard because almost nothing it decides is visible afterwards. A
// rule pointing at an empty table does not fail; it falls through to the main
// one, so a binding that is silently on the router's default connection and a
// binding that is working look identical from every direction except this one.
// So the assertions here are about the exact priority, address and table, and
// about which of the two down-states the rule ended up in - not about "a rule
// was written".
//
// The router is the same one the layout probe next door is written against,
// because it is the one that produced the fault the classifier exists for: two
// LANs in public address space, `option gateway` on the wired one, four DHCP
// uplinks. A binding is then hung off it in every shape the pass has an answer
// for, and the four passes at the foot of the file are the self-healing claims
// made in earnest: a rule deleted by hand comes back, a WAN that changed table
// is re-pointed, a section that was removed has its rule withdrawn, and a
// settled router writes nothing at all.

import { seed } from 'fs';
import { cursor } from 'uci';
import * as rtnl from 'rtnl';

import * as cfg from 'bm.wanbind.config';
import * as direct from 'bm.wanbind.direct';
import * as layout from 'bm.wanbind.layout';
import * as leases from 'bm.wanbind.leases';
import * as prepare from 'bm.wanbind.prepare';
import * as ruleset from 'bm.wanbind.rules';
import * as wans from 'bm.wanbind.wans';

import { check, report, says } from 'probe';

let uci = cursor();

// ------------------------------------------------------------- the interfaces
//
// netifd's answer, which is where every question about what an interface is
// doing right now has to come from. The tables are netifd's live `ip4table`,
// deliberately not the numbers the sections below are stamped with - that
// difference is what the fourth pass is about.

function lanEntry(name, device, addr, table) {
	let entry = {
		interface: name,
		proto: 'static',
		device: device,
		l3_device: device,
		up: true,
		uptime: 4000,
		'ipv4-address': [ { address: addr, mask: 24 } ]
	};

	// `lan` is given a routing table of its own, which is unusual but perfectly
	// legal, and it is what makes the classifier load-bearing rather than
	// decorative here: without it a LAN named as a WAN would be refused for
	// having no table anyway, and the probe would pass with the classifier
	// switched off. With it, netifd reports `lan` up, addressed, healthy and
	// with a table - indistinguishable from a WAN by every reading except the
	// one that asks what the router is doing with the interface.
	if (table)
		entry.ip4table = sprintf('%d', table);

	return entry;
};

function wanEntry(name, device, addr, table, up) {
	let entry = {
		interface: name,
		proto: 'dhcp',
		device: device,
		l3_device: device,
		up: up,
		uptime: up ? 900 : 0,
		'ipv4-address': up ? [ { address: addr, mask: 24 } ] : []
	};

	if (table)
		entry.ip4table = sprintf('%d', table);

	if (!up)
		entry.errors = [ { code: 'NO_DEVICE' } ];

	return entry;
};

function busFor(list) {
	return {
		call: function(object, method, args) {
			if (object != 'network.interface' || method != 'dump')
				return null;

			return { interface: list };
		}
	};
};

function router(wan0Table, wan2Up) {
	return [
		lanEntry('lan', 'eth1', '12.10.1.1', 10004),
		lanEntry('LAN_WIRED', 'eth0', '12.10.10.1', 0),
		wanEntry('WAN0', 'eth2', '203.0.113.10', wan0Table, true),
		wanEntry('WAN1', 'eth3', '203.0.113.20', 10001, true),
		wanEntry('WAN2', 'eth4', '203.0.113.30', 10002, wan2Up),
		// Up, healthy, and with no routing table of its own - so a rule aimed
		// at it would find an empty table and fall through to main.
		wanEntry('WAN3', 'eth5', '203.0.113.40', 0, true)
	];
};

// ------------------------------------------------------------ /etc/config/*
//
// The reported router, verbatim, so both halves of this package are checked
// against one box rather than two imaginary ones.

uci.set('network', 'lan', 'interface');
uci.set('network', 'lan', 'proto', 'static');
uci.set('network', 'lan', 'device', 'eth1');
uci.set('network', 'lan', 'ipaddr', '12.10.1.1');
uci.set('network', 'lan', 'ip6assign', '60');

uci.set('network', 'LAN_WIRED', 'interface');
uci.set('network', 'LAN_WIRED', 'proto', 'static');
uci.set('network', 'LAN_WIRED', 'device', 'eth0');
uci.set('network', 'LAN_WIRED', 'ipaddr', '12.10.10.1');
uci.set('network', 'LAN_WIRED', 'gateway', '168.192.1.1');

for (let i = 0; i < 4; i++) {
	let name = sprintf('WAN%d', i);
	uci.set('network', name, 'interface');
	uci.set('network', name, 'proto', 'dhcp');
	uci.set('network', name, 'device', sprintf('eth%d', i + 2));
}

uci.set('network', 'WAN0', 'ip4table', '10000');
uci.set('network', 'WAN1', 'ip4table', '10001');
uci.set('network', 'WAN2', 'ip4table', '10002');

uci.set('dhcp', 'lan', 'dhcp');
uci.set('dhcp', 'lan', 'interface', 'lan');
uci.set('dhcp', 'lan', 'limit', '200');

uci.set('dhcp', 'LAN_WIRED', 'dhcp');
uci.set('dhcp', 'LAN_WIRED', 'interface', 'LAN_WIRED');
uci.set('dhcp', 'LAN_WIRED', 'limit', '250');

uci.set('firewall', 'lanzone', 'zone');
uci.set('firewall', 'lanzone', 'name', 'lan');
uci.set('firewall', 'lanzone', 'network', [ 'lan', 'LAN_WIRED' ]);

uci.set('firewall', 'wanzone', 'zone');
uci.set('firewall', 'wanzone', 'name', 'wan');
uci.set('firewall', 'wanzone', 'network', [ 'WAN0', 'WAN1', 'WAN2', 'WAN3' ]);
uci.set('firewall', 'wanzone', 'masq', '1');

// One instance, so that the hold table is an instance's catch-all rather than
// one this file had to choose - which is the arrangement most routers carrying
// both features will be in.
uci.set('bm_wanbind', 'main', 'wanbind');
uci.set('bm_wanbind', 'main', 'interval', '30');
uci.set('bm_wanbind', 'main', 'direct_pref_base', '19000');

uci.set('bm_wanbind', 'home', 'instance');
uci.set('bm_wanbind', 'home', 'lan', 'lan');
uci.set('bm_wanbind', 'home', 'carrier', 'eth9');
uci.set('bm_wanbind', 'home', 'rule_pref_base', '20000');
uci.set('bm_wanbind', 'home', 'catch_all_pref', '30000');
uci.set('bm_wanbind', 'home', 'catch_all_table', '253');

function binding(id, options) {
	uci.set('bm_wanbind', id, 'direct');

	for (let key in options)
		uci.set('bm_wanbind', id, key, options[key]);
};

// A plain address on a healthy WAN. The one everything else is a departure from.
binding('desk', { ip: '12.10.1.40', wan: 'WAN0', lan: 'lan', pref: '19000', table: '10000', when_down: 'hold' });

// A device rather than an address, found through the lease file.
binding('lap', { mac: 'AA-BB-CC-DD-EE-01', wan: 'WAN1', lan: 'lan', pref: '19001', table: '10001', when_down: 'fallback' });

// Its WAN is down, and it asked to be held.
binding('shop', { ip: '12.10.1.50', wan: 'WAN2', lan: 'lan', pref: '19002', table: '10002', when_down: 'hold' });

// Its WAN is down, and it asked for the default connection instead.
binding('till', { ip: '12.10.1.51', wan: 'WAN2', lan: 'lan', pref: '19003', table: '10002', when_down: 'fallback' });

// The mirror of the fault the classifier was written for: an address bound to
// an interface that is one of the router's own LANs.
binding('nas', { ip: '12.10.1.60', wan: 'lan', lan: 'lan', pref: '19004', table: '10005', when_down: 'hold' });

// A device that has wandered onto the other LAN, which this binding has no
// firewall path from.
binding('roam', { mac: 'aa:bb:cc:dd:ee:02', wan: 'WAN0', lan: 'lan', pref: '19005', table: '10000', when_down: 'hold' });

// A device nothing on this router has a lease for.
binding('gone', { mac: 'aa:bb:cc:dd:ee:03', wan: 'WAN1', lan: 'lan', pref: '19006', table: '10001' });

// Switched off by hand.
binding('off', { ip: '12.10.1.70', wan: 'WAN0', lan: 'lan', pref: '19007', table: '10000', enabled: '0' });

// A MAC whose lease landed on an address `desk` already holds. The create gate
// cannot catch this - the device was offline when it was written - so the pass
// has to settle it the way the kernel would, and say which binding won.
binding('twin', { mac: 'aa:bb:cc:dd:ee:04', wan: 'WAN1', lan: 'lan', pref: '19008', table: '10001' });

// Numbered where the instance would adopt and delete it, so the configuration
// reader refuses it and the pass has to withdraw its rule rather than maintain
// one for a section nothing accepts.
binding('bad', { ip: '12.10.1.80', wan: 'WAN0', lan: 'lan', pref: '20000', table: '10000' });

seed('/tmp/dhcp.leases',
	'0 aa:bb:cc:dd:ee:01 12.10.1.41 laptop *\n' +
	'0 aa:bb:cc:dd:ee:02 12.10.10.77 roamer *\n' +
	'0 aa:bb:cc:dd:ee:04 12.10.1.40 spare *\n');

// --------------------------------------------------------------- the fixtures

let ifaces = wans.dump(busFor(router(10000, false)));
let view = layout.classify(ifaces, layout.statements([ 'eth2' ]));
let configured = cfg.directConfigured();
let band = cfg.directBand();

check('the band is the one both halves agree on', sprintf('%d-%d', band.base, band.top), '19000-19999');
check('the band is safe to number in', band.usable, true);
check('ten sections were read', length(configured), 10);
check('WAN0 is not read as a LAN', view.byName.WAN0.role, 'uplink');
check('the wired LAN is still a LAN', view.byName.LAN_WIRED.role, 'lan');

let hold = ruleset.holdTable(cfg.instances(), configured, ifaces);
check('a held address is parked in the instance\'s catch-all', hold.table, 253);
check('and that table is the instance\'s, not ours to flush', hold.shared, true);

function policy() {
	return { base: band.base, top: band.top, warnUptime: 5, releaseGrace: 120 };
};

function asRules(desired) {
	let out = [];
	for (let one in desired)
		push(out, { pref: one.pref, cidr: one.ip + '/32', table: one.table });

	return out;
};

function ruleAt(list, pref) {
	for (let one in list) {
		if (one.pref == pref)
			return sprintf('%s -> %d', one.cidr, one.table);
	}

	return '';
};

function row(result, id) {
	for (let one in result.rows) {
		if (one.id == id)
			return one;
	}

	return { state: 'missing', reason: '', ip: '', table: 0 };
};

function said(result, pattern) {
	for (let one in result.events) {
		if (match(one.text, pattern))
			return one.text;
	}

	return '';
};

// ------------------------------------------------------- the first pass, cold
//
// Nothing on the router yet, so every rule a binding wants is an add and there
// is nothing to remove.

let first = direct.plan({
	now: 1000,
	bindings: configured,
	ifaces: ifaces,
	view: view,
	leases: leases.fromFile(),
	rules: [],
	hold: hold,
	forwardings: {},
	memory: {},
	policy: policy()
});

check('six bindings want a rule', length(first.add), 6);
check('and nothing is taken off a router that had none', length(first.remove), 0);
check('lowest priority first, because that is the order the kernel reads', first.rows[0].id, 'desk');

check('desk is bound', row(first, 'desk').state, 'bound');
check('desk leaves by WAN0\'s own table', ruleAt(first.add, 19000), '12.10.1.40/32 -> 10000');

check('lap was found through its lease', row(first, 'lap').ip, '12.10.1.41');
check('lap is bound', row(first, 'lap').state, 'bound');
check('lap leaves by WAN1\'s table', ruleAt(first.add, 19001), '12.10.1.41/32 -> 10001');

// The two halves of when_down, side by side. This pair is the whole reason the
// option exists, and reading one as the other is the fault it denies.
check('shop is held', row(first, 'shop').state, 'held');
check('a held address is parked on the unreachable table', ruleAt(first.add, 19002), '12.10.1.50/32 -> 253');
check('till fell back', row(first, 'till').state, 'fallback');
check('a fallback is a rule pointing at main, not the absence of one',
	ruleAt(first.add, 19003), '12.10.1.51/32 -> 254');
says('and both were told why', row(first, 'till').reason, /WAN2 is error/);

// The classifier earning its place: netifd says `lan` is up, addressed and
// healthy, and only the classifier knows it is the wrong side of the router.
check('a WAN that is really a LAN does not carry a binding', row(first, 'nas').state, 'held');
check('and the address is parked rather than sent into the network it is already on',
	ruleAt(first.add, 19004), '12.10.1.60/32 -> 253');
says('and the refusal quotes the router\'s own words',
	row(first, 'nas').reason, /lan is one of this router's own LANs, because/);
says('naming the statement that settled it',
	row(first, 'nas').reason, /handing out DHCP leases/);

check('roam has wandered off its LAN', row(first, 'roam').state, 'stranded');
check('and is parked rather than left steering into a zone with no path',
	ruleAt(first.add, 19005), '12.10.10.77/32 -> 253');
says('the row says where it went', row(first, 'roam').reason, /which is outside lan \(12\.10\.1\.0/);

check('gone has no lease to write a rule for', row(first, 'gone').state, 'waiting');
check('and no rule is written for it', ruleAt(first.add, 19006), '');
check('off is switched off', row(first, 'off').state, 'disabled');
check('and writes nothing', ruleAt(first.add, 19007), '');

check('twin lost the address to the binding that claimed it first', row(first, 'twin').state, 'shadowed');
check('and is told which one', row(first, 'twin').shadowedBy, 'desk');
check('and writes no rule of its own', ruleAt(first.add, 19008), '');

check('a section the config refused is refused here too', row(first, 'bad').state, 'refused');
says('with the sentence the configuration reader wrote',
	row(first, 'bad').reason, /rule_pref_base 20000/);

check('nothing is said the first time a binding is seen', length(first.events), 0);

// ---------------------------------------------------- the second pass, settled
//
// The claim that makes this safe to run every thirty seconds for years.

let installed = asRules(first.desired);

let second = direct.plan({
	now: 1030,
	bindings: configured,
	ifaces: ifaces,
	view: view,
	leases: leases.fromFile(),
	rules: installed,
	hold: hold,
	forwardings: {},
	memory: first.memory,
	policy: policy()
});

check('a settled router is written to not at all', length(second.add) + length(second.remove), 0);
check('and nothing is announced', length(second.events), 0);
check('a binding\'s clock does not restart every pass', row(second, 'desk').since, 1000);

// ------------------------------------------- a rule somebody removed by hand
//
// The self-healing claim, tested by taking exactly one rule off and asking for
// it back.

let mangled = [];
for (let one in installed) {
	if (one.pref != 19000)
		push(mangled, one);
}

let healed = direct.plan({
	now: 1060,
	bindings: configured,
	ifaces: ifaces,
	view: view,
	leases: leases.fromFile(),
	rules: mangled,
	hold: hold,
	forwardings: {},
	memory: second.memory,
	policy: policy()
});

check('the rule comes back', ruleAt(healed.add, 19000), '12.10.1.40/32 -> 10000');
check('and nothing else is touched', length(healed.add) + length(healed.remove), 1);

// ------------------------------------------------ a WAN that changed table
//
// netifd is putting WAN0's routes in 10009 now - somebody edited ip4table, or
// the interface came back under a different one. The stamped number is stale,
// and a rule pointing at it would send desk into an empty table, which does not
// fail: it falls through to main. So the live number wins.

let moved = wans.dump(busFor(router(10009, false)));
let movedView = layout.classify(moved, layout.statements([ 'eth2' ]));

let repointed = direct.plan({
	now: 1090,
	bindings: configured,
	ifaces: moved,
	view: movedView,
	leases: leases.fromFile(),
	rules: installed,
	hold: hold,
	forwardings: {},
	memory: second.memory,
	policy: policy()
});

check('the old rule is taken off first', ruleAt(repointed.remove, 19000), '12.10.1.40/32 -> 10000');
check('and re-pointed at the table netifd is really using',
	ruleAt(repointed.add, 19000), '12.10.1.40/32 -> 10009');
check('the row shows both numbers so the mismatch is visible', row(repointed, 'desk').stampedTable, 10000);
check('the live one being the one in force', row(repointed, 'desk').wanTable, 10009);
// Nothing else moves, and the two that could have are the interesting part:
// roam and nas are parked on the hold table, which has nothing to do with what
// WAN0 is up to, so a pass that re-pointed by WAN rather than by state would
// have rewritten them too.
check('and nothing else moves', length(repointed.add) + length(repointed.remove), 2);

// ------------------------------------------------ a WAN with no table at all
//
// WAN3 is up, addressed and healthy, and netifd is putting its routes in main.
// A rule aimed at the stamped table would find nothing there, so the binding
// would report itself bound while the address left over the default connection.

binding('shed', { ip: '12.10.1.90', wan: 'WAN3', lan: 'lan', pref: '19009', table: '10003', when_down: 'hold' });

let withShed = cfg.directConfigured();
let tabled = direct.plan({
	now: 1120,
	bindings: withShed,
	ifaces: ifaces,
	view: view,
	leases: leases.fromFile(),
	rules: installed,
	hold: hold,
	forwardings: {},
	memory: second.memory,
	policy: policy()
});

check('a WAN with no table of its own cannot carry a binding', row(tabled, 'shed').state, 'held');
says('and the row names the option that would fix it',
	row(tabled, 'shed').reason, /Set option ip4table on WAN3/);
check('the pass offers to write it', row(tabled, 'shed').needsTable, true);

uci.delete('bm_wanbind', 'shed');

// --------------------------------------------- a section that was removed
//
// desk is gone from the file. Its rule is now a rule in the band that no
// section wants, which is the definition of a stray.

uci.delete('bm_wanbind', 'desk');
let withoutDesk = cfg.directConfigured();

let withdrawn = direct.plan({
	now: 1150,
	bindings: withoutDesk,
	ifaces: ifaces,
	view: view,
	leases: leases.fromFile(),
	rules: installed,
	hold: hold,
	forwardings: {},
	memory: second.memory,
	policy: policy()
});

check('the rule of a section that has gone is withdrawn',
	ruleAt(withdrawn.remove, 19000), '12.10.1.40/32 -> 10000');
check('and the address it was holding is released to the binding behind it',
	row(withdrawn, 'twin').state, 'bound');

// desk back, for everything that follows.
binding('desk', { ip: '12.10.1.40', wan: 'WAN0', lan: 'lan', pref: '19000', table: '10000', when_down: 'hold' });
configured = cfg.directConfigured();
check('and the file is back to ten sections', length(configured), 10);

// ------------------------------------------------- a router with nowhere to hold
//
// The one case where doing nothing is the right answer. If there is no table to
// park a held address in, taking its rule away would let it out over the
// default connection - which is fallback wearing the name of hold.

let nowhere = direct.plan({
	now: 1180,
	bindings: configured,
	ifaces: ifaces,
	view: view,
	leases: leases.fromFile(),
	rules: installed,
	hold: { table: null, shared: false, reason: 'nowhere to park' },
	forwardings: {},
	memory: second.memory,
	policy: policy()
});

check('a held binding\'s priority is frozen out of the diff', nowhere.frozen['19002'], true);
check('so its rule is neither removed', ruleAt(nowhere.remove, 19002), '');
check('nor rewritten', ruleAt(nowhere.add, 19002), '');
check('the stranded-and-holding one is frozen too', nowhere.frozen['19005'], true);
check('while fallback, which needs no table, is unaffected', ruleAt(nowhere.remove, 19003), '');
check('and the bound ones are unaffected', ruleAt(nowhere.remove, 19000), '');

// ------------------------------------------- a lease file that would not read
//
// dnsmasq restarting is not every device on the LAN disappearing. Reading it as
// one would start the release grace on every MAC binding at once and, two
// minutes later, take all of them off their WANs together.

let blind = direct.plan({
	now: 1210,
	bindings: configured,
	ifaces: ifaces,
	view: view,
	leases: null,
	rules: installed,
	hold: hold,
	forwardings: {},
	memory: second.memory,
	policy: policy()
});

check('a device binding keeps the address it had', row(blind, 'lap').ip, '12.10.1.41');
check('and stays bound', row(blind, 'lap').state, 'bound');
check('and its rule is not rewritten', ruleAt(blind.add, 19001), '');
check('a binding that never had an address still has none', row(blind, 'gone').state, 'waiting');

// -------------------------------------------------- a device that went to sleep
//
// The lease is gone. The rule stays for the release grace, and then it does not.

seed('/tmp/dhcp.leases',
	'0 aa:bb:cc:dd:ee:02 12.10.10.77 roamer *\n' +
	'0 aa:bb:cc:dd:ee:04 12.10.1.40 spare *\n');

let sleeping = direct.plan({
	now: 1240,
	bindings: configured,
	ifaces: ifaces,
	view: view,
	leases: leases.fromFile(),
	rules: installed,
	hold: hold,
	forwardings: {},
	memory: second.memory,
	policy: policy()
});

check('a lease that has just gone changes nothing', row(sleeping, 'lap').state, 'bound');
check('the rule is still at the address it was last seen at', row(sleeping, 'lap').ip, '12.10.1.41');
check('and the clock on its absence started now', sleeping.memory.lap.missingSince, 1240);

let expired = direct.plan({
	now: 1240 + 121,
	bindings: configured,
	ifaces: ifaces,
	view: view,
	leases: leases.fromFile(),
	rules: installed,
	hold: hold,
	forwardings: {},
	memory: sleeping.memory,
	policy: policy()
});

check('past the grace the device is let go', row(expired, 'lap').state, 'waiting');
check('and its rule is taken off', ruleAt(expired.remove, 19001), '12.10.1.41/32 -> 10001');
says('and it is said out loud', said(expired, /has no lease for/), /lap has no lease for aa:bb:cc:dd:ee:01/);

seed('/tmp/dhcp.leases',
	'0 aa:bb:cc:dd:ee:01 12.10.1.41 laptop *\n' +
	'0 aa:bb:cc:dd:ee:02 12.10.10.77 roamer *\n' +
	'0 aa:bb:cc:dd:ee:04 12.10.1.40 spare *\n');

// ----------------------------------------------------------- a WAN coming back
//
// WAN2 is up again, so the two bindings on it change state - and each says so
// in the words its own option chose.

let back = wans.dump(busFor(router(10000, true)));
let backView = layout.classify(back, layout.statements([ 'eth2' ]));

let recovered = direct.plan({
	now: 1400,
	bindings: configured,
	ifaces: back,
	view: backView,
	leases: leases.fromFile(),
	rules: installed,
	hold: hold,
	forwardings: {},
	memory: second.memory,
	policy: policy()
});

check('the held one is bound', row(recovered, 'shop').state, 'bound');
check('and its rule moves off the unreachable table onto the WAN\'s',
	ruleAt(recovered.add, 19002), '12.10.1.50/32 -> 10002');
check('the fallback one is bound too', row(recovered, 'till').state, 'bound');
check('and moves off main', ruleAt(recovered.remove, 19003), '12.10.1.51/32 -> 254');
says('and the change reaches syslog', said(recovered, /shop is bound/), /12\.10\.1\.50 leaves through WAN2/);

// ---------------------------------------------------- the table a hold lives in
//
// Choosing it is the one number this file invents, so every way of getting it
// wrong is worth an assertion.

check('a table netifd is using is never blackholed',
	ruleset.holdTable([ { catchAllTable: 253 } ], [], [ { table: 253 } ]).table, 252);
check('nor is one a binding is stamped with',
	ruleset.holdTable([], [ { usable: true, enabled: true, table: 253 } ], []).table, 252);
check('the router\'s own main table is never a candidate',
	ruleset.holdTable([ { catchAllTable: 254 } ], [], []).table, 253);
check('with no instance at all there is still somewhere to park',
	ruleset.holdTable([], [], []).table, 253);
check('and it is ours to take away again', ruleset.holdTable([], [], []).shared, false);

let crowded = [];
for (let table = 244; table <= 253; table++)
	push(crowded, { table: table });

let stuck = ruleset.holdTable([], [], crowded);
check('a router with nowhere left says so', stuck.table, null);
says('in a sentence that says what happens instead',
	stuck.reason, /keeps whatever rule it already had rather than being let out/);

// ----------------------------------------------------- which rules are ours
//
// Two claims: the band, and every priority a section is stamped with. The
// second is what makes moving direct_pref_base survivable.

let mixed = [
	{ pref: 18999, cidr: '10.0.0.1/32', table: 5 },
	{ pref: 19000, cidr: '12.10.1.40/32', table: 10000 },
	{ pref: 19999, cidr: '10.0.0.2/32', table: 6 },
	{ pref: 20000, cidr: '10.0.0.3/32', table: 7 },
	{ pref: 21000, cidr: '10.0.0.4/32', table: 8 }
];

check('the band is claimed', length(ruleset.directOwned(mixed, 19000, 19999, {})), 2);
check('a stamped priority outside it is claimed too',
	length(ruleset.directOwned(mixed, 19000, 19999, { '21000': true })), 3);
check('and nothing else is', ruleAt(ruleset.directOwned(mixed, 19000, 19999, {}), 20000), '');

// ------------------------------------------------------ the two writes that
// are not ip rules.

// A forwarding is a pair of zones, not a binding. It says "traffic from here
// may go to there", which is true for every binding whose LAN and WAN sit in
// that pair - so five hundred of them need one section, not five hundred
// identical ones and five hundred commits of /etc/config/firewall.
let ready = prepare.prepare(cfg.directBinding('desk'), view, { defer: true });
check('preparing an already-tabled WAN writes only the forwarding', ready.ok, true);
check('so netifd is not disturbed', ready.network, false);
check('and fw4 is owed a reload', ready.firewall, true);

let pairs = prepare.forwardings().pairs;
check('the pair is in the file', exists(pairs, 'lan|wan'), true);
check('the forwarding runs from the LAN\'s zone', uci.get('firewall', pairs['lan|wan'].section, 'src'), 'lan');
check('to the WAN\'s', uci.get('firewall', pairs['lan|wan'].section, 'dest'), 'wan');
check('under a numbered name rather than a binding\'s', pairs['lan|wan'].section, 'bmz_0');
check('and it is not one of the old per-binding sections', pairs['lan|wan'].legacy, false);

check('a second preparation writes nothing', prepare.prepare(cfg.directBinding('desk'), view, { defer: true }).firewall, false);

// The point of the pair: another binding on the same two zones is already
// forwarded, whoever wrote the section.
binding('desk2', { ip: '12.10.1.44', wan: 'WAN0', lan: 'lan', pref: '19008', table: '10000' });
check('a second binding across the same pair writes nothing either',
	prepare.prepare(cfg.directBinding('desk2'), view, { defer: true }).firewall, false);
check('and there is still one section for it', length(prepare.forwardings().rows), 1);
uci.delete('bm_wanbind', 'desk2');

// The WAN with no ip4table: this is where the number the section is stamped
// with is finally used for something.
binding('shed', { ip: '12.10.1.90', wan: 'WAN3', lan: 'lan', pref: '19009', table: '10003', when_down: 'hold' });
let shed = prepare.prepare(cfg.directBinding('shed'), view, { defer: true });
check('a WAN with no table of its own is given the stamped one', uci.get('network', 'WAN3', 'ip4table'), '10003');
check('and netifd is owed a reload', shed.network, true);

// And the number nobody may overwrite.
binding('clash', { ip: '12.10.1.91', wan: 'WAN1', lan: 'lan', pref: '19010', table: '10099' });
let clash = prepare.prepare(cfg.directBinding('clash'), view, { defer: true });
check('a WAN already using another table is not quietly moved', clash.ok, false);
says('and the refusal says whose decision that is',
	clash.reason, /already puts its routes in table 10001 and this binding is stamped with 10099/);
check('so nothing was written', uci.get('network', 'WAN1', 'ip4table'), '10001');

// Binding an address to one of the router's own LANs writes nothing at all.
binding('inward', { ip: '12.10.1.92', wan: 'lan', lan: 'lan', pref: '19011', table: '10098' });
let inward = prepare.prepare(cfg.directBinding('inward'), view, { defer: true });
check('nothing is prepared for a binding that leaves by its own LAN', inward.ok, false);
check('and its network section is untouched', uci.get('network', 'lan', 'ip4table'), null);

uci.delete('bm_wanbind', 'shed');
uci.delete('bm_wanbind', 'clash');
uci.delete('bm_wanbind', 'inward');

// What a sweep is for: a pair nothing needs any more, and the per-binding
// sections older releases wrote.
//
// The old ones are still forwardings and still in force, so one is only removed
// once a numbered section covers the same pair. Removing it first would be a
// hole in the router's connectivity opened by an upgrade.
uci.set('firewall', 'bmd_ghost', 'forwarding');
uci.set('firewall', 'bmd_ghost', 'src', 'lan');
uci.set('firewall', 'bmd_ghost', 'dest', 'wan');
uci.set('firewall', 'bmd_old', 'forwarding');
uci.set('firewall', 'bmd_old', 'src', 'guest');
uci.set('firewall', 'bmd_old', 'dest', 'wan');

check('the old section covers its pair', prepare.forwardings().pairs['guest|wan'].legacy, true);

// Every binding above leaves by a WAN in the `wan` zone from a LAN in the `lan`
// zone, so all of them - including the one with no routing table of its own -
// are covered by the one numbered section. That is the whole point of keying a
// forwarding on the pair.
check('one section covers every binding written so far', length(prepare.forwardings().rows), 3);

// `lan -> wan` is wanted and covered by a numbered section, so the old
// per-binding one for it goes; `guest -> wan` is wanted and covered only by an
// old section, so that one stays until a numbered one takes it over.
check('the sweep takes the superseded section and nothing else',
	prepare.sweep({ 'lan|wan': true, 'guest|wan': true }), 1);
check('the superseded per-binding section is gone', uci.get('firewall', 'bmd_ghost'), null);
check('while the pair only an old section covers is kept', uci.get('firewall', 'bmd_old', 'dest'), 'wan');
check('and the numbered one stays', uci.get('firewall', 'bmz_0', 'dest'), 'wan');

// And a pair nothing wants at all goes, old section or new.
check('a pair nothing needs is swept', prepare.sweep({ 'lan|wan': true }), 1);
check('the old section for it is gone', uci.get('firewall', 'bmd_old'), null);


// --------------------------------------------------- and then a real pass
//
// Everything above is `plan()`, which is pure. This is `run()`, which is the
// same plan carried out against a kernel that stores what it is given - so the
// question here is not what was decided but what the router holds afterwards,
// which is the only question that matters to somebody whose traffic is going
// the wrong way.

rtnl.setRules([]);
rtnl.setRulesReadable(true);

let live = direct.run({ bus: busFor(router(10000, false)), now: 1500 });
check('a pass over a readable router works', live.ok, true);
check('and writes the rules it planned', live.added > 0, true);

let landed = rtnl.kernelRules();
check('which the kernel is holding afterwards', length(landed) == live.added, true);

// The one thing a real kernel will not be asked to do, and the whole reason
// the read-back exists: accept every write, report nothing wrong, and hold
// none of it. On a router that is an older module sweeping this band every two
// seconds, and from inside one pass it is indistinguishable from a socket that
// never carried the message.
rtnl.setRules([]);
rtnl.setDropAdds(true);
let unheld = direct.run({ bus: busFor(router(10000, false)), now: 1600 });
check('a pass whose writes are accepted and dropped still reports ok', unheld.ok, true);
check('but says how many of them the kernel is not holding', unheld.unverified, unheld.added);
check('and the router really is not holding them', length(rtnl.kernelRules()), 0);
rtnl.setDropAdds(false);

// ------------------------------------------------- no answer means change nothing
//
// A busy or missing netlink socket. A pass that treated that as "this router
// has no rules" would write every binding again on every tick - and, worse,
// would first read every rule already there as a stray and remove it.

rtnl.setRules(landed);
rtnl.setRulesReadable(false);

let refused = direct.run({ bus: busFor(router(10000, false)), now: 1700 });
check('a pass that could not read the rules changes nothing', refused.ok, false);
says('and says which read failed', refused.reason, /ip rules could not be read/);

rtnl.setRulesReadable(true);
check('so the rules already on the router are untouched', length(rtnl.kernelRules()), length(landed));

rtnl.setRulesReadable(false);
check('and a pass with no netifd changes nothing either', direct.run({ bus: null, now: 1700 }).ok, false);
rtnl.setRulesReadable(true);
check('nothing was removed by either', length(rtnl.kernelRules()), length(landed));

report();
