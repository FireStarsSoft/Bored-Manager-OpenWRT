// A clock the probe winds by hand, in place of uloop's.
//
// Deliberately not in ../../stubs, for the same reason as the uci and fs beside
// it: the stub answers `null` to `timer()`, which is right for a syntax check
// and is why `schedule()` in bm-wanbind - the one thing in that daemon that
// runs by itself - had never been executed by anything. A probe cannot wait
// thirty seconds for a reconcile timer, and a probe that called `pass()`
// directly would prove the pass works and say nothing at all about whether it
// is ever armed, re-armed, or armed twice.
//
// So time is a number here and nothing advances it but `advance(ms)`. A timer
// is due when the clock reaches it; a callback that re-arms its own timer -
// which is exactly what `schedule()` does - is armed against the clock as it
// stood when the callback ran, so a probe can advance an hour and count the
// passes rather than guess at them.
//
// The export list matches ../../stubs/uloop.uc name for name, because this file
// wins the search for every module a probe loads and a name missing here would
// break an import the stub satisfies.

let clock = 0;
let live = [];

// A callback that re-arms itself with no delay would keep `advance` inside its
// own loop for as long as the probe was willing to wait. A real uloop has the
// same property and a real router has the same bug; here it is a number, so it
// stops and says so rather than hanging a check.
const FIRE_CAP = 10000;

/** The virtual clock, in milliseconds since the probe started. */
export function now() {
	return clock;
};

/** How many timers are armed and waiting. */
export function pending() {
	let n = 0;

	for (let one in live) {
		if (one.armed)
			n++;
	}

	return n;
};

/** Forget every timer and put the clock back to zero. */
export function resetTimers() {
	clock = 0;
	live = [];
};

/**
 * Move the clock, firing what falls due, and answer how many fired.
 *
 * The count is the assertion worth writing: "one pass ran" and "five hundred
 * passes ran" are the difference between a daemon that folds a storm of
 * requests into one reconcile and one that does the whole thing per request,
 * and both leave the router in the same state afterwards.
 */
export function advance(ms) {
	let target = clock + ((type(ms) == 'int' && ms > 0) ? ms : 0);
	let fired = 0;

	while (true) {
		let next = null;

		for (let one in live) {
			if (!one.armed || one.at > target)
				continue;

			if (next == null || one.at < next.at)
				next = one;
		}

		if (next == null)
			break;

		if (fired >= FIRE_CAP) {
			printf('  WRONG uloop.advance: %d timers fired without the clock reaching %d - a callback is re-arming itself with no delay\n', fired, target);
			break;
		}

		// The clock stands at the timer's own due time while its callback runs,
		// so a callback that re-arms for "thirty seconds from now" is armed
		// thirty seconds from when it was due rather than from wherever this
		// call was asked to finish. Getting that wrong makes every re-arming
		// timer drift towards the end of the window and hides a pass that is
		// running late.
		clock = next.at;
		next.armed = false;
		fired++;
		next.cb();
	}

	clock = target;
	return fired;
};

function arm(state, timeout) {
	state.at = clock + ((type(timeout) == 'int' && timeout > 0) ? timeout : 0);
	state.armed = true;
	return true;
}

/**
 * One timer, with the three methods ucode's own hands back.
 *
 * `remaining()` answers -1 when the timer is not armed, which is what the C
 * module does and what "this timer is not waiting for anything" has to look
 * like: a probe that read 0 for both would call an unarmed timer due.
 */
export function timer(timeout, cb) {
	let state = {
		at: 0,
		armed: false,
		cb: (type(cb) == 'function') ? cb : function() { return null; }
	};

	push(live, state);

	if (type(timeout) == 'int' && timeout >= 0)
		arm(state, timeout);

	return {
		set: function(ms) { return arm(state, ms); },
		cancel: function() { state.armed = false; return true; },
		remaining: function() { return state.armed ? (state.at - clock) : -1; }
	};
};

/** The repeating one, re-armed from inside its own firing. */
export function interval(period, cb) {
	let every = (type(period) == 'int' && period > 0) ? period : 0;
	let handle = null;

	handle = timer(every, function() {
		if (type(cb) == 'function')
			cb();

		handle.set(every);
	});

	return handle;
};

export function init() { return null; };
export function run(timeout) { return null; };
export function end() { return null; };
export function done() { return null; };
export function handle(fd, cb, flags) { return null; };
export function process(executable, args, env, cb) { return null; };
export function task(fn, output_cb, input_cb) { return null; };
export function signal(signal, cb) { return null; };

export const ULOOP_READ = 1;
export const ULOOP_WRITE = 2;
export const ULOOP_EDGE_TRIGGER = 4;
export const ULOOP_BLOCKING = 8;
