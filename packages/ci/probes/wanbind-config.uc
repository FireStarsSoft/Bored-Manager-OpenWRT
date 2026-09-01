// What the binding daemon makes of a configuration file.
//
// The thing worth checking is not that a good instance is accepted - it is that
// a bad one is still *there*. A refused instance used to be dropped from every
// list the daemon built, which is the hardest kind of mistake to find: nothing
// is broken, nothing is red, and the row that should be there simply is not.
//
// The one-to-one bindings in the second half raise the stakes on exactly that.
// An instance nobody accepted leaves a LAN behaving as it did before anyone
// configured anything; a binding nobody accepted leaves its owner believing one
// address is pinned to one port while it takes whatever the router picked. So
// every refusal here is checked for the sentence it says, not only for having
// said no.

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

// ---------------------------------------------------------------------------
// One-to-one bindings.
//
// `home` and `spare` are the two usable instances above, and both number their
// clients from 20000. That is what every pref below is measured against: a
// binding at or over that number stops outranking the pool and starts being
// deleted by it.

// Good, and everything it does not say taken from the defaults: hold when the
// WAN is down, enabled, and named after its own section.
uci.set('bm_wanbind', 'pin', 'direct');
uci.set('bm_wanbind', 'pin', 'ip', '12.10.10.10');
uci.set('bm_wanbind', 'pin', 'wan', 'wan2');
uci.set('bm_wanbind', 'pin', 'lan', 'lan');
uci.set('bm_wanbind', 'pin', 'pref', '19000');
uci.set('bm_wanbind', 'pin', 'table', '10002');

// Good, and typed the way a Windows dialog spells a MAC.
uci.set('bm_wanbind', 'roam', 'direct');
uci.set('bm_wanbind', 'roam', 'name', 'Roaming laptop');
uci.set('bm_wanbind', 'roam', 'mac', 'A4-83-E7-11-22-33');
uci.set('bm_wanbind', 'roam', 'wan', 'wan');
uci.set('bm_wanbind', 'roam', 'when_down', 'fallback');
uci.set('bm_wanbind', 'roam', 'pref', '19001');
uci.set('bm_wanbind', 'roam', 'table', '10001');

// Refused: at 20000 the instances start counting their own client rules, so
// this one is adopted as an assignment and deleted for having no lease.
uci.set('bm_wanbind', 'high', 'direct');
uci.set('bm_wanbind', 'high', 'ip', '10.0.0.5');
uci.set('bm_wanbind', 'high', 'wan', 'wan');
uci.set('bm_wanbind', 'high', 'pref', '20000');
uci.set('bm_wanbind', 'high', 'table', '10001');

// Refused: a rule into the main table is fallback wearing a binding's name.
uci.set('bm_wanbind', 'mainish', 'direct');
uci.set('bm_wanbind', 'mainish', 'ip', '10.0.0.6');
uci.set('bm_wanbind', 'mainish', 'wan', 'wan');
uci.set('bm_wanbind', 'mainish', 'pref', '19002');
uci.set('bm_wanbind', 'mainish', 'table', '254');

// Refused: 253 is where the instances keep `unreachable default`, so this would
// read bound and drop every packet.
uci.set('bm_wanbind', 'blackhole', 'direct');
uci.set('bm_wanbind', 'blackhole', 'ip', '10.0.0.7');
uci.set('bm_wanbind', 'blackhole', 'wan', 'wan');
uci.set('bm_wanbind', 'blackhole', 'pref', '19003');
uci.set('bm_wanbind', 'blackhole', 'table', '253');

// Refused: nothing to follow.
uci.set('bm_wanbind', 'notarget', 'direct');
uci.set('bm_wanbind', 'notarget', 'wan', 'wan');
uci.set('bm_wanbind', 'notarget', 'pref', '19004');
uci.set('bm_wanbind', 'notarget', 'table', '10001');

// Refused: two things to follow, which is one too many.
uci.set('bm_wanbind', 'both', 'direct');
uci.set('bm_wanbind', 'both', 'ip', '10.0.0.8');
uci.set('bm_wanbind', 'both', 'mac', 'a4:83:e7:44:55:66');
uci.set('bm_wanbind', 'both', 'wan', 'wan');
uci.set('bm_wanbind', 'both', 'pref', '19005');
uci.set('bm_wanbind', 'both', 'table', '10001');

// Refused rather than read as hold: somebody who typed a third word asked for
// something, and quietly giving them the opposite is the whole failure mode.
uci.set('bm_wanbind', 'word', 'direct');
uci.set('bm_wanbind', 'word', 'ip', '10.0.0.9');
uci.set('bm_wanbind', 'word', 'wan', 'wan');
uci.set('bm_wanbind', 'word', 'when_down', 'drop');
uci.set('bm_wanbind', 'word', 'pref', '19006');
uci.set('bm_wanbind', 'word', 'table', '10001');

// Refused: that is the device under the interface, and netifd is asked about
// the interface.
uci.set('bm_wanbind', 'device', 'direct');
uci.set('bm_wanbind', 'device', 'ip', '10.0.0.10');
uci.set('bm_wanbind', 'device', 'wan', 'eth1.101');
uci.set('bm_wanbind', 'device', 'pref', '19007');
uci.set('bm_wanbind', 'device', 'table', '10001');

