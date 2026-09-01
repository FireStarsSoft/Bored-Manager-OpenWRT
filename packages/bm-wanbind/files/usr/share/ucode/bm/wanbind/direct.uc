// One address, one port, and the pass that keeps that true with nothing
// attached.
//
// An instance hands every client on a LAN whichever WAN happens to be free. A
// one-to-one binding is the other thing people buy a multi-WAN router for: this
// address leaves by that port, always, because a person said so. The module
// used to do the whole of it over SSH - classify the interfaces, write the
// firewall forwarding, write the `ip rule` - and a binding therefore lasted
// exactly as long as somebody kept the app open. It is the router's now. The
// sections live in /etc/config/bm_wanbind, this file reconciles them on boot,
// on the daemon's timer and on a lease event, and the module only adds, removes
// and reads them.
//
// What a binding is, on the wire, is three things:
//
//   option ip4table   on the WAN's network section, so that WAN's routes land
//                     in a table of its own rather than in main
//   a forwarding      from the zone of the LAN the address is on to the WAN's
//                     zone, so fw4 lets the traffic through
//   an ip rule        `from <address>/32 lookup <that table>`, at the priority
//                     the binding is stamped with
//
// The third is what every pass writes. The first two are written once, by
// `prepare()`, and re-checked on every pass so that a forwarding somebody
// deleted by hand comes back.
//
// Three things here are counter-intuitive, and each of them was a bug once:
//
//   * A rule whose table holds no matching route does not fail. The kernel's
//     fib-rule walk carries on to the next rule and out of the main table -
//     which is the router's default connection, the very thing a binding is an
//     exception to. So `hold` is a re-point at a table holding `unreachable
//     default`, `fallback` is a re-point at main, and neither of them is
//     "remove the rule". Removing it on a LAN some instance owns hands the
//     address straight to that instance's fail-closed catch-all, which takes
//     offline the device the option was chosen to keep online.
//   * `ip rule add` stacks rather than replaces. Every add here is preceded by
//     a delete of what is at that priority, and whole priority groups are
//     compared rather than single rules, because two rules at one number is a
//     state the kernel allows and nothing here wants.
//   * A MAC target keeps its rule at the last address it was seen at for a
//     release grace after the lease disappears, so a laptop that sleeps for
//     thirty seconds does not lose and regain its WAN.
//
// The classifier next door decides which LAN an address is on and whether the
// interface a binding names as its WAN is really one of the router's own LANs.
// That is what it is for: the fault that produced it was a LAN being called an
// uplink, and the mirror of that fault - an address bound to a WAN that is
// actually the LAN it already sits on - would send the traffic back into the
// network it came from while every surface read `bound`.
//
// Nothing here is written to disk. Everything a pass needs is either in
// /etc/config/bm_wanbind or on the router in the rules themselves, and the one
// thing that is neither - the last address a MAC target answered to - is RAM on
// purpose: it is a fact about the network at this instant rather than about the
// binding, so a daemon that restarted should go and look again instead of
// writing a rule for an address a device left hours ago.

import { cursor } from 'uci';

import { debug, err, notice } from 'bm.log';

import * as cfg from 'bm.wanbind.config';
import * as layout from 'bm.wanbind.layout';
import * as leases from 'bm.wanbind.leases';
import * as netlink from 'bm.wanbind.netlink';
import * as rules from 'bm.wanbind.rules';
import * as wans from 'bm.wanbind.wans';

/**
 * The kernel's main table, written as its number and never as the word `main`.
 *
 * `lookup main` resolves through /etc/iproute2/rt_tables, which is a file the
 * administrator owns and which a build carrying ip-tiny may not have at all.
 * 254 is the kernel's own constant and needs nothing on disk to mean what it
 * means - and over netlink, which is how every rule here is written and read
 * back, it is the only spelling there is. That last part is a real difference
 * from the module: `ip -4 rule show` prints table 254 as `main`, so the module
 * cannot read its own fallback rules back and has to stand its memory in for
 * them. Here a fallback rule reads back like any other.
 */
const MAIN_TABLE = 254;

/**
 * How long a WAN has to have been up before an address is aimed at it.
 *
 * The same five seconds an instance defaults to, and for the same reason: a
 * session that came up two seconds ago has an address and a route and still
 * drops the first packets through it, which looks exactly like a broken binding
 * to the person using it. There is no per-binding option for this because there
 * is nothing about one address that would make the answer different.
 */
const WAN_WARN_UPTIME = 5;

/**
 * How long a MAC target keeps its rule after its lease disappears.
 *
 * Two minutes, which is the instance half's `release_grace` default. A lease
 * going away is a laptop closing its lid far more often than it is somebody
 * leaving, and a binding that dropped its rule the moment dnsmasq forgot the
 * device would take the address off its WAN several times a day for people who
 * never did anything.
 */
const RELEASE_GRACE = 120;

/**
 * How long before a failed preparation is attempted again.
 *
 * `prepare()` writes /etc/config and asks netifd or fw4 to reload, so it must
 * never become something a pass does every thirty seconds. It cannot loop on
 * success - it writes only what is missing, and what it wrote is not missing
 * next time - but a commit that fails, or a router whose /etc is read-only,
 * would otherwise retry on every tick for ever. Five minutes is long enough
 * that a broken router is quiet, and short enough that a fixed one heals itself
 * without anybody restarting anything.
 */
const PREPARE_RETRY = 300;

/**
 * The firewall sections this file owns.
 *
 * Named from the binding's own id rather than from a slot number, because on
 * the router the section name *is* the binding's identity - `config direct
 * 'desk'` is `desk` on every surface - and a second numbering scheme would only
 * be a way for the two to disagree about which forwarding belongs to which
 * binding. The prefix is what lets a sweep recognise its own work, and what
 * stops it touching a forwarding somebody wrote by hand.
 */
const FORWARD_PREFIX = 'bmd_';

/**
 * What may be pasted into a UCI section name.
 *
 * Guarded rather than trusted even though a `config direct` section name comes
 * from UCI, which has its own idea of a legal name: the value is concatenated
 * into a section name that a `uci delete` is later built from, and this is the
 * only thing between a hand-edited /etc/config and a token nobody meant.
 */
const SAFE_ID = /^[A-Za-z0-9_]{1,48}$/;

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
}

function intOr(value, fallback) {
	return type(value) == 'int' ? value : fallback;
}

