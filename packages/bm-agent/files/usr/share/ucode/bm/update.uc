// Updating the packages from the router, when somebody asks.
//
// Never on a timer, never at boot, never in the background. A router that calls
// out to the internet on its own is a router doing something its owner did not
// ask for, and the one thing this project must never do is surprise somebody's
// network. Every function here runs because a person pressed something.
//
// The order matters and is the same every time:
//
//   check      fetch the manifest, verify its signature, compare versions
//   guard      snapshot and arm the countdown, so a bad update undoes itself
//   download   every .apk, each checked against the hash in the signed manifest
//   install    one `apk add --allow-untrusted` with all of them
//   migrate    as a *new process*, because the old one is still running the
//              code apk just replaced
//   verify     ask the router what it now has, rather than assuming
//
// What the guard protects is worth being precise about: it restores the
// router's *configuration*, not its packages. An update that writes a broken
// firewall rule is undone by it; an update whose new agent simply crashes is
// not, and `bmctl rollback` is what that needs.

import { access, lsdir, mkdir, popen, readfile, rename, rmdir, stat, unlink } from 'fs';
import { cursor } from 'uci';

import { arm } from 'bm.guard';
import { err, notice } from 'bm.log';
import { verify } from 'bm.signature';
import { ROOT, ensure, read as readState, write as writeState } from 'bm.state';
import { CONFIG_SCHEMA, RELEASE, compare, isNewer } from 'bm.version';

/** Where the .apk set that produced the current install is kept. */
export const STORE = ROOT + '/packages';
const CURRENT = STORE + '/current';
const PREVIOUS = STORE + '/previous';

/**
 * Where the manifest and the archives are staged, made fresh by `mktemp -d`.
 *
 * Not a fixed path. `/tmp` is world-writable, so any process on the router can
 * create `/tmp/bm-update` first - as a directory it can also write, or as a
 * symlink pointing somewhere else entirely - and `ensureDir` would have adopted
 * it: stat() follows symlinks, the mkdir with its 0700 never runs, and the
 * whole update then happens as root inside a path somebody else chose. That is
 * the download, the sha256 check, the `apk add` that follows it, and the
 * removeTree afterwards. CWE-377, and the module's own side of this has used
 * `mktemp -d` since 2.2.0 for exactly this reason.
 *
 * `mktemp -d` creates the directory itself and fails rather than reusing one,
 * which is the property that matters: there is no window in which the path
 * exists and is not ours.
 *
 * Resolved once and remembered, because a check followed by an apply has to
 * stage into the same directory.
 */
let WORK = null;

function workDir() {
	if (WORK)
		return WORK;

	let handle = popen('umask 077; mktemp -d /tmp/bm-update.XXXXXX 2>/dev/null', 'r');
	if (!handle)
		return null;

	let out = handle.read('all');
	handle.close();

	let path = (type(out) == 'string') ? trim(out) : '';

	// Checked rather than trusted: the name is about to be joined with a file
	// name from a manifest and handed to wget and to apk.
	WORK = match(path, /^\/tmp\/bm-update\.[A-Za-z0-9]{6,}$/) ? path : null;
	return WORK;
}


// Generous, because this is one file over whatever uplink a router has, and a
// download that gives up at thirty seconds on a slow ADSL line is a failure
// invented by the timeout.
//
// Written without digit separators because ucode has none: its lexer stops a
// number at the first character that is not a digit, so `120_000` is the number
// 120 followed by a label, and the file does not compile at all.
const FETCH_TIMEOUT_MS = 120000;    // two minutes
const INSTALL_TIMEOUT_MS = 300000;  // five

// A manifest naming a file with a slash in it would put a package outside the
// working directory and turn a URL into a path traversal. Names come from a
// signed file, so this should never fire - which is exactly why it is checked.
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.apk$/;

function ensureDir(path) {
	let info = stat(path);
	if (info && info.type == 'directory')
		return true;

	mkdir(path, 0o700);
	info = stat(path);
	return (info && info.type == 'directory') ? true : false;
}

function removeTree(path) {
	let names = lsdir(path);
	if (type(names) == 'array') {
		for (let name in names)
			unlink(path + '/' + name);
	}
	return true;
}

function configuredUrl() {
	try {
		let url = cursor().get('bm_agent', 'main', 'update_url');
		return type(url) == 'string' ? trim(url) : '';
	}
	catch (e) {
		return '';
	}
}

/** `https://host/a/b/bm-packages.json` -> `https://host/a/b/`. */
function baseOf(url) {
	let cut = 0;
	for (let i = 0; i < length(url); i++) {
		if (substr(url, i, 1) == '/')
			cut = i;
	}
	return substr(url, 0, cut + 1);
}

