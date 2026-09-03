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
import * as service from 'bm.wanbind.service';
import * as cfg from 'bm.wanbind.config';
import * as direct from 'bm.wanbind.direct';
import * as prepare from 'bm.wanbind.prepare';
import * as netlink from 'bm.wanbind.netlink';

import { check, report, says } from 'probe';

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

// ===========================================================================
// One read of the file per question asked of it.
//
// Every reader in `bm.wanbind.config` used to open its own cursor, and they
// call each other: the bindings need the band, the band needs the instances,
// and the instances are a second walk of the same file. At four instances that
// is invisible. At five hundred bindings it is the answer arriving late to a
// page that asks every five seconds.

uci.set('bm_wanbind', 'main', 'wanbind');
uci.set('bm_wanbind', 'main', 'interval', '30');
uci.set('bm_wanbind', 'main', 'direct_pref_base', '19000');

for (let i = 0; i < 4; i++) {
	let lan = scale.lanOf(i);
	let id = 'bmi_' + lan.name;

	uci.set('network', lan.name, 'interface');
	uci.set('network', lan.name, 'proto', 'static');
	uci.set('network', lan.name, 'device', lan.device);
	uci.set('network', lan.name, 'ipaddr', lan.address);

	uci.set('dhcp', lan.name, 'dhcp');
	uci.set('dhcp', lan.name, 'interface', lan.name);
	uci.set('dhcp', lan.name, 'limit', '200');

	uci.set('bm_wanbind', id, 'instance');
	uci.set('bm_wanbind', id, 'lan', lan.name);
	uci.set('bm_wanbind', id, 'carrier', 'eth1');
	uci.set('bm_wanbind', id, 'rule_pref_base', sprintf('%d', 20000 + i * 2000));
	uci.set('bm_wanbind', id, 'catch_all_pref', sprintf('%d', 21000 + i * 2000));
	uci.set('bm_wanbind', id, 'catch_all_table', sprintf('%d', 253 - i));
}

// The sessions as the pool daemon leaves them in /etc/config/network: a section
// each, carrying its own routing table. The preparation half reads that file
// rather than netifd, because what netifd is using now and what it will use
// after the next reload are different questions.
scale.networkSections(uci, 500);

// Two LAN zones and one WAN zone, so the bindings span two pairs. A forwarding
// is a pair of zones, so five hundred bindings across two of them is two
// sections - which is the whole of what this release changed about them.
uci.set('firewall', 'zone_lan', 'zone');
uci.set('firewall', 'zone_lan', 'name', 'lan');
uci.set('firewall', 'zone_lan', 'network', [ 'lan', 'LAN_WIRED' ]);

uci.set('firewall', 'zone_guest', 'zone');
uci.set('firewall', 'zone_guest', 'name', 'guest');
uci.set('firewall', 'zone_guest', 'network', [ 'guest', 'iot' ]);

let wanNetworks = [];
for (let i = 1; i <= 500; i++)
	push(wanNetworks, scale.wanName(i));

uci.set('firewall', 'zone_wan', 'zone');
uci.set('firewall', 'zone_wan', 'name', 'wan');
uci.set('firewall', 'zone_wan', 'network', wanNetworks);
uci.set('firewall', 'zone_wan', 'masq', '1');

rtnl.setRules(scale.kernelRules());
rtnl.setRoutes([ { family: 2, type: 1, oif: 'pppoe-p001', gateway: '100.70.0.1', table: 254 } ]);

service.attach(scale.busFor(router, {}));
let ran = [];
service.attachSystem((command, timeout) => { push(ran, command); return 0; });
service.load();

// What the readers cost when nothing is shared between them, which is what
// every verb used to do: three questions about one file, three walks of it.
uciLib.resetCounters();
cfg.main();
cfg.directBand();
cfg.directConfigured();
check('three unshared readers open three cursors', uciLib.opened(), 3);

// And what one snapshot costs, which is the same three answers.
uciLib.resetCounters();
let shared = cfg.snapshot();
cfg.main(shared);
cfg.directBand(shared);
cfg.directConfigured(shared);
check('one snapshot answers all three', uciLib.opened(), 1);
check('and it read the file', length(cfg.directConfigured(shared)), 500);