function arrayOr(value) {
	return type(value) == 'array' ? value : [];
}

function objectOr(value) {
	return type(value) == 'object' ? value : {};
}

/** Milliseconds off the monotonic clock, for measuring one pass. */
function millis() {
	let now = clock(true);
	return type(now) == 'array' ? (now[0] * 1000 + now[1] / 1000000) : 0;
}

/** The firewall section one binding's forwarding lives in, or '' for an unusable id. */
export function forwardingName(id) {
	let one = text(id);
	return match(one, SAFE_ID) ? (FORWARD_PREFIX + one) : '';
};

/** The binding id behind one of our firewall sections, or ''. */
function forwardingId(name) {
	let one = text(name);
	if (substr(one, 0, length(FORWARD_PREFIX)) != FORWARD_PREFIX)
		return '';

	return substr(one, length(FORWARD_PREFIX));
}

/**
 * The forwardings this file has written, by binding id.
 *
 * Read on every pass rather than remembered, for the reason everything else
 * here is read every pass: somebody deleting the section from LuCI or by hand
 * has to be something the next pass notices and puts back, and a cache would
 * make it something nothing ever notices at all.
 */
export function forwardings() {
	let out = {};

	try {
		cursor().foreach('firewall', 'forwarding', (section) => {
			let id = forwardingId(section['.name']);
			if (!length(id))
				return;

			out[id] = { src: text(section.src), dest: text(section.dest) };
		});
	}
	catch (e) {
		debug('cannot read /etc/config/firewall: ' + e);
	}

	return out;
};

// ---------------------------------------------------------------------------
// The pure pass. Given a moment, the sections, and what the router says it is
// doing, the rules that would make the two agree.
//
// No clock, no netlink, no UCI: `run()` supplies all three. That is what makes
// the probe real - every rule this file ever puts on a router is decided here,
// so a fixture that says "this WAN is down and this binding holds" can assert
// the exact priority, address and table rather than the fact that something
// happened.

/**
 * The address this binding is written for on this pass, and how long it has
 * been missing.
 *
 * An IP target is its own answer. A MAC target reads the leases, and when the
 * device is not on the network it keeps the last address it was seen at for the
 * release grace before the rule comes off.
 *
 * A lease file that could not be read is not an empty LAN, and this is where
 * that distinction has teeth: reading `null` as "the device is gone" would
 * start the grace running on every MAC binding on the router because dnsmasq
 * was restarting, and two minutes later take all of them off their WANs at
 * once. So a missing file freezes each binding exactly where it was - same
 * address, same clock - and the next pass with a readable file decides.
 */
function resolveAddress(one, current, before, now, grace) {
	if (one.targetKind == 'ip')
		return { ip: one.target.ip, missingSince: 0 };

	if (current === null) {
		return {
			ip: before ? text(before.ip) : '',
			missingSince: before ? intOr(before.missingSince, 0) : 0
		};
	}

	let lease = current[one.target.mac];
	if (lease && leases.validIp(lease.ip))
		return { ip: lease.ip, missingSince: 0 };

	let remembered = before ? text(before.ip) : '';
	if (!length(remembered))
		return { ip: '', missingSince: 0 };

	let missingSince = before ? intOr(before.missingSince, 0) : 0;
	if (missingSince == 0)
		missingSince = now;

	if (now - missingSince < grace)
		return { ip: remembered, missingSince: missingSince };

	return { ip: '', missingSince: 0 };
}

/**
 * Whether this binding's WAN can carry an address right now, and why not.
 *
 * Four ways of being unusable, asked in the order that puts the most surprising
 * one first. A WAN that is really one of the router's own LANs is the
 * interesting one: netifd reports it up, with an address and every appearance
 * of health, and a rule pointing into it would send the address back into the
 * network it is already on while every row read `bound`. The classifier is
 * asked because it is the only thing here that can tell the difference - and
 * only a *decisive* answer blocks. `unclear` means the router could not be read
 * either way, and refusing on that would break bindings on routers this file
 * has no argument with.
 *
 * The table comes from netifd rather than from the binding's stamped `table`,
 * which is the one place this half deliberately disagrees with what the section
 * says. `ip4table` in the dump is the table netifd is putting this interface's
 * routes into *now*; the number in UCI is what it will use after the next
 * reload, and a rule pointing at that one sends the address into an empty table
 * - which does not fail, it falls through to main, so the binding is silently
 * on the default connection while claiming to be bound. The stamped number is
 * still what `prepare()` writes and what the mismatch is reported against.
 */
function readWan(one, iface, verdict, warnUptime) {
	if (!iface) {
		return {
			usable: false,
			table: 0,
			reason: sprintf('%s is not an interface netifd knows about, so there is nothing here for %s to leave by. This wants the name of a section in /etc/config/network',
				one.wan, one.label)
		};
	}

	if (verdict && verdict.role == 'lan') {
		return {
			usable: false,
			table: 0,
			reason: sprintf('%s is one of this router\'s own LANs, because %s. An address bound to it would be sent into the network it is already on rather than out of the router',
				one.wan, layout.clauses(verdict.lanEvidence))
		};
	}

	let table = intOr(iface.table, 0);

	if (table < 1) {
		return {
			usable: false,
			table: 0,
			reason: sprintf('%s puts its routes in the router\'s main table rather than one of its own, so a rule pointing at table %d would find nothing there and %s would leave over the default connection anyway. Set option ip4table on %s in /etc/config/network',
				one.wan, one.table, one.label, one.wan)
		};
	}

	if (!wans.usable(iface, warnUptime)) {
		return {
			usable: false,
			table: table,
			reason: sprintf('%s is %s', one.wan, wans.state(iface, warnUptime))
		};
	}

	return { usable: true, table: table, reason: '' };
}

/**
 * The rule a state asks for, or null for the states that hold none.
 *
 * `fallback` writes a rule rather than nothing at all, and that is the whole of
 * the difference between it and a bug. "No rule falls through to main" is only
 * true on a router where nothing else matches the address, and a binding
 * instance's catch-all does - it sends it to the unreachable table, which the
 * instance never lifts it back out of, because a bound address has no lease
 * that instance would hand a WAN to. The option that promises the device stays
 * online was a total outage. A rule at the stamped priority pointing at main
 * reaches the default connection from underneath that catch-all, and is equally
 * correct on a router carrying no instance at all.
 *
 * `stranded` has no table of its own on purpose. The device is on a LAN this
 * binding has no forwarding from, so the honest answer is the one its owner
 * already chose for a WAN it cannot use: park it, or hand it to the default
 * connection. What it must never become is the absence of a rule.
 *
 * `shadowed` is the one down state that genuinely writes nothing, and it is the
 * opposite case: another binding already holds this address at a lower
 * priority, so a rule here would either be beaten by that one or - at a lower
 * number still - quietly steal the address from the binding created for it.
 *
 * A hold on a router with no table to park in returns null too, and the caller
 * freezes that priority rather than reading the null as "no rule wanted".
 * Deleting the rule that is there would be fallback wearing the name of hold,
 * which is the exact substitution this feature exists to deny.
 */
