// What this router has of what every Bored Manager feature needs - and the
// fixed list of package groups the agent may install to close a gap.
//
// The report exists because a requirement that fails silently is a feature
// that breaks silently: a router that loses `ppp` after a sysupgrade keeps
// its pools listed and dials nothing, and the only witness used to be the
// app's readiness page - invisible from the router's own LuCI. Every row here
// is asked live, in one shell, the same way the app's probe asks.
//
// The installer is an allowlist, never a parameter. It mirrors the module's
// `main/packages.ts` table name for name: `apk add` is built only from names
// written in this file, so nothing a caller sends can become a different
// command. Firewall4 is deliberately absent from the groups for the same
// reason it is absent from the module's table - installing fw4 under a
// running fw3 takes the firewall down rather than fixing anything.

import { access, popen } from 'fs';

import { debug } from 'bm.log';

// Long enough for `apk add` of a kmod over a slow uplink; the same budget the
// update engine gives an install.
const APK_TIMEOUT = '300';

// The groups, and the exact packages each one installs, in install order.
// Mirrors openwrt/main/packages.ts - a second list would drift, so this one
// spells the same names and the check that holds the two together is review.
const GROUPS = {
	pppoe: [ 'ppp', 'ppp-mod-pppoe', 'kmod-pppoe' ],
	ipfull: [ 'ip-full' ],
	dnsmasq: [ 'dnsmasq' ]
};

// One shell, sentinel words out. Mirrors the app-side capability probe
// (openwrt/main/probe/command.ts) fact for fact, including the FIB tolerance:
// a numeric table that merely does not exist yet is iproute2 saying the kernel
// parsed the table and looked it up - which is the capability under test -
// while BusyBox's `invalid argument` and a kernel without multiple tables
// both stay failures.
const FACTS_SCRIPT = 'if ls /usr/lib/pppd/*/*pppoe.so >/dev/null 2>&1; then echo plugin; fi; ' +
	'if ls /lib/modules/*/pppoe.ko* >/dev/null 2>&1 || grep -qs pppoe /lib/modules/*/modules.builtin; then echo kmod; fi; ' +
	'if command -v pppd >/dev/null 2>&1; then echo pppd; fi; ' +
	'BM_T=$(ip -4 route show table 29999 2>&1); BM_TR=$?; ' +
	'if ip -4 rule show >/dev/null 2>&1; then if [ $BM_TR -eq 0 ] || printf \'%s\' "$BM_T" | grep -qi \'fib table does not exist\'; then echo iprule; fi; fi; ' +
	'if command -v dnsmasq >/dev/null 2>&1; then echo dnsmasq; fi; ' +
	'if command -v pidof >/dev/null 2>&1; then echo pidof; if pidof dnsmasq >/dev/null 2>&1; then echo dnsmasqrun; fi; fi; ' +
	'if command -v fw4 >/dev/null 2>&1 && command -v nft >/dev/null 2>&1; then echo fw4; fi; ' +
	'BM_N=$(nft list tables inet 2>/dev/null) && case "$BM_N" in *\'table inet fw4\'*) echo fw4run;; esac; ' +
	'if command -v usign >/dev/null 2>&1; then echo usign; fi; ' +
	'if ls /usr/share/bm/keys/*.pub >/dev/null 2>&1; then echo key; fi; ' +
	'if [ -r /etc/ssl/certs/ca-certificates.crt ]; then echo cabundle; fi';

/** Run one command through the shell and hand back its text, or null. */
function sh(script) {
	let handle = popen(script, 'r');
	if (!handle)
		return null;

	let out = handle.read('all');
	handle.close();
	return type(out) == 'string' ? out : null;
};

/** The sentinel words the facts script printed, as a set. Null when it could
 * not run at all - a harness with no shell, which must read as "not asked"
 * rather than as a router missing everything. */
function facts() {
	let out = sh(FACTS_SCRIPT);
	if (out == null)
		return null;

	let seen = {};
	for (let line in split(out, '\n')) {
		let word = trim(line);
		if (length(word))
			seen[word] = true;
	}

	return seen;
};

function row(id, label, ok, detail, group) {
	return { id: id, label: label, ok: ok, detail: detail, group: group };
};

/**
 * Every requirement, asked live. `ok` is true, false, or null for a question
 * this process could not ask - a caller treats null as unknown, never as
 * missing, because an invented fault is worse than a missing one.
 *
 * `group` names the installable fix when there is one; null means no package
 * on this router can change the answer.
 */
