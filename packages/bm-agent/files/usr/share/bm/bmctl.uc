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
import { compatibility } from 'bm.meta';
import { plan, run } from 'bm.migrate';
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
