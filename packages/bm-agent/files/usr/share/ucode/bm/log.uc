// One line, one prefix, one destination.
//
// Everything goes to stderr, which procd hands to syslog for a service and
// which is simply the terminal for `bmctl`. That is deliberately not the `log`
// ucode module: it would be a fourth dependency for something the router
// already does, and it would split the agent's output between syslog and the
// console depending on how it was started - so `logread` would show half of a
// story and the shell the other half.
//
// The prefix is always `bm-agent:` so that `logread -e bm-agent` is the whole
// filter anybody needs.

const PREFIX = 'bm-agent: ';

function emit(level, message) {
	warn(PREFIX + level + ' ' + message + '\n');
}

export function notice(message) {
	emit('notice', message);
};

export function err(message) {
	emit('error', message);
};

// For a failure that is expected often enough to be noise at `notice` but is
// still worth having when somebody goes looking - a config file that is not
// there yet, a feature descriptor that will not parse.
export function debug(message) {
	if (getenv('BM_DEBUG'))
		emit('debug', message);
};
