// Who gets which WAN, and how many of them fit on one.
//
// The seating half of an instance has never had a probe of its own, which is
// awkward for something whose whole job is arithmetic nobody can see: a client
// that ends up on the wrong line still has internet, still shows green on every
// surface, and is only wrong in the one way the feature was bought to be right.
// Every claim here is checked against the rules the kernel is holding rather
// than against what the pass reported, because those are two different things
// and only one of them decides where a packet goes.
//
// `clients_per_wan` is the new option and most of this file is about it, but
// the default - one client per WAN, which is every instance written before
// 2.4.0 and what most routers want - is checked first and hardest. A release
// that seated two people on one line by accident would be a far worse failure
// than one that refused to seat anybody.

import { seed } from 'fs';
import { cursor } from 'uci';
import * as rtnl from 'rtnl';

import * as cfg from 'bm.wanbind.config';
import * as engine from 'bm.wanbind.engine';
import * as reconcile from 'bm.wanbind.reconcile';

import { check, report, says } from 'probe';

const PACKAGE = 'bm_wanbind';

let uci = cursor();

// ----------------------------------------------------------------- the router

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
		entry.errors = [ { subsystem: 'dhcp', code: 'NO_LEASE' } ];

	return entry;
};

// Three WANs on one carrier, so the pool is small enough to run out on purpose.
let wan2Up = true;

function router() {
	return [
		lanEntry('lan', 'br-lan', '10.9.0.1', 0),
		wanEntry('WAN0', 'eth1.10', '203.0.113.10', 10000, true),
		wanEntry('WAN1', 'eth1.11', '203.0.113.20', 10001, true),
		wanEntry('WAN2', 'eth1.12', '203.0.113.30', 10002, wan2Up)
	];
};

let bus = {
	call: function(object, method, args) {
		if (object == 'network' && method == 'reload')
			return {};

		if (object != 'network.interface' || method != 'dump')
			return null;

		return { interface: router() };
	}
};

uci.set('network', 'lan', 'interface');
uci.set('network', 'lan', 'proto', 'static');
uci.set('network', 'lan', 'device', 'br-lan');
uci.set('network', 'lan', 'ipaddr', '10.9.0.1');

for (let i = 0; i < 3; i++) {
	let name = sprintf('WAN%d', i);
	uci.set('network', name, 'interface');
	uci.set('network', name, 'proto', 'dhcp');
	uci.set('network', name, 'device', sprintf('eth1.%d', 10 + i));
	uci.set('network', name, 'ip4table', sprintf('%d', 10000 + i));
}

uci.set('dhcp', 'lan', 'dhcp');
uci.set('dhcp', 'lan', 'interface', 'lan');

uci.set('firewall', 'lanzone', 'zone');
uci.set('firewall', 'lanzone', 'name', 'lan');
uci.set('firewall', 'lanzone', 'network', [ 'lan' ]);

uci.set('firewall', 'wanzone', 'zone');
uci.set('firewall', 'wanzone', 'name', 'wan');
uci.set('firewall', 'wanzone', 'network', [ 'WAN0', 'WAN1', 'WAN2' ]);
uci.set('firewall', 'wanzone', 'masq', '1');

// One default route, out of the first WAN, so the classifier has something
// decisive to read and does not have to guess which side of the router the
// interfaces are on.
rtnl.setRoutes([
	{ family: 2, type: 1, oif: 'eth1.10', gateway: '203.0.113.1', table: 254 }
]);

// ------------------------------------------------------------------- helpers

function leases(list) {
	let text = '';
	for (let one in list)
		text = text + sprintf('0 %s %s %s *\n', one[0], one[1], one[2]);

	seed('/tmp/dhcp.leases', text);
};

function instance(id, extra) {
	uci.set(PACKAGE, id, 'instance');
	uci.set(PACKAGE, id, 'lan', 'lan');
	uci.set(PACKAGE, id, 'carrier', 'eth1');
	uci.set(PACKAGE, id, 'rule_pref_base', '20000');
	uci.set(PACKAGE, id, 'catch_all_pref', '30000');
	uci.set(PACKAGE, id, 'catch_all_table', '253');
	uci.set(PACKAGE, id, 'wan_error_grace', '20');

	for (let key in extra)
		uci.set(PACKAGE, id, key, extra[key]);
};