function desiredRuleFor(one, state, ip, wanTable, holdTable) {
	if (!length(ip))
		return null;

	if (state == 'bound')
		return { id: one.id, pref: one.pref, ip: ip, table: wanTable, mode: 'wan' };

	if (state == 'held' || (state == 'stranded' && one.whenDown == 'hold')) {
		if (holdTable === null)
			return null;

		return { id: one.id, pref: one.pref, ip: ip, table: holdTable, mode: 'hold' };
	}

	if (state == 'fallback' || (state == 'stranded' && one.whenDown == 'fallback'))
		return { id: one.id, pref: one.pref, ip: ip, table: MAIN_TABLE, mode: 'fallback' };

	return null;
}

/**
 * What changed, in sentences somebody can read in syslog.
 *
 * Nothing is said the first time a binding is seen. A daemon that has just
 * started would otherwise announce every binding on the router as though it had
 * just done it - and a restart happens whenever /etc/config/bm_wanbind is
 * edited, so the transitions worth reading would be buried under the ones that
 * are only the daemon waking up.
 */
function transitionEvents(one, before, entry, holdTable, now) {
	if (!before)
		return [];

	if (before.state == entry.state) {
		if (entry.state != 'bound' || !length(entry.ip) || before.ip == entry.ip)
			return [];

		return [ {
			t: now,
			kind: 'moved',
			text: sprintf('%s followed %s from %s to %s', one.name, one.label, before.ip, entry.ip)
		} ];
	}

	let parked = (holdTable === null)
		? 'has no table on this router to be parked in, so its rule was left exactly as it was'
		: sprintf('is parked on table %d and has no way out', holdTable);

	if (entry.state == 'bound') {
		return [ {
			t: now,
			kind: 'bound',
			text: sprintf('%s is bound: %s leaves through %s', one.name, entry.ip, one.wan)
		} ];
	}

	if (entry.state == 'held') {
		return [ {
			t: now,
			kind: 'held',
			text: sprintf('%s is held: %s, so %s %s', one.name, entry.reason, entry.ip, parked)
		} ];
	}

	if (entry.state == 'fallback') {
		return [ {
			t: now,
			kind: 'fallback',
			text: sprintf('%s fell back: %s, so %s is re-pointed at the main table and leaves through the router\'s default connection',
				one.name, entry.reason, entry.ip)
		} ];
	}

	if (entry.state == 'stranded') {
		return [ {
			t: now,
			kind: 'stranded',
			text: sprintf('%s has moved off %s: %s answers to %s now, and this binding has no firewall path from the LAN that address is on, so it %s until it comes back',
				one.name, one.lan, one.label, entry.ip,
				(one.whenDown == 'hold') ? parked : 'is on the router\'s default connection')
		} ];
	}

	if (entry.state == 'shadowed') {
		return [ {
			t: now,
			kind: 'shadowed',
			text: sprintf('%s is not in force: %s is already bound by %s, which holds it at a lower rule priority, so this binding writes no rule of its own',
				one.name, entry.ip, length(entry.shadowedBy) ? entry.shadowedBy : 'another one-to-one binding')
		} ];
	}

	if (entry.state == 'waiting') {
		return [ {
			t: now,
			kind: 'released',
			text: sprintf('%s has no lease for %s any more; its rule was removed', one.name, one.label)
		} ];
	}

	if (entry.state == 'refused') {
		return [ {
			t: now,
			kind: 'refused',
			text: sprintf('%s was refused and its rule removed: %s', one.name, entry.reason)
		} ];
	}

	return [ {
		t: now,
		kind: 'disabled',
		text: sprintf('%s was switched off; its rule was removed', one.name)
	} ];
}

/** Where the firewall forwarding for this binding stands. */
function forwardingState(one, lanZone, wanZone, present) {
	if (!length(one.lan))
		return 'no-lan';

	if (!length(lanZone) || !length(wanZone))
		return 'no-zone';

	let existing = present[one.id];
	if (!existing)
		return 'missing';

	if (existing.src != lanZone || existing.dest != wanZone)
		return 'wrong';

	return 'ok';
}

function ruleKey(pref, cidr, table) {
	return sprintf('%d|%s|%d', pref, cidr, table);
}

function groupByPref(entries) {
	let out = {};

	for (let one in entries) {
		let key = sprintf('%d', one.pref);
		if (!(key in out))
			out[key] = [];

		push(out[key], one);
	}

	return out;
}

/**
 * The whole decision, with nothing read and nothing written.
 *
 * `input` is:
 *   now           seconds, for the release grace and the state clock
 *   bindings      cfg.directConfigured() - refused ones included, on purpose
 *   ifaces        wans.dump() - netifd's normalised interface list
 *   view          layout.classify(...), or null when the router could not be read
 *   leases        leases.fromFile() - null means no information, not nobody
 *   rules         netlink.rules() - every IPv4 rule on the router
 *   hold          { table, reason, shared } from rules.holdTable()
 *   forwardings   forwardings() - the firewall sections this file owns
 *   memory        the previous pass's `memory`, id -> entry
 *   policy        { base, top, warnUptime, releaseGrace }
 */
