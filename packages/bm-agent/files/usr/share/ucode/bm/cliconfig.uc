// `bmctl config ...`: the snapshot, restore and guard commands.
//
// Kept out of bmctl.uc so that the CLI's entry point stays a list of commands
// rather than a wall of printing. Everything here formats; the deciding is in
// bm.snapshot, bm.restore and bm.guard, which the ubus object calls too - so
// there is one implementation of "restore this snapshot" and not a console one
// and an app one that disagree about what happened.
//
// It prints for a person by default and `--json` for a program. The two carry
// the same facts; the text form only chooses which of them are worth a line.

import { BASELINE, list, meta, remove, take } from 'bm.snapshot';
import { diff, restore } from 'bm.restore';
import { arm, cancel, confirm, expire, forget, status } from 'bm.guard';

export const USAGE = 'usage: bmctl config <command> [--json]\n' +
	'\n' +
	'  list                    every snapshot, newest first\n' +
	'  show <id>               what one snapshot holds\n' +
	'  diff <id>               what restoring it would change\n' +
	'  restore <id> [-n]       put it back    (-n / --dry-run: say, do nothing)\n' +
	'  snapshot [reason]       take one now\n' +
	'  delete <id>             remove one (never the baseline)\n' +
	'\n' +
	'  guard [--timeout N]     snapshot, then start a countdown\n' +
	'  confirm                 keep the change; stop the countdown\n' +
	'  cancel                  put it back now, without waiting\n' +
	'  forget                  drop the countdown without restoring anything\n' +
	'  status                  is a guard armed, and how long is left\n';

// `1690000000` as something a person can read without doing arithmetic. Not a
// locale-aware date: this runs on a router whose clock may not have been set
// since it booted, and an elapsed time is honest about that in a way a
// confidently wrong timestamp is not.
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

function kb(bytes) {
	return sprintf('%d KB', (bytes + 1023) / 1024);
}

function need(args, what) {
	if (length(args) < 2 || !length(trim(args[1]))) {
		warn('bmctl config: ' + what + '\n');
		return null;
	}

	return args[1];
}

function report(result, asJson, line) {
	if (asJson) {
		printf('%J\n', result);
		return result.ok ? 0 : 1;
	}

	if (!result.ok) {
		printf('%s\n', result.reason);
		return 1;
	}

	if (line)
		printf('%s\n', line);

	return 0;
}

