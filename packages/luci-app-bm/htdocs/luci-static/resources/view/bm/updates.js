'use strict';
'require view';
'require ui';
'require dom';
'require bm.api as api';

/*
 * Updating the router packages from the router.
 *
 * Nothing on this page happens on its own. The router never reaches out to the
 * internet unless somebody presses Check, which is the point: a router that
 * phones home by itself is a router doing something its owner did not ask for.
 * So the "latest version" column is empty until it is asked for, and it says so
 * rather than showing a dash that could mean anything.
 *
 * An update runs under the guard by default. That is not belt and braces: the
 * set being replaced includes the daemon that writes this router's ip rules,
 * and an update that leaves the router unreachable is the one failure nobody
 * can drive a fix for from the outside.
 */

/** What `update_apply` does, in the order it does it. */
function steps() {
	return [
		_('Arm the countdown and take a snapshot'),
		_('Fetch the signed manifest and check its signature'),
		_('Download each archive and check its sha256 against the manifest'),
		_('Install them with apk, in one command'),
		_('Run the schema migration'),
		_('Read the router back and report what it now answers')
	];
}

return view.extend({
	load() {
		return Promise.all([
			api.ask(api.calls.agentInfo),
			api.ask(api.calls.updateStatus)
		]);
	},

	render(loaded) {
		const first = loaded[0];
		const banner = api.guardBanner();

		if (!first.ok) {
			return E([], [banner, api.notice(
				_('There is no agent on this router'),
				_('The updater is bm-agent\'s, and it did not answer: %s').format(first.error))]);
		}

		const info = first.data;
		const last = loaded[1].ok ? loaded[1].data : null;

		const versions = E('div', {});
		const found = E('div', {});
		const self = this;

		self.latest = null;

		function paintVersions() {
			dom.content(versions, api.figures([
				[_('Installed'), info.release ?? '?'],
				[_('Latest'), self.latest ? self.latest.latest : _('not asked')],
				[_('Data schema'), '%d / %d'.format(info.dataSchema ?? 0, info.schema | 0)],
				[_('Update source'), (info.updateUrl && info.updateUrl.length) ? _('configured') : _('not set')]
			]));
		}

		paintVersions();
		self.paintVersions = paintVersions;

		return E([], [
			banner,
			E('h2', {}, _('Updates')),
			E('div', { 'class': 'cbi-map-descr' },
				_('This router checks for a new release only when somebody asks it to, and installs one only under the countdown.')),
			versions,
			E('div', { 'style': 'margin:.5em 0' }, [
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(self, function() {
						return self.check(found);
					})
				}, _('Check for updates')),
				' ',
				E('button', {
					'class': 'btn cbi-button-reset',
					'click': ui.createHandlerFn(self, function() {
						return self.rollback();
					})
				}, _('Roll back to the previous set'))
			]),
			found,
			this.lastSection(last),
			api.section(_('What an update does'),
				_('Every step in order. A step that fails stops the ones after it, and the countdown puts the router back if nobody confirms.'),
				E('ol', {}, steps().map(text => E('li', {}, text)))),
			api.section(_('Where the log is'),
				_('Each step is written to the system log as it happens. At a console: "logread -e bm-agent", or "bmctl version" for what this router answers now.'),
				'')
		]);
	},

	lastSection(last) {
		if (!last || !(last.at | 0)) {
			return api.section(_('The last update'),
				_('No update has been applied on this router. A first install done from the Bored Manager app does not count as one.'), '');
		}

		return api.section(_('The last update'), null, E('ul', {}, [
			E('li', {}, _('At %s').format(api.when(last.at))),
			E('li', {}, _('From %s to %s').format(last.from ?? '?', last.to ?? '?')),
			E('li', {}, _('Packages: %s').format((last.packages ?? []).join(', ') || '-')),
			E('li', {}, last.migrated === false
				? _('The schema migration did not finish. Run "bmctl schema" to see why.')
				: _('The schema migration finished.'))
		]));
	},

	/**
	 * Ask, and say exactly which part failed.
	 *
	 * A bad signature and an unreachable host are two different problems with
	 * two different fixes, and a page that reports both as "could not check for
	 * updates" sends people to the wrong one. The daemon already tells them
	 * apart; this only has to not throw that away.
	 */
	check(node) {
		const self = this;

		dom.content(node, E('p', { 'class': 'spinning' }, _('Asking the release server...')));

		return api.ask(api.calls.updateCheck).then(result => {
			if (!result.ok) {
				dom.content(node, E('p', { 'class': 'alert-message warning' }, result.error));
				return;
			}

			const data = result.data;

			if (data.ok === false) {
				dom.content(node, E('div', { 'class': 'alert-message warning' }, [
					E('p', {}, data.reason ?? _('The router would not say why.')),
					data.hint ? E('p', {}, data.hint) : ''
				]));
				return;
			}

			self.latest = data;
			self.paintVersions();

			if (data.caBundle === false) {
				dom.content(node, E('div', { 'class': 'alert-message warning' }, [
					E('p', {}, _('This router has no CA bundle, so it cannot verify the release server\'s certificate. Install ca-bundle before updating over the network.'))
				]));
				return;
			}

			if (data.comparable === false) {
				dom.content(node, E('p', { 'class': 'alert-message warning' },
					_('The release server offers %s and this router answers %s, and the two cannot be compared. Nothing will be installed on a guess.')
						.format(data.latest ?? '?', data.current ?? '?')));
				return;
			}

			if (data.newer !== true) {
				dom.content(node, api.section(_('Up to date'),
					_('The release server offers %s; this router is on %s.').format(data.latest ?? '?', data.current ?? '?'),
					E('p', {}, _('Signed by key %s.').format(data.key ?? '?'))));
				return;
			}

			dom.content(node, self.offer(data));
		});
	},

	offer(data) {
		const self = this;

		const guard = E('input', { 'type': 'checkbox', 'checked': '' });
		const timeout = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'width:5em',
			'value': '180'
		});

		return api.section(_('%s is available').format(data.latest), null, [
			E('p', {}, _('This router is on %s. Signed by key %s, fetched from %s.')
				.format(data.current ?? '?', data.key ?? '?', data.url ?? '?')),
			E('ul', {}, (data.packages ?? []).map(one => E('li', {},
				_('%s %s, %s').format(one.name ?? '?', one.version ?? '?', api.size(one.size))))),
			(data.notes && data.notes.length) ? E('pre', { 'style': 'white-space:pre-wrap' }, data.notes) : '',
			E('div', { 'style': 'margin:.5em 0' }, [
				E('label', {}, [guard, ' ', _('Put the router back if nobody confirms')]),
				E('span', { 'style': 'margin-left:1em' }, [_('after'), ' ', timeout, ' ', _('seconds')])
			]),
			E('div', {}, [
				E('button', {
					'class': 'btn cbi-button-neutral',
					'click': ui.createHandlerFn(self, function() {
						return self.apply(data, true, guard.checked, parseInt(timeout.value, 10));
					})
				}, _('Show what would happen')),
				' ',
				E('button', {
					'class': 'btn cbi-button-apply',
					'click': ui.createHandlerFn(self, function() {
						if (!confirm(_('Install %s now? The services being replaced include the one that maintains this router\'s routing rules.').format(data.latest)))
							return Promise.resolve();

						return self.apply(data, false, guard.checked, parseInt(timeout.value, 10));
					})
				}, _('Update now'))
			])
		]);
	},

	/**
	 * Apply, then tell the truth about what came out.
	 *
	 * `verified` is deliberately three-valued: the daemon reads the router back
	 * and reports null when it could not. Rounding that to success would be the
	 * one place on this page where an unchecked claim looks like a checked one.
	 *
	 * The guard is left armed. Confirming it is the person's job, because the
	 * thing being confirmed is that they can still reach the router - and a
	 * page that confirmed on their behalf would be answering its own question.
	 */
	apply(data, dryRun, withGuard, seconds) {
		const self = this;

		const timeout = (Number.isFinite(seconds) && seconds > 0) ? Math.trunc(seconds) : 0;

		return api.run(api.calls.updateApply, {
			dry_run: dryRun === true,
			guard: withGuard === true,
			timeout: timeout
		}).then(result => {
			if (!result)
				return null;

			if (result.dryRun) {
				ui.addNotification(null, E('p', {},
					_('Nothing was installed. It would have fetched: %s.').format((result.packages ?? []).join(', '))), 'info');
				return null;
			}

			if (result.verified === false) {
				ui.addNotification(null, E('p', {},
					_('apk reported success but this router still answers %s. Check "logread -e bm-agent".').format(result.running ?? '?')), 'warning');
			}
			else if (result.verified === null) {
				ui.addNotification(null, E('p', {},
					_('Installed %s, but the router\'s own version could not be read back, so this is unverified.').format(result.to ?? '?')), 'warning');
			}
			else {
				ui.addNotification(null, E('p', {},
					_('Installed %s. The countdown at the top of the page is still running: keep the change once you are sure this router is still reachable.').format(result.to ?? '?')), 'info');
			}

			if (result.migrated === false) {
				ui.addNotification(null, E('p', {},
					_('The schema migration did not finish. Run "bmctl schema" at a console to see why.')), 'warning');
			}

			return null;
		});
	},

	rollback() {
		if (!confirm(_('Put the previous set of packages back? They are the ones this router installed last time, kept on the router, so nothing is downloaded.')))
			return Promise.resolve();

		return api.run(api.calls.updateRollback, { guard: true, timeout: 180 }).then(result => {
			if (!result)
				return null;

			ui.addNotification(null, E('p', {},
				_('Rolled back. The countdown at the top of the page is still running.')), 'info');
			return null;
		});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
