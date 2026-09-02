// The address arithmetic an instance is scoped with, and what it refuses.
//
// This is the file that decides which devices on a LAN an instance is allowed
// to touch, and the two halves of that decision have to agree exactly or the
// feature is worse than not having it. The planner admits a lease when it is
// inside the range; the catch-all blocks every address the planner did not
// seat. If the blocks cover one address more than the range does, that address
// is fenced off the internet by an instance that will never give it a WAN - a
// device taken off the network by a feature whose entire purpose was to leave
// it alone.
//
// So the assertions here are on the exact block list rather than on "some
// blocks came back", and on the boundaries: one address, a whole subnet, a
// range that starts above 128.0.0.0 (where a signed shift would go negative and
// swallow the internet), and the arithmetic guard.

import { cursor } from 'uci';

import * as cfg from 'bm.wanbind.config';
import * as wans from 'bm.wanbind.wans';

import { check, report, says } from 'probe';

let uci = cursor();

function blocks(from, to) {
	return join(' ', wans.rangeCidrs(from, to));
}

// ------------------------------------------------------------- the arithmetic

check('an address is itself', blocks('10.0.0.7', '10.0.0.7'), '10.0.0.7/32');

check('a whole /24 is one block', blocks('192.168.1.0', '192.168.1.255'), '192.168.1.0/24');

// The textbook awkward range: neither end lands on a boundary, so it needs a
// block per power of two on the way up and a block per power of two on the way
// down.
check('an awkward range is the minimal cover',
	blocks('10.0.0.10', '10.0.0.20'),
	'10.0.0.10/31 10.0.0.12/30 10.0.0.16/30 10.0.0.20/32');

check('and a DHCP pool that starts at .100', blocks('192.168.1.100', '192.168.1.199'),
	'192.168.1.100/30 192.168.1.104/29 192.168.1.112/28 192.168.1.128/26 192.168.1.192/29');

// Above 128.0.0.0 every address has its top bit set. ucode's bitwise operators
// are signed 64-bit, so a mask built by shifting would make these compare as
// negative and the first block would come back as 0.0.0.0/0 - a fail-closed
// catch-all over the entire internet, written by an instance somebody scoped to
// ten addresses. The arithmetic here is multiplication and subtraction for
// exactly that reason, and this is the case that proves it.
check('the top half of the address space is not special',
	blocks('200.0.0.0', '200.0.0.3'), '200.0.0.0/30');

check('nor is a range that spans the sign bit',
	blocks('127.255.255.255', '128.0.0.0'), '127.255.255.255/32 128.0.0.0/32');

check('the whole address space is one block', blocks('0.0.0.0', '255.255.255.255'), '0.0.0.0/0');

check('a range that runs backwards has no blocks', length(wans.rangeCidrs('10.0.0.20', '10.0.0.10')), 0);
check('nor has one that is not addresses', length(wans.rangeCidrs('10.0.0.x', '10.0.0.20')), 0);

check('membership is inclusive at both ends', wans.inRange('10.0.0.10', '10.0.0.20', '10.0.0.10'), true);
check('at the top too', wans.inRange('10.0.0.10', '10.0.0.20', '10.0.0.20'), true);
check('and excludes what is outside', wans.inRange('10.0.0.10', '10.0.0.20', '10.0.0.21'), false);
check('below as well', wans.inRange('10.0.0.10', '10.0.0.20', '10.0.0.9'), false);

check('an address that is not one is in no range', wans.inRange('10.0.0.10', '10.0.0.20', 'nope'), false);

// --------------------------------------------------------------- the section

function instance(id, extra) {
	uci.set('bm_wanbind', id, 'instance');
	uci.set('bm_wanbind', id, 'lan', 'lan');
	uci.set('bm_wanbind', id, 'carrier', 'eth1');

	for (let key in extra)
		uci.set('bm_wanbind', id, key, extra[key]);
};

function readingOf(id) {
	for (let one in cfg.configured()) {
		if (one.id == id)
			return one;
	}

	return null;
};

function reasonFor(id) {
	let one = readingOf(id);
	return one ? one.reason : 'no such section';
};

// A section written before any of this existed, which is every section on every
// router that has ever run this package. It has to keep meaning exactly what it
// meant: the whole LAN, one client per WAN.
instance('legacy', {});

check('an instance with none of the new options is still usable', readingOf('legacy').usable, true);
check('and means one client per WAN', readingOf('legacy').clientsPerWan, 1);
check('and the whole of its LAN', readingOf('legacy').rangeFrom, '');

instance('scoped', { range_from: '192.168.1.100', range_to: '192.168.1.199', catch_all_pref: '30001', lan: 'scopedlan' });
check('a scoped instance is usable', readingOf('scoped').usable, true);
check('and remembers its range', readingOf('scoped').rangeTo, '192.168.1.199');

instance('shared', { clients_per_wan: '4', catch_all_pref: '30002', lan: 'guest' });
check('and so is one that seats four to a WAN', readingOf('shared').clientsPerWan, 4);

instance('unlimited', { clients_per_wan: '0', catch_all_pref: '30003', lan: 'iot' });
check('nought means no limit rather than none', readingOf('unlimited').usable, true);
check('and is read as nought', readingOf('unlimited').clientsPerWan, 0);

// --------------------------------------------------------------- the refusals

