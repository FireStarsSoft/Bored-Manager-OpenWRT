// What this router says each of its own interfaces is, and every sentence
// behind the answer.
//
// The daemon needs this because the bindings are the router's now. An instance
// is reconciled at boot and on every netifd event with nothing attached over
// SSH, so "is this interface a LAN, or the way out" has to be answerable here,
// by the package, rather than handed down by whoever happens to have the app
// open. A binding that stops working when the module is uninstalled was the
// thing the move onto the router was for.
//
// The rule is the module's, ported rather than copied: openwrt/main/direct/
// layout.ts weighs the same statements, in the same order, and words the
// evidence the same way. Both halves reach the same operator - one through the
// app, one through LuCI and `bmwan` - and two different answers about one
// interface would be worse than either answer on its own.
//
// Three statements decide, and no tie-breaker may overturn one of them:
//
//   * a `config dhcp` section actually serving an interface settles it as a
//     LAN. A router does not run a DHCP server on the interface its own address
//     came from; the stock `config dhcp 'wan'` exists precisely to switch
//     itself off with `option ignore`.
//   * carrying the main table's default route settles it as an uplink. An
//     uplink is the interface everything else leaves by - that is what the word
//     means - and this is the only statement here that is not an inference: the
//     kernel is asked over netlink and answers outright.
//   * `proto pppoe` or `proto dhcp` settles it as an uplink. A router that
//     dials, or takes a lease, on an interface is a *client* of what is beyond
//     it, and a router is not a client of its own LAN.
//
// Two decisive statements pointing opposite ways is a real router - an
// interface that both takes a lease and hands them out is a downstream router
// wired as a LAN - and the answer to it is `unclear`, said out loud rather than
// settled by arithmetic.
//
// Everything else is a tie-breaker, and `option gateway` is the reason this
// file exists. It used to weigh as heavily as anything else, and on a real
// router - LANs on 12.10.x, a second box on the wired LAN, so `option gateway`
// sitting on an interface that hands out 250 leases - that one line had the LAN
// called an uplink and every address on it refused with a sentence about a
// router the operator does not have. Any interface may carry a gateway. It is
// not a statement about which side of the router the interface is on.
//
// And nothing here reads the address itself. That site runs its LANs on
// 12.10.x, which is public space; squatted ranges, real allocations and CGNAT
// are all ordinary, and a LAN holding one is still a LAN. Do not add a reading
// of the address.

import { cursor } from 'uci';
import * as rtnl from 'rtnl';

import { debug } from 'bm.log';

import * as wans from 'bm.wanbind.wans';

// `const` is a keyword, so this cannot be destructured in an import - which is
// why netlink.uc in this package spells it the same way.
/**
 * The kernel's own names for what is being asked.
 *
 * `?? {}` because the CI stub cannot supply them: `const` is a ucode keyword,
 * so `export const const` is not a thing anybody can write, and a stub reaching
 * this line handed the file a null. Every lookup below then raised, the catch in
 * `defaultRouteDevices` swallowed it, and the probe could not tell "this router
 * has no default route" from "this code cannot read one" - which is exactly the
 * gap the wrong key hid in for as long as it existed. Empty here means the
 * request goes out with undefined numbers, which only ever happens under a stub
 * that is going to answer with a written-down dump anyway.
 */
const C = rtnl.const ?? {};

// The two protocols that settle an interface on their own.
const CLIENT_PROTOS = [ 'pppoe', 'dhcp' ];

/**
 * The dnsmasq options only a section that really hands out leases carries.
 *
 * `option ignore` is read first and settles most routers by itself. These three
 * are the second reading, and they are deliberately the same three the module
 * weighs: this half can see the whole of /etc/config/dhcp and the module's half
 * sees a filtered dump of it, so a longer list here would be a router the two
 * halves describe differently, which is the one failure worth more than a
 * slightly weaker reading.
 */
const SERVING_OPTIONS = [ 'limit', 'ra', 'dhcpv6' ];

/**
 * How much each statement counts for.
 *
 * Small numbers on purpose. None of them decides an interface, which is the
 * whole correction being made here: a router is described by several weak facts
 * agreeing with each other, and the one strong-looking fact this used to rest
 * on turned out not to be a fact at all.
 */
