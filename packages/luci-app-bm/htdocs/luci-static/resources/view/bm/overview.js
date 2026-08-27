'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require bm.api as api';
'require bm.ui as bmui';

/*
 * What this router is doing, on one page - and what it is missing, on the
 * same page.
 *
 * The three cards are the three daemons, and a card is drawn for a daemon
 * that is not installed too - saying so, with what it would do. Beside them
 * sit the two cards that used to have no surface on the router at all:
 * Requirements, which asks the agent live which of the pieces every feature
 * needs are present and offers the fixed-list installer for the ones a
 * package can fix; and Updates, which shows what is installed and checks for
 * a release only when asked. Both exist for the same reason: a requirement
 * that fails silently is a feature that breaks silently, and the app's
 * readiness page is invisible from the router's own LuCI.
 *
 * "Recent activity" is built from the snapshot history rather than from a
 * log. Every snapshot carries the reason it was taken, so the list is the
 * router's own record of the things that changed it.
 */

/** Five minutes of throughput at the five-second poll. */
const SAMPLES = 60;

const history = [];

const SVG = 'http://www.w3.org/2000/svg';

/**
 * A line, drawn rather than described. Built with createElementNS because
 * E() calls createElement, which would produce an HTML element named "svg" -
 * present in the DOM, styled by nothing, and drawing nothing at all.
 */
function sparkline(values) {
	if (values.length < 2)
		return E('div', { 'style': 'height:40px' }, '');

	const peak = Math.max.apply(null, values.concat([1]));
	const step = 240 / (SAMPLES - 1);

	const points = values.map((value, index) =>
		'%.1f,%.1f'.format(index * step, 38 - (value / peak) * 36)).join(' ');

	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', '0 0 240 40');
	svg.setAttribute('preserveAspectRatio', 'none');
	svg.setAttribute('class', 'bm-spark');
	svg.setAttribute('aria-hidden', 'true');

	const line = document.createElementNS(SVG, 'polyline');
	line.setAttribute('points', points);
	line.setAttribute('fill', 'none');
	line.setAttribute('stroke', 'currentColor');
	line.setAttribute('stroke-width', '1.5');
	line.setAttribute('vector-effect', 'non-scaling-stroke');

	svg.appendChild(line);
	return svg;
}

/** One daemon, whether or not it is there. */
function daemonCard(title, what, info, stats, missingText) {
	if (!info) {
		return bmui.card({
			title: title,
			pill: bmui.pill('idle', _('not answering')),
			sub: what,
			body: E('p', { 'class': 'bm-small' }, missingText)
		});
	}

	const now = api.routerNow(info);
	const off = info.enabled === false;

	return bmui.card({
		title: title,
		pill: off ? bmui.pill('warn', _('switched off')) : bmui.pill('ok', _('running')),
		sub: what,
		body: bmui.kv([
			[_('Version'), _('%s, ubus API %d').format(info.release ?? '?', info.apiVersion | 0)],
			[_('Uptime'), api.duration(info.uptime)],
			[_('Memory'), stats && (stats.rssKb | 0) >= 0 ? api.size((stats.rssKb | 0) * 1024) : _('not reported')],
			[_('Router clock'), now ? api.when(now) : '-']
		])
	});
}

/**
 * The snapshot history, read as a list of things that happened.
 */
function activityText(entry) {
	const reason = String(entry.reason ?? '');

	if (entry.baseline)
		return _('The first snapshot, taken before any of this touched the router');
	if (reason.indexOf('before-restore-') === 0)
		return _('A restore was about to run, so the state it would replace was kept');
	if (reason === 'manual')
		return _('Somebody asked for a snapshot');
	if (reason === 'guard')
		return _('A change was armed with the countdown');

	return reason.length ? reason : _('Reason not recorded');
}

