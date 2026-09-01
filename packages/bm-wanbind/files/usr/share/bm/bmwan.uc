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
import * as direct from 'bm.wanbind.direct';
import * as layout from 'bm.wanbind.layout';
import * as netlink from 'bm.wanbind.netlink';
import * as ruleset from 'bm.wanbind.rules';

// A MAC is spelled here the way /tmp/dhcp.leases spells it, because that is how
// a binding following a device is matched to a lease later. It is also how an
// address typed at this prompt is told from a MAC typed at it: whatever this
// accepts is a device, and everything else is an address.
import { normalizeMac } from 'bm.wanbind.leases';

const USAGE = 'usage: bmwan <command> [--json] [--instance NAME]\n' +
	'\n' +
	'  status          instances, how many are bound, how many are waiting\n' +
	'  list            every client and the WAN it is on\n' +
	'  waiting         every client that has none, and why\n' +
	'  layout          what this router reads each interface as, and why\n' +
	'  stats           memory, events handled, and the last pass time\n' +
	'  check           read the configuration and say what is wrong with it\n' +
	'  instance delete NAME\n' +
	'                  take an instance\'s rules off, then remove its section\n' +
	'  reconcile       run a full pass now\n' +
	'  pin MAC WAN     put one client on one WAN\n' +
	'  reassign MAC    move it to a different WAN, whichever one is free\n' +
	'  unassign MAC    take it off and keep it off\n' +
	'  release MAC     let it back into the pool\n' +
	'\n' +
	'One address nailed to one WAN, written into the configuration:\n' +
	'\n' +
	'  bindings        every binding, and what the router is doing about it\n' +
	'  bind ADDR WAN   bind one IPv4 address, or one MAC, to one WAN\n' +
	'  unbind NAME     take a binding\'s rules off, then remove its section\n' +
	'\n' +
	'  flush           remove every rule this package wrote (no service needed)\n' +
	'  help            this text\n' +
	'\n' +
	'`bind` takes an address or a MAC and the UCI name of a WAN - the section in\n' +
	'/etc/config/network, so wan2 and not eth3 - and then:\n' +
	'\n' +
	'  --id NAME          the section name, which is the binding\'s identity\n' +
	'                     everywhere; made up from the address when not given\n' +
	'  --name TEXT        what to call it on a screen\n' +
	'  --lan NAME         the LAN it sits behind\n' +
	'  --when-down WORD   hold, so it has no way out at all while its WAN is\n' +
	'                     down, or fallback, so it leaves over whatever the\n' +
	'                     router would have used. hold is the default\n' +
	'  --pref N           the ip rule priority to write it at; one is taken from\n' +
	'                     the direct band when this is not given\n' +
	'  --table N          the WAN\'s routing table; read from netifd when not given\n' +
	'  --off              write it, or switch an existing one, off\n' +
	'  --on               switch an existing binding back on\n' +
	'\n' +
	'`bind` on a name that is already in the file edits that binding, and every\n' +
	'field you do not give keeps what the section already has - the name, the LAN,\n' +
	'the when-down word, the priority and the table alike. Empty one of the words\n' +
	'with uci: `uci delete bm_wanbind.NAME.lan; uci commit bm_wanbind`.\n' +
	'\n' +
	'`bind` is not `pin`. pin moves a client around one instance\'s pool of WANs\n' +
	'for as long as the daemon remembers it; bind writes a section that survives\n' +
	'a reboot, the app being uninstalled, and this daemon being stopped.\n' +
	'\n' +
	'Instances are added and edited with uci, or from LuCI under Services ->\n' +
	'Bored Manager. `check` is what tells you whether the daemon will accept one,\n' +
	'and it reads the bindings too.\n' +
	'\n' +
	'Whatever writes them, take an instance\'s rules off *before* switching it\n' +
	'off, deleting it, or moving rule_pref_base, catch_all_pref or lan:\n' +
	'\n' +
	'  bmwan flush --instance NAME\n' +
	'\n' +
	'A rule is recognised by where it sits, so a section that has gone or moved\n' +
	'is a set of rules nothing left on the router will admit to. `instance\n' +
	'delete` and `unbind` do the two steps in that order for you.\n';

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

