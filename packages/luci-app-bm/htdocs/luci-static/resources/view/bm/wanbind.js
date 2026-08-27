'use strict';
'require view';
'require ui';
'require uci';
'require poll';
'require dom';
'require bm.api as api';
'require bm.ui as bmui';

/*
 * One DHCP client, one WAN.
 *
 * The instance list never comes from the daemon's `instances`, because that is
 * the list of instances it built state for: an instance that is switched off,
 * or that it refused for a configuration mistake, is not in it. Those are
 * exactly the two rows somebody opens this page to fix, and a page that drew
 * only the running ones would leave out the one they came for.
 *
 * So it comes from `configured`, which the daemon builds by reading the file -
 * refusals and all, each with the sentence syslog got - and from UCI directly
 * when the daemon is not answering. Which means this page draws itself on a
 * router whose bm-wanbind service is stopped. It says so, and it still shows
 * what is configured, which is the state a person is most likely to be looking
 * at it in.
 *
 * Instances are written here too. They are plain UCI sections, so this uses
 * LuCI's own uci write path and LuCI's own apply - countdown and all, which is
 * the mechanism a LuCI user already knows for a change that can take the
 * network with it. What is not plain UCI is the order: rules already on the
 * router are recognised by where they sit, so anything that moves an instance's
 * priority range, changes its LAN, switches it off or deletes it has to take
 * its rules off *first*. A disabled section is a section the daemon no longer
 * reads, and rules nothing knows the owner of stay on the router forever.
 */

const state = {
	instance: ''
};

/** The room the daemon insists on between client rules and the catch-all. */
const MIN_PREF_SPAN = 64;

/** UCI has no booleans and every one of these means the same thing. */
function flag(value, fallback) {
	if (value === undefined || value === null || value === '')
		return fallback;
	return ['0', 'no', 'off', 'false', 'disabled'].indexOf(String(value)) < 0;
}

/**
 * Every configured instance, refused ones included.
 *
 * From the daemon when it is answering, because only it can say why it refused
 * one. From UCI when it is not, which loses the reasons and keeps the rows.
 */
function instanceRows(info) {
	if (info && Array.isArray(info.configured)) {
		return info.configured.map(one => ({
			id: one.id,
			lan: one.lan ?? '',
			carrier: one.carrier ?? '',
			enabled: one.enabled !== false,
			reason: (typeof one.reason === 'string' && one.reason.length) ? one.reason : null
		}));
	}

	return uci.sections('bm_wanbind', 'instance').map(section => ({
		id: section['.name'],
		lan: section.lan ?? '',
		carrier: section.carrier ?? '',
		enabled: flag(section.enabled, true),
		reason: null
	}));
}

/**
 * Take an instance's rules off, and say what stopped it if anything did.
 *
 * Resolves to null on success and to a sentence otherwise. Every caller treats
 * a sentence as a refusal and changes nothing, because the alternative - write
 * the config anyway - is the state this whole function exists to avoid: rules
 * on the router that nothing left will admit to.
 */
function flushFirst(id) {
	return api.ask(api.calls.wanbindFlush, { instance: id }).then(result => {
		if (!result.ok)
			return result.error;

		const data = result.data ?? {};
		return (data.ok === false)
			? (data.reason ?? _('the router would not say why'))
			: null;
	});
}

function cannotFlush(id, why) {
	ui.addNotification(null, E('div', {}, [
		E('p', {}, _('Nothing was changed, because %s could not have its rules taken off first: %s').format(id, why)),
		E('p', {}, _('Rules left behind by an instance the daemon has stopped reading stay on the router with nothing to remove them. Run "bmwan flush --instance %s" at a console and try again.').format(id))
	]), 'error');
}

function whyText(row) {
	if (row.why === 'held')
		return _('Held out of the pool by hand');
	if (row.why === 'exhausted')
		return _('No priority left in this instance\'s range - it has to be widened');
	return _('Waiting for a WAN to come free');
}

