// The service. Publishes one ubus object, does one pass, and then waits.
//
// Started as `ucode -R -S /usr/share/bm/wanbindd.uc` by /etc/init.d/bm-wanbind,
// not through a shebang: the two flags say what this file is - raw script,
// strict mode - rather than depending on which default the router's ucode was
// built with.
//
// The order below is the order it has to be. Configuration first, so a router
// with nothing configured says so and stops rather than publishing an object
// that answers questions about nothing. ubus and uloop next, because publishing
// an object registers it against the loop that will serve it. The first
// reconcile pass last, because it needs the ubus connection to ask netifd what
// interfaces exist.

import { connect } from 'ubus';
import { done, init, run } from 'uloop';

import { err, notice } from 'bm.log';
import { compatibility } from 'bm.meta';

import * as service from 'bm.wanbind.service';

// bm-agent's schema gate, asked here too. This package writes into the same
// /etc/bm/state/ and an older build reading a newer file would misread a client
// list - which on this package means ip rules pointing at the wrong lines.
//
// exit(0), not 1: a correct refusal rather than a crash. It is not what stops
// the restarting, though - procd does not look at the exit status at all, and
// its retry limit here is deliberately unlimited. The init script runs `bmctl
// schema` before it registers an instance, so on a router in this state there
// is nothing to respawn; this stays as the second line of defence, for a daemon
// started by hand.
let compat = compatibility();

if (!compat.ok) {
	err(compat.reason);
	exit(0);
}

service.load();

init();

let bus = connect();

if (!bus) {
	err('cannot reach ubus - is ubusd running?');
	done();
	exit(1);
}

service.attach(bus);

// The firewall reload is an init script, not a ubus call. The runner is
// injected so that everything below the entry point can be driven by the CI
// probes without a single command ever running on the machine checking it.
service.attachSystem((command, timeout) => system(command, timeout));

if (!bus.publish('bm.wanbind', service.methods)) {
	// Almost always a second copy already holding the name. procd will restart
	// this one in five seconds, which is the right answer if the other copy is
	// on its way out and the wrong-but-harmless one if it is not.
	let reason = bus.error();
	err('cannot publish bm.wanbind: ' + (reason ? reason : 'unknown error'));
	done();
	exit(1);
}

notice('published bm.wanbind, release ' + service.RELEASE);

service.start();

run();
done();
