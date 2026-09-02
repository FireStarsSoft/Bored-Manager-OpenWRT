// Every rule on the router, and whose it is.
//
// The monitor exists because the fast sweep only ever filtered the rule table
// down to this package's own priority window - so a rule somebody else wrote
// could steer every packet on the router and appear on no surface at all. What
// it produces is a verdict and a sentence per rule, and both are worth testing
// for the same reason: a wrong verdict here does not break anything, it sends
// somebody to a console to delete a rule that was doing its job, or leaves them
// looking for a fault in the one place there is not one.
//
// The router below is the shape that made half of these cases obvious: 32 PPPoE
// sessions, each with a routing table of its own. netifd writes three rules per
// such interface without anybody asking, which is 96 rules, and a monitor that
// called them all strangers would bury the handful worth reading under a page
// of alarm about the router routing itself.

import { cursor } from 'uci';
import * as rtnl from 'rtnl';

import * as monitor from 'bm.wanbind.monitor';

import { check, report, says } from 'probe';

let uci = cursor();

// ------------------------------------------------------------------ the router

// Two uplinks and four PPPoE sessions, each with its own table, plus a LAN.
// Small enough to write out and large enough to have one of everything.
let interfaces = [
	{ name: 'lan', device: 'br-lan', l3Device: 'br-lan', table: null, ipv4: { addr: '10.9.0.1', mask: 24 } },
	{ name: 'WAN0', device: 'eth1', l3Device: 'eth1', table: 10000, ipv4: { addr: '203.0.113.10', mask: 24 } },
	{ name: 'p01', device: 'pppoe-p01', l3Device: 'pppoe-p01', table: 10001, ipv4: { addr: '100.70.1.1', mask: 32 } },
	{ name: 'p02', device: 'pppoe-p02', l3Device: 'pppoe-p02', table: 10002, ipv4: { addr: '100.70.1.2', mask: 32 } }
];

// The kernel's own three, netifd's three per routed interface, and then the
// rules this package and other people write.
let ruleset = [
	{ priority: 0, table: 255, action: 1 },
	{ priority: 32766, table: 254, action: 1 },
	{ priority: 32767, table: 253, action: 1 },

	// netifd, for WAN0: source, destination, and locally-generated. The third
	// carries no selector this dump can read - `ip rule show` prints `iif lo`
	// and netlink answers with nothing at all, which is why it is written here
	// exactly as the kernel hands it back.
	{ priority: 10000, src: '203.0.113.10/32', table: 10000, action: 1 },
	{ priority: 20000, dst: '203.0.113.10/32', table: 10000, action: 1 },
	{ priority: 90000, table: 10000, action: 1 },

	// And for one PPPoE session.
	{ priority: 10001, src: '100.70.1.1/32', table: 10001, action: 1 },
	{ priority: 20001, dst: '100.70.1.1/32', table: 10001, action: 1 },
	{ priority: 90001, table: 10001, action: 1 },

	// A one-to-one binding this daemon holds a section for.
	{ priority: 19000, src: '10.9.0.50/32', table: 10001, action: 1 },
	// One in the band that nothing claims - a binding somebody deleted, or one
	// an older Bored Manager module wrote without ever writing a section.
	{ priority: 19005, src: '10.9.0.51/32', table: 10002, action: 1 },

	// An instance: one seated client and the fail-closed catch-all beneath it.
	{ priority: 20500, src: '10.9.0.80/32', table: 10002, action: 1 },
	{ priority: 30000, src: '10.9.0.0/24', table: 253, action: 1 },

	// Somebody else entirely, read before everything this daemon writes - and
	// pointing at a table that can actually answer, so it really does decide.
	{ priority: 5000, src: '10.9.0.99/32', table: 10002, action: 1 },
	// The same shape over a table with no default route. It has precedence and
	// no effect, which is a different sentence and a different thing to do
	// about it.
	{ priority: 5001, src: '10.9.0.98/32', table: 900, action: 1 }
];

rtnl.setRules(ruleset);
rtnl.setRulesReadable(true);

rtnl.setRoutes([
	// The router's own way out.
	{ family: 2, type: 1, oif: 'eth1', gateway: '203.0.113.1', table: 254 },
	{ family: 2, type: 1, oif: 'eth1', gateway: '203.0.113.1', table: 10000 },
	{ family: 2, type: 1, oif: 'pppoe-p01', gateway: '100.123.0.1', table: 10001 },
	{ family: 2, type: 1, oif: 'pppoe-p02', gateway: '100.123.0.2', table: 10002 },
	// The catch-all table: a blackholed default, which is a parked address.
	{ family: 2, type: 7, table: 253 },
	// Table 900 has no default at all, which is a different thing again.
	{ family: 2, type: 1, dst: '10.0.0.0/8', oif: 'eth1', table: 900 }
]);

// ---------------------------------------------------------------- the inputs

let instances = [
	{
		id: 'home', name: 'home', enabled: true, usable: true, reason: null,
		lan: 'lan', carrier: 'eth2', sticky: true, remap: true,
		rangeFrom: '', rangeTo: '', clientsPerWan: 1, slot: 0,
		rulePrefBase: 20000, catchAllPref: 30000, catchAllTable: 253,
		wanWarnUptime: 5, wanErrorGrace: 20, releaseGrace: 120
	}
];

let bindings = [
	{ id: 'desk', name: 'desk', enabled: true, usable: true, source: 'manual',
	  targetKind: 'ip', label: '10.9.0.50', ip: '10.9.0.50', wan: 'p01',
	  pref: 19000, table: 10001, state: 'bound', whenDown: 'hold' }
];