// `info` is the call every surface makes first. It used to cost five: the main
// section, the band, the instances, the seven create-time defaults out of a
// cursor of their own, and the bindings.
uciLib.resetCounters();
let facts = service.info();
check('info() reads the file once', uciLib.opened(), 1);
check('and still answers about every instance in it', length(facts.configured), 4);
check('with the settings block filled in', facts.settings.rule_pref_base, 20000);
check('and the band it was asked about', facts.settings.band.base, 19000);

// `bindings` cost seven, because the row builder asked the config four separate
// questions and two of them asked it two more.
uciLib.resetCounters();
let rows = service.bindings('', '');
check('bindings() reads the file once', uciLib.opened(), 1);
check('and answers about all five hundred', length(rows.bindings), 500);

// A create check reads twice on purpose: once for the file, once for
// /etc/config/network, which is a different file and not in the snapshot.
uciLib.resetCounters();
let verdict = service.bindCheck({ id: 'newone', ip: '10.9.0.200', wan: 'p001' });
check('a create check reads twice', uciLib.opened(), 2);

// ===========================================================================
// One reading of netifd per pass, and a pass that says so when there is none.
//
// Every instance and the binding half all need the interface list. Asking once
// per half was five dumps on a router with four instances - five replies that
// grow with every session dialled, and five different routers as far as
// anything comparing them is concerned.

scale.resetBusCounts();
uciLib.resetCounters();

let firstPass = service.pass();

check('one dump for the whole pass', scale.busCounts().dump, 1);

// Counted as walks of this package's own file rather than as cursors, because a
// pass legitimately opens others: /etc/config/network, /etc/config/firewall and
// /etc/config/dhcp are read by the layout, and none of them is what the
// snapshot holds. What the snapshot holds is this, and it is read once.
check('the instances are walked once', uciLib.foreachCount('bm_wanbind', 'instance'), 1);
check('and the bindings once', uciLib.foreachCount('bm_wanbind', 'direct'), 1);
check('every instance ran', length(firstPass), 4);
check('netifd is answering', service.info().netifd.ok, true);

// A netifd that will not answer is the one failure this daemon cannot work
// around: every decision it makes is about interfaces, and reading "no answer"
// as "this router has no interfaces" would take every rule off. So the pass
// stops - and a pass that stopped quietly would leave every row reading exactly
// as it did before with nothing anywhere saying why.
service.attach(scale.busFor(router, { dumpNull: true }));
scale.resetBusCounts();

service.pass();
service.pass();

let noAnswer = service.info();

check('the failures are counted', noAnswer.netifd.failures, 2);
check('and it is not pretending otherwise', noAnswer.netifd.ok, false);
check('it tried once per pass', scale.busCounts().dump, 2);
says('the daemon says what stopped', noAnswer.netifd.reason, /netifd did not answer/);
says('and every instance says it too', noAnswer.instances[0].reason, /netifd did not answer/);
check('nothing was reconciled', length(service.pass()), 0);

// And when it comes back, it says that as well rather than leaving a router
// reading "not answering" for ever because nobody restarted anything.
service.attach(scale.busFor(router, {}));
service.pass();

let back = service.info();

check('netifd is answering again', back.netifd.ok, true);
check('and the count starts over', back.netifd.failures, 0);
check('the pass runs every instance again', length(service.pass()), 4);

// ===========================================================================
// The DHCP hook does not read the configuration.
//
// It runs on every lease add, renew and release on the router. Reading
// /etc/config/bm_wanbind here was four opens per DHCP packet - parsing in
// proportion to the traffic rather than to the number of bindings - to answer a
// question that only changes when somebody edits a binding.

// The three hundred and thirty-second binding follows a MAC, and the pass above
// has just indexed it.
let followed = scale.clientMac(331);

uciLib.resetCounters();
let noted = direct.lease({ action: 'add', mac: followed, ip: '10.9.3.99' }, { now: 1000 });

check('a lease for a followed MAC reads no configuration', uciLib.opened(), 0);
check('and exactly the one binding that follows it was acted on', length(noted.handled ?? []), 1);

uciLib.resetCounters();
let ignored = direct.lease({ action: 'add', mac: '02:00:ff:ff:ff:ff', ip: '10.9.0.240' }, { now: 1000 });

check('a lease for a MAC nobody follows reads none either', uciLib.opened(), 0);
check('and nothing was done about it', length(ignored.handled ?? []), 0);

// A section that has just been unbound is out of the index before the pass that
// would have rebuilt it, so a lease arriving in between finds nothing to move.
direct.forget('bmdir_331');

uciLib.resetCounters();
let gone = direct.lease({ action: 'add', mac: followed, ip: '10.9.3.98' }, { now: 1000 });

