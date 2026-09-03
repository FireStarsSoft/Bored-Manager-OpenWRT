'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require bm.api as api';
'require bm.ui as bmui';

/*
 * The PPPoE Dialer: one card per pool, one row per member, and nothing hidden.
 *
 * The table under each pool is driven by the pool's record, not by what
 * netifd happens to mention: a member whose section is missing from
 * /etc/config/network is a row saying "unwritten", not a row that vanished.
 * That is the whole lesson of the old model, where configuration that could
 * not be seen was configuration nobody could question.
 *
 * Everything here goes through bm.pppoe. Creating and editing both run the
 * same two steps - pool_check first, findings shown, then pool_add or
 * pool_set - so the refusal a person reads in this page is the same sentence
 * the app and the CLI would have shown them. Credentials travel inline over
 * the ubus socket, which never puts them in any command line; the ACL grants
 * pool_add and pool_set and not pool_create, which names files for the daemon
 * to read and unlink as root.
 */

const ACTION_LIMIT = 500;

const MODES = [
	['multi', _('Shared account')],
	['single', _('One account per VLAN')]
];

const CARRIER_MODES = [
	['vlan', _('VLAN - one 802.1Q tag per member')],
	['direct', _('Direct - dial the carrier itself, untagged')]
];

const state = {
	info: null,
	rows: [],
	rowsError: null,
	limitHit: false
};

function stateDot(status) {
	if (status === 'up') return bmui.dot('ok', _('up'));
	if (status === 'dialing') return bmui.dot('busy', _('dialing'));
	if (status === 'error') return bmui.dot('bad', _('error'));
	if (status === 'unwritten') return bmui.dot('bad', _('unwritten'));
	if (status === 'stopped') return bmui.dot('idle', _('stopped'));
	return bmui.dot('idle', _('down'));
}

/*
 * `101-150,200,0` -> [0, 101..150, 200]. The multi-mode member list: ranges
 * and single numbers, commas or whitespace between them, 0 meaning untagged.
 */
function parseVlans(text) {
	const vlans = [];
	const errors = [];
	const seen = {};

	String(text ?? '').split(/[\s,]+/).forEach(function(token) {
		if (!token.length)
			return;

		const range = token.match(/^([0-9]{1,4})-([0-9]{1,4})$/);
		const single = token.match(/^[0-9]{1,4}$/);

		let from, to;
		if (range) {
			from = Number(range[1]);
			to = Number(range[2]);
		}
		else if (single) {
			from = to = Number(token);
		}
		else {
			errors.push(_('"%s" is not a VLAN or a range like 101-150').format(token));
			return;
		}

		if (to < from || from < 0 || to > 4094) {
			errors.push(_('"%s" is outside 0-4094').format(token));
			return;
		}

		for (let vlan = from; vlan <= to; vlan++) {
			if (seen[vlan]) {
				errors.push(_('VLAN %d appears twice').format(vlan));
				return;
			}
			seen[vlan] = true;
			vlans.push(vlan);
		}
	});

	return { vlans: vlans, errors: errors };
}

/*
 * One member per line: `vlan, username, password`, separated by a tab, a
 * comma, a semicolon, a pipe or spaces; `#` starts a comment. The password
 * may be left empty for a member the pool already has - it keeps its stored
 * one - which is what lets an edit change the list without retyping secrets.
 */
function splitLine(line) {
	if (line.indexOf('\t') >= 0) return line.split(/\t+/).map(part => part.trim());
	if (line.indexOf(',') >= 0) return line.split(',').map(part => part.trim());
	if (line.indexOf(';') >= 0) return line.split(';').map(part => part.trim());
	if (line.indexOf('|') >= 0) return line.split('|').map(part => part.trim());
	return line.trim().split(/\s+/);
}

function parseMembers(text) {
	const members = [];
	const errors = [];
	const seen = {};

	String(text ?? '').split(/\r?\n/).forEach(function(raw, offset) {
		const line = raw.trim();
		if (!line.length || line.charAt(0) === '#')
			return;

		const fields = splitLine(line);
		if (fields.length < 2 || fields.length > 3) {
			errors.push(_('line %d: expected VLAN, username and password').format(offset + 1));
			return;
		}

		const vlan = Number(fields[0]);
		if (!Number.isInteger(vlan) || vlan < 0 || vlan > 4094) {
			errors.push(_('line %d: the VLAN has to be 0 to 4094').format(offset + 1));
			return;
		}
		if (seen[vlan]) {
			errors.push(_('line %d: VLAN %d appears twice').format(offset + 1, vlan));
			return;
		}
		seen[vlan] = true;

		const member = { vlan: vlan, user: fields[1] ?? '' };
		if (fields.length > 2 && fields[2].length)
			member.pass = fields[2];

		members.push(member);
	});

	return { members: members, errors: errors };
}

/** [0, 101, 102, 103, 200] -> "0,101-103,200", for prefilled edit forms. */
function compressVlans(vlans) {
	const sorted = vlans.slice().sort((a, b) => a - b);
	const parts = [];

	for (let i = 0; i < sorted.length; i++) {
		let end = i;
		while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1)
			end++;

		parts.push(end > i ? '%d-%d'.format(sorted[i], sorted[end]) : '%d'.format(sorted[i]));
		i = end;
	}

	return parts.join(',');
}

