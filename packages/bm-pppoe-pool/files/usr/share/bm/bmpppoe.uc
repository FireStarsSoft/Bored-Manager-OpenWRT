// The command line, for a console, a serial cable, or anybody who would
// rather read the router than a web page.
//
// Everything here goes through ubus, unlike bmwan's `flush`. That is not an
// inconsistency: bmwan has to work when the daemon is gone because its rules
// outlive it and have to be taken off, and nothing this package installs
// does. A PPPoE pool keeps dialling with or without a daemon watching it, so
// a CLI that cannot reach the daemon has nothing useful to do on its own.
//
// One thing is deliberately absent: a credential as an argument. `create`,
// `set` and `check` all take `--from FILE` and never a password on the
// command line, because /proc/<pid>/cmdline is world-readable for as long as
// the process lives. The file is handed to the daemon by path; the daemon
// reads and unlinks it as root.

import { connect } from 'ubus';

const USAGE = 'usage: bmpppoe <command> [--json] [--pool ID]\n' +
	'\n' +
	'  status                 every pool: mode, members, states, throughput\n' +
	'  list [--all]           every member row (--pool ID to narrow)\n' +
	'  carriers               devices a pool could dial over\n' +
	'  stats                  memory, events handled, redials\n' +
	'  reconcile              read netifd and the counters now\n' +
	'  up SECTION...          bring named members up\n' +
	'  down SECTION...        take them down\n' +
	'  redial SECTION...      down then up\n' +
	'  enable SECTION...      clear the Disable mark and dial\n' +
	'  disable SECTION...     stop and keep stopped across reboots\n' +
	'  check ID --from F      validate a pool spec, write nothing\n' +
	'  create ID --from F     create a pool from a JSON spec file\n' +
	'  set ID --from F        apply a partial spec to an existing pool\n' +
	'  delete ID [--force]    remove a pool and everything it wrote\n' +
	'  settings [--set k=v]   read or change the daemon settings\n' +
	'  help                   this text\n' +
	'\n' +
	'The spec file is JSON, in /tmp, and is deleted as it is read - write it\n' +
	'with `umask 077` and never pass a password as an argument to anything:\n' +
	'  { "mode": "multi", "prefix": "fpt", "carrier": "eth1",\n' +
	'    "username": "user@isp", "password": "...", "table_base": 10000,\n' +
	'    "members": [ { "vlan": 101 }, { "vlan": 102 } ] }\n' +
	'mode "single" carries the account per member instead:\n' +
	'  "members": [ { "vlan": 101, "user": "a@isp", "pass": "..." } ]\n' +
	'"carrier_mode": "direct" dials the carrier itself, untagged, and the\n' +
	'member numbers become slots: mac_mode auto gives every slot its own\n' +
	'macvlan and MAC, mac_mode inherit shares the carrier MAC and derives a\n' +
	'Host-Uniq per slot instead.\n' +
	'`check` consumes the file too: write it again before create or set.\n';

function bus() {
	let conn = connect();
	if (!conn)
		return null;

	let objects = conn.list();
	if (type(objects) != 'array' || !('bm.pppoe' in objects))
		return null;

	return conn;
};

function fail(message) {
	warn('bmpppoe: ' + message + '\n');
	exit(1);
};

function call(method, args) {
	let conn = bus();
	if (!conn)
		fail('bm.pppoe is not answering. Is /etc/init.d/bm-pppoe running?');

	let result = conn.call('bm.pppoe', method, args);
	if (type(result) != 'object')
		fail('bm.pppoe gave no answer to ' + method);

	return result;
};

/** `1234567` -> `1.2 Mbit/s`. Rates are read, not compared. */
function bits(bytesPerSecond) {
	let b = bytesPerSecond * 8;

	if (b >= 1000000000)
		return sprintf('%d.%d Gbit/s', b / 1000000000, (b % 1000000000) / 100000000);
	if (b >= 1000000)
		return sprintf('%d.%d Mbit/s', b / 1000000, (b % 1000000) / 100000);
	if (b >= 1000)
		return sprintf('%d kbit/s', b / 1000);

	return sprintf('%d bit/s', b);
};

