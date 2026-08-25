// Everything the agent writes for itself, and nowhere else.
//
// Two kinds of data live on this router and they are deliberately kept apart:
//
//   /etc/config/bm_*   what a person edits. Declared as apk conffiles, so an
//                      update leaves their edits alone.
//   /etc/bm/           what the agent decides. Never shipped by any package, so
//                      apk neither writes it nor removes it, and an update
//                      cannot roll it back to a fresh install's idea of it.
//
// Both are under /etc, which on OpenWrt is in the overlay and therefore
// survives a reboot. /etc/bm/ is 0700 because state grows: the snapshots that
// land here later contain a router's whole network configuration, and a
// world-readable copy of that is worse than not having one.
//
// Every write is atomic - a temporary file and a rename - because the failure
// this guards against is not a bug, it is a power cut. A half-written JSON file
// is one nothing can read afterwards, and on a router the moment of maximum
// risk is exactly when something is being applied.

import { chmod, lsdir, mkdir, readfile, rename, stat, unlink, writefile } from 'fs';

import { debug, err } from 'bm.log';

export const ROOT = '/etc/bm';
export const DIR = ROOT + '/state';

function ensureDir(path) {
	let info = stat(path);
	if (info && info.type == 'directory')
		return true;

	if (!mkdir(path, 0o700)) {
		// Racing with another writer is fine and expected; anything else is not.
		info = stat(path);
		if (!info || info.type != 'directory') {
			err('cannot create ' + path);
			return false;
		}
	}

	return true;
}

export function ensure() {
	return ensureDir(ROOT) && ensureDir(DIR);
};

function path(name) {
	return DIR + '/' + name + '.json';
}

// Null for "not there" and null for "there but unreadable" are deliberately the
// same answer to a caller: both mean this router has no usable value, and the
// only correct response to either is to write a fresh one. The difference is
// logged rather than returned, because a caller that branched on it would be
// choosing between two ways of doing the same thing.
export function read(name) {
	let text = readfile(path(name));
	if (type(text) != 'string')
		return null;

	try {
		return json(text);
	}
	catch (e) {
		err('state/' + name + '.json will not parse; treating it as absent');
		return null;
	}
};

export function write(name, value) {
	if (!ensure())
		return false;

	let target = path(name);
	let temp = target + '.tmp';

	if (!writefile(temp, sprintf('%J\n', value))) {
		err('cannot write ' + temp);
		return false;
	}

	chmod(temp, 0o600);

	// Rename within one directory is atomic: a reader sees either the previous
	// file or the new one, and never the half of one that had been written when
	// the power went.
	if (!rename(temp, target)) {
		err('cannot replace ' + target);
		unlink(temp);
		return false;
	}

	debug('wrote state/' + name + '.json');
	return true;
};

export function remove(name) {
	return unlink(path(name)) ? true : false;
};

export function list() {
	let names = lsdir(DIR);
	if (type(names) != 'array')
		return [];

	let out = [];
	for (let name in names) {
		let found = match(name, /^(.+)\.json$/);
		if (found)
			push(out, found[1]);
	}

	return sort(out);
};
