// The scale rig itself, before anything is measured with it.
//
// Every other assertion in this file's future - one cursor per operation, one
// netifd dump per pass, one firewall commit for five hundred bindings - is a
// number produced by the fixtures and counters in `lib/scale.uc`, `lib/uci.uc`,
// `lib/uloop.uc` and `stubs/rtnl.uc`. A counter that does not count, or a
// fixture that quietly builds four hundred and ninety-nine of something, would
// make every one of those assertions agree with a daemon that was wrong.
//
// So this block measures the instruments. It is the only part of the scale work
// that asserts about the probe library rather than about the router.

import { cursor } from 'uci';

import * as rtnl from 'rtnl';
import * as scale from 'scale';
import * as uloop from 'uloop';
import * as uciLib from 'uci';

import { check, report } from 'probe';

let uci = cursor();

// ------------------------------------------------------ the router fixture

let router = scale.router(4, 500);

check('interfaces in the dump', length(router), 504);
check('the first is a LAN', router[0].interface, 'lan');
check('the fifth is the first session', router[4].interface, 'p001');
check('the last is the five hundredth', router[503].interface, 'p500');
check('sessions carry a routing table', router[503].ip4table, '10500');
check('and a device netifd would name', router[503].l3_device, 'pppoe-p500');
check('dialled over a VLAN of the carrier', router[503].device, 'eth1.600');
check('addresses do not repeat', scale.wanAddress(500), '100.70.1.244');

// A LAN has no routing table of its own, so netifd writes it no rules. Three
// per session and none per LAN is the arithmetic every rule-count assertion
// downstream rests on.
let netifd = scale.netifdRules(router);

check('rules netifd wrote', length(netifd), 1500);
check('the first is the session address', netifd[0].src, '100.70.0.1/32');
check('the second is traffic to it', netifd[1].dst, '100.70.0.1/32');
check('the third carries no selector at all', netifd[2].src ?? '', '');
check('and all three name one table', netifd[2].table, 10001);

// ------------------------------------------------------- the file fixtures

let ids = scale.manualSections(uci, 500, 19000, 500);

check('bindings written', length(ids), 500);
check('the first is numbered from the base', uci.get('bm_wanbind', 'bmdir_000', 'pref'), '19000');
check('and follows an address', uci.get('bm_wanbind', 'bmdir_000', 'ip'), '10.9.0.10');
check('every fourth follows a MAC', uci.get('bm_wanbind', 'bmdir_003', 'mac'), '02:00:00:00:03:01');
check('which has no address', uci.get('bm_wanbind', 'bmdir_003', 'ip'), null);
check('the last is the five hundredth number', uci.get('bm_wanbind', 'bmdir_499', 'pref'), '19499');
check('sections are bindings', uci.get('bm_wanbind', 'bmdir_499'), 'direct');
check('clients spread over the four LANs', uci.get('bm_wanbind', 'bmdir_001', 'ip'), '10.9.1.10');

let leases = scale.leases(500);

check('lease rows', length(split(leases, '\n')), 501);
check('in the format dnsmasq writes', split(split(leases, '\n')[0], ' ')[2], '10.9.0.10');

// -------------------------------------------------------------- the clocks

uloop.resetTimers();

let fired = 0;
let one = uloop.timer(2000, () => { fired++; });

check('a timer waits', uloop.pending(), 1);
check('and says how long for', one.remaining(), 2000);
check('an hour before it is due, nothing', uloop.advance(1999), 0);
check('at its moment, once', uloop.advance(1), 1);
check('and it is no longer waiting', uloop.pending(), 0);
check('the callback ran', fired, 1);
check('a fired timer is not due again', uloop.advance(100000), 0);

// The reconcile timer re-arms itself from inside its own callback, so a clock
// that armed the next one against the end of the window rather than against the
// moment the timer was due would drift a whole interval per advance - and the
// probe that counts passes over an hour would count the wrong number and pass.
uloop.resetTimers();

let passes = 0;
let repeating = null;

repeating = uloop.timer(30000, () => {
	passes++;
	repeating.set(30000);
});

