// /etc/config/bm_pppoe, and the naming rules every pool obeys.
//
// The sections that dial live in /etc/config/network, where netifd reads them.
// This file is the record of which of those belong to which pool - without it,
// "delete this pool" could only mean "delete every PPPoE interface on the
// router", which is not the same thing on a router that had some already.
//
// The names are derived, never stored per session: pool `ppp` sequence 7 is
// always section `ppp00007` and always table base+7. That is what lets a pool
// of five thousand be described by six numbers instead of five thousand rows,
// and what lets a delete be certain it is removing its own.

import { cursor } from 'uci';

import { debug, err } from 'bm.log';

const PACKAGE = 'bm_pppoe';

// Five digits, so a pool can hold 99999 sessions and every section name sorts
// in sequence order in `uci show`. Written into the format string rather than
// passed as a `*` width, because ucode's sprintf is not C's and this is not a
// thing to discover on a router.
const SEQ_FORMAT = '%s%05d';
const MAX_SEQ = 99999;

// Linux caps an interface name at IFNAMSIZ, which is 16 bytes including the
// terminator. A prefix of 1-4 characters plus five digits fits with room for a
// VLAN suffix on the device name.
const PREFIX = /^[a-z][a-z0-9]{0,3}$/;


function flag(value, fallback) {
	if (type(value) != 'string' || !length(value))
		return fallback;

	return !(value in [ '0', 'no', 'off', 'false', 'disabled' ]);
};

function number(value, fallback) {
	if (type(value) == 'int')
		return value;
	if (type(value) != 'string' || !match(trim(value), /^[0-9]+$/))
		return fallback;
	return int(trim(value));
};

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
};

/** `ppp` + 7 -> `ppp00007`. The one place a section name is built. */
export function sectionName(prefix, seq) {
	return sprintf(SEQ_FORMAT, prefix, seq);
};

/** Pool table base + sequence. Each session gets a routing table of its own. */
export function tableFor(tableBase, seq) {
	return tableBase + seq;
};

export function validPrefix(value) {
	return type(value) == 'string' && match(value, PREFIX) ? true : false;
};

/**
 * Whether a credential is safe to write into a config file.
 *
 * Byte by byte, and not by regex, for two separate reasons that both had to be
 * found by running it.
 *
 * ucode hands a pattern straight to regcomp with REG_EXTENDED, and POSIX has no
 * \x escape - so `/[\x00-\x1f\x7f]/`, which is the obvious spelling, is
 * refused by regcomp. Refused when the constant is built, which is when this
 * module is loaded, so the entire package would fail to start with "Invalid
 * regular expression" and no line of it would ever run. `ucode -c` cannot see
 * it: compiling a regex literal into the bytecode never calls regcomp.
 *
 * And a subject reaches regexec as a NUL-terminated C string, so a value with a
 * NUL in it is scanned only as far as the NUL and everything after is invisible
 * to any pattern at all. A password the uci library then truncates at that NUL
 * is not a security hole, but it is a session that never dials and a cause
 * nobody would ever find.
 *
 * A loop over 128 bytes has neither problem and costs nothing.
 */
export function safeValue(value) {
	if (type(value) != 'string' || length(value) < 1 || length(value) > 128)
		return false;

	for (let i = 0; i < length(value); i++) {
		// C0 controls and DEL: anything that could end a UCI line or a shell
		// word. Bytes above 127 are left alone - they are UTF-8 continuation
		// bytes, and a username with an accent in it is somebody's username.
		let byte = ord(value, i);
		if (byte < 32 || byte == 127)
			return false;
	}

	return true;
};

/** The one global section. Absent means the shipped defaults. */
export function main() {
	let out = { enabled: true, counterInterval: 5, redialAfter: 120, redialBatch: 20 };

	try {
		let uci = cursor();
		out.enabled = flag(uci.get(PACKAGE, 'main', 'enabled'), true);

		let interval = number(uci.get(PACKAGE, 'main', 'counter_interval'), 5);
		out.counterInterval = (interval >= 1 && interval <= 300) ? interval : 5;

		let redial = number(uci.get(PACKAGE, 'main', 'redial_after'), 120);
		out.redialAfter = (redial >= 0 && redial <= 86400) ? redial : 120;

		let batch = number(uci.get(PACKAGE, 'main', 'redial_batch'), 20);
		out.redialBatch = (batch >= 1 && batch <= 500) ? batch : 20;
	}
	catch (e) {
		debug('cannot read ' + PACKAGE + ': ' + e);
	}

	return out;
};

