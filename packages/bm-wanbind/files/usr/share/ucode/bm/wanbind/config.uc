// /etc/config/bm_wanbind, read once per pass and validated on the way in.
//
// Everything downstream - the pool, the engine, the rules - is given a record
// out of this file and never touches UCI itself. That is what makes the engine
// testable and, more to the point, what makes a broken instance one refusal
// with a name in it rather than a daemon that half works.
//
// An instance whose numbers do not make sense is dropped and logged. It is not
// corrected: the priority range and the catch-all table are what the rules
// already on the router were written against, so quietly choosing different
// ones would make the next pass fail to recognise its own work and write a
// second copy of every rule.
//
// Two section types live here. `config instance` is a whole LAN sharing a pool
// of WANs, and `config direct` is one address nailed to one port by hand. The
// second half of this file is the second of those.

import { cursor } from 'uci';

import { debug, err } from 'bm.log';

// A MAC and an address have exactly one spelling in this package, and it is the
// one /tmp/dhcp.leases carries: a MAC target is resolved by matching it against
// a lease as a string, so the reader that accepts it and the reader that
// resolves it have to agree letter for letter. Two spellings would mean a
// binding that is accepted here, never resolves, and never says why.
import { normalizeMac, validIp } from 'bm.wanbind.leases';

// The range arithmetic lives with the other address arithmetic rather than
// here, because the catch-all writer needs the same decomposition and two
// copies of it would be two chances to disagree about which addresses an
// instance owns.
import { ipToInt, rangeCidrs } from 'bm.wanbind.wans';

const PACKAGE = 'bm_wanbind';

// Below this a full pass on a large LAN would overlap the previous one.
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 3600;

// The room every instance needs between its client rules and its catch-all,
// which is also the largest number of clients it can seat. A range narrower
// than this is a configuration that would run out during an ordinary evening.
const MIN_PREF_SPAN = 64;

// How many clients one WAN may be asked to carry. Not a kernel limit - the
// kernel does not care - but a number above this in a config file is a typo
// rather than an intention, and an instance that seated four thousand devices
// on one line because somebody meant 8 is worth refusing.
const MAX_CLIENTS_PER_WAN = 4096;

// Linux reserves 253, 254 and 255 (default, main, local). The catch-all table
// deliberately may be 253: OpenWrt leaves `default` empty and a router that has
// nothing in it is the natural home for `unreachable default`.
const MAX_TABLE = 65535;

// UCI has no booleans, and every one of these means the same thing.
function flag(value, fallback) {
	if (type(value) != 'string' || !length(value))
		return fallback;

	if (value in [ '0', 'no', 'off', 'false', 'disabled' ])
		return false;

	return true;
}

function number(value, fallback) {
	if (type(value) == 'int')
		return value;

	if (type(value) != 'string' || !match(trim(value), /^[0-9]+$/))
		return fallback;

	return int(trim(value));
}

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
}

/**
 * The one global section. Absent means the shipped defaults.
 *
 * `option direct_pref_base` sits on this same section and is deliberately not
 * read here. Answering what it is worth is not a question about the global
 * section at all - it is a question about where the instances have put their
 * own priority ranges - so `directBand()` at the foot of this file owns it.
 */
function readMain(uci) {
	// `raw` is the seven create-time defaults exactly as the section spells
	// them, or null where it does not. They are read here rather than where
	// they are used because the alternative is a second cursor over the same
	// file to answer the same question - which is what `settings_get` did, on
	// the call every surface makes first.
	//
	// Not interpreted here either: what a missing one falls back to is a
	// decision about creating an instance, and this file's business is the
	// file. `service.settingsRead` owns the defaults and applies them.
	let out = {
		enabled: true,
		interval: 30,
		reason: null,
		raw: {
			rule_pref_base: null,
			catch_all_pref_base: null,
			catch_all_table: null,
			wan_table_base: null,
			wan_warn_uptime: null,
			wan_error_grace: null,
			release_grace: null
		}
	};

	if (uci == null)
		return out;

	try {
		out.enabled = flag(uci.get(PACKAGE, 'main', 'enabled'), true);

		for (let key in keys(out.raw))
			out.raw[key] = uci.get(PACKAGE, 'main', key);

		let interval = number(uci.get(PACKAGE, 'main', 'interval'), 30);
		if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) {
			// Carried out rather than logged from here. This is read once per
			// snapshot and a snapshot is taken by every ubus call, so a router
			// with one bad number would write one syslog line per question
			// somebody asked it. `snapshot({ log: true })` - which only the
			// reconcile pass sets - is where it becomes a line.
			out.reason = sprintf('interval %d is outside %d-%d; using 30', interval, MIN_INTERVAL, MAX_INTERVAL);
			interval = 30;
		}
		out.interval = interval;
	}
	catch (e) {
		// No config file at all. The defaults above are the shipped ones, so a
		// router that lost /etc/config/bm_wanbind still answers questions and
		// still reconciles - it simply has no instances to reconcile.
		debug('cannot read ' + PACKAGE + ': ' + e);
	}

	return out;
}

