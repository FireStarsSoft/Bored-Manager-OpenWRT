'use strict';
'require baseclass';
'require rpc';
'require ui';
'require poll';
'require dom';

/*
 * One place that knows how to talk to the three daemons, and one place that
 * knows how to say what went wrong.
 *
 * Every view begins the same way: ask bm.agent what this router has. That call
 * is the only one whose absence has an unambiguous meaning - no agent, no
 * pages worth drawing - and its reply carries `provides`, which is how a view
 * knows whether the daemon it is about is installed at all. Guessing that from
 * a ubus error code would be guessing: "object not found" is also what a
 * daemon that crashed two seconds ago looks like, and those two need different
 * sentences and different buttons.
 *
 * The other rule here is that nothing rejects into a view. `ask` turns every
 * failure into { ok: false, error: <a sentence> }, so a table renders its own
 * explanation rather than leaving an empty box and a stack trace in the
 * console. It is the same rule the app's pages follow, for the same reason: a
 * blank table is the one state a person cannot act on.
 */

const AGENT = 'bm.agent';
const WANBIND = 'bm.wanbind';
const PPPOE = 'bm.pppoe';

/*
 * `expect: { '': {} }` returns the whole reply, defaulting to an empty object.
 * `reject: true` turns a nonzero ubus status into a rejection instead of
 * quietly handing back the default, which is what lets `ask` tell "the router
 * said no" from "the router said nothing".
 *
 * Our own methods answer refusals inside the payload - { ok: false, reason } -
 * so those arrive here as successful calls and are handled by `run`.
 */
function declare(object, method, params) {
	return rpc.declare({
		object: object,
		method: method,
		params: params,
		expect: { '': {} },
		reject: true
	});
}

/*
 * Every key a pool spec may carry, in one place. Credentials travel inline
 * here and that is safe for the reason the app's 0600 file is safe on its
 * path: a ubus call from this page crosses a unix socket as a parsed object,
 * so no part of it is ever a command line on the router.
 */
const POOL_SPEC = {
	id: '', mode: '', label: '', prefix: '', carrier: '', carrier_mode: '', mac_mode: '',
	username: '', password: '', members: [], table_base: 0,
	service: '', ac: '', ac_mac: '', mtu: 0, keepalive: '', ipv6: '',
	peerdns: false, dns: [], defaultroute: true, host_uniq: '', demand: 0,
	padi_attempts: 0, padi_timeout: 0, pppd_options: '', zone: '',
	masq: true, mtu_fix: true, lan_forward: true
};

/*
 * Every key a one-to-one binding may carry, and every key an instance may
 * carry. Both are sent to three methods each - the check, the write, and in
 * the binding's case the same method for create and for edit - so the shape
 * lives here once.
 *
 * `pref` and `table` are declared as integers and not as the strings UCI
 * stores them as, because ubus checks an argument against the daemon's own
 * template and refuses the whole call when the type disagrees. Leaving either
 * out is how a form says "the router picks"; absent is not zero.
 */
const BIND_SPEC = {
	id: '', name: '', ip: '', mac: '', wan: '', lan: '',
	when_down: '', pref: 0, table: 0, enabled: true
};

const INSTANCE_SPEC = {
	id: '', enabled: true, name: '', lan: '', carrier: '',
	sticky: true, remap: true, clients_per_wan: 0,
	range_from: '', range_to: '',
	rule_pref_base: 0, catch_all_pref: 0, catch_all_table: 0,
	wan_warn_uptime: 0, wan_error_grace: 0, release_grace: 0,
	raise_dhcp_limits: false
};