/** Why this pool record cannot be used, or null. */
export function refusal(one) {
	if (!validPrefix(one.prefix))
		return 'prefix must be 1 to 4 characters, starting with a letter';

	if (one.seqFrom < 1 || one.seqTo < one.seqFrom || one.seqTo > MAX_SEQ)
		return sprintf('sequence range %d-%d is not inside 1-%d', one.seqFrom, one.seqTo, MAX_SEQ);

	if (one.tableBase < 1 || one.tableBase + one.seqTo > 65535) {
		return sprintf('table base %d plus sequence %d is beyond the routing table range',
			one.tableBase, one.seqTo);
	}

	if (!length(one.carrier))
		return 'no carrier is set, so there is nothing to dial over';

	return null;
};

/** Every pool this router has a record of, in file order. */
export function pools() {
	let out = [];

	try {
		cursor().foreach(PACKAGE, 'pool', (section) => {
			let one = {
				id: text(section['.name']),
				prefix: text(section.prefix),
				carrier: text(section.carrier),
				seqFrom: number(section.seq_from, 0),
				seqTo: number(section.seq_to, 0),
				tableBase: number(section.table_base, 0),
				created: number(section.created, 0),
				vlan: number(section.vlan, 0)
			};

			one.count = one.seqTo - one.seqFrom + 1;

			let reason = refusal(one);
			if (reason) {
				err('pool ' + one.id + ': ' + reason);
				return;
			}

			push(out, one);
		});
	}
	catch (e) {
		debug('cannot list pools in ' + PACKAGE + ': ' + e);
	}

	return out;
};

export function pool(id) {
	for (let one in pools()) {
		if (one.id == id)
			return one;
	}

	return null;
};

/** Every section name a pool owns, in sequence order. */
export function sectionsOf(one) {
	let out = [];
	for (let seq = one.seqFrom; seq <= one.seqTo; seq++)
		push(out, sectionName(one.prefix, seq));
	return out;
};

/**
 * Record a pool, or forget one.
 *
 * Written before the interfaces are, and removed after they are: a record with
 * no sections is a pool that can be deleted cleanly, and sections with no
 * record are sections nothing knows how to delete.
 */
export function remember(one) {
	try {
		let uci = cursor();
		uci.set(PACKAGE, one.id, 'pool');
		uci.set(PACKAGE, one.id, 'prefix', one.prefix);
		uci.set(PACKAGE, one.id, 'carrier', one.carrier);
		uci.set(PACKAGE, one.id, 'seq_from', sprintf('%d', one.seqFrom));
		uci.set(PACKAGE, one.id, 'seq_to', sprintf('%d', one.seqTo));
		uci.set(PACKAGE, one.id, 'table_base', sprintf('%d', one.tableBase));
		uci.set(PACKAGE, one.id, 'created', sprintf('%d', one.created));
		if (one.vlan)
			uci.set(PACKAGE, one.id, 'vlan', sprintf('%d', one.vlan));

		// The return is tested, not the exception. ucode's uci module never
		// raises: every failure path in lib/uci.c stashes a code and returns
		// null, so the catch below only ever fires on a cursor that would not
		// open. A commit that silently failed here would leave the pool's
		// interfaces written with no record naming them - the exact state this
		// file exists to prevent, and the one that cannot be cleaned up
		// afterwards because nothing knows the sections are a pool.
		if (uci.commit(PACKAGE) === null) {
			err('cannot record pool ' + one.id + ': the configuration would not commit');
			return false;
		}

		return true;
	}
	catch (e) {
		err('cannot record pool ' + one.id + ': ' + e);
		return false;
	}
};

export function forget(id) {
	try {
		let uci = cursor();
		uci.delete(PACKAGE, id);
		uci.commit(PACKAGE);
		return true;
	}
	catch (e) {
		err('cannot remove the record of pool ' + id + ': ' + e);
		return false;
	}
};