check('a re-arming timer over five minutes', uloop.advance(300000), 10);
check('ran ten times', passes, 10);
check('and is still waiting', uloop.pending(), 1);
check('the clock reached the end of the window', uloop.now(), 300000);

repeating.cancel();
check('a cancelled timer waits for nothing', repeating.remaining(), -1);
check('and never fires again', uloop.advance(300000), 0);

// ----------------------------------------------------------- the counters

uciLib.resetCounters();
check('no cursor has been opened since', uciLib.opened(), 0);

let fresh = cursor();
check('opening one is counted', uciLib.opened(), 1);

fresh.set('bm_scratch', 'a', 'thing');
fresh.commit('bm_scratch');
fresh.commit('bm_scratch');
check('commits are counted per package', uciLib.commits('bm_scratch'), 2);
check('and a package nobody wrote has none', uciLib.commits('bm_other'), 0);

fresh.foreach('bm_scratch', 'thing', (section) => { return true; });
check('walks are counted per type', uciLib.foreachCount('bm_scratch', 'thing'), 1);
check('a type nobody walked has none', uciLib.foreachCount('bm_scratch', 'other'), 0);

uciLib.resetCounters();
check('and the counters start again', uciLib.commits('bm_scratch'), 0);

// ------------------------------------------------------------ the kernel

rtnl.setRules([]);
rtnl.resetRuleDumps();

// Two escape rules, no source between them, different destinations. Keyed on
// source alone they are one rule: the second add finds the first, answers
// EEXIST, and a daemon that wrote four rules for four LANs holds one.
rtnl.request(rtnl.const.RTM_NEWRULE, rtnl.const.NLM_F_CREATE | rtnl.const.NLM_F_EXCL,
	{ family: 2, priority: 18000, dst: '10.9.0.0/24', table: 254, action: 1 });
rtnl.request(rtnl.const.RTM_NEWRULE, rtnl.const.NLM_F_CREATE | rtnl.const.NLM_F_EXCL,
	{ family: 2, priority: 18001, dst: '10.9.1.0/24', table: 254, action: 1 });

check('both destination rules are held', length(rtnl.kernelRules()), 2);
check('and the second was not refused', rtnl.error(), null);
check('the destination came back', rtnl.kernelRules()[1].dst, '10.9.1.0/24');

// A delete naming a destination has to miss a rule carrying a different one, or
// a flush sweeping a band by priority and a delete aimed at one escape rule
// would be the same call.
rtnl.request(rtnl.const.RTM_DELRULE, 0,
	{ family: 2, priority: 18000, dst: '10.9.9.0/24', table: 254, action: 1 });
check('a delete with the wrong destination removes nothing', length(rtnl.kernelRules()), 2);

rtnl.request(rtnl.const.RTM_DELRULE, 0,
	{ family: 2, priority: 18000, dst: '10.9.0.0/24', table: 254, action: 1 });
check('the right one removes exactly it', length(rtnl.kernelRules()), 1);
check('and leaves the other', rtnl.kernelRules()[0].dst, '10.9.1.0/24');

check('dumps are counted', rtnl.ruleDumps(), 0);
rtnl.request(rtnl.const.RTM_GETRULE, rtnl.const.NLM_F_DUMP, { family: 2 });
rtnl.request(rtnl.const.RTM_GETRULE, rtnl.const.NLM_F_DUMP, { family: 2 });
check('once each', rtnl.ruleDumps(), 2);

// ---------------------------------------------------------------- the bus

scale.resetBusCounts();

let bus = scale.busFor(router, {});

check('a dump answers every interface', length(bus.call('network.interface', 'dump', {}).interface), 504);
check('a status answers one', bus.call('network.interface.p017', 'status', {}).interface, 'p017');
check('an interface that is not there answers nothing', bus.call('network.interface.p999', 'status', {}), null);
check('dumps counted', scale.busCounts().dump, 1);
check('statuses counted', scale.busCounts().status, 2);
check('reloads counted', scale.busCounts().reload, 0);

let blind = scale.busFor(router, { dumpNull: true });
check('a netifd that will not answer says so', blind.call('network.interface', 'dump', {}), null);
check('and being asked still counts', scale.busCounts().dump, 2);

report();