instance('halfrange', { range_from: '192.168.9.10', catch_all_pref: '30010', lan: 'half' });
says('one end of a range without the other is refused', reasonFor('halfrange'),
	/range_from is set without range_to/);
says('and says what to do about it', reasonFor('halfrange'), /set both, or neither for the whole LAN/);

instance('halfrange2', { range_to: '192.168.9.20', catch_all_pref: '30011', lan: 'half2' });
says('the other way round too', reasonFor('halfrange2'), /range_to is set without range_from/);

instance('backwards', { range_from: '192.168.9.99', range_to: '192.168.9.10', catch_all_pref: '30012', lan: 'back' });
says('a range that runs downhill is refused', reasonFor('backwards'), /a range runs upwards/);
says('quoting both ends', reasonFor('backwards'), /range_from 192.168.9.99 is above range_to 192.168.9.10/);

instance('nonsense', { range_from: 'ten', range_to: '192.168.9.20', catch_all_pref: '30013', lan: 'non' });
says('and one that is not addresses', reasonFor('nonsense'), /range_from ten is not an IPv4 address/);

instance('crowd', { clients_per_wan: '99999', catch_all_pref: '30014', lan: 'crowd' });
says('a clients_per_wan nobody meant is refused', reasonFor('crowd'), /is not a number of clients/);
says('and the sentence explains all three answers', reasonFor('crowd'), /0 means no limit/);

// ------------------------------------------------------ two instances, one LAN
//
// The whole reason a range is a first-class thing rather than a filter: two
// disjoint ranges on one LAN are two pools of clients and two pools of WANs,
// which people genuinely want. Two overlapping ones are two planners deciding
// the same device on two timers, each reading the other rule as a stray.

uci.set('bm_wanbind', 'lower', 'instance');
uci.set('bm_wanbind', 'lower', 'lan', 'office');
uci.set('bm_wanbind', 'lower', 'carrier', 'eth1');
uci.set('bm_wanbind', 'lower', 'range_from', '10.9.0.10');
uci.set('bm_wanbind', 'lower', 'range_to', '10.9.0.99');
uci.set('bm_wanbind', 'lower', 'catch_all_pref', '30020');

uci.set('bm_wanbind', 'upper', 'instance');
uci.set('bm_wanbind', 'upper', 'lan', 'office');
uci.set('bm_wanbind', 'upper', 'carrier', 'eth2');
uci.set('bm_wanbind', 'upper', 'range_from', '10.9.0.100');
uci.set('bm_wanbind', 'upper', 'range_to', '10.9.0.199');
uci.set('bm_wanbind', 'upper', 'catch_all_pref', '30021');

check('two disjoint ranges on one LAN are both fine', readingOf('lower').usable, true);
check('both of them', readingOf('upper').usable, true);

uci.set('bm_wanbind', 'greedy', 'instance');
uci.set('bm_wanbind', 'greedy', 'lan', 'office');
uci.set('bm_wanbind', 'greedy', 'carrier', 'eth3');
uci.set('bm_wanbind', 'greedy', 'range_from', '10.9.0.50');
uci.set('bm_wanbind', 'greedy', 'range_to', '10.9.0.150');
uci.set('bm_wanbind', 'greedy', 'catch_all_pref', '30022');

says('a third that straddles them is refused', reasonFor('greedy'), /already binds 10.9.0.10-10.9.0.99 on office/);
says('and named for what to change', reasonFor('greedy'), /an address range that does not overlap/);
check('while the two it collided with are untouched', readingOf('lower').usable, true);

// The old rule, said properly: a whole-LAN instance covers everything, so it
// collides with anything else on that LAN whichever way round they are written.
uci.set('bm_wanbind', 'everything', 'instance');
uci.set('bm_wanbind', 'everything', 'lan', 'office');
uci.set('bm_wanbind', 'everything', 'carrier', 'eth4');
uci.set('bm_wanbind', 'everything', 'catch_all_pref', '30023');

says('and a whole-LAN instance beside a scoped one is refused',
	reasonFor('everything'), /already binds 10.9.0.10-10.9.0.99 on office/);

// A disabled section claims nothing, so switching one off is a way to free its
// scope. Deleting it should not have to be. `greedy` straddles both, so one is
// not enough - and the sentence naming the second one is the point: an operator
// who switched off the instance the refusal named has to be told there is
// another rather than left pressing the same button.
uci.set('bm_wanbind', 'lower', 'enabled', '0');
says('switching one off moves the refusal to the next one it overlaps',
	reasonFor('greedy'), /instance upper already binds 10.9.0.100-10.9.0.199/);

uci.set('bm_wanbind', 'upper', 'enabled', '0');
check('and switching off the last of them frees the scope', reasonFor('greedy'), null);

uci.set('bm_wanbind', 'lower', 'enabled', '1');
uci.set('bm_wanbind', 'upper', 'enabled', '1');

// Two catch-alls at one priority is the same fault one step along.
uci.set('bm_wanbind', 'twin', 'instance');
uci.set('bm_wanbind', 'twin', 'lan', 'spare');
uci.set('bm_wanbind', 'twin', 'carrier', 'eth5');
uci.set('bm_wanbind', 'twin', 'catch_all_pref', '30020');

says('two catch-alls at one priority is refused', reasonFor('twin'),
	/catch_all_pref 30020 is already taken by instance lower/);
says('and says what the two of them would do', reasonFor('twin'), /keep rewriting the other/);

report();
