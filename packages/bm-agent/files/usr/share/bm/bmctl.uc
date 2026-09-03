// The command line, for a console, a serial cable, or anybody who would rather
// read the router than a web page.
//
// It reads the same functions the ubus object does rather than going through
// ubus for everything, which matters more than it sounds: the moment somebody
// runs this is usually the moment the service is not answering, and a CLI that
// can only relay ubus is a CLI that goes quiet exactly when it is needed. Where
// the answer genuinely belongs to the running process - the counters in
// `stats` - it asks ubus and says so when it could not.

import { connect } from 'ubus';

import { info, stats } from 'bm.agent';
import { run as configCommand, USAGE as CONFIG_USAGE } from 'bm.cliconfig';
import { compute as capacityCompute } from 'bm.capacity';
import { compatibility } from 'bm.meta';
import { plan, run } from 'bm.migrate';
import { install as installPackages, report as requirementsReport } from 'bm.requirements';
import { apply as tuneApply, current as tuneCurrent, memory as tuneMemory, recommended as tuneRecommended, scale as tuneScale } from 'bm.tune';
import { apply as applyUpdate, check as checkUpdate, last as lastUpdate, rollback } from 'bm.update';
import { API_VERSION, CONFIG_SCHEMA, RELEASE } from 'bm.version';

const USAGE = 'usage: bmctl <command> [--json] [--dry-run]\n' +
	'\n' +
	'  version         the installed release and the module API version\n' +
	'  info            the version handshake, as the module receives it\n' +
	'  stats           memory and request counters from the running service\n' +
	'  schema          what shape this router\'s data is in\n' +
	'  migrate         bring that data forward, one step at a time\n' +
	'                    --dry-run  list the steps and change nothing\n' +
	'  config          snapshots, restore, and the commit-confirm guard\n' +
	'                    bmctl config help  for the rest\n' +
	'  check-update    ask the release URL what is published (nothing else does)\n' +
	'  update          take it: guard, download, verify, install, migrate\n' +
	'                    --dry-run    check and stop\n' +
	'                    --no-guard   do not arm the countdown first\n' +
	'                    --timeout N  how long the countdown runs\n' +
	'  rollback        reinstall the package set this router had before\n' +
	'  requirements    what this router has of what every feature needs\n' +
	'  install-group   close one gap: bmctl install-group pppoe|ipfull|dnsmasq\n' +
	'                    --dry-run  say which packages, install nothing\n' +
	'  tune            the scale limits. Bare: read them. With key=value\n' +
	'                    pairs: apply and persist, e.g.\n' +
	'                    bmctl tune conntrack_max=262144 gc_thresh3=16384\n' +
	'                    keys: conntrack_max gc_thresh1 gc_thresh2 gc_thresh3\n' +
	'                          flow_offload (0/1, fw4 software offload)\n' +
	'  capacity        what this router has against what its configuration\n' +
	'                    needs, where it is estimated to stop, and what to do\n' +
	'                    about it. Exit 1 when the answer is unstable or\n' +
	'                    unknown, so a script can watch it\n' +
	'  help            this text\n';

// Present as a separate question from `info`, because "the files are installed"
// and "the service is answering" are different states with different fixes, and
// folding them together is how a stopped daemon comes to look like a broken
// install.
function bus() {
	let conn = connect();
	if (!conn)
		return null;

	let objects = conn.list();
	if (type(objects) != 'array' || !('bm.agent' in objects))
		return null;

	return conn;
}

function emit(value, asJson) {
	if (asJson) {
		printf('%J\n', value);
		return;
	}

	for (let key in value) {
		let item = value[key];
		let text = (type(item) == 'array' || type(item) == 'object')
			? sprintf('%J', item)
			: sprintf('%s', item);
		printf('%-12s %s\n', key, text);
	}
}

let args = [];
let asJson = false;
let dryRun = false;
let timeout = null;
let reason = null;
// On unless somebody says otherwise. A change applied with no way back is the
// one thing the router-side half exists to make unnecessary.
let guard = true;

// Options anywhere, in either spelling, because this is typed at a console
// under exactly the circumstances where getting the word order wrong and being
// told so is most annoying.
let expect = null;