const calls = {
	agentInfo: declare(AGENT, 'info'),
	agentStats: declare(AGENT, 'stats'),

	configList: declare(AGENT, 'config_list'),
	configShow: declare(AGENT, 'config_show', { id: '' }),
	configDiff: declare(AGENT, 'config_diff', { id: '' }),
	configExport: declare(AGENT, 'config_export', { id: '' }),
	configRestore: declare(AGENT, 'config_restore', { id: '', dry_run: false }),
	configSnapshot: declare(AGENT, 'config_snapshot', { reason: '' }),
	configDelete: declare(AGENT, 'config_delete', { id: '' }),

	guardStatus: declare(AGENT, 'guard_status'),
	guardArm: declare(AGENT, 'guard_arm', { timeout: 0, reason: '' }),
	guardConfirm: declare(AGENT, 'guard_confirm'),
	guardCancel: declare(AGENT, 'guard_cancel'),

	updateCheck: declare(AGENT, 'update_check'),
	updateApply: declare(AGENT, 'update_apply', { dry_run: false, guard: true, timeout: 0 }),
	updateRollback: declare(AGENT, 'update_rollback', { guard: true, timeout: 0 }),
	updateStatus: declare(AGENT, 'update_status'),

	// What this router has of what every feature needs, and the allowlisted
	// installer behind the rows. `group` is a key into the agent's own fixed
	// table (pppoe / ipfull / dnsmasq); a package name never crosses this call.
	requirements: declare(AGENT, 'requirements'),
	installPackages: declare(AGENT, 'install_packages', { group: '', dry_run: false }),

	// The router-wide limits that decide whether thousands of sessions fit:
	// conntrack, the neighbour-cache thresholds, and fw4's flow offload.
	tuneGet: declare(AGENT, 'tune_get'),
	tuneSet: declare(AGENT, 'tune_set', {
		conntrack_max: 0, gc_thresh1: 0, gc_thresh2: 0, gc_thresh3: 0, flow_offload: false
	}),

	wanbindInfo: declare(WANBIND, 'info'),
	wanbindStats: declare(WANBIND, 'stats'),
	wanbindAssignments: declare(WANBIND, 'assignments', { instance: '' }),
	wanbindWaiting: declare(WANBIND, 'waiting', { instance: '', limit: 0, offset: 0, include_reserved: false }),
	wanbindPin: declare(WANBIND, 'pin', { instance: '', mac: '', wan: '' }),
	wanbindReassign: declare(WANBIND, 'reassign', { instance: '', mac: '' }),
	wanbindUnassign: declare(WANBIND, 'unassign', { instance: '', mac: '' }),
	wanbindRelease: declare(WANBIND, 'release', { instance: '', mac: '' }),
	wanbindReconcile: declare(WANBIND, 'reconcile', { instance: '', wait: false }),
	wanbindFlush: declare(WANBIND, 'flush', { instance: '' }),

	// Every binding the router holds, by hand or grown from a lease, and the
	// two ways to change a hand-placed one. `source` filters; leaving it out
	// asks for all of them, which is what an older daemon that has never heard
	// of the key answers anyway.
	wanbindBindings: declare(WANBIND, 'bindings', { id: '', source: '' }),
	wanbindBind: declare(WANBIND, 'bind', BIND_SPEC),
	wanbindBindCheck: declare(WANBIND, 'bind_check', BIND_SPEC),
	wanbindUnbind: declare(WANBIND, 'unbind', { id: '' }),

	// The batch forms. What they are for is the module handing over the
	// bindings it used to write itself, but the ACL and this table are one
	// list: a method the daemon publishes and this file does not declare is a
	// method nothing in the browser can reach.
	wanbindBindMany: declare(WANBIND, 'bind_many', { bindings: [] }),
	wanbindUnbindMany: declare(WANBIND, 'unbind_many', { ids: [] }),

	// What this router reads each of its interfaces as, and what it can hand
	// out. Asked when a form opens rather than on the poll: neither answer
	// changes while somebody is typing into the box it filled.
	wanbindLayout: declare(WANBIND, 'layout'),
	wanbindWans: declare(WANBIND, 'wans'),

	// The router's whole ip rule table, and the check that what the daemon
	// wrote is still in it. Both read-only; `rules` is the only call on this
	// page that can be capped, and says so in its own reply.
	wanbindRules: declare(WANBIND, 'rules', { limit: 0, offset: 0, reasons: false, collapse: true }),
	wanbindRuleExplain: declare(WANBIND, 'rule_explain', { pref: 0, cidr: '', dst: '', table: 0 }),
	wanbindVerify: declare(WANBIND, 'verify', { instance: '' }),

	// Instances are the router's to write from 2.4.0 on. The browser sends a
	// spec and the daemon does the whole dance - flush first, write, prepare,
	// pass - because only it can do those in the one order that leaves no rule
	// behind that nothing admits to.
	wanbindInstanceCheck: declare(WANBIND, 'instance_check', INSTANCE_SPEC),
	wanbindInstanceSet: declare(WANBIND, 'instance_set', INSTANCE_SPEC),
	wanbindInstanceDelete: declare(WANBIND, 'instance_delete', { id: '' }),

	wanbindSettingsGet: declare(WANBIND, 'settings_get'),
	wanbindSettingsSet: declare(WANBIND, 'settings_set', {
		enabled: false, interval: 0, direct_pref_base: 0, rule_pref_base: 0,
		catch_all_pref_base: 0, catch_all_table: 0, wan_table_base: 0,
		wan_warn_uptime: 0, wan_error_grace: 0, release_grace: 0
	}),

	poolInfo: declare(PPPOE, 'info'),
	poolStats: declare(PPPOE, 'stats'),
	poolSessions: declare(PPPOE, 'sessions', { id: '', scope: '' }),
	poolAction: declare(PPPOE, 'action', { action: '', sections: [] }),
	poolCarriers: declare(PPPOE, 'carriers'),
	// The full spec shape, shared by check, create and set. Only the keys a
	// form actually sends travel - rpc.declare with an object filters by
	// presence - which is what makes pool_set a partial edit.
	poolCheck: declare(PPPOE, 'pool_check', POOL_SPEC),
	poolAdd: declare(PPPOE, 'pool_add', POOL_SPEC),
	poolSet: declare(PPPOE, 'pool_set', POOL_SPEC),
	poolDelete: declare(PPPOE, 'pool_delete', { id: '', force: false }),
	poolSettingsGet: declare(PPPOE, 'settings_get'),
	poolSettingsSet: declare(PPPOE, 'settings_set', {
		enabled: false, counter_interval: 0, redial_after: 0, redial_batch: 0
	}),
	poolReconcile: declare(PPPOE, 'reconcile')
};

