// The router-owned write path, run rather than read.
//
// `bind`, `unbind`, `bindings`, `layout`, `reconcile` and the plain `flush` are
// the half of bm-wanbind where the router is the source of truth: they do not
// report on state this process is holding, they edit /etc/config/bm_wanbind and
// then ask `bm.wanbind.config` to read it back and say whether what they wrote
// is a binding this router can act on. Until this file existed every one of
// them had been compiled and none of them had ever run - the one probe that
// imports this module calls `info()` and a `flush` naming an instance, and the
// instance name is exactly what makes it skip the binding half.
//
// So the assertions here are about the file and not about the return value. A
// method that answered `{ ok: true }` and wrote nothing, wrote the wrong section
// type, or cleared a field it was not asked about would satisfy every check
// that read only what it handed back - and the operator would find out when an
// address stopped going out of the port they chose. `uci.get` is therefore the
// witness throughout: what the cursor holds after the call, including the
// section's *type*, which is how a `bind` that turned a whole LAN's instance
// into a one-address binding would be caught.
//
// The router below is the one the two probes next door are written against, so
// all three halves of this package are checked against one box rather than
// three imaginary ones.

import { seed } from 'fs';
import { cursor } from 'uci';

import * as rtnl from 'rtnl';
import * as service from 'bm.wanbind.service';

import { check, report, says } from 'probe';

const PACKAGE = 'bm_wanbind';

let uci = cursor();

// ------------------------------------------------------------- the interfaces

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

function wanEntry(name, device, addr, table) {
	let entry = {
		interface: name,
		proto: 'dhcp',
		device: device,
		l3_device: device,
		up: true,
		uptime: 900,
		'ipv4-address': [ { address: addr, mask: 24 } ]
	};

	if (table)
		entry.ip4table = sprintf('%d', table);

	return entry;
};

let router = [
	lanEntry('lan', 'eth1', '12.10.1.1', 10004),
	lanEntry('LAN_WIRED', 'eth0', '12.10.10.1', 0),
	wanEntry('WAN0', 'eth2', '203.0.113.10', 10000),
	wanEntry('WAN1', 'eth3', '203.0.113.20', 10001),
	wanEntry('WAN2', 'eth4', '203.0.113.30', 10002),
	// Up, healthy, and with no routing table of its own. `bind` has to refuse a
	// binding onto it rather than stamp one with a table nothing routes.
	wanEntry('WAN3', 'eth5', '203.0.113.40', 0)
];

// netifd, and the one call `direct.run` makes back at it when it has given a
// WAN a routing table. Answering it is not decoration: a reload the fixture
// refused would raise inside the pass rather than being reported.
let reloaded = 0;

let bus = {
	call: function(object, method, args) {
		if (object == 'network' && method == 'reload') {
			reloaded++;
			return {};
		}

		if (object != 'network.interface' || method != 'dump')
			return null;

		return { interface: router };
	}
};

// The kernel: one default route out of eth2, which is what settles WAN0 as an
// uplink, and no ip rules at all. Both readings come off this one list - the
// rule dump throws away anything with no priority and no source, which is every
// route here, so a router with a default route and no rules is what the daemon
// sees.
rtnl.setRoutes([
	{ family: 2, type: 1, oif: 'eth2', gateway: '203.0.113.1', table: 254 }
]);

// ------------------------------------------------------------ /etc/config/*

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

uci.set(PACKAGE, 'main', 'wanbind');
uci.set(PACKAGE, 'main', 'interval', '30');
uci.set(PACKAGE, 'main', 'direct_pref_base', '19000');

uci.set(PACKAGE, 'home', 'instance');
uci.set(PACKAGE, 'home', 'lan', 'lan');
uci.set(PACKAGE, 'home', 'carrier', 'eth9');
uci.set(PACKAGE, 'home', 'rule_pref_base', '20000');
uci.set(PACKAGE, 'home', 'catch_all_pref', '30000');
uci.set(PACKAGE, 'home', 'catch_all_table', '253');

