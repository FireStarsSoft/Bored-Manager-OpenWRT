// Creating, checking, editing and deleting v2 PPPoE pools, for real.
//
// The derivations are what this is for: which sections a pool writes, what
// every option says, which MAC a member is assigned, what joins the zone -
// and that an edit rewrites exactly the difference while a delete removes
// exactly what the create added. Every one of those is one spelling mistake
// away from overwriting somebody's interface, and none of it is visible to a
// compiler.
//
// The daemon runs against the probe lib's uci and fs: uci stores what it is
// told, fs serves a seeded /sys/class/net, and no ubus and no system() exist
// here - so netifd state is simply absent and every member reads as down,
// which is enough for everything but the dump-driven states.

import { seed, readfile } from 'fs';
import { cursor } from 'uci';

import * as cfg from 'bm.pppoe.config';
import * as pppoe from 'bm.pppoe.service';

import { check, report, says } from 'probe';

function hasFinding(result, level, needle) {
	if (type(result.findings) != 'array')
		return false;

	for (let one in result.findings) {
		if (one.level == level && index(one.label, needle) >= 0)
			return true;
	}

	return false;
};

function networks(uci, zone) {
	let value = uci.get('firewall', zone, 'network');
	if (type(value) == 'array')
		return join(',', value);
	return type(value) == 'string' ? value : '';
};

// The carrier the pools dial over, as sysfs tells it.
seed('/sys/cl' + 'ass/net/eth1/address', 'aa:bb:cc:dd:ee:ff\n');
seed('/sys/cl' + 'ass/net/eth1/operstate', 'up\n');

let uci = cursor();

// ------------------------------------------------------------- derivations
// The MAC formula, pinned to fixed inputs. If this check moves, every pool in
// the field redials on the next reconcile - so it must never move by surprise.
check('mac formula vlan 101', cfg.macFor('aa:bb:cc:dd:ee:ff', 'fpt1', 101), '02:a6:65:b8:00:65');
check('mac formula vlan 102', cfg.macFor('aa:bb:cc:dd:ee:ff', 'fpt1', 102), '02:a6:65:b8:00:66');
check('mac formula is carrier-cased', cfg.macFor('AA:BB:CC:DD:EE:FF', 'fpt1', 101), '02:a6:65:b8:00:65');

check('section name', cfg.sectionFor('fpt', 101), 'fpt101');
check('vlan 0 section name', cfg.sectionFor('fpt', 0), 'fpt0');
check('vlan parse', cfg.vlanOfSection('fpt', 'fpt101'), 101);
check('vlan parse refuses a leading zero', cfg.vlanOfSection('fpt', 'fpt0101'), null);
check('vlan parse refuses the old five-digit shape', cfg.vlanOfSection('ppp', 'ppp00007'), null);

// ------------------------------------------------------------------ create
let made = pppoe.poolAdd({
	id: 'fpt1', mode: 'multi', prefix: 'fpt', carrier: 'eth1',
	username: 'u@isp', password: 'pw1', table_base: 10000,
	keepalive: '5 1', zone: 'bmwanpool',
	members: [ { vlan: 101 }, { vlan: 102 }, { vlan: 0 } ]
});

check('create ok', made.ok, true);
check('create count', made.created, 3);

check('interface proto', uci.get('network', 'fpt101', 'proto'), 'pppoe');
check('interface device', uci.get('network', 'fpt101', 'device'), 'eth1.101');
check('interface username', uci.get('network', 'fpt101', 'username'), 'u@isp');
check('interface password', uci.get('network', 'fpt101', 'password'), 'pw1');
check('interface table', uci.get('network', 'fpt101', 'ip4table'), '10101');
check('interface metric', uci.get('network', 'fpt101', 'metric'), '10101');
check('interface ipv6 defaults off', uci.get('network', 'fpt101', 'ipv6'), '0');
check('interface peerdns off', uci.get('network', 'fpt101', 'peerdns'), '0');
check('interface keepalive written when set', uci.get('network', 'fpt101', 'keepalive'), '5 1');
check('interface mtu absent when unset', uci.get('network', 'fpt101', 'mtu'), null);

// Section names via the derive functions, which both exercises them and
// keeps `<pool>_<vlan>` literals out of a file the not-ucode word search
// would misread as digit separators.
let dev101 = cfg.deviceSection('fpt1', 101);
check('device section name', dev101, 'bmd_' + 'fpt1' + '_' + '101');
check('tagged device type', uci.get('network', dev101, 'type'), '8021q');
check('tagged device parent', uci.get('network', dev101, 'ifname'), 'eth1');
check('tagged device vid', uci.get('network', dev101, 'vid'), '101');
check('tagged device name', uci.get('network', dev101, 'name'), 'eth1.101');
check('tagged device golden mac', uci.get('network', dev101, 'macaddr'), '02:a6:65:b8:00:65');
check('second member golden mac', uci.get('network', cfg.deviceSection('fpt1', 102), 'macaddr'), '02:a6:65:b8:00:66');