for (let arg in ARGV) {
	if (expect) {
		if (expect == 'timeout')
			timeout = int(arg);
		else
			reason = arg;
		expect = null;
		continue;
	}

	if (arg == '--json')
		asJson = true;
	else if (arg == '--dry-run' || arg == '-n')
		dryRun = true;
	else if (arg == '--no-guard')
		guard = false;
	else if (arg == '--timeout' || arg == '--reason')
		expect = substr(arg, 2);
	else {
		let paired = match(arg, /^--(timeout|reason)=(.*)$/);

		if (paired && paired[1] == 'timeout')
			timeout = int(paired[2]);
		else if (paired)
			reason = paired[2];
		else
			push(args, arg);
	}
}

let command = length(args) ? args[0] : 'help';

if (command == 'help' || command == '-h' || command == '--help') {
	print(USAGE);
	exit(0);
}

if (command == 'version') {
	if (asJson)
		printf('%J\n', { release: RELEASE, apiVersion: API_VERSION });
	else
		printf('bm-agent %s (module API %d)\n', RELEASE, API_VERSION);
	exit(0);
}

if (command == 'info') {
	let conn = bus();
	let value = info();

	// Read off the disk either way; what ubus adds is whether anything is
	// listening, which the module needs to know and a user reading this wants
	// to be told without having to run a second command.
	value.service = conn ? 'running' : 'stopped';

	let previous = lastUpdate();
	if (previous)
		value.lastUpdate = previous;

	emit(value, asJson);
	exit(0);
}

if (command == 'stats') {
	let conn = bus();

	if (!conn) {
		// Deliberately not the local numbers dressed up as the service's. This
		// process has been alive for a few milliseconds and has served nothing;
		// printing that as though it were the daemon's would be a lie in the
		// one command somebody runs to find out what the daemon is doing.
		warn('bm-agent is not running - no counters to report\n');
		exit(1);
	}

	let answer = conn.call('bm.agent', 'stats', {});
	emit(type(answer) == 'object' ? answer : stats(), asJson);
	exit(0);
}

if (command == 'schema') {
	let compat = compatibility();
	let value = {
		build: CONFIG_SCHEMA,
		data: compat.fresh ? null : compat.schema,
		fresh: compat.fresh === true,
		ok: compat.ok
	};

	if (compat.reason)
		value.reason = compat.reason;

	if (asJson) {
		printf('%J\n', value);
	}
	else if (compat.fresh) {
		printf('schema %d; nothing has been written on this router yet\n', CONFIG_SCHEMA);
	}
	else if (!compat.ok) {
		printf('schema %d on disk, this build understands %d\n', compat.schema, CONFIG_SCHEMA);
		printf('%s\n', compat.reason);
	}
	else if (compat.pending > 0) {
		printf('schema %d on disk, %d ahead in this build - run `bmctl migrate`\n',
			compat.schema, compat.pending);
	}
	else {
		printf('schema %d, up to date\n', CONFIG_SCHEMA);
	}

	exit(compat.ok ? 0 : 1);
}

if (command == 'migrate') {
	// The plan is built end to end before anything runs, so a router that is
	// missing a step in the middle of the chain is told which one before a
	// single file is touched rather than half way through.
	if (dryRun) {
		let intent = plan();

		if (asJson) {
			printf('%J\n', intent);
			exit(intent.ok ? 0 : 1);
		}

		if (!intent.ok) {
			printf('%s\n', intent.reason);
			exit(1);
		}

		if (!length(intent.steps)) {
			printf('nothing to do: schema %d\n', intent.to);
			exit(0);
		}

		printf('%d step(s), schema %d -> %d:\n', length(intent.steps), intent.from, intent.to);
		for (let step in intent.steps)
			printf('  %-28s %d -> %d  %s\n', step.file, step.from, step.to, step.describe);

		exit(0);
	}

	let result = run(false);

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		printf('%d step(s) applied before it stopped; the stamp is at the last one that finished\n',
			length(result.applied));
		exit(1);
	}

	if (!length(result.applied))
		printf('nothing to do: schema %d\n', result.to);
	else
		printf('schema %d -> %d, %d step(s)\n', result.from, result.to, length(result.applied));

	exit(0);
}

if (command == 'check-update') {
	// The only thing on this router that reaches out to the internet, and it
	// only does so because somebody typed this.
	let found = checkUpdate();

	if (asJson) {
		printf('%J\n', found);
		exit(found.ok ? 0 : 1);
	}

	if (!found.ok) {
		printf('%s\n', found.reason);
		if (found.hint)
			printf('%s\n', found.hint);
		exit(1);
	}

	printf('installed  %s\n', found.current);
	printf('published  %s\n', found.latest);
	printf('signed by  %s\n', found.key);

	if (found.newer === true)
		printf('\nAn update is available. `bmctl update` takes it.\n');
	else if (found.newer === null)
		printf('\nThose two versions cannot be compared, so this router will not act on it.\n');
	else
		printf('\nNothing to do.\n');

	if (length(found.notes))
		printf('\n%s\n', found.notes);

	exit(0);
}