// Every flag that takes a value after it. An unknown one is refused rather than
// read as a positional argument, which is the whole reason this list exists:
// `bmwan bind 10.0.0.5 wan2 --wen-down fallback` reading the typo as an address
// would write a binding that holds when its WAN goes down, having been asked
// for the opposite, and say nothing about it.
const VALUE_FLAGS = [ 'instance', 'id', 'name', 'lan', 'when-down', 'pref', 'table' ];

let args = [];
let opts = {};
let asJson = false;
let expect = null;

for (let arg in ARGV) {
	if (expect) {
		opts[expect] = arg;
		expect = null;
		continue;
	}

	if (arg == '--json') {
		asJson = true;
		continue;
	}

	// The only flag that is a statement rather than a value.
	if (arg == '--off') {
		opts.off = '1';
		continue;
	}

	// The other half of `--off`, and the reason it has to exist: an omitted
	// `enabled` now means "leave it as it is", so without a word for "on" there
	// would be no way to switch a binding back on from a router shell.
	if (arg == '--on') {
		opts.on = '1';
		continue;
	}

	if (arg == '-i') {
		expect = 'instance';
		continue;
	}

	// Read as the command below rather than refused as a flag nothing declares.
	if (arg == '-h' || arg == '--help') {
		push(args, 'help');
		continue;
	}

	let paired = match(arg, /^--([a-z][a-z-]*)=(.*)$/);
	if (paired) {
		// `--json=1` is not how it is written, but somebody who writes it that
		// way meant the flag rather than a typo, and telling them there is no
		// --json flag would be a lie about the one thing they got right.
		if (paired[1] == 'json') {
			asJson = true;
			continue;
		}

		if (!(paired[1] in VALUE_FLAGS))
			fail('there is no --' + paired[1] + ' flag; `bmwan help` lists them');

		opts[paired[1]] = paired[2];
		continue;
	}

	let named = match(arg, /^--([a-z][a-z-]*)$/);
	if (named) {
		if (!(named[1] in VALUE_FLAGS))
			fail('there is no --' + named[1] + ' flag; `bmwan help` lists them');

		expect = named[1];
		continue;
	}

	push(args, arg);
}

if (expect)
	fail('--' + expect + ' was given nothing to be');

/** A flag's value, or '' - so that "not given" reads the same everywhere. */
function flag(name) {
	return type(opts[name]) == 'string' ? opts[name] : '';
}

/** A flag that has to be a number if it is there at all. */
function counted(name, what) {
	let value = flag(name);

	if (!length(value))
		return 0;

	if (!match(value, /^[0-9]+$/))
		fail('--' + name + ' takes a number, which is ' + what);

	return int(value);
}

let instance = flag('instance');
// The firewall reload is an init script rather than a ubus call, so the runner
// has to be handed in here too. `bmwan flush` is what /etc/init.d/bm-wanbind
// runs when the service stops and what the package's prerm runs on `apk del`,
// and it takes the bindings' firewall forwardings off - which without this
// would be removed from /etc/config/firewall and left in force in fw4.
direct.attachSystem((command, timeout) => system(command, timeout));

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

	// Printed before the table rather than as a footnote, because without it the
	// table reads as a report of what the router is doing and it is a report of
	// what the configuration asks for. The second sentence is the half that is
	// still true: a binding is nobody's instance and is reconciled either way.
	if (!result.enabled) {
		printf('Instances are switched off in /etc/config/bm_wanbind - `option enabled 0` on the\n');
		printf('main section - so no client below is being handed a WAN.\n');

		if (result.bindingsMaintained)
			printf('The one-to-one bindings are still being kept in force; `bmwan bindings` lists them.\n');

		printf('\n');
	}

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

