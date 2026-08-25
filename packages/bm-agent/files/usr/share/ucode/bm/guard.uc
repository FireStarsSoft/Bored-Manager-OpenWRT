// Commit-confirm: a change that nobody confirms puts itself back.
//
// This is the one thing in the whole project that cannot be done from the app.
// Once a change has taken SSH down there is nobody left to type the command
// that would undo it - the connection the command would arrive on is the thing
// that broke. So the undo has to be armed *before* the change, by something
// already on the router, running on a timer that is not the process making the
// change. It is the same idea as `commit confirmed` on JunOS and RouterOS, for
// the same reason.
//
// The shape of it:
//
//   arm      snapshot, write the deadline, start /etc/init.d/bm-guard
//   ...      the change is applied by whoever asked for the guard
//   confirm  the caller got an answer back, so the change stands: file removed,
//            timer stopped
//   expire   nobody confirmed in time: the snapshot goes back and the network
//            is reloaded
//
// The deadline lives in a file rather than in the timer's memory, which is what
// makes it survive the timer being killed and the router being rebooted: on the
// next boot the init script sees the file, starts the timer again, and it
// expires immediately - which is exactly right, because a router that rebooted
// mid-change was never confirmed.

import { err, notice } from 'bm.log';
import { restore } from 'bm.restore';
import { take } from 'bm.snapshot';
import { read, remove, write } from 'bm.state';

const NAME = 'guard';

// Two minutes. Long enough for an app on the far side of a slow link to read
// the router back and confirm, short enough that somebody watching a dead SSH
// session does not give up first.
export const DEFAULT_TIMEOUT = 120;

// Below this there is not enough time for the change to settle, let alone for
// anything to check it; above it, a person waiting for their network to come
// back has already power-cycled the router.
const MIN_TIMEOUT = 15;
const MAX_TIMEOUT = 3600;

function service(action) {
	// Not popen(): nothing here reads the output, and the guard has to work when
	// the router is in a state where reading a pipe is the least of the worries.
	return system([ '/etc/init.d/bm-guard', action ]);
}

/** The guard in force, or null. */
export function active() {
	let entry = read(NAME);
	if (type(entry) != 'object' || type(entry.deadline) != 'int')
		return null;

	return entry;
};

export function status() {
	let entry = active();

	if (!entry)
		return { armed: false };

	return {
		armed: true,
		snapshot: entry.snapshot,
		reason: entry.reason,
		armedAt: entry.armedAt,
		deadline: entry.deadline,
		// Negative once it is overdue, which is a state a surface should show as
		// "restoring" rather than as a countdown that has gone strange.
		remaining: entry.deadline - time()
	};
};

/**
 * Arm the guard. Returns { ok, snapshot, deadline }.
 *
 * The snapshot is taken here rather than by the caller, because the whole
 * promise is that the thing to go back to was captured before the change, and a
 * caller that forgot would only find out at the moment it mattered.
 */
export function arm(options) {
	let opts = type(options) == 'object' ? options : {};

	if (active())
		return { ok: false, reason: 'a guard is already armed - confirm or cancel it first' };

	let timeout = type(opts.timeout) == 'int' ? opts.timeout : DEFAULT_TIMEOUT;
	if (timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) {
		return {
			ok: false,
			reason: sprintf('timeout has to be between %d and %d seconds', MIN_TIMEOUT, MAX_TIMEOUT)
		};
	}

	let reason = type(opts.reason) == 'string' ? opts.reason : 'guard';
	let snapshot = take('guard-' + reason);
	if (!snapshot.ok)
		return { ok: false, reason: 'cannot take a snapshot to guard with: ' + snapshot.reason };

	let entry = {
		snapshot: snapshot.id,
		reason: reason,
		armedAt: time(),
		deadline: time() + timeout
	};

	if (!write(NAME, entry))
		return { ok: false, reason: 'cannot write the guard record' };

	// Started after the record, never before: the timer's first act is to read
	// that file, and a timer that finds nothing simply stops.
	if (service('start') !== 0) {
		remove(NAME);
		return { ok: false, reason: 'cannot start /etc/init.d/bm-guard, so nothing would put the change back' };
	}

	notice(sprintf('guard armed for %ds against snapshot %s (%s)', timeout, entry.snapshot, reason));
	return { ok: true, snapshot: entry.snapshot, deadline: entry.deadline, timeout: timeout };
};

/** Keep the change. Removing the record is what disarms it; the rest is tidying. */
export function confirm() {
	let entry = active();
	if (!entry)
		return { ok: false, reason: 'no guard is armed' };

	remove(NAME);
	service('stop');
	notice('guard confirmed; snapshot ' + entry.snapshot + ' kept for the history');
	return { ok: true, snapshot: entry.snapshot };
};

function finish(entry, why) {
	// The record goes first. A restore reloads the network, and if that takes
	// long enough for the timer to come round again, a record still on disk
	// would start a second restore on top of the first.
	remove(NAME);

	// snapshotFirst so the broken state is captured before it is undone: that
	// copy is the only evidence of what actually went wrong, and it is worth
	// far more than the few kilobytes it costs.
	let result = restore(entry.snapshot, { snapshotFirst: true });

	service('stop');

	if (!result.ok) {
		err('guard ' + why + ' but the restore failed: ' + result.reason);
		return { ok: false, reason: result.reason, snapshot: entry.snapshot };
	}

	notice('guard ' + why + '; snapshot ' + entry.snapshot + ' restored');
	return { ok: true, snapshot: entry.snapshot, restored: result.restored, why: why };
}

/**
 * Put it back now, without waiting for the deadline. What "Undo" is.
 */
export function cancel() {
	let entry = active();
	if (!entry)
		return { ok: false, reason: 'no guard is armed' };

	notice('guard cancelled; restoring snapshot ' + entry.snapshot);
	return finish(entry, 'cancelled');
};

/**
 * What the timer calls, once every few seconds.
 *
 * The three answers are exit codes rather than a report, because the caller is
 * a shell loop with no JSON parser and no need for one:
 *
 *   0  nothing left to guard - confirmed, cancelled, or just restored
 *   2  still inside the deadline; ask again shortly
 *   1  something is wrong that another few seconds will not fix
 */
export function expire() {
	let entry = active();
	if (!entry)
		return { done: true, code: 0 };

	if (time() < entry.deadline)
		return { done: false, code: 2, remaining: entry.deadline - time() };

	let result = finish(entry, 'expired');
	return { done: true, code: result.ok ? 0 : 1, result: result };
};

/**
 * Drop the record without restoring anything.
 *
 * The third answer, and the one `prerm` needs: the packages are going away, so
 * there will shortly be nothing left to expire the guard, and firing it on the
 * way out would reload somebody's network as a parting gift. It is not
 * `confirm` - nothing was checked and nothing is being promised - and it is not
 * `cancel`, which would put the change back. The snapshot stays where it is.
 *
 * Always ok, deliberately. "There was nothing armed" is the state this asks
 * for, not a failure to reach it.
 */
export function forget() {
	remove(NAME);
	// Same order as confirm(): the record is what disarms, stopping the timer is
	// tidying. Without it procd would respawn a countdown that finds nothing to
	// count until it hits the retry limit.
	service('stop');
	return { ok: true };
};