export function report() {
	let seen = facts();

	if (!seen) {
		let unknown = [];
		for (let id in [ 'pppoe', 'iprule', 'dnsmasq', 'fw4', 'signing', 'cabundle' ])
			push(unknown, row(id, id, null, 'this build could not ask the shell', null));
		return { ok: true, asked: false, rows: unknown };
	}

	let rows = [];

	let pppMissing = [];
	if (!seen.pppd)
		push(pppMissing, 'pppd');
	if (!seen.plugin)
		push(pppMissing, 'the pppoe plugin');
	if (!seen.kmod)
		push(pppMissing, 'the pppoe kernel module');

	push(rows, row('pppoe', 'PPPoE dialing stack',
		length(pppMissing) == 0,
		length(pppMissing) == 0
			? 'pppd, the pppoe plugin and the kernel module are all present.'
			: 'Missing: ' + join(', ', pppMissing) + '. Without them no pool session can dial.',
		length(pppMissing) == 0 ? null : 'pppoe'));

	push(rows, row('iprule', 'Policy routing (numeric tables)',
		seen.iprule == true,
		seen.iprule
			? 'The ip binary accepted a numeric routing table, so WAN binding can steer by table.'
			: 'The ip binary refused a numeric routing table: BusyBox ip, or a kernel without ' +
			  'multiple routing tables. Installing ip-full fixes the first and nothing fixes the second.',
		seen.iprule ? null : 'ipfull'));

	let dnsmasqDetail = 'dnsmasq is what turns DHCP leases into devices WAN binding can see.';
	if (seen.dnsmasq && seen.pidof)
		dnsmasqDetail = seen.dnsmasqrun
			? 'Present and running.'
			: 'Installed but not running - start it with "service dnsmasq start".';
	push(rows, row('dnsmasq', 'DHCP leases (dnsmasq)',
		seen.dnsmasq == true,
		seen.dnsmasq ? dnsmasqDetail : 'Not installed. ' + dnsmasqDetail,
		seen.dnsmasq ? null : 'dnsmasq'));

	push(rows, row('fw4', 'Firewall4 (fw4 + nft)',
		seen.fw4 == true,
		seen.fw4
			? (seen.fw4run
				? 'Present, and the inet fw4 ruleset is loaded.'
				: 'Present, but no inet fw4 ruleset is loaded - start it with "service firewall start".')
			: 'No fw4: pools cannot masquerade and binding cannot forward. No package is offered - ' +
			  'installing fw4 under a running fw3 takes the firewall down.',
		null));

	push(rows, row('signing', 'Release signing (usign + key)',
		seen.usign == true && seen.key == true,
		(seen.usign && seen.key)
			? 'A release manifest fetched over the network can be verified here.'
			: (seen.usign
				? 'No release key is installed, so this router refuses network updates. Updating the packages once from the app puts the key on.'
				: 'usign is missing, so nothing fetched over the network can be verified.'),
		null));

	push(rows, row('cabundle', 'HTTPS trust (ca-bundle)',
		seen.cabundle == true,
		seen.cabundle
			? 'HTTPS certificates can be verified, so release downloads can run.'
			: 'No ca-certificates bundle: this router cannot verify an HTTPS certificate, so it cannot fetch updates itself.',
		null));

	return { ok: true, asked: true, rows: rows };
};

/**
 * Install one group off the fixed table. `apk update` runs first and its
 * failure is tolerated - one unreachable feed must not cancel an install of
 * packages the router already has cached - and the add itself is quoted from
 * this file alone, never from the caller.
 */
export function install(args) {
	let group = type(args.group) == 'string' ? args.group : '';

	if (!exists(GROUPS, group)) {
		return {
			ok: false,
			reason: 'unknown group "' + group + '" - one of: ' + join(', ', sort(keys(GROUPS)))
		};
	}

	let names = GROUPS[group];

	if (args.dry_run === true)
		return { ok: true, group: group, packages: names, dryRun: true };

	let apk = null;
	for (let candidate in [ '/usr/bin/apk', '/sbin/apk', '/bin/apk', '/usr/sbin/apk' ]) {
		if (access(candidate, 'x'))
			apk = candidate;
	}

	if (!apk)
		return { ok: false, reason: 'no apk on this router - it is the only package manager this agent drives' };

	// Through the shell so the output comes back with the exit status: apk's
	// own sentence is the only thing a user can act on when an add fails.
	// `timeout` guards a wedged feed; names are from the table above only.
	let updated = sh('timeout ' + APK_TIMEOUT + ' ' + apk + ' update 2>&1');

	let out = sh('timeout ' + APK_TIMEOUT + ' ' + apk + ' add ' + join(' ', names) + ' 2>&1; echo "bm-apk-exit=$?"');
	if (out == null)
		return { ok: false, reason: 'apk could not be started' };

	let found = match(out, /bm-apk-exit=([0-9]+)/);
	let status = found ? int(found[1]) : 1;

	// The tail is what carries apk's reason; the head is progress noise.
	let tail = length(out) > 600 ? substr(out, length(out) - 600) : out;

	if (status != 0) {
		debug('requirements install ' + group + ' failed: ' + tail);
		return { ok: false, group: group, packages: names, reason: trim(tail) };
	}

	return {
		ok: true,
		group: group,
		packages: names,
		updateOk: updated != null,
		detail: trim(tail)
	};
};
