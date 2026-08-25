// The command line, for a console, a serial cable, or anybody who would rather
// read the router than a web page.
//
// Everything here goes through ubus, unlike bmwan's `flush`. That is not an
// inconsistency: bmwan has to work when the daemon is gone because its rules
// outlive it and have to be taken off, and nothing this package installs does.
// A PPPoE pool keeps dialling with or without a daemon watching it, so a CLI
// that cannot reach the daemon has nothing useful to do on its own.
//
// One thing is deliberately absent: a password as an argument. `create` and
// `append` both take `--from FILE` and never a credential on the command line,
// because /proc/<pid>/cmdline is world-readable for as long as the process
// lives. `create` hands the daemon the path and lets it read and unlink the
// file itself; `append` reads it here and sends the rows over the ubus socket,
// which is a unix socket and not a command line either.

import { readfile, unlink } from 'fs';
import { connect } from 'ubus';

// What the daemon takes in one `pool_append` call. Mirrored from
// INLINE_ACCOUNTS in bm.pppoe.service; a longer file is sent as several calls.
const APPEND_CHUNK = 200;

const USAGE = 'usage: bmpppoe <command> [--json] [--pool ID]\n' +
	'\n' +
	'  status              every pool: up, dialing, down, throughput\n' +
	'  list [--all]        sessions needing attention (--all: every one)\n' +
	'  stats               memory, events handled, redials\n' +
	'  reconcile           read netifd and the counters now\n' +
	'  up SECTION...       bring named sessions up\n' +
	'  down SECTION...     take them down\n' +
	'  redial SECTION...   down then up\n' +
	'  create ID --from F  create a pool from a JSON account file (see below)\n' +
	'  append ID --from F  add more sessions to the end of an existing pool\n' +
	'  delete ID           remove a pool and every section it owns\n' +
	'  help                this text\n' +
	'\n' +
	'The account file for `create` and `append` is JSON:\n' +
	'  { "prefix": "ppp", "carrier": "eth1", "seqFrom": 1, "tableBase": 1000,\n' +
	'    "accounts": [ { "user": "a@isp", "pass": "..." }, ... ] }\n' +
	'`append` reads only "accounts" - the rest is what the pool was created as.\n' +
	'It must be in /tmp and is deleted as it is read - so write it with\n' +
	'`umask 077` and never pass a password as an argument to anything.\n';

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

let args = [];
let asJson = false;
let pool = '';
let from = '';
let all = false;
let expect = null;