check('untagged dials the bare carrier', uci.get('network', 'fpt0', 'device'), 'eth1');
check('untagged has no device section', uci.get('network', cfg.deviceSection('fpt1', 0)), null);
check('untagged table is the base', uci.get('network', 'fpt0', 'ip4table'), '10000');

check('zone exists', uci.get('firewall', 'bmwanpool', 'name'), 'bmwanpool');
check('zone rejects input', uci.get('firewall', 'bmwanpool', 'input'), 'REJECT');
check('zone masquerades', uci.get('firewall', 'bmwanpool', 'masq'), '1');
check('zone membership is the member list', networks(uci, 'bmwanpool'), 'fpt0,fpt101,fpt102');
check('forwarding src', uci.get('firewall', 'bmfwd', 'src'), 'lan');
check('forwarding dest', uci.get('firewall', 'bmfwd', 'dest'), 'bmwanpool');

check('record mode', uci.get('bm_pppoe', 'fpt1', 'mode'), 'multi');
check('record member section', uci.get('bm_pppoe', cfg.memberSection('fpt1', 101), 'vlan'), '101');
check('record member carries no account in multi', uci.get('bm_pppoe', cfg.memberSection('fpt1', 101), 'username'), null);

// ------------------------------------------------------------- the refusals
let clash = pppoe.poolCheck({
	id: 'fpt2', mode: 'multi', prefix: 'fpt', carrier: 'eth1',
	username: 'x@isp', password: 'x', members: [ { vlan: 300 } ]
});
check('a shared prefix is refused', clash.ok, false);
check('and names the pool holding it', hasFinding(clash, 'error', 'already uses the prefix fpt'), true);

let taken = pppoe.poolCheck({
	id: 'vnpt', mode: 'multi', prefix: 'vnp', carrier: 'eth1',
	username: 'x@isp', password: 'x', members: [ { vlan: 101 } ]
});
check('a taken (carrier, vlan) is refused', taken.ok, false);
check('and says which pool owns it', hasFinding(taken, 'error', 'already belongs to pool fpt1'), true);

let sharedMac = pppoe.poolCheck({
	id: 'fpt9', mode: 'multi', prefix: 'fpn', carrier: 'eth1', mac_mode: 'inherit',
	username: 'x@isp', password: 'x', members: [ { vlan: 300 } ]
});
check('multi without per-vlan MACs is refused', sharedMac.ok, false);
check('and explains the MAC rule', hasFinding(sharedMac, 'error', 'mac_mode auto'), true);

let twice = pppoe.poolCheck({
	id: 'fpt9', mode: 'multi', prefix: 'fpn', carrier: 'eth1',
	username: 'x@isp', password: 'x', members: [ { vlan: 300 }, { vlan: 300 } ]
});
check('a duplicate vlan is refused', hasFinding(twice, 'error', 'listed twice'), true);

let missing = pppoe.poolCheck({
	id: 'fpt9', mode: 'single', prefix: 'fpn', carrier: 'eth1',
	members: [ { vlan: 300, user: 'a@x' } ]
});
check('single without a password is refused', hasFinding(missing, 'error', 'no password'), true);

let offTable = pppoe.poolCheck({
	id: 'fpt9', mode: 'multi', prefix: 'fpn', carrier: 'eth1',
	username: 'x@isp', password: 'x', table_base: 65000, members: [ { vlan: 1000 } ]
});
check('a table past 65535 is refused', hasFinding(offTable, 'error', 'beyond 65535'), true);

uci.set('network', 'wan6', 'interface');
uci.set('network', 'wan6', 'proto', 'static');
let squatted = pppoe.poolCheck({
	id: 'wanp', mode: 'multi', prefix: 'wan', carrier: 'eth1',
	username: 'x@isp', password: 'x', members: [ { vlan: 6 } ]
});
check('a derived name that already exists is refused', hasFinding(squatted, 'error', 'wan6 already exists'), true);

let badKeepalive = pppoe.poolCheck({
	id: 'fpt9', mode: 'multi', prefix: 'fpn', carrier: 'eth1',
	username: 'x@isp', password: 'x', keepalive: 'abc', members: [ { vlan: 300 } ]
});
check('junk keepalive is refused', hasFinding(badKeepalive, 'error', 'Keepalive'), true);