seed('/tmp/dhcp.leases', '0 aa:bb:cc:dd:ee:01 12.10.1.41 laptop *\n');

// ------------------------------------------------------------- the daemon

// The runner for the one command in this package that is not a ubus call.
// Recorded rather than counted, because the claim worth making is *which*
// command ran: `attachSystem` was once written, documented and never handed in,
// and every forwarding the daemon wrote was committed and never put in force
// while the row read `ok`.
let ran = [];

service.attach(bus);
service.attachSystem((command, timeout) => {
	push(ran, command);
	return 0;
});

service.load();

function lastRan() {
	return length(ran) ? ran[length(ran) - 1] : '';
};

function roleOf(list, name) {
	for (let one in list) {
		if (one.name == name)
			return one.role;
	}

	return '';
};

function zoneOf(list, name) {
	for (let one in list) {
		if (one.name == name)
			return one.zone;
	}

	return '';
};

// --------------------------------------------------------------- the layout
//
// What the module asks before it offers an address to bind. It has to be the
// answer the daemon itself acts on, or a surface offers a binding that cannot
// be made.

let seen = service.interfaces();

check('the layout verb answers', seen.ok, true);
check('and says the router was read, not merely guessed at', seen.stated, true);
check('WAN0 is on the way out', roleOf(seen.interfaces, 'WAN0'), 'uplink');
check('the wired LAN is one of the router\'s own', roleOf(seen.interfaces, 'LAN_WIRED'), 'lan');
check('and lan is too', roleOf(seen.interfaces, 'lan'), 'lan');
check('the zone a forwarding would run from is carried', zoneOf(seen.interfaces, 'lan'), 'lan');
check('and the one it would run to', zoneOf(seen.interfaces, 'WAN0'), 'wan');

// A refusal rather than an empty list. An empty list says this router has no
// interfaces at all, and every surface reading it would act on that.
service.attach(null);
let blind = service.interfaces();
check('with netifd silent the layout verb refuses', blind.ok, false);
says('and says what to try', blind.reason, /ubus call network.interface dump/);
service.attach(bus);

// ------------------------------------------------------------------ creating

let made = service.bind({
	id: 'desk',
	name: 'Front desk',
	ip: '12.10.1.40',
	wan: 'WAN0',
	lan: 'lan',
	when_down: 'fallback'
});

check('a binding is created', made.ok, true);
check('and the answer carries the row for it', made.binding ? made.binding.id : '', 'desk');

// What the file holds, which is the only thing that outlives this process.
check('the section is a binding and not an instance', uci.get(PACKAGE, 'desk'), 'direct');
check('it follows the address it was given', uci.get(PACKAGE, 'desk', 'ip'), '12.10.1.40');
check('and no mac beside it, which the reader would refuse', uci.get(PACKAGE, 'desk', 'mac'), null);
check('it leaves by the WAN it was given', uci.get(PACKAGE, 'desk', 'wan'), 'WAN0');
check('from the LAN it was given', uci.get(PACKAGE, 'desk', 'lan'), 'lan');
check('under the name it was given', uci.get(PACKAGE, 'desk', 'name'), 'Front desk');
check('with the word it was given for its WAN being down', uci.get(PACKAGE, 'desk', 'when_down'), 'fallback');
check('it is on', uci.get(PACKAGE, 'desk', 'enabled'), '1');

// The two numbers nobody sent. The priority is the lowest free one in the band,
// and the table is what netifd says WAN0 is using right now - not what
// /etc/config/network says it will use after the next reload.
check('a free priority was taken out of the band', uci.get(PACKAGE, 'desk', 'pref'), '19000');
check('and the table came from netifd', uci.get(PACKAGE, 'desk', 'table'), '10000');

