// What the router makes of its own interfaces - against the router that proved
// the old answer wrong.
//
// A user reported Binding 1-1 refusing a device on their own LAN: "12.10.10.10
// is on LAN_WIRED, which this router uses as an uplink rather than as a LAN".
// The configuration below is theirs, read off the box over SSH: two LANs, one
// of which carries `option gateway` because a second router sits on it, four
// DHCP uplinks, and every address in public space because that is what the site
// was allocated. Three readings lined up to produce that sentence - a gateway
// weighted as heavily as anything else, an address read as "routable so
// external", and nothing anywhere asking the kernel which way out is.
//
// So this is the regression net for the router half. If LAN_WIRED ever reads as
// an uplink again, it says so here rather than in somebody's living room.
//
// Everything the classifier needs can be written down except one fact: netlink.
// The route devices are handed to statements() the way the daemon hands it the
// kernel's answer, and the last section then takes them away again - because a
// router whose netlink read failed must still classify its interfaces
// correctly, and only two of the three decisive statements are left to do it.

import { cursor } from 'uci';

import * as rtnl from 'rtnl';
import * as layout from 'bm.wanbind.layout';
import * as wans from 'bm.wanbind.wans';

import { check, report, says } from 'probe';

/** A netifd that answers `network.interface dump` with exactly this list. */
function busFor(list) {
	return {
		call: function(object, method, args) {
			if (object != 'network.interface' || method != 'dump')
				return null;

			return { interface: list };
		}
	};
};

function iface(name, proto, device, addr, mask) {
	let entry = {
		interface: name,
		proto: proto,
		device: device,
		l3_device: device,
		up: true
	};

	if (addr)
		entry['ipv4-address'] = [ { address: addr, mask: mask } ];

	return entry;
};

/** The evidence as one string, so a probe can ask whether it was said. */
function told(list) {
	return type(list) == 'array' ? join(' | ', list) : '';
};

function verdict(result, name) {
	return result.byName[name] ? result.byName[name] : { role: 'missing', lanEvidence: [], uplinkEvidence: [] };
};

let uci = cursor();

// ------------------------------------------------------- the router, verbatim
//
// network.lan            proto static, device eth1, 12.10.1.1/24, ip6assign 60
// network.LAN_WIRED      proto static, device eth0, 12.10.10.1/24, gateway 168.192.1.1
// network.WAN0..WAN3     proto dhcp, devices eth2..eth5
// dhcp.lan               interface 'lan', limit 200
// dhcp.LAN_WIRED         interface 'LAN_WIRED', limit 250
// firewall zone 'lan'    network 'lan' 'LAN_WIRED'            (no masq)
// firewall zone 'wan'    network 'WAN1' 'WAN0' 'WAN2' 'WAN3', masq 1
// ip -4 route list table main -> default via 192.168.1.1 dev eth2 ...

uci.set('network', 'lan', 'interface');
uci.set('network', 'lan', 'proto', 'static');
uci.set('network', 'lan', 'device', 'eth1');
uci.set('network', 'lan', 'ipaddr', '12.10.1.1');
uci.set('network', 'lan', 'netmask', '255.255.255.0');
uci.set('network', 'lan', 'ip6assign', '60');
uci.set('network', 'lan', 'defaultroute', '0');

uci.set('network', 'LAN_WIRED', 'interface');
uci.set('network', 'LAN_WIRED', 'proto', 'static');
uci.set('network', 'LAN_WIRED', 'device', 'eth0');
uci.set('network', 'LAN_WIRED', 'ipaddr', '12.10.10.1');
uci.set('network', 'LAN_WIRED', 'netmask', '255.255.255.0');
// The line that used to decide it, and the whole reason this file exists. The
// second router on that LAN is what it is for; it is not a statement about
// which side of this router the interface is on.
uci.set('network', 'LAN_WIRED', 'gateway', '168.192.1.1');
uci.set('network', 'LAN_WIRED', 'defaultroute', '0');

for (let i = 0; i < 4; i++) {
	let name = sprintf('WAN%d', i);
	uci.set('network', name, 'interface');
	uci.set('network', name, 'proto', 'dhcp');
	uci.set('network', name, 'device', sprintf('eth%d', i + 2));
}

uci.set('dhcp', 'lan', 'dhcp');
uci.set('dhcp', 'lan', 'interface', 'lan');
uci.set('dhcp', 'lan', 'start', '100');
uci.set('dhcp', 'lan', 'limit', '200');

uci.set('dhcp', 'LAN_WIRED', 'dhcp');
uci.set('dhcp', 'LAN_WIRED', 'interface', 'LAN_WIRED');
uci.set('dhcp', 'LAN_WIRED', 'start', '100');
uci.set('dhcp', 'LAN_WIRED', 'limit', '250');

