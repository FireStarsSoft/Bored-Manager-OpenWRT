// The pool daemon with five hundred sessions on it.
//
// `pool-lifecycle.uc` next door asks whether the arithmetic is right, against a
// pool of three. That is the correct size for that question and the wrong size
// for this one: a pass that walks every pool's member list for every dumped
// interface, and one that looks the interface up, behave identically at three
// members and are a quarter of a million comparisons apart at five hundred.
//
// So this file measures. Every assertion here is a count or a cost rather than
// a verdict, and the numbers are the ones a router carrying a real pool would
// produce.

import { seed, wipe } from 'fs';
import { cursor } from 'uci';

import * as netifd from 'netifd';
import * as service from 'bm.pppoe.service';
import * as sessions from 'bm.pppoe.sessions';
import * as uciLib from 'uci';

import { check, report, says } from 'probe';

let uci = cursor();

const PREFIX = 'fpt';
const MEMBERS = 500;
const FIRST_VLAN = 101;

// --------------------------------------------------------------- the router

uci.set('network', 'lan', 'interface');
uci.set('network', 'lan', 'proto', 'static');
uci.set('network', 'lan', 'device', 'br-lan');
uci.set('network', 'lan', 'ipaddr', '10.9.0.1');

// fw4's software flow offload, on. Above sixty-four sessions the create check
// refuses a pool without it - every session installs three routing rules and
// the kernel walks the whole list for every packet - so a fixture of five
// hundred that did not say either way would be testing the refusal.
uci.set('firewall', 'defs', 'defaults');
uci.set('firewall', 'defs', 'flow_offloading', '1');

seed('/proc/meminfo', 'MemTotal:        2048000 kB' + chr(10) + 'MemAvailable:    1500000 kB' + chr(10));

// The pool as the daemon itself would write it: five hundred members, created
// through the same call the app and the CLI use, so the fixture cannot describe
// a router the daemon would never produce.
seed('/sys/cl' + 'ass/net/eth1/address', 'aa:bb:cc:dd:ee:ff' + chr(10));
seed('/sys/cl' + 'ass/net/eth1/operstate', 'up' + chr(10));
seed('/sys/cl' + 'ass/net/eth2/address', 'aa:bb:cc:dd:ee:f0' + chr(10));
seed('/sys/cl' + 'ass/net/eth2/operstate', 'up' + chr(10));

let wanted = [];

for (let i = 0; i < MEMBERS; i++)
	push(wanted, { vlan: FIRST_VLAN + i });

let made = service.poolAdd({
	id: PREFIX, mode: 'multi', prefix: PREFIX, carrier: 'eth1',
	username: 'user@isp', password: 'pw', table_base: 10000,
	zone: 'bmwanpool', members: wanted
});

check('the pool was created', made.ok, true);
check('with five hundred members', made.created, MEMBERS);

seed('/etc/config/network', 'seeded so the daemon can stat it');

// netifd: every member up, and five hundred interfaces of somebody else's on
// the same router - which is what makes the index worth having rather than a
// tidier way of writing the same walk.
let dump = netifd.dumpOf(PREFIX, FIRST_VLAN, MEMBERS, { foreign: 500 });
let bus = netifd.bus(dump);

service.attach(bus);
service.attachSystem((command, timeout) => { return 0; });
service.load();

// ------------------------------------------------------------- the fixture

check('every member is in the index', service.stats().indexSize, MEMBERS);
// Built when the configuration is read and not on every pass: twice so far,
// once for the create and once for the load above.
let builtSoFar = service.stats().indexBuilds;
check('and the dump has the router-s own interfaces in it too', length(dump.interface), MEMBERS + 501);

// ------------------------------------------------------------- one pass

service.pass();

let after = service.stats();