export function plan(input) {
	let now = intOr(input.now, 0);
	let policy = objectOr(input.policy);
	let base = intOr(policy.base, 19000);
	let top = intOr(policy.top, base + 999);
	let warnUptime = intOr(policy.warnUptime, WAN_WARN_UPTIME);
	let grace = intOr(policy.releaseGrace, RELEASE_GRACE);

	let byIface = {};
	for (let one in arrayOr(input.ifaces))
		byIface[one.name] = one;

	let verdicts = objectOr(objectOr(input.view).byName);
	let current = (input.leases !== null && type(input.leases) == 'object') ? input.leases : null;
	let before = objectOr(input.memory);
	let hold = objectOr(input.hold);
	let holdTable = intOr(hold.table, null);
	let present = objectOr(input.forwardings);

	// Lowest priority first, because that is the order the kernel reads them in
	// and therefore the order that settles who owns a contested address. The id
	// breaks a tie, so two bindings a configuration error left at one number are
	// still ordered the same way on every pass.
	let list = [];
	for (let one in arrayOr(input.bindings))
		push(list, one);

	sort(list, (a, b) => (a.pref != b.pref)
		? (a.pref - b.pref)
		: ((a.id < b.id) ? -1 : ((a.id > b.id) ? 1 : 0)));

	let desired = [];
	let memory = {};
	let events = [];
	let rows = [];
	let stamped = {};
	let frozen = {};
	let claimedBy = {};
	let holdWanted = false;

	for (let one in list) {
		let was = before[one.id];
		let iface = byIface[one.wan];
		let verdict = verdicts[one.wan];
		let lanVerdict = length(one.lan) ? verdicts[one.lan] : null;
		let lanCidr = lanVerdict ? text(lanVerdict.cidr) : '';
		let lanZone = lanVerdict ? text(lanVerdict.zone) : '';
		let wanZone = verdict ? text(verdict.zone) : '';

		// Every priority a section names is claimed, refused sections included.
		// A section refused because its priority collides with another's is
		// exactly the one whose rule has to come off, and a claim is also how
		// this pass gets to see a rule written under a band the settings have
		// since moved away from.
		if (one.pref >= 1)
			stamped[sprintf('%d', one.pref)] = true;

		let resolved = { ip: '', missingSince: 0 };
		let wan = { usable: false, table: 0, reason: '' };
		let state = 'refused';
		let reason = text(one.reason);
		let shadowedBy = '';

		if (one.usable) {
			resolved = resolveAddress(one, current, was, now, grace);
			wan = readWan(one, iface, verdict, warnUptime);

			// A disabled binding claims no address - which is exactly what being
			// switched off says about one - and a binding with no address has
			// none to claim, so both are asked before the collision is.
			let holder = (one.enabled && length(resolved.ip)) ? claimedBy[resolved.ip] : null;

			// `stranded` is asked ahead of the WAN's own health on purpose.
			// Either answer writes the same rule, so the ordering only decides
			// which sentence syslog and the row carry - and of the two, "the
			// device has moved somewhere this binding cannot reach it" is the
			// one nobody could have guessed from the table.
			//
			// A LAN with no CIDR this pass is not an answer. It may simply be
			// missing from a short interface dump, and reading that absence as
			// "the device has moved" would strand every binding on the router
			// over one bad sample.
			let strayed = length(resolved.ip) && length(lanCidr) && !wans.contains(lanCidr, resolved.ip);

			if (!one.enabled) {
				state = 'disabled';
				reason = 'switched off in /etc/config/bm_wanbind';
			}
			else if (!length(resolved.ip)) {
				state = 'waiting';
				reason = (one.targetKind == 'mac')
					? sprintf('no lease on this router answers to %s', one.label)
					: '';
			}
			else if (holder) {
				state = 'shadowed';
				shadowedBy = holder;
				reason = sprintf('%s already follows %s at a lower rule priority', holder, resolved.ip);
			}
			else if (strayed) {
				state = 'stranded';
				reason = sprintf('%s answers to %s, which is outside %s (%s)',
					one.label, resolved.ip, one.lan, lanCidr);
			}
			else if (wan.usable) {
				state = 'bound';
				reason = '';
			}
			else {
				state = (one.whenDown == 'hold') ? 'held' : 'fallback';
				reason = wan.reason;
			}

			if (one.enabled && length(resolved.ip) && !holder)
				claimedBy[resolved.ip] = one.name;
		}

		let rule = desiredRuleFor(one, state, resolved.ip, wan.table, holdTable);

		if (rule)
			push(desired, rule);

		// A hold this router has nowhere to park. The rule already there stays
		// exactly as it is, which is why the priority is frozen out of both
		// sides of the diff below: taking it away would be the leak, and writing
		// a new one has no table to point at.
		let wantsHold = (state == 'held' || (state == 'stranded' && one.whenDown == 'hold'));
		if (wantsHold)
			holdWanted = true;

		if (wantsHold && holdTable === null && one.pref >= 1)
			frozen[sprintf('%d', one.pref)] = true;

		let entry = {
			id: one.id,
			ip: resolved.ip,
			missingSince: resolved.missingSince,
			state: state,
			since: (was && was.state == state) ? intOr(was.since, now) : now,
			reason: reason,
			shadowedBy: shadowedBy,
			pref: one.pref,
			table: rule ? rule.table : 0,
			wanTable: wan.table,
			wanUsable: wan.usable
		};

		memory[one.id] = entry;

		for (let event in transitionEvents(one, was, entry, holdTable, now))
			push(events, event);

		let forwarding = one.usable ? forwardingState(one, lanZone, wanZone, present) : '';

		push(rows, {
			id: one.id,
			name: one.name,
			enabled: one.enabled,
			usable: one.usable,
			targetKind: one.targetKind,
			label: one.label,
			wan: one.wan,
			lan: one.lan,
			lanCidr: lanCidr,
			lanZone: lanZone,
			wanZone: wanZone,
			whenDown: one.whenDown,
			pref: one.pref,
			// What the rule actually points at right now, which is not always
			// the number the section carries - see readWan.
			table: entry.table,
			stampedTable: one.table,
			wanTable: wan.table,
			state: state,
			ip: resolved.ip,
			since: entry.since,
			reason: reason,
			shadowedBy: shadowedBy,
			forwarding: forwarding,
			// The two writes `prepare()` makes, asked as questions a surface can
			// show and a pass can act on.
			needsForwarding: (one.usable && one.enabled && (forwarding == 'missing' || forwarding == 'wrong')),
			needsTable: (one.usable && one.enabled && iface != null && wan.table < 1 && one.table >= 1),
			evidence: verdict ? layout.clauses(verdict.lanEvidence) : ''
		});
	}

	// The band today's settings define, plus every priority a section is stamped
	// with. A rule outside both belongs to the instance half, to another tool or
	// to nobody, and this pass never deletes what it did not put there.
	//
	// The stamped half is what makes moving `direct_pref_base` survivable.
	// `desired` is built from each section's own number, which never moves;
	// reading the router back from the live band alone meant that after any edit
	// of that setting the two disagreed about every binding, so each emitted a
	// delete and an add on every pass for ever - and its rule was momentarily
	// absent each cycle, which for a held binding is the leak holding exists to
	// deny.
	let actual = [];
	for (let one in rules.directOwned(arrayOr(input.rules), base, top, stamped)) {
		if (frozen[sprintf('%d', one.pref)] === true)
			continue;

		push(actual, one);
	}

	let wanted = [];
	for (let one in desired) {
		if (frozen[sprintf('%d', one.pref)] === true)
			continue;

		push(wanted, { pref: one.pref, cidr: one.ip + '/32', table: one.table });
	}

	// Whole priority groups are compared rather than single rules. `ip rule add`
	// stacks rather than replaces, so a group that differs at all is emptied
	// before it is rewritten - and a group that matches exactly is left alone,
	// which is what makes a settled router write nothing at all.
	let actualByPref = groupByPref(actual);
	let wantedByPref = groupByPref(wanted);

	let prefs = [];
	for (let key in actualByPref)
		push(prefs, int(key));
	for (let key in wantedByPref) {
		if (!(key in actualByPref))
			push(prefs, int(key));
	}
	sort(prefs, (a, b) => a - b);

	let remove = [];
	let add = [];

	for (let pref in prefs) {
		let key = sprintf('%d', pref);
		let old = (key in actualByPref) ? actualByPref[key] : [];
		let fresh = (key in wantedByPref) ? wantedByPref[key] : [];

		let oldKeys = [];
		for (let one in old)
			push(oldKeys, ruleKey(one.pref, one.cidr, one.table));

		let freshKeys = [];
		for (let one in fresh)
			push(freshKeys, ruleKey(one.pref, one.cidr, one.table));

		sort(oldKeys);
		sort(freshKeys);

		if (join('\n', oldKeys) == join('\n', freshKeys))
			continue;

		for (let one in old)
			push(remove, one);

		for (let one in fresh)
			push(add, one);
	}

	return {
		desired: desired,
		remove: remove,
		add: add,
		memory: memory,
		events: events,
		rows: rows,
		stamped: stamped,
		frozen: frozen,
		holdWanted: holdWanted
	};
};

