// A copy of the router's network configuration, taken before anything changes
// it, and small enough to keep ten of.
//
// Deliberately not `sysupgrade -b`. That is a backup of the whole of /etc, it
// takes seconds and megabytes, and restoring it is a different operation with
// different consequences - it would put back an SSH key, a hostname and a
// wireless password along with the one interface somebody meant to undo. What
// is here is the text of the packages this module writes to, which is small,
// diffable, and restorable in isolation.
//
// The rule and route captures are not restored. They are read back by a person
// working out what changed: `ip rule` is derived from the configuration, so
// putting the configuration back and reloading is what actually restores them,
// and importing a rule table directly would leave the router in a state no
// configuration file describes.

import { lsdir, mkdir, popen, readfile, rmdir, stat, unlink, writefile } from 'fs';

import { debug, err, notice } from 'bm.log';
import { ROOT, ensure } from 'bm.state';
import { CONFIG_SCHEMA, RELEASE } from 'bm.version';

export const DIR = ROOT + '/snapshots';

// The UCI packages a snapshot covers: everything this project writes to, plus
// the three of the router's own that it changes. Anything else on the router is
// somebody else's and is left strictly alone - a restore that also put back a
// wireless password would be a surprise nobody asked for.
// Exported because it is also the allowlist. Every name that reaches a shell -
// `uci export <name>` here, `uci import <name>` in bm.restore - is checked
// against this list first. The names in a snapshot's meta.json were written by
// this file, so they are already from here; checking anyway is what stops a
// hand-edited or truncated meta.json from turning a package name into a command.
export const PACKAGES = [ 'network', 'firewall', 'dhcp', 'bm_agent', 'bm_pppoe', 'bm_wanbind' ];

/** Whether `name` is a UCI package this project will read or write. */
export function known(name) {
	return type(name) == 'string' && (name in PACKAGES);
};

// Ten, plus a baseline that is never deleted. Ten is enough to walk back
// through an afternoon's work and few enough that the directory stays small on
// a router with 8 MB of flash.
const KEEP = 10;

// Over this, the oldest go. A snapshot of a large PPPoE pool is the big one -
// five thousand interface sections is a few hundred kilobytes of text - and a
// router that fills its overlay with its own safety net has made things worse.
const BUDGET_BYTES = 2 * 1024 * 1024;

export const BASELINE = 'baseline';

function run(command) {
	let handle = popen(command, 'r');
	if (!handle)
		return null;

	let text = handle.read('all');
	handle.close();
	return type(text) == 'string' ? text : null;
}

function ensureDir(path) {
	let info = stat(path);
	if (info && info.type == 'directory')
		return true;

	mkdir(path, 0o700);
	info = stat(path);
	return (info && info.type == 'directory') ? true : false;
}

// `guard`, `before-pool-create`. Anything else becomes part of a directory
// name, so it is reduced to something a shell will never have an opinion about.
function slug(reason) {
	let text = lc(trim(type(reason) == 'string' ? reason : ''));
	text = replace(text, /[^a-z0-9]+/g, '-');
	text = replace(text, /^-+|-+$/g, '');
	return length(text) ? substr(text, 0, 32) : 'manual';
}

function removeTree(path) {
	let names = lsdir(path);
	if (type(names) == 'array') {
		for (let name in names) {
			let child = path + '/' + name;
			let info = stat(child);
			if (info && info.type == 'directory')
				removeTree(child);
			else
				unlink(child);
		}
	}

	return rmdir(path) ? true : false;
}

function sizeOf(path) {
	let total = 0;
	let names = lsdir(path);

	if (type(names) != 'array')
		return 0;

	for (let name in names) {
		let info = stat(path + '/' + name);
		if (!info)
			continue;
		if (info.type == 'directory')
			total += sizeOf(path + '/' + name);
		else
			total += info.size;
	}

	return total;
}

/**
 * A snapshot id, checked before it is joined onto a path.
 *
 * Every id this file writes is `<epoch>-<reason>` or the baseline, so nothing
 * legitimate is turned away. But an id arrives from `ubus call bm.agent
 * config_delete` and from `bmctl config restore`, and both hand it straight
 * through - so without this, `../state` reaches removeTree() as root and
 * `./baseline` walks past the one refusal in `remove` that the whole safety
 * net rests on. The LuCI app grants config_delete to a web session, which is
 * the shortest route to it.
 *
 * Checked here, on the lines that build the path, rather than at each caller:
 * an allowlist two files away is not a guarantee.
 */