check('the pass read every interface netifd offered', after.pass.dumpEntries, MEMBERS + 501);
check('every member is known', after.sessions, MEMBERS);
check('and every one of them is up', service.info({}).pools[0].up, MEMBERS);
check('nothing is waiting to be redialled', after.queueDepth, 0);
check('the pass timed itself', after.pass.totalMs >= 0, true);
check('and did not rebuild the index', after.indexBuilds, builtSoFar);

// A foreign interface is not somebody's session. Folded into a pool by a loop
// that matched on the wrong thing, it would be a member this daemon believes in
// and netifd has never heard of.
check('and no foreign interface became a member', after.sessions, MEMBERS);

// ------------------------------------------------------- the config cadence

let reads = service.stats().pass.configReads;

for (let i = 0; i < 24; i++)
	service.pass();

check('the configuration is not re-read on every pass', uciLib.foreachCount('network', 'interface') < 30, true);
check('and the last pass did not read it', service.stats().pass.configReads, 0);

// Until it changes, and then it is read again on the next pass.
seed('/etc/config/network', 'edited by somebody at a shell');
service.pass();

check('a file that changed is read again', service.stats().pass.configReads, 1);
service.pass();
check('and only once', service.stats().pass.configReads, 0);

// -------------------------------------------------------- the redial queue

// A hundred sessions go down and stay down. The queue used to be an array that
// only ever shed entries from its front, so a redial every interval for a week
// was twenty thousand entries describing five hundred sessions.
let downed = [];

for (let i = 0; i < 100; i++)
	push(downed, sprintf('%s%d', PREFIX, FIRST_VLAN + i));

netifd.setDown(dump, downed);
service.pass();

check('the daemon knows how many are waiting', service.stats().queueDepth, 100);

// Two hundred rounds of redialling, which is a week of a flapping pool.
let pool = service.poolState(PREFIX);
// From the router's own clock, because the sessions were marked down against
// it: a probe clock starting at zero would make every session look as though it
// went down in 1970 and nothing would ever be due.
let clock = time();

for (let round = 0; round < 200; round++) {
	clock = clock + 200;

	let due = sessions.dueForRedial(pool, 120, 20, clock);

	for (let one in due)
		sessions.redialled(pool, one, clock);
}

check('nothing grew that is not a session', exists(pool, 'downQueue'), false);
check('and the number waiting is still the number down', sessions.queueDepth(pool), 100);

// Longest down first, which is what the queue was for.
let first = sessions.dueForRedial(pool, 1, 5, clock + 10000);
check('the redial batch is the size asked for', length(first), 5);

// ------------------------------------------------------- rows, per pool

// A second pool, so the row cap has two of them to be shared badly between.
let second = [];

for (let i = 0; i < MEMBERS; i++)
	push(second, { vlan: 201 + i });

let made2 = service.poolAdd({
	id: 'vnp', mode: 'multi', prefix: 'vnp', carrier: 'eth2',
	username: 'user@vnpt', password: 'pw', table_base: 11000,
	zone: 'bmwanpool', members: second
});

check('the second pool was created', made2.created, MEMBERS);

let page = service.sessionRows({});

check('a page is the cap', length(page.sessions), 500);
check('and says how many rows there are altogether', page.total, 1000);
check('so a reader knows it is not the whole answer', page.truncated, true);

let rest = service.sessionRows({ offset: 500 });

check('the rest are reachable', length(rest.sessions), 500);
check('and that is all of them', rest.truncated, false);

// The failure this replaces: asked for the second pool by name, every one of
// its members came back rather than none of them.
let onlySecond = service.sessionRows({ id: 'vnp' });

check('one pool answers about itself', onlySecond.total, MEMBERS);
check('all of it', length(onlySecond.sessions), MEMBERS);
check('and says it is complete', onlySecond.truncated, false);

let past = service.sessionRows({ offset: 5000 });
check('an offset past the end is empty rather than an error', length(past.sessions), 0);

// ------------------------------------------------------ actions by pool id

let downAll = service.actionCall({ action: 'down', id: 'vnp' });