if (command == 'update') {
	let result = applyUpdate({ dryRun: dryRun, guard: guard, timeout: timeout });

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		if (result.hint)
			printf('%s\n', result.hint);
		exit(1);
	}

	if (result.dryRun) {
		printf('would update %s -> %s: %s\n', result.current, result.latest,
			join(', ', result.packages));
		exit(0);
	}

	printf('updated %s -> %s: %s\n', result.from, result.to, join(', ', result.packages));

	if (!result.migrated)
		printf('the migration did not finish - run `bmctl schema` to see why\n');

	if (result.guard) {
		// Said plainly, because the countdown is running while somebody reads
		// this and the consequence of ignoring it is the update being undone.
		printf('\nA guard is armed for %ds. Run `bmctl config confirm` to keep this,\n',
			result.guard.timeout);
		printf('or leave it and the router restores snapshot %s on its own.\n',
			result.guard.snapshot);
	}

	exit(0);
}

if (command == 'rollback') {
	let result = rollback({ guard: guard, timeout: timeout });

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		exit(1);
	}

	printf('rolled back to %s\n', join(', ', result.packages));

	if (result.guard) {
		printf('\nA guard is armed for %ds. Run `bmctl config confirm` to keep this.\n',
			result.guard.timeout);
	}

	exit(0);
}

if (command == 'requirements') {
	let found = requirementsReport();

	if (asJson) {
		printf('%J\n', found);
		exit(0);
	}

	if (!found.asked) {
		printf('the shell could not be asked, so nothing here is known\n');
		exit(1);
	}

	for (let entry in found.rows) {
		let mark = entry.ok == null ? '?' : (entry.ok ? 'ok' : '!!');
		printf('%-3s %-32s %s\n', mark, entry.label, entry.detail);
		if (entry.ok == false && entry.group)
			printf('    fix: bmctl install-group %s\n', entry.group);
	}

	exit(0);
}

if (command == 'install-group') {
	let group = length(args) > 1 ? args[1] : '';
	let result = installPackages({ group: group, dry_run: dryRun });

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		exit(1);
	}

	if (result.dryRun) {
		printf('would install: %s\n', join(', ', result.packages));
		exit(0);
	}

	printf('installed %s\n', join(', ', result.packages));
	printf('run `bmctl requirements` to see what changed\n');
	exit(0);
}

if (command == 'tune') {
	// Pairs come as plain arguments (`tune conntrack_max=262144`), so the
	// option parser above stays untouched and word order stays free.
	let wanted = {};
	let bad = null;

	for (let raw in slice(args, 1)) {
		let pair = match(raw, /^([a-z0-9_]+)=([0-9]+)$/);
		if (!pair) {
			bad = raw;
			continue;
		}

		if (pair[1] == 'flow_offload')
			wanted.flow_offload = pair[2] != '0';
		else
			wanted[pair[1]] = int(pair[2]);
	}

	if (bad != null) {
		warn('bmctl tune: cannot read "' + bad + '" - expected key=value with a numeric value\n');
		exit(1);
	}

	if (!length(keys(wanted))) {
		let state = tuneCurrent();

		if (asJson) {
			printf('%J\n', state);
			exit(0);
		}

		for (let key in sort(keys(state.values))) {
			let value = state.values[key];
			printf('%-18s %s\n', key, value == null ? 'unknown' : sprintf('%s', value));
		}
		printf('\npersisted in %s: %J\n', state.file, state.persisted);

		// What this router is carrying, and what its tables should be for it.
		// The same arithmetic the app's Router limits page offers, so a console
		// and a page cannot give somebody two different numbers.
		let advice = tuneRecommended(tuneScale(), tuneMemory());

		printf('\nfor %d client(s) and %d session(s) on this router:\n',
			tuneScale().clients, tuneScale().sessions);
		printf('%-18s %d\n', 'conntrack_max', advice.conntrack_max);
		printf('%-18s %d\n', 'gc_thresh1', advice.gc_thresh1);
		printf('%-18s %d\n', 'gc_thresh2', advice.gc_thresh2);
		printf('%-18s %d\n', 'gc_thresh3', advice.gc_thresh3);

		if (advice.mem_capped) {
			printf('\nconntrack_max is held down by this router-s memory: a full table at 320 bytes\n');
			printf('an entry would be an eighth of its RAM.\n');
		}

		printf('\napply them with `bmctl tune conntrack_max=%d gc_thresh1=%d gc_thresh2=%d gc_thresh3=%d`\n',
			advice.conntrack_max, advice.gc_thresh1, advice.gc_thresh2, advice.gc_thresh3);

		exit(0);
	}

	let result = tuneApply(wanted);

	if (asJson) {
		printf('%J\n', result);
		exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		exit(1);
	}

	printf('applied %J\n', result.applied);
	if (result.persisted)
		printf('persisted in %s, replayed at every boot\n', result.file);
	if (result.flowOffload != null)
		printf('flow offload %s%s\n', result.flowOffload ? 'on' : 'off',
			result.reloaded ? ', firewall reloaded' : ' - reload the firewall to apply it');
	exit(0);
}

