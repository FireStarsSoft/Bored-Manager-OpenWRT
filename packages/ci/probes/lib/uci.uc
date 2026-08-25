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
// that type, with four sets an option, and `foreach` walks sections of one type
// in file order.

let store = {};

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

		if (option == null)
			return one;

		return (option in one) ? one[option] : null;
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

		for (let name in p.order) {
			let one = p.sections[name];
			if (one && one['.type'] == kind)
				fn(one);
		}

		return true;
	},

	// The real one returns null on failure and the daemons test for exactly
	// that, so returning true here is what "it committed" looks like.
	commit: function(config) { return true; },
	save: function(config) { return true; },
	changes: function() { return {}; }
};

export function cursor(config_dir, save_dir) { return handle; };
export function error() { return null; };