let assignments = [
	{ instance: 'home', mac: 'aa:bb:cc:00:00:01', ip: '10.9.0.80', host: 'desk2',
	  wan: 'p02', pref: 20500, table: 10002 }
];

function run(limit) {
	return monitor.report({
		limit: limit,
		band: { base: 19000, span: 1000, top: 19999, usable: true, reason: null },
		instances: instances,
		bindings: bindings,
		assignments: assignments,
		interfaces: interfaces
	});
};

let out = run(0);

function owners(result) {
	let counts = {};
	for (let one in result.rules)
		counts[one.owner] = (type(counts[one.owner]) == 'int' ? counts[one.owner] : 0) + 1;
	return counts;
};

function rowAt(result, pref) {
	for (let one in result.rules) {
		if (one.pref == pref)
			return one;
	}
	return null;
};

function tableAt(result, table) {
	for (let one in result.tables) {
		if (one.table == table)
			return one;
	}
	return null;
};

// ------------------------------------------------------------- the verdicts

check('every rule is read', out.ok, true);
check('and the read succeeded', out.read, true);
check('all of them', out.count, length(ruleset));
check('nothing was capped', out.capped, false);

let byOwner = owners(out);

check('the kernel keeps its own three', byOwner.kernel, 3);
check('netifd is credited with its six', byOwner.netifd, 6);
check('the two in the one-to-one band are read as hand-placed', byOwner.manual, 2);
check('the seated client is the instance', byOwner.client, 1);
check('so is the fence beneath it', byOwner['catch-all'], 1);
check('and two rules belong to nobody here', byOwner.foreign, 2);

check('the binding is named', rowAt(out, 19000).id, 'desk');
check('the client names its instance', rowAt(out, 20500).instance, 'home');
check('and the client is named too', rowAt(out, 20500).id, 'aa:bb:cc:00:00:01');
check('the catch-all names its instance', rowAt(out, 30000).instance, 'home');
check('and netifd rules name the interface', rowAt(out, 10001).id, 'p01');

// The third of netifd's three is the one worth pinning: `ip rule show` prints
// `iif lo` and the netlink dump carries no selector at all, so a reader that
// insisted on seeing the `iif` would call it a stranger's.
check('the rule with no readable selector is still netifd', rowAt(out, 90001).owner, 'netifd');
check('and it is not mistaken for a kernel rule', rowAt(out, 90001).owner != 'kernel', true);

// ------------------------------------------------------------- the selectors

check('a source rule reads as one', rowAt(out, 19000).selector, 'from 10.9.0.50/32');
check('a destination rule is not "everything"', rowAt(out, 20001).selector, 'to 100.70.1.1/32');
check('and a rule with nothing readable says so', rowAt(out, 90001).selector, 'everything');

// -------------------------------------------------------------- the sentences

says('a hand-placed binding is explained by name', rowAt(out, 19000).reason, /10.9.0.50/);
says('and says where its table leads', rowAt(out, 19000).reason, /pppoe-p01/);
says('and that it is decided before the main table', rowAt(out, 19000).reason, /before the main table/);

says('a binding nothing claims says the next pass removes it',
	rowAt(out, 19005).reason, /no binding section claims it/);

says('netifd rules are described as plumbing', rowAt(out, 10001).reason, /netifd wrote this/);
says('and named for the interface being routed', rowAt(out, 10001).reason, /p01/);

says('the kernel own three say they steer nothing', rowAt(out, 0).reason, /steers no address anywhere on its own/);

says('a foreign rule read first says it wins', rowAt(out, 5000).reason, /whatever any binding below claims/);
says('and admits nothing here claims it', rowAt(out, 5000).reason, /Nothing in this daemon/);
says('one over a table that cannot answer does not claim to win',
	rowAt(out, 5001).reason, /Nothing in this daemon/);
check('and is still nobody here', rowAt(out, 5001).owner, 'foreign');

// --------------------------------------------------------------- the tables

check('the main table is always described', tableAt(out, 254) != null, true);
check('and says where the router itself leaves by', tableAt(out, 254).device, 'eth1');
check('main is reported as such', out.main.device, 'eth1');
check('with its gateway', out.main.gateway, '203.0.113.1');

check('a WAN table leaves through its own device', tableAt(out, 10001).device, 'pppoe-p01');
check('and is marked as having a default', tableAt(out, 10001).hasDefault, true);
check('and not as unreachable', tableAt(out, 10001).unreachable, false);

// The three table states are three different facts, and a page that showed two
// of them the same way would say a parked address was working.
check('the catch-all table is unreachable', tableAt(out, 253).unreachable, true);
check('which is not the same as having a default', tableAt(out, 253).hasDefault, false);

check('a table with neither says so', tableAt(out, 900).hasDefault, false);
check('and is not called unreachable either', tableAt(out, 900).unreachable, false);

// ------------------------------------------------------------------ the caps

let few = run(3);

check('a capped read says how many there really are', few.count, length(ruleset));
check('and says it was capped', few.capped, true);
check('and returns only what was asked for', length(few.rules), 3);
// Sorted before capping, or the cap would drop exactly the rules that win.
check('keeping the ones the kernel reads first', few.rules[0].pref, 0);

// ------------------------------------------------- no answer is not an empty router

rtnl.setRulesReadable(false);

let blind = run(0);

check('a dump that failed is not a router with no rules', blind.read, false);
check('and is not reported as a success', blind.ok, false);
check('with nothing invented to fill it', length(blind.rules), 0);

rtnl.setRulesReadable(true);

report();