function validId(id) {
	if (type(id) != 'string' || !length(id) || length(id) > 64)
		return false;

	// No slash, no dot-segment, and it cannot start with a dot - which rules
	// out '.', '..' and any traversal without having to reason about them.
	return match(id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/) && !match(id, /\.\./);
}

export function meta(id) {
	if (!validId(id))
		return null;

	let text = readfile(DIR + '/' + id + '/meta.json');
	if (type(text) != 'string')
		return null;

	try {
		let value = json(text);
		return type(value) == 'object' ? value : null;
	}
	catch (e) {
		return null;
	}
};

// Newest first, which is the order a person reads them in: the one they want is
// almost always the last one taken.
export function list() {
	let names = lsdir(DIR);
	if (type(names) != 'array')
		return [];

	let out = [];
	for (let name in names) {
		let info = stat(DIR + '/' + name);
		if (!info || info.type != 'directory')
			continue;

		let entry = meta(name);
		push(out, {
			id: name,
			at: (entry && type(entry.at) == 'int') ? entry.at : 0,
			reason: (entry && type(entry.reason) == 'string') ? entry.reason : 'unknown',
			release: (entry && type(entry.release) == 'string') ? entry.release : '',
			schema: (entry && type(entry.schema) == 'int') ? entry.schema : 0,
			baseline: name == BASELINE,
			packages: (entry && type(entry.packages) == 'array') ? entry.packages : [],
			size: sizeOf(DIR + '/' + name)
		});
	}

	return sort(out, (a, b) => {
		// The baseline last however old it is: it is not part of the recent
		// history, it is the way back to before any of this touched the router.
		if (a.baseline != b.baseline)
			return a.baseline ? 1 : -1;
		return b.at - a.at;
	});
};

/**
 * Delete the oldest until there are at most KEEP and the directory is under
 * budget. The baseline is exempt from both, always.
 */
function prune() {
	let entries = filter(list(), (entry) => !entry.baseline);

	// Oldest first for deletion, which is the reverse of how they are listed.
	entries = sort(entries, (a, b) => a.at - b.at);

	while (length(entries) > KEEP) {
		let victim = shift(entries);
		debug('pruning snapshot ' + victim.id + ' (over ' + KEEP + ')');
		removeTree(DIR + '/' + victim.id);
	}

	let total = sizeOf(DIR);
	while (total > BUDGET_BYTES && length(entries) > 1) {
		let victim = shift(entries);
		notice('pruning snapshot ' + victim.id + ' to stay under the size budget');
		removeTree(DIR + '/' + victim.id);
		total -= victim.size;
	}
}

/**
 * Take a snapshot. Returns { ok, id, reason } - the reason only on failure.
 *
 * `id` is `<epoch>-<slug>`, except for the very first one ever taken on this
 * router, which is called `baseline` and is never pruned. That one is the
 * answer to "put this router back the way it was before any of this", which no
 * amount of recent history can give.
 */