/*
 * What this router reads each of its interfaces as, and why.
 *
 * Asked of the daemon rather than worked out here, because the answer that
 * matters is the one the daemon acts on - a second opinion printed at a console
 * would be a way to be told a binding is fine by the thing that is not going to
 * write it.
 *
 * Both sides of the reasoning are printed, including the losing one. An
 * interface can be a LAN and still have a default gateway on it, and somebody
 * who thinks the answer is wrong needs to see the one line that argues their
 * way rather than a verdict that reads unanimous.
 */
if (command == 'layout') {
	let result = call('layout', {});

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		exit(1);
	}

	if (!result.stated)
		printf('/etc/config could not be read, so this is netifd and the kernel alone.\n\n');

	printf('%-16s %-8s %-19s %-12s %s\n', 'INTERFACE', 'ROLE', 'NETWORK', 'DEVICE', 'ZONE');

	for (let one in result.interfaces) {
		printf('%-16s %-8s %-19s %-12s %s\n',
			one.name, one.role,
			length(one.cidr) ? one.cidr : '-',
			length(one.device) ? one.device : '-',
			length(one.zone) ? one.zone : '-');

		// Labelled by which side each argues for rather than by which side won,
		// because the ROLE column above has already said which side won and the
		// point of printing the other one is that it disagrees.
		if (length(one.lanEvidence))
			printf('  for LAN:    %s\n', layout.clauses(one.lanEvidence));
		if (length(one.uplinkEvidence))
			printf('  for uplink: %s\n', layout.clauses(one.uplinkEvidence));
		if (!length(one.lanEvidence) && !length(one.uplinkEvidence))
			printf('  nothing in /etc/config or in the kernel says which side of this router it is on\n');
	}

	exit(0);
}

/*
 * Every binding in the file, and what the router is doing about each one.
 *
 * The refused and the switched-off are here too, for the same reason `status`
 * prints an instance that is not ready: a row that vanished is the hardest kind
 * of mistake to find, and these are exactly the rows somebody came looking for.
 */
if (command == 'bindings') {
	let result = call('bindings', { id: flag('id') });

	if (asJson) {
		printf('%J\n', result);
		exit(0);
	}

	if (!length(result.bindings)) {
		printf('no binding in /etc/config/bm_wanbind\n');
		printf('There is a commented template in that file, and `bmwan bind` writes them.\n');
		exit(0);
	}

	printf('%-14s %-18s %-10s %-9s %7s %7s %s\n',
		'BINDING', 'ADDRESS', 'WAN', 'STATE', 'PREF', 'TABLE', 'NAME');

	for (let one in result.bindings) {
		printf('%-14s %-18s %-10s %-9s %7d %7d %s\n',
			one.id,
			// The live address for a MAC binding, the address itself for the
			// other kind, and the raw text for one that is neither.
			length(one.ip) ? one.ip : one.label,
			one.wan,
			length(one.state) ? one.state : 'pending',
			one.pref,
			// What its rule points at, or - before any pass has written one -
			// what the section says it should.
			one.table ? one.table : one.stampedTable,
			one.name);

		// Both kinds of sentence. A refusal says why there is no rule; a state
		// reason says why the rule there is does not point where somebody
		// expected. Neither is ever the whole row on its own.
		if (length(one.reason))
			printf('  %s\n', one.reason);
	}

	if (result.band.reason)
		printf('\ndirect band: %s\n', result.band.reason);

	exit(0);
}

/*
 * Bind one address, or one device, to one WAN.
 *
 * Over ubus, unlike `unbind` below, because a binding that is only in the file
 * is not yet doing anything: the daemon writes the ip rule, and the call
 * returning after it has done so is what makes `bmwan bind` at a console mean
 * the same thing as pressing it in the app.
 */