function downloader() {
	for (let tool in [ '/bin/uclient-fetch', '/usr/bin/uclient-fetch', '/usr/bin/wget', '/bin/wget' ]) {
		if (access(tool, 'x'))
			return tool;
	}
	return null;
}

function fetch(url, dest) {
	let tool = downloader();
	if (!tool)
		return { ok: false, reason: 'no uclient-fetch or wget on this router, so nothing can be downloaded' };

	// Certificates are never skipped and there is deliberately no option to.
	// A download this router cannot authenticate is a download it does not make.
	let status = system([ tool, '-q', '-O', dest, url ], FETCH_TIMEOUT_MS);

	if (status !== 0) {
		unlink(dest);
		return {
			ok: false,
			reason: sprintf('%s exited %d fetching %s', tool, status, url),
			// Named separately because it is the common cause and has a fix that
			// has nothing to do with the URL.
			hint: access('/etc/ssl/certs/ca-certificates.crt', 'r')
				? null
				: 'ca-bundle is not installed, so this router cannot verify an HTTPS certificate'
		};
	}

	return { ok: true };
}

function sha256(path) {
	let handle = popen('sha256sum ' + path + ' 2>/dev/null', 'r');
	if (!handle)
		return null;

	let text = handle.read('all');
	handle.close();

	let found = match(type(text) == 'string' ? text : '', /^([0-9a-f]{64})/);
	return found ? found[1] : null;
}

function highestSchema(packages) {
	let found = null;

	for (let entry in packages) {
		if (type(entry.configSchema) == 'int' && (found === null || entry.configSchema > found))
			found = entry.configSchema;
	}

	return found;
}

function parseManifest(path) {
	let text = readfile(path);
	if (type(text) != 'string')
		return { ok: false, reason: 'the manifest could not be read' };

	let value;
	try {
		value = json(text);
	}
	catch (e) {
		return { ok: false, reason: 'the manifest is not valid JSON' };
	}

	if (type(value) != 'object' || type(value.release) != 'string' || type(value.packages) != 'array')
		return { ok: false, reason: 'the manifest has no release or no package list' };

	for (let entry in value.packages) {
		if (type(entry) != 'object' || type(entry.file) != 'string' || type(entry.sha256) != 'string')
			return { ok: false, reason: 'a package entry has no file or no sha256' };

		if (!match(entry.file, SAFE_FILE))
			return { ok: false, reason: 'a package entry names something that is not a plain .apk filename' };
	}

	return { ok: true, manifest: value };
}

/**
 * Fetch and verify the manifest. Changes nothing on the router.
 *
 * Returns { ok, current, latest, newer, packages, reason }. `newer` is only
 * ever true for a version that parsed and compared - an unreadable version is
 * "cannot tell", never "older", because treating it as older is how a router
 * talks itself into a downgrade.
 */
export function check() {
	let url = configuredUrl();
	if (!length(url))
		return { ok: false, current: RELEASE, reason: 'no update_url is set in /etc/config/bm_agent' };

	let work = workDir();
	if (!work)
		return { ok: false, current: RELEASE, reason: 'cannot make a working directory under /tmp' };

	let manifestPath = work + '/bm-packages.json';
	let sigPath = manifestPath + '.sig';

	let got = fetch(url, manifestPath);
	if (!got.ok)
		return { ok: false, current: RELEASE, reason: got.reason, hint: got.hint };

	// The signature is fetched from beside the manifest rather than from a
	// separate place, so a mirror serving one serves both or neither.
	let sig = fetch(url + '.sig', sigPath);
	if (!sig.ok) {
		return {
			ok: false,
			current: RELEASE,
			reason: 'the manifest has no signature beside it, so nothing here can be trusted: ' + sig.reason
		};
	}

	let verified = verify(manifestPath, sigPath);
	if (!verified.ok)
		return { ok: false, current: RELEASE, reason: verified.reason };

	let parsed = parseManifest(manifestPath);
	if (!parsed.ok)
		return { ok: false, current: RELEASE, reason: parsed.reason };

	let manifest = parsed.manifest;
	let ordering = compare(manifest.release, RELEASE);

	return {
		ok: true,
		current: RELEASE,
		latest: manifest.release,
		// Null when either side would not parse: a caller has to be able to tell
		// "older" from "no idea" and refuse on the second.
		newer: ordering === null ? null : (ordering === 1),
		comparable: ordering !== null,
		minAgentVersion: type(manifest.minAgentVersion) == 'string' ? manifest.minAgentVersion : null,
		// The highest any package in the release declares, not the first one's:
		// the set is installed together, so the strictest requirement is the
		// one that decides whether this router may take it.
		configSchema: highestSchema(manifest.packages),
		packages: manifest.packages,
		notes: type(manifest.notes) == 'string' ? manifest.notes : '',
		key: verified.key,
		url: url,
		// Named, because "this router cannot verify an HTTPS certificate" is a
		// different problem with a different fix from "the URL is wrong", and a
		// surface that cannot tell them apart sends people to the wrong place.
		caBundle: access('/etc/ssl/certs/ca-certificates.crt', 'r') ? true : false,
		manifestPath: manifestPath
	};
};