export function take(reason, options) {
	if (!ensure() || !ensureDir(DIR))
		return { ok: false, reason: 'cannot create ' + DIR };

	let asBaseline = (type(options) == 'object' && options.baseline === true);

	// The first snapshot on a router is the baseline, whatever it was taken
	// for. Waiting for somebody to ask for one explicitly means the moment it
	// would have been useful has already passed.
	if (!asBaseline && !stat(DIR + '/' + BASELINE)) {
		let first = take(reason, { baseline: true });
		if (!first.ok)
			return first;
	}

	let id = asBaseline ? BASELINE : sprintf('%d-%s', time(), slug(reason));
	let path = DIR + '/' + id;

	if (!ensureDir(path) || !ensureDir(path + '/uci'))
		return { ok: false, reason: 'cannot create ' + path };

	// One file per UCI package rather than one combined export. Restoring then
	// needs no parsing at all - `uci import <name>` reads exactly one of these -
	// and a diff can be shown for the package somebody changed instead of for
	// everything at once.
	let captured = [];
	for (let name in PACKAGES) {
		let text = run('uci export ' + name + ' 2>/dev/null');

		// A package that is not on this router is not a failure; bm_pppoe does
		// not exist until the first pool is created.
		if (type(text) != 'string' || !length(trim(text)))
			continue;

		if (!writefile(path + '/uci/' + name + '.uci', text)) {
			removeTree(path);
			return { ok: false, reason: 'cannot write the ' + name + ' export' };
		}

		push(captured, name);
	}

	if (!length(captured)) {
		removeTree(path);
		return { ok: false, reason: 'uci exported nothing - is uci working on this router?' };
	}

	// Read back by a person working out what changed, never restored. See the
	// note at the top of this file for why.
	writefile(path + '/rules.txt', run('ip -4 rule show 2>/dev/null') || '');
	writefile(path + '/routes.txt', run('ip -4 route show table all 2>/dev/null') || '');

	let entry = {
		id: id,
		at: time(),
		reason: type(reason) == 'string' ? reason : 'manual',
		release: RELEASE,
		schema: CONFIG_SCHEMA,
		packages: captured,
		baseline: asBaseline
	};

	if (!writefile(path + '/meta.json', sprintf('%J\n', entry))) {
		removeTree(path);
		return { ok: false, reason: 'cannot write ' + path + '/meta.json' };
	}

	notice('snapshot ' + id + ' (' + entry.reason + '): ' + join(', ', captured));

	if (!asBaseline)
		prune();

	return { ok: true, id: id, packages: captured };
};

export function remove(id) {
	// Before the baseline check, not after: './baseline' is not equal to
	// 'baseline' and would otherwise have walked straight past it.
	if (!validId(id))
		return { ok: false, reason: 'no snapshot called ' + id };

	if (id == BASELINE)
		return { ok: false, reason: 'the baseline is the way back to how this router was before any of this; it is never deleted' };

	if (!stat(DIR + '/' + id))
		return { ok: false, reason: 'no snapshot called ' + id };

	return removeTree(DIR + '/' + id)
		? { ok: true }
		: { ok: false, reason: 'cannot remove ' + DIR + '/' + id };
};

/** The stored text of one UCI package in a snapshot, or null. */
export function exported(id, name) {
	if (!validId(id) || !known(name))
		return null;

	return readfile(DIR + '/' + id + '/uci/' + name + '.uci');
};

/** What the router has right now, in the same form, for comparison. */
export function currentExport(name) {
	// popen() runs through a shell, so this is the line where a package name
	// stops being data. Nothing that is not in PACKAGES gets to be a command.
	if (!known(name))
		return null;

	return run('uci export ' + name + ' 2>/dev/null');
};

/**
 * A whole snapshot as one `uci import` stream, or null.
 *
 * The stored packages concatenated in the order they were captured, each one
 * beginning with its own `package` line - which is exactly what `uci import`
 * reads. So what comes out of here is not a description of a snapshot, it is
 * the snapshot: `uci import < file` on any router puts it back.
 *
 * Nothing is wrapped around it. No header, no comment, no metadata - anything
 * added would have to be something uci will read, and the one thing somebody
 * needs to know about the file is which snapshot it is, which is in the name it
 * is saved under.
 *
 * rules.txt and routes.txt are left out for the reason they are never restored:
 * they are a record of what the kernel was doing, read by a person working out
 * what changed, and putting them in a file whose whole purpose is to be fed
 * back into uci would make it not that file any more.
 */
export function bundle(id) {
	let entry = meta(id);
	if (!entry)
		return null;

	let names = (type(entry.packages) == 'array' && length(entry.packages))
		? entry.packages
		: PACKAGES;

	let out = '';

	for (let name in names) {
		let text = exported(id, name);
		if (type(text) != 'string' || !length(trim(text)))
			continue;

		out += text;

		// uci export ends each package with a newline, but a file that was
		// truncated would run the next `package` line onto the end of the last
		// option and uci would read one option nobody wrote.
		if (substr(out, -1) != '\n')
			out += '\n';
	}

	return length(out) ? out : null;
};