function sectionFor(id) {
	for (let one in cfg.configured()) {
		if (one.id == id)
			return one;
	}

	return null;
};

/** A fresh engine over the current configuration, and a pass. */
function runFresh(id, now, reserved) {
	rtnl.setRules([]);
	rtnl.setRulesReadable(true);

	let st = engine.create(sectionFor(id));
	let out = reconcile.run(st, { bus: bus, now: now, reserved: reserved });

	return { st: st, out: out };
};

/** The client rules the kernel is holding, as `<ip> -> <table>`, sorted. */
function seated() {
	let out = [];

	for (let one in rtnl.kernelRules()) {
		// The catch-all sits at 30000 and is about a subnet, not a client.
		if (one.priority < 20000 || one.priority >= 30000)
			continue;

		push(out, sprintf('%s->%d', one.src, one.table));
	}

	return join(' ', sort(out));
};

/** How many of them there are. */
function seats() {
	let n = 0;

	for (let one in rtnl.kernelRules()) {
		if (one.priority >= 20000 && one.priority < 30000)
			n++;
	}

	return n;
};

/** The catch-all group, as `<cidr>` blocks, sorted. */
function fence() {
	let out = [];

	for (let one in rtnl.kernelRules()) {
		if (one.priority == 30000)
			push(out, one.src);
	}

	return join(' ', sort(out));
};

// ------------------------------------------------- one client per WAN, the default

leases([
	[ 'aa:bb:cc:00:00:01', '10.9.0.101', 'one' ],
	[ 'aa:bb:cc:00:00:02', '10.9.0.102', 'two' ],
	[ 'aa:bb:cc:00:00:03', '10.9.0.103', 'three' ],
	[ 'aa:bb:cc:00:00:04', '10.9.0.104', 'four' ]
]);

instance('solo', {});

let solo = runFresh('solo', 1000);

check('a pass over a readable router works', solo.out.ok, true);
check('three WANs seat three of the four clients', solo.out.bound, 3);
check('and the kernel is holding exactly three client rules', seats(), 3);
check('the fourth is waiting', length(solo.st.waiting), 1);
check('each client is on a WAN of its own',
	length(engine.wanHolders(solo.st, 'WAN0')) +
	length(engine.wanHolders(solo.st, 'WAN1')) +
	length(engine.wanHolders(solo.st, 'WAN2')), 3);
check('and no WAN carries two', engine.wanLoad(solo.st, 'WAN0'), 1);
check('nor does the next', engine.wanLoad(solo.st, 'WAN1'), 1);
check('the pool has nothing left to give', length(solo.st.freeWans), 0);
check('the whole LAN is fenced', fence(), '10.9.0.0/24');

// ------------------------------------------------------------- two to a WAN

instance('pair', { clients_per_wan: '2', catch_all_pref: '30000' });
uci.delete(PACKAGE, 'solo');

let pair = runFresh('pair', 2000);

check('two per WAN seats all four', pair.out.bound, 4);
check('and the kernel holds four client rules', seats(), 4);
check('with nobody waiting', length(pair.st.waiting), 0);

// Even, rather than two stacked on the first WAN and none on the third. A pool
// that fills front-first is a pool where the last line is idle while the first
// carries everybody.
let loads = sort([
	engine.wanLoad(pair.st, 'WAN0'),
	engine.wanLoad(pair.st, 'WAN1'),
	engine.wanLoad(pair.st, 'WAN2')
]);
check('and the pool fills evenly', join(',', loads), '1,1,2');

// Which WAN ended up carrying two is the pool order's business rather than
// anything worth pinning; that two of the three still have room, and that the
// full one does not, is the claim.
let roomy = 0;
for (let name in [ 'WAN0', 'WAN1', 'WAN2' ]) {
	if (engine.wanRoom(pair.st, name))
		roomy++;
}

check('the two WANs carrying one client each still have room', roomy, 2);
check('and both of them are still in the pool', length(pair.st.freeWans), 2);

// ------------------------------------------------------- no limit at all

