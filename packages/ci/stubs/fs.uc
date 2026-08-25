// Stub of ucode-mod-fs for the compile-time syntax check. See ../README.md:
// these exist so `import { readfile } from 'fs'` resolves on a runner that has
// no OpenWrt modules. Nothing here is ever executed.

export function readfile(path, limit) { return null; };
export function writefile(path, data, limit) { return null; };
export function lsdir(path, pattern) { return null; };
export function mkdir(path, mode) { return null; };
export function rmdir(path) { return null; };
export function unlink(path) { return null; };
export function rename(from, to) { return null; };
export function stat(path) { return null; };
export function lstat(path) { return null; };
export function access(path, mode) { return null; };
export function chmod(path, mode) { return null; };
export function realpath(path) { return null; };
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
