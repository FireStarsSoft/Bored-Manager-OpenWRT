// One step at a time, forwards only, and safe to run twice.
//
// This exists before there is anything to migrate, and that is the point. A
// migration framework retrofitted after two releases of data are already in the
// wild has to guess what the first release wrote; one that has been there since
// schema 1 knows, because every router was stamped on the way in.
//
// Three rules, and they are what the loader below enforces rather than
// documents:
//
//   Every step moves exactly one number.  A single migration that jumps from 1
//   to 4 cannot be resumed after a power cut half way through it, and a router
//   that has been offline for three releases is the normal case, not the
//   exotic one.
//
//   Every step is idempotent.  It runs again after a crash that happened
//   between the change and the stamp, so "add this option if it is missing" is
//   the shape every one of them has to take.
//
//   Nothing goes backwards.  There is no `down`, deliberately. Undoing a
//   migration correctly needs the data the migration threw away; the honest
//   way back is the snapshot taken before the update ran.

import { lsdir } from 'fs';
import { cursor } from 'uci';

import { debug, err, notice } from 'bm.log';
import { compatibility, stamp } from 'bm.meta';
import * as state from 'bm.state';
import { CONFIG_SCHEMA } from 'bm.version';

export const DIR = '/usr/share/bm/migrations';

// `001-name.uc`. The number orders them for a human reading the directory; the
// chain below is built from each file's own `from`, so a mis-numbered filename
// is untidy rather than dangerous.
const FILENAME = /^[0-9]{3}-[a-z0-9-]+\.uc$/;

/**
 * A migration file returns its own descriptor rather than exporting one:
 *
 *   return {
 *     from: 1,
 *     to: 2,
 *     describe: 'move the sticky map out of the pool record',
 *     apply: function(ctx) { ... }
 *   };
 *
 * Loaded by path with loadfile() instead of imported, because these are data
 * for the agent rather than modules anything links against - they are not on
 * ucode's search path, their names are not known at compile time, and a release
 * adds one by dropping a file in.
 *
 * `raw_mode` is passed rather than inherited. Unspecified options default to
 * those of the running program, and both entry points here are started as
 * `ucode -R -S`, so it would be true anyway - but a migration is a script under
 * every caller, and inheriting the answer means a future one started as a
 * template would silently print these files instead of running them.
 */
function describe(name) {
	let step;

	try {
		let program = loadfile(DIR + '/' + name, { raw_mode: true });
		step = program();
	}
	catch (e) {
		err('migration ' + name + ' will not load: ' + e);
		return null;
	}

	if (type(step) != 'object' || type(step.apply) != 'function') {
		err('migration ' + name + ' returned no { from, to, apply } descriptor');
		return null;
	}

	if (type(step.from) != 'int' || type(step.to) != 'int' || step.to != step.from + 1) {
		err('migration ' + name + ' does not move exactly one schema step');
		return null;
	}

	step.file = name;
	return step;
}

export function available() {
	let names = lsdir(DIR);
	if (type(names) != 'array')
		return [];

	let out = [];
	for (let name in names) {
		if (!match(name, FILENAME))
			continue;

		let step = describe(name);
		if (step)
			push(out, step);
	}

	return sort(out, (a, b) => a.from - b.from);
};

/**
 * What running would do, without doing any of it.
 *
 * A missing step is found here rather than half way through: the chain is built
 * end to end first, so a router three releases behind either has every step it
 * needs or is told which one is absent before a single file is touched.
 */
export function plan() {
	let compat = compatibility();

	if (!compat.ok)
		return { ok: false, reason: compat.reason, from: compat.schema, to: CONFIG_SCHEMA, steps: [] };

	// A router nobody has stamped is a fresh install: its data was written by
	// this build, so there is nothing to move it from.
	let from = compat.fresh ? CONFIG_SCHEMA : compat.schema;

	if (from >= CONFIG_SCHEMA)
		return { ok: true, fresh: compat.fresh, from: from, to: CONFIG_SCHEMA, steps: [] };

	let byFrom = {};
	for (let step in available())
		byFrom[sprintf('%d', step.from)] = step;

	let steps = [];
	for (let at = from; at < CONFIG_SCHEMA; at++) {
		let step = byFrom[sprintf('%d', at)];

		if (!step) {
			return {
				ok: false,
				reason: sprintf(
					'no migration from schema %d to %d is installed - this router cannot be brought forward without the release that provides it',
					at, at + 1),
				from: from,
				to: CONFIG_SCHEMA,
				steps: steps
			};
		}

		push(steps, step);
	}

	return { ok: true, fresh: false, from: from, to: CONFIG_SCHEMA, steps: steps };
};

/**
 * Run the chain, stamping after each step.
 *
 * Stamping between steps rather than once at the end is what makes a crash
 * recoverable: the next run starts from the last step that finished, and the
 * step that was interrupted runs again - which is exactly what idempotence buys.
 */
export function run(dryRun) {
	let plan_ = plan();

	if (!plan_.ok) {
		err(plan_.reason);
		return { ok: false, reason: plan_.reason, applied: [] };
	}

	if (!length(plan_.steps)) {
		// Stamp a fresh router on the way past, so that the next update can tell
		// "never been here" from "already at the current schema".
		if (plan_.fresh && !dryRun)
			stamp(CONFIG_SCHEMA, 'first install');

		return { ok: true, from: plan_.from, to: plan_.to, applied: [] };
	}

	let ctx = { state: state, cursor: cursor, notice: notice, debug: debug };
	let applied = [];

	for (let step in plan_.steps) {
		if (dryRun) {
			push(applied, { file: step.file, from: step.from, to: step.to, describe: step.describe });
			continue;
		}

		notice(sprintf('migrating schema %d -> %d (%s)', step.from, step.to, step.file));

		try {
			step.apply(ctx);
		}
		catch (e) {
			let reason = sprintf('migration %s failed: %s', step.file, e);
			err(reason);
			// Deliberately no attempt to undo. The step may have written half of
			// what it meant to, and guessing which half is how data gets lost;
			// the stamp still says the schema this router was at when it began,
			// so a fixed release runs the same step again from the same place.
			return { ok: false, reason: reason, from: plan_.from, applied: applied };
		}

		stamp(step.to, step.file);
		push(applied, { file: step.file, from: step.from, to: step.to, describe: step.describe });
	}

	return { ok: true, from: plan_.from, to: plan_.to, applied: applied };
};
