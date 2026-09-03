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

// The pool as the daemon itself would write it: five hundred members, created
// through the same call the app and the CLI use, so the fixture cannot describe
// a router the daemon would never produce.
seed('/sys/cl' + 'ass/net/eth1/address', 'aa:bb:cc:dd:ee:ff' + chr(10));
seed('/sys/cl' + 'ass/net/eth1/operstate', 'up' + chr(10));

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

report();