/**
 * What the router says it is running, asked in a new process.
 *
 * The point is that it is a new process: this one compiled its modules from the
 * files apk has just replaced, so asking it would only ever get the answer it
 * started with. Anything unreadable comes back null and the caller reports the
 * install as done-but-unverified rather than claiming a version it did not see.
 */
function installedRelease() {
	let handle = popen('/usr/sbin/bmctl version --json 2>/dev/null', 'r');
	if (!handle)
		return null;

	let text = handle.read('all');
	handle.close();

	try {
		let value = json(type(text) == 'string' ? text : '');
		return (type(value) == 'object' && type(value.release) == 'string') ? value.release : null;
	}
	catch (e) {
		return null;
	}
}

/** Why this router must not take that release, or null. */
function blockers(found) {
	if (found.newer === null)
		return 'the published version cannot be compared with the installed one, so this router will not act on it';

	if (found.newer !== true)
		return sprintf('this router is already at %s and the published release is %s', found.current, found.latest);

	// A release that needs a newer agent than this one to apply it. The step in
	// between has to be taken first, and saying which is the whole point.
	if (found.minAgentVersion && isNewer(found.minAgentVersion, RELEASE)) {
		return sprintf(
			'%s needs agent %s or newer to apply it and this router has %s - update to that first',
			found.latest, found.minAgentVersion, found.current);
	}

	// Data written at a schema the incoming build does not understand. The
	// service would refuse to start afterwards, so it is refused now, while the
	// router is still working.
	if (type(found.configSchema) == 'int' && found.configSchema < CONFIG_SCHEMA) {
		return sprintf(
			'%s writes data at schema %d and this router is already at %d - installing it would take the data backwards',
			found.latest, found.configSchema, CONFIG_SCHEMA);
	}

	return null;
}

function stash(files) {
	if (!ensure() || !ensureDir(STORE))
		return false;

	// The previous set is what `rollback` reinstalls, so it is replaced only
	// once the new one is safely on the router - which is why this runs after
	// `apk add` and not before it.
	removeTree(PREVIOUS);
	if (stat(CURRENT))
		rename(CURRENT, PREVIOUS);

	if (!ensureDir(CURRENT))
		return false;

	// Copied, not renamed. /tmp is tmpfs and /etc is the overlay, so a rename
	// across them fails with EXDEV - which would silently leave the store empty
	// and `rollback` with nothing to offer, on exactly the router that needs it.
	for (let file in files) {
		if (system([ 'cp', file.path, CURRENT + '/' + file.name ]) !== 0)
			err('could not keep a copy of ' + file.name + ' for rollback');
	}

	return true;
}

/**
 * Take the update.
 *
 * `options.guard` defaults to true and is the reason this is safe to run on a
 * router nobody can physically reach. `options.dryRun` stops after the checks.
 */