const WEIGHT = {
	// A dnsmasq section that names it without switching itself off.
	namedByDhcp: 1,
	// The only dnsmasq section naming it sets `option ignore`, as a WAN's does.
	dhcpSwitchedOff: 1,
	// `option ip6assign`, which delegates a prefix downstream - only a LAN does.
	delegatesPrefix: 1,
	// A firewall zone that does not masquerade on a router where another does.
	quietZone: 1,
	// `option gateway`, which any interface may carry.
	gateway: 2,
	// A firewall zone that masquerades, which is what a WAN zone is for.
	masquerades: 2
};

/** Past every weight added together, for the statements that admit no argument. */
const DECISIVE = 100;

/** Strongest LAN statement first, because two sections can name one network. */
const DHCP_RANK = { serving: 2, named: 1, ignored: 0 };

/**
 * Zone names reach sentences a person reads, and they come off the router.
 * Anything outside this is described rather than quoted.
 */
const ZONE_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * RT_TABLE_MAIN, written out.
 *
 * It is the table `ip route list table main` means and the one the kernel has
 * answered to that number for as long as there have been routing tables. Taken
 * from `rtnl.const` it would be one more name that has to exist in a module
 * this file cannot check, on a code path that is already the fallible one.
 */
const MAIN_TABLE = 254;

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
}

/** Whether UCI says anything here at all - presence, not truth. */
function present(value) {
	if (type(value) == 'int')
		return true;

	return length(text(value)) > 0;
}

/** UCI has no booleans, and every one of these means the same thing. */
function truth(value) {
	let one = lc(text(value));

	if (!length(one))
		return false;

	return !(one in [ '0', 'no', 'off', 'false', 'disabled' ]);
}

/**
 * A UCI membership list, however it was written.
 *
 * `list network 'lan'` twice arrives as an array; `option network 'lan guest'`
 * arrives as one string holding both names, and fw4 splits that on whitespace.
 * A router written the second way is configured correctly, and comparing the
 * whole value to an interface name told such a router its LAN was in no zone at
 * all.
 */
function words(value) {
	let out = [];
	let items = type(value) == 'array' ? value : [ value ];

	for (let one in items) {
		for (let word in split(text(one), /[[:space:]]+/)) {
			if (length(word) && !(word in out))
				push(out, word);
		}
	}

	return out;
}

function objectOr(value) {
	return type(value) == 'object' ? value : {};
}

function arrayOr(value) {
	return type(value) == 'array' ? value : [];
}

/** "a", "a and b", "a, b and c" - evidence read as one sentence. */
export function clauses(parts) {
	let list = arrayOr(parts);

	if (length(list) < 2)
		return length(list) ? '' + list[0] : '';

	let head = [];
	for (let i = 0; i < length(list) - 1; i++)
		push(head, list[i]);

	return join(', ', head) + ' and ' + list[length(list) - 1];
};

/**
 * Whether a zone's `list device` entry claims this netdev.
 *
 * A trailing `*` and a trailing `+` are both honoured, and a leading `!` is the
 * opposite of a claim: that is the shape routers actually carry, and a
 * half-understood pattern matching too much would put an interface into a zone
 * it is not in.
 *
 * `+` is fw4's own spelling - it rewrites a trailing `+` to `*` when it renders
 * the ruleset - and it is what bm-pppoe-pool writes, one `pppoe-<prefix>+` per
 * pool instead of one `list network` entry per session. Without it here, every
 * WAN in a pool read as being in no firewall zone, and a binding onto one was
 * refused for a reason that was not true.
 */
function deviceMatches(entry, device) {
	if (!length(entry) || substr(entry, 0, 1) == '!')
		return false;

	let last = substr(entry, length(entry) - 1, 1);

	if (last == '*' || last == '+') {
		let prefix = substr(entry, 0, length(entry) - 1);
		return length(prefix) > 0 && substr(device, 0, length(prefix)) == prefix;
	}

	return entry == device;
}

/** The netdevs an interface answers to, in the order a zone is likely to name them. */
function devicesOf(iface) {
	let out = [];

	for (let one in [ text(iface.device), text(iface.l3Device) ]) {
		if (length(one) && !(one in out))
			push(out, one);
	}

	return out;
}

