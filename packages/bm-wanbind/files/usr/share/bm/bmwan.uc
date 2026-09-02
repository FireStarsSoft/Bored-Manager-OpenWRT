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
//
// `instance delete` is the one command that is in both halves. With the daemon
// answering it goes over ubus, because taking the rules off is only a third of
// the job - the firewall forwardings and the saved state go too, and the daemon
// is what knows about them. With the daemon gone it does the part that has to
// happen anyway, which is the `prerm` case again.

import { cursor } from 'uci';
import { connect } from 'ubus';

import * as cfg from 'bm.wanbind.config';
import * as direct from 'bm.wanbind.direct';
import * as layout from 'bm.wanbind.layout';
import * as netlink from 'bm.wanbind.netlink';
import * as prepare from 'bm.wanbind.prepare';
import * as ruleset from 'bm.wanbind.rules';
import * as wans from 'bm.wanbind.wans';

// A MAC is spelled here the way /tmp/dhcp.leases spells it, because that is how
// a binding following a device is matched to a lease later. It is also how an
// address typed at this prompt is told from a MAC typed at it: whatever this
// accepts is a device, and everything else is an address.
import { normalizeMac } from 'bm.wanbind.leases';

const USAGE = 'usage: bmwan <command> [--json] [--instance NAME]\n' +
	'\n' +
	'  status          instances, how many are bound, how many are waiting\n' +
	'  instances       every instance in the file, what it binds, and how it is\n' +
	'  list            every client and the WAN it is on\n' +
	'  waiting         every client that has none, and why\n' +
	'  wans            every uplink, its table, its zone, and who is on it\n' +
	'  layout          what this router reads each interface as, and why\n' +
	'  rules [--limit N]\n' +
	'                  every ip rule on this router, whose it is, and why\n' +
	'  verify          the rules that should be on this router and are not\n' +
	'  stats           memory, events handled, and the last pass time\n' +
	'  check           read the configuration and say what is wrong with it\n' +
	'  settings [k=v]  the numbers the daemon works to; with none, read them\n' +
	'  reconcile       run a full pass now\n' +
	'  pin MAC WAN     put one client on one WAN\n' +
	'  reassign MAC    move it to a different WAN, whichever one is free\n' +
	'  unassign MAC    take it off and keep it off\n' +
	'  release MAC     let it back into the pool\n' +
	'\n' +
	'A pool of WANs and the clients the router hands them out to:\n' +
	'\n' +
	'  instance check NAME [flags]\n' +
	'                  what the daemon would make of it; writes nothing\n' +
	'  instance add NAME [flags]\n' +
	'                  check it, and write it if the check passes\n' +
	'  instance set NAME [flags]\n' +
	'                  the same, on one that is already there\n' +
	'  instance delete NAME\n' +
	'                  take its rules off, then remove its section\n' +
	'\n' +
	'  --lan NAME             the LAN whose clients it hands WANs to\n' +
	'  --carrier NAME         the device its WANs are carried on\n' +
	'  --clients-per-wan N    1 is one client to a WAN, N is how many may share\n' +
	'                         one, and 0 is no limit at all\n' +
	'  --range FROM-TO        only the addresses between those two, which is\n' +
	'                         what lets two instances share a LAN; `--range\n' +
	'                         none` puts it back to the whole of it\n' +
	'  --no-sticky            stop giving a client the WAN it had last time\n' +
	'  --no-remap             stop moving a client when its WAN goes down\n' +
	'  --sticky, --remap      the other halves of those two\n' +
	'  --pref-base N          the priority its client rules start at\n' +
	'  --catch-all-pref N     the priority its catch-all sits at\n' +
	'  --catch-all-table N    the table that catch-all points into\n' +
	'  --warn-uptime S        how long a WAN must be up before a client goes on\n' +
	'  --error-grace S        how long it may be down before they are moved off\n' +
	'  --release-grace S      how long a client keeps its WAN after its lease\n' +
	'  --raise-dhcp-limits    raise the dnsmasq lease ceilings to fit the LAN\n' +
	'  --name TEXT            what to call it on a screen\n' +
	'  --off, --on            switch it off, or back on\n' +
	'  --check                on `add` or `set`, the same as `check`: say what\n' +
	'                         the daemon makes of it and write nothing\n' +
	'\n' +
	'`instance set` changes what you give it and leaves everything else as the\n' +
	'section already has it. A number you never give is one the router picks and\n' +
	'writes into the section, and `instance check` says which numbers those would\n' +
	'be before anything is written at all.\n' +
	'\n' +
	'One address nailed to one WAN, written into the configuration:\n' +
	'\n' +
	'  bindings [--id NAME] [--source manual|NAME]\n' +
	'                  every binding, and what the router is doing about it;\n' +
	'                  --source manual is the ones written into the file, and\n' +
	'                  an instance\'s name is the seats it is holding\n' +
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
	'  --check            say what the daemon makes of it and write nothing\n' +
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
	'The rules belong to the daemon, and it takes them off itself: switching an\n' +
	'instance off, deleting it, or moving its priorities or its LAN flushes what\n' +
	'is there before anything new is written. `bmwan flush --instance NAME` is\n' +
	'for the other case - the daemon stopped, or a section somebody edited with\n' +
	'uci behind its back, which leaves rules at priorities nothing on the router\n' +
	'will admit to any more. `bmwan verify` is what says that has happened.\n' +
	'\n' +
	'That one reads the named instance\'s LAN from netifd first, because two\n' +
	'instances may share a LAN with different address ranges and only the subnet\n' +
	'tells one\'s client rules from the other\'s. With netifd not answering it\n' +
	'removes nothing rather than removing both. Plain `bmwan flush` asks nothing\n' +
	'of anybody and takes every rule this package wrote off, which is the\n' +
	'uninstall and works with the service already stopped.\n';

function bus() {
	let conn = connect();
	if (!conn)
		return null;

	let objects = conn.list();
	if (type(objects) != 'array' || !('bm.wanbind' in objects))
		return null;

	return conn;
}

/*
 * Every interface netifd knows about, or null when it will not answer.
 *
 * A plain `connect()` rather than `bus()` above, because this is not a question
 * for bm-wanbind: netifd is a different daemon and is up on a router where this
 * package's service has been stopped, which is the only state `flush` is ever
 * run in. Null and an empty list are kept apart the way `wans.dump` keeps them
 * apart - no answer means the caller knows nothing, not that this router has no
 * LAN - and the one caller below refuses rather than guessing.
 */