/**
 * The addresses one instance is willing to bind, as a range of numbers.
 *
 * A whole-LAN instance has no range of its own - it takes whatever its LAN
 * holds - and is reported as the whole address space here, which is exactly
 * what makes the overlap test below read the right way: a whole-LAN instance
 * overlaps every other instance on the same LAN, and that is the truth about
 * it.
 */
function scopeBounds(one) {
	if (!length(one.rangeFrom) || !length(one.rangeTo))
		return { low: 0, high: 4294967295, whole: true };

	let low = ipToInt(one.rangeFrom);
	let high = ipToInt(one.rangeTo);

	if (low === null || high === null || low > high)
		return { low: 0, high: 4294967295, whole: true };

	return { low: low, high: high, whole: false };
}

/**
 * Why this section cannot be used, or null.
 *
 * Written as one function returning a sentence because that sentence is what
 * reaches syslog, `bmwan status` and the app. "instance home: rule_pref_base
 * 30000 is not below catch_all_pref 30000" is something somebody can act on;
 * "invalid configuration" is not.
 */
function refuse(one) {
	if (!length(one.lan))
		return 'no lan is set, so there is no subnet to bind clients from';

	if (!length(one.carrier))
		return 'no carrier is set, so there are no WANs to hand out';

	if (one.rulePrefBase < 1 || one.rulePrefBase > 0x7fffffff)
		return sprintf('rule_pref_base %d is not an ip rule priority', one.rulePrefBase);

	if (one.catchAllPref <= one.rulePrefBase) {
		return sprintf('rule_pref_base %d is not below catch_all_pref %d, so there is no range to write client rules in',
			one.rulePrefBase, one.catchAllPref);
	}

	if (one.catchAllPref - one.rulePrefBase < MIN_PREF_SPAN) {
		return sprintf('only %d ip rule priorities between rule_pref_base and catch_all_pref; at least %d are needed',
			one.catchAllPref - one.rulePrefBase, MIN_PREF_SPAN);
	}

	if (one.catchAllTable < 1 || one.catchAllTable > MAX_TABLE)
		return sprintf('catch_all_table %d is not a routing table number', one.catchAllTable);

	if (one.catchAllTable == 254 || one.catchAllTable == 255) {
		return sprintf('catch_all_table %d is the router\'s own main or local table; putting an unreachable default in it would take the router off the network',
			one.catchAllTable);
	}

	if (one.clientsPerWan < 0 || one.clientsPerWan > MAX_CLIENTS_PER_WAN) {
		return sprintf('clients_per_wan %d is not a number of clients; 1 gives each WAN to one device, a larger number is how many may share one, and 0 means no limit',
			one.clientsPerWan);
	}

	// One end without the other is the one range mistake that would otherwise
	// pass silently: the section reads as a whole-LAN instance, and the operator
	// who wrote a start address watches it bind the addresses they meant to
	// leave alone.
	if (length(one.rangeFrom) && !length(one.rangeTo))
		return 'range_from is set without range_to, so there is no range - set both, or neither for the whole LAN';

	if (length(one.rangeTo) && !length(one.rangeFrom))
		return 'range_to is set without range_from, so there is no range - set both, or neither for the whole LAN';

	if (length(one.rangeFrom)) {
		if (ipToInt(one.rangeFrom) === null)
			return sprintf('range_from %s is not an IPv4 address', one.rangeFrom);

		if (ipToInt(one.rangeTo) === null)
			return sprintf('range_to %s is not an IPv4 address', one.rangeTo);

		if (ipToInt(one.rangeFrom) > ipToInt(one.rangeTo)) {
			return sprintf('range_from %s is above range_to %s; a range runs upwards',
				one.rangeFrom, one.rangeTo);
		}

		// The blocks are what the catch-all is written as, so a range that
		// cannot be expressed as blocks is a range this daemon cannot fence.
		// Refusing beats writing a fence with a hole in it.
		if (!length(rangeCidrs(one.rangeFrom, one.rangeTo))) {
			return sprintf('range %s-%s cannot be written as a set of address blocks, so there is no catch-all that would cover exactly it',
				one.rangeFrom, one.rangeTo);
		}
	}

	return null;
}