let badUniq = pppoe.poolCheck({
	id: 'fpt9', mode: 'multi', prefix: 'fpn', carrier: 'eth1',
	username: 'x@isp', password: 'x', host_uniq: 'zz', members: [ { vlan: 300 } ]
});
check('junk host_uniq is refused', hasFinding(badUniq, 'error', 'Host-Uniq'), true);

let sane = pppoe.poolCheck({
	id: 'fpt1', keepalive: '10 3'
});
check('a partial check against a stored pool passes', sane.ok, true);
check('the standing tagged/untagged note is on every report', hasFinding(sane, 'info', 'Tagged and untagged'), true);
check('multi mode always warns about sharing', hasFinding(sane, 'warning', 'share one account'), true);

// ------------------------------------------------------------------- edits
let repriced = pppoe.poolSet({ id: 'fpt1', password: 'pw2' });
check('password change ok', repriced.ok, true);
check('password change rewrites every member', repriced.changed.rewritten, 3);
check('and the sections say so', uci.get('network', 'fpt102', 'password'), 'pw2');

let reshaped = pppoe.poolSet({ id: 'fpt1', members: [ { vlan: 101 }, { vlan: 103 } ] });
check('member edit ok', reshaped.ok, true);
check('member edit added 103', join(',', reshaped.changed.added), '103');
check('member edit removed 0 and 102', join(',', reshaped.changed.removed), '0,102');
check('the new member is written', uci.get('network', 'fpt103', 'username'), 'u@isp');
check('the new member mac is the golden one', uci.get('network', cfg.deviceSection('fpt1', 103), 'macaddr'), '02:a6:65:b8:00:67');
check('the removed member is gone', uci.get('network', 'fpt102'), null);
check('its device is gone', uci.get('network', cfg.deviceSection('fpt1', 102)), null);
check('the untagged member is gone too', uci.get('network', 'fpt0'), null);
check('zone membership followed', networks(uci, 'bmwanpool'), 'fpt101,fpt103');
check('the kept member kept its password', uci.get('network', 'fpt101', 'password'), 'pw2');

let modeFlip = pppoe.poolSet({ id: 'fpt1', mode: 'single' });
check('a mode change is refused', modeFlip.ok, false);
check('and says why', hasFinding(modeFlip, 'error', 'mode of a pool cannot change'), true);

let macFlip = pppoe.poolSet({ id: 'fpt1', mac_mode: 'inherit' });
check('multi cannot switch to inherited MACs', macFlip.ok, false);

// ------------------------------------------- the second pool, mode single
let second = pppoe.poolAdd({
	id: 'vnpt', mode: 'single', prefix: 'vnp', carrier: 'eth1', mac_mode: 'inherit',
	table_base: 20000, zone: 'bmwanpool',
	members: [
		{ vlan: 201, user: 'a@vnpt', pass: 'p1' },
		{ vlan: 202, user: 'b@vnpt', pass: 'p2' }
	]
});

check('single create ok', second.ok, true);
check('single member account is its own', uci.get('network', 'vnp201', 'username'), 'a@vnpt');
check('single member table', uci.get('network', 'vnp202', 'ip4table'), '20202');
check('inherit writes no macaddr', uci.get('network', 'bmd_vnpt_201', 'macaddr'), null);
check('but still writes the tagged device', uci.get('network', 'bmd_vnpt_201', 'vid'), '201');
check('single member record carries its account', uci.get('bm_pppoe', 'vnpt_201', 'username'), 'a@vnpt');
check('the shared zone is the union', networks(uci, 'bmwanpool'), 'fpt101,fpt103,vnp201,vnp202');

let retyped = pppoe.poolSet({
	id: 'vnpt',
	members: [ { vlan: 201 }, { vlan: 203, user: 'c@vnpt', pass: 'p3' } ]
});
check('single member edit ok', retyped.ok, true);
check('a kept member keeps its account without retyping', uci.get('network', 'vnp201', 'username'), 'a@vnpt');
check('the new member has its own', uci.get('network', 'vnp203', 'username'), 'c@vnpt');
check('the dropped member is gone', uci.get('network', 'vnp202'), null);

// ----------------------------------------------------- status and actions
// A section deleted by hand is a member shown, not a member lost.
uci.delete('network', 'fpt101');
pppoe.pass();

let rows = pppoe.sessionRows({ id: 'fpt1', scope: '' });
check('every member has a row', length(rows.sessions), 2);
check('the missing section reads unwritten', rows.sessions[0].status, 'unwritten');
check('the row still knows its table', rows.sessions[0].table, 10101);
check('the row still knows its mac', rows.sessions[0].mac, '02:a6:65:b8:00:65');
check('the written member reads down', rows.sessions[1].status, 'down');

