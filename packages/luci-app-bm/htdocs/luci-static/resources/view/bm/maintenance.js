'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require bm.api as api';
'require bm.ui as bmui';

function asRows(value) {
	return Array.isArray(value) ? value : [];
}

function asRecord(value) {
	return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

/*
 * Keeping the router healthy, on one tab: the snapshots and the way back,
 * the updater, and the scale limits.
 *
 * These three lived on two tabs and nowhere. They are one errand - not
 * operating a feature but looking after the router underneath the features -
 * which is why they share a page now. Snapshots and updates moved here
 * unchanged in behaviour; Scaling is new, and it is the first surface for the
 * two kernel tables that overflow first when a router grows to thousands of
 * sessions: conntrack ("nf_conntrack: table full, dropping packet") and the
 * neighbour cache ("neighbour: arp_cache: neighbour table overflow!"). Both
 * fail by dropping traffic with one line in dmesg that nothing used to show.
 *
 * The values are applied and persisted by bm-agent under /etc/sysctl.d/, so
 * they survive a reboot - and they are deliberately outside the snapshot set,
 * because a guard restore that quietly shrank conntrack back would undo a
 * capacity fix nobody asked it to touch.
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

/** What `update_apply` does, in the order it does it. */
function updateSteps() {
	return [
		_('Arm the countdown and take a snapshot'),
		_('Fetch the signed manifest and check its signature'),
		_('Download each archive and check its sha256 against the manifest'),
		_('Install them with apk, in one command'),
		_('Run the schema migration'),
		_('Read the router back and report what it now answers')
	];
}

/** The two tunings a preset fills in, sized by how many clients they seat. */
const PRESETS = [
	{ label: _('Up to 1,000 clients'), conntrack: 262144, thresh: [2048, 4096, 8192] },
	{ label: _('Up to 4,000 clients'), conntrack: 524288, thresh: [4096, 8192, 16384] }
];

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
			return E([], [banner, bmui.notice(
				_('There is no agent on this router'),
				_('Snapshots, updates and tuning are bm-agent\'s, and it did not answer: %s').format(first.error))]);
		}

		const info = first.data;
		const last = loaded[1].ok ? loaded[1].data : null;

		return E([], [
			banner,
			E('h2', {}, _('Maintenance')),
			E('div', { 'class': 'cbi-map-descr' },
				_('The router\'s own safety net and upkeep: the snapshots it can put back without anybody reaching it, the updater it runs only when asked, and the kernel limits that decide how far it scales.')),
			this.snapshotsSection(),
			this.updatesSection(info, last),
			this.scalingSection()
		]);
	},

	/* ------------------------------------------------------------ snapshots */

	snapshotsSection() {
		const list = E('div', {});
		const self = this;

		function refresh() {
			return api.ask(api.calls.configList).then(result => self.snapshotsPaint(list, result, refresh));
		}

		poll.add(refresh, 10);
		refresh();

		return bmui.section(_('Snapshots'),
			_('The router keeps a copy of its own configuration before every change it makes, and can put one back without anybody being able to reach it.'),
			E('div', {}, [
				bmui.toolbar([
					E('button', {
						'class': 'btn cbi-button-apply',
						'click': ui.createHandlerFn(self, function() {
							return api.run(api.calls.configSnapshot, { reason: 'manual' },
								_('Taken.')).then(refresh);
						})
					}, _('Take a snapshot now'))
				]),
				list
			]));
	},

	snapshotsPaint(node, result, refresh) {
		if (!result.ok) {
			dom.content(node, E('p', { 'class': 'alert-message warning' }, result.error));
			return;
		}

		const rows = asRows(asRecord(result.data).snapshots);
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
						return self.downloadSnapshot(entry);
					})
				}, _('Download')),
				' ',
				entry.baseline
					? E('span', { 'class': 'bm-muted', 'style': 'margin-left:.5em' }, _('kept forever'))
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
			bmui.tableWrap(table.render()),
			E('div', { 'class': 'cbi-section-descr' },
				_('The ten most recent are kept, and the baseline on top of those, which is never deleted by anything.'))
		]);
	},

	/**
	 * Save a snapshot to the machine looking at this page. What comes down is
	 * the snapshot itself - the stored `uci export` of each package - so the
	 * file restores on any router, including one that has never had any of
	 * this installed.
	 */
	downloadSnapshot(entry) {
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

	/** What restoring would change, line by line. */
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

			const data = asRecord(result.data);
			const packages = asRows(data.packages);

			const body = packages.length
				? packages.map(one => E('div', { 'style': 'margin-bottom:1em' }, [
					E('h5', {}, one.package),
					E('pre', { 'style': 'max-height:14em;overflow:auto;white-space:pre-wrap' },
						asRows(one.restores).map(line => '+ ' + line + '\n').join('') +
						asRows(one.discards).map(line => '- ' + line + '\n').join(''))
				]))
				: [E('p', {}, _('Nothing has changed since this snapshot was taken.'))];

			ui.showModal(_('Changes since %s').format(api.when(entry.at)), [
				E('p', {}, _('%d line(s) differ. A line marked + comes back when this is restored; a line marked - goes away.').format(data.changes | 0)),
				E('p', { 'class': 'bm-muted' },
					_('These are configuration lines exactly as the router exports them, so some of them carry keys and passwords.')),
				E('div', {}, body),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
		});
	},

	/** Two steps, and the first one is the router's own dry run. */
	askRestore(entry, refresh) {
		const self = this;

		ui.showModal(_('Restore the snapshot from %s').format(api.when(entry.at)), [
			E('p', { 'class': 'spinning' }, _('Asking the router what this would change...'))
		]);

		return api.ask(api.calls.configRestore, { id: entry.id, dry_run: true }).then(result => {
			const title = _('Restore the snapshot from %s').format(api.when(entry.at));

			const dry = asRecord(result.data);

			if (!result.ok || dry.ok === false) {
				ui.showModal(title, [
					E('p', { 'class': 'alert-message warning' },
						result.ok ? (dry.reason ?? _('The router would not do it.')) : result.error),
					E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
				]);
				return;
			}

			const changes = dry.changes | 0;
			const packages = asRows(dry.packages).map(one => one.package);

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
		const payload = asRecord(data);
		const failed = asRows(payload.reloaded).filter(one => one.ok !== true).map(one => one.service);

		if (failed.length) {
			ui.addNotification(null, E('p', {},
				_('Restored %s, but these did not reload: %s. Check "logread -e bm-agent".')
					.format(asRows(payload.restored).join(', '), failed.join(', '))), 'warning');
			return;
		}

		ui.addNotification(null, E('p', {},
			_('Restored %s and reloaded what needed it.').format(asRows(payload.restored).join(', '))), 'info');
	},

	/* -------------------------------------------------------------- updates */

	updatesSection(info, last) {
		const versions = E('div', {});
		const found = E('div', {});
		const self = this;

		self.latest = null;

		function paintVersions() {
			dom.content(versions, bmui.tiles([
				[_('Installed'), info.release ?? '?'],
				[_('Latest'), self.latest ? self.latest.latest : _('not asked')],
				[_('Data schema'), '%d / %d'.format(info.dataSchema ?? 0, info.schema | 0)],
				[_('Update source'), (info.updateUrl && info.updateUrl.length) ? _('configured') : _('not set')]
			]));
		}

		paintVersions();
		self.paintVersions = paintVersions;

		return bmui.section(_('Updates'),
			_('This router checks for a new release only when somebody asks it to, and installs one only under the countdown.'),
			E('div', {}, [
				versions,
				bmui.toolbar([
					E('button', {
						'class': 'btn cbi-button-action',
						'click': ui.createHandlerFn(self, function() {
							return self.check(found);
						})
					}, _('Check for updates')),
					E('button', {
						'class': 'btn cbi-button-reset',
						'click': ui.createHandlerFn(self, function() {
							return self.rollback();
						})
					}, _('Roll back to the previous set'))
				]),
				found,
				this.lastUpdateBlock(last),
				E('details', { 'style': 'margin:.6em 0' }, [
					E('summary', {}, _('What an update does, step by step')),
					E('ol', {}, updateSteps().map(text => E('li', {}, text))),
					E('p', { 'class': 'bm-muted' },
						_('Each step is written to the system log as it happens. At a console: "logread -e bm-agent", or "bmctl version" for what this router answers now.'))
				])
			]));
	},

	lastUpdateBlock(last) {
		if (!last || !(last.at | 0)) {
			return E('p', { 'class': 'bm-muted' },
				_('No update has been applied on this router. A first install done from the Bored Manager app does not count as one.'));
		}

		return E('div', { 'class': 'bm-small' }, [
			E('p', {}, _('Last update: %s, %s to %s. Packages: %s.').format(
				api.when(last.at), last.from ?? '?', last.to ?? '?',
				asRows(last.packages).join(', ') || '-')),
			E('p', {}, last.migrated === false
				? _('The schema migration did not finish. Run "bmctl schema" to see why.')
				: _('The schema migration finished.'))
		]);
	},

	/** Ask, and say exactly which part failed. */
	check(node) {
		const self = this;

		dom.content(node, E('p', { 'class': 'spinning' }, _('Asking the release server...')));

		return api.ask(api.calls.updateCheck).then(result => {
			if (!result.ok) {
				dom.content(node, E('p', { 'class': 'alert-message warning' }, result.error));
				return;
			}

			const data = asRecord(result.data);

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
				dom.content(node, bmui.section(_('Up to date'),
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

		return bmui.section(_('%s is available').format(data.latest), null, [
			E('p', {}, _('This router is on %s. Signed by key %s, fetched from %s.')
				.format(data.current ?? '?', data.key ?? '?', data.url ?? '?')),
			E('ul', {}, asRows(data.packages).map(one => E('li', {},
				_('%s %s, %s').format(one.name ?? '?', one.version ?? '?', api.size(one.size))))),
			(data.notes && data.notes.length) ? E('pre', { 'style': 'white-space:pre-wrap' }, data.notes) : '',
			E('div', { 'style': 'margin:.5em 0' }, [
				E('label', {}, [guard, ' ', _('Put the router back if nobody confirms')]),
				E('span', { 'style': 'margin-left:1em' }, [_('after'), ' ', timeout, ' ', _('seconds')])
			]),
			bmui.toolbar([
				E('button', {
					'class': 'btn cbi-button-neutral',
					'click': ui.createHandlerFn(self, function() {
						return self.applyUpdate(data, true, guard.checked, parseInt(timeout.value, 10));
					})
				}, _('Show what would happen')),
				E('button', {
					'class': 'btn cbi-button-apply',
					'click': ui.createHandlerFn(self, function() {
						if (!confirm(_('Install %s now? The services being replaced include the one that maintains this router\'s routing rules.').format(data.latest)))
							return Promise.resolve();

						return self.applyUpdate(data, false, guard.checked, parseInt(timeout.value, 10));
					})
				}, _('Update now'))
			])
		]);
	},

	/** Apply, then tell the truth about what came out. */
	applyUpdate(data, dryRun, withGuard, seconds) {
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
					_('Nothing was installed. It would have fetched: %s.').format(asRows(result.packages).join(', '))), 'info');
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

	/* -------------------------------------------------------------- scaling */

	/**
	 * The kernel limits, read live and written through the agent. Every value
	 * is applied to /proc/sys at once and pinned under /etc/sysctl.d/, so it
	 * holds across reboots; the agent refuses anything outside its own bounds
	 * or a threshold trio out of order, so a typo cannot wreck the neighbour
	 * cache staging.
	 */
	scalingSection() {
		const body = E('div', {}, E('p', { 'class': 'spinning' }, _('Asking the router...')));
		const self = this;

		function refresh() {
			return api.ask(api.calls.tuneGet).then(result => {
				if (!result.ok) {
					dom.content(body, E('p', { 'class': 'alert-message warning' }, result.error));
					return null;
				}

				dom.content(body, self.scalingForm(result.data ?? {}, refresh));
				return null;
			});
		}

		refresh();

		return bmui.section(_('Scaling'),
			_('The two kernel tables that overflow first at thousands of sessions or clients, and the fw4 flow offload that keeps rule lookups off the CPU. Values apply immediately and persist across reboots.'),
			body);
	},

	scalingForm(state, refresh) {
		const values = state.values ?? {};
		const self = this;

		const count = values.conntrack_count;
		const max = values.conntrack_max;
		const usage = (count != null && max != null && max > 0) ? Math.round((count / max) * 100) : null;

		const conntrack = bmui.textInput(max != null ? '%d'.format(max) : '', '262144', '9em');
		const thresh1 = bmui.textInput(values.gc_thresh1 != null ? '%d'.format(values.gc_thresh1) : '', '2048', '8em');
		const thresh2 = bmui.textInput(values.gc_thresh2 != null ? '%d'.format(values.gc_thresh2) : '', '4096', '8em');
		const thresh3 = bmui.textInput(values.gc_thresh3 != null ? '%d'.format(values.gc_thresh3) : '', '8192', '8em');
		const offload = bmui.checkbox(values.flow_offload === true);

		function preset(entry) {
			return E('button', {
				'class': 'btn cbi-button-neutral',
				'click': function(ev) {
					ev.preventDefault();
					conntrack.value = '%d'.format(entry.conntrack);
					thresh1.value = '%d'.format(entry.thresh[0]);
					thresh2.value = '%d'.format(entry.thresh[1]);
					thresh3.value = '%d'.format(entry.thresh[2]);
				}
			}, entry.label);
		}

		const headroom = usage === null
			? bmui.pill('idle', _('unknown'))
			: (usage >= 80 ? bmui.pill('bad', _('%d%% full').format(usage))
				: (usage >= 60 ? bmui.pill('warn', _('%d%% used').format(usage))
					: bmui.pill('ok', _('%d%% used').format(usage))));

		return E('div', {}, [
			E('p', {}, [
				_('Connection tracking: %s of %s entries in use.').format(
					count != null ? '%d'.format(count) : '?',
					max != null ? '%d'.format(max) : '?'),
				' ',
				headroom
			]),
			usage !== null && usage >= 80
				? bmui.riskNote(_('The conntrack table is nearly full. When it fills, the kernel drops new connections with only a dmesg line to show for it - raise the limit below.'))
				: '',
			bmui.field(_('conntrack max'), conntrack,
				_('Entries the connection-tracking table can hold. Roughly 300 bytes of kernel memory each; 262144 suits a few thousand busy clients.')),
			bmui.field(_('Neighbour thresholds'), E('span', {}, [thresh1, ' / ', thresh2, ' / ', thresh3]),
				_('gc_thresh1/2/3 of the ARP cache. The kernel refuses new neighbours at the third; keep it above twice the expected client count, and the three in order.')),
			bmui.field(_('Software flow offload'), offload,
				_('fw4 fastpath for established flows. Cuts per-packet rule lookups at thousands of linear fib rules; committed to the firewall config and reloaded.')),
			bmui.toolbar([
				preset(PRESETS[0]),
				preset(PRESETS[1]),
				E('button', {
					'class': 'btn cbi-button-apply',
					'click': ui.createHandlerFn(self, function() {
						const wanted = {
							conntrack_max: bmui.whole(conntrack, 16384, 4194304),
							gc_thresh1: bmui.whole(thresh1, 128, 1048576),
							gc_thresh2: bmui.whole(thresh2, 128, 1048576),
							gc_thresh3: bmui.whole(thresh3, 128, 1048576)
						};

						if (wanted.conntrack_max === null || wanted.gc_thresh1 === null ||
							wanted.gc_thresh2 === null || wanted.gc_thresh3 === null) {
							ui.addNotification(null, E('p', {},
								_('conntrack max is 16384 to 4194304 and each threshold 128 to 1048576, whole numbers only.')), 'warning');
							return Promise.resolve();
						}

						wanted.flow_offload = offload.checked;

						return api.run(api.calls.tuneSet, wanted,
							_('Applied, and pinned under /etc/sysctl.d/ so it survives a reboot.'))
							.then(refresh);
					})
				}, _('Apply and persist'))
			]),
			E('p', { 'class': 'bm-muted bm-small' },
				_('Persisted in %s. The guard\'s snapshots deliberately do not cover this file, so a restore never quietly shrinks a capacity fix. At a console: "bmctl tune".').format(state.file ?? '/etc/sysctl.d/60-bm-scale.conf'))
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