// ---------------------------------------------------------------------------
// The router half: reading it, writing it, and what is kept between passes.

/**
 * One set of bindings per router, held for the life of the process.
 *
 * Module scope rather than an object the caller passes in, unlike the instance
 * half next door. There is one `config direct` list on a router and one
 * reconciler for it, so a state object would only ever have one instance and
 * every call site would have to carry it. `service.uc` calls `run(ctx)`.
 */
let state = {
	memory: {},
	rows: [],
	hold: { table: null, reason: null, shared: false },
	preparedAt: {},
	system: null,
	ready: false,
	reason: '',
	passes: 0,
	written: 0,
	removed: 0,
	events: 0,
	lastPassAt: 0,
	lastPassMs: 0
};

/**
 * Hand in the runner for the one command here that is not a ubus call.
 *
 * `/etc/init.d/firewall reload` has no ubus equivalent, so the entry point
 * passes ucode's own `system()` and everything below it can be driven by the CI
 * probes without a single command ever running on the machine doing the
 * checking. The same arrangement bm-pppoe-pool uses, for the same reason.
 *
 * With nothing attached the firewall is never reloaded, and `prepare()` says so
 * in the sentence it returns rather than reporting a forwarding as in force
 * when fw4 has not read it.
 */
export function attachSystem(runner) {
	state.system = runner;
};

/** Start again from nothing. What `flush` leaves behind, and what a probe resets to. */
export function reset() {
	state.memory = {};
	state.rows = [];
	state.hold = { table: null, reason: null, shared: false };
	state.preparedAt = {};
	state.ready = false;
	state.reason = '';
};

function reloadFirewall() {
	if (type(state.system) != 'function')
		return false;

	let status = state.system('/etc/init.d/firewall reload', 30000);
	return (status === 0);
}

function reloadNetwork(bus) {
	if (!bus)
		return false;

	try {
		bus.call('network', 'reload', {});
		return true;
	}
	catch (e) {
		debug('network reload failed: ' + e);
		return false;
	}
}

/**
 * The LANs held bindings sit on, so the hold table can keep them reachable.
 *
 * Computed from the sections and the classifier rather than from the plan,
 * because the table has to be armed *before* the plan is applied: a rule
 * pointed at a table that does not blackhole yet is a moment of the address
 * being on the default connection, which is the thing hold denies.
 */
function holdingLans(bindings, verdicts) {
	let out = [];
	let seen = {};

	for (let one in bindings) {
		if (!one.usable || !one.enabled || one.whenDown != 'hold' || !length(one.lan))
			continue;

		let verdict = verdicts[one.lan];
		if (!verdict)
			continue;

		let cidr = text(verdict.cidr);
		let device = text(verdict.device);
		if (!length(cidr) || !length(device) || seen[cidr] === true)
			continue;

		seen[cidr] = true;
		push(out, { cidr: cidr, device: device });
	}

	return out;
}

// ---------------------------------------------------------------------------
// The two writes that are not ip rules.

/**
 * Give this binding the two things on the router a rule is no use without.
 *
 * Called by the pass when it finds either missing, and by the ubus `add` path
 * so that a binding created from the app or from LuCI works before the next
 * tick rather than after it. Both callers reach the same code, because a create
 * that prepared the router differently from a reconcile would be two routers
 * wearing one configuration.
 *
 * Nothing here overwrites a value somebody else chose. `option ip4table` is
 * written only when the WAN section has none: a different number there is an
 * administrator's decision about their own router, and the honest response is
 * to say so and let the binding be re-stamped, not to quietly take that
 * interface's routes somewhere they were not put.
 *
 * `ctx.defer` returns the reloads as flags for a caller that is preparing
 * several bindings at once. Without it they happen here.
 */
function refusePrepare(reason, changed) {
	return { ok: false, changed: changed, network: false, firewall: false, reason: reason };
}

/**
 * Everything `prepare` writes, with neither reload performed.
 *
 * Split out so that every return below hands back the same shape and the
 * reloads happen in exactly one place. A version that reloaded from inside each
 * branch reloaded netifd on some failures and not others, which is the kind of
 * difference nobody sees until a router bounces its WANs for a binding that was
 * refused anyway.
 */