/**
 * The firewall zone an interface sits in, by the name that zone answers to.
 *
 * A zone states its membership either way and fw4 honours both: `list network`
 * names logical interfaces, `list device` names the netdevs themselves. LuCI
 * writes the first, so the first answers first - it is a statement about *this*
 * interface rather than about the wire underneath it - and the device pass is
 * what stops a LAN on a VLAN or a plain port reading as being in no zone at
 * all, which would cost this file both of its zone readings at once.
 */
function zoneFor(said, name, devices) {
	for (let zone in said.zones) {
		if (name in zone.networks)
			return zone.name;
	}

	for (let zone in said.zones) {
		for (let entry in zone.devices) {
			for (let device in devices) {
				if (deviceMatches(entry, device))
					return zone.name;
			}
		}
	}

	return '';
}

function zonePhrase(zone) {
	return match(zone, ZONE_NAME) ? ('zone ' + zone) : 'a firewall zone with an unsupported name';
}

/** The device name off one route or one of its nexthops, or ''. */
function deviceOf(entry) {
	// `oif` first, because that is the key ucode's rtnl module actually answers
	// with - checked against a real router, whose main-table default comes back
	// as { oif: "eth2", gateway: "192.168.1.1", table: 254 }. Reading only
	// `dev`/`device` collected nothing at all, which left the one statement here
	// that is not an inference silently dead: the classifier still settled every
	// router whose uplink runs pppoe or dhcp, and had nothing whatsoever to say
	// about the static uplink this signal exists for.
	for (let key in [ 'oif', 'dev', 'device' ]) {
		let name = text(entry[key]);
		if (length(name))
			return name;
	}

	return '';
}

/** Whether this route is the one everything with nowhere better to go takes. */
function isDefault(entry) {
	if (type(entry.dst_len) == 'int' && entry.dst_len != 0)
		return false;

	if (entry.dst == null)
		return true;

	let dst = text(entry.dst);

	return !length(dst) || dst == 'default' || dst == '0.0.0.0' || dst == '0.0.0.0/0';
}

/**
 * The netdevs the router's main table currently sends everything else out of.
 *
 * Asked of the kernel over netlink, which is the point: every other reading in
 * this file is a guess at this fact from the shape of /etc/config, and each of
 * those guesses has by now been wrong on somebody's router. Not asked of netifd
 * - unlike every other question this package puts to it - because netifd knows
 * the routes netifd installed, and the kernel's main table is the sum of those
 * and everything else, which is what traffic actually follows.
 *
 * Devices rather than logical interfaces, because netlink speaks netdevs; the
 * caller matches them against `device` and `l3Device`. Several are possible and
 * all of them count: a load-balanced default has one nexthop per line.
 *
 * An empty list on failure rather than null, and deliberately so. This is a
 * tie-breaker's worth of silence, not an instruction to change nothing: the two
 * other decisive statements still settle every interface a stock router has,
 * and a classifier that refused to answer because netlink was busy would take
 * the create gate down with it.
 */
export function defaultRouteDevices() {
	let dump;

	try {
		dump = rtnl.request(C.RTM_GETROUTE, C.NLM_F_DUMP, { family: C.AF_INET });
	}
	catch (e) {
		debug('cannot read the router\'s routes: ' + e);
		return [];
	}

	if (type(dump) != 'array') {
		debug('the route dump gave nothing usable');
		return [];
	}

	let out = [];

	for (let one in dump) {
		if (type(one) != 'object')
			continue;

		// A route the kernel put in another table is another table's business:
		// this package's own catch-all tables hold an `unreachable default`, and
		// counting that as a statement about direction would make every bound
		// client's line look like the router's uplink.
		if (type(one.table) == 'int' && one.table != MAIN_TABLE)
			continue;

		if (!isDefault(one))
			continue;

		// No reading of the route type is needed: a blackhole or unreachable
		// default names no device, so it contributes nothing here on its own.
		let name = deviceOf(one);
		if (length(name) && !(name in out))
			push(out, name);

		if (type(one.multipath) != 'array')
			continue;

		for (let hop in one.multipath) {
			if (type(hop) != 'object')
				continue;

			let via = deviceOf(hop);
			if (length(via) && !(via in out))
				push(out, via);
		}
	}

	return out;
};

