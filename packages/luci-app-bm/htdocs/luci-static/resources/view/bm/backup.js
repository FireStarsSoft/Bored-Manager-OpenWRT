'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require bm.api as api';

/*
 * The snapshots, and the way back.
 *
 * A snapshot here is not a sysupgrade backup. It is `uci export` of the handful
 * of packages this project touches, plus the router's ip rules and routes as
 * they stood - small, readable, and diffable, which is the whole reason for the
 * Compare button. Restoring it is `uci import` and a reload, not a reboot.
 *
 * The baseline row is the one that never goes away: it was taken before any of
 * this touched the router, and it is the way back to a router that never had
 * Bored Manager on it. There is no Delete button on it, here or anywhere else.
 */

function reasonText(entry) {
	const reason = String(entry.reason ?? '');

	if (entry.baseline)
		return _('Before any of this touched the router');
	if (reason.indexOf('before-restore-') === 0)
		return _('Kept before restoring %s').format(reason.slice('before-restore-'.length));
	if (reason === 'manual')
		return _('Asked for by hand');
	if (reason === 'guard')
		return _('A change was armed with the countdown');

	return reason.length ? reason : _('Not recorded');
}

return view.extend({
	load() {
		return api.ask(api.calls.agentInfo);
	},

	render(first) {
		const banner = api.guardBanner();

		if (!first.ok) {
			return E([], [banner, api.notice(
				_('There is no agent on this router'),
				_('Snapshots are bm-agent\'s, and it did not answer: %s').format(first.error))]);
		}

		const list = E('div', {});
		const self = this;

		function refresh() {
			return api.ask(api.calls.configList).then(result => self.paint(list, result, refresh));
		}

		poll.add(refresh, 10);
		refresh();

		return E([], [
			banner,
			E('h2', {}, _('Backup and Restore')),
			E('div', { 'class': 'cbi-map-descr' },
				_('The router keeps a copy of its own configuration before every change it makes, and can put one back without anybody being able to reach it.')),
			E('div', { 'style': 'margin:.5em 0' }, [
				E('button', {
					'class': 'btn cbi-button-apply',
					'click': ui.createHandlerFn(self, function() {
						return api.run(api.calls.configSnapshot, { reason: 'manual' },
							_('Taken.')).then(refresh);
					})
				}, _('Take a snapshot now'))
			]),
			list
		]);
	},

	paint(node, result, refresh) {
		if (!result.ok) {
			dom.content(node, E('p', { 'class': 'alert-message warning' }, result.error));
			return;
		}

		const rows = result.data.snapshots ?? [];
		const self = this;

		const table = new ui.Table([
			_('Taken'), _('Why'), _('Release'), _('Schema'), _('Size'), ''
		], {
			id: 'bm-snapshots',
			captionClasses: [null, null, null, null, null, 'cbi-section-actions']
		}, E('em', {}, _('This router has taken no snapshot yet. One is taken automatically before the next change; the button above takes one now.')));

		table.update(rows.map(entry => [
			E('span', {}, [
				api.when(entry.at),
				entry.baseline ? E('strong', { 'style': 'margin-left:.5em' }, _('baseline')) : ''
			]),
			reasonText(entry),
			(entry.release && entry.release.length) ? entry.release : '-',
			'%d'.format(entry.schema | 0),
			api.size(entry.size),
			E('div', {}, [
				E('button', {
					'class': 'btn cbi-button-neutral',
					'click': ui.createHandlerFn(self, function() {
						return self.showDiff(entry);
					})
				}, _('Compare')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(self, function() {
						return self.askRestore(entry, refresh);
					})
				}, _('Restore')),
				' ',
				E('button', {
					'class': 'btn cbi-button-neutral',
					'click': ui.createHandlerFn(self, function() {
						return self.download(entry);
					})
				}, _('Download')),
				' ',
				entry.baseline
					? E('span', { 'style': 'opacity:.6;margin-left:.5em' }, _('kept forever'))
					: E('button', {
						'class': 'btn cbi-button-remove',
						'click': ui.createHandlerFn(self, function() {
							if (!confirm(_('Delete the snapshot taken at %s? There is no way back to it afterwards.').format(api.when(entry.at))))
								return Promise.resolve();

							return api.run(api.calls.configDelete, { id: entry.id },
								_('Deleted.')).then(refresh);
						})
					}, _('Delete'))
			])
		]));

		dom.content(node, [
			table.render(),
			E('div', { 'class': 'cbi-section-descr' },
				_('The ten most recent are kept, and the baseline on top of those, which is never deleted by anything.'))
		]);
	},

	/**
	 * Save a snapshot to the machine looking at this page.
	 *
	 * What comes down is the snapshot itself and not a report about it: the
	 * stored `uci export` of each package, concatenated, which is what
	 * `uci import` reads. So the file restores on any router, including one
	 * that has never had any of this installed - which is the case a downloaded
	 * backup is actually for.
	 *
	 * The rules and routes are left out for the reason they are never restored:
	 * they are a record of what the kernel was doing, kept for somebody working
	 * out what changed, and putting them in a file meant to be fed back into
	 * uci would make it not that file any more. Compare shows them.
	 */
	download(entry) {
		return api.ask(api.calls.configExport, { id: entry.id }).then(result => {
			if (!result.ok) {
				ui.addNotification(null, E('p', {}, result.error), 'error');
				return;
			}

			const data = result.data ?? {};

			if (data.ok === false || typeof data.text !== 'string' || !data.text.length) {
				ui.addNotification(null, E('p', {},
					data.reason ?? _('The router had nothing to send for that snapshot.')), 'warning');
				return;
			}

			api.download('bm-snapshot-%s.uci'.format(entry.id), data.text);
		});
	},

	/**
	 * What restoring would change, line by line.
	 *
	 * "Restores" are lines the snapshot has that the router no longer does, and
	 * "discards" are the other way round - which is the direction that matters:
	 * one of them is what comes back and the other is what goes away, and a
	 * single list of changed lines would not say which was which.
	 */
	showDiff(entry) {
		ui.showModal(_('Changes since %s').format(api.when(entry.at)), [
			E('p', { 'class': 'spinning' }, _('Reading the snapshot...'))
		]);

		return api.ask(api.calls.configDiff, { id: entry.id }).then(result => {
			if (!result.ok) {
				ui.showModal(_('Changes since %s').format(api.when(entry.at)), [
					E('p', { 'class': 'alert-message warning' }, result.error),
					E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
				]);
				return;
			}

			const data = result.data;
			const packages = data.packages ?? [];

			const body = packages.length
				? packages.map(one => E('div', { 'style': 'margin-bottom:1em' }, [
					E('h5', {}, one.package),
					E('pre', { 'style': 'max-height:14em;overflow:auto;white-space:pre-wrap' },
						(one.restores ?? []).map(line => '+ ' + line + '\n').join('') +
						(one.discards ?? []).map(line => '- ' + line + '\n').join(''))
				]))
				: [E('p', {}, _('Nothing has changed since this snapshot was taken.'))];

			ui.showModal(_('Changes since %s').format(api.when(entry.at)), [
				E('p', {}, _('%d line(s) differ. A line marked + comes back when this is restored; a line marked - goes away.').format(data.changes | 0)),
				E('p', { 'style': 'opacity:.75' },
					_('These are configuration lines exactly as the router exports them, so some of them carry keys and passwords.')),
				E('div', {}, body),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
		});
	},

	/**
	 * Two steps, and the first one is the router's own answer.
	 *
	 * The dry run is not a preview this page assembled - it is `config_restore`
	 * with dry_run set, so what is shown is what that call decided it would do.
	 * A preview computed separately is a preview that can be right about a
	 * restore that then does something else.
	 */
	askRestore(entry, refresh) {
		const self = this;

		ui.showModal(_('Restore the snapshot from %s').format(api.when(entry.at)), [
			E('p', { 'class': 'spinning' }, _('Asking the router what this would change...'))
		]);

		return api.ask(api.calls.configRestore, { id: entry.id, dry_run: true }).then(result => {
			const title = _('Restore the snapshot from %s').format(api.when(entry.at));

			if (!result.ok || result.data.ok === false) {
				ui.showModal(title, [
					E('p', { 'class': 'alert-message warning' },
						result.ok ? (result.data.reason ?? _('The router would not do it.')) : result.error),
					E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
				]);
				return;
			}

			const changes = result.data.changes | 0;
			const packages = (result.data.packages ?? []).map(one => one.package);

			ui.showModal(title, [
				E('p', {}, changes
					? _('%d configuration line(s) will change, across: %s.').format(changes, packages.join(', '))
					: _('Nothing would change: the router already matches this snapshot.')),
				E('p', {}, _('Restoring reloads the services behind those packages - network, firewall and dnsmasq as needed. It is a reload rather than a restart, so interfaces are not dropped on the way through, but the connection you are reading this on goes through one of them.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							ui.hideModal();
							return api.run(api.calls.configRestore, { id: entry.id, dry_run: false })
								.then(data => {
									if (data)
										self.reportRestore(data);
									return refresh();
								});
						})
					}, _('Restore it'))
				])
			]);
		});
	},

	/** What actually came back, and whether every service took it. */
	reportRestore(data) {
		const failed = (data.reloaded ?? []).filter(one => one.ok !== true).map(one => one.service);

		if (failed.length) {
			ui.addNotification(null, E('p', {},
				_('Restored %s, but these did not reload: %s. Check "logread -e bm-agent".')
					.format((data.restored ?? []).join(', '), failed.join(', '))), 'warning');
			return;
		}

		ui.addNotification(null, E('p', {},
			_('Restored %s and reloaded what needed it.').format((data.restored ?? []).join(', '))), 'info');
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
