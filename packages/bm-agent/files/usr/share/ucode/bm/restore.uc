// Putting a snapshot back, and saying what that would change first.
//
// `uci import` replaces a package wholesale, which is the behaviour this wants:
// a restore has to remove the sections the change added, not merely correct the
// ones it edited. Each package is imported and committed on its own, so a
// failure part way leaves the packages that already went back in place rather
// than a router half described by two different configurations.
//
// Reloading is what actually applies it, and it is done in one order for one
// reason: netifd brings the interfaces up, fw4 builds its ruleset from the
// interfaces that exist, and dnsmasq serves the bridges netifd made. Reloading
// the firewall first would build a ruleset against the interfaces that are on
// their way out.

import { access, popen } from 'fs';

import { err, notice } from 'bm.log';
import { currentExport, exported, known, meta, take } from 'bm.snapshot';

// The daemons come after the stack they sit on: netifd owns the interfaces,
// fw4 builds against the interfaces that exist, dnsmasq serves the bridges
// netifd made - and `bm-wanbind` writes rules about all three.
const RELOAD_ORDER = [ 'network', 'firewall', 'dnsmasq', 'bm-wanbind', 'bm-pppoe' ];

// Which init script a restored UCI package needs run.
//
// `bm_wanbind` and `bm_pppoe` are here rather than "read on demand" because
// they are not. `uci commit` emits no procd trigger, and both daemons read
// their configuration once at start - so a restore that put a section back
// without this committed a file the daemon never looked at again, and
// `bm-wanbind` went on re-asserting the rules of an instance the snapshot had
// just removed, every thirty seconds, while the restore reported success.
//
// That is the case the guard exists for: the change that has to be undone is
// usually one that took the connection away, and there is nobody left to
// notice that the undo did not take.
const SERVICE_FOR = {
	network: 'network',
	firewall: 'firewall',
	dhcp: 'dnsmasq',
	bm_wanbind: 'bm-wanbind',
	bm_pppoe: 'bm-pppoe'
};

function shell(command) {
	let handle = popen(command, 'r');
	if (!handle)
		return { ok: false, output: '' };

	let output = handle.read('all');
	let status = handle.close();
	return { ok: status === 0, output: type(output) == 'string' ? output : '' };
}

function lines(text) {
	if (type(text) != 'string')
		return [];

	let out = [];
	for (let line in split(text, '\n')) {
		let trimmed = trim(line);
		if (length(trimmed))
			push(out, trimmed);
	}

	return out;
}

function counted(list) {
	let out = {};
	for (let line in list)
		out[line] = (out[line] || 0) + 1;
	return out;
}

/**
 * What one package would gain and lose, as lines.
 *
 * A line-level comparison rather than a structural one, because a UCI export is
 * already one fact per line - `network.lan.ipaddr='192.168.1.1'` - and the
 * question somebody asks of a diff before pressing Restore is "which settings
 * move", which those lines answer directly. It is order-insensitive on purpose:
 * uci does not promise to export sections in the order it read them, and a diff
 * that reported a reshuffle as a hundred changes would be unreadable.
 */
export function diffPackage(id, name) {
	let before = counted(lines(exported(id, name)));
	let after = counted(lines(currentExport(name)));

	let removed = [];
	let added = [];

	// Lines the snapshot has that the router no longer does: restoring puts
	// these back.
	for (let line in before) {
		let extra = before[line] - (after[line] || 0);
		for (let i = 0; i < extra; i++)
			push(removed, line);
	}

	for (let line in after) {
		let extra = after[line] - (before[line] || 0);
		for (let i = 0; i < extra; i++)
			push(added, line);
	}

	return { package: name, restores: sort(removed), discards: sort(added) };
};

export function diff(id) {
	let entry = meta(id);
	if (!entry)
		return { ok: false, reason: 'no snapshot called ' + id };

	let out = [];
	let changes = 0;

	for (let name in entry.packages) {
		let one = diffPackage(id, name);
		changes += length(one.restores) + length(one.discards);
		if (length(one.restores) || length(one.discards))
			push(out, one);
	}

	return { ok: true, id: id, at: entry.at, reason: entry.reason, changes: changes, packages: out };
};

/**
 * Put a snapshot back.
 *
 * `options.dryRun` reports without touching anything. `options.snapshotFirst`
 * defaults to true: a restore is itself a change, and being unable to undo the
 * undo is how somebody ends up worse off than before they started. It is left
 * on even when the router is in a bad way - capturing the broken state is
 * exactly what makes the fault diagnosable afterwards - and a snapshot that
 * fails is logged and does not stop the restore, because the restore is the
 * part that matters.
 */