return view.extend({
	load() {
		return api.ask(api.calls.agentInfo);
	},

	render(first) {
		const banner = api.guardBanner();

		if (!first.ok) {
			return E([], [banner, bmui.notice(
				_('There is no agent on this router'),
				_('This page is drawn from what the router reports, and bm-agent did not answer: %s').format(first.error))]);
		}

		if (!api.has(first.data, 'pppoe')) {
			return E([], [banner, bmui.notice(
				_('bm-pppoe-pool is not installed'),
				_('Without it this router dials no pools. Install it from Router packages in the Bored Manager app, or with "apk add bm-pppoe-pool" on this router.'))]);
		}

		const content = E('div', {});
		const self = this;

		/**
		 * Every member of every pool, page by page.
		 *
		 * One call carries five hundred rows and that is a cap on the call, not
		 * on the router: two pools of five hundred are a thousand members, and
		 * the page used to show the first five hundred with a banner saying the
		 * rest were "shown incomplete". It pages until the daemon says it has
		 * sent the last of them.
		 */
		function walkSessions(collected, offset, pages) {
			return api.ask(api.calls.poolSessions, { id: '', scope: 'all', offset: offset })
				.then(function(result) {
					if (!result.ok) {
						state.rowsError = result.error;
						return null;
					}

					const data = result.data || {};
					const rows = Array.isArray(data.sessions) ? data.sessions : [];
					const seen = collected.concat(rows);
					const total = (data.total == null) ? seen.length : (data.total | 0);
					const done = !rows.length || seen.length >= total || pages + 1 >= 8;

					if (!done)
						return walkSessions(seen, seen.length, pages + 1);

					state.rows = seen;
					state.limitHit = seen.length < total;
					state.rowsError = null;
					return null;
				});
		}

		function refresh() {
			return Promise.all([
				api.ask(api.calls.poolInfo, { members: true }),
				walkSessions([], 0, 0)
			]).then(answers => {
				if (answers[0].ok) {
					state.info = answers[0].data;
				}

				self.paint(content);
			});
		}

		self.refresh = refresh;

		poll.add(refresh, 5);
		refresh();

		return E([], [
			banner,
			E('h2', {}, _('PPPoE Dialer')),
			E('div', { 'class': 'cbi-map-descr' },
				_('A pool is one carrier and a list of members, each dialling its own PPPoE session with its own routing table. Members are VLANs, or plain slots when the pool dials the carrier itself. Everything about it - interfaces, devices, MAC addresses, the firewall zone - is derived from the pool by the router itself.')),
			content
		]);
	},

	paint(node) {
		const info = state.info;

		if (!info) {
			dom.content(node, E('p', { 'class': 'spinning' }, _('Asking the router...')));
			return;
		}

		if ((info.apiVersion | 0) < 2) {
			dom.content(node, bmui.notice(
				_('bm-pppoe-pool %s is too old for this page').format(info.release ?? '?'),
				_('This page drives the pool-of-VLANs model, which arrived with 2.0.0 (API 2). Update the router packages from the Bored Manager app, or with "apk add bm-pppoe-pool" against a 2.x feed.')));
			return;
		}

		const pools = info.pools ?? [];
		const legacy = info.legacy ?? [];
		const tally = { members: 0, up: 0, dialing: 0, down: 0, error: 0, stopped: 0, unwritten: 0 };

		for (const one of pools) {
			tally.members += one.members | 0;
			tally.up += one.up | 0;
			tally.dialing += one.dialing | 0;
			tally.down += one.down | 0;
			tally.error += one.error | 0;
			tally.stopped += one.stopped | 0;
			tally.unwritten += one.unwritten | 0;
		}

		const blocks = [
			bmui.tiles([
				[_('Pools'), '%d'.format(pools.length)],
				[_('Interfaces'), '%d'.format(tally.members)],
				[_('Up'), '%d'.format(tally.up)],
				[_('Dialing'), '%d'.format(tally.dialing)],
				[_('Error'), '%d'.format(tally.error)],
				[_('Stopped'), '%d'.format(tally.stopped)],
				[_('Unwritten'), '%d'.format(tally.unwritten)]
			]),
			this.toolbar()
		];

		if (state.rowsError)
			blocks.push(E('p', { 'class': 'alert-message warning' }, state.rowsError));

		if (legacy.length)
			blocks.push(this.legacyBlock(legacy));

		if (!pools.length) {
			blocks.push(bmui.notice(
				_('This router has no pools yet'),
				_('Create one with the button above, from the Bored Manager app, or with "bmpppoe create" at a console.')));
		}

		for (const pool of pools)
			blocks.push(this.poolCard(pool));

		// Only after the paging above has given up, which on this router means
		// more than four thousand members.
		if (state.limitHit) {
			blocks.push(E('p', { 'class': 'alert-message warning' },
				_('This router has more members than this page will list. The ones above are the first of them; "bmpppoe list" at a console reads the rest.')));
		}

		// The pool daemon running on events alone. Every state below is the last
		// thing netifd said, so a session that dropped since still reads up.
		if (info.blind) {
			blocks.push(bmui.riskNote(
				_('netifd is not answering this daemon\'s interface dump (%d failed attempts). Every state below is the last one it saw: a session that has dropped since would still read up here.').format(
					(info.blind.failures | 0))));
		}

		blocks.push(this.settingsBlock(info.settings ?? {}));

		dom.content(node, blocks);
	},

	toolbar() {
		const self = this;

		return bmui.toolbar([
			E('button', {
				'class': 'btn cbi-button-add',
				'click': ui.createHandlerFn(self, function() {
					return self.openEditor(null);
				})
			}, _('Create a pool')),
			E('button', {
				'class': 'btn cbi-button-neutral',
				'click': ui.createHandlerFn(self, function() {
					return api.run(api.calls.poolReconcile, {}, _('The router has re-read netifd and the counters.'))
						.then(() => self.refresh());
				})
			}, _('Refresh from netifd')),
			offloadButton()
		]);

		/**
		 * The switch the create check refuses past sixty-four members without.
		 *
		 * Rendered only where the router says it is off, because a button that
		 * turns on something already on is a button that teaches somebody the
		 * page does not know what the router is doing. The daemon never writes
		 * the firewall itself, deliberately - this is the one place it is
		 * offered, and it is a person pressing it.
		 */
		function offloadButton() {
			const router = (state.info || {}).router || {};

			if (router.flowOffload !== false) return '';

			return E('button', {
				'class': 'btn cbi-button-apply',
				'click': ui.createHandlerFn(self, function() {
					if (!confirm(_('Turn on fw4 software flow offload? The firewall config is committed and fw4 reloaded, which briefly interrupts new connections. Above 64 sessions the router otherwise evaluates every policy rule for every packet.')))
						return Promise.resolve();

					return api.run(api.calls.tuneSet, { flow_offload: true },
						_('Flow offload is on and the firewall was reloaded.'))
						.then(() => self.refresh());
				})
			}, _('Enable flow offload'));
		}
	},

	/** The pools the old model wrote: shown, explained, and only deletable. */
	legacyBlock(legacy) {
		const self = this;

		const table = new ui.Table([
			_('Pool'), _('Prefix'), _('Carrier'), _('Sessions'), ''
		], { id: 'bm-legacy-pools' });

		table.update(legacy.map(one => [
			one.id,
			one.prefix,
			one.carrier,
			'%d'.format(one.count | 0),
			E('button', {
				'class': 'btn cbi-button-remove',
				'click': ui.createHandlerFn(self, function() {
					return self.confirmDelete({ id: one.id, members: one.count | 0, legacy: true });
				})
			}, _('Delete'))
		]));

		return E('div', { 'class': 'alert-message warning' }, [
			E('h4', {}, _('Pools from the old model')),
			E('p', {}, _('These were created by an earlier release as numbered session runs. This release neither edits nor watches them: delete each one and create it again as a pool of VLANs. Deleting removes its interfaces exactly as the old release would have.')),
			bmui.tableWrap(table.render())
		]);
	},

	/** One pool: its header, its always-complete member table, its buttons. */
	poolCard(pool) {
		const self = this;
		const rows = state.rows.filter(row => row.pool === pool.id);
		const sections = rows.map(row => row.section);

		const direct = pool.carrier_mode === 'direct';

		const account = pool.mode === 'multi'
			? _('account %s').format(pool.username || '?')
			: (direct ? _('one account per slot') : _('one account per VLAN'));

		const macness = pool.mac_mode === 'auto'
			? (direct ? _('per-slot MACs') : _('per-VLAN MACs'))
			: _('carrier MAC');

		const header = E('div', { 'class': 'bm-pool-head' }, [
			E('h3', {}, pool.label && pool.label.length ? '%s (%s)'.format(pool.label, pool.id) : pool.id),
			E('span', {
				'class': 'bm-pill bm-mode--%s'.format(pool.mode === 'multi' ? 'multi' : 'single')
			}, pool.mode === 'multi' ? _('shared account') : (direct ? _('per-slot accounts') : _('per-VLAN accounts'))),
			E('span', {
				'class': 'bm-pill bm-mode--%s'.format(direct ? 'direct' : 'vlan')
			}, direct ? _('direct') : _('VLAN')),
			E('span', { 'style': 'opacity:.8' }, _('on %s').format(pool.carrier)),
			E('span', { 'style': 'opacity:.8' }, account),
			E('span', { 'style': 'opacity:.8' }, macness),
			E('span', { 'style': 'opacity:.8' },
				_('%d up, %d error, %d stopped of %d').format(pool.up | 0, pool.error | 0, pool.stopped | 0, pool.members | 0)),
			E('span', { 'style': 'opacity:.8' },
				api.rate((((pool.rate && pool.rate.rxBps) || 0) + ((pool.rate && pool.rate.txBps) || 0)) * 8))
		]);

		function bulk(action, label, confirmText) {
			return E('button', {
				'class': 'btn cbi-button-action',
				'click': ui.createHandlerFn(self, function() {
					if (!sections.length)
						return Promise.resolve();
					if (confirmText && !confirm(confirmText.format(sections.length)))
						return Promise.resolve();

					return api.run(api.calls.poolAction,
						{ action: action, sections: sections.slice(0, ACTION_LIMIT) },
						_('Asked the router to %s %d interface(s).').format(label, sections.length))
						.then(() => self.refresh());
				})
			}, label);
		}

		const buttons = bmui.toolbar([
			bulk('up', _('Start all'), null),
			bulk('down', _('Stop all'), _('Stop all %d interface(s)? Anybody using them loses their connection.')),
			bulk('redial', _('Redial all'), _('Redial all %d interface(s)? Each one drops and dials again.')),
			E('button', {
				'class': 'btn cbi-button-action',
				'click': ui.createHandlerFn(self, function() {
					return self.openEditor(pool);
				})
			}, _('Edit')),
			E('button', {
				'class': 'btn cbi-button-remove',
				'click': ui.createHandlerFn(self, function() {
					return self.confirmDelete(pool);
				})
			}, _('Delete'))
		]);

		const table = new ui.Table([
			_('Section'), direct ? _('Slot') : _('VLAN'), _('Device'), _('Username'), _('MAC'), _('IPv4'),
			_('Table'), _('State'), _('Error'), ''
		], {
			id: 'bm-pool-%s'.format(pool.id),
			captionClasses: [null, null, null, null, null, null, null, null, null, 'cbi-section-actions']
		}, E('em', {}, _('The row list has not arrived yet.')));

		table.update(rows.map(row => [
			row.section,
			'%d'.format(row.vlan | 0),
			row.device,
			row.username || '-',
			row.mac || '-',
			row.ip || '-',
			'%d'.format(row.table | 0),
			stateDot(row.status),
			row.errorCode || '',
			this.rowActions(row)
		]));

		return E('div', { 'class': 'cbi-section bm-section' }, [header, buttons, bmui.tableWrap(table.render())]);
	},

	rowActions(row) {
		const self = this;

		function act(action, label, confirmText, cls) {
			return E('button', {
				'class': 'btn %s'.format(cls ?? 'cbi-button-action'),
				'style': 'margin-right:.25em',
				'click': ui.createHandlerFn(self, function() {
					if (confirmText && !confirm(confirmText.format(row.section)))
						return Promise.resolve();

					return api.run(api.calls.poolAction, { action: action, sections: [row.section] },
						_('%s: asked the router to %s.').format(row.section, label))
						.then(() => self.refresh());
				})
			}, label);
		}

		const toggle = row.status === 'stopped'
			? act('enable', _('Enable'), null, 'cbi-button-apply')
			: act('disable', _('Disable'), _('Disable %s? It stops now and stays stopped across reboots.'), 'cbi-button-remove');

		return E('div', {}, [
			act('up', _('Up'), null),
			act('down', _('Down'), _('Take %s down? Anybody using it loses their connection.')),
			act('redial', _('Redial'), _('Redial %s? It drops and dials again.')),
			toggle
		]);
	},

	/**
	 * Create and edit are one form. `pool` is null for a create; for an edit
	 * the fields arrive filled from the pool's own record, the immutable ones
	 * disabled with the reason beside them, and only what changed is sent.
	 */
	openEditor(pool) {
		const self = this;
		const creating = !pool;

		return api.ask(api.calls.poolCarriers).then(function(answer) {
			const carriers = (answer.ok && answer.data.ok !== false) ? (answer.data.carriers ?? []) : [];
			self.editorModal(pool, creating, carriers);
		});
	},

	editorModal(pool, creating, carriers) {
		const self = this;

		// ---- identity
		const supportsDirect = ((state.info && state.info.apiVersion) | 0) >= 3;

		const modeSelect = bmui.selectInput(MODES, creating ? 'multi' : pool.mode);
		if (!creating) modeSelect.disabled = true;

		const carrierModeSelect = bmui.selectInput(CARRIER_MODES,
			creating ? 'vlan' : (pool.carrier_mode === 'direct' ? 'direct' : 'vlan'));
		if (!creating || !supportsDirect) carrierModeSelect.disabled = true;

		const idInput = bmui.textInput(creating ? '' : pool.id, 'fpt1', '10em', !creating);
		const labelInput = bmui.textInput(creating ? '' : (pool.label ?? ''), _('optional'), '18em');
		const prefixInput = bmui.textInput(creating ? '' : pool.prefix, 'fpt', '6em', !creating);

		const carrierOptions = carriers.map(one => [one.name, '%s%s'.format(one.name, one.up ? '' : ' ' + _('(down)'))]);
		const currentCarrier = creating ? (carrierOptions.length ? carrierOptions[0][0] : '') : pool.carrier;
		if (currentCarrier && !carrierOptions.some(entry => entry[0] === currentCarrier))
			carrierOptions.unshift([currentCarrier, currentCarrier]);
		const carrierSelect = carrierOptions.length
			? bmui.selectInput(carrierOptions, currentCarrier)
			: bmui.textInput(currentCarrier, 'eth1', '10em');

		const macSelect = bmui.selectInput([
			['auto', _('auto - one derived MAC per member')],
			['inherit', _('inherit - every member keeps the carrier MAC')]
		], creating ? 'auto' : pool.mac_mode);

		const tableBaseInput = bmui.textInput(creating ? '10000' : '%d'.format(pool.table_base | 0), '10000', '8em');

		// ---- accounts and members
		const usernameInput = bmui.textInput(creating ? '' : (pool.username ?? ''), 'user@isp', '14em');
		const passwordInputNode = bmui.passwordInput(creating ? '' : _('unchanged if left empty'));

		const memberVlans = creating ? [] : (pool.memberList ?? []).map(one => one.vlan | 0);
		const vlanBox = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': '3',
			'style': 'width:100%;font-family:monospace',
			'placeholder': '101-150,200,0'
		}, creating ? '' : compressVlans(memberVlans));

		const memberLines = creating ? '' : (pool.memberList ?? [])
			.map(one => '%d,%s,'.format(one.vlan | 0, one.username ?? ''))
			.join('\n');
		const memberBox = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': '6',
			'style': 'width:100%;font-family:monospace',
			'placeholder': '101,line101@isp,secret\n102,line102@isp,secret2'
		}, memberLines);

		// ---- general
		const serviceInput = bmui.textInput(creating ? '' : (pool.service ?? ''), _('auto'), '12em');
		const acInput = bmui.textInput(creating ? '' : (pool.ac ?? ''), _('auto'), '12em');
		const acMacInput = bmui.textInput(creating ? '' : (pool.ac_mac ?? ''), _('auto'), '12em');

		// ---- advanced
		const mtuInput = bmui.textInput(creating || !(pool.mtu | 0) ? '' : '%d'.format(pool.mtu), '1492', '6em');
		const keepalive = String((creating ? '' : pool.keepalive) ?? '').match(/^([0-9]+)(?:[ ,]([0-9]+))?$/);
		const kaFailInput = bmui.textInput(keepalive ? keepalive[1] : '', '5', '5em');
		const kaIntInput = bmui.textInput(keepalive && keepalive[2] ? keepalive[2] : '', '1', '5em');
		const ipv6Select = bmui.selectInput([
			['0', _('Disabled')], ['auto', _('Automatic')], ['1', _('Manual')]
		], creating ? '0' : (pool.ipv6 ?? '0'));
		const peerdnsCheck = bmui.checkbox(creating ? false : pool.peerdns === true);
		const dnsInput = bmui.textInput(creating ? '' : (pool.dns ?? []).join(' '), '1.1.1.1 8.8.8.8', '20em');
		const defaultrouteCheck = bmui.checkbox(creating ? true : pool.defaultroute !== false);
		const hostUniqInput = bmui.textInput(creating ? '' : (pool.host_uniq ?? ''), _('empty unless the ISP requires it'), '14em');
		const demandInput = bmui.textInput(creating || !(pool.demand | 0) ? '' : '%d'.format(pool.demand), '0', '6em');
		const padiAttemptsInput = bmui.textInput(creating || !(pool.padi_attempts | 0) ? '' : '%d'.format(pool.padi_attempts), _('default'), '6em');
		const padiTimeoutInput = bmui.textInput(creating || !(pool.padi_timeout | 0) ? '' : '%d'.format(pool.padi_timeout), _('default'), '6em');
		const pppdInput = bmui.textInput(creating ? '' : (pool.pppd_options ?? ''), '', '24em');

		// ---- firewall
		const zoneInput = bmui.textInput(creating ? 'bmwanpool' : pool.zone, 'bmwanpool', '10em');
		const masqCheck = bmui.checkbox(creating ? true : pool.masq !== false);
		const mtuFixCheck = bmui.checkbox(creating ? true : pool.mtu_fix !== false);
		const lanForwardCheck = bmui.checkbox(creating ? true : pool.lan_forward !== false);

		const status = E('div', { 'style': 'margin:.5em 0' });
		const buttons = E('div', { 'class': 'right' });

		// Which member editor is on show follows the mode. `conditional`
		// rendering by hand, because the two modes ask for different things.
		const vlanField = bmui.field(_('VLANs'), vlanBox,
			_('Ranges and numbers: 101-150,200. VLAN 0 means untagged, straight over the carrier, at most once.'));
		const memberField = bmui.field(_('Members'), memberBox,
			_('One per line: VLAN, username, password - separated by a comma, a tab, a semicolon, a pipe or spaces. # starts a comment. On an edit, an empty password keeps the stored one.'));

		const multiBlock = E('div', {}, [
			bmui.field(_('Username'), usernameInput, _('The one account every member dials with.')),
			bmui.field(_('Password'), passwordInputNode,
				creating ? '' : _('Leave empty to keep the stored password.')),
			vlanField
		]);

		const singleBlock = E('div', {}, [memberField]);

		function syncMode() {
			const multi = modeSelect.value === 'multi';
			multiBlock.style.display = multi ? '' : 'none';
			singleBlock.style.display = multi ? 'none' : '';
		}

		function syncCarrier() {
			const direct = carrierModeSelect.value === 'direct';
			const vlanTitle = vlanField.querySelector('.cbi-value-title');
			const vlanHint = vlanField.querySelector('.cbi-value-description');
			const memberTitle = memberField.querySelector('.cbi-value-title');
			const memberHint = memberField.querySelector('.cbi-value-description');

			if (vlanTitle)
				vlanTitle.textContent = direct ? _('Slots') : _('VLANs');
			if (vlanHint) {
				vlanHint.textContent = direct
					? _('Slot numbers 1-4094: 1-32,40. Direct mode has no VLAN 0 - every member dials the carrier itself.')
					: _('Ranges and numbers: 101-150,200. VLAN 0 means untagged, straight over the carrier, at most once.');
			}
			if (memberTitle)
				memberTitle.textContent = _('Members');
			if (memberHint) {
				memberHint.textContent = direct
					? _('One per line: slot, username, password. Slots are 1-4094. # starts a comment. On an edit, an empty password keeps the stored one.')
					: _('One per line: VLAN, username, password - separated by a comma, a tab, a semicolon, a pipe or spaces. # starts a comment. On an edit, an empty password keeps the stored one.');
			}
		}

		modeSelect.addEventListener('change', syncMode);
		carrierModeSelect.addEventListener('change', syncCarrier);
		syncMode();
		syncCarrier();

		function carrierValue() {
			return String(carrierSelect.value ?? '').trim();
		}

		/** The spec the form describes right now, or null with the reason shown. */
		function buildSpec() {
			const spec = {};
			const mode = modeSelect.value;

			if (creating) {
				spec.mode = mode;
				spec.id = idInput.value.trim();
				spec.prefix = prefixInput.value.trim();
			}
			else {
				spec.id = pool.id;
			}

			spec.label = labelInput.value.trim();
			spec.carrier = carrierValue();
			if (supportsDirect)
				spec.carrier_mode = carrierModeSelect.value;
			spec.mac_mode = macSelect.value;

			const tableBase = bmui.whole(tableBaseInput, 1, 65535);
			if (tableBase === null) {
				dom.content(status, bmui.riskNote(_('The table base has to be 1 to 65535.')));
				return null;
			}
			spec.table_base = tableBase;

			if (mode === 'multi') {
				spec.username = usernameInput.value.trim();
				if (passwordInputNode.value.length)
					spec.password = passwordInputNode.value;

				const parsed = parseVlans(vlanBox.value);
				if (parsed.errors.length) {
					dom.content(status, bmui.riskNote(parsed.errors.slice(0, 5).join('; ')));
					return null;
				}
				spec.members = parsed.vlans.map(vlan => ({ vlan: vlan }));
			}
			else {
				const parsed = parseMembers(memberBox.value);
				if (parsed.errors.length) {
					dom.content(status, bmui.riskNote(parsed.errors.slice(0, 5).join('; ')));
					return null;
				}
				spec.members = parsed.members;
			}

			if (spec.carrier_mode === 'direct' && spec.members.some(one => (one.vlan | 0) < 1)) {
				dom.content(status, bmui.riskNote(_('Direct mode numbers its sessions 1-4094. There is no VLAN 0.')));
				return null;
			}

			spec.service = serviceInput.value.trim();
			spec.ac = acInput.value.trim();
			spec.ac_mac = acMacInput.value.trim();

			const mtuRaw = mtuInput.value.trim();
			if (mtuRaw.length) {
				const mtu = bmui.whole(mtuInput, 576, 9200);
				if (mtu === null) {
					dom.content(status, bmui.riskNote(_('MTU has to be 576 to 9200, or empty for the default.')));
					return null;
				}
				spec.mtu = mtu;
			}
			else {
				spec.mtu = 0;
			}

			const kaFail = kaFailInput.value.trim();
			if (kaFail.length)
				spec.keepalive = kaIntInput.value.trim().length
					? '%s %s'.format(kaFail, kaIntInput.value.trim())
					: kaFail;
			else
				spec.keepalive = '';

			spec.ipv6 = ipv6Select.value;
			spec.peerdns = peerdnsCheck.checked;
			spec.dns = dnsInput.value.trim().length ? dnsInput.value.trim().split(/\s+/) : [];
			spec.defaultroute = defaultrouteCheck.checked;
			spec.host_uniq = hostUniqInput.value.trim();
			spec.demand = demandInput.value.trim().length ? (bmui.whole(demandInput, 0, 86400) ?? -1) : 0;
			spec.padi_attempts = padiAttemptsInput.value.trim().length ? (bmui.whole(padiAttemptsInput, 0, 100) ?? -1) : 0;
			spec.padi_timeout = padiTimeoutInput.value.trim().length ? (bmui.whole(padiTimeoutInput, 0, 300) ?? -1) : 0;

			if (spec.demand < 0 || spec.padi_attempts < 0 || spec.padi_timeout < 0) {
				dom.content(status, bmui.riskNote(_('Demand and the PADI numbers have to be whole numbers.')));
				return null;
			}

			spec.pppd_options = pppdInput.value.trim();
			spec.zone = zoneInput.value.trim();
			spec.masq = masqCheck.checked;
			spec.mtu_fix = mtuFixCheck.checked;
			spec.lan_forward = lanForwardCheck.checked;

			return spec;
		}

		function submit() {
			const spec = buildSpec();
			if (!spec)
				return Promise.resolve();

			dom.content(status, E('p', { 'class': 'spinning' }, _('Asking the router to check it...')));

			return api.ask(api.calls.poolCheck, spec).then(function(result) {
				if (!result.ok) {
					dom.content(status, bmui.riskNote(result.error));
					return null;
				}

				const data = result.data ?? {};
				if (data.ok === false && !Array.isArray(data.findings)) {
					dom.content(status, bmui.riskNote(data.reason ?? _('The router would not say why.')));
					return null;
				}

				const passed = data.ok === true;

				dom.content(status, [
					bmui.findingsList(data.findings),
					passed
						? E('div', { 'class': 'right' }, [
							E('button', {
								'class': 'btn cbi-button-%s'.format(creating ? 'add' : 'apply'),
								'click': ui.createHandlerFn(self, function() {
									return api.run(creating ? api.calls.poolAdd : api.calls.poolSet, spec,
										creating
											? _('Pool %s created. Its interfaces are dialling now.').format(spec.id)
											: _('Pool %s updated across every interface.').format(spec.id))
										.then(function(done) {
											if (done) ui.hideModal();
											return self.refresh();
										});
								})
							}, creating ? _('Create it') : _('Apply to the whole pool'))
						])
						: bmui.riskNote(_('Fix the errors above and check again; nothing has been written.'))
				]);

				return null;
			});
		}

		dom.content(buttons, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', {
				'class': 'btn cbi-button-action',
				'click': ui.createHandlerFn(self, submit)
			}, _('Check'))
		]);

		ui.showModal(creating ? _('Create a PPPoE pool') : _('Edit pool %s').format(pool.id), [
			E('p', {}, creating
				? _('Every field below can also be changed later, except the id, the mode and the prefix.')
				: _('Changes apply to every interface in the pool in one pass. Nothing is written until the check passes and you apply.')),

			bmui.field(_('Mode'), modeSelect, creating
				? _('Shared account: one login, many members. One account per VLAN: each line has its own login.')
				: _('The mode of a pool cannot change; delete it and create a new one.')),
			bmui.field(_('Carrier mode'), carrierModeSelect, creating
				? (supportsDirect
					? _('VLAN tags each member. Direct dials the carrier itself, untagged - the flow for an ISP that answers PPPoE without 802.1Q. Fixed after create.')
					: _('This router\'s bm-pppoe-pool is older than 2.2.0, so only VLAN mode is available. Update the router packages to unlock Direct.'))
				: _('The carrier mode of a pool cannot change; delete it and create a new one.')),
			bmui.field(_('Pool id'), idInput, creating
				? _('Lowercase letters, digits and underscores. This is what you delete it by.')
				: _('Fixed for the life of the pool.')),
			bmui.field(_('Label'), labelInput, _('Only for people; shown wherever the pool is.')),
			bmui.field(_('Prefix'), prefixInput, creating
				? _('1-4 characters. Interface names derive from it: prefix fpt, member 101 dials as fpt101 on pppoe-fpt101.')
				: _('Fixed: every interface is named by it.')),
			bmui.field(_('Carrier'), carrierSelect, _('The physical uplink. Changing it later redials the whole pool.')),
			bmui.field(_('MAC mode'), macSelect, _('auto derives 02:xx:xx:xx:NN:NN from the carrier MAC, the pool id and the member number - a tagged device in VLAN mode, a macvlan in Direct. inherit keeps the carrier MAC; Direct then derives a Host-Uniq per slot.')),
			bmui.field(_('Table base'), tableBaseInput, _('Each member routes in table base + member number. Changing it later strands binding rules until bm-wanbind\'s next pass.')),

			multiBlock,
			singleBlock,

			bmui.groupHeading(_('General')),
			bmui.field(_('Service name'), serviceInput, _('Empty means autodetect.')),
			bmui.field(_('Access concentrator'), acInput, _('Empty means autodetect.')),
			bmui.field(_('AC MAC address'), acMacInput, _('Empty means autodetect.')),

			bmui.groupHeading(_('Advanced')),
			bmui.field(_('MTU'), mtuInput, _('Empty uses the pppd default of 1492. Above 1492 needs an ISP that supports RFC 4638.')),
			bmui.field(_('LCP echo failure / interval'), E('span', {}, [kaFailInput, ' / ', kaIntInput]),
				_('Presume the peer dead after this many missed echoes sent this many seconds apart. Empty leaves pppd\'s default.')),
			bmui.field(_('IPv6'), ipv6Select, ''),
			bmui.field(_('Use ISP DNS servers'), peerdnsCheck, _('Off means the servers below are used instead.')),
			bmui.field(_('DNS servers'), dnsInput, _('Space separated. Only used while ISP DNS is off.')),
			bmui.field(_('Default route'), defaultrouteCheck, _('Each session installs its default route into its own table.')),
			bmui.field(_('Host-Uniq'), hostUniqInput, _('Raw hex bytes. Leave empty unless the ISP requires it. In Direct mode the daemon extends this per slot so concurrent sessions on one wire can be told apart.')),
			bmui.field(_('Inactivity timeout'), demandInput, _('Seconds of idle before hanging up; 0 keeps sessions up.')),
			bmui.field(_('PADI attempts'), padiAttemptsInput, ''),
			bmui.field(_('PADI timeout'), padiTimeoutInput, ''),
			bmui.field(_('Extra pppd options'), pppdInput, _('Passed to pppd verbatim. A wrong word here fails every session in the pool.')),

			bmui.groupHeading(_('Firewall')),
			bmui.field(_('Zone'), zoneInput, _('Created and owned by the router\'s pool daemon; pools may share one. Changing it later moves every membership.')),
			bmui.field(_('Masquerade'), masqCheck, ''),
			bmui.field(_('MTU fix (MSS clamping)'), mtuFixCheck, ''),
			bmui.field(_('Allow LAN to reach this zone'), lanForwardCheck, _('Writes one forwarding from the LAN zone.')),

			E('p', { 'style': 'opacity:.75' },
				_('VLAN mode: VLAN 0 dials untagged; VLANs 1-4094 add an 802.1Q tag, and a wrong tag looks like a PADO timeout. Direct mode: every member dials the carrier itself. auto gives each slot its own macvlan and MAC (needs kmod-macvlan); inherit shares the carrier MAC and lets Host-Uniq tell the sessions apart. A shared account carries as many sessions as the ISP allows: try two or three members before pasting the full list.')),

			status,
			buttons
		]);

		return Promise.resolve();
	},

	/**
	 * Two steps, and the second one has to be typed. Deleting a pool takes
	 * away every interface in it, their tagged devices and MACs, the routing
	 * tables, and the pool's zone memberships - the zone itself too when
	 * nothing else uses it.
	 */
	confirmDelete(pool) {
		const self = this;
		const forceCheck = bmui.checkbox(false);

		bmui.confirmTyped({
			title: _('Delete pool %s').format(pool.id),
			body: [
				E('p', {}, _('This removes all %d interface(s), their devices, their routing tables and their firewall memberships. Anybody dialling through them loses their connection.').format(pool.members | 0)),
				pool.legacy ? E('p', {}, _('This is an old-model pool: its numbered sessions are removed exactly as the release that made them would have.')) : '',
				E('p', {}, _('The router refuses while a bm-wanbind instance hands clients to this carrier, unless forced.')),
				bmui.field(_('Force'), forceCheck, _('Delete even while a binder instance uses this carrier.'))
			],
			expected: pool.id,
			actionLabel: _('Delete it'),
			run: function() {
				return api.run(api.calls.poolDelete, { id: pool.id, force: forceCheck.checked },
					_('Pool %s is gone.').format(pool.id)).then(() => self.refresh());
			}
		});

		return Promise.resolve();
	},

	/** The daemon's own numbers: the counter pass and the watchdog. */
	settingsBlock(settings) {
		const self = this;

		const interval = bmui.textInput('%d'.format(settings.counter_interval | 0), '5', '6em');
		const redialAfter = bmui.textInput('%d'.format(settings.redial_after | 0), '120', '6em');
		const redialBatch = bmui.textInput('%d'.format(settings.redial_batch | 0), '20', '6em');

		return bmui.section(_('Daemon settings'),
			_('The watchdog redials sessions netifd has given up on. 0 seconds turns it off and leaves every retry to netifd.'),
			E('div', {}, [
				bmui.field(_('Counter interval (s)'), interval, _('1 to 300. How often /proc/net/dev is read and the dump corrected.')),
				bmui.field(_('Redial after (s)'), redialAfter, _('0 to 86400. How long a session may stay down before the watchdog redials it.')),
				bmui.field(_('Redial batch'), redialBatch, _('1 to 500. The most redials one watchdog pass starts.')),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn cbi-button-apply',
						'click': ui.createHandlerFn(self, function() {
							const values = {
								counter_interval: bmui.whole(interval, 1, 300),
								redial_after: bmui.whole(redialAfter, 0, 86400),
								redial_batch: bmui.whole(redialBatch, 1, 500)
							};

							if (values.counter_interval === null || values.redial_after === null || values.redial_batch === null) {
								ui.addNotification(null, E('p', {}, _('Counter interval is 1-300, redial after 0-86400, batch 1-500.')), 'warning');
								return Promise.resolve();
							}

							return api.run(api.calls.poolSettingsSet, values, _('Daemon settings applied.'))
								.then(() => self.refresh());
						})
					}, _('Save'))
				])
			]));
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
