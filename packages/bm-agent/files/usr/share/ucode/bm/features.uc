// Which Bored Manager packages are on this router, read off the disk.
//
// The agent deliberately does not know the names of the packages that build on
// it. Each one drops a descriptor into /usr/share/bm/features/ and takes it
// away again in its own prerm, so "what can this router do" is a directory
// listing rather than a table the agent has to be updated to extend. Adding
// bm-wanbind later is then a new package and no change here at all.
//
// It is also read on every call rather than cached. A feature file appears the
// moment `apk add` unpacks it, and an agent holding a list from its own start-up
// would report a package the router gained five seconds ago as absent - which
// is precisely the moment the module asks.

import { lsdir, readfile } from 'fs';

import { debug } from 'bm.log';

const DIR = '/usr/share/bm/features';

// A descriptor is:
//   { "name": "bm-wanbind", "version": "1.3.0", "ubus": "bm.wanbind",
//     "provides": ["binding"] }
//
// Anything that will not parse, or that does not at least name itself, is
// skipped and logged rather than allowed to abort the listing: one malformed
// file left behind by a half-finished install must not make the agent look
// like it has nothing at all.
function read(name) {
	let text = readfile(DIR + '/' + name);
	if (type(text) != 'string')
		return null;

	let entry;
	try {
		entry = json(text);
	}
	catch (e) {
		debug('ignoring ' + name + ': not valid JSON');
		return null;
	}

	if (type(entry) != 'object' || type(entry.name) != 'string') {
		debug('ignoring ' + name + ': no name');
		return null;
	}

	return entry;
}

export function list() {
	let names = lsdir(DIR);
	if (type(names) != 'array')
		return [];

	let out = [];
	for (let name in names) {
		if (!match(name, /\.json$/))
			continue;

		let entry = read(name);
		if (entry)
			push(out, entry);
	}

	return sort(out, (a, b) => (a.name < b.name) ? -1 : ((a.name > b.name) ? 1 : 0));
};

// The flat list of capability names every installed feature claims, which is
// what the module actually branches on. `provides` rather than the package name
// so that a capability can move between packages later without the module
// having to learn the new arrangement.
export function provides() {
	let out = [];

	for (let entry in list()) {
		if (type(entry.provides) != 'array')
			continue;

		for (let name in entry.provides) {
			if (type(name) == 'string' && index(out, name) < 0)
				push(out, name);
		}
	}

	return sort(out);
};