/**
 * Every instance in the file, refused ones included, in file order.
 *
 * `id` is the UCI section name, which is what every other surface names an
 * instance by - so a section written as `config instance 'home'` is `home`
 * everywhere, and an anonymous section gets the name UCI gave it.
 *
 * `reason` is null when the instance is usable and the refusal sentence when it
 * is not. Every surface that shows somebody their configuration reads this one
 * rather than `instances()`, because an instance that has simply disappeared
 * from every list is the hardest kind of mistake to find: nothing is broken,
 * nothing is red, and the row that should be there is not. The sentence here is
 * the same sentence syslog gets.
 */
function readInstances(uci) {
	let out = [];

	if (uci == null)
		return out;

	try {
		uci.foreach(PACKAGE, 'instance', (section) => {
			let one = {
				id: text(section['.name']),
				// What somebody called it, which is not its section name. The
				// section name is the identity every surface and every log line
				// uses; this is the label an editor prefills and a table shows,
				// and a reader with no way to tell them apart cannot offer to
				// rename one without appearing to rename the other.
				name: text(section.name),
				enabled: flag(section.enabled, true),
				lan: text(section.lan),
				carrier: text(section.carrier),
				sticky: flag(section.sticky, true),
				remap: flag(section.remap, true),
				// Absent means one client per WAN, which is what every instance
				// written before 2.4.0 meant and what most people want. 0 is
				// "no limit", which with a single-WAN pool is the other thing
				// people ask a multi-WAN router for: everybody out of that line.
				clientsPerWan: number(section.clients_per_wan, 1),
				// Absent - either of them - means the whole of the LAN. Both are
				// kept as written rather than normalised, because the refusal
				// below quotes them back and an address somebody typed wrongly
				// is easier to find in the shape they typed it.
				rangeFrom: text(section.range_from),
				rangeTo: text(section.range_to),
				rulePrefBase: number(section.rule_pref_base, 20000),
				catchAllPref: number(section.catch_all_pref, 30000),
				catchAllTable: number(section.catch_all_table, 253),
				wanWarnUptime: number(section.wan_warn_uptime, 5),
				wanErrorGrace: number(section.wan_error_grace, 20),
				releaseGrace: number(section.release_grace, 120)
			};

			one.reason = refuse(one);
			one.usable = (one.reason == null);

			push(out, one);
		});
	}
	catch (e) {
		debug('cannot list instances in ' + PACKAGE + ': ' + e);
	}

	// What no section can see on its own: the other sections.
	//
	// Two instances that would bind the same address on the same LAN is not a
	// division of labour, it is two planners handing that device two different
	// WANs on two timers and each reading the other's rule as a stray to be
	// removed. The device spends its life on whichever one wrote last.
	//
	// A range is what makes two instances on one LAN legal at all - two
	// disjoint ranges are two pools of clients and two pools of WANs, which is
	// a thing people genuinely want - so the test is on the scopes rather than
	// on the LAN. A whole-LAN instance covers everything, so it still collides
	// with every other instance there, which is the old rule said properly.
	//
	// First in file order keeps what it claimed. A disabled instance neither
	// claims nor is checked: it binds nobody, so it collides with nobody, and
	// refusing it would make deleting a section the only way to free a scope.
	let claimedPrefBase = {};
	let scopes = [];

	for (let one in out) {
		if (one.reason || !one.enabled)
			continue;

		let mine = scopeBounds(one);

		for (let other in scopes) {
			if (other.lan != one.lan)
				continue;

			if (mine.low > other.high || mine.high < other.low)
				continue;

			one.reason = sprintf('instance %s already binds %s on %s, and two instances cannot decide the same address - give this one an address range that does not overlap, or a different LAN',
				other.id, other.whole ? 'the whole of it' : sprintf('%s-%s', other.from, other.to), one.lan);
			one.usable = false;
			break;
		}

		if (one.reason)
			continue;

		// Two instances sharing a catch-all priority is the same fault one step
		// along: the pass that repairs the group would find the other one's
		// rules in it and rewrite them on every tick, for ever.
		let prefKey = sprintf('%d', one.catchAllPref);
		if (prefKey in claimedPrefBase) {
			one.reason = sprintf('catch_all_pref %d is already taken by instance %s, and two catch-alls at one priority would each keep rewriting the other',
				one.catchAllPref, claimedPrefBase[prefKey]);
			one.usable = false;
			continue;
		}
		claimedPrefBase[prefKey] = one.id;

		push(scopes, {
			id: one.id,
			lan: one.lan,
			low: mine.low,
			high: mine.high,
			whole: mine.whole,
			from: one.rangeFrom,
			to: one.rangeTo
		});
	}

	return out;
};