function printFindings(findings) {
	for (let one in findings) {
		printf('  %-8s %s\n', uc(one.level), one.label);
		if (length(one.detail))
			printf('           %s\n', one.detail);
	}
};

let args = [];
let asJson = false;
let pool = '';
let from = '';
let all = false;
let force = false;
let sets = [];
let expect = null;

for (let arg in ARGV) {
	if (expect) {
		if (expect == 'pool')
			pool = arg;
		else if (expect == 'set')
			push(sets, arg);
		else
			from = arg;
		expect = null;
		continue;
	}

	if (arg == '--json')
		asJson = true;
	else if (arg == '--all')
		all = true;
	else if (arg == '--force')
		force = true;
	else if (arg == '--pool' || arg == '-p')
		expect = 'pool';
	else if (arg == '--from' || arg == '-f')
		expect = 'from';
	else if (arg == '--set')
		expect = 'set';
	else {
		let paired = match(arg, /^--(pool|from|set)=(.*)$/);
		if (paired && paired[1] == 'pool')
			pool = paired[2];
		else if (paired && paired[1] == 'set')
			push(sets, paired[2]);
		else if (paired)
			from = paired[2];
		else
			push(args, arg);
	}
}

let command = length(args) ? args[0] : 'help';

if (command == 'help' || command == '-h' || command == '--help') {
	print(USAGE);
	exit(0);
}

if (command == 'status') {
	let result = call('info', {});

	if (asJson) {
		printf('%J\n', result);
		exit(0);
	}

	printf('bm-pppoe-pool %s (module API %d), up %ds\n\n',
		result.release, result.apiVersion, result.uptime);

	if (!length(result.pools) && !length(result.legacy)) {
		printf('No pools on this router yet.\n');
		printf('Create one from the app, from LuCI, or with `bmpppoe create ID --from FILE`.\n');
		exit(0);
	}

	if (length(result.pools)) {
		printf('%-12s %-7s %-10s %7s %4s %5s %5s %6s %5s %10s %10s\n',
			'POOL', 'MODE', 'CARRIER', 'MEMBERS', 'UP', 'DIAL', 'DOWN', 'ERROR', 'STOP', 'RX', 'TX');

		for (let one in result.pools) {
			printf('%-12s %-7s %-10s %7d %4d %5d %5d %6d %5d %10s %10s\n',
				one.id, one.mode, one.carrier, one.members, one.up, one.dialing,
				one.down, one.error, one.stopped, bits(one.rate.rxBps), bits(one.rate.txBps));

			if (one.unwritten)
				printf('  %d member(s) are recorded but not written - run `bmpppoe set %s --from FILE` or delete the pool\n',
					one.unwritten, one.id);
		}
	}

	if (length(result.legacy)) {
		printf('\nPools from the old model - only delete works on these:\n');
		for (let one in result.legacy) {
			printf('  %-12s prefix %-5s carrier %-10s sessions %d (delete and recreate as a VLAN pool)\n',
				one.id, one.prefix, one.carrier, one.count);
		}
	}

	exit(0);
}

if (command == 'list') {
	let result = call('sessions', { id: pool, scope: all ? 'all' : '' });

	if (asJson) {
		printf('%J\n', result);
		exit(0);
	}

	if (!length(result.sessions)) {
		printf('no members\n');
		exit(0);
	}

	printf('%-12s %5s %-12s %-10s %-16s %-8s %s\n',
		'SECTION', 'VLAN', 'DEVICE', 'STATE', 'ADDRESS', 'TABLE', 'ERROR');
	for (let one in result.sessions) {
		printf('%-12s %5d %-12s %-10s %-16s %-8d %s\n',
			one.section, one.vlan, one.device, one.status, one.ip, one.table, one.errorCode);
	}

	if (length(result.sessions) >= result.limit)
		printf('\n(%d shown, which is the cap - narrow it with --pool)\n', result.limit);

	exit(0);
}

if (command == 'carriers') {
	let result = call('carriers', {});

	if (asJson) {
		printf('%J\n', result);
		exit(0);
	}

	if (!result.ok)
		fail(result.reason);

	printf('%-16s %-6s %s\n', 'DEVICE', 'UP', 'MAC');
	for (let one in result.carriers)
		printf('%-16s %-6s %s\n', one.name, one.up ? 'up' : 'down', one.macaddr);

	exit(0);
}

