// What `bm.agent` answers, and the plain functions behind it.
//
// Every method is a thin wrapper over a function that does not know ubus
// exists. That is what lets `bmctl` print exactly what the module receives:
// there is one implementation, not a ubus one and a CLI one that drift until
// somebody notices they disagree about the router.

import { readfile } from 'fs';
import { cursor } from 'uci';

import { API_VERSION, CONFIG_SCHEMA, RELEASE } from 'bm.version';
import { list as featureList, provides } from 'bm.features';
import { schema as diskSchema } from 'bm.meta';
import { arm, cancel, confirm, status as guardStatus } from 'bm.guard';
import { install as installPackages, report as requirementsReport } from 'bm.requirements';
import { diff, restore } from 'bm.restore';
import { bundle as snapshotBundle, list as snapshots, meta as snapshotMeta, remove as removeSnapshot, take } from 'bm.snapshot';
import { apply as tuneApply, current as tuneCurrent } from 'bm.tune';
import { openBus, report as capacityReport } from 'bm.capacity';
import { apply as applyUpdate, check as checkUpdate, last as lastUpdate, rollback } from 'bm.update';

const STARTED = time();

// Bumped by the ubus wrapper only. A caller that reaches the functions below
// directly - bmctl, another module in this package - is not a request the
// router served, and counting it would make `stats` answer a different question
// depending on who asked.
let served = 0;

function config() {
	let out = { enabled: true, updateUrl: '' };

	try {
		let uci = cursor();
		let enabled = uci.get('bm_agent', 'main', 'enabled');
		let url = uci.get('bm_agent', 'main', 'update_url');

		// UCI has no booleans. `0`, `no`, `off` and `false` are all the same
		// answer, and anything else - including the option being absent - is on,
		// which is what the shipped config says.
		if (type(enabled) == 'string')
			out.enabled = !(enabled in [ '0', 'no', 'off', 'false' ]);

		if (type(url) == 'string')
			out.updateUrl = url;
	}
	catch (e) {
		// A router with no /etc/config/bm_agent at all still gets an answer.
		// Refusing to report anything because one file is missing would hide
		// the version handshake, which is the one thing this call exists for.
	}

	return out;
}

// Resident set size in kilobytes, or -1 when /proc did not say. -1 rather than
// 0 for the same reason the probe uses it: a caller has to be able to tell "no
// memory used" from "nobody asked".
function rssKb() {
	let status = readfile('/proc/self/status');
	if (type(status) != 'string')
		return -1;

	let found = match(status, /VmRSS:[ \t]+([0-9]+)/);
	return found ? int(found[1]) : -1;
}

// The version handshake, and the whole of what the module needs to decide
// whether to drive this router through the agent or fall back to SSH.
export function info() {
	let settings = config();

	return {
		name: 'bm-agent',
		release: RELEASE,
		// The number the module compares against its own. A mismatch is a
		// fallback, never a failure: an agent from the future and an app from
		// the past both have to leave the router working.
		apiVersion: API_VERSION,
		// Two schema numbers because they can disagree, and the disagreement is
		// the interesting part: `schema` is what this build understands and
		// `dataSchema` is what is actually on the disk. Equal is the normal
		// case; data ahead of the build is a downgrade the service refuses to
		// start on; data behind is a migration that has not run yet.
		schema: CONFIG_SCHEMA,
		dataSchema: diskSchema(),
		started: STARTED,
		uptime: time() - STARTED,
		enabled: settings.enabled,
		updateUrl: settings.updateUrl,
		// What else is installed, read off the disk on every call so that a
		// package unpacked five seconds ago is not reported as absent.
		features: featureList(),
		provides: provides(),
		// One small file read, and it saves the module a second call on every
		// poll: whether to show a countdown banner is something every surface
		// needs to know and nothing else here answers.
		guard: guardStatus()
	};
};

export function stats() {
	return {
		rssKb: rssKb(),
		uptime: time() - STARTED,
		served: served
	};
};

/**
 * One published method.
 *
 * `args` is a type template rather than a value: ubus reads the type of each
 * field to declare and check what callers may send, so `{ id: '' }` means "a
 * string called id" and `{}` means the method takes none.
 *
 * The counter is bumped here and nowhere else, which is what keeps `stats`
 * answering one question - how much has this router been asked to do - rather
 * than a different one depending on whether bmctl or the app was the caller.
 */
function method(args, fn) {
	// Accepted on every method because LuCI's dispatcher appends the session id
	// to whatever a page sends, and ucode's publish refuses any named argument
	// the template does not declare - which would turn every LuCI call into
	// UBUS_STATUS_INVALID_ARGUMENT while `ubus call` over SSH kept working. It
	// is stripped before the handler runs, so no function below ever sees it.
	args.ubus_rpc_session = '';

	return {
		call: function(req) {
			served++;
			let given = type(req.args) == 'object' ? req.args : {};
			delete given.ubus_rpc_session;
			return fn(given);
		},
		args: args
	};
}

function text(value) {
	return type(value) == 'string' ? value : '';
}