function writePreparation(one, view) {
	let changed = [];
	let owedNetwork = false;

	if (type(one) != 'object' || one.usable !== true)
		return refusePrepare('this binding is not usable, so there is nothing to prepare for it', changed);

	let section = forwardingName(one.id);
	if (!length(section))
		return refusePrepare(sprintf('%s cannot be used as a firewall section name', one.id), changed);

	let verdicts = objectOr(objectOr(view).byName);
	let verdict = verdicts[one.wan];

	if (verdict && verdict.role == 'lan') {
		return refusePrepare(sprintf('%s is one of this router\'s own LANs, because %s - nothing will be written for a binding that leaves by the network it is already on',
			one.wan, layout.clauses(verdict.lanEvidence)), changed);
	}

	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		return refusePrepare('cannot open /etc/config: ' + e, changed);
	}

	if (!uci)
		return refusePrepare('cannot open /etc/config', changed);

	// --- the WAN's own routing table.
	if (uci.get('network', one.wan) == null)
		return refusePrepare(sprintf('/etc/config/network has no section called %s', one.wan), changed);

	let written = uci.get('network', one.wan, 'ip4table');
	let already = (written == null) ? '' : text('' + written);

	if (!length(already)) {
		if (!uci.set('network', one.wan, 'ip4table', sprintf('%d', one.table)) || !uci.commit('network')) {
			return refusePrepare(sprintf('could not give %s routing table %d in /etc/config/network',
				one.wan, one.table), changed);
		}

		push(changed, sprintf('%s now puts its routes in table %d', one.wan, one.table));

		// Reloaded rather than left for the next reboot. Until netifd has read
		// it the table is empty, and a rule pointing at an empty table does not
		// fail - it falls through to main, so the binding would report itself
		// bound while the address left over the default connection.
		owedNetwork = true;
	}
	else if (already != sprintf('%d', one.table)) {
		return refusePrepare(sprintf('%s already puts its routes in table %s and this binding is stamped with %d. Nothing was changed - one of the two has to move, and which is not this daemon\'s decision',
			one.wan, already, one.table), changed);
	}

	// --- the firewall forwarding.
	if (!length(one.lan)) {
		return {
			ok: true,
			changed: changed,
			network: owedNetwork,
			firewall: false,
			reason: sprintf('no lan is set on this binding, so there is no source zone to write a forwarding from. Set option lan to the interface %s sits behind',
				one.label)
		};
	}

	let lanVerdict = verdicts[one.lan];
	let lanZone = lanVerdict ? text(lanVerdict.zone) : '';
	let wanZone = verdict ? text(verdict.zone) : '';

	if (!length(lanZone) || !length(wanZone)) {
		let refusal = sprintf('%s is in %s and %s is in %s, and a forwarding needs both',
			one.lan, length(lanZone) ? ('zone ' + lanZone) : 'no firewall zone',
			one.wan, length(wanZone) ? ('zone ' + wanZone) : 'no firewall zone');

		// The table write above still happened and still has to be applied, so
		// this refusal carries the reload it owes rather than dropping it.
		return { ok: false, changed: changed, network: owedNetwork, firewall: false, reason: refusal };
	}

	let src = text(uci.get('firewall', section, 'src'));
	let dest = text(uci.get('firewall', section, 'dest'));

	if (src == lanZone && dest == wanZone)
		return { ok: true, changed: changed, network: owedNetwork, firewall: false, reason: '' };

	uci.set('firewall', section, 'forwarding');
	uci.set('firewall', section, 'src', lanZone);
	uci.set('firewall', section, 'dest', wanZone);

	if (!uci.commit('firewall')) {
		return { ok: false, changed: changed, network: owedNetwork, firewall: false,
			reason: sprintf('could not write the firewall forwarding %s -> %s', lanZone, wanZone) };
	}

	push(changed, sprintf('%s -> %s is forwarded', lanZone, wanZone));

	return { ok: true, changed: changed, network: owedNetwork, firewall: true, reason: '' };
}

export function prepare(one, view, ctx) {
	let options = objectOr(ctx);
	let out = writePreparation(one, view);

	if (options.defer === true)
		return out;

	if (out.network) {
		reloadNetwork(options.bus);
		out.network = false;
	}

	if (out.firewall) {
		out.firewall = false;

		if (!reloadFirewall()) {
			out.ok = false;
			out.reason = 'the firewall forwarding was written and fw4 was not reloaded, so it is not in force yet';
		}
	}

	return out;
};

/**
 * Take one binding's firewall forwarding off the router.
 *
 * The rule is not touched here, deliberately: a section that is still in the
 * config is still a binding, and the pass is the only thing that decides what
 * rule it should have. This is what the ubus `remove` path calls once the
 * section has gone, and what the sweep below calls for a section that went while
 * nothing was watching.
 *
 * `option ip4table` is never taken back. It is a statement about the WAN rather
 * than about the binding - other bindings and the instance half may be resting
 * on it - and an interface losing its own routing table is a router-wide event
 * that no single binding being deleted should cause.
 */
export function withdraw(id, ctx) {
	let options = objectOr(ctx);
	let section = forwardingName(id);

	if (!length(section))
		return false;

	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		debug('cannot open /etc/config: ' + e);
		return false;
	}

	if (!uci || uci.get('firewall', section) == null)
		return false;

	uci.delete('firewall', section);

	if (!uci.commit('firewall')) {
		err(sprintf('the firewall forwarding for binding %s could not be removed', id));
		return false;
	}

	if (options.defer !== true && !reloadFirewall())
		err(sprintf('the firewall forwarding for binding %s was removed and fw4 was not reloaded, so it is still in force', id));

	notice(sprintf('binding %s: its firewall forwarding was removed', id));
	return true;
};

/**
 * Every forwarding this file owns whose binding has gone.
 *
 * `keep` is the set of section ids the config still has, refused ones included:
 * a binding refused for a bad priority is still a binding somebody is about to
 * correct, and taking its firewall path away in the meantime would turn one
 * mistake into two.
 */
export function sweep(keep) {
	let kept = objectOr(keep);
	let gone = [];

	for (let id in forwardings()) {
		if (kept[id] !== true)
			push(gone, id);
	}

	let removed = 0;
	for (let id in gone) {
		if (withdraw(id, { defer: true }))
			removed++;
	}

	if (removed)
		reloadFirewall();

	return removed;
};