// ---------------------------------------------------------------------------
// One-to-one bindings: `config direct '<id>'`.
//
// An instance hands every client on a LAN whichever WAN is free at the time. A
// direct binding is the other thing people want out of a multi-WAN router: this
// address, that port, always, chosen by a person rather than by a pool.
//
// It lives in this file rather than in the app because the router is the source
// of truth for it. The daemon reconciles these on boot and on netifd events
// with nothing attached to it, so a binding has to keep working when the app is
// uninstalled, when the laptop it ran on is shut, and when the router comes
// back up at three in the morning on its own.

/**
 * Where the priorities a binding may take start, and how many there are.
 *
 * The band sits *below* every instance's `rule_pref_base`, and that placement
 * is the whole of how a hand-placed binding beats the pool. The kernel walks ip
 * rules from the lowest preference upwards and the first match decides, so a
 * binding at 19000 answers for an address before the assignment an instance
 * would have given it at 20000 is ever reached.
 *
 * The same fact read from the other end is what keeps the two bands from
 * colliding at all: the instance planner counts its free client preferences
 * from its own `rule_pref_base` upwards and reads the router's rule table back
 * from the same number, so a rule down here is invisible to it. Let the bands
 * overlap and it is not merely a tie - the instance adopts a binding's rule as
 * one of its own assignments, finds no lease that justifies it, and deletes it
 * on the next pass, once per pass, with nothing anywhere saying why the address
 * keeps losing its WAN. That is why an overlap is refused in two places below:
 * on the band, by `directBand()`, and on each binding's own stamped `pref`.
 *
 * 1000 is DIRECT_PREF_SPAN in the module's records.ts, and 19000 is its
 * `directPrefBase` default. Both halves have to agree about the width, or the
 * app allocates a number the router then refuses.
 */
const DIRECT_PREF_BASE = 19000;
const DIRECT_PREF_SPAN = 1000;

// The kernel's own ceiling for an ip rule priority.
const MAX_PREF = 0x7fffffff;

// A UCI interface name, not a device name. `wan`, `wan2` and `lan_guest` are
// sections in /etc/config/network; `eth1.101`, `br-lan` and `pppoe-wan` are
// what the kernel calls the things underneath them. netifd is asked about the
// first kind and knows nothing of the second, so a binding naming a device
// would resolve to no interface, write no rule, and report nothing wrong.
const UCI_NAME = /^[A-Za-z0-9_]+$/;

function uciName(value) {
	return match(value, UCI_NAME) ? true : false;
}

/**
 * What this binding follows, or null when it cannot be read.
 *
 * Dashes are read as colons and letters are lower-cased on the way in, because
 * that is the spelling the lease file carries and somebody copying a MAC out of
 * a Windows dialog has still named the right device. Null covers every way of
 * getting this wrong; the sentence that explains which way is `refuseDirect`'s
 * job, because only that has both raw values in front of it.
 */