check('a forgotten binding is not followed', length(gone.handled ?? []), 0);
check('and it still cost no read', uciLib.opened(), 0);

// ===========================================================================
// Five hundred requests for a pass are one pass.
//
// The interface hotplug hook asks for a reconcile every time a session comes
// up, so a pool of five hundred dialling after a reboot asks five hundred
// times. Answered one at a time that is five hundred rule dumps and five
// hundred sweeps of the same band to reach the state one pass reaches.

uloop.resetTimers();
scale.resetBusCounts();

let deferred = null;

for (let i = 0; i < 500; i++)
	deferred = service.reconcileNow({});

check('none of them ran a pass', scale.busCounts().dump, 0);
check('one is due instead', uloop.pending(), 1);
check('and the caller was told so', deferred.pending, true);
check('rather than being told it was done', length(deferred.passes), 0);
check('five hundred requests are waiting on it', service.stats().pass.waiting, 500);
check('four hundred and ninety-nine of them found one already asked for', service.stats().pass.coalesced, 499);
says('and the reason they gave is kept', sprintf('%J', service.stats().pass.owed), /reconcile/);

// A write that arrives while a pass is due joins it. Running one here and
// another two seconds later is two sweeps of every binding on the router for
// one edit.
// The WAN already carries its own routing table, so this write asks netifd for
// nothing: what a bind costs when it has to find one is the next block's
// question.
let beforeBind = scale.busCounts().dump;
let joined = service.bind({ id: 'bmdir_new', ip: '10.9.0.201', wan: 'p002', lan: 'lan' });

check('the write went in', joined.ok, true);
check('and says its rule is coming rather than claiming it is there', joined.pending, true);

// One dump, and it is the check that refuses a binding onto one of the router's
// own LANs - not a pass. A pass costs that dump *and* a sweep of every binding
// on the router, which is what joining the one already due avoids.
check('no pass ran for it', scale.busCounts().dump - beforeBind, 1);
check('the one already due is still the one due', uloop.pending(), 1);

// The trailing edge is fixed. A window that was pushed back by each new request
// would leave the bindings unreconciled for exactly as long as the router was
// busiest.
check('nothing runs before it is due', uloop.advance(1999), 0);
check('and then exactly one pass does', uloop.advance(1), 1);
check('which read netifd once', scale.busCounts().dump - beforeBind, 2);
check('the pass says what asked for it', service.stats().pass.kind, 'coalesced');
check('and how many it answered', service.stats().pass.folded, 501);
check('nothing is owed afterwards', service.stats().pass.pending, false);
check('nor waiting', uloop.pending(), 0);

// `wait` is what a person pressing a button sends, and it still runs the pass
// and answers with what it did.
scale.resetBusCounts();
let asked = service.reconcileNow({ wait: true });

check('an insisting caller gets a pass', length(asked.passes), 4);
check('not a promise of one', asked.pending ?? false, false);
check('which cost one dump', scale.busCounts().dump, 1);

// ===========================================================================
// One firewall commit for five hundred bindings.
//
// A forwarding is a pair of zones: "traffic from here may go to there". Five
// hundred bindings whose LANs are in two zones and whose WANs are all in one
// need two of them. Written per binding they were five hundred identical
// sections, five hundred commits of /etc/config/firewall - five hundred writes
// to flash on a router - and a ruleset carrying five hundred copies of one rule.

let paths = prepare.forwardings();

check('five hundred bindings across two pairs of zones', length(paths.rows), 2);
check('one for the wired LANs', exists(paths.pairs, 'lan|wan'), true);
check('and one for the guest LANs', exists(paths.pairs, 'guest|wan'), true);

// What it costs from cold: the sections are removed and a pass puts them back.
uci.delete('firewall', paths.pairs['lan|wan'].section);
uci.delete('firewall', paths.pairs['guest|wan'].section);

direct.reset();
uciLib.resetCounters();
ran = [];

service.pass();

check('the pass wrote them again', length(prepare.forwardings().rows), 2);
check('committing the firewall once', uciLib.commits('firewall'), 1);
check('and reloading it once', length(ran), 1);
says('with fw4', ran[0] ?? '', /firewall reload/);

// The write budget. A router coming up cold with five hundred bindings on WANs
// that have no routing table has five hundred `option ip4table` lines to write;
// doing them all in one callback is one commit either way and one failure away
// from five hundred unprepared bindings. Sixty-four a pass settles a cold start
// in a handful of passes and leaves nothing a later pass cannot pick up.
let spare = { byName: {} };
let waiting = [];