instance('crowd', { clients_per_wan: '0', catch_all_pref: '30000' });
uci.delete(PACKAGE, 'pair');

let crowd = runFresh('crowd', 3000);

check('no limit seats everybody', crowd.out.bound, 4);
check('and the kernel holds four rules', seats(), 4);
check('a WAN always has room', engine.wanRoom(crowd.st, 'WAN0'), true);
check('so the pool never empties', length(crowd.st.freeWans) > 0, true);

// The thing people ask a multi-WAN router for that the old model could not do
// at all: every device on a LAN out of one chosen line, with the fail-closed
// catch-all still underneath.
uci.set(PACKAGE, 'crowd', 'carrier', 'eth1.11');

let single = runFresh('crowd', 3100);

check('a one-WAN pool with no limit seats everybody on it', single.out.bound, 4);
check('all of them on the same line', engine.wanLoad(single.st, 'WAN1'), 4);
check('and every rule points at that WAN table',
	seated(),
	'10.9.0.101/32->10001 10.9.0.102/32->10001 10.9.0.103/32->10001 10.9.0.104/32->10001');

uci.set(PACKAGE, 'crowd', 'carrier', 'eth1');

// --------------------------------------------------------------- an address range
//
// The half that decides which devices an instance may touch at all. A block
// covering one address more than the range does is a device fenced off the
// internet by an instance that will never give it a WAN.

instance('scoped', { range_from: '10.9.0.101', range_to: '10.9.0.102', catch_all_pref: '30000' });
uci.delete(PACKAGE, 'crowd');

let scoped = runFresh('scoped', 4000);

check('a scoped instance seats only what is inside it', scoped.out.bound, 2);
check('and the kernel holds two client rules', seats(), 2);
// The addresses are the claim. Which of the three WANs each of them landed on
// is the pool order's business, and pinning it here would make this probe fail
// the next time somebody changes how a free WAN is chosen - which is a decision
// this file has no opinion about.
let addresses = [];
let tables = {};
for (let one in rtnl.kernelRules()) {
	if (one.priority < 20000 || one.priority >= 30000)
		continue;

	push(addresses, one.src);
	tables[sprintf('%d', one.table)] = true;
}

check('the two inside the range', join(' ', sort(addresses)), '10.9.0.101/32 10.9.0.102/32');
check('on a WAN each', length(keys(tables)), 2);
check('nobody outside it is waiting either', length(scoped.st.waiting), 0);
check('and the fence covers exactly the range', fence(), '10.9.0.101/32 10.9.0.102/32');

// The device outside the range must be able to leave by the router's ordinary
// routing, which is what "no rule at all for it" means.
check('the address outside the range has no rule of its own',
	index(seated(), '10.9.0.103'), -1);

// A settled router writes nothing. The catch-all is a group of several rules
// now, and a comparison that cared about the order they came back in would tear
// it down and rebuild it on every pass - with a window each time where the LAN
// is not fenced at all.
let before = seats();
let again = reconcile.run(scoped.st, { bus: bus, now: 4030 });

check('a second pass over a settled router works', again.ok, true);
check('and writes nothing', again.bound, 0);
check('the fence is still exactly the range', fence(), '10.9.0.101/32 10.9.0.102/32');
check('and the seats are untouched', seats(), before);

// ----------------------------------------------------------- a WAN that fails

instance('failing', { clients_per_wan: '2', catch_all_pref: '30000' });
uci.delete(PACKAGE, 'scoped');

let failing = runFresh('failing', 5000);
check('everybody is seated to start with', failing.out.bound, 4);

let carried = length(engine.wanHolders(failing.st, 'WAN2'));

// WAN2 goes down, and stays down past the grace. Every client on it moves, not
// the first one: above one client per WAN a failing line is several people off
// the internet.
wan2Up = false;

reconcile.run(failing.st, { bus: bus, now: 5001 });
let moved = reconcile.run(failing.st, { bus: bus, now: 5100 });

check('the clients on a failed WAN are moved off it', engine.wanLoad(failing.st, 'WAN2'), 0);
check('all of them', moved.remapped, carried);
check('and the kernel is holding a rule for each of them somewhere else', seats(), 4);