function readTarget(ipText, macText) {
	if (length(ipText) && length(macText))
		return null;

	if (length(ipText))
		return validIp(ipText) ? { kind: 'ip', ip: trim(ipText) } : null;

	if (length(macText)) {
		let mac = normalizeMac(replace(macText, /-/g, ':'));
		return length(mac) ? { kind: 'mac', mac: mac } : null;
	}

	return null;
}

/**
 * The band new bindings are numbered in, and whether it is safe to number in.
 *
 * `reason` is null when the band is usable and a sentence when it is not, for
 * the same reason every refusal in this file is a sentence: this one has to
 * reach somebody before a binding exists to be refused, because by then the
 * failure is an address that is not going where its owner was told it goes.
 *
 * A band that cannot hold its own width falls back to the shipped default and
 * says so; a band that reaches into an instance's client range does not, and is
 * returned as it was written. Moving that one would be the app's stamped
 * numbers and the router's disagreeing about where a binding lives, which is
 * the one thing every number in this file is arranged to prevent.
 *
 * Declared above its callers because ucode resolves a name when it compiles the
 * function that mentions it, so a callee further down the file is a global load
 * that raises the first time the line runs.
 */
function bandFrom(uci, list) {
	let base = DIRECT_PREF_BASE;
	let fallbackReason = null;

	try {
		if (uci != null)
			base = number(uci.get(PACKAGE, 'main', 'direct_pref_base'), DIRECT_PREF_BASE);
	}
	catch (e) {
		debug('cannot read ' + PACKAGE + ': ' + e);
	}

	if (base < 1 || base + DIRECT_PREF_SPAN - 1 > MAX_PREF) {
		fallbackReason = sprintf('direct_pref_base %d cannot hold %d ip rule priorities; using %d',
			base, DIRECT_PREF_SPAN, DIRECT_PREF_BASE);
		base = DIRECT_PREF_BASE;
	}

	let reason = null;

	for (let one in list) {
		if (base + DIRECT_PREF_SPAN > one.rulePrefBase) {
			reason = sprintf('direct_pref_base %d opens a band of %d that reaches %d, which is not below instance %s\'s rule_pref_base %d. A binding numbered up there is adopted by that instance as one of its own client assignments and deleted on the next pass. Lower direct_pref_base, or raise that instance\'s rule_pref_base',
				base, DIRECT_PREF_SPAN, base + DIRECT_PREF_SPAN - 1, one.id, one.rulePrefBase);
			break;
		}
	}

	return {
		base: base,
		span: DIRECT_PREF_SPAN,
		top: base + DIRECT_PREF_SPAN - 1,
		reason: reason,
		usable: (reason == null),
		fallbackReason: fallbackReason
	};
}

/**
 * Why this binding cannot be used, or null.
 *
 * One function returning one sentence, for the reason the instance half gives:
 * that sentence is what reaches syslog, `bmwan check` and the app, and "pref
 * 20000 is not below instance home's rule_pref_base 20000" is something a
 * person can act on where "invalid configuration" is not.
 *
 * The stakes are higher here than they are next door. An instance that is
 * quietly dropped leaves a LAN behaving as it did before anybody configured
 * anything. A binding that is quietly dropped leaves its owner believing one
 * address is pinned to one port when it is taking whatever the router picked -
 * which is the failure the whole feature exists to deny. So nothing here is
 * corrected on the way past, and nothing is silently ignored.
 *
 * `live` carries the usable instances and the band, because half of what makes
 * a binding wrong is what the rest of the file says.
 */