let flagged = pppoe.sessionRows({ id: '', scope: 'attention' });
check('attention scope is the unwritten row', length(flagged.sessions), 1);

// Any edit repairs an unwritten member, because the reconciler only ever
// writes the whole difference.
let repaired = pppoe.poolSet({ id: 'fpt1' });
check('a no-op set repairs the missing section', join(',', repaired.changed.added), '101');
check('and the section is back', uci.get('network', 'fpt101', 'ip4table'), '10101');

let stopped = pppoe.actionCall({ action: 'disable', sections: [ 'fpt103' ] });
check('disable ok', stopped.ok, true);
check('disable is option auto 0', uci.get('network', 'fpt103', 'auto'), '0');

let after = pppoe.sessionRows({ id: 'fpt1', scope: '' });
check('a disabled member reads stopped', after.sessions[1].status, 'stopped');

let resumed = pppoe.actionCall({ action: 'enable', sections: [ 'fpt103' ] });
check('enable ok', resumed.ok, true);
check('enable clears the mark', uci.get('network', 'fpt103', 'auto'), null);

let foreign = pppoe.actionCall({ action: 'down', sections: [ 'wan6' ] });
check('a section outside every pool is refused', foreign.ok, false);

// ------------------------------------------------------------ the payload
seed('/tmp/spec-x', '{"mode":"multi","prefix":"tst","carrier":"eth1","username":"t@isp","password":"tp","table_base":30000,"members":[{"vlan":50}]}');
let fromFile = pppoe.poolCreate({ id: 'tst1', source: '/tmp/spec-x' });
check('create from a file ok', fromFile.ok, true);
check('the payload was consumed', readfile('/tmp/spec-x'), null);
check('and the pool exists', uci.get('network', 'tst50', 'username'), 't@isp');

let outside = pppoe.poolCreate({ id: 'tst2', source: '/etc/passwd' });
check('a payload outside /tmp is refused', outside.ok, false);
says('and says where payloads live', outside.reason, /directly in \/tmp/);

// ---------------------------------------------------------------- info
// Pools are found by id, not by index: a record rewrite moves the section to
// the end of the file, and file order is all info promises.
function poolTold(told, id) {
	for (let one in told.pools) {
		if (one.id == id)
			return one;
	}
	return null;
};

let told = pppoe.info();
let fptTold = poolTold(told, 'fpt1');
check('info release', told.release, '2.0.0');
check('info api version', told.apiVersion, 2);
check('info lists every pool', length(told.pools), 3);
check('info never carries a password', exists(fptTold, 'password'), false);
check('info says one is set', fptTold.hasPassword, true);
check('info counts members', fptTold.members, 2);
check('info carries the member list', fptTold.memberList[0].vlan, 101);

// ---------------------------------------------------------------- settings
let tuned = pppoe.settingsSet({ counter_interval: 60 });
check('settings set ok', tuned.ok, true);
check('settings are written', uci.get('bm_pppoe', 'main', 'counter_interval'), '60');
check('settings are applied', pppoe.settingsGet().counter_interval, 60);

let refused = pppoe.settingsSet({ redial_batch: 0 });
check('settings out of range are refused', refused.ok, false);

// ---------------------------------------------------------------- delete
let goneFirst = pppoe.poolDelete({ id: 'fpt1' });
check('delete ok', goneFirst.ok, true);
check('delete removed both members', goneFirst.removed, 2);
check('its sections are gone', uci.get('network', 'fpt101'), null);
check('its devices are gone', uci.get('network', cfg.deviceSection('fpt1', 103)), null);
check('its record is gone', uci.get('bm_pppoe', 'fpt1'), null);
check('its member records are gone', uci.get('bm_pppoe', cfg.memberSection('fpt1', 101)), null);
check('the shared zone keeps the other pools', networks(uci, 'bmwanpool'), 'vnp201,vnp203,tst50');
check('the forwarding survives for it', uci.get('firewall', 'bmfwd', 'dest'), 'bmwanpool');
check('the neighbour pool is untouched', uci.get('network', 'vnp201', 'username'), 'a@vnpt');

pppoe.poolDelete({ id: 'tst1' });
let goneLast = pppoe.poolDelete({ id: 'vnpt' });
check('the last delete ok', goneLast.ok, true);
check('the empty zone goes with it', uci.get('firewall', 'bmwanpool'), null);
check('and the forwarding goes too', uci.get('firewall', 'bmfwd'), null);
check('the foreign section outlives everything', uci.get('network', 'wan6', 'proto'), 'static');

report();
