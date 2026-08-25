// The command line, for a console, a serial cable, or anybody who would rather
// read the router than a web page.
//
// Two kinds of command, and the difference matters:
//
//   asking      goes through ubus, because only the running process knows who
//               holds which WAN right now
//   flushing    does not, because the moment this is needed is usually the
//               moment the service is not answering - `prerm` runs it after
//               procd has already stopped the daemon, and a CLI that could
//               only relay ubus would leave every rule on the router
//
// So `bmwan flush` reads the configuration and the router's own ip rules and
// takes them off itself. `apk del bm-wanbind` at a shell then leaves exactly
// the same router behind as pressing Remove in the app, which is the promise
// every package here has to keep.

import { cursor } from 'uci';
import { connect } from 'ubus';

import * as cfg from 'bm.wanbind.config';
import * as netlink from 'bm.wanbind.netlink';
import * as ruleset from 'bm.wanbind.rules';

const USAGE = 'usage: bmwan <command> [--json] [--instance NAME]\n' +
	'\n' +
	'  status          instances, how many are bound, how many are waiting\n' +
	'  list            every client and the WAN it is on\n' +
	'  waiting         every client that has none, and why\n' +
	'  stats           memory, events handled, and the last pass time\n' +
	'  check           read the configuration and say what is wrong with it\n' +
	'  instance delete NAME\n' +
	'                  take an instance\'s rules off, then remove its section\n' +
	'  reconcile       run a full pass now\n' +
	'  pin MAC WAN     put one client on one WAN\n' +
	'  reassign MAC    move it to a different WAN, whichever one is free\n' +
	'  unassign MAC    take it off and keep it off\n' +
	'  release MAC     let it back into the pool\n' +
	'  flush           remove every rule this package wrote (no service needed)\n' +
	'  help            this text\n' +
	'\n' +
	'Instances are added and edited with uci, or from LuCI under Services ->\n' +
	'Bored Manager. `check` is what tells you whether the daemon will accept one.\n' +
	'\n' +
	'Whatever writes them, take an instance\'s rules off *before* switching it\n' +
	'off, deleting it, or moving rule_pref_base, catch_all_pref or lan:\n' +
	'\n' +
	'  bmwan flush --instance NAME\n' +
	'\n' +
	'A rule is recognised by where it sits, so a section that has gone or moved\n' +
	'is a set of rules nothing left on the router will admit to. `instance\n' +
	'delete` does the two steps in that order for you.\n';

function bus() {
	let conn = connect();
	if (!conn)
		return null;

	let objects = conn.list();
	if (type(objects) != 'array' || !('bm.wanbind' in objects))
		return null;

	return conn;
}

function fail(message) {
	warn('bmwan: ' + message + '\n');
	exit(1);
}

function call(method, args) {
	let conn = bus();
	if (!conn) {
		fail('bm.wanbind is not answering. Is /etc/init.d/bm-wanbind running? ' +
			'`bmwan flush` works without it.');
	}

	let result = conn.call('bm.wanbind', method, args);
	if (type(result) != 'object')
		fail('bm.wanbind gave no answer to ' + method);

	return result;
}

function ago(at) {
	if (type(at) != 'int' || at <= 0)
		return 'unknown';

	let delta = time() - at;
	if (delta < 0)
		return 'in the future (check the router clock)';
	if (delta < 90)
		return sprintf('%ds ago', delta);
	if (delta < 5400)
		return sprintf('%dm ago', delta / 60);
	if (delta < 172800)
		return sprintf('%dh ago', delta / 3600);
	return sprintf('%dd ago', delta / 86400);
}

let args = [];
let asJson = false;
let instance = '';
let expect = null;