/** A ubus failure as something a person can act on. */
function describe(error) {
	const text = String((error && error.message) || error || '');

	if (/ubus code 4\b/.test(text))
		return _('The router has no such service listening. It may have stopped, or the package may have just been removed.');
	if (/ubus code 6\b/.test(text))
		return _('This login is not allowed to make that call. The ACL that grants it is luci-app-bm.');
	// Raw ubus status values - rpc.js prints the number and nothing else, so
	// these have to agree with its own table (rpc.js, getStatusText): 2 is
	// INVALID_ARGUMENT, 7 is TIMEOUT, 9 is UNKNOWN_ERROR. 2 and 7 shared one
	// sentence about arguments, which is the wrong half of the advice for a
	// daemon that is simply not answering.
	if (/ubus code 2\b/.test(text))
		return _('The router rejected the arguments of that call.');
	// A method the running agent has never heard of: the packages predate it.
	// Said as the fix rather than as a fault, because the router is fine.
	if (/ubus code 3\b/.test(text))
		return _('The bm-agent on this router does not have that call yet. Update the router packages to 2.1.0 or newer.');
	if (/ubus code 7\b/.test(text))
		return _('The router took too long to answer.');
	// What a handler that threw replies with, immediately before the exception
	// takes the daemon down with it (ubus.c, the default exception case). So it
	// is the one code whose reason only ever exists in the log.
	if (/ubus code 9\b/.test(text))
		return _('The router failed that call without saying why, and the daemon may have stopped. Run "logread -e bm-" on the router.');
	// The dispatcher's own refusal, not a ubus status: the session was created
	// before this package's ACL existed, so rpcd never granted it these calls.
	// A new login reads the ACL that is on disk now.
	if (/-32002|Access denied/i.test(text))
		return _('This login is older than the ACL that allows these calls. Log out of LuCI and back in; if that is not enough, run "/etc/init.d/rpcd reload" on the router.');
	if (/HTTP error|NetworkError/i.test(text))
		return _('The router did not answer. The connection may have gone.');

	return text.length ? text : _('The call failed and the router did not say why.');
}

