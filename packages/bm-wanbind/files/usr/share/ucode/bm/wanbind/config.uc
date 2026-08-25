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

import { cursor } from 'uci';

import { debug, err } from 'bm.log';

const PACKAGE = 'bm_wanbind';

// Below this a full pass on a large LAN would overlap the previous one.
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 3600;

// The room every instance needs between its client rules and its catch-all,
// which is also the largest number of clients it can seat. A range narrower
// than this is a configuration that would run out during an ordinary evening.
const MIN_PREF_SPAN = 64;

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

/** The one global section. Absent means the shipped defaults. */
export function main() {
	let out = { enabled: true, interval: 30 };

	try {
		let uci = cursor();
		out.enabled = flag(uci.get(PACKAGE, 'main', 'enabled'), true);

		let interval = number(uci.get(PACKAGE, 'main', 'interval'), 30);
		if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) {
			err(sprintf('interval %d is outside %d-%d; using 30', interval, MIN_INTERVAL, MAX_INTERVAL));
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
};

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
export function configured() {
	let out = [];

	try {
		cursor().foreach(PACKAGE, 'instance', (section) => {
			let one = {
				id: text(section['.name']),
				enabled: flag(section.enabled, true),
				lan: text(section.lan),
				carrier: text(section.carrier),
				sticky: flag(section.sticky, true),
				remap: flag(section.remap, true),
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

	return out;
};

/** Every usable instance, in file order. What the engine runs on. */
export function instances() {
	let out = [];

	for (let one in configured()) {
		if (one.reason) {
			err('instance ' + one.id + ': ' + one.reason);
			continue;
		}

		push(out, one);
	}

	return out;
};

/**
 * One instance by name, or null.
 *
 * Used by every ubus call that names one. Reading the file again rather than
 * caching is deliberate: a section edited from LuCI or by hand is in effect on
 * the next call, without anything having to be told to reload.
 */
export function instance(id) {
	for (let one in instances()) {
		if (one.id == id)
			return one;
	}

	return null;
};