/**
 * Everything /etc/config and the kernel state about direction, read once.
 *
 * Read whole rather than per interface, because the two zone readings are
 * questions about the router - "does anything on this router masquerade" is
 * what makes a quiet zone mean anything at all - and asking them again for
 * every interface would answer them differently as the file changed underneath
 * a pass.
 *
 * `routeDevices` may be passed in by a caller that has already asked the
 * kernel, and is asked for here when it is not. The probe passes it: netlink is
 * the one fact in here that cannot be written down in a fixture, and the router
 * that started all of this is worth being able to replay.
 */
export function statements(routeDevices) {
	let said = {
		zones: [],
		masquerading: {},
		anyMasquerade: false,
		dhcp: {},
		gateway: {},
		ip6assign: {},
		routeDevices: type(routeDevices) == 'array' ? routeDevices : defaultRouteDevices(),
		read: false
	};

	let uci;

	try {
		uci = cursor();
	}
	catch (e) {
		debug('cannot read /etc/config: ' + e);
		return said;
	}

	if (!uci)
		return said;

	// Said before the files are walked, and true even for a router whose
	// /etc/config/dhcp is empty. It is the difference between "the router says
	// nothing about this interface" and "nobody asked the router" - two answers
	// a surface has to word differently, because only one of them is something
	// an operator can go and fix.
	said.read = true;

	try {
		uci.foreach('network', 'interface', (section) => {
			let name = text(section['.name']);
			if (!length(name))
				return;

			if (present(section.gateway))
				said.gateway[name] = true;

			if (present(section.ip6assign))
				said.ip6assign[name] = true;
		});
	}
	catch (e) {
		debug('cannot read /etc/config/network: ' + e);
	}

	try {
		uci.foreach('dhcp', 'dhcp', (section) => {
			// `option interface` is what a section is really about; the section
			// name is the fallback, because a hand-written `config dhcp 'guest'`
			// sometimes leaves the option out and means itself.
			let name = text(section.interface);
			if (!length(name))
				name = text(section['.name']);
			if (!length(name))
				return;

			let serving = false;
			for (let option in SERVING_OPTIONS) {
				let value = text(section[option]);
				if (type(section[option]) == 'int')
					value = sprintf('%d', section[option]);

				if (length(value) && value != '0' && value != 'disabled')
					serving = true;
			}

			let statement = truth(section.ignore) ? 'ignored' : (serving ? 'serving' : 'named');

			// A second section for one network can only ever add service, so the
			// strongest statement wins: one that ignores the network cannot take
			// back what another one hands out.
			let before = said.dhcp[name];
			if (before != null && DHCP_RANK[before] >= DHCP_RANK[statement])
				return;

			said.dhcp[name] = statement;
		});
	}
	catch (e) {
		debug('cannot read /etc/config/dhcp: ' + e);
	}

	try {
		uci.foreach('firewall', 'zone', (section) => {
			let name = text(section.name);
			if (!length(name))
				name = text(section['.name']);
			if (!length(name))
				return;

			let masq = truth(section.masq);

			// Sections in file order, so the zone an interface is placed in is the
			// first one that claims it - but masquerading is answered by name, and
			// two sections can only share a name by mistake. The safe reading of
			// that mistake is that a name any copy of which masquerades
			// masquerades.
			push(said.zones, {
				name: name,
				networks: words(section.network),
				devices: words(section.device)
			});

			said.masquerading[name] = (said.masquerading[name] === true) || masq;

			if (masq)
				said.anyMasquerade = true;
		});
	}
	catch (e) {
		debug('cannot read /etc/config/firewall: ' + e);
	}

	return said;
};

