// What a probe reports with.
//
// The last line is the whole point. ucode exits 0 on an uncaught exception, so
// a probe that died half way through and a probe that passed are
// indistinguishable by exit status - and a runner that trusted `$?` would call
// every one of these green. So a probe that got to the end says so, and the
// runner looks for that line. `bm-probe-ok` is also spelled in
// scripts/check-ucode.sh; there is nowhere else to put a string a shell and a
// ucode module both have to agree on.

let wrong = 0;

export function check(what, got, want) {
	if (got != want) {
		printf('  WRONG %s: got %J, wanted %J\n', what, got, want);
		wrong++;
		return false;
	}

	printf('  ok    %s = %J\n', what, got);
	return true;
};

/** For a sentence: that it says the thing somebody will need to read. */
export function says(what, text, pattern) {
	return check(what, (type(text) == 'string' && match(text, pattern)) ? true : false, true);
};

/**
 * Reaching a name is the check, and finishing the call is not.
 *
 * ucode resolves an identifier when it compiles the function that mentions it,
 * so a callee declared below its caller is a global load that raises the first
 * time the line runs. That is the failure being looked for here. Anything else
 * means the name resolved and the call simply could not finish against a stub
 * router, which is expected and not a failure.
 */
export function resolves(what, fn) {
	try {
		fn();
		printf('  ok    %s: resolved\n', what);
		return true;
	}
	catch (e) {
		if (match('' + e, /undeclared variable/)) {
			printf('  WRONG %s: REFERENCE ERROR - %s\n', what, e);
			wrong++;
			return false;
		}

		printf('  ok    %s: resolved (stopped later: %s)\n', what, e);
		return true;
	}
};

export function report() {
	if (wrong) {
		printf('  %d WRONG\n', wrong);
		exit(1);
	}

	printf('bm-probe-ok\n');
	exit(0);
};