function refuseDirect(one, live) {
	if (length(one.ip) && length(one.mac)) {
		return 'both ip and mac are set, and a binding follows one thing: an address, or a device wherever its lease puts it. Delete whichever of the two was not meant';
	}

	if (!length(one.ip) && !length(one.mac))
		return 'neither ip nor mac is set, so there is nothing for this binding to follow';

	if (!one.target && length(one.ip))
		return sprintf('ip %s is not an IPv4 address', one.ip);

	if (!one.target)
		return sprintf('mac %s is not a MAC address; six hex pairs, separated by colons', one.mac);

	// Both of these parse and neither is a host. A rule written from 0.0.0.0
	// matches every source on the router, which is not a binding but a default
	// route with one address's name on it.
	if (one.targetKind == 'ip' && (one.target.ip == '0.0.0.0' || one.target.ip == '255.255.255.255'))
		return sprintf('ip %s is not one host\'s address, so there is nothing here to bind', one.target.ip);

	if (one.targetKind == 'mac' && (one.target.mac == '00:00:00:00:00:00' || one.target.mac == 'ff:ff:ff:ff:ff:ff'))
		return sprintf('mac %s is not one device\'s address, so no lease will ever answer to it', one.target.mac);

	if (!length(one.wan))
		return 'no wan is set, so there is no port for this binding to leave through';

	if (!uciName(one.wan)) {
		return sprintf('wan %s is not a UCI interface name. This wants the name of the section in /etc/config/network - wan, wan2 - and not the device underneath it, which is what eth1.101 and br-lan are',
			one.wan);
	}

	if (length(one.lan) && !uciName(one.lan)) {
		return sprintf('lan %s is not a UCI interface name. This wants the section in /etc/config/network the address sits behind - lan, lan_guest - and not the bridge device, which is what br-lan is',
			one.lan);
	}

	if (!(one.whenDown in [ 'hold', 'fallback' ])) {
		return sprintf('when_down %s is neither hold nor fallback. hold parks the address on the unreachable table, so while its WAN is down it has no way out at all; fallback re-points it at the main table, so it leaves over whatever connection the router would have used anyway. There is no third answer - taking the rule away is fallback with nothing to say so',
			one.whenDown);
	}

	if (one.pref < 1) {
		return sprintf('no pref is set, or it is not a number. This is the ip rule priority this binding\'s rule is written at, and the daemon will not pick one: a number the app and the router had each chosen separately would be two rules for one address. Take a free one from %d-%d',
			live.base, live.top);
	}

	if (one.pref > MAX_PREF)
		return sprintf('pref %d is above %d, which is the highest ip rule priority the kernel takes', one.pref, MAX_PREF);

	// The first instance that would swallow it, rather than the lowest base on
	// the router: naming one of them is enough to act on, and every one of them
	// has the same fix.
	for (let ins in live.instances) {
		if (one.pref >= ins.rulePrefBase) {
			return sprintf('pref %d is not below instance %s\'s rule_pref_base %d. The lowest matching ip rule decides, so at or above that number this binding no longer outranks the WAN that instance would assign - and worse, that instance counts its own client priorities from there upwards, adopts this rule as one of its assignments, finds no lease behind it and removes it. Move this binding into %d-%d',
				one.pref, ins.id, ins.rulePrefBase, live.base, live.top);
		}
	}

	if (one.table < 1) {
		return 'no table is set, or it is not a number. This is the routing table the bound WAN puts its default route in - `option ip4table` on that interface in /etc/config/network';
	}

	if (one.table > MAX_TABLE)
		return sprintf('table %d is not a routing table number; the highest is %d', one.table, MAX_TABLE);

	if (one.table == 254) {
		return 'table 254 is the router\'s own main table. A rule pointing there sends this address out over whichever connection the router would have picked anyway, while every row on every surface reads bound - which is when_down fallback wearing the name of a binding. Use the WAN\'s own ip4table';
	}

	if (one.table == 255)
		return 'table 255 is the local table, which holds the router\'s own addresses and no way off the router';

	// A WAN's table is never one of these, so this only ever fires on a typo -
	// and the typo is expensive, because the table it lands in holds nothing
	// but `unreachable default`.
	for (let ins in live.instances) {
		if (one.table == ins.catchAllTable) {
			return sprintf('table %d is instance %s\'s catch_all_table, which holds nothing but `unreachable default`. The rule would be written, the row would read bound, and every packet from %s would be dropped. Use the WAN\'s own ip4table',
				one.table, ins.id, one.label);
		}
	}

	return null;
}