// Refused: `pin` above already follows this address, and only the lower-
// numbered rule would ever be reached.
uci.set('bm_wanbind', 'twin', 'direct');
uci.set('bm_wanbind', 'twin', 'ip', '12.10.10.10');
uci.set('bm_wanbind', 'twin', 'wan', 'wan');
uci.set('bm_wanbind', 'twin', 'pref', '19008');
uci.set('bm_wanbind', 'twin', 'table', '10001');

// Usable, switched off, and deliberately sharing `pin`'s priority: a binding
// that writes no rule collides with nothing, so switching one off has to be a
// way of freeing its number.
uci.set('bm_wanbind', 'off', 'direct');
uci.set('bm_wanbind', 'off', 'ip', '10.0.0.11');
uci.set('bm_wanbind', 'off', 'wan', 'wan');
uci.set('bm_wanbind', 'off', 'enabled', '0');
uci.set('bm_wanbind', 'off', 'pref', '19000');
uci.set('bm_wanbind', 'off', 'table', '10001');

// Refused: the daemon does not choose a priority. One picked twice, once by the
// app and once here, is two rules for one address.
uci.set('bm_wanbind', 'nopref', 'direct');
uci.set('bm_wanbind', 'nopref', 'ip', '10.0.0.12');
uci.set('bm_wanbind', 'nopref', 'wan', 'wan');
uci.set('bm_wanbind', 'nopref', 'table', '10001');

let bindings = cfg.directConfigured();
check('every binding is in directConfigured()', length(bindings), 12);

let byId = {};
for (let one in bindings)
	byId[one.id] = one;

check('pin is usable', byId.pin.usable, true);
check('and follows an address', byId.pin.targetKind, 'ip');
check('which is the one it was given', byId.pin.target.ip, '12.10.10.10');
check('holds when its WAN is down unless told otherwise', byId.pin.whenDown, 'hold');
check('and is named after its section when nothing else says', byId.pin.name, 'pin');

check('roam is usable', byId.roam.usable, true);
check('and follows a device', byId.roam.targetKind, 'mac');
check('spelled the way the lease file spells it', byId.roam.target.mac, 'a4:83:e7:11:22:33');
check('and falls back when told to', byId.roam.whenDown, 'fallback');
check('and keeps the name it was given', byId.roam.name, 'Roaming laptop');

check('high is refused', byId.high.usable, false);
says('and names the instance that would eat it', byId.high.reason, /rule_pref_base 20000/);

check('mainish is refused', byId.mainish.usable, false);
says('and says what table 254 would really do', byId.mainish.reason, /main table/);

check('blackhole is refused', byId.blackhole.usable, false);
says('and names the instance whose table that is', byId.blackhole.reason, /catch_all_table/);

check('notarget is refused', byId.notarget.usable, false);
says('and says there is nothing to follow', byId.notarget.reason, /nothing for this binding to follow/);

check('both is refused', byId.both.usable, false);
says('and says a binding follows one thing', byId.both.reason, /follows one thing/);

check('word is refused', byId.word.usable, false);
says('and offers the two answers there are', byId.word.reason, /neither hold nor fallback/);

check('device is refused', byId.device.usable, false);
says('and says an interface name is wanted', byId.device.reason, /not a UCI interface name/);

check('twin is refused', byId.twin.usable, false);
says('and names the binding that already has it', byId.twin.reason, /binding pin already follows/);

check('off is usable', byId.off.usable, true);
check('and is switched off', byId.off.enabled, false);

check('nopref is refused', byId.nopref.usable, false);
says('and says which numbers are free to take', byId.nopref.reason, /19000-19999/);

// directBindings() is what the reconcile writes rules for.
let live = cfg.directBindings();
check('directBindings() keeps the usable ones', length(live), 3);
check('in file order, pin first', live[0].id, 'pin');
check('then roam', live[1].id, 'roam');
check('then off, which is a decision and not a fault', live[2].id, 'off');

check('directBinding() finds one by name', cfg.directBinding('pin').target.ip, '12.10.10.10');
check('and does not find a refused one', cfg.directBinding('high'), null);

// The band, which has to be answered before any binding exists to be refused.
let band = cfg.directBand();
check('the shipped band starts at 19000', band.base, 19000);
check('and is 1000 wide', band.span, 1000);
check('so it ends at 19999', band.top, 19999);
check('which is below every instance here', band.usable, true);

uci.set('bm_wanbind', 'main', 'direct_pref_base', '19500');
let overlap = cfg.directBand();
check('a band that reaches into the instances is refused', overlap.usable, false);
says('and says whose range it reached into', overlap.reason, /rule_pref_base 20000/);
check('and is not quietly moved somewhere else', overlap.base, 19500);

// A base that cannot hold its own width is the one case that does fall back,
// because there is no band there to leave alone.
uci.set('bm_wanbind', 'main', 'direct_pref_base', '0');
check('a base with no band falls back to the shipped one', cfg.directBand().base, 19000);

report();
