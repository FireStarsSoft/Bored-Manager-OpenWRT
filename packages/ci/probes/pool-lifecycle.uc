// Creating, extending and deleting a PPPoE pool, for real.
//
// The arithmetic is what this is for: which sections a create names, where an
// append starts, what the record says afterwards, and which of the two overlap
// rules fires when. Every one of those is an off-by-one away from a pool that
// rewrites another pool's credentials, and none of them is visible to a
// compiler.

import { cursor } from 'uci';

import * as cfg from 'bm.pppoe.config';
import * as pppoe from 'bm.pppoe.service';

import { check, report, says } from 'probe';

function rows(count, from) {
	let out = [];

	for (let i = 0; i < count; i++)
		push(out, { user: sprintf('u%d@isp', from + i), pass: sprintf('p%d', from + i) });

	return out;
};

let uci = cursor();

// ---------------------------------------------------------------- create
let made = pppoe.poolAdd({
	id: 'ppp', prefix: 'ppp', carrier: 'eth1',
	seq_from: 1, table_base: 1000, vlan: 0,
	accounts: rows(200, 1)
});

check('create ok', made.ok, true);
check('create count', made.created, 200);
check('create seqTo', made.seqTo, 200);
check('first section username', uci.get('network', 'ppp00001', 'username'), 'u1@isp');
check('first section table', uci.get('network', 'ppp00001', 'ip4table'), '1001');
check('last section username', uci.get('network', 'ppp00200', 'username'), 'u200@isp');
check('record seq_to', uci.get('bm_pppoe', 'ppp', 'seq_to'), '200');

// ---------------------------------------------------------------- append
let more = pppoe.poolAppend({ id: 'ppp', accounts: rows(50, 201) });

check('append ok', more.ok, true);
check('append starts after the last', more.seqFrom, 201);
check('append seqTo', more.seqTo, 250);
check('append reports the whole pool', more.count, 250);
check('appended section', uci.get('network', 'ppp00201', 'username'), 'u201@isp');
check('appended table', uci.get('network', 'ppp00250', 'ip4table'), '1250');
check('record widened', uci.get('bm_pppoe', 'ppp', 'seq_to'), '250');
check('record start unmoved', uci.get('bm_pppoe', 'ppp', 'seq_from'), '1');

// What is written has to survive being read back, which is what pools() decides
// and what a create used not to check.
let listed = cfg.pools();
check('pools() sees it', length(listed), 1);
check('pools() counts it', listed[0].count, 250);

// ------------------------------------------------------------- the overlap
let clash = pppoe.poolAdd({
	id: 'ppp2', prefix: 'ppp', carrier: 'eth1',
	seq_from: 200, table_base: 5000, accounts: rows(10, 1)
});

check('an overlapping create is refused', clash.ok, false);
says('and it names the pool in the way', clash.reason, /pool ppp already holds/);

let beside = pppoe.poolAdd({
	id: 'ppp2', prefix: 'ppp', carrier: 'eth1',
	seq_from: 300, table_base: 5000, accounts: rows(10, 300)
});

check('a create above it is fine', beside.ok, true);

// And now the first pool cannot grow into its neighbour. The record must be
// untouched: it is checked before it is widened, not after.
let blocked = pppoe.poolAppend({ id: 'ppp', accounts: rows(80, 251) });

check('an append into the neighbour is refused', blocked.ok, false);
check('and the record was not widened', uci.get('bm_pppoe', 'ppp', 'seq_to'), '250');

// ----------------------------------------------------- refused on read-back
let noCarrier = pppoe.poolAdd({
	id: 'ppp3', prefix: 'ppq', carrier: '',
	seq_from: 1, table_base: 1000, accounts: rows(2, 1)
});

check('a pool with no carrier is refused', noCarrier.ok, false);

let offTheEnd = pppoe.poolAdd({
	id: 'ppp4', prefix: 'ppr', carrier: 'eth1',
	seq_from: 1, table_base: 65530, accounts: rows(20, 1)
});

check('a pool past routing table 65535 is refused', offTheEnd.ok, false);

// --------------------------------------------------------- the inline limit
let flood = pppoe.poolAdd({
	id: 'ppp5', prefix: 'pps', carrier: 'eth1',
	seq_from: 1, table_base: 2000, accounts: rows(201, 1)
});

check('more than 200 accounts in one call is refused', flood.ok, false);
says('and says how to send them', flood.reason, /at most 200 accounts in one call/);

// ---------------------------------------------------------------- credentials
check('a password with a newline is refused',
	cfg.safeValue(sprintf('good%cbad', 10)), false);
check('a password with a NUL is refused',
	cfg.safeValue(sprintf('good%cbad', 0)), false);
check('an ordinary password is not',
	cfg.safeValue('p@ssw0rd! #$%^&*()'), true);

// ---------------------------------------------------------------- delete
let gone = pppoe.poolDelete({ id: 'ppp' });

check('delete ok', gone.ok, true);
check('delete removed the whole range', gone.removed, 250);
check('its first section is gone', uci.get('network', 'ppp00001', 'username'), null);
check('the neighbour is untouched', uci.get('network', 'ppp00300', 'username'), 'u300@isp');

report();