uci.set('firewall', 'lanzone', 'zone');
uci.set('firewall', 'lanzone', 'name', 'lan');
uci.set('firewall', 'lanzone', 'network', [ 'lan', 'LAN_WIRED' ]);
uci.set('firewall', 'lanzone', 'input', 'ACCEPT');
uci.set('firewall', 'lanzone', 'forward', 'ACCEPT');

uci.set('firewall', 'wanzone', 'zone');
uci.set('firewall', 'wanzone', 'name', 'wan');
uci.set('firewall', 'wanzone', 'network', [ 'WAN1', 'WAN0', 'WAN2', 'WAN3' ]);
uci.set('firewall', 'wanzone', 'masq', '1');

let bus = busFor([
	iface('loopback', 'static', 'lo', '127.0.0.1', 8),
	iface('lan', 'static', 'eth1', '12.10.1.1', 24),
	iface('LAN_WIRED', 'static', 'eth0', '12.10.10.1', 24),
	iface('WAN0', 'dhcp', 'eth2', '192.168.1.100', 24),
	iface('WAN1', 'dhcp', 'eth3', null, 0),
	iface('WAN2', 'dhcp', 'eth4', null, 0),
	iface('WAN3', 'dhcp', 'eth5', null, 0)
]);

// `default via 192.168.1.1 dev eth2`, as the kernel would answer it.
let said = layout.statements([ 'eth2' ]);
let result = layout.classify(wans.dump(bus), said);

check('the router was read', result.stated, true);
check('loopback is not an interface anybody binds', 'loopback' in keys(result.byName), false);
check('every other interface has a verdict', length(result.list), 6);

// ------------------------------------------------------------ the six verdicts
check('lan is a LAN', verdict(result, 'lan').role, 'lan');
check('LAN_WIRED is a LAN', verdict(result, 'LAN_WIRED').role, 'lan');
check('WAN0 is an uplink', verdict(result, 'WAN0').role, 'uplink');
check('WAN1 is an uplink', verdict(result, 'WAN1').role, 'uplink');
check('WAN2 is an uplink', verdict(result, 'WAN2').role, 'uplink');
check('WAN3 is an uplink', verdict(result, 'WAN3').role, 'uplink');

// ------------------------------------------------------------- and why it says so
let wired = verdict(result, 'LAN_WIRED');
says('LAN_WIRED hands out leases', told(wired.lanEvidence), /handing out DHCP leases/);
says('and is in a zone that does not masquerade', told(wired.lanEvidence), /which does not masquerade/);
// Still weighed, still said. A verdict that hid the fact arguing the other way
// would reach an operator looking unanimous, and the one line on their side -
// the line that used to win - would never be mentioned.
says('and its gateway is still reported', told(wired.uplinkEvidence), /gives it a default gateway/);
check('LAN_WIRED carries its own subnet', wired.cidr, '12.10.10.0/24');
check('and is in the lan zone', wired.zone, 'lan');
check('which does not masquerade', wired.zoneMasquerades, false);

let lan = verdict(result, 'lan');
says('lan delegates a prefix downstream', told(lan.lanEvidence), /option ip6assign/);
check('lan carries its own subnet', lan.cidr, '12.10.1.0/24');

let wan0 = verdict(result, 'WAN0');
says('WAN0 is the way out', told(wan0.uplinkEvidence), /default route leaves by it/);
says('and takes a lease on it', told(wan0.uplinkEvidence), /it runs dhcp/);
says('and masquerades', told(wan0.uplinkEvidence), /which masquerades/);
check('nothing argues WAN0 is a LAN', length(wan0.lanEvidence), 0);

// The other three are uplinks without the kernel naming them, which is what the
// two remaining decisive statements are for.
let wan1 = verdict(result, 'WAN1');
check('WAN1 does not claim a default route it does not carry',
	match(told(wan1.uplinkEvidence), /default route/) ? true : false, false);
says('it is an uplink because it takes a lease', told(wan1.uplinkEvidence), /^it runs dhcp/);

// ------------------------------------------------- the readings nothing settles
//
// Added after the six on purpose: they are shapes this router does not have,
// and the answers above are the answers to the router as it really is.

// A downstream router wired as a LAN: it takes a lease on that wire and hands
// them out on it. Two decisive statements pointing opposite ways, and the
// honest answer is to say so.
uci.set('network', 'downstream', 'interface');
uci.set('network', 'downstream', 'proto', 'dhcp');
uci.set('network', 'downstream', 'device', 'eth6');
uci.set('dhcp', 'downstream', 'dhcp');
uci.set('dhcp', 'downstream', 'interface', 'downstream');
uci.set('dhcp', 'downstream', 'limit', '50');

// Nothing states anything about it at all.
uci.set('network', 'mystery', 'interface');
uci.set('network', 'mystery', 'proto', 'static');
uci.set('network', 'mystery', 'device', 'eth7');