for (let arg in ARGV) {
	if (expect) {
		if (expect == 'pool')
			pool = arg;
		else
			from = arg;
		expect = null;
		continue;
	}

	if (arg == '--json')
		asJson = true;
	else if (arg == '--all')
		all = true;
	else if (arg == '--pool' || arg == '-p')
		expect = 'pool';
	else if (arg == '--from' || arg == '-f')
		expect = 'from';
	else {
		let paired = match(arg, /^--(pool|from)=(.*)$/);
		if (paired && paired[1] == 'pool')
			pool = paired[2];
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

	if (!length(result.pools)) {
		printf('No pools on this router yet.\n');
		printf('Create one from the app, from LuCI, or with `bmpppoe create ID --from FILE`.\n');
		exit(0);
	}

	printf('%-12s %-10s %6s %8s %6s %6s %12s %12s\n',
		'POOL', 'CARRIER', 'UP', 'DIALING', 'DOWN', 'ERROR', 'RX', 'TX');

	for (let one in result.pools) {
		printf('%-12s %-10s %6d %8d %6d %6d %12s %12s\n',
			one.id, one.carrier, one.up, one.dialing, one.down, one.error,
			bits(one.rate.rxBps), bits(one.rate.txBps));
	}

	exit(0);
}

if (command == 'list') {
	let result = call('sessions', { id: pool, scope: all ? 'all' : 'attention' });

	if (asJson) {
		printf('%J\n', result);
		exit(0);
	}

	if (!length(result.sessions)) {
		printf(all ? 'no sessions\n' : 'nothing needs attention\n');
		exit(0);
	}

	printf('%-14s %-10s %-16s %-8s %s\n', 'SECTION', 'STATE', 'ADDRESS', 'TABLE', 'ERROR');
	for (let one in result.sessions) {
		printf('%-14s %-10s %-16s %-8s %s\n',
			one.section, one.state, one.ipv4, one.table ? sprintf('%d', one.table) : '-', one.error);
	}

	if (length(result.sessions) >= result.limit)
		printf('\n(%d shown, which is the cap - narrow it with --pool)\n', result.limit);

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

if (command == 'up' || command == 'down' || command == 'redial') {
	let names = slice(args, 1);
	if (!length(names))
		fail(command + ' which sections? try `bmpppoe list`');

	let result = call('action', { action: command, sections: names });

	if (asJson)
		printf('%J\n', result);
	else if (result.ok)
		printf('%s: %d session(s)\n', command, length(result.sections));
	else
		printf('%s\n', result.reason);

	exit(result.ok ? 0 : 1);
}

if (command == 'create') {
	if (length(args) < 2)
		fail('name the pool: `bmpppoe create ppp --from /tmp/accounts.json`');

	if (!length(from))
		fail('--from FILE is required, and the file has to be in /tmp - see `bmpppoe help`');

	let result = call('pool_create', { id: args[1], source: from });

	if (asJson)
		printf('%J\n', result);
	else if (result.ok)
		printf('created %s: %d session(s), %s%05d to %s%05d\n',
			result.id, result.created, args[1], result.seqFrom, args[1], result.seqTo);
	else
		printf('%s\n', result.reason);

	exit(result.ok ? 0 : 1);
}

/**
 * Read an account file the way the daemon reads one, and delete it.
 *
 * `append` cannot hand the path over the way `create` does: `pool_append` takes
 * its rows inline so that a web session may call it without also being able to
 * name any file in /tmp for the daemon to read and unlink as root. Which leaves
 * the reading here - and the same discipline, because a file full of passwords
 * left behind after a command that has finished with it is the thing the 0600
 * file was for.
 */
function takeAccounts(path) {
	if (!match(path, /^\/tmp\/[A-Za-z0-9._-]{1,64}$/))
		fail('--from has to be a plain file directly in /tmp');

	let raw = readfile(path);
	unlink(path);

	if (type(raw) != 'string')
		fail('cannot read ' + path);

	let value;
	try {
		value = json(raw);
	}
	catch (e) {
		fail(path + ' is not valid JSON');
	}

	if (type(value) != 'object' || type(value.accounts) != 'array' || !length(value.accounts))
		fail(path + ' lists no accounts');

	return value.accounts;
}

if (command == 'append') {
	if (length(args) < 2)
		fail('append to which pool? try `bmpppoe status`');

	if (!length(from))
		fail('--from FILE is required, and the file has to be in /tmp - see `bmpppoe help`');

	let accounts = takeAccounts(from);
	let added = 0;
	let last = null;

	// One call per chunk, and the first failure stops. Each call that succeeded
	// has already widened the pool, so what was added stays added and is
	// reported - the alternative is a command that fails at row 3000 and leaves
	// somebody guessing how much of their file went in.
	for (let offset = 0; offset < length(accounts); offset += APPEND_CHUNK) {
		let chunk = slice(accounts, offset, offset + APPEND_CHUNK);
		last = call('pool_append', { id: args[1], accounts: chunk });

		if (!last.ok)
			break;

		added += last.created;
	}

	if (asJson)
		printf('%J\n', { ok: last.ok, id: args[1], created: added, reason: last.reason });
	else if (last.ok)
		printf('appended %d session(s) to %s, now %d in the pool\n', added, args[1], last.count);
	else if (added)
		printf('%s\n(%d session(s) were added before that)\n', last.reason, added);
	else
		printf('%s\n', last.reason);

	exit(last.ok ? 0 : 1);
}

if (command == 'delete') {
	if (length(args) < 2)
		fail('delete which pool? try `bmpppoe status`');

	let result = call('pool_delete', { id: args[1] });

	if (asJson)
		printf('%J\n', result);
	else if (result.ok)
		printf('deleted %s: %d interface(s) removed\n', result.id, result.removed);
	else
		printf('%s\n', result.reason);

	exit(result.ok ? 0 : 1);
}

warn('bmpppoe: unknown command "' + command + '"\n\n');
warn(USAGE);
exit(1);