export function run(args, opts) {
	let command = length(args) ? args[0] : 'help';
	let asJson = opts.json === true;

	if (command == 'help') {
		print(USAGE);
		return 0;
	}

	if (command == 'list') {
		let entries = list();

		if (asJson) {
			printf('%J\n', entries);
			return 0;
		}

		if (!length(entries)) {
			printf('no snapshots yet - one is taken automatically before anything is written\n');
			return 0;
		}

		printf('%-24s %-14s %-9s %s\n', 'ID', 'TAKEN', 'SIZE', 'REASON');
		for (let entry in entries) {
			printf('%-24s %-14s %-9s %s%s\n',
				entry.id, ago(entry.at), kb(entry.size), entry.reason,
				entry.baseline ? '  [baseline, never pruned]' : '');
		}

		return 0;
	}

	if (command == 'show') {
		let id = need(args, 'show which snapshot? try `bmctl config list`');
		if (!id)
			return 1;

		let entry = meta(id);
		if (!entry) {
			printf('no snapshot called %s\n', id);
			return 1;
		}

		if (asJson) {
			printf('%J\n', entry);
			return 0;
		}

		printf('id        %s%s\n', entry.id, (entry.id == BASELINE) ? '  [baseline]' : '');
		printf('taken     %s\n', ago(entry.at));
		printf('reason    %s\n', entry.reason);
		printf('release   %s (schema %d)\n', entry.release, entry.schema);
		printf('packages  %s\n', join(', ', entry.packages));
		return 0;
	}

	if (command == 'diff') {
		let id = need(args, 'diff which snapshot? try `bmctl config list`');
		if (!id)
			return 1;

		let result = diff(id);

		if (asJson) {
			printf('%J\n', result);
			return result.ok ? 0 : 1;
		}

		if (!result.ok) {
			printf('%s\n', result.reason);
			return 1;
		}

		if (!result.changes) {
			printf('nothing has changed since %s was taken\n', id);
			return 0;
		}

		printf('%d line(s) differ from %s (%s)\n\n', result.changes, id, ago(result.at));
		for (let one in result.packages) {
			printf('%s\n', one.package);
			// `+` is what restoring would put back and `-` is what it would take
			// away, which is the opposite of a diff read against the snapshot -
			// so both are spelled out rather than left to a convention.
			for (let line in one.restores)
				printf('  + %s\n', line);
			for (let line in one.discards)
				printf('  - %s\n', line);
			printf('\n');
		}

		printf('+ restoring puts back    - restoring takes away\n');
		return 0;
	}

	if (command == 'restore') {
		let id = need(args, 'restore which snapshot? try `bmctl config list`');
		if (!id)
			return 1;

		let result = restore(id, { dryRun: opts.dryRun === true });

		if (asJson) {
			printf('%J\n', result);
			return result.ok ? 0 : 1;
		}

		if (!result.ok) {
			printf('%s\n', result.reason);
			return 1;
		}

		if (result.dryRun) {
			printf('would restore %s: %d line(s) change. Run `bmctl config diff %s` to read them.\n',
				id, result.changes, id);
			return 0;
		}

		printf('restored %s: %s\n', id, join(', ', result.restored));
		for (let one in result.reloaded)
			printf('  %-10s %s\n', one.service, one.ok ? 'reloaded' : 'reload FAILED');

		return 0;
	}

	if (command == 'snapshot') {
		let reason = (length(args) > 1) ? args[1] : 'manual';
		let result = take(reason);
		return report(result, asJson, result.ok ? sprintf('snapshot %s', result.id) : null);
	}

	if (command == 'delete') {
		let id = need(args, 'delete which snapshot? try `bmctl config list`');
		if (!id)
			return 1;

		let result = remove(id);
		return report(result, asJson, sprintf('deleted %s', id));
	}

	if (command == 'guard') {
		let result = arm({ timeout: opts.timeout, reason: opts.reason });

		if (asJson) {
			printf('%J\n', result);
			return result.ok ? 0 : 1;
		}

		if (!result.ok) {
			printf('%s\n', result.reason);
			return 1;
		}

		printf('guard armed for %ds against snapshot %s.\n', result.timeout, result.snapshot);
		printf('Run `bmctl config confirm` once you can still reach this router.\n');
		printf('If nobody does, it restores that snapshot and reloads the network.\n');
		return 0;
	}

	if (command == 'confirm') {
		let result = confirm();
		return report(result, asJson, 'guard confirmed; the change stands');
	}

	if (command == 'cancel') {
		let result = cancel();
		return report(result, asJson, result.ok ? sprintf('restored %s', result.snapshot) : null);
	}

	// Neither confirm nor cancel: the countdown simply stops mattering. What
	// `prerm` needs when the packages are being removed - there is about to be
	// nothing left to expire the guard, and firing it on the way out would
	// reload somebody's network as a parting gift. The snapshot stays.
	if (command == 'forget') {
		let state = status();
		let result = forget();
		return report(result, asJson,
			state.armed
				? sprintf('guard on %s dropped; the snapshot is still there', state.snapshot)
				: 'no guard was armed');
	}

	if (command == 'status') {
		let state = status();

		if (asJson) {
			printf('%J\n', state);
			return 0;
		}

		if (!state.armed) {
			printf('no guard is armed\n');
			return 0;
		}

		if (state.remaining <= 0)
			printf('guard on %s is overdue - it is restoring now\n', state.snapshot);
		else
			printf('guard on %s: %ds left (%s)\n', state.snapshot, state.remaining, state.reason);

		return 0;
	}

	// What /usr/share/bm/guard-timer.sh calls. Not in USAGE: it is a protocol
	// between two files in this package, and its exit code is the whole answer.
	if (command == 'expire') {
		let result = expire();

		if (asJson)
			printf('%J\n', result);

		return result.code;
	}

	warn('bmctl config: unknown command "' + command + '"\n\n');
	warn(USAGE);
	return 1;
};
