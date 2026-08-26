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

/** Probe setup: put a file where the daemon will look for it. */
export function seed(path, content) {
	files[path] = content;
};

export function wipe() {
	files = {};
};

export function readfile(path, limit) {
	return exists(files, path) ? files[path] : null;
};

export function writefile(path, data, limit) {
	files[path] = data;
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
export function stat(path) { return null; };
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
