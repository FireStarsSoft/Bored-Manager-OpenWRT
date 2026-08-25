'use strict';
'require view';
'require poll';
'require dom';
'require bm.api as api';

/*
 * What this router is doing, on one page.
 *
 * The three cards are the three daemons, and a card is drawn for a daemon that
 * is not installed too - saying so, with what it would do. A router with only
 * bm-agent is a normal, working router, and a page that simply left out the
 * two missing cards would be telling somebody there is nothing else rather
 * than that there is something else they have not installed.
 *
 * "Recent activity" is built from the snapshot history rather than from a log.
 * Every snapshot carries the reason it was taken - a guard arming, an update,
 * a restore, somebody pressing the button - so the list is the router's own
 * record of the things that changed it, and it costs no permission beyond the
 * one this page already needs. The full log is `logread -e bm-` at a console,
 * and the page says so rather than pretending this is the same thing.
 */

/** Five minutes of throughput at the five-second poll. */
const SAMPLES = 60;

const history = [];

const SVG = 'http://www.w3.org/2000/svg';

/**
 * A line, drawn rather than described.
 *
 * Built with createElementNS because E() calls createElement, which would
 * produce an HTML element named "svg" - present in the DOM, styled by nothing,
 * and drawing nothing at all.
 *
 * `currentColor` and a non-scaling stroke, so it takes the theme's text colour
 * and stays one pixel wide however wide the box gets. There is no axis and no
 * number on it on purpose: the figure above says what the value is, and this
 * only says which way it has been going.
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
	svg.setAttribute('style', 'width:100%;height:40px;opacity:.8');
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
	const body = [];

	if (!info) {
		body.push(E('p', {}, missingText));
	}
	else {
		const now = api.routerNow(info);

		body.push(E('div', {}, api.dot(info.enabled === false ? 'idle' : 'ok',
			info.enabled === false ? _('running, but switched off in its config') : _('running'))));
		body.push(E('div', { 'style': 'margin-top:.4em;opacity:.85' }, [
			E('div', {}, _('Version %s, ubus API %d').format(info.release ?? '?', info.apiVersion | 0)),
			E('div', {}, _('Up %s').format(api.duration(info.uptime))),
			E('div', {}, stats && (stats.rssKb | 0) >= 0
				? _('Memory %s').format(api.size((stats.rssKb | 0) * 1024))
				: _('Memory not reported')),
			now ? E('div', { 'style': 'opacity:.7' }, _('Router clock: %s').format(api.when(now))) : ''
		]));
	}

	return E('div', {
		'style': 'flex:1 1 16em;min-width:14em;padding:.75em 1em;border:1px solid rgba(128,128,128,.35);border-radius:4px'
	}, [
		E('h4', { 'style': 'margin:0 0 .2em' }, title),
		E('div', { 'style': 'opacity:.7;font-size:.9em;margin-bottom:.5em' }, what),
		E('div', {}, body)
	]);
}

/**
 * The snapshot history, read as a list of things that happened.
 *
 * `before-restore-<id>` is the one reason that is not a sentence, so it is
 * turned into one here rather than shown raw: it is written by the restore
 * path itself and would otherwise be the only row on the page that reads like
 * a filename.
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
				api.notice(
					_('There is no agent on this router'),
					_('These pages are drawn from what bm-agent reports, and it did not answer: %s').format(first.error),
					E('p', {}, _('Install bm-agent from the Bored Manager app, or check it with "/etc/init.d/bm-agent status" at a console.'))
				)
			]);
		}

		const cards = E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:1em;margin-bottom:1em' });
		const figures = E('div', {});
		const graph = E('div', {});
		const activity = E('div', {});

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
						daemonCard(_('PPPoE Pools'), _('Many sessions over one carrier'),
							pppoe ? pool : null, poolStats,
							pppoe
								? _('bm-pppoe-pool is installed but is not answering. Check "logread -e bm-pppoe".')
								: _('bm-pppoe-pool is not installed. Without it, pools are written by the app over SSH, a chunk per round trip.'))
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

					dom.content(figures, api.figures([
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

						dom.content(graph, api.section(
							_('Throughput, last five minutes'),
							_('The sum of every pool on this router, sampled each time this page refreshes.'),
							sparkline(history)));
					}
					else {
						dom.content(graph, null);
					}

					dom.content(activity, api.section(
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

		return E([], [
			banner,
			E('h2', {}, _('Bored Manager')),
			E('div', { 'class': 'cbi-map-descr' },
				_('What the three router daemons are doing. The app drives the same calls; nothing here is a second opinion.')),
			cards,
			figures,
			graph,
			activity
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
