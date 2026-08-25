// What schema this router's data is written at, and which release stamped it.
//
// It is a file under /etc/bm/, not a section in /etc/config/. UCI is for what a
// person edits, and this is the one number nobody should ever edit: it says
// what shape the data on disk is in, and setting it by hand does not change the
// data - it only makes the next migration skip the step that would have. It is
// also deliberately outside the snapshot set, because restoring an old schema
// number over data the new code already migrated is exactly the corruption
// snapshots exist to prevent.
//
// Absent means fresh. That is the whole rule that keeps a first install from
// running a chain of migrations against data that does not exist yet: the file
// is created by the first `bmctl migrate`, which postinst runs, and from then
// on its presence is what says this router has been here before.

import { debug } from 'bm.log';
import { read, write } from 'bm.state';
import { CONFIG_SCHEMA, RELEASE } from 'bm.version';

const NAME = 'meta';

// Null when this router has never been stamped - a first install. Callers must
// treat that as "nothing to migrate", never as schema 0.
export function current() {
	let meta = read(NAME);
	if (type(meta) != 'object' || type(meta.schema) != 'int')
		return null;

	return meta;
};

export function schema() {
	let meta = current();
	return meta ? meta.schema : null;
};

export function stamp(value, note) {
	let meta = current();
	let out = {
		schema: value,
		release: RELEASE,
		// Kept across stamps so a router can say when it was first set up, which
		// is the one date that explains why its data looks the way it does.
		firstSeen: (meta && type(meta.firstSeen) == 'int') ? meta.firstSeen : time(),
		stampedAt: time()
	};

	if (type(note) == 'string')
		out.note = note;

	debug('stamping schema ' + value);
	return write(NAME, out);
};

/**
 * Whether this build may run against the data on disk.
 *
 * Refusing to run on a schema newer than the code understands is the whole
 * point. Downgrading a package is easy - `apk add` an older file, restore a
 * snapshot, roll back an update - and the data does not come back with it. Code
 * that ploughs on reads fields that moved and writes fields that no longer mean
 * what it thinks, which is a far worse outcome than a service that will not
 * start and says why.
 */
export function compatibility() {
	let found = schema();

	if (found === null)
		return { ok: true, fresh: true, schema: CONFIG_SCHEMA };

	if (found > CONFIG_SCHEMA) {
		return {
			ok: false,
			fresh: false,
			schema: found,
			reason: sprintf(
				'this router\'s data is at schema %d and this build only understands %d - install the newer packages again, or restore a snapshot taken before the upgrade',
				found, CONFIG_SCHEMA)
		};
	}

	return { ok: true, fresh: false, schema: found, pending: CONFIG_SCHEMA - found };
};