/**
 * Every binding in the file, refused ones included, in file order.
 *
 * Same contract as `configured()` next door, and for the same reason: a section
 * that has simply disappeared from every list is the hardest kind of mistake to
 * find. `id` is the UCI section name, so `config direct 'desk'` is `desk`
 * everywhere; `reason` is null when the binding is usable and the refusal
 * sentence when it is not, and it is the sentence syslog gets.
 *
 * `pref` and `table` are read as written and never re-derived. They are what
 * the rule already on the router was written against, so a binding whose
 * numbers were quietly recomputed from today's settings would send the next
 * pass hunting in the wrong band and leave the real rule behind, unowned and
 * still steering traffic.
 */
function readDirect(uci, live) {
	let out = [];

	if (uci == null)
		return out;

	try {
		uci.foreach(PACKAGE, 'direct', (section) => {
			let one = {
				id: text(section['.name']),
				name: text(section.name),
				enabled: flag(section.enabled, true),
				ip: text(section.ip),
				mac: text(section.mac),
				wan: text(section.wan),
				lan: text(section.lan),
				// Absent means hold, here and in the app's reader both. A
				// binding whose choice was lost has to fail closed rather than
				// quietly start letting the address out over the default
				// connection - but a word that is neither is refused below,
				// because somebody typing `drop` asked for something and would
				// otherwise silently get the opposite of it.
				whenDown: lc(text(section.when_down)),
				pref: number(section.pref, 0),
				table: number(section.table, 0)
			};

			if (!length(one.name))
				one.name = one.id;

			if (!length(one.whenDown))
				one.whenDown = 'hold';

			one.target = readTarget(one.ip, one.mac);
			one.targetKind = one.target ? one.target.kind : '';
			one.label = one.target
				? (one.target.kind == 'ip' ? one.target.ip : one.target.mac)
				: (length(one.ip) ? one.ip : one.mac);

			one.reason = refuseDirect(one, live);
			one.usable = (one.reason == null);

			push(out, one);
		});
	}
	catch (e) {
		debug('cannot list bindings in ' + PACKAGE + ': ' + e);
	}

	// What no section can see on its own: the other sections.
	//
	// Two rules at one priority is not a tie the kernel breaks in any order
	// worth relying on, and two bindings following one address means the
	// lower-numbered rule decides while the other is never reached - one row
	// reading bound for something it is not doing. First in file order keeps
	// what it claimed, which is the only rule here that does not change when
	// somebody adds a section at the end.
	//
	// A disabled binding neither claims nor is checked: it writes no rule, so
	// it collides with nothing, and refusing it would mean the way to free a
	// priority was to delete a section rather than switch it off.
	let claimedPref = {};
	let claimedTarget = {};

	for (let one in out) {
		if (one.reason || !one.enabled)
			continue;

		let prefKey = sprintf('%d', one.pref);
		if (prefKey in claimedPref) {
			one.reason = sprintf('pref %d is already taken by binding %s, and two ip rules at one priority is not an order anything can rely on',
				one.pref, claimedPref[prefKey]);
			one.usable = false;
			continue;
		}
		claimedPref[prefKey] = one.id;

		let targetKey = one.targetKind + ' ' + one.label;
		if (targetKey in claimedTarget) {
			one.reason = sprintf('binding %s already follows %s. The lower-numbered rule decides and the other is never reached, so one of these two would do nothing while its row said otherwise',
				claimedTarget[targetKey], one.label);
			one.usable = false;
			continue;
		}
		claimedTarget[targetKey] = one.id;
	}

	return out;
};

// ---------------------------------------------------------------------------
// One read of the file, and everything anybody asks about it.
//
// Every reader above used to open its own cursor, and the readers call each
// other: `directConfigured()` needs the band, the band needs the instances, and
// the instances are a second walk of the same file. Answering `bindings` cost
// seven opens of /etc/config/bm_wanbind and answering `info` cost five. At four
// instances that is invisible. At five hundred bindings it is the pass.
//
// So the file is read once, into this, and the readers below hand back pieces
// of it. Nothing is cached between calls and that is deliberate: jffs2 stores
// one second of mtime resolution, and `bind` commits a section and then reads
// it back inside the same second to decide whether what it wrote is usable. A
// cache would answer that read with the file as it was before the write.