return baseclass.extend({
	AGENT: AGENT,
	WANBIND: WANBIND,
	PPPOE: PPPOE,

	calls: calls,

	/**
	 * Make a call and never reject.
	 *
	 * Resolves to { ok: true, data } or { ok: false, error } where `error` is a
	 * finished sentence. Views branch on `ok` and print `error`; none of them
	 * needs a catch of its own, and none of them can forget one.
	 */
	ask(fn, args) {
		return fn(args ?? {})
			.then(data => ({ ok: true, data: data ?? {}, error: null }))
			.catch(error => ({ ok: false, data: null, error: describe(error) }));
	},

	/**
	 * Make a call that changes something, and report either way.
	 *
	 * Two different failures land here and they are told apart on purpose: a
	 * call that never arrived is an error, and a call the daemon answered with
	 * { ok: false, reason } is a refusal - the router is fine and has said why
	 * it would not do that. Showing the second as an error would send somebody
	 * looking for a fault that is not there.
	 */
	run(fn, args, success) {
		return this.ask(fn, args).then(result => {
			if (!result.ok) {
				ui.addNotification(null, E('p', {}, result.error), 'error');
				return null;
			}

			const data = result.data ?? {};

			if (data.ok === false) {
				ui.addNotification(null, E('p', {}, data.reason ?? _('The router would not do that, and did not say why.')), 'warning');
				return null;
			}

			if (success)
				ui.addNotification(null, E('p', {}, success), 'info');

			return data;
		});
	},

	/** Whether an installed feature package claims this capability. */
	has(info, capability) {
		return !!info && Array.isArray(info.provides) && info.provides.indexOf(capability) >= 0;
	},

	/**
	 * The router's own clock at the moment a reply was built.
	 *
	 * Every daemon reports `started` and `uptime`, so their sum is the epoch
	 * second the router believed it was. Ages are worked out against that
	 * rather than against the browser's clock, which on a router with no RTC
	 * and no NTP yet can be years out - and an uptime of "-3 years" is how a
	 * perfectly healthy daemon comes to look broken.
	 */
	routerNow(info) {
		const started = (info && info.started) | 0;
		const uptime = (info && info.uptime) | 0;
		return started + uptime;
	},

	/** 3d 4h, 12m 30s, 45s. Never an empty string. */
	duration(seconds) {
		let left = Math.max(0, Math.trunc(seconds || 0));

		const days = Math.floor(left / 86400); left -= days * 86400;
		const hours = Math.floor(left / 3600); left -= hours * 3600;
		const minutes = Math.floor(left / 60); left -= minutes * 60;

		if (days) return '%dd %dh'.format(days, hours);
		if (hours) return '%dh %dm'.format(hours, minutes);
		if (minutes) return '%dm %ds'.format(minutes, left);
		return '%ds'.format(left);
	},

	/** How long ago, against the router's clock. '-' when it never happened. */
	ago(at, now) {
		if (!at) return '-';
		const delta = (now | 0) - (at | 0);
		if (delta < 0) return '-';
		return _('%s ago').format(this.duration(delta));
	},

	/** A wall-clock stamp from a router epoch second. */
	when(at) {
		if (!at) return '-';
		return new Date(at * 1000).toLocaleString();
	},

	/**
	 * Hand the browser a file to save.
	 *
	 * A blob and an object URL rather than a link to something on the router,
	 * because there is nothing on the router to link to: the text came back
	 * over the same rpc connection as everything else on the page, and giving
	 * the browser a path would mean giving the session a way to ask for paths.
	 */
	download(name, text) {
		const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
		const link = E('a', { 'href': url, 'download': name, 'style': 'display:none' });

		document.body.appendChild(link);
		link.click();

		// After the click, and not before: some browsers read the blob after
		// the event returns, and revoking it in the same tick gives them an
		// empty file with the right name - which is worse than no file at all.
		window.setTimeout(function() {
			document.body.removeChild(link);
			URL.revokeObjectURL(url);
		}, 2000);
	},

	size(bytes) {
		const value = bytes | 0;
		if (value < 1024) return '%d B'.format(value);
		if (value < 1024 * 1024) return '%.1f KB'.format(value / 1024);
		return '%.1f MB'.format(value / (1024 * 1024));
	},

	rate(bitsPerSecond) {
		const value = bitsPerSecond || 0;
		if (value < 1000) return '%d bit/s'.format(Math.round(value));
		if (value < 1000000) return '%.1f kbit/s'.format(value / 1000);
		return '%.2f Mbit/s'.format(value / 1000000);
	},

	/**
	 * The commit-confirm countdown, at the top of every tab.
	 *
	 * It is at the top of every tab and not on a page of its own because of
	 * when it matters: somebody has just applied a change that may be about to
	 * take their connection away, and whichever page they are on is the page
	 * that has to tell them. By the time it fires they are not looking at the
	 * app - that is the whole reason the guard exists on the router.
	 *
	 * Two polls, and they do different things. The five-second one asks the
	 * router; the one-second one only does arithmetic on the answer it already
	 * has, so the countdown moves once a second without a call once a second.
	 * The number it counts down is `remaining`, which the router worked out
	 * against its own clock - a browser whose clock disagrees with the router's
	 * still sees the right number of seconds.
	 */
	guardBanner() {
		const node = E('div', {});
		const self = this;

		let state = null;
		let fetchedAt = Date.now();

		function paint() {
			if (!state || state.armed !== true) {
				dom.content(node, null);
				return;
			}

			const elapsed = (Date.now() - fetchedAt) / 1000;
			const left = Math.round((state.remaining || 0) - elapsed);

			const heading = left > 0
				? _('A change is waiting to be confirmed')
				: _('The countdown has run out');

			const sentence = left > 0
				? _('This router will put its configuration back in %s unless somebody keeps the change.').format(self.duration(left))
				: _('This router is putting its configuration back now. It will be a moment.');

			dom.content(node, E('div', { 'class': 'alert-message warning' }, [
				E('h4', {}, heading),
				E('p', {}, sentence),
				state.reason ? E('p', {}, _('Reason given: %s').format(state.reason)) : '',
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn cbi-button-neutral',
						'click': ui.createHandlerFn(self, function() {
							return self.run(calls.guardCancel, {}, _('Put back. The router is reloading now.'))
								.then(() => self.refreshGuard(node));
						})
					}, _('Undo now')),
					' ',
					E('button', {
						'class': 'btn cbi-button-apply',
						'click': ui.createHandlerFn(self, function() {
							return self.run(calls.guardConfirm, {}, _('Kept. The countdown has been cancelled.'))
								.then(() => self.refreshGuard(node));
						})
					}, _('Keep these changes'))
				])
			]));
		}

		function fetch() {
			return self.ask(calls.guardStatus).then(result => {
				// A router that stopped answering keeps whatever it last said
				// rather than dropping the banner: a countdown that vanishes
				// because one poll failed is the single most alarming thing
				// this page could do, and it would be a lie.
				if (result.ok) {
					state = result.data;
					fetchedAt = Date.now();
				}
				paint();
			});
		}

		node.bmRefresh = fetch;

		poll.add(fetch, 5);
		poll.add(paint, 1);

		fetch();

		return node;
	},

	/** Ask the banner to catch up now, after something that may have armed it. */
	refreshGuard(node) {
		return (node && typeof node.bmRefresh == 'function') ? node.bmRefresh() : Promise.resolve();
	}
});