/**
 * One full pass: from what the router says, to what it should say.
 *
 * Runs at start, on the daemon's timer and whenever something asks for one.
 * Nothing here is allowed to act on a missing answer - a netifd dump that
 * failed, a netlink socket that would not talk - because treating no answer as
 * an empty answer would take every binding on the router off its WAN because
 * one read failed.
 */
export function run(ctx) {
	let started = millis();
	let options = objectOr(ctx);
	let now = intOr(options.now, time());

	let ifaces = wans.dump(options.bus);
	if (ifaces === null) {
		state.ready = false;
		state.reason = 'netifd did not answer, so nothing was changed';
		return { ok: false, reason: state.reason };
	}

	let present = netlink.rules();
	if (present === null) {
		state.ready = false;
		state.reason = 'the router\'s ip rules could not be read, so nothing was changed';
		return { ok: false, reason: state.reason };
	}

	// One reading of netifd, shared. `layout.read()` would dump it a second
	// time, and two dumps a few milliseconds apart are two different routers as
	// far as anything comparing them is concerned.
	let view = layout.classify(ifaces, layout.statements());
	let verdicts = objectOr(view.byName);
	let bindings = cfg.directConfigured();
	let band = cfg.directBand();

	let hold = rules.holdTable(cfg.instances(), bindings, ifaces);

	// Asked before the table is armed, so that most routers - which have no
	// binding holding anything - never write a route or read one back.
	let wantsHold = false;
	for (let one in bindings) {
		if (one.usable && one.enabled && one.whenDown == 'hold')
			wantsHold = true;
	}

	if (wantsHold && hold.table !== null && !rules.installHold(hold.table, holdingLans(bindings, verdicts))) {
		err(sprintf('the table held addresses are parked in (%d) could not be given an unreachable default, so every held binding was left exactly as it was rather than re-pointed at a table that does not hold them',
			hold.table));

		hold = {
			table: null,
			shared: hold.shared,
			reason: sprintf('table %d could not be given an unreachable default', hold.table)
		};
	}

	state.hold = hold;

	let planned = plan({
		now: now,
		bindings: bindings,
		ifaces: ifaces,
		view: view,
		leases: leases.fromFile(),
		rules: present,
		hold: hold,
		forwardings: forwardings(),
		memory: state.memory,
		policy: {
			base: band.base,
			top: band.top,
			warnUptime: WAN_WARN_UPTIME,
			releaseGrace: RELEASE_GRACE
		}
	});

	// The removes before the adds. A rule being replaced is absent for the
	// microseconds in between, which is the price of `ip rule add` stacking
	// rather than replacing; doing it the other way round would leave two rules
	// at one priority instead, and which of them the kernel honours is not
	// something to find out on somebody's router.
	let removed = 0;
	for (let one in planned.remove) {
		if (netlink.remove(one.pref, one.cidr, one.table))
			removed++;
		else
			debug(sprintf('could not remove rule pref %d from %s table %d', one.pref, one.cidr, one.table));
	}

	let written = 0;
	for (let one in planned.add) {
		if (netlink.add(one.pref, one.cidr, one.table))
			written++;
		else
			err(sprintf('the rule at priority %d (%s -> table %d) could not be written, so that address is not going where its binding says',
				one.pref, one.cidr, one.table));
	}

	for (let event in planned.events)
		notice('binding ' + event.text);

	state.memory = planned.memory;
	state.rows = planned.rows;
	state.ready = true;
	state.reason = '';
	state.passes = state.passes + 1;
	state.written = state.written + written;
	state.removed = state.removed + removed;
	state.events = state.events + length(planned.events);

	// The two UCI writes, last and rarely. Last because a forwarding is no use
	// without the rule and the rule is what somebody is waiting for; rarely
	// because each is written only when it is missing, so the pass that installs
	// one is followed by passes with nothing to do.
	let byId = {};
	for (let one in bindings)
		byId[one.id] = one;

	let prepared = 0;
	let owedNetwork = false;
	let owedFirewall = false;

	for (let row in planned.rows) {
		if (!row.needsForwarding && !row.needsTable)
			continue;

		let last = intOr(state.preparedAt[row.id], 0);
		if (last && now - last < PREPARE_RETRY)
			continue;

		state.preparedAt[row.id] = now;

		let one = byId[row.id];
		if (!one)
			continue;

		// Deferred, so that a router coming up with five bindings that all need
		// a forwarding reloads fw4 once rather than five times.
		let done = prepare(one, view, { bus: options.bus, defer: true });

		owedNetwork = owedNetwork || done.network;
		owedFirewall = owedFirewall || done.firewall;

		if (done.ok) {
			prepared++;
			delete state.preparedAt[row.id];
		}
		else {
			err(sprintf('binding %s: %s', one.id, done.reason));
		}
	}

	if (owedNetwork)
		reloadNetwork(options.bus);

	if (owedFirewall && !reloadFirewall()) {
		err('a firewall forwarding was written and fw4 was not reloaded, so it is not in force yet');
	}

	// Forwardings whose section has gone. A binding removed from the config has
	// its rule withdrawn by the diff above - nothing desires it, so it is a
	// stray in the band - but the firewall section it left behind is named after
	// a binding that no longer exists, and nothing else would ever look at it.
	let keep = {};
	for (let one in bindings)
		keep[one.id] = true;

	let swept = sweep(keep);

	state.lastPassAt = now;
	state.lastPassMs = millis() - started;

	let counts = {};
	for (let row in planned.rows)
		counts[row.state] = intOr(counts[row.state], 0) + 1;

	return {
		ok: true,
		bindings: length(planned.rows),
		bound: intOr(counts.bound, 0),
		held: intOr(counts.held, 0),
		fallback: intOr(counts.fallback, 0),
		stranded: intOr(counts.stranded, 0),
		shadowed: intOr(counts.shadowed, 0),
		waiting: intOr(counts.waiting, 0),
		disabled: intOr(counts.disabled, 0),
		refused: intOr(counts.refused, 0),
		added: written,
		removed: removed,
		prepared: prepared,
		swept: swept,
		holdTable: (hold.table === null) ? 0 : hold.table,
		holdReason: hold.reason,
		passMs: state.lastPassMs
	};
};