return view.extend({
	load() {
		return api.ask(api.calls.agentInfo);
	},

	render(first) {
		const banner = api.guardBanner();

		if (!first.ok) {
			return E([], [
				banner,
				bmui.notice(
					_('There is no agent on this router'),
					_('These pages are drawn from what bm-agent reports, and it did not answer: %s').format(first.error),
					E('p', {}, _('Install bm-agent from the Bored Manager app, or check it with "/etc/init.d/bm-agent status" at a console.'))
				)
			]);
		}

		const cards = E('div', { 'class': 'bm-cards' });
		const health = E('div', { 'class': 'bm-cards' });
		const figures = E('div', {});
		const graph = E('div', {});
		const activity = E('div', {});
		const self = this;

		function refresh() {
			return api.ask(api.calls.agentInfo).then(agentResult => {
				if (!agentResult.ok) {
					dom.content(cards, E('p', { 'class': 'alert-message warning' }, agentResult.error));
					return null;
				}

				const info = agentResult.data;
				const binding = api.has(info, 'binding');
				const pppoe = api.has(info, 'pppoe');

				return Promise.all([
					api.ask(api.calls.agentStats),
					binding ? api.ask(api.calls.wanbindInfo) : null,
					binding ? api.ask(api.calls.wanbindStats) : null,
					pppoe ? api.ask(api.calls.poolInfo) : null,
					pppoe ? api.ask(api.calls.poolStats) : null,
					api.ask(api.calls.configList)
				]).then(answers => {
					const agentStats = answers[0].ok ? answers[0].data : null;
					const wanbind = (answers[1] && answers[1].ok) ? answers[1].data : null;
					const wanbindStats = (answers[2] && answers[2].ok) ? answers[2].data : null;
					const pool = (answers[3] && answers[3].ok) ? answers[3].data : null;
					const poolStats = (answers[4] && answers[4].ok) ? answers[4].data : null;
					const snapshots = answers[5].ok ? (answers[5].data.snapshots ?? []) : [];

					dom.content(cards, [
						daemonCard(_('Agent'), _('Snapshots, the countdown, and the updater'),
							info, agentStats, ''),
						daemonCard(_('WAN Binding'), _('One DHCP client, one WAN'),
							binding ? wanbind : null, wanbindStats,
							binding
								? _('bm-wanbind is installed but is not answering. Check "logread -e bm-wanbind".')
								: _('bm-wanbind is not installed. Without it, binding is done by the app over SSH: it works, and a client waits up to one sweep for its WAN instead of a few milliseconds.')),
						daemonCard(_('PPPoE Dialer'), _('Many sessions over one carrier'),
							pppoe ? pool : null, poolStats,
							pppoe
								? _('bm-pppoe-pool is installed but is not answering. Check "logread -e bm-pppoe".')
								: _('bm-pppoe-pool is not installed. Without it this router dials no pools.'))
					]);

					// Sessions.
					let up = 0, dialing = 0, broken = 0, rx = 0, tx = 0;
					for (const one of (pool && pool.pools) ? pool.pools : []) {
						up += one.up | 0;
						dialing += one.dialing | 0;
						broken += one.error | 0;
						rx += (one.rate && one.rate.rxBps) | 0;
						tx += (one.rate && one.rate.txBps) | 0;
					}

					// Clients.
					let bound = 0, waiting = 0, held = 0;
					for (const one of (wanbind && wanbind.instances) ? wanbind.instances : []) {
						bound += one.bound | 0;
						waiting += one.waiting | 0;
						held += one.held | 0;
					}

					dom.content(figures, bmui.tiles([
						[_('PPPoE sessions up'), pppoe ? '%d'.format(up) : '-'],
						[_('Dialing'), pppoe ? '%d'.format(dialing) : '-'],
						[_('In error'), pppoe ? '%d'.format(broken) : '-'],
						[_('Clients bound'), binding ? '%d'.format(bound) : '-'],
						[_('Clients waiting'), binding ? '%d'.format(waiting + held) : '-'],
						[_('Throughput'), pppoe ? api.rate(rx + tx) : '-']
					]));

					if (pppoe) {
						history.push(rx + tx);
						while (history.length > SAMPLES)
							history.shift();

						dom.content(graph, bmui.section(
							_('Throughput, last five minutes'),
							_('The sum of every pool on this router, sampled each time this page refreshes.'),
							sparkline(history)));
					}
					else {
						dom.content(graph, null);
					}

					dom.content(activity, bmui.section(
						_('Recent activity'),
						_('Built from the snapshot history, which is the router\'s own record of what changed it. The full log is "logread -e bm-" at a console.'),
						snapshots.length
							? E('ul', {}, snapshots.slice(0, 20).map(entry => E('li', {}, [
								E('span', {}, api.when(entry.at)),
								' - ',
								E('span', {}, activityText(entry)),
								entry.baseline ? E('em', {}, _(' (baseline)')) : ''
							])))
							: E('p', {}, _('No snapshot has been taken on this router yet.'))));

					return null;
				});
			});
		}

		poll.add(refresh, 5);
		refresh();

		dom.content(health, [this.requirementsCard(), this.updatesCard(first.data)]);

		return E([], [
			banner,
			E('h2', {}, _('Bored Manager')),
			E('div', { 'class': 'cbi-map-descr' },
				_('What the three router daemons are doing, what every feature needs, and where updates come from. The app drives the same calls; nothing here is a second opinion.')),
			cards,
			health,
			figures,
			graph,
			activity
		]);
	},

	/**
	 * Every requirement, asked live, with the installer beside the rows a
	 * package can fix.
	 *
	 * Asked on load and on demand rather than on the poll: the report forks a
	 * shell on the router, and a page left open must not do that every five
	 * seconds for a list that changes when somebody installs something.
	 */
	requirementsCard() {
		const body = E('div', {}, E('p', { 'class': 'spinning' }, _('Asking the router...')));
		const self = this;

		function refresh() {
			return api.ask(api.calls.requirements).then(result => {
				if (!result.ok) {
					dom.content(body, E('p', { 'class': 'alert-message warning' }, result.error));
					return null;
				}

				const data = result.data ?? {};

				if (data.asked === false) {
					dom.content(body, E('p', { 'class': 'bm-muted' },
						_('The agent could not ask the shell, so nothing here is known. Check "logread -e bm-agent".')));
					return null;
				}

				dom.content(body, (data.rows ?? []).map(row => self.requirementRow(row, refresh)));
				return null;
			});
		}

		refresh();

		return bmui.card({
			title: _('Requirements'),
			sub: _('What every feature needs from this router, asked live. A missing piece is a feature that breaks - this row is where it says so first.'),
			body: body,
			footer: E('button', {
				'class': 'btn cbi-button-neutral',
				'click': ui.createHandlerFn(this, function() {
					dom.content(body, E('p', { 'class': 'spinning' }, _('Asking the router...')));
					return refresh();
				})
			}, _('Re-check'))
		});
	},

	requirementRow(row, refresh) {
		const pill = row.ok === true
			? bmui.pill('ok', _('ok'))
			: (row.ok === false ? bmui.pill('bad', _('missing')) : bmui.pill('idle', _('unknown')));

		const fixable = row.ok === false && typeof row.group === 'string' && row.group;

		return E('div', { 'class': 'bm-req-row' }, [
			E('div', {}, pill),
			E('div', { 'class': 'bm-req-body' }, [
				E('div', { 'class': 'bm-req-label' }, row.label),
				E('div', { 'class': 'bm-req-detail' }, row.detail ?? '')
			]),
			fixable
				? E('div', { 'class': 'bm-req-action' }, E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						if (!confirm(_('Install %s with apk now? This runs "apk update" first and can take a minute.').format(row.label)))
							return Promise.resolve();

						return api.run(api.calls.installPackages, { group: row.group },
							_('Installed. Re-checking what the router has now.')).then(refresh);
					})
				}, _('Install')))
				: ''
		]);
	},

	/**
	 * Updates, without phoning home: what is installed and what happened last
	 * time are read off the router; the release server is asked only when the
	 * button is pressed. The full flow - dry run, rollback, the step list -
	 * lives on the Maintenance tab.
	 */
	updatesCard(info) {
		const body = E('div', {});
		const self = this;

		function paint(latest) {
			const rows = [
				[_('Installed'), info.release ?? '?'],
				[_('Latest'), latest ? (latest.latest ?? '?') : _('not asked yet')]
			];

			const children = [bmui.kv(rows)];

			return api.ask(api.calls.updateStatus).then(result => {
				const last = result.ok ? result.data : null;

				if (last && (last.at | 0))
					children.push(E('p', { 'class': 'bm-small bm-muted' },
						_('Last update: %s, %s to %s.').format(api.when(last.at), last.from ?? '?', last.to ?? '?')));

				if (latest && latest.newer === true) {
					children.push(E('p', {}, [
						bmui.pill('warn', _('update available')),
						' ',
						_('%s is published and signed by key %s.').format(latest.latest ?? '?', latest.key ?? '?')
					]));
					children.push(E('button', {
						'class': 'btn cbi-button-apply',
						'click': ui.createHandlerFn(self, function() {
							if (!confirm(_('Install %s now, under the countdown? The services being replaced include the ones binding clients and dialling pools.').format(latest.latest)))
								return Promise.resolve();

							return api.run(api.calls.updateApply, { dry_run: false, guard: true, timeout: 180 },
								_('Installing. The countdown at the top of the page is running: keep the change once this router is still reachable.'));
						})
					}, _('Update now')));
				}
				else if (latest) {
					children.push(E('p', { 'class': 'bm-muted' },
						latest.ok === false
							? (latest.reason ?? _('The check failed and the router did not say why.'))
							: _('Up to date.')));
				}

				dom.content(body, children);
				return null;
			});
		}

		paint(null);

		return bmui.card({
			title: _('Updates'),
			sub: _('This router asks the release server only when somebody presses the button; nothing here runs on its own. The full flow, including rollback, is on the Maintenance tab.'),
			body: body,
			footer: [
				E('a', { 'class': 'btn', 'href': L.url('admin/services/bm/maintenance') }, _('Maintenance')),
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						dom.content(body, E('p', { 'class': 'spinning' }, _('Asking the release server...')));
						return api.ask(api.calls.updateCheck).then(result => {
							if (!result.ok) {
								dom.content(body, E('p', { 'class': 'alert-message warning' }, result.error));
								return null;
							}
							return paint(result.data ?? {});
						});
					})
				}, _('Check for updates'))
			]
		});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