/** One interface weighed against one reading of the router. */
function weigh(iface, said) {
	let lanEvidence = [];
	let uplinkEvidence = [];
	let lanScore = 0;
	let uplinkScore = 0;

	let devices = devicesOf(iface);
	let zone = zoneFor(said, iface.name, devices);
	let zoneMasquerades = length(zone) > 0 && said.masquerading[zone] === true;

	if (iface.proto in CLIENT_PROTOS) {
		uplinkScore += DECISIVE;
		push(uplinkEvidence,
			'it runs ' + iface.proto + ', so this router is a client of the network on the other side of it');
	}

	let leaves = false;
	for (let device in devices) {
		if (device in said.routeDevices)
			leaves = true;
	}

	if (leaves) {
		uplinkScore += DECISIVE;
		push(uplinkEvidence, 'the router\'s default route leaves by it');
	}

	if (said.gateway[iface.name] === true) {
		uplinkScore += WEIGHT.gateway;
		push(uplinkEvidence, '/etc/config/network gives it a default gateway');
	}

	if (zoneMasquerades) {
		uplinkScore += WEIGHT.masquerades;
		push(uplinkEvidence, 'it is in ' + zonePhrase(zone) + ', which masquerades');
	}

	let dhcp = said.dhcp[iface.name];

	if (dhcp == 'serving') {
		lanScore += DECISIVE;
		push(lanEvidence, '/etc/config/dhcp has it handing out DHCP leases');
	}
	else if (dhcp == 'named') {
		lanScore += WEIGHT.namedByDhcp;
		push(lanEvidence, 'a section in /etc/config/dhcp names it and does not switch itself off');
	}
	else if (dhcp == 'ignored') {
		uplinkScore += WEIGHT.dhcpSwitchedOff;
		push(uplinkEvidence, 'the only section in /etc/config/dhcp naming it sets option ignore');
	}

	if (said.ip6assign[iface.name] === true) {
		lanScore += WEIGHT.delegatesPrefix;
		push(lanEvidence, 'it delegates an IPv6 prefix downstream (option ip6assign)');
	}

	if (length(zone) > 0 && !zoneMasquerades && said.anyMasquerade) {
		lanScore += WEIGHT.quietZone;
		push(lanEvidence,
			'it is in ' + zonePhrase(zone) + ', which does not masquerade while another zone on this router does');
	}

	// Comparing the sums alone would let one decisive fact plus a tie-breaker
	// quietly outvote the other decisive fact, which is the arithmetic this
	// whole file is a correction to.
	let role = 'unclear';

	if (uplinkScore >= DECISIVE && lanScore >= DECISIVE)
		role = 'unclear';
	else if (uplinkScore > lanScore)
		role = 'uplink';
	else if (lanScore > uplinkScore)
		role = 'lan';

	return {
		name: iface.name,
		role: role,
		cidr: iface.ipv4 ? (wans.network(iface.ipv4.addr, iface.ipv4.mask) || '') : '',
		device: text(iface.l3Device) || text(iface.device),
		zone: zone,
		zoneMasquerades: zoneMasquerades,
		lanEvidence: lanEvidence,
		uplinkEvidence: uplinkEvidence
	};
}

/**
 * Weigh every interface in one sample against one reading of the router.
 *
 * Pure, and the statements are passed in rather than fetched, so the whole of
 * this decision can be replayed against a router written down in a probe - the
 * only way the class of mistake being fixed here stays fixed.
 */
export function classify(ifaces, stated) {
	let raw = objectOr(stated);
	let said = {
		zones: arrayOr(raw.zones),
		masquerading: objectOr(raw.masquerading),
		anyMasquerade: raw.anyMasquerade === true,
		dhcp: objectOr(raw.dhcp),
		gateway: objectOr(raw.gateway),
		ip6assign: objectOr(raw.ip6assign),
		routeDevices: arrayOr(raw.routeDevices),
		read: raw.read === true
	};

	let out = { byName: {}, list: [], stated: said.read };

	for (let one in arrayOr(ifaces)) {
		if (type(one) != 'object')
			continue;

		let name = text(one.name);
		if (!length(name) || name == 'loopback')
			continue;

		let verdict = weigh(one, said);
		out.byName[name] = verdict;
		push(out.list, verdict);
	}

	return out;
};

/**
 * The whole answer: what netifd has, weighed against what the router says.
 *
 * Null when netifd could not be asked, which is the rule the rest of this
 * package already follows - no answer means change nothing. An empty answer
 * would say this router has no interfaces, and every caller here would act on
 * that: the create gate would refuse every address on the router, and the
 * reconciler would read every binding as pointing at an interface that is gone.
 */
export function read(bus) {
	let ifaces = wans.dump(bus);

	if (ifaces === null)
		return null;

	return classify(ifaces, statements());
};