for (let arg in ARGV) {
	if (expect) {
		instance = arg;
		expect = null;
		continue;
	}

	if (arg == '--json') {
		asJson = true;
	}
	else if (arg == '--instance' || arg == '-i') {
		expect = 'instance';
	}
	else {
		let paired = match(arg, /^--instance=(.*)$/);
		if (paired)
			instance = paired[1];
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

	printf('bm-wanbind %s (module API %d), up %ds\n\n',
		result.release, result.apiVersion, result.uptime);

	if (!length(result.instances)) {
		printf('No instances are configured. Add one to /etc/config/bm_wanbind,\n');
		printf('or create one from the app or from LuCI.\n');
		exit(0);
	}

	printf('%-12s %-18s %-7s %6s %8s %6s\n', 'INSTANCE', 'LAN', 'READY', 'BOUND', 'WAITING', 'FREE');
	for (let one in result.instances) {
		printf('%-12s %-18s %-7s %6d %8d %6d\n',
			one.id, one.lanCidr ? one.lanCidr : one.lan, one.ready ? 'yes' : 'NO',
			one.bound, one.waiting, one.free);

		if (!one.ready && length(one.reason))
			printf('  %s\n', one.reason);
	}

	exit(0);
}

if (command == 'list') {
	let result = call('assignments', { instance: instance });

	if (asJson) {
		printf('%J\n', result);
		exit(0);
	}

	if (!length(result.assignments)) {
		printf('nothing is bound yet\n');
		exit(0);
	}

	printf('%-18s %-16s %-16s %-10s %s\n', 'MAC', 'IP', 'WAN', 'SINCE', 'HOST');
	for (let one in result.assignments) {
		printf('%-18s %-16s %-16s %-10s %s\n',
			one.mac, one.ip, one.wan, ago(one.assignedAt), one.host);
	}

	exit(0);
}

if (command == 'waiting') {
	let result = call('waiting', { instance: instance });

	if (asJson) {
		printf('%J\n', result);
		exit(0);
	}

	if (!length(result.waiting)) {
		printf('nobody is waiting\n');
		exit(0);
	}

	printf('%-18s %-16s %-10s %s\n', 'MAC', 'IP', 'WAITING', 'WHY');
	for (let one in result.waiting)
		printf('%-18s %-16s %-10s %s\n', one.mac, one.ip, ago(one.since), one.reason);

	exit(0);
}

if (command == 'stats') {
	let result = call('stats', {});
	printf('%J\n', result);
	exit(0);
}

if (command == 'reconcile') {
	let result = call('reconcile', { instance: instance });

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		exit(1);
	}

	for (let one in result.passes) {
		if (!one.ok) {
			printf('%s: %s\n', one.instance ? one.instance : '?', one.reason);
			continue;
		}

		printf('%s: %d bound, %d waiting, %d stray rule(s) removed, %dms\n',
			one.instance, one.bound, one.waiting, one.removedStrays, one.passMs);
	}

	exit(0);
}

if (command == 'pin') {
	if (length(args) < 3)
		fail('pin which client to which WAN? try `bmwan pin 00:11:22:33:44:55 wan_101`');

	let result = call('pin', { instance: instance, mac: args[1], wan: args[2] });

	if (asJson)
		printf('%J\n', result);
	else
		printf('%s\n', result.ok ? sprintf('%s is on %s', result.mac, result.wan) : result.reason);

	exit(result.ok ? 0 : 1);
}

/*
 * Move one client to a different line.
 *
 * Not `unassign` followed by `release`: that would free the WAN, put the client
 * back in the queue, and its sticky choice would hand it straight back the line
 * it just came off. This is the one call that says "anything but that one",
 * which is what somebody asking for it means.
 *
 * A client that ends up with no WAN at all is still a success here - it was
 * moved off the one it had, which is what was asked - so the line printed says
 * which of the two happened rather than treating the second as a failure.
 */
if (command == 'reassign') {
	if (length(args) < 2)
		fail('reassign which client? try `bmwan reassign 00:11:22:33:44:55`');

	let result = call('reassign', { instance: instance, mac: args[1] });

	if (asJson)
		printf('%J\n', result);
	else if (!result.ok)
		printf('%s\n', result.reason);
	else if (result.wan)
		printf('%s moved from %s to %s\n', result.mac, result.from, result.wan);
	else
		printf('%s came off %s and is waiting: %s\n', result.mac, result.from, result.reason);

	exit(result.ok ? 0 : 1);
}

if (command == 'unassign' || command == 'release') {
	if (length(args) < 2)
		fail(command + ' which client? try `bmwan ' + command + ' 00:11:22:33:44:55`');

	let result = call(command, { instance: instance, mac: args[1] });

	if (asJson)
		printf('%J\n', result);
	else if (result.ok)
		printf('%s\n', (command == 'unassign') ? (result.mac + ' is held out of the pool') : (result.mac + ' is back in the pool'));
	else
		printf('%s\n', result.reason);

	exit(result.ok ? 0 : 1);
}