export function apply(options) {
	let opts = type(options) == 'object' ? options : {};

	let found = check();
	if (!found.ok)
		return { ok: false, reason: found.reason, hint: found.hint };

	let blocked = opts.force === true ? null : blockers(found);
	if (blocked)
		return { ok: false, reason: blocked, current: found.current, latest: found.latest };

	if (opts.dryRun === true) {
		return {
			ok: true,
			dryRun: true,
			current: found.current,
			latest: found.latest,
			packages: map(found.packages, (entry) => entry.file)
		};
	}

	let base = baseOf(found.url);
	let downloaded = [];

	for (let entry in found.packages) {
		let dest = workDir() + '/' + entry.file;
		let got = fetch(base + entry.file, dest);

		if (!got.ok)
			return { ok: false, reason: got.reason, hint: got.hint };

		// Against the hash in the signed manifest, not one computed from the
		// same download. That is the whole difference between "it arrived
		// intact" and "it is what was published".
		let digest = sha256(dest);
		if (digest !== entry.sha256) {
			unlink(dest);
			return {
				ok: false,
				reason: sprintf('%s does not match the hash in the signed manifest - it was altered on the way here', entry.file)
			};
		}

		push(downloaded, { name: entry.file, path: dest });
	}

	if (!length(downloaded))
		return { ok: false, reason: 'the manifest lists no packages' };

	let guard = null;
	if (opts.guard !== false) {
		let armed = arm({ timeout: opts.timeout, reason: 'update-' + found.latest });

		if (!armed.ok)
			return { ok: false, reason: 'could not arm the guard, so the update was not started: ' + armed.reason };

		guard = armed;
	}

	let argv = [ 'apk', 'add', '--allow-untrusted' ];
	for (let file in downloaded)
		push(argv, file.path);

	// One command with every file, so apk resolves them against each other
	// rather than failing on a dependency that is in the next argument.
	let status = system(argv, INSTALL_TIMEOUT_MS);
	if (status !== 0) {
		return {
			ok: false,
			reason: sprintf('apk add exited %d; nothing was migrated and the guard is still armed', status),
			guard: guard
		};
	}

	stash(downloaded);

	// A new process on purpose. apk has just replaced every file under
	// /usr/share/ucode/bm/, and this one is still running the code it compiled
	// from the old ones - so the migration has to be run by something that
	// starts after the install, or it would migrate with the previous release's
	// idea of what the data should look like.
	let migrated = system([ '/usr/sbin/bmctl', 'migrate' ], INSTALL_TIMEOUT_MS);

	if (migrated !== 0)
		err('the packages installed but the migration did not finish - run `bmctl schema` to see why');

	// The downloads are in tmpfs and have been copied into the store; leaving
	// them would keep a few hundred kilobytes of RAM occupied until the next
	// reboot, on a device that may not have much.
	// The archives are in tmpfs and have been copied into the store; leaving
	// them would hold a few hundred kilobytes of RAM until the next reboot, on
	// a device that may not have much. The directory itself goes too, since it
	// is this run's and nothing else will ever look in it.
	removeTree(WORK);
	rmdir(WORK);
	WORK = null;

	writeState('update', {
		at: time(),
		from: found.current,
		to: found.latest,
		packages: map(downloaded, (file) => file.name),
		migrated: migrated === 0
	});

	// Read off the router rather than assumed. An `apk add` that returned zero
	// having installed nothing useful is rare, and reporting a version nobody
	// checked is exactly how it would go unnoticed.
	let running = installedRelease();

	if (running !== null && running != found.latest) {
		err(sprintf('apk reported success but this router still answers %s, not %s',
			running, found.latest));
	}

	notice(sprintf('updated %s -> %s', found.current, found.latest));

	return {
		ok: true,
		from: found.current,
		to: found.latest,
		// Null when it could not be read, which a surface must show as
		// "unverified" rather than as a failure or as a success.
		verified: running === null ? null : (running == found.latest),
		running: running,
		packages: map(downloaded, (file) => file.name),
		migrated: migrated === 0,
		// Deliberately still armed. The caller confirms once it has read the
		// router back and found it answering; nobody confirming is exactly the
		// case the guard exists for.
		guard: guard
	};
};

/** What the last update did, for a surface to show. Null if none has run. */
export function last() {
	let entry = readState('update');
	return type(entry) == 'object' ? entry : null;
};

/**
 * Put the previous package set back.
 *
 * The archives kept under /etc/bm/packages/previous/ are the ones this router
 * actually installed, so there is nothing to download and nothing to verify -
 * they were verified on the way in. A router whose first install came from the
 * app has no previous set, and is told so rather than left to guess why
 * nothing happened.
 */
export function rollback(options) {
	let opts = type(options) == 'object' ? options : {};
	let names = lsdir(PREVIOUS);

	if (type(names) != 'array' || !length(names)) {
		return {
			ok: false,
			reason: 'there is no previous package set on this router to go back to - install the version you want from the app instead'
		};
	}

	let argv = [ 'apk', 'add', '--allow-untrusted' ];
	let files = [];

	for (let name in names) {
		if (!match(name, SAFE_FILE))
			continue;
		push(argv, PREVIOUS + '/' + name);
		push(files, name);
	}

	if (!length(files))
		return { ok: false, reason: 'the previous package set holds no .apk files' };

	let guard = null;
	if (opts.guard !== false) {
		let armed = arm({ timeout: opts.timeout, reason: 'rollback' });
		if (!armed.ok)
			return { ok: false, reason: 'could not arm the guard, so the rollback was not started: ' + armed.reason };
		guard = armed;
	}

	let status = system(argv, INSTALL_TIMEOUT_MS);
	if (status !== 0)
		return { ok: false, reason: sprintf('apk add exited %d during rollback', status), guard: guard };

	// No migration. Going back to an older build cannot move the data forward,
	// and there is no `down` step by design - if the data was migrated by the
	// version being removed, the older service will refuse to start and say so,
	// which is when the snapshot taken before the update is the way back.
	notice('rolled back to the previous package set: ' + join(', ', files));

	return { ok: true, packages: files, guard: guard, migrated: false };
};