function netifd() {
	return wans.dump(connect());
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

	// A method the daemon does not publish answers the same way a method that
	// went wrong does, and the two are told apart by nothing this process can
	// see - so the sentence names the likelier of the two rather than leaving
	// somebody to work out that their router is a version behind their CLI.
	if (type(result) != 'object') {
		fail('bm.wanbind gave no answer to ' + method +
			'. A daemon older than 2.4.0 does not have that call; `bmwan status` prints its version.');
	}

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

/** A list the daemon may not have sent, so that every loop below is one line. */
function arrayOr(value) {
	return (type(value) == 'array') ? value : [];
}

/*
 * A number the daemon may not have sent.
 *
 * A gap prints as a gap rather than as zero, because zero is an answer here and
 * a wrong one: "0 events handled" reads as a daemon sitting idle, and what it
 * would actually mean is a reply this CLI could not find the figure in.
 */
function figure(value) {
	return (type(value) == 'int') ? sprintf('%d', value) : '-';
}

/** `clients_per_wan` as a column: 1, a number, or the word for 0. */
function perWan(limit) {
	if (type(limit) != 'int')
		return '1';
	if (limit == 0)
		return 'no limit';

	return sprintf('%d', limit);
}

/** How many findings are the kind that stop a write. */
function errors(findings) {
	let bad = 0;

	for (let one in arrayOr(findings)) {
		if (one.level == 'error')
			bad++;
	}

	return bad;
}

/*
 * The findings of a check, in the shape bmpppoe prints them.
 *
 * Level first because it is what the eye needs first - three of these are
 * information and one of them is why nothing will be written - and the detail
 * below the label because the detail is a sentence and the label is a heading.
 */
function printFindings(findings) {
	for (let one in arrayOr(findings)) {
		printf('  %-8s %s\n', (type(one.level) == 'string') ? uc(one.level) : 'NOTE', one.label);
		if (length(one.detail))
			printf('           %s\n', one.detail);
	}

	return errors(findings);
}

/*
 * Rules this daemon wrote and could not find again a moment later.
 *
 * Reported wherever there is room for it, because it is the one number that
 * explains the thing that otherwise cannot be explained: every row says bound,
 * the daemon says it wrote the rule, and the address leaves by the wrong WAN.
 * The counter is under `netlink` in the answers that carry it and under `core`
 * in the ones that do not, and either being non-zero is the same news.
 */
function unverified(result) {
	let counters = (type(result.netlink) == 'object') ? result.netlink : result.core;

	if (type(counters) != 'object' || type(counters.unverified) != 'int' || !counters.unverified)
		return 0;

	return counters.unverified;
}

// Every flag that takes a value after it. An unknown one is refused rather than
// read as a positional argument, which is the whole reason this list exists:
// `bmwan bind 10.0.0.5 wan2 --wen-down fallback` reading the typo as an address
// would write a binding that holds when its WAN goes down, having been asked
// for the opposite, and say nothing about it.
const VALUE_FLAGS = [
	'instance', 'id', 'name', 'lan', 'when-down', 'pref', 'table', 'source',
	'limit', 'carrier', 'clients-per-wan', 'range', 'pref-base',
	'catch-all-pref', 'catch-all-table', 'warn-uptime', 'error-grace',
	'release-grace'
];

// And every flag that is a statement rather than a value. `--off` and `--on`
// are both here for the same reason: an omitted key now means "leave it as it
// is", so without a word for each direction there would be no way to switch
// something back on from a router shell. The four below them are the same
// again, for an instance's two habits and its two opt-ins.
const STATEMENT_FLAGS = [
	'off', 'on', 'sticky', 'no-sticky', 'remap', 'no-remap',
	'raise-dhcp-limits', 'check'
];

// Every setting `settings_get` answers with, in the order it is worth reading,
// and what each one is for. This is also the list `bmwan settings k=v` accepts:
// a key that is not here is a typo, and sending it would come back as ubus
// refusing an argument, which reads like the daemon being broken.
const SETTINGS = [
	[ 'enabled', 'whether instances hand out WANs at all' ],
	[ 'interval', 'seconds between passes' ],
	[ 'direct_pref_base', 'the priority the one-to-one bindings start at' ],
	[ 'rule_pref_base', 'where a new instance\'s client rules start' ],
	[ 'catch_all_pref_base', 'where a new instance\'s catch-all sits' ],
	[ 'catch_all_table', 'the table a new instance\'s catch-all points into' ],
	[ 'wan_table_base', 'the first routing table number handed to a WAN' ],
	[ 'wan_warn_uptime', 'seconds a WAN must be up before a client goes on it' ],
	[ 'wan_error_grace', 'seconds it may be down before its clients are moved' ],
	[ 'release_grace', 'seconds a client keeps its WAN after its lease ends' ]
];

/** Whether a word is one of the settings above. */
function isSetting(name) {
	for (let one in SETTINGS) {
		if (one[0] == name)
			return true;
	}

	return false;
}

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

		// `--off=0` is not that. It is somebody saying the opposite of what the
		// flag means, and the one thing that must not happen is to read it as
		// the flag and switch off what they were asking to leave alone.
		if (paired[1] in STATEMENT_FLAGS)
			fail('--' + paired[1] + ' is a word on its own and takes no value; write it or leave it out');

		if (!(paired[1] in VALUE_FLAGS))
			fail('there is no --' + paired[1] + ' flag; `bmwan help` lists them');

		opts[paired[1]] = paired[2];
		continue;
	}

	let named = match(arg, /^--([a-z][a-z-]*)$/);
	if (named) {
		if (named[1] in STATEMENT_FLAGS) {
			opts[named[1]] = '1';
			continue;
		}

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

/*
 * A flag that has to be a number if it is there at all; null when it is not.
 *
 * Null rather than zero because zero is an answer now: `--clients-per-wan 0` is
 * how somebody says a WAN may carry the whole LAN, and a helper that could not
 * tell that from an omitted flag would either drop it or send it on every call.
 */
function counted(name, what) {
	if (!exists(opts, name))
		return null;

	let value = flag(name);

	if (!match(value, /^[0-9]+$/))
		fail('--' + name + ' takes a number, which is ' + what);

	return int(value);
}

/** Two flags that say opposite things: true, false, or null for neither. */
function opposites(yes, no) {
	if (exists(opts, yes) && exists(opts, no))
		fail('--' + yes + ' and --' + no + ' are opposites; give one of them or neither');

	if (exists(opts, yes))
		return true;
	if (exists(opts, no))
		return false;

	return null;
}

/*
 * The instance flags, as the spec `instance_check` and `instance_set` take.
 *
 * A key that is not here is one the daemon leaves alone, which is what makes
 * `instance set` an edit and what makes `instance add` inherit the router's own
 * numbering. So every field is sent only when it was typed, and `exists` is
 * what decides that rather than the value being empty - `--name=` is somebody
 * clearing a name, and it has to arrive as an empty name rather than as
 * silence.
 *
 * The numbers go as numbers and the switches as booleans. ubus checks an
 * argument against the daemon's template and refuses the whole call when the
 * type disagrees, which from a shell looks exactly like the daemon being
 * broken.
 */
function instanceSpec(id) {
	let spec = { id: id };

	if (exists(opts, 'name'))
		spec.name = flag('name');

	if (exists(opts, 'lan'))
		spec.lan = flag('lan');

	if (exists(opts, 'carrier'))
		spec.carrier = flag('carrier');

	let enabled = opposites('on', 'off');
	if (enabled !== null)
		spec.enabled = enabled;

	let sticky = opposites('sticky', 'no-sticky');
	if (sticky !== null)
		spec.sticky = sticky;

	let remap = opposites('remap', 'no-remap');
	if (remap !== null)
		spec.remap = remap;

	if (exists(opts, 'raise-dhcp-limits'))
		spec.raise_dhcp_limits = true;

	let clients = counted('clients-per-wan', 'how many clients may share one WAN, where 0 is no limit');
	if (clients !== null)
		spec.clients_per_wan = clients;

	let prefBase = counted('pref-base', 'the priority its client rules start at');
	if (prefBase !== null)
		spec.rule_pref_base = prefBase;

	let catchAllPref = counted('catch-all-pref', 'the priority its catch-all sits at');
	if (catchAllPref !== null)
		spec.catch_all_pref = catchAllPref;

	let catchAllTable = counted('catch-all-table', 'the routing table its catch-all points into');
	if (catchAllTable !== null)
		spec.catch_all_table = catchAllTable;

	let warnUptime = counted('warn-uptime', 'seconds a WAN must be up before a client is put on it');
	if (warnUptime !== null)
		spec.wan_warn_uptime = warnUptime;

	let errorGrace = counted('error-grace', 'seconds a WAN may be down before its clients are moved');
	if (errorGrace !== null)
		spec.wan_error_grace = errorGrace;

	let releaseGrace = counted('release-grace', 'seconds a client keeps its WAN after its lease ends');
	if (releaseGrace !== null)
		spec.release_grace = releaseGrace;

	/*
	 * The range is one flag and two fields, because that is how somebody says
	 * it out loud. `--range none` is the way back to the whole LAN: both ends
	 * arrive empty, which is what the daemon reads as no range at all, and
	 * without it there would be no way to widen an instance again from a shell.
	 */
	if (exists(opts, 'range')) {
		let range = flag('range');

		if (range == 'none' || !length(range)) {
			spec.range_from = '';
			spec.range_to = '';
		}
		else {
			let ends = match(range, /^([0-9.]+)-([0-9.]+)$/);

			if (!ends) {
				fail('--range takes the two ends with a dash between them, as in ' +
					'--range 192.168.1.100-192.168.1.150, or the word none for the whole LAN');
			}

			spec.range_from = ends[1];
			spec.range_to = ends[2];
		}
	}

	return spec;
}

let instance = flag('instance');
// The firewall reload is an init script rather than a ubus call, so the runner
// has to be handed in here too - to `prepare`, which is the one file that runs
// it and which every other module reaches it through. `bmwan flush` is what
// /etc/init.d/bm-wanbind runs when the service stops and what the package's
// prerm runs on `apk del`, and it takes the bindings' firewall forwardings off
// - which without this would be removed from /etc/config/firewall and left in
// force in fw4.
prepare.attachSystem((command, timeout) => system(command, timeout));

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

	// The one number that explains a row saying bound while the address leaves
	// by the wrong WAN. Everything else on this screen is what the daemon meant
	// to do; this is the kernel disagreeing with it afterwards.
	let gone = unverified(result);
	if (gone) {
		printf('%d rule(s) this daemon wrote were gone from the kernel\'s rule table a moment later.\n', gone);
		printf('The usual cause is a Bored Manager module older than 3.4.0, which sweeps this\n');
		printf('band every two seconds while it is connected. `bmwan verify` says which ones\n');
		printf('are missing now, and syslog carries a line for each of them.\n\n');
	}

	/*
	 * The configuration is the spine of this table, and the live rows fill it in.
	 *
	 * `instances` is what the daemon is running, and by design it has no entry
	 * for one that is switched off or that the daemon refused - those are in
	 * `configured` alone. Drawing the table from the live list told the router
	 * somebody ran `status` on to find out why nothing is binding that there was
	 * nothing configured to bind, which is the one answer that sends them
	 * looking somewhere other than at the section that is being refused. "No
	 * instances are configured" is now what an empty file says, and only that.
	 */
	let live = {};
	for (let one in arrayOr(result.instances))
		live[one.id] = one;

	let rows = arrayOr(result.configured);

	if (!length(rows)) {
		printf('No instances are configured. Add one with `bmwan instance add NAME --lan lan`,\n');
		printf('or create one from the app or from LuCI.\n');
		exit(0);
	}

	printf('%-12s %-18s %-7s %6s %8s %6s\n', 'INSTANCE', 'LAN', 'READY', 'BOUND', 'WAITING', 'FREE');
	for (let one in rows) {
		let st = live[one.id];
		let ready = 'NO';

		if (!one.enabled)
			ready = 'off';
		else if (st && st.ready)
			ready = 'yes';

		// A dash rather than a zero in the three live columns, for the reason
		// this whole table was rewritten: an instance the daemon is not running
		// has no counts, and printing 0 bound and 0 waiting would say it is
		// running and idle.
		printf('%-12s %-18s %-7s %6s %8s %6s\n',
			one.id,
			(st && length(st.lanCidr)) ? st.lanCidr : one.lan,
			ready,
			st ? sprintf('%d', st.bound) : '-',
			st ? sprintf('%d', st.waiting) : '-',
			st ? sprintf('%d', st.free) : '-');

		// The refusal first: an instance the configuration rules out has no
		// state, so whatever the daemon last said about it is older news.
		let why = length(one.reason) ? one.reason : ((st && !st.ready) ? st.reason : '');
		if (length(why))
			printf('  %s\n', why);
	}

	exit(0);
}