if (command == 'stats') {
	printf('%J\n', call('stats', {}));
	exit(0);
}

if (command == 'reconcile') {
	let result = call('reconcile', {});
	printf(asJson ? '%J\n' : 'read %d pool(s)\n', asJson ? result : result.pools);
	exit(0);
}

if (command in [ 'up', 'down', 'redial', 'enable', 'disable' ]) {
	let names = slice(args, 1);
	if (!length(names))
		fail(command + ' which sections? try `bmpppoe list`');

	let result = call('action', { action: command, sections: names });

	if (asJson)
		printf('%J\n', result);
	else if (result.ok)
		printf('%s: %d member(s)\n', command, length(result.sections));
	else
		printf('%s\n', result.reason);

	exit(result.ok ? 0 : 1);
}

if (command == 'check') {
	if (length(args) < 2)
		fail('check what? `bmpppoe check fpt1 --from /tmp/spec.json`');

	if (!length(from))
		fail('--from FILE is required, and the file has to be in /tmp - see `bmpppoe help`');

	let result = call('pool_check', { id: args[1], source: from });

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (type(result.findings) == 'array')
		printFindings(result.findings);
	else
		printf('%s\n', result.reason);

	printf(result.ok
		? '\nThe spec passes. The file was consumed - write it again for create or set.\n'
		: '\nThe spec does not pass.\n');

	exit(result.ok ? 0 : 1);
}

if (command == 'create') {
	if (length(args) < 2)
		fail('name the pool: `bmpppoe create fpt1 --from /tmp/spec.json`');

	if (!length(from))
		fail('--from FILE is required, and the file has to be in /tmp - see `bmpppoe help`');

	let result = call('pool_create', { id: args[1], source: from });

	if (asJson)
		printf('%J\n', result);
	else if (result.ok)
		printf('created %s: %d interface(s), firewall included\n', result.id, result.created);
	else {
		printf('%s\n', result.reason);
		if (type(result.findings) == 'array')
			printFindings(result.findings);
	}

	exit(result.ok ? 0 : 1);
}

if (command == 'set') {
	if (length(args) < 2)
		fail('set which pool? try `bmpppoe status`');

	if (!length(from))
		fail('--from FILE is required, and the file has to be in /tmp - see `bmpppoe help`');

	let result = call('pool_set', { id: args[1], source: from });

	if (asJson)
		printf('%J\n', result);
	else if (result.ok)
		printf('set %s: %d added, %d removed, %d rewritten\n', result.id,
			length(result.changed.added), length(result.changed.removed), result.changed.rewritten);
	else {
		printf('%s\n', result.reason);
		if (type(result.findings) == 'array')
			printFindings(result.findings);
	}

	exit(result.ok ? 0 : 1);
}

if (command == 'delete') {
	if (length(args) < 2)
		fail('delete which pool? try `bmpppoe status`');

	let result = call('pool_delete', { id: args[1], force: force });

	if (asJson)
		printf('%J\n', result);
	else if (result.ok)
		printf('deleted %s: %d interface(s) removed\n', result.id, result.removed);
	else
		printf('%s\n', result.reason);

	exit(result.ok ? 0 : 1);
}

if (command == 'settings') {
	if (!length(sets)) {
		printf('%J\n', call('settings_get', {}));
		exit(0);
	}

	let change = {};
	for (let one in sets) {
		let pair = match(one, /^(enabled|counter_interval|redial_after|redial_batch)=([0-9]+)$/);
		if (!pair)
			fail('--set takes enabled=0|1, counter_interval=N, redial_after=N or redial_batch=N, not "' + one + '"');

		change[pair[1]] = int(pair[2]);
	}

	let result = call('settings_set', change);

	if (asJson)
		printf('%J\n', result);
	else if (result.ok)
		printf('%J\n', result.settings);
	else
		printf('%s\n', result.reason);

	exit(result.ok ? 0 : 1);
}

warn('bmpppoe: unknown command "' + command + '"\n\n');
warn(USAGE);
exit(1);