// The pass `bind` runs before it answers, so that somebody watching the address
// they just bound sees it work now rather than in half a minute.
check('the pass wrote the binding\'s firewall path', uci.get('firewall', 'bmd_desk', 'src'), 'lan');
check('to the WAN\'s zone', uci.get('firewall', 'bmd_desk', 'dest'), 'wan');
check('and fw4 was actually reloaded rather than the path being left unread',
	lastRan(), '/etc/init.d/firewall reload');
// The other reload, which must not have happened: WAN0 already had its own
// routing table, and bouncing netifd on a router carrying live sessions to
// write a number that was already there is not a thing a create may do.
check('netifd was left alone, because WAN0 already had its table', reloaded, 0);

// ------------------------------------------------------------- and editing
//
// One method for both, because the router is the source of truth: the module
// says what the section should contain and this makes the file say it. What
// that must not mean is that a field nobody mentioned is taken away.

let before = uci.get_all(PACKAGE, 'desk');
check('the section before the edit has the name it was given', before.name, 'Front desk');
check('and the LAN', before.lan, 'lan');
check('and the word for its WAN being down', before.when_down, 'fallback');

let edited = service.bind({ id: 'desk', ip: '12.10.1.41', wan: 'WAN0' });

check('an edit is accepted', edited.ok, true);
check('the address it was given is in force', uci.get(PACKAGE, 'desk', 'ip'), '12.10.1.41');
check('and there is still one section, not two', uci.get(PACKAGE, 'desk'), 'direct');

// The numbers the rule already on the router was written against. Allocating
// again here would leave the real rule behind, unowned and still carrying
// traffic.
check('the priority is kept rather than allocated again', uci.get(PACKAGE, 'desk', 'pref'), '19000');
check('and so is the table', uci.get(PACKAGE, 'desk', 'table'), '10000');

// The fields an absent argument must not clear. Each of these is a working
// binding quietly becoming a different one: no name is a row nobody recognises,
// no lan is a binding with no firewall path from the network its address is on,
// and when_down reverting is an address that was told it would fall back being
// held off the network instead.
check('an edit that said nothing about the name did not take it away',
	uci.get(PACKAGE, 'desk', 'name'), before.name);
check('nor about the lan', uci.get(PACKAGE, 'desk', 'lan'), before.lan);
check('nor about when_down', uci.get(PACKAGE, 'desk', 'when_down'), before.when_down);

// The same claim for the one field where getting it wrong puts an address back
// on a WAN somebody deliberately took it off.
check('a binding can be switched off through the same call',
	service.bind({ id: 'desk', ip: '12.10.1.41', wan: 'WAN0', enabled: false }).ok, true);
check('and the file says so', uci.get(PACKAGE, 'desk', 'enabled'), '0');

service.bind({ id: 'desk', ip: '12.10.1.41', wan: 'WAN0' });
check('an edit that said nothing about enabled did not switch it back on',
	uci.get(PACKAGE, 'desk', 'enabled'), '0');

// Everything said out loud again, so what follows starts from a section this
// file wrote in full rather than from whatever the checks above left behind.
check('and it can be switched back on', service.bind({
	id: 'desk',
	name: 'Front desk',
	ip: '12.10.1.41',
	wan: 'WAN0',
	lan: 'lan',
	when_down: 'fallback',
	enabled: true
}).ok, true);
check('the file agrees', uci.get(PACKAGE, 'desk', 'enabled'), '1');

// ------------------------------------------------------- what is refused
//
// Every one of these has to leave the file exactly as it found it, which is the
// half a return value cannot show.

check('a nameless binding is refused', service.bind({ ip: '12.10.1.42', wan: 'WAN0' }).ok, false);

says('a name no UCI section can have is refused',
	service.bind({ id: 'front-desk', ip: '12.10.1.42', wan: 'WAN0' }).reason,
	/is not a name a UCI section can have/);
check('and no section by it was written', uci.get(PACKAGE, 'front-desk'), null);

says('the package\'s own settings section is not a binding',
	service.bind({ id: 'main', ip: '12.10.1.42', wan: 'WAN0' }).reason,
	/main is this package/);
