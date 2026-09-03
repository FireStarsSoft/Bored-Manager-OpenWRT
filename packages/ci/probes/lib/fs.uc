// A working fs, in memory, for the probes only.
//
// Same reasoning as the uci beside it: the stub in ../../stubs returns null
// for everything, which is right for a syntax check and useless for a probe
// that wants the daemon to read a carrier MAC out of /sys/class/net or
// consume a payload file. This one stores what it is told and hands it back,
// and is put on the search path only by the probe runner.
//
// The export list matches stubs/fs.uc name for name, because this file wins
// the search for *every* module a probe loads - a name missing here would
// break an import that the stub satisfies.

let files = {};

// When each file was last written, on a clock that only moves when something
// writes. A daemon that re-reads a configuration file only when its mtime has
// changed cannot be told apart from one that re-reads it every pass unless the
// mtime is a fact a probe can control.
let mtimes = {};
let tick = 1000000;

// What the code under test asked for, rather than what it got back.
let readCounts = {};
let writeCount = 0;

function touch(path) {
	tick = tick + 1;
	mtimes[path] = tick;
}

/** Probe setup: put a file where the daemon will look for it. */
export function seed(path, content) {
	files[path] = content;
	touch(path);
};

export function wipe() {
	files = {};
	mtimes = {};
	readCounts = {};
	writeCount = 0;
};

export function readfile(path, limit) {
	readCounts[path] = (exists(readCounts, path) ? readCounts[path] : 0) + 1;
	return exists(files, path) ? files[path] : null;
};

/**
 * How many times one path was read since the counters were last reset.
 *
 * The same reasoning as the uci counters next door: a report that reads
 * /proc/meminfo is correct, and a daemon pass that reads it five hundred times
 * a minute is correct too, and nothing but a counter tells the two apart.
 */
export function reads(path) {
	return exists(readCounts, path) ? readCounts[path] : 0;
};

/** How many writes have happened at all - a read-only path must make none. */
export function writes() {
	return writeCount;
};

export function resetCounters() {
	readCounts = {};
	writeCount = 0;
};

export function writefile(path, data, limit) {
	writeCount++;
	files[path] = data;
	touch(path);
	return length(data);
};

export function unlink(path) {
	if (!exists(files, path))
		return false;

	delete files[path];
	return true;
};

/** One level of names under a directory, or null - the shape lsdir has. */
export function lsdir(path, pattern) {
	let prefix = path;
	if (substr(prefix, -1) != '/')
		prefix = prefix + '/';

	let out = [];
	for (let name in files) {
		if (length(name) <= length(prefix) || substr(name, 0, length(prefix)) != prefix)
			continue;

		let tail = substr(name, length(prefix));
		let slash = index(tail, '/');
		let entry = slash >= 0 ? substr(tail, 0, slash) : tail;

		if (!(entry in out))
			push(out, entry);
	}

	return length(out) ? sort(out) : null;
};

export function mkdir(path, mode) { return true; };
export function rmdir(path) { return true; };
export function rename(from, to) { return null; };
/** Enough of a stat for the readers here: when it changed, and how big it is. */
export function stat(path) {
	if (!exists(files, path))
		return null;

	return {
		type: 'file',
		size: length(files[path]),
		mtime: mtimes[path],
		ctime: mtimes[path]
	};
};
export function lstat(path) { return null; };
export function access(path, mode) { return exists(files, path); };
export function chmod(path, mode) { return true; };
export function realpath(path) { return path; };
export function readlink(path) { return null; };
export function symlink(target, path) { return null; };
export function basename(path) { return null; };
export function dirname(path) { return null; };
export function glob(...patterns) { return null; };
export function open(path, mode, perm) { return null; };
export function fdopen(fd, mode) { return null; };
export function opendir(path) { return null; };
export function mkstemp(template) { return null; };
export function popen(command, mode) { return null; };
export function pipe() { return null; };
export function error() { return null; };
