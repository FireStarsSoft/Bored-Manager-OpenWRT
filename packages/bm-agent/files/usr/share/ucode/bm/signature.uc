// Whether a release manifest was signed by the key this build trusts.
//
// It matters because of what it is protecting against, which is not a corrupt
// download. A sha256 taken from the same file that was just fetched only proves
// the bytes arrived intact; it says nothing about who sent them. The manifest
// is the list of what to install and what each file should hash to, so anybody
// who can replace the manifest can replace everything - which is why the
// manifest, and only the manifest, is signed, and every archive is then checked
// against the hashes inside it.
//
// usign is OpenWrt's own signing tool: ed25519, the same format the firmware
// uses for its package feeds. It is shelled out to rather than reimplemented,
// because a hand-written signature check is a much worse idea than a fork.
//
// Fails closed, every time. No key installed, no usign on the router, an
// unreadable signature, a verify that did not return zero - all of them are
// "not verified", and the caller refuses. The other install paths have their
// own trust roots and do not come through here at all: a bundle a person chose
// from their own machine is trusted because they chose it, and the module's
// pinned install is trusted because the hash is compiled into the module.

import { access, lsdir } from 'fs';

import { debug, err } from 'bm.log';

export const KEYDIR = '/usr/share/bm/keys';

// Any .pub in the directory, so a key rollover ships the new one beside the old
// and a router mid-upgrade accepts either. Removing the old key is then its own
// release, made after everything has moved.
export function keys() {
	let names = lsdir(KEYDIR);
	if (type(names) != 'array')
		return [];

	let out = [];
	for (let name in names) {
		if (match(name, /\.pub$/))
			push(out, KEYDIR + '/' + name);
	}

	return sort(out);
};

function haveUsign() {
	// `access` rather than running it: `usign` with no arguments prints usage
	// and returns non-zero, which is indistinguishable from a broken install.
	for (let path in [ '/usr/bin/usign', '/bin/usign' ]) {
		if (access(path, 'x'))
			return path;
	}

	return null;
}

/**
 * Verify `file` against `sigFile`.
 *
 * Returns { ok, reason }. The reason is worded for somebody reading an update
 * that refused: "the signature did not verify" and "there is no key on this
 * router to verify it with" are different problems with different fixes, and
 * collapsing them into "update failed" is how a user comes to retry the same
 * download six times.
 */
export function verify(file, sigFile) {
	let usign = haveUsign();
	if (!usign) {
		return {
			ok: false,
			reason: 'usign is not installed on this router, so a signed release cannot be checked - install it, or install the packages from the app instead'
		};
	}

	let installed = keys();
	if (!length(installed)) {
		return {
			ok: false,
			reason: 'no release key is installed in ' + KEYDIR + ', so nothing fetched over the network can be trusted here - install the packages from the app instead'
		};
	}

	if (!access(file, 'r') || !access(sigFile, 'r')) {
		return { ok: false, reason: 'the manifest or its signature is missing' };
	}

	for (let key in installed) {
		// An array rather than a command line: nothing here is quoted, escaped
		// or passed through a shell, so a path can never become an argument.
		let status = system([ usign, '-V', '-q', '-m', file, '-p', key, '-x', sigFile ]);

		if (status === 0) {
			debug('manifest verified against ' + key);
			return { ok: true, key: key };
		}
	}

	err('manifest did not verify against any key in ' + KEYDIR);
	return {
		ok: false,
		reason: 'the release manifest is not signed by a key this router trusts - it was not published by this project, or it was altered on the way here'
	};
};