check('and it is still the settings section', uci.get(PACKAGE, 'main'), 'wanbind');
check('with its interval intact', uci.get(PACKAGE, 'main', 'interval'), '30');

// The one that would be a whole LAN's pool of WANs deleted by a call that was
// adding one address.
says('an instance\'s name is refused',
	service.bind({ id: 'home', ip: '12.10.1.42', wan: 'WAN0' }).reason,
	/already an instance/);
check('and the instance is still an instance', uci.get(PACKAGE, 'home'), 'instance');
check('with its priority range intact', uci.get(PACKAGE, 'home', 'rule_pref_base'), '20000');

says('a binding cannot follow both an address and a device',
	service.bind({ id: 'both', ip: '12.10.1.42', mac: 'aa:bb:cc:dd:ee:01', wan: 'WAN0' }).reason,
	/not both/);
check('and nothing was written for it', uci.get(PACKAGE, 'both'), null);

says('nor neither',
	service.bind({ id: 'neither', wan: 'WAN0' }).reason,
	/nothing for this binding to follow/);

says('and a binding with no WAN has no port to leave through',
	service.bind({ id: 'nowan', ip: '12.10.1.42' }).reason,
	/name the WAN/);
check('and nothing was written for that either', uci.get(PACKAGE, 'nowan'), null);

// The one that cost a router a subnet.
//
// `bind` took the WAN name on trust. Told to bind an address to LAN_WIRED - a
// name a person can reach for, because it is the LAN the address is on and it
// reads like an interface - it found no `option ip4table` there, allocated one,
// wrote it and reloaded netifd. That LAN's connected route moved out of `main`
// into a table nothing else consults, and the 12.10.10.0/24 subnet stopped
// being reachable from the other LAN, from the router's own services, and from
// the person who had just run the command. Thirty-five devices re-ran DHCP.
// The reply said `ok: true`.
//
// So the assertion that matters here is the last one. A refusal that still
// wrote the option would satisfy the first two and cut the router off exactly
// as before.
says('a LAN is not a WAN, and binding to one is refused',
	service.bind({ id: 'wrongside', ip: '12.10.10.240', wan: 'LAN_WIRED' }).reason,
	/one of this router.s own LANs/);
check('and no binding was written', uci.get(PACKAGE, 'wrongside'), null);
check('and that LAN still has no routing table of its own',
	uci.get('network', 'LAN_WIRED', 'ip4table'), null);

// The same name through the check verb, which is what a form asks before it
// offers a Save button.
says('and the check verb says so before anything is typed',
	service.bindCheck({ id: 'wrongside', ip: '12.10.10.240', wan: 'LAN_WIRED' }).findings[0].detail,
	/one of this router.s own LANs/);

// An interface netifd has never heard of is refused for the same reason and at
// the same point: the name is what the table would have been written against.
says('an interface this router does not have is refused',
	service.bind({ id: 'ghost', ip: '12.10.1.42', wan: 'WAN9' }).reason,
	/knows no interface called WAN9/);
check('and nothing was written for it', uci.get(PACKAGE, 'ghost'), null);

// A WAN with no routing table of its own is given one.
//
// This used to be a refusal, and on a real router that made the whole feature
// unreachable: `option ip4table` is not part of a stock OpenWrt WAN, so every
// `bmwan bind` at a shell answered with an instruction to go and hand-edit
// /etc/config/network - on the one path that is supposed to work without the
// app. The number is allocated here, from the same base the app's own half
// numbers WAN tables from, and written to the interface section.
//
// The rule still may not point at a table nothing is filling: a rule whose
// table has no route does not fail, it falls through to main, and the binding
// would read bound while the address left over the default connection. That is
// what the table being *written to the WAN* prevents - netifd fills it once it
// re-reads the section.
let shed = service.bind({ id: 'shed', ip: '12.10.1.99', wan: 'WAN3' });
check('a WAN with no routing table of its own is given one', shed.ok, true);
check('the section is written', uci.get(PACKAGE, 'shed'), 'direct');
// Asserted between the two places the number has to agree, rather than through
// the reply. That is the invariant worth holding: the interface carries the
// table the binding points at. A rule pointing at a table netifd is not filling
// does not fail - it falls through to main - so a binding whose two numbers
// disagree reads bound while the address leaves over the default connection.
let shedTable = uci.get(PACKAGE, 'shed', 'table');
check('the binding is stamped with a table', shedTable != null && shedTable != '0', true);
check('and the WAN carries the same one', uci.get('network', 'WAN3', 'ip4table'), shedTable);
check('numbered from the base the other half uses', int(shedTable) >= 10000, true);

