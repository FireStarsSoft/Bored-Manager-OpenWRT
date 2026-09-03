// A working uci, in memory, for the probes only.
//
// Deliberately not in ../../stubs: that directory is on the search path for
// every module load the check does, and a module that started writing
// configuration during a syntax check would be a worse problem than the one the
// stubs solve. This file is put on the path only by the probe runner, which
// wants the writes to actually happen so it can read them back.
//
// Same shapes as ucode-mod-uci, which is the only reason a probe can drive the
// real daemon code through it: `set` with three arguments creates a section of
// that type, with four sets an option, `get` with two answers the section's
// type and with three the option, `get_all` hands back the whole section, and
// `foreach` walks sections of one type in file order.
//
// One store, shared by every cursor, for the life of the process. That is the
// arrangement the write paths need rather than a convenience: `service.bind`
// opens a cursor, writes a section, commits, and then asks `bm.wanbind.config`
// - which opens a cursor of its own - to read it back and say whether it is a
// binding this router can act on. A cursor that kept its writes to itself would
// make every one of those read-backs answer "there is no such section", which
// is a refusal the daemon then undoes, so the probe would watch a working
// `bind` fail and leave nothing behind.

let store = {};

// What the code under test did to get at the store, rather than what it wrote.
//
// The writes are already visible - the store is right there to read back. What
// was not visible is the *cost*: `info()` opening five cursors to answer one
// question, or a pass committing the firewall once per binding, are both
// perfectly correct and both fall over at five hundred. A probe cannot see
// either without being told, so this counts.
//
// Reset between blocks, never between calls: the number a scale assertion wants
// is "how many did that one call cost", and the only honest way to get it is to
// zero the counters immediately before the call.
let opens = 0;
let commitCounts = {};
let walkCounts = {};

function pkg(name) {
	if (!(name in store))
		store[name] = { order: [], sections: {} };

	return store[name];
};

function without(list, drop) {
	let out = [];

	for (let one in list) {
		if (one != drop)
			push(out, one);
	}

	return out;
};

const handle = {
	get: function(config, section, option) {
		let one = pkg(config).sections[section];
		if (!one)
			return null;

		// Two arguments is a question about the section itself, and the real
		// module answers it with the section's *type* - `direct`, `instance`,
		// `forwarding`. Handing back the section object instead read the same as
		// "yes, it is there" at all four call sites in the daemon, every one of
		// which only tests it against null - and told a probe nothing about what
		// had been written. That is the difference between asserting a `bind`
		// wrote a binding and asserting it wrote *something*: a call that turned
		// `config instance 'home'` into `config direct 'home'` - a whole LAN's
		// pool deleted by a call that was adding one address - would have passed
		// either way. `get_all` below is the object.
		if (option == null)
			return one['.type'];

		return (option in one) ? one[option] : null;
	},

	/**
	 * The whole section, or null.
	 *
	 * A copy, and that is the point rather than tidiness. A probe asserting that
	 * an edit left a field alone has to hold the section as it was before the
	 * write and compare it with the section after, and one that was handed the
	 * stored object twice would be comparing one object with itself - so the
	 * fields the write had quietly cleared would agree, and the assertion would
	 * pass on exactly the fault it was written to catch.
	 *
	 * Shallow, like the real module's: an option whose value is a list is the
	 * same array in both, which no probe here writes through.
	 */
	get_all: function(config, section) {
		let one = pkg(config).sections[section];
		if (!one)
			return null;

		let out = {};
		for (let key in one)
			out[key] = one[key];

		return out;
	},

	set: function(config, section, a, b) {
		let p = pkg(config);

		if (!(section in p.sections) || !p.sections[section]) {
			p.sections[section] = { '.name': section, '.type': '' };
			p.order = without(p.order, section);
			push(p.order, section);
		}

		if (b == null)
			p.sections[section]['.type'] = a;
		else
			p.sections[section][a] = b;

		return true;
	},

	delete: function(config, section, option) {
		let p = pkg(config);

		if (option == null) {
			p.sections[section] = null;
			p.order = without(p.order, section);
			return true;
		}

		if (p.sections[section])
			delete p.sections[section][option];

		return true;
	},

	foreach: function(config, kind, fn) {
		let p = pkg(config);
		let key = config + '|' + kind;

		walkCounts[key] = (exists(walkCounts, key) ? walkCounts[key] : 0) + 1;

		for (let name in p.order) {
			let one = p.sections[name];
			if (one && one['.type'] == kind)
				fn(one);
		}

		return true;
	},

	// The real one returns null on failure and the daemons test for exactly
	// that, so returning true here is what "it committed" looks like.
	//
	// Counted because a commit is the expensive one: on a router this is a
	// write to flash, and the difference between a pass that commits once and a
	// pass that commits per binding is the difference between a daemon that can
	// hold five hundred of them and a daemon that wears the flash out.
	commit: function(config) {
		commitCounts[config] = (exists(commitCounts, config) ? commitCounts[config] : 0) + 1;
		return true;
	},
	save: function(config) { return true; },
	changes: function() { return {}; }
};

/** How many cursors were opened since the counters were last reset. */
export function opened() {
	return opens;
};

/** How many times one package was committed. */
export function commits(config) {
	return exists(commitCounts, config) ? commitCounts[config] : 0;
};

/**
 * How many times one package's sections of a type were walked.
 *
 * The reader that re-parses `/etc/config/network` on every tick and the one
 * that reads it when the file changes are the same code from the outside, and
 * this is the only thing that tells them apart.
 */
export function foreachCount(config, kind) {
	let key = config + '|' + kind;
	return exists(walkCounts, key) ? walkCounts[key] : 0;
};

export function resetCounters() {
	opens = 0;
	commitCounts = {};
	walkCounts = {};
};

export function cursor(config_dir, save_dir) {
	opens++;
	return handle;
};

export function error() { return null; };