check('a whole pool can be named', downAll.ok, true);
check('and every one of its members acted on', length(downAll.sections), MEMBERS);
check('without touching the other pool', downAll.pool, 'vnp');

let mixed = service.actionCall({ action: 'down', id: 'vnp', sections: [ 'vnp201', 'fpt101' ] });

check('sections outside the named pool are refused', length(mixed.sections), 1);
check('and named rather than silently dropped', mixed.skipped[0], 'fpt101');

let nopool = service.actionCall({ action: 'down', id: 'nosuch' });
check('a pool that is not there is said so', nopool.ok, false);
says('by name', nopool.reason, /no pool called nosuch/);

// ------------------------------------------------------------ going blind

service.attach(netifd.bus(dump, { dumpNull: true }));
service.pass();
service.pass();

let unseen = service.sessionRows({ id: PREFIX });

check('the daemon says it cannot see', unseen.blind != null, true);
check('and for how long it has not', unseen.blind.failures, 2);
check('while the rows are still there, being the last it saw', length(unseen.sessions), MEMBERS);

service.attach(netifd.bus(dump));
service.pass();

check('and when netifd comes back it says so', service.sessionRows({}).blind, null);

// ------------------------------------------------- what the router can carry

function hasFinding(result, level, needle) {
	for (let one in (type(result.findings) == 'array') ? result.findings : []) {
		if (one.level == level && index(one.label, needle) >= 0)
			return true;
	}

	return false;
};

// Offload off, and a pool large enough for it to matter. This is the refusal
// that turns "my ISP is slow" into "turn this on".
uci.set('firewall', 'defs', 'flow_offloading', '0');

let refused = service.poolCheck({
	id: 'big', mode: 'multi', prefix: 'big', carrier: 'eth1',
	username: 'u@isp', password: 'pw', table_base: 12000, zone: 'bmwanpool',
	members: wanted
});

check('a large pool without flow offload is refused', refused.ok, false);
check('and says which setting it is', hasFinding(refused, 'error', 'need fw4 flow offload'), true);
check('the check says what the router answered', refused.router.flowOffload, false);

// Sixty-four is the threshold, so sixty-four is not over it.
let small = [];
for (let i = 0; i < 64; i++)
	push(small, { vlan: 900 + i });

let allowed = service.poolCheck({
	id: 'small', mode: 'multi', prefix: 'sml', carrier: 'eth1',
	username: 'u@isp', password: 'pw', table_base: 13000, zone: 'bmwanpool',
	members: small
});

check('a pool at the threshold is not refused for it', hasFinding(allowed, 'error', 'need fw4 flow offload'), false);

uci.set('firewall', 'defs', 'flow_offloading', '1');

let fine = service.poolCheck({
	id: 'big', mode: 'multi', prefix: 'big', carrier: 'eth1',
	username: 'u@isp', password: 'pw', table_base: 12000, zone: 'bmwanpool',
	members: wanted
});

check('with it on, the same pool passes', hasFinding(fine, 'error', 'need fw4 flow offload'), false);
check('and it is said so rather than left unsaid', hasFinding(fine, 'pass', 'flow offload is on'), true);

// Memory. Five hundred more sessions on a router with sixty megabytes free is
// not a warning, it is a refusal.
seed('/proc/meminfo', 'MemTotal:         131072 kB' + chr(10) + 'MemAvailable:      60000 kB' + chr(10));

let tight = service.poolCheck({
	id: 'big', mode: 'multi', prefix: 'big', carrier: 'eth1',
	username: 'u@isp', password: 'pw', table_base: 12000, zone: 'bmwanpool',
	members: wanted
});

check('a router without the memory is told', hasFinding(tight, 'error', 'does not have the memory'), true);

seed('/proc/meminfo', 'MemTotal:        2048000 kB' + chr(10) + 'MemAvailable:    1500000 kB' + chr(10));

report();