// A gateway and a quiet zone, and nothing decisive either way: the tie-breakers
// are all that is left, and 2 beats 1.
uci.set('network', 'dmz', 'interface');
uci.set('network', 'dmz', 'proto', 'static');
uci.set('network', 'dmz', 'device', 'eth8');
uci.set('network', 'dmz', 'gateway', '10.9.9.1');
uci.set('firewall', 'dmzzone', 'zone');
uci.set('firewall', 'dmzzone', 'name', 'dmz');
// Placed by device rather than by network, which is the other spelling fw4
// honours and the one LuCI never writes.
uci.set('firewall', 'dmzzone', 'device', [ 'eth8' ]);

let more = busFor([
	iface('lan', 'static', 'eth1', '12.10.1.1', 24),
	iface('LAN_WIRED', 'static', 'eth0', '12.10.10.1', 24),
	iface('downstream', 'dhcp', 'eth6', '10.5.5.2', 24),
	iface('mystery', 'static', 'eth7', '10.6.6.1', 24),
	iface('dmz', 'static', 'eth8', '10.9.9.2', 24)
]);

let second = layout.classify(wans.dump(more), layout.statements([ 'eth2' ]));

check('a downstream router is not resolved by arithmetic', verdict(second, 'downstream').role, 'unclear');
says('and says it takes a lease', told(verdict(second, 'downstream').uplinkEvidence), /it runs dhcp/);
says('and that it hands them out', told(verdict(second, 'downstream').lanEvidence), /handing out DHCP leases/);

check('an interface nothing describes is unclear', verdict(second, 'mystery').role, 'unclear');
check('and has nothing to say for it', length(verdict(second, 'mystery').lanEvidence), 0);
check('nor against it', length(verdict(second, 'mystery').uplinkEvidence), 0);

check('a gateway outweighs a quiet zone when nothing decisive speaks', verdict(second, 'dmz').role, 'uplink');
check('the zone found by device', verdict(second, 'dmz').zone, 'dmz');
says('and the quiet zone is still said', told(verdict(second, 'dmz').lanEvidence), /which does not masquerade/);
check('the LANs are unaffected by any of it', verdict(second, 'LAN_WIRED').role, 'lan');

// --------------------------------------------- and with no answer from netlink
//
// read() asks the kernel itself, and there is no kernel here: the rtnl stub
// answers nothing, so this is a router whose route dump failed. The point is
// that the verdicts do not move. If they ever depend on netlink, a busy socket
// becomes a refused binding.
let blind = layout.read(bus);

check('netifd answered, so there is a layout', type(blind), 'object');
check('LAN_WIRED is still a LAN with no route to read', verdict(blind, 'LAN_WIRED').role, 'lan');
check('lan is still a LAN', verdict(blind, 'lan').role, 'lan');
check('WAN0 is still an uplink', verdict(blind, 'WAN0').role, 'uplink');
says('but no longer claims the default route', told(verdict(blind, 'WAN0').uplinkEvidence), /^it runs dhcp/);

// Nothing to ask means nothing to say, which is not the same as an empty router.
check('a dump that failed is no layout at all', layout.read(null), null);

// The statements a surface reads back.
check('the kernel answer is carried', join(',', said.routeDevices), 'eth2');

// ------------------------------------------------- and read off a real dump

// The shape ucode's rtnl really answers with, copied off an OpenWrt 25.12
// router: the device is `oif`, the table is an int, and a default carries no
// `dst`. Asserted because reading the wrong key here costs nothing anybody
// notices - every router whose uplink dials or takes a lease is settled by its
// protocol - and takes away the only statement that settles a static one.
rtnl.setRoutes([
	{ family: 2, type: 1, oif: 'eth2', gateway: '192.168.1.1', priority: 0, table: 254 },
	{ family: 2, type: 1, oif: 'pppoe-f01', gateway: '100.123.0.150', priority: 10001, table: 10001 },
	{ family: 2, type: 1, oif: 'eth9', dst: '10.0.0.0', dst_len: 8, table: 254 }
]);

let fromKernel = layout.defaultRouteDevices();
check('the default route is read off the kernel dump', join(',', fromKernel), 'eth2');
check('a route in another table is not one', !('pppoe-f01' in fromKernel), true);
check('and neither is a route with a destination', !('eth9' in fromKernel), true);

rtnl.setRoutes(null);
check('no dump is no devices, not a crash', length(layout.defaultRouteDevices()), 0);
check('the router masquerades somewhere', said.anyMasquerade, true);
check('dhcp serves the wired LAN', said.dhcp.LAN_WIRED, 'serving');
check('the gateway was seen', said.gateway.LAN_WIRED, true);

// The evidence is joined into one sentence wherever it is shown.
check('one clause', layout.clauses([ 'a' ]), 'a');
check('two clauses', layout.clauses([ 'a', 'b' ]), 'a and b');
check('three clauses', layout.clauses([ 'a', 'b', 'c' ]), 'a, b and c');
check('no clauses', layout.clauses([]), '');

report();