spare.byName['lanA'] = { role: 'lan', zone: 'lan', cidr: '10.9.0.0/24', device: 'br-lan', lanEvidence: [] };

for (let i = 0; i < 100; i++) {
	let wan = sprintf('spare%03d', i);

	uci.set('network', wan, 'interface');
	uci.set('network', wan, 'proto', 'dhcp');

	spare.byName[wan] = { role: 'wan', zone: 'wan', cidr: '', device: wan, lanEvidence: [] };

	push(waiting, {
		id: sprintf('bmspare_%03d', i),
		usable: true,
		enabled: true,
		wan: wan,
		lan: 'lanA',
		table: 0,
		label: sprintf('10.8.0.%d', i)
	});
}

uciLib.resetCounters();
let batch = prepare.prepareMany(waiting, spare, { taken: {} });

check('the batch stops at its budget', batch.writes, 64);
check('and says how many are left for the next pass', batch.deferred, 36);
check('one commit for all of them', uciLib.commits('network'), 1);
check('and one cursor', uciLib.opened(), 2);
check('netifd is owed a reload', batch.network, true);
check('the pair was already there, so the firewall is not', batch.firewall, false);
check('sixty-four WANs were given a table', uci.get('network', 'spare063', 'ip4table') != null, true);
check('and the sixty-fifth was not', uci.get('network', 'spare064', 'ip4table'), null);

// The rest on the next pass, and no number handed out twice.
let taken = {};
for (let i = 0; i < 100; i++) {
	let already = uci.get('network', sprintf('spare%03d', i), 'ip4table');
	if (already != null)
		taken[already] = true;
}

let second = prepare.prepareMany(waiting, spare, { taken: taken });

check('the second pass finishes them', second.writes, 36);
check('with nothing left over', second.deferred, 0);
// `taken` is handed to both batches and each one adds the numbers it gave out,
// so a hundred entries is a hundred WANs with a hundred different tables. Two
// prepared in one batch without a shared set would have been handed the same
// free number, which is the one state that sends one binding's traffic out of
// another's port.
check('and every table is a different number', length(keys(taken)), 100);

// ===========================================================================
// Two hundred bindings in one call.
//
// The module hands over the bindings it used to write itself. Five hundred
// separate `bind` calls would be five hundred commits to flash and five hundred
// full passes over the same band, on a router that is answering everything else
// in between.

uloop.resetTimers();
uciLib.resetCounters();
scale.resetBusCounts();

let batchSpecs = [];

// On the two LANs the fixture's own five hundred do not reach: those sit from
// .10 to .134 on each, and a batch that collided with them would be measuring
// the collision check rather than the batch.
for (let i = 0; i < 200; i++) {
	let lan = (i < 100) ? 'guest' : 'iot';
	let subnet = (i < 100) ? '10.9.2' : '10.9.3';

	push(batchSpecs, {
		id: sprintf('bmhand_%03d', i),
		ip: sprintf('%s.%d', subnet, 150 + (i % 100)),
		wan: scale.wanName((i % 500) + 1),
		lan: lan,
		when_down: 'hold'
	});
}

let handed = service.bindMany({ bindings: batchSpecs });

check('every one of them was written', handed.written, 200);
check('none refused', handed.refused, 0);
check('in one commit', uciLib.commits('bm_wanbind'), 1);
check('with one look at netifd', scale.busCounts().dump, 1);
check('and a pass owed rather than run', handed.pending, true);
check('one pass, not two hundred', uloop.pending(), 1);
check('a result per entry', length(handed.results), 200);
check('each carrying the number it was given', handed.results[0].pref > 0, true);

// Every priority handed out is a different one. Allocated from the file alone,
// every entry in the batch would have been given the lowest free number - two
// hundred rules at one priority, which is not an order the kernel breaks in any
// way worth relying on.
let seenPrefs = {};
for (let row in handed.results) {
	if (row.ok)
		seenPrefs[sprintf('%d', row.pref)] = true;
}

check('and no two the same', length(keys(seenPrefs)), 200);