// Taken straight back off, so the counts further down still mean what they say.
// The alternative was to raise four numbers in three sections, which is how a
// probe stops describing anything.
service.unbind({ id: 'shed' });
check('and the file is back to what it was', uci.get(PACKAGE, 'shed'), null);

// ------------------------------------------- a write the reader would not take
//
// The section is written, read back, refused, and put back the way it was. This
// is the path that turns a rejected edit into a binding that was working before
// the call and writes no rule after it.

let bad = service.bind({ id: 'desk', ip: '12.10.1.41', wan: 'WAN0', when_down: 'drop' });

check('a third answer to when_down is refused', bad.ok, false);
says('in the reader\'s own words', bad.reason, /neither hold nor fallback/);

check('and the binding that was working is put back', uci.get(PACKAGE, 'desk', 'when_down'), 'fallback');
check('with its address', uci.get(PACKAGE, 'desk', 'ip'), '12.10.1.41');
check('its name', uci.get(PACKAGE, 'desk', 'name'), 'Front desk');
check('its LAN', uci.get(PACKAGE, 'desk', 'lan'), 'lan');
check('its priority', uci.get(PACKAGE, 'desk', 'pref'), '19000');
check('and its table', uci.get(PACKAGE, 'desk', 'table'), '10000');

// ------------------------------------------ a section no pass has reached
//
// Written by hand a moment ago, or written while netifd was not answering.
// Disproportionately the row somebody opened a list to find, so it has to be in
// it - with everything the file can say about it and nothing invented.

uci.set(PACKAGE, 'shop', 'direct');
uci.set(PACKAGE, 'shop', 'ip', '12.10.1.50');
uci.set(PACKAGE, 'shop', 'wan', 'WAN1');
uci.set(PACKAGE, 'shop', 'lan', 'lan');
uci.set(PACKAGE, 'shop', 'when_down', 'fallback');
uci.set(PACKAGE, 'shop', 'pref', '19005');
uci.set(PACKAGE, 'shop', 'table', '10001');

let cold = service.bindings('shop');
check('the section is listed', length(cold.bindings), 1);

let row = cold.bindings[0];
check('by its section name', row.id, 'shop');
check('with no state, because nothing has looked at the router for it', row.state, '');
says('and the row says exactly that', row.reason, /no pass has reached this binding yet/);
check('the priority is the one written in the file', row.pref, 19005);
check('the stamped table is reported as stamped', row.stampedTable, 10001);
check('and no table is claimed to be in force', row.table, 0);
check('an address binding is its own address', row.ip, '12.10.1.50');
check('and no rule is claimed to have been written', row.since, 0);

let both = service.bindings('', '');
check('naming nothing lists every binding in the file', length(both.bindings), 2);
check('the band rides along for a caller about to add one', both.band.base, 19000);
check('and says whether it may take any at all', both.band.usable, true);

// ------------------------------------------------- one list, two kinds of row
//
// An instance is a generator of bindings rather than a different kind of thing:
// what it puts on the wire is the same address-to-table rule a hand-placed
// binding is. So both belong in one list, told apart by `source` - and a
// surface asking "what is bound on this router" gets the answer rather than
// half of it and a second call to make.

check('every row somebody placed says so', both.bindings[0].source, 'manual');
check('and the counts separate the two kinds', both.counts.manual, 2);
check('with none seated by an instance on this router yet', both.counts.derived, 0);
check('and an unfiltered list says it was not narrowed', both.filtered, false);

