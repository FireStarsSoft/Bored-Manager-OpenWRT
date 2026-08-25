// Stub of ucode-mod-uloop for the compile-time syntax check. See ../README.md.

export function init() { return null; };
export function run(timeout) { return null; };
export function end() { return null; };
export function done() { return null; };
export function timer(timeout, cb) { return null; };
export function interval(interval, cb) { return null; };
export function handle(fd, cb, flags) { return null; };
export function process(executable, args, env, cb) { return null; };
export function task(fn, output_cb, input_cb) { return null; };
export function signal(signal, cb) { return null; };

export const ULOOP_READ = 1;
export const ULOOP_WRITE = 2;
export const ULOOP_EDGE_TRIGGER = 4;
export const ULOOP_BLOCKING = 8;