if (command == 'capacity') {
	// `compute` rather than `report`, because a person at a console asking a
	// second time means "again", not "the same answer you gave me eight seconds
	// ago". The daemons are asked over a connection of this command's own, and a
	// router with neither of them running still gets a report - the load is read
	// off the files rather than off the daemons.
	let bus = null;

	try {
		bus = connect();
	}
	catch (e) {
		bus = null;
	}

	let found = capacityCompute({ bus: bus });

	if (bus)
		bus.disconnect();

	// The same verdict in both modes. `--json` is the mode a script uses, and it
	// was the one mode that always exited 0 - so a monitor watching this command
	// would have called an unstable router healthy, which is the opposite of
	// what the exit code is for. The USAGE text promised otherwise.
	let verdict = (type(found.stability) == 'object') ? text(found.stability.level) : '';
	let bad = (!found.ok || verdict == 'unstable' || verdict == 'unknown');

	if (asJson) {
		printf('%J\n', found);
		exit(bad ? 1 : 0);
	}

	if (!found.ok) {
		printf('%s\n', found.reason);
		exit(1);
	}

	let hw = found.hardware;
	let sw = found.software;
	let load = found.load;
	let need = found.needed;
	let cap = found.ceiling;

	let say = function(value) {
		return (value == null) ? 'unknown' : sprintf('%d', value);
	};

	let mb = function(kb) {
		return (type(kb) != 'int') ? 'unknown' : sprintf('%d MB', kb / 1024);
	};

	printf('hardware\n');
	printf('  %-16s %s\n', 'board', length(hw.board) ? hw.board : 'unknown');
	printf('  %-16s %s x %s (%s, %s)\n', 'cpu', say(hw.cpus),
		length(hw.cpuModel) ? hw.cpuModel : 'unknown model',
		length(hw.arch) ? hw.arch : 'unknown arch',
		length(hw.target) ? hw.target : 'unknown target');
	printf('  %-16s %s total, %s available%s\n', 'memory', mb(hw.memTotalKb), mb(hw.memAvailableKb),
		hw.memAvailableEstimated ? ' (estimated)' : '');
	printf('  %-16s %s free of %s on %s\n', 'flash', mb(hw.flashFreeKb), mb(hw.flashTotalKb),
		length(hw.flashMount) ? hw.flashMount : 'unknown');
	printf('  %-16s %s\n', 'ports', hw.nicsKnown ? sprintf('%d', hw.nicCount) : 'unknown');
	printf('  %-16s %s, load %.2f %.2f %.2f\n', 'kernel',
		length(hw.kernel) ? hw.kernel : 'unknown', hw.load1, hw.load5, hw.load15);

	printf('\nsoftware\n');
	printf('  %-16s OpenWrt %s\n', 'release', length(sw.release) ? sw.release : 'unknown');
	printf('  %-16s agent %s, wanbind %s, pppoe %s, luci %s\n', 'packages',
		sw.packages.agent,
		sw.packages.wanbind == null ? 'not installed' : sw.packages.wanbind,
		sw.packages.pppoe == null ? 'not installed' : sw.packages.pppoe,
		sw.packages.luci == null ? 'not installed' : sw.packages.luci);
	printf('  %-16s %s, offload %s (kernel %s, hardware %s)\n', 'firewall',
		sw.fw4 === true ? 'fw4 present' : 'fw4 missing',
		sw.flowOffload == null ? 'unknown' : (sw.flowOffload ? 'on' : 'off'),
		sw.flowOffloadKernel == null ? 'unknown' : (sw.flowOffloadKernel ? 'has it' : 'has no module'),
		sw.hwOffload.capable);
	printf('  %-16s conntrack %s of %s, gc_thresh3 %s, dhcp leases %s%s\n', 'limits',
		say(sw.conntrackCount), say(sw.conntrackMax), say(sw.gcThresh3),
		say(sw.leaseMax), sw.leaseMaxDefault ? ' (default)' : '');

	printf('\nload\n');
	printf('  %-16s %d session(s) in %d pool(s), %d binding(s), %d instance(s)\n', 'configured',
		load.configured.members, length(load.configured.pools),
		load.configured.bindings, load.configured.instances);
	printf('  %-16s %s\n', 'pppoe',
		load.answered.pppoe
			? sprintf('%d session(s) up', load.live.sessionsUp)
			: 'bm-pppoe-pool is not answering');
	printf('  %-16s %s\n', 'wanbind',
		load.answered.wanbind
			? sprintf('%d bound, %d lease(s), %s ip rule(s)', load.live.bound, load.live.leases,
				say(load.live.ipRules))
			: 'bm-wanbind is not answering');

	printf('\nneeds %s of memory, %d core(s), %s of flash, conntrack %d, gc_thresh3 %d, %d lease(s)\n',
		mb(need.memKb), need.cpus, mb(need.flashKb), need.conntrackMax, need.gcThresh3, need.leaseMax);
	printf('ceiling ~%s session(s)%s and ~%s binding(s)%s at this hardware and these\n',
		say(cap.sessions),
		length(cap.limitedBy.sessions) ? sprintf(' (limited by %s)', cap.limitedBy.sessions) : '',
		say(cap.bindings),
		length(cap.limitedBy.bindings) ? sprintf(' (limited by %s)', cap.limitedBy.bindings) : '');
	printf('settings - an estimate, not a measurement%s\n',
		cap.basis.calibrated ? '' : ', from working numbers no rig has measured yet');

	printf('\ntier   sessions %s\n', found.tiers.sessions.label);

	if (found.tiers.sessions.next != null)
		printf('       next at %d: %s\n', found.tiers.sessions.next.at, found.tiers.sessions.next.label);

	printf('       bindings %s\n', found.tiers.bindings.label);

	if (found.tiers.bindings.next != null)
		printf('       next at %d: %s\n', found.tiers.bindings.next.at, found.tiers.bindings.next.label);

	printf('\nstability %s - %s\n\n', found.stability.level, found.stability.reason);

	// One list, requirements first, so the reading order is "what this needs"
	// and then "what is wrong with it right now".
	let rows = [];

	for (let one in found.requirements)
		push(rows, one);

	for (let one in found.issues)
		push(rows, one);

	let mark = function(level) {
		if (level == 'error')
			return '!!';

		if (level == 'warning')
			return '! ';

		if (level == 'pass')
			return 'ok';

		return '--';
	};

	for (let one in rows) {
		printf('%s %s\n', mark(one.level), one.label);

		if (length(one.detail))
			printf('     %s\n', one.detail);

		if (one.fix == null)
			continue;

		if (one.fix.kind == 'tune_set') {
			let pairs = '';

			for (let key in sort(keys(one.fix.args))) {
				let value = one.fix.args[key];

				pairs += sprintf(' %s=%s', key,
					type(value) == 'bool' ? (value ? '1' : '0') : sprintf('%d', value));
			}

			printf('     fix: bmctl tune%s\n', pairs);
		}
		else if (one.fix.kind == 'wanbind_reconcile')
			printf('     fix: bmwan reconcile\n');
		else if (one.fix.kind == 'wanbind_settings_set')
			printf('     fix: bmwan settings lan_local=1\n');
		else if (one.fix.kind == 'wanbind_instance_set')
			printf('     fix: bmwan instance set %s --raise-dhcp-limits\n', one.fix.args.id);
		else if (one.fix.kind == 'pool_reconcile')
			printf('     fix: bmpppoe reconcile\n');
	}

	// Something a script can watch: 0 while the router is carrying what it is
	// configured to carry, 1 where it is not or where nobody can tell.
	exit(bad ? 1 : 0);
}

// Everything about snapshots, restore and the guard, in its own file: this one
// stays a list of commands rather than becoming a wall of printing.
if (command == 'config') {
	exit(configCommand(slice(args, 1), {
		json: asJson,
		dryRun: dryRun,
		timeout: timeout,
		reason: reason
	}));
}

warn('bmctl: unknown command "' + command + '"\n\n');
warn(USAGE);
warn(CONFIG_USAGE);
exit(1);