let states = both.counts.byState;
check('the states are counted', type(states) == 'object', true);

// The distinction the whole reply hangs on: an empty list after a filter is not
// a router with nothing on it. Nothing else in the answer could tell them
// apart, and a page that could not would state a fact about the whole router
// while showing a view that can never hold a row.
let none = service.bindings('', 'home');

check('a filter that matches nothing answers an empty list', length(none.bindings), 0);
check('and says the list was narrowed', none.filtered, true);
check('while the counts still describe the router', none.counts.manual, 2);

let one = service.bindings('desk', '');

check('an id narrows to that binding', length(one.bindings), 1);
check('and it is the one asked for', one.bindings[0].id, 'desk');
check('and that is narrowed too', one.filtered, true);

// Every band a rule could legitimately sit in, so a reader does not have to
// know this daemon's numbering to tell a binding from an instance's client.
check('the instance bands ride along', length(both.instances), 1);
check('named', both.instances[0].id, 'home');
check('with the range its clients are numbered in', both.instances[0].base, 20000);
check('and the priority its fence sits at', both.instances[0].catchAllPref, 30000);

// ------------------------------------------------------------------ removing

let gone = service.unbind({ id: 'shop' });

check('the binding is removed', gone.ok, true);
check('and there is nothing left for anybody to do by hand', gone.reason, null);
check('the section is gone from the file', uci.get(PACKAGE, 'shop'), null);
check('and the binding beside it is untouched', uci.get(PACKAGE, 'desk', 'ip'), '12.10.1.41');
check('one binding left', length(service.bindings('').bindings), 1);

says('a name that is not there is refused', service.unbind({ id: 'nosuch' }).reason,
	/no binding called nosuch/);
says('and so is no name at all', service.unbind({}).reason, /name the binding to remove/);
check('and neither of those took the binding that is there',
	uci.get(PACKAGE, 'desk'), 'direct');

// ------------------------------------------------- a priority outside the band
//
// The pass sweeps the band and nothing else, so a binding somebody numbered
// below it leaves a rule this daemon has no claim to. The section still goes;
// what must not happen is the removal reporting itself finished.

uci.set(PACKAGE, 'stray', 'direct');
uci.set(PACKAGE, 'stray', 'ip', '12.10.1.60');
uci.set(PACKAGE, 'stray', 'wan', 'WAN1');
uci.set(PACKAGE, 'stray', 'lan', 'lan');
uci.set(PACKAGE, 'stray', 'when_down', 'fallback');
uci.set(PACKAGE, 'stray', 'pref', '18000');
uci.set(PACKAGE, 'stray', 'table', '10001');

let strayGone = service.unbind({ id: 'stray' });

check('the section goes just the same', strayGone.ok, true);
check('and it is gone', uci.get(PACKAGE, 'stray'), null);
says('but the rule out there is said to be somebody\'s to remove',
	strayGone.reason, /outside the 19000-19999 band this daemon sweeps/);
says('and the sentence says how to find it', strayGone.reason, /ip -4 rule show/);

// --------------------------------------------------------------- reconciling

// `wait` is what a person pressing a button sends. Without it the request is
// folded into the pass that is already due - which is what the hotplug hooks
// want and what the scale probe next door measures.
let now = service.reconcileNow({ wait: true });

check('a pass with nothing named runs', now.ok, true);
check('over the one instance', length(now.passes), 1);
check('and over the bindings, which belong to no instance', now.core ? now.core.ok : false, true);
check('all one of them', now.core ? now.core.bindings : 0, 1);

let narrow = service.reconcileNow({ instance: 'home' });

check('naming an instance still runs it', narrow.ok, true);
check('over that instance', length(narrow.passes), 1);
// Deliberately: a binding belongs to no instance, and reconciling one is not
// part of what somebody asked about the other.
check('and deliberately leaves the bindings alone', narrow.core, null);

