// The service. It publishes one ubus object and then does nothing until asked.
//
// Started as `ucode -R -S /usr/share/bm/agentd.uc` by /etc/init.d/bm-agent, not
// through a shebang: the two flags say what this file is - raw script, strict
// mode - rather than depending on which default the router's ucode was built
// with. There is no polling loop and no timer here; the agent costs nothing
// while nobody is talking to it, which is the whole point of it living on a
// router that may also be dialing five thousand PPPoE sessions.

import { connect } from 'ubus';
import { done, init, run } from 'uloop';

import { methods } from 'bm.agent';
import { err, notice } from 'bm.log';
import { compatibility } from 'bm.meta';
import { RELEASE } from 'bm.version';

// Before anything else, and before ubus. Somebody has installed an older
// release over a newer one - by hand, by a rollback, by restoring a snapshot -
// and the data on disk is written in a shape this build does not know. Running
// anyway means reading fields that moved and writing fields that no longer mean
// what this code thinks they do, which is a far worse outcome than a service
// that will not start and says exactly why.
//
// exit(0), not 1: this is a correct refusal rather than a crash. It is not what
// stops the restarting, though - procd does not look at the exit status at all,
// and its retry limit here is deliberately unlimited. The init script runs
// `bmctl schema` before it registers an instance, so on a router in this state
// there is nothing to respawn; this stays as the second line of defence, for
// the case where the daemon is started by hand.
let compat = compatibility();

if (!compat.ok) {
	err(compat.reason);
	exit(0);
}

// Before the connection, because publishing an object registers it against the
// loop that will serve it. A connection made first has nothing to attach to.
init();

let bus = connect();

if (!bus) {
	err('cannot reach ubus - is ubusd running?');
	done();
	exit(1);
}

if (!bus.publish('bm.agent', methods)) {
	// Almost always a second copy already holding the name. procd will restart
	// this one in five seconds, which is the right answer if the other copy is
	// on its way out and the wrong-but-harmless one if it is not.
	let reason = bus.error();
	err('cannot publish bm.agent: ' + (reason ? reason : 'unknown error'));
	done();
	exit(1);
}

notice('published bm.agent, release ' + RELEASE);

run();
done();
