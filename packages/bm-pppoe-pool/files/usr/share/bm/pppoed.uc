// The service. Publishes one ubus object, starts two loops, and waits.
//
// Started as `ucode -R -S /usr/share/bm/pppoed.uc` by /etc/init.d/bm-pppoe, not
// through a shebang: the two flags say what this file is - raw script, strict
// mode - rather than depending on which default the router's ucode was built
// with.
//
// The order below is the order it has to be. Configuration first. ubus and
// uloop next, because publishing an object registers it against the loop that
// will serve it, and because the netifd listener needs the same connection. The
// first pass last, since it asks netifd what exists.

import { connect } from 'ubus';
import { done, init, run } from 'uloop';

import { err, notice } from 'bm.log';
import { compatibility } from 'bm.meta';

import * as service from 'bm.pppoe.service';

// bm-agent's schema gate, asked here too. Installing an older build over a
// newer one is easy - a rollback, a restored snapshot - and running against
// data written in a shape this build does not know is a far worse outcome than
// a service that will not start and says exactly why.
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

if (!bus.publish('bm.pppoe', service.methods)) {
	// Almost always a second copy already holding the name. procd will restart
	// this one in five seconds, which is the right answer if the other copy is
	// on its way out and the wrong-but-harmless one if it is not.
	let reason = bus.error();
	err('cannot publish bm.pppoe: ' + (reason ? reason : 'unknown error'));
	done();
	exit(1);
}

notice('published bm.pppoe, release ' + service.RELEASE);

service.start();

run();
done();