export function restore(id, options) {
	let entry = meta(id);
	if (!entry)
		return { ok: false, reason: 'no snapshot called ' + id };

	let opts = type(options) == 'object' ? options : {};
	let dryRun = opts.dryRun === true;

	let planned = diff(id);
	if (dryRun)
		return { ok: true, dryRun: true, id: id, changes: planned.changes, packages: planned.packages };

	// Read before anything is written, because taking a snapshot can delete
	// this one.
	//
	// `take` prunes: it keeps the ten most recent and enforces a size budget,
	// and the only thing it will not delete is the baseline. So restoring the
	// oldest snapshot in a full store, or the older of two large ones, made the
	// before-restore copy the eleventh - and the pruner removed the very files
	// the next loop was about to read. Every package then read back null, every
	// one was skipped, and the call returned "nothing in snapshot X could be
	// read back" having changed nothing.
	//
	// It is worst exactly where it matters most. `bm.guard` restores through
	// here after removing its own record, so a countdown that fired against a
	// pruned snapshot left the change standing with nothing left to undo it.
	//
	// Holding the text in memory first makes the order irrelevant: a few
	// kilobytes of `uci export` against a failure mode that is silent and only
	// happens to somebody whose store is full.
	let texts = {};
	for (let name in entry.packages) {
		// The names in meta.json were written by bm.snapshot from its own list,
		// so this can only fire on a file somebody edited or a write that was
		// cut short. It is checked because the name later reaches a command: an
		// allowlist two files away is not a guarantee, and one on the line that
		// needs it is.
		if (!known(name)) {
			err('snapshot ' + id + ' names a UCI package this agent does not manage: ' + name);
			continue;
		}

		let text = exported(id, name);
		if (type(text) != 'string') {
			err('snapshot ' + id + ' is missing its ' + name + ' export; skipping it');
			continue;
		}

		texts[name] = text;
	}

	if (!length(texts))
		return { ok: false, reason: 'nothing in snapshot ' + id + ' could be read back' };

	if (opts.snapshotFirst !== false) {
		let before = take('before-restore-' + id);
		if (!before.ok)
			err('could not snapshot before restoring: ' + before.reason);
	}

	let restored = [];
	let services = {};

	for (let name in texts) {
		let text = texts[name];

		// Written to `uci import <name>` on stdin. No `-m`, so the package is
		// replaced: a restore has to remove the sections a change added, not
		// merely correct the ones it edited.
		let handle = popen('uci import ' + name, 'w');
		if (!handle) {
			return { ok: false, reason: 'cannot run uci import ' + name, restored: restored };
		}

		handle.write(text);
		let status = handle.close();

		if (status !== 0) {
			return {
				ok: false,
				reason: sprintf('uci import %s exited %d - the packages already restored are staying', name, status),
				restored: restored
			};
		}

		let commit = shell('uci commit ' + name + ' 2>&1');
		if (!commit.ok) {
			return {
				ok: false,
				reason: 'uci commit ' + name + ' failed: ' + trim(commit.output),
				restored: restored
			};
		}

		push(restored, name);
		if (SERVICE_FOR[name])
			services[SERVICE_FOR[name]] = true;
	}

	if (!length(restored))
		return { ok: false, reason: 'nothing in snapshot ' + id + ' could be read back' };

	// The rules and routes, which no UCI restore can reach.
	//
	// A snapshot is a copy of `/etc/config`, and the thing most likely to have
	// taken the router off its network is not in there: an `ip rule` and the
	// table it points at are written straight to the kernel, by this router's
	// own daemon or by the module over SSH. Importing the configuration that
	// predates them leaves every one of them exactly where it was, and the
	// restore then reports success on a router that is still unreachable.
	//
	// `bmwan flush` and not the daemon: it reads the configuration and the
	// router rather than asking a process that may not be answering, which is
	// the same reason `service_stopped` calls it. It runs before the reloads
	// below so the daemon rebuilds from what was just restored rather than
	// racing what is being taken away.
	//
	// Best effort. A router without `bm-wanbind` has no rules of ours to flush,
	// and a flush that fails must not stop the configuration going back.
	if (access('/usr/sbin/bmwan')) {
		let flushed = shell('/usr/sbin/bmwan flush 2>&1');
		if (!flushed.ok)
			err('bmwan flush failed before restoring: ' + trim(flushed.output));
	}

	let reloaded = [];
	for (let service in RELOAD_ORDER) {
		if (!services[service])
			continue;

		// `reload` rather than `restart`: it is what netifd and fw4 are designed
		// for, and it does not drop every interface on the way through - which
		// matters when the connection being used to run this is one of them.
		let result = shell('/etc/init.d/' + service + ' reload 2>&1');
		push(reloaded, { service: service, ok: result.ok });

		if (!result.ok)
			err('/etc/init.d/' + service + ' reload failed: ' + trim(result.output));
	}

	notice('restored snapshot ' + id + ': ' + join(', ', restored));
	return { ok: true, id: id, restored: restored, reloaded: reloaded, changes: planned.changes };
};