// The published object.
//
// Everything below is a wrapper over a function that does not know ubus exists,
// and `bmctl` calls those same functions. That is deliberate: there is one
// implementation of "restore this snapshot", not a console one and an app one
// that drift until they disagree about what a router did.
export const methods = {
	info: method({}, () => info()),
	stats: method({}, () => stats()),

	// A ubus reply is an object, so a list is returned under a name rather than
	// bare - which also leaves room to say more about the set later without
	// changing the shape of what a caller already parses.
	config_list: method({}, () => ({ snapshots: snapshots() })),

	config_show: method({ id: '' }, (args) => {
		let entry = snapshotMeta(text(args.id));
		return entry ? entry : { ok: false, reason: 'no snapshot called ' + text(args.id) };
	}),

	config_diff: method({ id: '' }, (args) => diff(text(args.id))),

	// The snapshot itself, as one `uci import` stream. It is how a page with no
	// filesystem of its own offers a download: the text comes back over the
	// same connection everything else does, and the browser saves it. Nothing
	// here needs a path, so nothing here can be asked for a path.
	config_export: method({ id: '' }, (args) => {
		let id = text(args.id);
		let out = snapshotBundle(id);
		return (type(out) == 'string')
			? { ok: true, id: id, text: out }
			: { ok: false, reason: 'no snapshot called ' + id + ', or nothing in it could be read' };
	}),

	config_restore: method({ id: '', dry_run: false }, (args) =>
		restore(text(args.id), { dryRun: args.dry_run === true })),

	config_snapshot: method({ reason: '' }, (args) =>
		take(length(text(args.reason)) ? text(args.reason) : 'manual')),

	config_delete: method({ id: '' }, (args) => removeSnapshot(text(args.id))),

	// The three the module calls around every apply. `guard_arm` takes the
	// snapshot itself, because the promise is that what it goes back to was
	// captured before the change - and a caller that forgot would only find out
	// at the moment it mattered.
	guard_arm: method({ timeout: 0, reason: '' }, (args) =>
		arm({
			timeout: type(args.timeout) == 'int' && args.timeout > 0 ? args.timeout : null,
			reason: text(args.reason)
		})),

	guard_confirm: method({}, () => confirm()),
	guard_cancel: method({}, () => cancel()),
	guard_status: method({}, () => guardStatus()),

	// The only calls that reach the internet, and only when one of them is made.
	// Nothing polls, nothing runs at boot: a router that phones home on its own
	// is a router doing something its owner did not ask for.
	update_check: method({}, () => checkUpdate()),

	update_apply: method({ dry_run: false, guard: true, timeout: 0 }, (args) =>
		applyUpdate({
			dryRun: args.dry_run === true,
			// The default is on, so only an explicit false turns it off - an
			// argument that was simply not sent must never disarm the safety net.
			guard: args.guard === false ? false : true,
			timeout: type(args.timeout) == 'int' && args.timeout > 0 ? args.timeout : null
		})),

	update_rollback: method({ guard: true, timeout: 0 }, (args) =>
		rollback({
			guard: args.guard === false ? false : true,
			timeout: type(args.timeout) == 'int' && args.timeout > 0 ? args.timeout : null
		})),

	// Reads a file. Deliberately not a second `update_check`: a surface asking
	// what happened last time must not make the router fetch anything.
	update_status: method({}, () => {
		let previous = lastUpdate();
		return previous ? previous : { at: 0, from: RELEASE, to: RELEASE, packages: [] };
	}),

	// What this router has of what every feature needs, asked live - so a
	// requirement that stops being met is a row somebody sees, not a feature
	// that breaks with its reason in dmesg.
	requirements: method({}, () => requirementsReport()),

	// The allowlisted installer behind those rows. `group` is a key into a
	// fixed table in bm.requirements; a package name never crosses this call.
	install_packages: method({ group: '', dry_run: false }, (args) =>
		installPackages({ group: text(args.group), dry_run: args.dry_run === true })),

	// The router-wide limits that decide whether thousands of sessions fit:
	// conntrack and the neighbour thresholds, plus fw4's flow offload.
	// What this router has, against what its configuration needs.
	//
	// Additive, so `apiVersion` does not move: an agent without it answers
	// METHOD_NOT_FOUND, which is what every surface turns into "update the
	// router packages" rather than into an error nobody can act on.
	capacity: method({ refresh: false },
		(args) => capacityReport({ bus: openBus(), refresh: args.refresh === true })),

	tune_get: method({}, () => tuneCurrent()),

	tune_set: method(
		{ conntrack_max: 0, gc_thresh1: 0, gc_thresh2: 0, gc_thresh3: 0, flow_offload: false },
		(args) => {
			// Only what the caller actually sent reaches the allowlist: a field
			// ubus never carried is absent here, and 0 is below every floor, so
			// neither can quietly reset a limit to nothing.
			let wanted = {};
			for (let key in [ 'conntrack_max', 'gc_thresh1', 'gc_thresh2', 'gc_thresh3' ]) {
				if (type(args[key]) == 'int' && args[key] > 0)
					wanted[key] = args[key];
			}
			if (type(args.flow_offload) == 'bool')
				wanted.flow_offload = args.flow_offload;

			return tuneApply(wanted);
		})
};