// Deliberately not over ubus. See the note at the top of this file: the moment
// this is wanted is the moment the service has already been stopped.
/*
 * Read the configuration and report on it, without the daemon.
 *
 * Deliberately not a ubus call. An instance the daemon refused is one it has no
 * state for, so asking the daemon about it can only ever come back empty - and
 * a stopped daemon is the state somebody is most likely to be in when they come
 * looking for why nothing is being bound.
 */
if (command == 'check') {
	let rows = cfg.configured();

	if (asJson) {
		printf('%J\n', { instances: rows });
		exit(0);
	}

	if (!length(rows)) {
		printf('no instance in /etc/config/bm_wanbind\n');
		printf('There is a commented template in that file, and the LuCI page writes them.\n');
		exit(0);
	}

	let bad = 0;

	for (let one in rows) {
		if (length(instance) && one.id != instance)
			continue;

		if (one.reason) {
			bad++;
			printf('%-16s REFUSED  %s\n', one.id, one.reason);
		}
		else if (!one.enabled) {
			printf('%-16s off      lan %s, carrier %s\n', one.id, one.lan, one.carrier);
		}
		else {
			printf('%-16s ok       lan %s, carrier %s, priorities %d-%d, table %d\n',
				one.id, one.lan, one.carrier, one.rulePrefBase, one.catchAllPref, one.catchAllTable);
		}
	}

	exit(bad ? 1 : 0);
}

/*
 * Remove an instance, rules first.
 *
 * The order is the whole point of the command existing. `uci delete` on its own
 * is one keystroke shorter and leaves every ip rule the instance wrote on the
 * router: the daemon decides what to look at by reading the config, so a
 * section that is gone is a section it never reads again, and nothing else
 * knows those priorities were anybody's.
 *
 * Adding and editing are left to uci, which is the right tool for them and
 * cannot get anything into this state - `check` is what says whether the result
 * will be accepted.
 */
if (command == 'instance') {
	let action = length(args) > 1 ? args[1] : '';
	let name = length(args) > 2 ? args[2] : '';

	if (action != 'delete')
		fail('the only instance command is `bmwan instance delete NAME` - add and edit them with uci, or from LuCI');

	if (!length(name))
		fail('delete which instance? `bmwan check` lists them');

	let one = null;
	for (let row in cfg.configured()) {
		if (row.id == name)
			one = row;
	}

	if (!one)
		fail('no instance called ' + name + ' in /etc/config/bm_wanbind');

	if (one.usable) {
		let present = netlink.rules();
		if (present === null)
			fail('the router\'s ip rules could not be read, so nothing was removed and the section was left alone');

		printf('removed %d rule(s) from %s\n', ruleset.flush(one, present, null), name);
	}
	else {
		// Its priority range is part of what was refused, so deleting by it
		// could take somebody else's rules off. Said plainly rather than
		// guessed at.
		printf('%s was refused (%s), so its priority range cannot be trusted and no rule was removed.\n', name, one.reason);
		printf('Check `ip -4 rule show` by hand afterwards.\n');
	}

	let uci = cursor();
	uci.delete('bm_wanbind', name);

	if (uci.commit('bm_wanbind') === null)
		fail('the rules are off but the section would not commit; check /etc/config/bm_wanbind');

	printf('instance %s removed\n', name);
	exit(0);
}

if (command == 'flush') {
	let present = netlink.rules();
	if (present === null)
		fail('the router\'s ip rules could not be read, so nothing was removed');

	let removed = 0;
	let touched = 0;

	for (let one in cfg.instances()) {
		if (length(instance) && one.id != instance)
			continue;

		removed += ruleset.flush(one, present);
		touched++;
	}

	if (!touched) {
		printf('no instance to flush\n');
		exit(0);
	}

	printf('removed %d rule(s) across %d instance(s)\n', removed, touched);
	exit(0);
}

warn('bmwan: unknown command "' + command + '"\n\n');
warn(USAGE);
exit(1);
