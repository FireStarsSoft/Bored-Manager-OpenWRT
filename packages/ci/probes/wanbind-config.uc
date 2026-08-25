// What the binding daemon makes of a configuration file.
//
// The thing worth checking is not that a good instance is accepted - it is that
// a bad one is still *there*. A refused instance used to be dropped from every
// list the daemon built, which is the hardest kind of mistake to find: nothing
// is broken, nothing is red, and the row that should be there simply is not.

import { cursor } from 'uci';

import * as cfg from 'bm.wanbind.config';

import { check, report, says } from 'probe';

let uci = cursor();

// Good.
uci.set('bm_wanbind', 'home', 'instance');
uci.set('bm_wanbind', 'home', 'lan', 'lan');
uci.set('bm_wanbind', 'home', 'carrier', 'eth1');

// Refused: only 32 priorities between the client range and the catch-all, which
// is also the most clients it could ever seat.
uci.set('bm_wanbind', 'narrow', 'instance');
uci.set('bm_wanbind', 'narrow', 'lan', 'lan2');
uci.set('bm_wanbind', 'narrow', 'carrier', 'eth2');
uci.set('bm_wanbind', 'narrow', 'rule_pref_base', '20000');
uci.set('bm_wanbind', 'narrow', 'catch_all_pref', '20032');

// Refused: an unreachable default in the router's own main table would take the
// router off the network.
uci.set('bm_wanbind', 'mainbl', 'instance');
uci.set('bm_wanbind', 'mainbl', 'lan', 'lan3');
uci.set('bm_wanbind', 'mainbl', 'carrier', 'eth3');
uci.set('bm_wanbind', 'mainbl', 'catch_all_table', '254');

// Refused: no carrier, so there are no WANs to hand out.
uci.set('bm_wanbind', 'nowan', 'instance');
uci.set('bm_wanbind', 'nowan', 'lan', 'lan5');

// Usable, and switched off. Being off is a decision, not a configuration that
// cannot be read, so it stays in both lists.
uci.set('bm_wanbind', 'spare', 'instance');
uci.set('bm_wanbind', 'spare', 'lan', 'lan4');
uci.set('bm_wanbind', 'spare', 'carrier', 'eth4');
uci.set('bm_wanbind', 'spare', 'enabled', '0');

let all = cfg.configured();
check('every section is in configured()', length(all), 5);

let by = {};
for (let one in all)
	by[one.id] = one;

check('home is usable', by.home.usable, true);
check('home has nothing to say', by.home.reason, null);

check('narrow is refused', by.narrow.usable, false);
says('and says how many priorities it has', by.narrow.reason, /only 32 ip rule priorities/);

check('mainbl is refused', by.mainbl.usable, false);
says('and says what table 254 is', by.mainbl.reason, /main or local table/);

check('nowan is refused', by.nowan.usable, false);
says('and says what a carrier is for', by.nowan.reason, /no WANs to hand out/);

check('spare is usable', by.spare.usable, true);
check('and is switched off', by.spare.enabled, false);

// instances() is what the engine runs on.
let usable = cfg.instances();
check('instances() keeps the usable ones', length(usable), 2);
check('in file order, home first', usable[0].id, 'home');
check('then spare', usable[1].id, 'spare');

// The defaults in the shipped config file are the defaults here.
check('default priority base', by.home.rulePrefBase, 20000);
check('default catch-all priority', by.home.catchAllPref, 30000);
check('default catch-all table', by.home.catchAllTable, 253);
check('sticky is on unless it is turned off', by.home.sticky, true);

report();