return view.extend({
	load() {
		return Promise.all([
			api.ask(api.calls.agentInfo),
			uci.load('bm_wanbind').catch(() => null)
		]);
	},

	render(loaded) {
		const first = loaded[0];
		const banner = api.guardBanner();

		if (!first.ok) {
			return E([], [banner, bmui.notice(
				_('There is no agent on this router'),
				_('This page is drawn from what the router reports, and bm-agent did not answer: %s').format(first.error))]);
		}

		if (!api.has(first.data, 'binding')) {
			return E([], [banner, bmui.notice(
				_('bm-wanbind is not installed'),
				_('Without it this router binds nobody by itself. The Bored Manager app can still do it over SSH: it works, and it reconciles on a poll rather than on the lease, so a client waits up to one sweep for its WAN instead of a few milliseconds.'),
				E('p', {}, _('Install it from Router packages in the app, or with "apk add bm-wanbind" on this router.')))]);
		}

		const instances = E('div', {});
		const assignments = E('div', {});
		const waiting = E('div', {});

		const self = this;

		function refresh() {
			return Promise.all([
				api.ask(api.calls.wanbindInfo),
				api.ask(api.calls.wanbindAssignments, { instance: state.instance }),
				api.ask(api.calls.wanbindWaiting, { instance: state.instance })
			]).then(answers => {
				const info = answers[0].ok ? answers[0].data : null;
				const now = info ? api.routerNow(info) : 0;

				self.paintInstances(instances, answers[0], info, refresh);
				self.paintAssignments(assignments, answers[1], now, refresh);
				self.paintWaiting(waiting, answers[2], now, refresh);
			});
		}

		poll.add(refresh, 5);
		refresh();

		return E([], [
			banner,
			E('h2', {}, _('WAN Binding')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Every client on the LAN gets a WAN of its own, decided here on the router the moment its lease arrives.')),
			instances,
			assignments,
			waiting
		]);
	},

	paintInstances(node, result, info, refresh) {
		const configured = instanceRows(info);
		const running = {};
		const self = this;

		for (const one of (info && info.instances) ? info.instances : [])
			running[one.id] = one;

		const table = new ui.Table([
			_('Instance'), _('LAN'), _('Carrier'), _('State'), _('Bound'), _('Waiting'),
			_('Held'), _('Free WANs'), _('Clients seen'), _('Last pass'), ''
		], {
			id: 'bm-instances',
			captionClasses: [null, null, null, null, null, null, null, null, null, null, 'cbi-section-actions']
		}, E('em', {}, _('There is no instance yet. Add one with the button below; "bmwan check" reads them back from a console.')));

		table.update(configured.map(one => {
			const live = running[one.id];

			let dot;
			// The refusal first, because it is the one state where nothing
			// works and nothing else on the row explains why.
			if (one.reason)
				dot = bmui.dot('bad', one.reason);
			else if (!one.enabled)
				dot = bmui.dot('idle', _('switched off'));
			else if (!live)
				dot = bmui.dot('bad', _('configured, but the daemon has no state for it'));
			else if (!live.ready)
				dot = bmui.dot('busy', live.reason ?? _('not ready'));
			else
				dot = bmui.dot('ok', _('binding'));

			return [
				one.id,
				one.lan,
				one.carrier,
				dot,
				live ? '%d'.format(live.bound | 0) : '-',
				live ? '%d'.format(live.waiting | 0) : '-',
				live ? '%d'.format(live.held | 0) : '-',
				live ? '%d'.format(live.free | 0) : '-',
				live ? '%d'.format(live.devices | 0) : '-',
				(live && info) ? api.ago(live.lastPassAt, api.routerNow(info)) : '-',
				E('div', {}, [
					E('button', {
						'class': 'btn cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							state.instance = (state.instance === one.id) ? '' : one.id;
							return refresh();
						})
					}, state.instance === one.id ? _('Show all') : _('Show only this')),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							return self.askInstance(one.id, refresh);
						})
					}, _('Edit')),
					' ',
					E('button', {
						'class': one.enabled ? 'btn cbi-button-reset' : 'btn cbi-button-apply',
						'click': ui.createHandlerFn(self, function() {
							return self.toggle(one, refresh);
						})
					}, one.enabled ? _('Stop') : _('Start')),
					' ',
					E('button', {
						'class': 'btn cbi-button-remove',
						'click': ui.createHandlerFn(self, function() {
							return self.askDelete(one, refresh);
						})
					}, _('Delete'))
				])
			];
		}));

		dom.content(node, [
			!result.ok
				? E('p', { 'class': 'alert-message warning' }, [
					_('The bm-wanbind service is not answering, so the numbers below are missing: %s').format(result.error),
					E('br'),
					_('What is configured is still shown. Start it with "/etc/init.d/bm-wanbind start".')
				])
				: '',
			bmui.tableWrap(table.render()),
			bmui.toolbar([
				E('button', {
					'class': 'btn cbi-button-add',
					'click': ui.createHandlerFn(self, function() {
						return self.askInstance(null, refresh);
					})
				}, _('Add an instance'))
			]),
			E('div', { 'class': 'cbi-section-descr' },
				_('If the Bored Manager app is connected to this router it owns this list, and it will put its own value back on its next pass. Writing instances from here is meant for a router the app is not managing.'))
		]);
	},

	/**
	 * Write an instance, after taking its rules off if the change needs it.
	 *
	 * The three fields that are checked - the two priorities and the LAN - are
	 * the ones the rules already on the router were written against. Move any
	 * of them and the next pass looks in the wrong place, finds nothing of its
	 * own, and writes a second complete set; the first set stays, pointing at
	 * whatever those priorities used to mean. So they are taken off first and
	 * rebuilt, which costs bound clients a few seconds and costs nothing else.
	 *
	 * Everything else - sticky, remap, the three timers - only changes what the
	 * next decision is, so it is written straight through.
	 */
	writeInstance(id, values, needsFlush, refresh) {
		function write() {
			for (const key of Object.keys(values)) {
				if (values[key] === null)
					uci.unset('bm_wanbind', id, key);
				else
					uci.set('bm_wanbind', id, key, values[key]);
			}

			return uci.save()
				.then(() => uci.apply())
				.then(() => uci.unload('bm_wanbind'))
				.then(() => uci.load('bm_wanbind'))
				.then(() => refresh())
				.catch(error => {
					ui.addNotification(null, E('p', {},
						_('The change could not be applied: %s').format(error)), 'error');
				});
		}

		if (!needsFlush)
			return write();

		return flushFirst(id).then(why => {
			if (why) {
				cannotFlush(id, why);
				return null;
			}

			return write();
		});
	},

	/**
	 * Switch one instance on or off.
	 *
	 * Off has to flush first: the daemon decides what to look at by reading the
	 * config, so a section that is off is a section it never reads again, and
	 * its rules would sit on the router with nothing left that knows they are
	 * its. On does not - there is nothing to take off yet, and the daemon
	 * writes what it needs on its first pass.
	 */
	toggle(one, refresh) {
		return this.writeInstance(one.id, { enabled: one.enabled ? '0' : '1' }, one.enabled, refresh);
	},

	/** Remove an instance, rules first and the section after. */
	askDelete(one, refresh) {
		bmui.confirmTyped({
			title: _('Delete instance %s').format(one.id),
			body: [
				E('p', {}, _('Every client this instance was binding goes back to being routed the way the rest of the router routes, and its fail-closed catch-all goes with it.')),
				E('p', {}, _('Its ip rules are taken off before the section is removed. After the section is gone nothing knows they were its.'))
			],
			expected: one.id,
			actionLabel: _('Delete it'),
			run: function() {
				return flushFirst(one.id).then(why => {
					if (why) {
						cannotFlush(one.id, why);
						return null;
					}

					uci.remove('bm_wanbind', one.id);

					return uci.save()
						.then(() => uci.apply())
						.then(() => uci.unload('bm_wanbind'))
						.then(() => uci.load('bm_wanbind'))
						.then(() => {
							ui.addNotification(null, E('p', {},
								_('Instance %s is gone.').format(one.id)), 'info');
							return refresh();
						})
						.catch(error => {
							ui.addNotification(null, E('p', {},
								_('The change could not be applied: %s').format(error)), 'error');
						});
				});
			}
		});

		return Promise.resolve();
	},

	/**
	 * Add an instance, or edit one.
	 *
	 * The same form either way, because the same fields decide the same things
	 * and a separate read-only edit dialog would be two places to keep right.
	 * The name is the exception: it is the UCI section name, which is what
	 * every other surface calls this instance by, so it is fixed once written.
	 *
	 * Validated here against the same rules the daemon uses, not because the
	 * daemon's check can be skipped but because an instance the daemon refuses
	 * disappears from its own list - and being told the priority range is too
	 * narrow while typing it is a different experience from saving, applying,
	 * and finding a row that has gone quiet.
	 */
	askInstance(id, refresh) {
		const self = this;

		// Read the file before writing to it. The table above may have been
		// drawn from the daemon, which knows nothing about this browser's uci
		// cache - and a section LuCI has never loaded is a section `uci.set`
		// would be writing blind into.
		return uci.load('bm_wanbind').catch(() => null).then(() => {
			const existing = id ? uci.get('bm_wanbind', id) : null;

			if (id && !existing) {
				ui.addNotification(null, E('p', {},
					_('%s is not in /etc/config/bm_wanbind as this login can read it, so it cannot be edited from here.').format(id)), 'error');
				return null;
			}

			self.instanceForm(id, existing, refresh);
			return null;
		});
	},

	instanceForm(id, existing, refresh) {
		const self = this;

		function value(key, fallback) {
			const found = existing ? existing[key] : null;
			return (found === undefined || found === null || found === '') ? fallback : String(found);
		}

		const name = bmui.textInput(id ?? '', 'home', '10em');
		const lan = bmui.textInput(value('lan', 'lan'), 'lan', '10em');
		const carrier = bmui.textInput(value('carrier', ''), 'eth1', '10em');
		const sticky = bmui.checkbox(flag(existing ? existing.sticky : null, true));
		const remap = bmui.checkbox(flag(existing ? existing.remap : null, true));
		const prefBase = bmui.textInput(value('rule_pref_base', '20000'), '20000', '8em');
		const catchPref = bmui.textInput(value('catch_all_pref', '30000'), '30000', '8em');
		const catchTable = bmui.textInput(value('catch_all_table', '253'), '253', '8em');
		const warnUptime = bmui.textInput(value('wan_warn_uptime', '5'), '5', '6em');
		const errorGrace = bmui.textInput(value('wan_error_grace', '20'), '20', '6em');
		const releaseGrace = bmui.textInput(value('release_grace', '120'), '120', '6em');

		const status = E('div', { 'style': 'margin:.5em 0' });

		function refuse(text) {
			dom.content(status, E('p', { 'class': 'alert-message warning' }, text));
			return null;
		}

		/** The same refusals bm.wanbind.config makes, in the same order. */
		function collect() {
			const sectionName = name.value.trim();

			if (!id && !/^[a-zA-Z0-9_]{1,32}$/.test(sectionName))
				return refuse(_('The name has to be 1 to 32 letters, digits or underscores.'));

			if (!id && uci.get('bm_wanbind', sectionName))
				return refuse(_('This router already has an instance called %s.').format(sectionName));

			if (!lan.value.trim().length)
				return refuse(_('Name the LAN interface. Without it there is no subnet to bind clients from.'));

			if (!carrier.value.trim().length)
				return refuse(_('Name the carrier device. Without it there are no WANs to hand out.'));

			const base = bmui.whole(prefBase);
			const catchAt = bmui.whole(catchPref);
			const table = bmui.whole(catchTable);
			const warn = bmui.whole(warnUptime);
			const grace = bmui.whole(errorGrace);
			const release = bmui.whole(releaseGrace);

			if (base === null || catchAt === null || table === null ||
				warn === null || grace === null || release === null)
				return refuse(_('Every number on this form has to be a whole number.'));

			if (base < 1 || base > 2147483647)
				return refuse(_('%d is not an ip rule priority.').format(base));

			if (catchAt <= base)
				return refuse(_('The client rule priority has to be below the catch-all priority, or there is no range to write client rules in.'));

			if (catchAt - base < MIN_PREF_SPAN)
				return refuse(_('Only %d priorities between the two, and at least %d are needed. That number is also the most clients this instance can seat.').format(catchAt - base, MIN_PREF_SPAN));

			if (table < 1 || table > 65535)
				return refuse(_('%d is not a routing table number.').format(table));

			if (table === 254 || table === 255)
				return refuse(_('Table %d is the router\'s own main or local table. Putting an unreachable default in it would take the router off the network.').format(table));

			return {
				sectionName: sectionName,
				values: {
					lan: lan.value.trim(),
					carrier: carrier.value.trim(),
					sticky: sticky.checked ? '1' : '0',
					remap: remap.checked ? '1' : '0',
					rule_pref_base: String(base),
					catch_all_pref: String(catchAt),
					catch_all_table: String(table),
					wan_warn_uptime: String(warn),
					wan_error_grace: String(grace),
					release_grace: String(release)
				}
			};
		}

		function submit() {
			const collected = collect();
			if (!collected)
				return Promise.resolve();

			ui.hideModal();

			if (!id) {
				uci.add('bm_wanbind', 'instance', collected.sectionName);
				collected.values.enabled = '1';
				return self.writeInstance(collected.sectionName, collected.values, false, refresh);
			}

			// Only these three were written into the rules that already exist.
			const moved = existing && (
				String(existing.rule_pref_base ?? '20000') !== collected.values.rule_pref_base ||
				String(existing.catch_all_pref ?? '30000') !== collected.values.catch_all_pref ||
				String(existing.lan ?? '') !== collected.values.lan);

			return self.writeInstance(id, collected.values, !!moved, refresh);
		}

		ui.showModal(id ? _('Edit instance %s').format(id) : _('Add an instance'), [
			E('p', {}, _('One instance is one LAN and one pool of WANs on one carrier device. A router with two independent pools has two of these; most have one.')),
			bmui.field(_('Name'), id ? E('em', {}, id) : name,
				id ? _('The section name, which every other surface calls this instance by. It cannot be changed.') : _('Letters, digits and underscores.')),
			bmui.field(_('LAN interface'), lan, _('The UCI interface name of the LAN whose clients are bound. Its subnet is read from the router.')),
			bmui.field(_('Carrier device'), carrier, _('The device the WAN pool sits on. Every interface on it or on a VLAN of it is in the pool.')),
			bmui.field(_('Remember each client\'s WAN'), sticky, _('Give a client the same WAN back when it returns, if that WAN is free.')),
			bmui.field(_('Move a client off a failing WAN'), remap, _('Off means it waits for its own WAN to come back.')),
			bmui.field(_('Client rule priority'), prefBase, _('Client rules are written from here upwards. At least %d below the catch-all, which is also the most clients this instance can seat.').format(MIN_PREF_SPAN)),
			bmui.field(_('Catch-all priority'), catchPref, _('Where the fail-closed rule sits. Nothing outside this range is ever touched.')),
			bmui.field(_('Catch-all table'), catchTable, _('The routing table holding "unreachable default". A client with no WAN lands here and is blocked, rather than leaking out of whichever WAN the router would have picked.')),
			bmui.field(_('WAN settle time'), warnUptime, _('Seconds a WAN has to have been up before it is handed to a client. Freshly dialled PPPoE sessions come up before they carry traffic.')),
			bmui.field(_('Failure grace'), errorGrace, _('Seconds a WAN has to have been failing before a client is moved off it.')),
			bmui.field(_('Lease grace'), releaseGrace, _('Seconds a client keeps its WAN after its lease disappears. Covers a reboot, a cable pulled for a minute, and dnsmasq restarting.')),
			id
				? E('p', {}, _('Changing the LAN or either priority takes this instance\'s rules off before the change and lets the daemon write them again. Bound clients lose their route for a few seconds.'))
				: '',
			status,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-apply',
					'click': ui.createHandlerFn(self, submit)
				}, id ? _('Save') : _('Add it'))
			])
		]);

		return Promise.resolve();
	},

	paintAssignments(node, result, now, refresh) {
		if (!result.ok) {
			dom.content(node, bmui.section(_('Assignments'), null,
				E('p', { 'class': 'alert-message warning' }, result.error)));
			return;
		}

		const rows = result.data.assignments ?? [];
		const self = this;

		const table = new ui.Table([
			_('Client'), _('IP'), _('Hostname'), _('WAN'), _('Rule'), _('Table'), _('Since'), ''
		], {
			id: 'bm-assignments',
			captionClasses: [null, null, null, null, null, null, null, 'cbi-section-actions']
		}, E('em', {}, _('Nobody is bound. Either no client has taken a lease yet, or every WAN is down - the Waiting table below says which.')));

		table.update(rows.map(row => [
			row.mac,
			(row.ip && row.ip.length) ? row.ip : '-',
			(row.host && row.host.length) ? row.host : '-',
			row.wan,
			'%d'.format(row.pref | 0),
			'%d'.format(row.table | 0),
			api.ago(row.assignedAt, now),
			E('div', {}, [
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(self, function() {
						return api.run(api.calls.wanbindReassign, { instance: row.instance, mac: row.mac },
							_('Asked the router to move %s off %s.').format(row.mac, row.wan)).then(refresh);
					})
				}, _('Move')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(self, function() {
						return self.askPin(row, refresh);
					})
				}, _('Pin')),
				' ',
				E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(self, function() {
						return api.run(api.calls.wanbindUnassign, { instance: row.instance, mac: row.mac },
							_('%s is held out of the pool.').format(row.mac)).then(refresh);
					})
				}, _('Hold'))
			])
		]));

		dom.content(node, bmui.section(_('Assignments'),
			_('Move puts a client on a different WAN and forgets its sticky choice; Pin keeps it on one; Hold takes it out of the pool until it is let back in.'),
			bmui.tableWrap(table.render())));
	},

	/**
	 * Which WAN to pin to, typed rather than chosen.
	 *
	 * The daemon does not publish the list of WANs it can hand out, and `bmwan
	 * pin MAC WAN` at a console asks for the same thing in the same way. Rather
	 * than invent a list from the WANs that happen to be in use - which are
	 * exactly the ones that are not free - this asks, and lets the daemon
	 * answer if the name is not one of its own.
	 */
	askPin(row, refresh) {
		const field = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'width:14em',
			'placeholder': row.wan
		});

		ui.showModal(_('Pin %s').format(row.mac), [
			E('p', {}, _('Name the WAN interface to keep this client on. It is on %s now.').format(row.wan)),
			E('p', {}, _('Whoever is on that WAN loses it and goes back in the queue.')),
			field,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-apply',
					'click': ui.createHandlerFn(this, function() {
						const wan = field.value.trim();

						if (!wan.length) {
							ui.addNotification(null, E('p', {}, _('Name a WAN first.')), 'warning');
							return Promise.resolve();
						}

						ui.hideModal();
						return api.run(api.calls.wanbindPin,
							{ instance: row.instance, mac: row.mac, wan: wan },
							_('%s is pinned to %s.').format(row.mac, wan)).then(refresh);
					})
				}, _('Pin it'))
			])
		]);

		return Promise.resolve();
	},

	paintWaiting(node, result, now, refresh) {
		if (!result.ok) {
			dom.content(node, bmui.section(_('Waiting'), null,
				E('p', { 'class': 'alert-message warning' }, result.error)));
			return;
		}

		const rows = result.data.waiting ?? [];
		const self = this;

		const table = new ui.Table([
			_('Client'), _('IP'), _('Hostname'), _('Place'), _('Since'), _('Why'), ''
		], {
			id: 'bm-waiting',
			captionClasses: [null, null, null, null, null, null, 'cbi-section-actions']
		}, E('em', {}, _('Nobody is waiting: every client the router has seen has a WAN.')));

		table.update(rows.map(row => [
			row.mac,
			(row.ip && row.ip.length) ? row.ip : '-',
			(row.host && row.host.length) ? row.host : '-',
			row.held ? '-' : '%d'.format(row.order | 0),
			row.held ? '-' : api.ago(row.since, now),
			whyText(row),
			row.held
				? E('button', {
					'class': 'btn cbi-button-apply',
					'click': ui.createHandlerFn(self, function() {
						return api.run(api.calls.wanbindRelease, { instance: row.instance, mac: row.mac },
							_('%s is back in the pool.').format(row.mac)).then(refresh);
					})
				}, _('Let back in'))
				: ''
		]));

		dom.content(node, [
			bmui.section(_('Waiting'),
				_('Clients with no WAN, in the order they asked. A client the pool cannot seat is blocked rather than quietly sent out of whichever WAN the router would have used.'),
				bmui.tableWrap(table.render())),
			bmui.toolbar([
				E('button', {
					'class': 'btn cbi-button-neutral',
					'click': ui.createHandlerFn(self, function() {
						return api.run(api.calls.wanbindReconcile, { instance: state.instance },
							_('The router has run a full pass.')).then(refresh);
					})
				}, _('Run a pass now')),
				' ',
				E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(self, function() {
						if (!confirm(_('Remove every ip rule this package wrote? Every bound client loses its route until the next pass puts it back, and the fail-closed catch-all goes too.')))
							return Promise.resolve();

						return api.run(api.calls.wanbindFlush, { instance: state.instance },
							_('The rules are off the router.')).then(refresh);
					})
				}, _('Remove every rule'))
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