says('a name that is not an instance is refused',
	service.reconcileNow({ instance: 'nope' }).reason, /no instance by that name/);

// The router below has the conflict built into it: `desk` is a binding on
// 12.10.1.41, `home` is an instance over the LAN that address is on, and
// /tmp/dhcp.leases hands 12.10.1.41 to aa:bb:cc:dd:ee:01. So a pass either
// leaves that device to the binding or seats it as one of the instance's
// clients, and which one it does is the whole of this check.
//
// It has to be asserted here rather than only against `reconcile.run`, because
// what was wrong was neither the instance half nor the binding half but the
// wiring between them: the thirty-second timer built the list of addresses
// already spoken for and handed it over, and this method - the one behind
// `Run a pass now`, the module's reconcile action and `bmwan reconcile` - did
// not build it at all. Every address on the router read as free, so a button
// undid what the timer had just decided, on a router where nothing was
// misconfigured and nothing was logged.
let leftAlone = service.waiting({});
let spokenFor = null;

for (let one in leftAlone.waiting) {
	if (one.why == 'reserved')
		spokenFor = one;
}

check('a pass run by hand leaves the address a binding already decides',
	spokenFor ? spokenFor.ip : '', '12.10.1.41');
check('and knows the device by its MAC, not by the address it was keyed under',
	spokenFor ? spokenFor.mac : '', 'aa:bb:cc:dd:ee:01');
says('and says why rather than dropping it off every table',
	spokenFor ? spokenFor.reason : '', /already decides this address/);

// --------------------------------------------------------------- the uninstall
//
// `flush` naming an instance is the first half of stopping that instance.
// `flush` naming none is `apk del bm-wanbind`, and it has to leave nothing
// behind - which for a binding means the rule and the firewall path, and does
// not mean the section.

// A forwarding whose binding has gone, so the sweep has one of each to find.
uci.set('firewall', 'bmd_ghost', 'forwarding');
uci.set('firewall', 'bmd_ghost', 'src', 'lan');
uci.set('firewall', 'bmd_ghost', 'dest', 'wan');

let justHome = service.flush({ instance: 'home' });

check('flushing one instance succeeds', justHome.ok, true);
check('and takes no binding rule off', justHome.bindings, 0);
check('nor any forwarding', justHome.forwardings, 0);
check('so the binding\'s path is exactly where it was', uci.get('firewall', 'bmd_desk', 'dest'), 'wan');
check('and so is the orphan, which is nobody\'s business until the uninstall',
	uci.get('firewall', 'bmd_ghost', 'dest'), 'wan');

let all = service.flush({});

check('the uninstall flush succeeds', all.ok, true);
check('with nothing to say went wrong', all.reason, null);
// The binding above really has a rule in the kernel by now - `bind` runs a pass
// before it answers - so this is the count that says `apk del` leaves nothing
// steering traffic, rather than a zero that only meant nothing was ever there.
check('the rule the binding had comes off with it', all.removed, 1);
check('and the kernel is holding nothing this package wrote',
	length(rtnl.kernelRules()), 0);
check('both firewall paths come off', all.forwardings, 2);
check('the binding\'s', uci.get('firewall', 'bmd_desk'), null);
check('and the orphan\'s', uci.get('firewall', 'bmd_ghost'), null);
check('and fw4 was reloaded, or they would still be in force', lastRan(), '/etc/init.d/firewall reload');

// The line between taking the rules off and deleting somebody's configuration.
// `apk del` removes a package; it does not remove the bindings from a file the
// operator wrote, and a reinstall has to find them still there.
check('the binding is still in the file', uci.get(PACKAGE, 'desk'), 'direct');
check('with its priority', uci.get(PACKAGE, 'desk', 'pref'), '19000');
check('and it is still listed', length(service.bindings('').bindings), 1);
says('with no pass behind it any more',
	service.bindings('desk').bindings[0].reason, /no pass has reached this binding yet/);

report();