/**
 * The whole configuration, from one cursor.
 *
 * `log` is what the reconcile pass sets and nothing else does. Refusals are
 * sentences somebody has to act on, and they were written to syslog by the
 * reader that found them - which is once per ubus call, per refused section, on
 * a router that answers a call every five seconds. Now they are collected here
 * and written once a pass.
 */
export function snapshot(opts) {
	let options = (type(opts) == 'object') ? opts : {};
	let uci = null;

	try {
		uci = cursor();
	}
	catch (e) {
		debug('cannot open uci: ' + e);
	}

	let main = readMain(uci);
	let instances = readInstances(uci);
	let refusals = [];

	if (main.reason)
		push(refusals, main.reason);

	let usable = [];

	for (let one in instances) {
		if (one.reason) {
			push(refusals, 'instance ' + one.id + ': ' + one.reason);
			continue;
		}

		push(usable, one);
	}

	let band = bandFrom(uci, usable);

	if (band.fallbackReason)
		push(refusals, band.fallbackReason);

	let direct = readDirect(uci, { base: band.base, top: band.top, instances: usable });
	let bindings = [];

	for (let one in direct) {
		if (one.reason) {
			push(refusals, 'binding ' + one.id + ': ' + one.reason);
			continue;
		}

		push(bindings, one);
	}

	// By name, because every ubus call that edits one thing looks it up by name
	// and a linear scan of five hundred bindings per call is the same waste in
	// a different place.
	let instanceById = {};
	let directById = {};

	for (let one in instances)
		instanceById[one.id] = one;

	for (let one in direct)
		directById[one.id] = one;

	if (options.log) {
		for (let one in refusals)
			err(one);
	}

	return {
		read: (uci != null),
		main: main,
		instances: instances,
		usable: usable,
		band: band,
		direct: direct,
		bindings: bindings,
		instanceById: instanceById,
		directById: directById,
		refusals: refusals
	};
};

/**
 * Whichever snapshot the caller already has, or a fresh one.
 *
 * The readers below all take an optional snapshot for the same reason: a verb
 * that answers one question takes one and threads it through everything it
 * calls, and a caller that has no reason to care still gets the file read
 * correctly. The wrappers are what keeps the second kind working.
 */
function given(snap) {
	return (type(snap) == 'object' && type(snap.main) == 'object') ? snap : snapshot();
}

/** The global section: whether the daemon runs, and how often it reconciles. */
export function main(snap) {
	return given(snap).main;
};

/**
 * Every instance in the file, refused ones included, in file order.
 *
 * `id` is the UCI section name, which is what every other surface names an
 * instance by - so a section written as `config instance 'home'` is `home`
 * everywhere, and an anonymous section gets the name UCI gave it.
 *
 * `reason` is null when the instance is usable and the refusal sentence when it
 * is not. Every surface that shows somebody their configuration reads this one
 * rather than `instances()`, because an instance that has simply disappeared
 * from every list is the hardest kind of mistake to find: nothing is broken,
 * nothing is red, and the row that should be there is not. The sentence here is
 * the same sentence syslog gets.
 */
export function configured(snap) {
	return given(snap).instances;
};

/** Every usable instance, in file order. What the engine runs on. */
export function instances(snap) {
	return given(snap).usable;
};

/**
 * One instance by name, or null.
 *
 * Refused sections are not findable here, which is what makes this the reader
 * every ubus call that acts on an instance uses: acting on one the file has
 * already refused is the failure, not the lookup.
 */
export function instance(id, snap) {
	let one = given(snap).instanceById[id];

	return (one != null && one.reason == null) ? one : null;
};

/** Where a one-to-one binding's priorities may sit, and whether they may. */
export function directBand(snap) {
	return given(snap).band;
};

/** Every binding in the file, refused ones included, in file order. */
export function directConfigured(snap) {
	return given(snap).direct;
};

/** Every usable binding, in file order. What the reconcile writes rules for. */
export function directBindings(snap) {
	return given(snap).bindings;
};

/** One binding by name, or null - refused ones are not findable. */
export function directBinding(id, snap) {
	let one = given(snap).directById[id];

	return (one != null && one.reason == null) ? one : null;
};
