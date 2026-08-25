// Stub of ucode-mod-ubus for the compile-time syntax check. See ../README.md.

export function connect(socket, timeout) { return null; };
export function open_channel(fd, cb, disconnect_cb, timeout) { return null; };
export function guard(handler) { return null; };
export function error(numeric) { return null; };

export const STATUS_OK = 0;
export const STATUS_INVALID_COMMAND = 1;
export const STATUS_INVALID_ARGUMENT = 2;
export const STATUS_METHOD_NOT_FOUND = 3;
export const STATUS_NOT_FOUND = 4;
export const STATUS_NO_DATA = 5;
export const STATUS_PERMISSION_DENIED = 6;
export const STATUS_TIMEOUT = 7;
export const STATUS_NOT_SUPPORTED = 8;
export const STATUS_UNKNOWN_ERROR = 9;
export const STATUS_CONNECTION_FAILED = 10;