// The batch checks itself as well as the file: two entries naming one section,
// or following one address, are caught here rather than by the read-back saying
// only that one of them is broken.
let clashes = service.bindMany({ bindings: [
	{ id: 'bmclash_a', ip: '10.9.1.200', wan: 'p003', lan: 'LAN_WIRED' },
	{ id: 'bmclash_a', ip: '10.9.1.201', wan: 'p003', lan: 'LAN_WIRED' },
	{ id: 'bmclash_b', ip: '10.9.1.200', wan: 'p004', lan: 'LAN_WIRED' }
] });

check('the good one is written', clashes.written, 1);
check('and the other two refused', clashes.refused, 2);
says('one for its name', clashes.results[1].reason, /both called bmclash_a/);
says('the other for its address', clashes.results[2].reason, /already follows 10\.9\.1\.200/);

// Over the limit is refused before anything is opened, rather than half done.
uciLib.resetCounters();

let toomany = [];
for (let i = 0; i < 201; i++)
	push(toomany, { id: sprintf('bmover_%03d', i), ip: sprintf('10.9.2.%d', 5 + i), wan: 'p005', lan: 'guest' });

let over = service.bindMany({ bindings: toomany });

check('a batch over the limit is refused', over.ok, false);
says('and says how to send it', over.reason, /Send it in batches/);
check('having opened nothing', uciLib.opened(), 0);

// And the same in reverse.
uciLib.resetCounters();

let names = [];
for (let i = 0; i < 200; i++)
	push(names, sprintf('bmhand_%03d', i));

let dropped = service.unbindMany({ ids: names });

check('every one removed', dropped.removed, 200);
check('in one commit', uciLib.commits('bm_wanbind'), 1);
check('with a pass owed', dropped.pending, true);
check('and the sections are gone', uci.get('bm_wanbind', 'bmhand_000'), null);

// ===========================================================================
// A bound address still reaches the network it is on.
//
// A binding sends everything from an address to its WAN's routing table, and
// that table knows only how to leave the building. Without an escape a bound
// machine reaches the internet and not the printer on the next desk - and the
// packet for the printer leaves by the WAN port addressed to a private network
// that drops it.

service.attach(scale.busFor(router, {}));
service.pass();

function escapes() {
	let out = [];

	for (let one in netlink.destRules()) {
		if (one.pref >= 18000 && one.pref <= 18063)
			push(out, one);
	}

	return out;
}

let escaped = escapes();

check('one rule per LAN this router serves', length(escaped), 4);
check('numbered from the base', escaped[0].pref, 18000);
check('and sorted, so a LAN keeps its number between passes', escaped[0].dst, '10.9.0.0/24');
check('the last is the fourth LAN', escaped[3].dst, '10.9.3.0/24');
check('every one of them goes to the main table', escaped[3].table, 254);
check('below every binding', escaped[3].pref < 19000, true);

// Written once. A pass that rewrote them every thirty seconds would be a window,
// thirty times an hour, in which a bound address has no way back to its LAN.
rtnl.resetRuleDumps();
service.pass();
check('a second pass writes nothing', length(escapes()), 4);
check('and the rules are the same ones', escapes()[0].pref, 18000);

// Removed by hand, put back by the next pass - the same contract every other
// rule this daemon writes has.
netlink.removeDest(18001, '10.9.1.0/24', 254);
check('one taken off by hand', length(escapes()), 3);

service.pass();
check('is put back', length(escapes()), 4);
check('at the number it had', escapes()[1].pref, 18001);
check('for the network it had', escapes()[1].dst, '10.9.1.0/24');

// The monitor knows whose they are. Reported as a stranger's, four rules with
// no source and a destination would read as somebody steering traffic by hand.
let seen = service.rulesReport({ limit: 3000 });
let localRows = 0;

for (let row in seen.rules) {
	if (row.owner == 'local')
		localRows++;
}

check('the monitor knows whose they are', localRows, 4);

// Switched off is a state, not an absence: the band has to end up empty.
let off = service.settingsSet({ lan_local: false });
check('the setting is accepted', off.ok, true);

service.pass();
check('and the rules come off', length(escapes()), 0);

let on = service.settingsSet({ lan_local: true });
check('switched back on', on.ok, true);

service.pass();
check('they come back', length(escapes()), 4);

// A base that reaches into the binding band is the same as having no escapes at
// all, and silently, so it is refused rather than corrected.
let bad = service.settingsSet({ local_pref_base: 19000 });
check('a base inside the binding band is refused', bad.ok, false);
says('and says why', bad.reason, /not below direct_pref_base/);

service.pass();
check('so the rules are still where they were', length(escapes()), 4);

report();