wan2Up = true;

// ------------------------------------------------- bound by hand, so left alone
//
// A hand-placed binding's rule sits below this instance's whole client range,
// so the kernel reaches it first. An instance that seated the same device
// anyway would write a second rule nothing ever gets to, and would hold one of
// its WANs open for traffic leaving by the binding's - a client reported bound
// to a line it does not use, and one fewer WAN for everybody actually waiting.

instance('shared2', { clients_per_wan: '1', catch_all_pref: '30000' });
uci.delete(PACKAGE, 'failing');

// .102 is bound by hand. .101, .103 and .104 are not.
let held = { 'aa:bb:cc:00:00:02': '10.9.0.102' };

let reserved = runFresh('shared2', 6000, held);

check('the reserved device is not seated', engine.wanLoad(reserved.st, 'WAN0') +
	engine.wanLoad(reserved.st, 'WAN1') + engine.wanLoad(reserved.st, 'WAN2'), 3);
check('and the kernel holds no rule for its address',
	index(seated(), '10.9.0.102'), -1);
check('while the other three are seated', reserved.out.bound, 3);
check('and it is not sitting in the queue either', length(reserved.st.waiting), 0);
check('the pool has nothing left over', length(reserved.st.freeWans), 0);

// The same thing keyed the way it is keyed on a real router, which is where
// this went wrong.
//
// `service.pass()` keys a binding that follows a MAC by that MAC, and one that
// follows an address by the address - it has nothing else to key it by, because
// a binding on a typed address need never have seen a lease. Every assertion
// above hands in a MAC, and every reader in `reconcile.uc` was a lookup into a
// table of MACs, so the MAC case worked and passed. The address case - which is
// what `bmwan bind --ip` and the app's own one-to-one form both produce, and so
// very nearly all of them - missed on every pass. The instance seated the
// address anyway: two rules, the binding's winning on priority, and one of the
// pool's WANs held open for traffic that left by another.
//
// The three checks are the same three, and they are the ones that were green
// with the fault in place.
let byAddress = runFresh('shared2', 6050, { '10.9.0.102': '10.9.0.102' });

check('a binding keyed by its address reserves too', engine.wanLoad(byAddress.st, 'WAN0') +
	engine.wanLoad(byAddress.st, 'WAN1') + engine.wanLoad(byAddress.st, 'WAN2'), 3);
check('and the kernel holds no client rule for it',
	index(seated(), '10.9.0.102'), -1);
check('and it is not queued behind anybody either', length(byAddress.st.waiting), 0);
check('and it is reported as reserved rather than missing',
	byAddress.st.reservedMacs['aa:bb:cc:00:00:02'], '10.9.0.102');

// The other direction, which is the one that actually happens: the device is
// seated first and the binding is written afterwards. Its WAN has to come back.
let later = runFresh('shared2', 6100, {});
check('with nothing reserved all four compete for three WANs', later.out.bound, 3);

let took = engine.wanHolders(later.st, 'WAN0');
let victim = length(took) ? took[0] : '';

check('somebody holds WAN0', length(victim) > 0, true);

let after = reconcile.run(later.st, { bus: bus, now: 6200,
	reserved: { [victim]: later.st.devices[victim].ip } });

check('a pass after the binding is written gives the WAN back', after.ok, true);
check('and that device is no longer on it', engine.onWan(later.st, 'WAN0', victim), false);
check('nor anywhere else', later.st.devices[victim].wan, null);
check('and the kernel is not holding a rule for its address',
	index(seated(), later.st.devices[victim].ip), -1);

// A rule left behind from before the binding existed is a stray, not something
// to adopt - or the instance would take it back on the very next pass.
rtnl.setRules([ { priority: 20099, src: '10.9.0.102/32', table: 10001, action: 1 } ]);

let adopting = runFresh('shared2', 6300, held);

check('an existing rule for a reserved address is not adopted',
	engine.wanLoad(adopting.st, 'WAN0') + engine.wanLoad(adopting.st, 'WAN1') +
	engine.wanLoad(adopting.st, 'WAN2'), 3);
check('and it is taken off the router', index(seated(), '10.9.0.102/32'), -1);

report();