/*
 * Every instance in the file, and what the daemon is making of it.
 *
 * Both lists at once, and the configuration is the spine of the join: an
 * instance the daemon refused has no state and would be missing from a table
 * drawn from `instances` alone, which is exactly the row somebody ran this to
 * look at. What the daemon knows - the LAN's real subnet, and the three counts
 * - is filled in where there is a live row to fill it from.
 */
if (command == 'instances') {
	let result = call('info', {});

	if (asJson) {
		printf('%J\n', result);
		exit(0);
	}

	let live = {};
	for (let one in arrayOr(result.instances))
		live[one.id] = one;

	let rows = arrayOr(result.configured);

	if (!length(rows)) {
		printf('no instance in /etc/config/bm_wanbind\n');
		printf('`bmwan instance add home --lan lan --carrier eth1` writes one.\n');
		exit(0);
	}

	printf('%-12s %-18s %-21s %-9s %-6s %6s %8s %6s\n',
		'INSTANCE', 'LAN', 'SCOPE', 'PER WAN', 'READY', 'BOUND', 'WAITING', 'FREE');

	for (let one in rows) {
		if (length(instance) && one.id != instance)
			continue;

		let st = live[one.id];
		let ready = 'NO';

		if (!one.enabled)
			ready = 'off';
		else if (st && st.ready)
			ready = 'yes';

		printf('%-12s %-18s %-21s %-9s %-6s %6s %8s %6s\n',
			one.id,
			(st && length(st.lanCidr)) ? st.lanCidr : one.lan,
			length(one.rangeFrom) ? sprintf('%s-%s', one.rangeFrom, one.rangeTo) : 'whole LAN',
			perWan(one.clientsPerWan),
			ready,
			st ? sprintf('%d', st.bound) : '-',
			st ? sprintf('%d', st.waiting) : '-',
			st ? sprintf('%d', st.free) : '-');

		// The refusal first: an instance the configuration rules out has no
		// state, so whatever the daemon last said about it is older news.
		let why = length(one.reason) ? one.reason : (st ? st.reason : '');
		if (length(why))
			printf('  %s\n', why);
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
 * Every uplink this router has, and who is on it.
 *
 * The columns are the four things somebody has to know before they can write an
 * instance or a binding: what the router calls the WAN, which routing table its
 * routes are in, which firewall zone it is in, and whether anybody is already
 * being sent out of it. The carriers are printed after them because `--carrier`
 * takes a device name and nothing else on this router prints that list.
 */
if (command == 'wans') {
	let result = call('wans', {});

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		exit(1);
	}

	printf('%-12s %-8s %-10s %6s %-12s %-12s %7s\n',
		'WAN', 'ROLE', 'STATE', 'TABLE', 'ZONE', 'INSTANCE', 'CLIENTS');

	for (let one in arrayOr(result.wans)) {
		printf('%-12s %-8s %-10s %6s %-12s %-12s %7d\n',
			one.name,
			length(one.role) ? one.role : '-',
			length(one.state) ? one.state : (one.up ? 'up' : 'down'),
			one.table ? sprintf('%d', one.table) : '-',
			length(one.zone) ? one.zone : '-',
			length(one.instance) ? one.instance : '-',
			length(arrayOr(one.holders)));
	}

	if (length(arrayOr(result.carriers))) {
		printf('\ncarriers - the devices these are carried on, which is what --carrier takes:\n');
		for (let one in result.carriers) {
			printf('  %-12s %-5s %s\n',
				one.device, one.up ? 'up' : 'down', join(' ', arrayOr(one.wans)));
		}
	}

	exit(0);
}

/*
 * Every ip rule on this router, and whose it is.
 *
 * Read over netlink by the daemon rather than by parsing `ip rule show` here,
 * and it prints the kernel's own baseline rows too. A rule table with a gap in
 * it is not a rule table anybody can reason about: the question this answers is
 * "what does the kernel consult, in what order", and a listing that quietly
 * left out the rows this package did not write would answer a different one.
 */
if (command == 'rules') {
	let limit = counted('limit', 'how many rules to read at most');
	let result = call('rules', { limit: (limit === null) ? 0 : limit });

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	/*
	 * No answer is not an empty router, and `read` is the only thing that tells
	 * them apart.
	 *
	 * Printing a table of nothing here would be this command saying that no rule
	 * on this router sends anything anywhere - which on a router whose rules
	 * simply could not be dumped is the most misleading sentence it could
	 * produce, and the one somebody would act on hardest.
	 */
	if (!result.ok || !result.read) {
		printf('the router\'s ip rules could not be read, so this is not a report of what it is doing.\n');
		printf('That is a netlink dump giving no answer, and not a router with no rules on it.\n');
		exit(1);
	}

	printf('%6s %-24s %6s %-9s %s\n', 'PREF', 'MATCHES', 'TABLE', 'OWNER', 'ID');

	for (let one in arrayOr(result.rules)) {
		let whose = length(one.id) ? one.id : '';

		// An instance's client rule carries both: the client it is for, and the
		// instance whose numbering it sits in. Neither is the other's name.
		if (length(one.instance) && one.instance != one.id)
			whose = length(whose) ? sprintf('%s (%s)', whose, one.instance) : one.instance;

		printf('%6d %-24s %6s %-9s %s\n',
			one.pref,
			// The daemon's own rendering of what the rule matches, source and
			// interface and mark alike. Written there once so that no surface
			// has to turn an FR_ACT number back into words and get it wrong in
			// a different way from every other surface.
			length(one.selector) ? one.selector : 'everything',
			one.table ? sprintf('%d', one.table) : '-',
			length(one.owner) ? one.owner : '-',
			whose);

		// And the sentence this whole monitor exists to produce. Anybody can
		// list `ip rule show`; what somebody at a console needs is the line
		// saying why this address is not leaving by the connection they expect.
		if (length(one.reason))
			printf('  %s\n', one.reason);
	}

	if (result.capped) {
		printf('\n%d rule(s) on this router and %d shown, which is the cap - raise it with `bmwan rules --limit N`\n',
			result.count, length(arrayOr(result.rules)));
	}

	/*
	 * The main table's default route, which is what a rule that points at an
	 * empty table falls through to. Printed even when there is none, because
	 * "no default route on main" is the whole answer to a binding that holds
	 * and a router that is otherwise online.
	 */
	printf('\n');
	if (type(result.main) != 'object' || !result.main)
		printf('main table: no default route\n');
	else if (length(result.main.gateway) && length(result.main.device))
		printf('main table: default via %s dev %s\n', result.main.gateway, result.main.device);
	else if (length(result.main.device))
		// A point-to-point link - PPPoE is the common one - has a default route
		// and no gateway to name. "via  dev pppoe-wan" is not a smaller way of
		// saying that, it is a gap where an address should be.
		printf('main table: default dev %s\n', result.main.device);
	else
		printf('main table: a default route the route dump names no device for\n');

	if (length(arrayOr(result.tables))) {
		printf('\n%6s %-12s %-11s %s\n', 'TABLE', 'WAN', 'ROLE', 'DEFAULT');

		/*
		 * Three states, and they describe three different routers.
		 *
		 * A table that leaves through a device is a way out. An unreachable
		 * default is a way out somebody took away on purpose - it is what parks
		 * a held address, and a lookup there fails rather than falling through.
		 * A table with neither stops nothing at all: the kernel finds nothing,
		 * carries on down the rule list, and the rule pointing into it does
		 * exactly what it would do if it had never been written. Printing the
		 * last two as one word is how a working hold and a rule doing nothing
		 * come to look identical.
		 */
		for (let one in result.tables) {
			let route = 'no default route, so a rule into it does nothing';

			if (one.unreachable)
				route = 'unreachable - a parked address, not a way out';
			else if (one.hasDefault && length(one.gateway) && length(one.device))
				route = sprintf('via %s dev %s', one.gateway, one.device);
			else if (one.hasDefault && length(one.device))
				route = sprintf('dev %s', one.device);
			else if (one.hasDefault)
				route = 'a default route the route dump names no device for';

			printf('%6d %-12s %-11s %s\n',
				one.table,
				length(one.wan) ? one.wan : '-',
				length(one.role) ? one.role : '-',
				route);
		}
	}

	exit(0);
}

/*
 * The rules that should be on this router, against the ones that are.
 *
 * Exits 1 on either kind of disagreement, so that it can be the thing a script
 * or a cron line runs. Missing means somebody else is removing rules in these
 * priorities; extra means a section moved or was deleted behind the daemon and
 * left rules nothing will admit to. They are different faults with the same
 * symptom, which is why both are printed and neither is summarised away.
 */
if (command == 'verify') {
	let result = call('verify', { instance: instance });

	if (asJson) {
		printf('%J\n', result);
		exit((result.ok && !length(arrayOr(result.missing)) && !length(arrayOr(result.extra))) ? 0 : 1);
	}

	/*
	 * `read` is the failure here, and `ok` is not.
	 *
	 * `ok` on this answer means "nothing missing and nothing extra". So a read
	 * that worked and found rules gone from the kernel comes back `ok: false`
	 * with `reason: null` - and branching on `ok` printed "nothing was checked"
	 * over the top of the one report this command exists to produce, on exactly
	 * the router that needed it. `read: false` is the case where the kernel
	 * would not answer and nothing was compared, and it is the only one.
	 */
	if (!result.read) {
		printf('%s\n', length(result.reason)
			? result.reason
			: 'the router\'s ip rules could not be read, so nothing was checked');
		exit(1);
	}

	let missing = arrayOr(result.missing);
	let extra = arrayOr(result.extra);

	if (!length(missing) && !length(extra)) {
		printf('%d rule(s) checked, and every one of them is on the router\n', result.checked);
		exit(0);
	}

	if (length(missing)) {
		printf('missing - this daemon wants these and the kernel does not have them:\n');
		for (let one in missing) {
			printf('  pref %-6d %-20s table %-6d %s\n',
				one.pref, length(one.cidr) ? one.cidr : 'all', one.table,
				length(one.source) ? sprintf('%s, %s', one.id, one.source) : one.id);
		}

		// Two different faults look identical here, and saying only the second
		// would send somebody hunting a phantom on a router where the daemon
		// simply has not had its pass yet.
		printf('Either no pass has run since these were wanted - `bmwan reconcile` runs one - or\n');
		printf('something else is removing them, which a Bored Manager module older than 3.4.0\n');
		printf('does every two seconds while it is connected.\n');
	}

	if (length(extra)) {
		if (length(missing))
			printf('\n');

		printf('extra - these sit in this daemon\'s priorities and nothing wants them:\n');
		for (let one in extra) {
			printf('  pref %-6d %-20s table %-6d %s\n',
				one.pref, length(one.cidr) ? one.cidr : 'all', one.table,
				length(one.id) ? one.id : '');
		}

		printf('A section that moved or was deleted behind the daemon leaves these; `bmwan\n');
		printf('reconcile` takes off the ones it still recognises.\n');
	}

	exit(1);
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
 * The numbers the daemon works to, and the way to change them.
 *
 * Seven of the ten are what a new instance is stamped with rather than anything
 * the daemon consults itself, which is the sentence at the bottom: changing
 * `rule_pref_base` here moves nothing that is already written, and somebody who
 * reads this list as live settings will spend an afternoon on that.
 */
if (command == 'settings') {
	let change = {};
	let wanted = slice(args, 1);

	for (let one in wanted) {
		let pair = match(one, /^([a-z_]+)=(.*)$/);

		if (!pair) {
			fail('settings takes key=value, as in `bmwan settings interval=15`; ' +
				'`bmwan settings` on its own prints the keys');
		}

		if (!isSetting(pair[1]))
			fail('there is no setting called ' + pair[1] + '; `bmwan settings` prints the ones there are');

		if (pair[1] == 'enabled') {
			if (!(pair[2] in [ '0', '1', 'no', 'yes', 'off', 'on', 'false', 'true' ]))
				fail('enabled takes yes or no, and "' + pair[2] + '" is neither');

			change.enabled = (pair[2] in [ '1', 'yes', 'on', 'true' ]);
			continue;
		}

		if (!match(pair[2], /^[0-9]+$/))
			fail(pair[1] + ' takes a number, and "' + pair[2] + '" is not one');

		change[pair[1]] = int(pair[2]);
	}

	let result = length(wanted) ? call('settings_set', change) : call('settings_get', {});
	let values = length(wanted) ? result.settings : result;

	if (asJson) {
		printf('%J\n', result);
		exit((length(wanted) && !result.ok) ? 1 : 0);
	}

	if (length(wanted) && !result.ok) {
		printf('%s\n', result.reason);
		exit(1);
	}

	if (type(values) != 'object')
		fail('bm.wanbind answered without any settings in it');

	for (let one in SETTINGS) {
		let value = values[one[0]];
		let shown = '-';

		if (one[0] == 'enabled')
			shown = value ? 'yes' : 'no';
		else if (type(value) == 'int')
			shown = sprintf('%d', value);

		printf('%-20s %-8s %s\n', one[0], shown, one[1]);
	}

	let band = values.band;
	if (type(band) == 'object' && band) {
		printf('\n');
		if (band.usable)
			printf('the one-to-one bindings are written at priorities %d-%d\n', band.base, band.top);
		else
			printf('no binding can be written: %s\n', band.reason);
	}

	printf('\nThe seven below direct_pref_base are what a new instance is stamped with. An\n');
	printf('instance already in the file keeps the numbers it was written with; change\n');
	printf('those with `bmwan instance set NAME --pref-base N`.\n');

	exit(0);
}

/*
 * Every binding in the file, and what the router is doing about each one.
 *
 * The refused and the switched-off are here too, for the same reason `status`
 * prints an instance that is not ready: a row that vanished is the hardest kind
 * of mistake to find, and these are exactly the rows somebody came looking for.
 *
 * The derived ones - the rules an instance writes for the clients it is handing
 * WANs to - are in the same table, because they are the same kind of thing and
 * they sit in the same rule table. SOURCE is what tells them apart, and
 * `--source manual` or `--source NAME` is how to ask for one kind.
 */
if (command == 'bindings') {
	let result = call('bindings', { id: flag('id'), source: flag('source') });

	if (asJson) {
		printf('%J\n', result);
		exit(0);
	}

	/*
	 * Whether this list is the router or a slice of it.
	 *
	 * The daemon says so, because it is the half that did the narrowing. The
	 * flags this process sent are the fallback for a daemon too old to carry
	 * the field: they answer the same question - was anything asked for - from
	 * the only other side that knows it.
	 */
	let narrowed = (type(result.filtered) == 'bool')
		? result.filtered
		: (length(flag('id')) > 0 || length(flag('source')) > 0);

	/*
	 * What the router holds, which is not what the table below shows whenever
	 * the list was narrowed - the daemon counts before it filters, on purpose.
	 *
	 * Guarded once here for both the empty case and the footer, and both go
	 * unsaid when the figures are missing rather than being printed as zero. A
	 * figure this process invented reads as "no instance is seating anybody",
	 * which is a fault somebody would then go looking for.
	 */
	let counts = (type(result.counts) == 'object' && result.counts) ? result.counts : null;
	let counted = (counts && type(counts.manual) == 'int' && type(counts.derived) == 'int') ? true : false;
	let holds = counted
		? sprintf('%d placed by hand, %d seated by an instance', counts.manual, counts.derived)
		: '';

	/*
	 * Nothing to show, and two entirely different reasons for it that no reader
	 * can tell apart from an empty table.
	 *
	 * `--source home` matching nothing on a router with four bindings in the
	 * file used to print "no binding in /etc/config/bm_wanbind" and point at
	 * the commented template in it: a statement about the whole router, made
	 * about a view that had been narrowed until it could not hold a row. So the
	 * narrowed case names the filter that matched nothing and then says what
	 * the router does hold, which is what turns the next look towards the
	 * filter rather than towards a file that was never the problem.
	 */
	if (!length(result.bindings)) {
		if (!narrowed) {
			printf('no binding in /etc/config/bm_wanbind, and no instance is seating a client\n');
			printf('There is a commented template in that file, and `bmwan bind` writes them.\n');
			exit(0);
		}

		let asked = [];

		if (length(flag('id')))
			push(asked, sprintf('--id %s', flag('id')));

		if (length(flag('source')))
			push(asked, sprintf('--source %s', flag('source')));

		// The flags as they were typed, because those are what has to change.
		// The list is empty only if a daemon narrowed by something this process
		// did not send, and saying "that filter" is the honest sentence there.
		printf('no binding matched %s\n', length(asked) ? join(' ', asked) : 'that filter');

		if (counted && (counts.manual + counts.derived) > 0)
			printf('This router holds %s; `bmwan bindings` with no filter lists them.\n', holds);
		else if (counted)
			printf('This router holds no binding at all, and no instance is seating a client.\n');

		exit(0);
	}

	printf('%-12s %-9s %-17s %-9s %-9s %6s %6s %s\n',
		'BINDING', 'SOURCE', 'ADDRESS', 'WAN', 'STATE', 'PREF', 'TABLE', 'NAME');

	let doubted = false;
	let seated = false;

	for (let one in result.bindings) {
		let state = length(one.state) ? one.state : 'pending';

		/*
		 * Who put it there, which is the one thing this table cannot be read
		 * without now that it holds both kinds of row.
		 *
		 * A hand-placed row is a section in /etc/config/bm_wanbind and `unbind`
		 * removes it. An instance's name is a seat that instance is holding for
		 * a client, there is no section behind it, and `unbind` refuses it by
		 * name. So SOURCE is not decoration - it is which half of the manual
		 * applies to the row somebody is looking at.
		 */
		let placed = (one.source == 'manual' || !length(one.source));

		if (!placed)
			seated = true;

		// The rule was written, the kernel took it, and it was gone when the
		// daemon looked again. Marked on the row rather than reported at the
		// bottom, because the row is what says bound.
		if (one.verified === false) {
			state = state + '!';
			doubted = true;
		}

		printf('%-12s %-9s %-17s %-9s %-9s %6d %6d %s\n',
			one.id,
			placed ? 'by hand' : one.source,
			// The live address for a MAC binding, the address itself for the
			// other kind, and the raw text for one that is neither.
			length(one.ip) ? one.ip : one.label,
			one.wan,
			state,
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

	if (doubted)
		printf('\n! the rule was accepted by the kernel and was not there a moment later - `bmwan verify`\n');

	// Said once, under the table, and only when a seat is actually in it. The
	// rows look identical to hand-placed ones and the reason line under each of
	// them says which instance seated it, but neither says the thing somebody
	// reading this table is about to act on: that there is nothing here to
	// remove, and that the client is moved by a different command.
	if (seated) {
		printf('\nA row with an instance in SOURCE is a seat that instance is holding, not a section:\n');
		printf('it lasts as long as the client\'s lease and `unbind` refuses it. `bmwan unassign MAC`\n');
		printf('is what takes such a client off its WAN, and `bmwan release MAC` puts it back.\n');
	}

	if (counted) {
		/*
		 * These figures are the table when nothing was asked for, and are not
		 * the table when something was - the daemon counts before it narrows so
		 * that a filtered view still knows what the router holds. A footer that
		 * did not say which of the two it was would be read as a count of the
		 * rows either way, and on a narrowed list that is a wrong number.
		 *
		 * The old wording, "N by hand, 0 from instances", dates from when this
		 * list held sections only. The daemon answers instance seats here now,
		 * so the second figure is a real count rather than the constant zero it
		 * used to print on every router.
		 */
		if (narrowed)
			printf('\nshowing %d of %d; this router holds %s\n',
				length(result.bindings), counts.manual + counts.derived, holds);
		else
			printf('\n%s\n', holds);
	}

	// Guarded like the counts above it. The band is the one fault with no row to
	// hang itself on - a `direct_pref_base` reaching into an instance's range
	// refuses every future binding rather than any existing one - so reaching
	// through a reply that did not carry it is how that sentence goes missing.
	if (type(result.band) == 'object' && result.band && length(result.band.reason))
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
	let enabled = opposites('on', 'off');
	if (enabled !== null)
		payload.enabled = enabled;

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
	if (pref !== null)
		payload.pref = pref;

	let table = counted('table', 'the routing table the bound WAN puts its default route in');
	if (table !== null)
		payload.table = table;

	/*
	 * `--check` is the same call one step short of writing anything.
	 *
	 * The findings are what the app and LuCI show before their Save button, and
	 * they are worth having here for the same reason: a binding whose WAN is one
	 * of this router's own LANs is refused, and being told that before the
	 * section exists is better than being told it by a row that never binds.
	 */
	if (exists(opts, 'check')) {
		let checked = call('bind_check', payload);

		if (asJson) {
			printf('%J\n', checked);
			exit(errors(checked.findings) ? 1 : 0);
		}

		let bad = printFindings(checked.findings);

		printf(bad
			? '\nnothing was written, and `bmwan bind` would refuse this too.\n'
			: '\nnothing to refuse; the same command without --check writes it.\n');

		exit(bad ? 1 : 0);
	}

	let result = call('bind', payload);

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		printFindings(result.findings);
		exit(1);
	}

	/*
	 * The section was written. The row is the daemon's account of what it was
	 * written as, and `bind` answers `binding: null` when the pass that ran
	 * inside the call could not read one back.
	 *
	 * Reading through it unguarded printed the receipt below with "(null)" in
	 * four places - a sentence saying an address leaves by a WAN at a priority
	 * into a table, with the address, the WAN, the priority and the table all
	 * missing. Somebody reading that has been told nothing and shown a form.
	 */
	let one = result.binding;

	if (type(one) == 'object' && one) {
		printf('%s: %s leaves by %s, at ip rule priority %d into table %d\n',
			one.id, length(one.ip) ? one.ip : one.label, one.wan, one.pref,
			one.table ? one.table : one.stampedTable);
		printf('  %s\n', (one.whenDown == 'hold')
			? sprintf('while %s is down it has no way out at all', one.wan)
			: sprintf('while %s is down it leaves over whatever the router would have used', one.wan));

		// The pass that ran inside the call may not have got as far as a rule -
		// a MAC with no lease yet, a WAN that is down. Said here rather than
		// left to be discovered, because the line above reads like a promise.
		if (length(one.state) && one.state != 'bound')
			printf('  it is %s right now: %s\n', one.state, one.reason);
	}
	else {
		printf('%s was written to /etc/config/bm_wanbind, and the daemon reported no row for it.\n', id);
		printf('The section is there and the next pass reconciles it either way; `bmwan bindings`\n');
		printf('says what the router is doing about it, and `bmwan check` reads the section back\n');
		printf('without the daemon at all.\n');
	}

	printFindings(result.findings);

	exit(0);
}

/*
 * What this process is costing and how much work it has done.
 *
 * The named figures the usage line promises, and not the reply object: a raw
 * dump is not a shorter way of printing this, it is the whole answer in the one
 * shape a person at a console cannot read - and printing it either way meant
 * `--json`, the flag that asks for exactly that shape, changed nothing at all.
 *
 * The last line is not about this process. It is the kernel disagreeing with it
 * afterwards, and it is the number that explains an address on the wrong WAN
 * while every row on every screen reads bound.
 */
if (command == 'stats') {
	let result = call('stats', {});

	if (asJson) {
		printf('%J\n', result);
		exit(0);
	}

	printf('%-18s %s kB\n', 'memory', figure(result.rssKb));
	printf('%-18s %s seconds\n', 'up', figure(result.uptime));
	printf('%-18s %s\n', 'events handled', figure(result.eventsHandled));
	printf('%-18s %s\n', 'clients seated', figure(result.assigned));
	printf('%-18s %s\n', 'clients released', figure(result.released));
	printf('%-18s %s\n', 'waiting', figure(result.queueDepth));
	printf('%-18s %s ms\n', 'last pass', figure(result.lastPassMs));

	let gone = unverified(result);
	if (gone) {
		printf('\n%d rule(s) were accepted by the kernel and were not there a moment later; `bmwan verify`\n',
			gone);
	}

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
	let core = (type(result.core) == 'object') ? result.core : result.direct;
	if (core) {
		if (!core.ok)
			printf('bindings: %s\n', core.reason);
		else
			printf('bindings: %d of %d bound, %d held, %d on the main table, %d stranded, %d rule(s) written, %d removed, %dms\n',
				core.bound, core.bindings, core.held, core.fallback, core.stranded,
				core.added, core.removed, core.passMs);
	}

	/*
	 * The counter is on the half that wrote the rules, not at the top level.
	 *
	 * `result.unverified` is nothing on any daemon this CLI talks to, so the
	 * guard was never true and the one line that names a second writer on the
	 * router never printed after a pass - which is the pass that would have just
	 * had its work removed. The already-resolved `core` goes in rather than the
	 * whole reply, so the `direct` spelling an older daemon uses counts too.
	 */
	let gone = unverified({ core: core });
	if (gone) {
		printf('%d rule(s) were accepted by the kernel and were not there a moment later; `bmwan verify`\n',
			gone);
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
 * The four instance commands.
 *
 * `check` is the whole of `add` and `set` minus the writing, and the other two
 * run it first and stop on an error finding rather than sending a spec the
 * daemon is only going to refuse - which would leave somebody reading a refusal
 * about a section that was never written and wondering what state it is in.
 *
 * `delete` is the one that has to work with no daemon at all. What it does
 * there is the first half of what the daemon does here, in the order that
 * matters: the rules come off before the section goes, because a rule is
 * recognised by where it sits and a section that has gone is a set of rules
 * nothing left on the router will admit to.
 */
if (command == 'instance') {
	let action = length(args) > 1 ? args[1] : '';
	let name = length(args) > 2 ? args[2] : '';

	if (!(action in [ 'check', 'add', 'set', 'delete' ]))
		fail('the instance commands are check, add, set and delete - `bmwan help` shows the flags');

	if (!length(name))
		fail(action + ' which instance? `bmwan instances` lists them');

	if (action == 'check' || action == 'add' || action == 'set') {
		let spec = instanceSpec(name);

		// `--check` means the same on `add` and `set` as the word does on its
		// own. Ignoring a flag whose whole meaning is "write nothing" is not a
		// thing this file may do quietly.
		let dry = (action == 'check') || exists(opts, 'check');

		// Which of the two words is right is a question about the file, and the
		// file is readable from here whether or not the daemon is. `set` on a
		// name that is not there would otherwise create a half-specified
		// instance, and `add` on one that is would quietly edit it.
		if (action != 'check') {
			let already = false;

			for (let row in cfg.configured()) {
				if (row.id == name)
					already = true;
			}

			if (action == 'add' && already)
				fail('there is already an instance called ' + name + '; `bmwan instance set ' + name + '` changes it');

			if (action == 'set' && !already) {
				fail('there is no instance called ' + name +
					'; `bmwan instance add ' + name + ' --lan lan --carrier eth1` writes one');
			}
		}

		let checked = call('instance_check', spec);
		let bad = errors(checked.findings);

		if (dry || bad) {
			if (asJson) {
				printf('%J\n', checked);
				exit(bad ? 1 : 0);
			}

			printFindings(checked.findings);
		}

		if (bad) {
			printf(action == 'check'
				? '\nthe daemon would refuse this as it is.\n'
				: '\nnothing was written.\n');
			exit(1);
		}

		if (dry) {
			// What the router would stamp into the section. Printed because
			// these are the numbers nobody chose and everybody has to know: the
			// priorities a rule of this instance's will be recognised by later.
			let got = checked.allocated;
			if (type(got) == 'object' && type(got.rule_pref_base) == 'int') {
				printf('\nclient rules from priority %d, catch-all at %d into table %d\n',
					got.rule_pref_base, got.catch_all_pref, got.catch_all_table);
			}

			let scope = checked.scope;
			if (type(scope) == 'object' && scope) {
				printf('binds %s\n', length(arrayOr(scope.cidrs))
					? join(' ', scope.cidrs)
					: scope.lanCidr);
			}

			if (length(arrayOr(checked.pool)))
				printf('pool: %s\n', join(' ', checked.pool));

			// A count rather than the list, because what matters is that there
			// is one: anything that moved means the rules that are there now
			// come off before the new ones go on.
			let moves = (type(checked.moves) == 'array')
				? length(checked.moves)
				: ((type(checked.moves) == 'int') ? checked.moves : 0);

			if (moves)
				printf('%d thing(s) moved, so its rules come off before the new ones go on\n', moves);

			if (checked.ok)
				printf('\nnothing to refuse; the same flags without `check` write it.\n');
			else
				printf('\n%s\n', length(checked.reason) ? checked.reason : 'the daemon would not accept this as it is');

			exit(checked.ok ? 0 : 1);
		}

		let result = call('instance_set', spec);

		if (asJson) {
			printf('%J\n', result);
			exit(result.ok ? 0 : 1);
		}

		if (!result.ok) {
			printf('%s\n', result.reason);
			printFindings(result.findings);
			exit(1);
		}

		printFindings(result.findings);

		let row = result.instance;
		if (type(row) == 'object' && row) {
			printf('%s: lan %s, carrier %s, %s per WAN, %s\n',
				row.id, row.lan, row.carrier, perWan(row.clientsPerWan),
				length(row.rangeFrom) ? sprintf('%s-%s', row.rangeFrom, row.rangeTo) : 'the whole LAN');
			printf('  client rules from priority %d, catch-all at %d into table %d\n',
				row.rulePrefBase, row.catchAllPref, row.catchAllTable);
		}

		if (type(result.flushed) == 'int' && result.flushed)
			printf('  %d rule(s) came off first\n', result.flushed);

		/*
		 * What the router had to be given before a rule of this instance's
		 * would mean anything.
		 *
		 * Four separate things, and none of them is the instance itself: a
		 * routing table for every WAN in its pool, a firewall forwarding from
		 * its LAN to each of them, the catch-all that makes an unseated client
		 * fail closed, and - only when it was asked for - room in dnsmasq for
		 * as many leases as the pool can seat. Any of them missing is a section
		 * that reads correct and a client that goes out of the wrong line, so
		 * they are named here rather than left in the log.
		 */
		let made = result.prepared;
		if (type(made) == 'object' && made) {
			for (let one in arrayOr(made.tables))
				printf('  %s puts its routes in table %d\n', one.wan, one.table);

			if (type(made.forwardings) == 'int' && made.forwardings)
				printf('  %d firewall forwarding(s) let its LAN out over the pool\n', made.forwardings);

			// The blocks it fences when the daemon lists them, and the bare fact
			// of one when it only says there is one. Either way this is the line
			// that says a client with no WAN is stopped rather than quietly
			// sharing whatever the router itself uses.
			if (type(made.catchAll) == 'array' && length(made.catchAll)) {
				printf('  its catch-all fences %s, so a client with no WAN has no way out rather than the router\'s own\n',
					join(' ', made.catchAll));
			}
			else if (made.catchAll === true) {
				printf('  its catch-all is in place, so a client with no WAN has no way out rather than the router\'s own\n');
			}

			// `prepare` answers with a finished sentence when the ceilings could
			// not be raised, and with nothing when they were already high
			// enough - so silence here is the good outcome and not a gap.
			let dhcp = made.dhcp;
			if (type(dhcp) == 'string' && length(dhcp)) {
				printf('  %s\n', dhcp);
			}
			else if (type(dhcp) == 'object' && dhcp) {
				if (length(dhcp.reason))
					printf('  %s\n', dhcp.reason);
				else if (dhcp.wrote)
					printf('  the dnsmasq lease ceilings were raised to fit the LAN\n');
			}
		}

		let pass = result.pass;
		if (type(pass) == 'object' && pass && type(pass.bound) == 'int')
			printf('  %d bound, %d waiting\n', pass.bound, pass.waiting);

		if (type(result.unverified) == 'int' && result.unverified) {
			printf('  %d rule(s) were accepted by the kernel and were not there a moment later; `bmwan verify`\n',
				result.unverified);
		}

		exit(0);
	}

	let conn = bus();

	if (conn) {
		let result = conn.call('bm.wanbind', 'instance_delete', { id: name });

		if (type(result) != 'object') {
			fail('bm.wanbind gave no answer to instance_delete. A daemon older than 2.4.0 does not ' +
				'have that call; stop the service and run this again to take the rules off from here.');
		}

		if (asJson) {
			printf('%J\n', result);
			exit(result.ok ? 0 : 1);
		}

		if (!result.ok) {
			printf('%s\n', result.reason);
			exit(1);
		}

		printf('instance %s removed, with %d rule(s) and %d firewall forwarding(s)\n',
			result.id, result.removed, result.forwardings);

		// Set when the section is gone and something was left on the router.
		if (length(result.reason))
			printf('%s\n', result.reason);

		exit(0);
	}

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

		// Scoped by the LAN's subnet when netifd will name one, which is what
		// the daemon's own `instance_delete` does with the same two lines. A
		// sibling instance sharing this LAN with a different address range has
		// client rules in a band that overlaps this one's, and the subnet is
		// the only thing that keeps this delete from taking them too. Null when
		// netifd says nothing: this is the teardown path, and a rule of the
		// deleted instance's left behind is the worse of the two faults here.
		let list = netifd();

		printf('removed %d rule(s) from %s\n',
			ruleset.flush(one, present, (list !== null) ? wans.lanCidr(list, one.lan) : null), name);
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

	// The firewall forwardings and the saved state are the daemon's half of
	// this, and there is no daemon. Named rather than left unsaid, because a
	// section that is gone is a forwarding nothing will ever mention again.
	printf('instance %s removed. Its firewall forwardings and its saved state are the daemon\'s\n', name);
	printf('half of this and are still there; the first pass after the service starts sweeps them.\n');
	exit(0);
}

/*
 * Remove a binding: the section, and then the pass that takes its rule off.
 *
 * Over ubus, unlike the offline half of `instance delete` above, and the
 * difference is not an inconsistency. An instance's rules can only be found
 * through the priority range in its own section, so they have to come off
 * before it is deleted and this file can do that with no daemon at all. A
 * binding's rule lives in a band the daemon owns and reconciles as a whole:
 * deleting the section is how the rule becomes unwanted, and the pass is what
 * notices. There is nothing useful this process could do on its own except take
 * every binding's rule off, which is `flush`, and which is a different request.
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

	/*
	 * The subnet one named instance's rules are recognised by, and only then.
	 *
	 * A client rule used to be told from everybody else's by its priority
	 * alone, which was enough while an instance owned a whole LAN. Since 2.4.0
	 * two of them may share one LAN with disjoint address ranges, so the band
	 * no longer separates them - and `ruleset.flush` with no subnet to scope by
	 * takes the sibling's clients off the router along with the named one's.
	 * That is a working instance losing every rule it has, as a side effect of
	 * stopping the one next to it.
	 *
	 * So the LAN comes from netifd, the way the daemon reads it, and a netifd
	 * that will not answer is refused below rather than quietly flushed wide.
	 *
	 * A plain `bmwan flush` is a different command with the same name: the
	 * uninstall, run by `prerm` and by the init script with the service already
	 * stopped, where every rule this package wrote has to come off and a rule
	 * left behind is the fault. It asks netifd nothing, because on that router
	 * netifd may be going away too.
	 */
	let list = length(instance) ? netifd() : null;

	if (length(instance) && list === null) {
		fail('netifd is not answering, so the LAN subnet ' + instance + ' hands addresses out on could ' +
			'not be read - and without it this cannot tell that instance\'s rules from those of another ' +
			'sharing the same LAN. Nothing was removed. `bmwan flush` with no --instance takes every rule ' +
			'this package wrote off, which is the uninstall and not this.');
	}

	let removed = 0;
	let touched = 0;

	for (let one in cfg.instances()) {
		if (length(instance) && one.id != instance)
			continue;

		let lanCidr = null;

		if (length(instance)) {
			lanCidr = wans.lanCidr(list, one.lan);

			// netifd answered and named no address on that interface, which is
			// the same hole as no answer at all: there is nothing to scope by,
			// and flushing anyway would be the wide flush this refuses.
			if (lanCidr === null) {
				fail('netifd names no IPv4 address on ' + one.lan + ', so the subnet ' + one.id +
					' hands addresses out on could not be read and its rules cannot be told from those of ' +
					'another instance on the same LAN. Nothing was removed. Bring ' + one.lan +
					' up and run this again, or use `bmwan flush` with no --instance, which takes ' +
					'every rule this package wrote off.');
			}
		}

		removed += ruleset.flush(one, present, lanCidr);
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