if (command == 'bind') {
	if (length(args) < 3)
		fail('bind what to which WAN? try `bmwan bind 192.168.1.40 wan2`, or a MAC in place of the address');

	let address = args[1];
	let wan = args[2];
	let mac = normalizeMac(replace(address, /-/g, ':'));

	// Made up from the address when nothing better was given, so that the short
	// form of this command works. Every character UCI will not have in a
	// section name becomes an underscore, which is what makes it a name rather
	// than a second copy of the address.
	let id = flag('id');
	if (!length(id))
		id = 'b' + replace(length(mac) ? mac : address, /[^0-9A-Za-z]/g, '_');

	let payload = {
		id: id,
		ip: length(mac) ? '' : address,
		mac: mac,
		wan: wan
	};

	// `enabled` goes the same way as the three words below: sent only when it was
	// asked for. Sending `true` on every call meant a `bind` that changed only
	// the WAN also switched a deliberately disabled binding back on, and started
	// steering an address whose owner had turned it off.
	if (length(flag('off')) && length(flag('on')))
		fail('--on and --off are opposites; give one of them or neither');

	if (length(flag('off')))
		payload.enabled = false;
	else if (length(flag('on')))
		payload.enabled = true;

	/*
	 * Everything else is sent only when it was typed.
	 *
	 * An omitted priority is one the daemon allocates out of the direct band and
	 * an omitted table is one it reads off netifd - decisions that have to be
	 * made in exactly one place, and this is not it. The three words are the
	 * same shape for a different reason: `bind` on a name that already exists is
	 * an edit, and a key the daemon receives is a key it writes. Sending an
	 * empty --name with every call is how `bmwan bind 192.168.1.40 wan2` used to
	 * clear the name, the LAN and the when-down of a binding somebody spent an
	 * afternoon getting right.
	 */
	let name = flag('name');
	if (length(name))
		payload.name = name;

	let lan = flag('lan');
	if (length(lan))
		payload.lan = lan;

	let whenDown = flag('when-down');
	if (length(whenDown))
		payload.when_down = whenDown;

	let pref = counted('pref', 'the ip rule priority the binding is written at');
	if (pref)
		payload.pref = pref;

	let table = counted('table', 'the routing table the bound WAN puts its default route in');
	if (table)
		payload.table = table;

	let result = call('bind', payload);

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		exit(1);
	}

	let one = result.binding;
	printf('%s: %s leaves by %s, at ip rule priority %d into table %d\n',
		one.id, length(one.ip) ? one.ip : one.label, one.wan, one.pref,
		one.table ? one.table : one.stampedTable);
	printf('  %s\n', (one.whenDown == 'hold')
		? sprintf('while %s is down it has no way out at all', one.wan)
		: sprintf('while %s is down it leaves over whatever the router would have used', one.wan));

	// The pass that ran inside the call may not have got as far as a rule - a
	// MAC with no lease yet, a WAN that is down. Said here rather than left to
	// be discovered, because the line above reads like a promise.
	if (length(one.state) && one.state != 'bound')
		printf('  it is %s right now: %s\n', one.state, one.reason);

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

	// Null when an instance was named: the bindings are nobody's instance, so a
	// pass asked for about one of them leaves the bindings alone rather than
	// reporting on work it did not do.
	if (result.direct) {
		if (!result.direct.ok)
			printf('bindings: %s\n', result.direct.reason);
		else
			printf('bindings: %d of %d bound, %d held, %d on the main table, %d stranded, %d rule(s) written, %d removed, %dms\n',
				result.direct.bound, result.direct.bindings, result.direct.held,
				result.direct.fallback, result.direct.stranded,
				result.direct.added, result.direct.removed, result.direct.passMs);
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
	let bindings = cfg.directConfigured();
	let band = cfg.directBand();

	if (asJson) {
		printf('%J\n', { instances: rows, direct: bindings, band: band });
		exit(0);
	}

	if (!length(rows) && !length(bindings)) {
		printf('no instance and no binding in /etc/config/bm_wanbind\n');
		printf('There is a commented template for each in that file, and the LuCI page writes them.\n');
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

	/*
	 * And the bindings, in the same three shapes.
	 *
	 * The band is reported before them because it is the one fault that has no
	 * binding to hang itself on: a `direct_pref_base` that reaches into an
	 * instance's client range refuses every future binding rather than any
	 * existing one, so without this line the symptom is a `bind` that keeps
	 * failing and a `check` that keeps saying everything is fine.
	 */
	if (band.reason) {
		bad++;
		printf('%-16s REFUSED  %s\n', 'direct band', band.reason);
	}

	for (let one in bindings) {
		if (length(instance) && one.id != instance)
			continue;

		if (one.reason) {
			bad++;
			printf('%-16s REFUSED  %s\n', one.id, one.reason);
		}
		else if (!one.enabled) {
			printf('%-16s off      %s -> %s\n', one.id, one.label, one.wan);
		}
		else {
			printf('%-16s ok       %s -> %s, pref %d, table %d, %s when down\n',
				one.id, one.label, one.wan, one.pref, one.table, one.whenDown);
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

	// Guarded because the rules have already come off by the time this runs.
	// `cursor()` answers null on a read-only overlay rather than raising, and the
	// `uci.delete` below would then be a call on null - a ucode traceback in
	// place of the one sentence that says what state the router is now in.
	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		uci = null;
	}

	if (!uci) {
		fail('/etc/config could not be opened, so the rules are off but the section is still there. ' +
			'Remove it with `uci delete bm_wanbind.' + name + '; uci commit bm_wanbind`');
	}

	uci.delete('bm_wanbind', name);

	if (uci.commit('bm_wanbind') === null)
		fail('the rules are off but the section would not commit; check /etc/config/bm_wanbind');

	printf('instance %s removed\n', name);
	exit(0);
}

/*
 * Remove a binding: the section, and then the pass that takes its rule off.
 *
 * Over ubus, unlike `instance delete` above, and the difference is not an
 * inconsistency. An instance's rules can only be found through the priority
 * range in its own section, so they have to come off before it is deleted and
 * this file can do that with no daemon at all. A binding's rule lives in a band
 * the daemon owns and reconciles as a whole: deleting the section is how the
 * rule becomes unwanted, and the pass is what notices. There is nothing useful
 * this process could do on its own except take every binding's rule off, which
 * is `flush`, and which is a different request.
 *
 * With the service stopped there is still an answer, and it is two commands:
 * `uci delete bm_wanbind.NAME; uci commit bm_wanbind`, then `bmwan flush`.
 */
if (command == 'unbind') {
	if (length(args) < 2)
		fail('unbind which binding? `bmwan bindings` lists them, and `bmwan check` lists them without the daemon');

	let result = call('unbind', { id: args[1] });

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		exit(1);
	}

	printf('binding %s removed, with %d rule(s) and %d firewall forwarding(s)\n',
		result.id, result.removed, result.swept);

	// Set when the section is gone but something was left on the router.
	if (result.reason)
		printf('%s\n', result.reason);

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

	/*
	 * And every binding, unless one instance was named.
	 *
	 * `flush --instance NAME` is the first half of stopping or deleting that
	 * instance, and the bindings are nobody's instance - taking them off as a
	 * side effect would cut the connection of addresses that have nothing to do
	 * with what was being stopped.
	 *
	 * A plain `flush` is the other thing: the uninstall, and what the init
	 * script runs when the service stops. It has to leave nothing behind, or
	 * `apk del bm-wanbind` leaves an address pointed at a table nothing
	 * maintains with no service left to explain it.
	 */
	let bindings = length(instance) ? { ok: true, removed: 0, swept: 0 } : direct.flush();

	if (!bindings.ok)
		fail(bindings.reason);

	if (!touched && !bindings.removed && !bindings.swept) {
		printf('nothing to flush\n');
		exit(0);
	}

	printf('removed %d rule(s) across %d instance(s), and %d rule(s) and %d firewall forwarding(s) from bindings\n',
		removed, touched, bindings.removed, bindings.swept);
	exit(0);
}

warn('bmwan: unknown command "' + command + '"\n\n');
warn(USAGE);
exit(1);
