// Deleting a pool the old model wrote, which is the one thing still owed it.
//
// The old shape is seeded by hand - a record with a sequence range, five-digit
// sections, a refcounted `bmv<vid>` device, zone memberships by section name -
// because nothing in 2.0.0 can create it any more. What is being proved is
// that the daemon lists it as legacy, refuses to edit it, and deletes exactly
// what the old create added, including the shared device only when this pool
// was its last user.

import { cursor } from 'uci';

import * as pppoe from 'bm.pppoe.service';

import { check, report, says } from 'probe';

let uci = cursor();

// A legacy pool: ppp00001-ppp00003 on VLAN 835, and a neighbour that shares
// the VLAN device the way the old model refcounted it.
uci.set('bm_pppoe', 'old1', 'pool');
uci.set('bm_pppoe', 'old1', 'prefix', 'ppp');
uci.set('bm_pppoe', 'old1', 'carrier', 'eth1');
uci.set('bm_pppoe', 'old1', 'seq_from', '1');
uci.set('bm_pppoe', 'old1', 'seq_to', '3');
uci.set('bm_pppoe', 'old1', 'table_base', '1000');
uci.set('bm_pppoe', 'old1', 'vlan', '835');

uci.set('network', 'bmv835', 'device');
uci.set('network', 'bmv835', 'type', '8021q');
uci.set('network', 'bmv835', 'ifname', 'eth1');
uci.set('network', 'bmv835', 'vid', '835');
uci.set('network', 'bmv835', 'name', 'eth1.835');

for (let seq = 1; seq <= 3; seq++) {
	let name = sprintf('ppp%05d', seq);
	uci.set('network', name, 'interface');
	uci.set('network', name, 'proto', 'pppoe');
	uci.set('network', name, 'device', 'eth1.835');
	uci.set('network', name, 'username', sprintf('u%d@isp', seq));
	uci.set('network', name, 'password', 'x');
	uci.set('network', name, 'ip4table', sprintf('%d', 1000 + seq));
}

// Somebody else still dials over the same VLAN device.
uci.set('network', 'other', 'interface');
uci.set('network', 'other', 'proto', 'pppoe');
uci.set('network', 'other', 'device', 'eth1.835');

// The zone the module of that era filled by section name.
uci.set('firewall', 'bmwanpool', 'zone');
uci.set('firewall', 'bmwanpool', 'name', 'bmwanpool');
uci.set('firewall', 'bmwanpool', 'network', [ 'ppp00001', 'ppp00002', 'ppp00003', 'other' ]);

uci.commit('bm_pppoe');
uci.commit('network');
uci.commit('firewall');

pppoe.load();

// ---------------------------------------------------------------- listing
let told = pppoe.info();
check('a legacy pool is not a pool', length(told.pools), 0);
check('it is listed as legacy', length(told.legacy), 1);
check('with its range', told.legacy[0].count, 3);

// ----------------------------------------------------------------- refusals
let edited = pppoe.poolSet({ id: 'old1', label: 'nope' });
check('editing a legacy pool is refused', edited.ok, false);
says('and says the way forward', edited.reason, /delete it and create it again/);

let checked = pppoe.poolCheck({ id: 'old1' });
check('checking one is refused the same way', checked.ok, false);

let squatted = pppoe.poolAdd({
	id: 'old1', mode: 'multi', prefix: 'ppq', carrier: 'eth1',
	username: 'x@isp', password: 'x', members: [ { vlan: 9 } ]
});
check('its id cannot be reused while it exists', squatted.ok, false);

// ------------------------------------------------------------------ delete
let gone = pppoe.poolDelete({ id: 'old1' });
check('delete ok', gone.ok, true);
check('delete says it was legacy', gone.legacy, true);
check('delete removed the whole range', gone.removed, 3);
check('the sections are gone', uci.get('network', 'ppp00001'), null);
check('the record is gone', uci.get('bm_pppoe', 'old1'), null);
check('the shared device stays for its other user', uci.get('network', 'bmv835', 'vid'), '835');
check('the neighbour interface stays', uci.get('network', 'other', 'proto'), 'pppoe');

let memberships = uci.get('firewall', 'bmwanpool', 'network');
check('the zone kept only the neighbour', join(',', memberships), 'other');

report();