/**
 * One lease, handled without reading the router.
 *
 * Everything this needs is in memory from the last pass, which is the point: a
 * device that renews onto a new address has its rule moved in a millisecond
 * rather than at the next tick, and it costs the same on a router with one
 * binding and one with two hundred. What it cannot do is discover that a WAN
 * came back or that somebody deleted a rule by hand; that is what the pass is
 * for, thirty seconds later.
 *
 * Only bindings that already know where they stand are acted on. A binding the
 * last pass never reached has no WAN table and no verdict to reuse, and
 * inventing either from a lease event is how a rule ends up pointing at a table
 * chosen by nothing. `stranded` and `shadowed` are deliberately not re-asked
 * here either: both are questions about the whole router, and getting either
 * wrong writes a rule for an address that belongs to somebody else.
 */
export function lease(event, ctx) {
	let options = objectOr(ctx);
	let now = intOr(options.now, time());

	if (type(event) != 'object' || !length(text(event.mac)))
		return { ok: false, reason: 'that is not a lease event this can act on' };

	if (!state.ready)
		return { ok: false, reason: 'no pass has completed yet, so the event was noted and nothing else' };

	let handled = [];

	// The configured list, with the unusable skipped here, rather than
	// `directBindings()` - which holds exactly the same bindings but writes an
	// error line for every refused section each time it is asked. That is right
	// for the pass and for `bmwan check`, which happen on a timer and when
	// somebody asks; this runs from the DHCP hotplug hook, so one mistyped
	// binding would put that line in syslog on every lease add, renew and
	// release on the router - logging in proportion to the traffic rather than
	// to the mistake, on a box carrying thousands of sessions.
	for (let one in cfg.directConfigured()) {
		if (!one.usable)
			continue;

		if (one.targetKind != 'mac' || one.target.mac != event.mac)
			continue;

		let entry = state.memory[one.id];
		if (!entry)
			continue;

		if (event.action == 'remove') {
			// Not released. The grace is what covers a device that will be back
			// in twenty seconds, and the pass is what ends it.
			push(handled, { id: one.id, action: 'noted' });
			continue;
		}

		if (!leases.validIp(event.ip))
			continue;

		if (entry.ip == event.ip) {
			push(handled, { id: one.id, action: 'unchanged' });
			continue;
		}

		let settled = entry.state;
		if (settled != 'bound' && settled != 'held' && settled != 'fallback') {
			entry.ip = event.ip;
			entry.missingSince = 0;
			push(handled, { id: one.id, action: 'noted' });
			continue;
		}

		let rule = desiredRuleFor(one, settled, event.ip, entry.wanTable, state.hold.table);
		if (!rule) {
			entry.ip = event.ip;
			entry.missingSince = 0;
			push(handled, { id: one.id, action: 'noted' });
			continue;
		}

		// The new rule first, then the old one away, so at no moment does the
		// address have none. Both are at the same priority, which is the one
		// place in this file where two rules briefly share a number - and the
		// older of the two points at the same table, so whichever the kernel
		// honours in between sends the traffic to the same place.
		if (!netlink.add(rule.pref, rule.ip + '/32', rule.table)) {
			err(sprintf('binding %s: %s moved to %s and the new rule could not be written',
				one.id, one.label, event.ip));
			continue;
		}

		if (length(entry.ip))
			netlink.remove(entry.pref, entry.ip + '/32', entry.table);

		notice(sprintf('binding %s: %s moved from %s to %s, still on %s',
			one.id, one.label, length(entry.ip) ? entry.ip : 'nowhere', event.ip, one.wan));

		entry.ip = event.ip;
		entry.missingSince = 0;
		entry.table = rule.table;
		push(handled, { id: one.id, action: 'readdressed' });
	}

	state.events = state.events + length(handled);

	if (!length(handled))
		return { ok: true, action: 'ignored' };

	return { ok: true, handled: handled, at: now };
};

// ---------------------------------------------------------------------------
// What the surfaces read.

/** Every binding and what it is doing, as of the last pass. */
export function bindings() {
	return state.rows;
};

/** One binding's row, or null. */
export function binding(id) {
	for (let row in state.rows) {
		if (row.id == id)
			return row;
	}

	return null;
};

/** The pass itself: whether it is running, what it found, and what it cost. */
export function summary() {
	let counts = {};
	for (let row in state.rows)
		counts[row.state] = intOr(counts[row.state], 0) + 1;

	return {
		ready: state.ready,
		reason: state.reason,
		bindings: length(state.rows),
		bound: intOr(counts.bound, 0),
		held: intOr(counts.held, 0),
		fallback: intOr(counts.fallback, 0),
		stranded: intOr(counts.stranded, 0),
		shadowed: intOr(counts.shadowed, 0),
		waiting: intOr(counts.waiting, 0),
		disabled: intOr(counts.disabled, 0),
		refused: intOr(counts.refused, 0),
		holdTable: (state.hold.table === null) ? 0 : state.hold.table,
		holdReason: state.hold.reason,
		holdShared: (state.hold.shared === true),
		passes: state.passes,
		written: state.written,
		removed: state.removed,
		events: state.events,
		lastPassAt: state.lastPassAt,
		lastPassMs: state.lastPassMs
	};
};

/**
 * Take every one-to-one binding off the router.
 *
 * What `bmwan flush` reaches, and through it what `prerm` reaches. Both halves
 * of a binding go: the rules, and the firewall forwardings named after them.
 * `option ip4table` stays, for the reason `withdraw` gives.
 *
 * The band is read from the configuration rather than from the last pass, so
 * this works on a daemon that has never completed one - which is exactly the
 * state a router is in while a package is being removed from it.
 *
 * The hold table's `unreachable default` is only taken away when this file put
 * it in a table of its own. When it is an instance's catch-all table, that
 * route is the instance's and removing it would take every unassigned client on
 * that LAN out onto the router's own WAN - which is the one thing the instance
 * half exists to prevent.
 */
export function flush() {
	let present = netlink.rules();
	if (present === null)
		return { ok: false, reason: 'the router\'s ip rules could not be read, so nothing was removed' };

	let band = cfg.directBand();
	let stamped = {};

	for (let one in cfg.directConfigured()) {
		if (one.pref >= 1)
			stamped[sprintf('%d', one.pref)] = true;
	}

	let removed = rules.directFlush(present, band.base, band.top, stamped);
	let swept = sweep({});

	if (state.hold.table !== null && state.hold.shared !== true)
		rules.removeHold(state.hold.table);

	reset();

	notice(sprintf('removed %d one-to-one binding rule(s) and %d firewall forwarding(s)', removed, swept));
	return { ok: true, removed: removed, swept: swept };
};
