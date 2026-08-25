'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require bm.api as api';

/*
 * The PPPoE pools, and the sessions in them.
 *
 * The session table opens on "Needs attention" and that is deliberate rather
 * than lazy: five thousand rows saying "up" is not something anybody reads,
 * and the question being asked of this table is almost always "what is wrong".
 * The daemon takes the same view - `scope` defaults to attention on its side
 * too - so the default costs one filter on the router rather than five
 * thousand rows over the wire.
 *
 * Pools are created here, credentials and all, and that needs a word about how.
 * A password must never become an argument to a process - /proc/<pid>/cmdline
 * is world-readable - which is why the module writes a 0600 file over SSH and
 * passes only its path. A ubus call from this page is not a command line: it
 * travels over a unix socket and arrives at the daemon as a parsed object. So
 * the credentials go inline, to `pool_add`, and the ACL grants that method and
 * not `pool_create` - which names a file for the daemon to read and unlink as
 * root, and would hand a web session an arbitrary delete in /tmp.
 *
 * The list is sent in chunks of CHUNK because a ubus message has a size ceiling
 * and one call writing five thousand sections would hold the daemon's event
 * loop for the whole of it. The pool exists from the first chunk onwards, so a
 * browser that goes away half way leaves a smaller pool rather than wreckage:
 * the record covers what was written, Delete removes it, and Add sessions
 * carries on from where it stopped.
 */

/** What the daemon will accept in one action call. */
const BATCH_LIMIT = 500;

/** What it will accept in one pool_add or pool_append. INLINE_ACCOUNTS there. */
const CHUNK = 200;

/** The most parse errors worth printing before the point has been made. */
const SHOWN_ERRORS = 5;

const SCOPES = [
	['attention', _('Needs attention')],
	['down', _('Not up')],
	['up', _('Up')],
	['all', _('Everything')]
];

const state = {
	scope: 'attention',
	pool: '',
	chosen: {},
	shown: []
};

function stateDot(name) {
	if (name === 'up') return api.dot('ok', _('up'));
	if (name === 'dialing') return api.dot('busy', _('dialing'));
	if (name === 'error') return api.dot('bad', _('error'));
	if (name === 'down') return api.dot('idle', _('down'));
	return api.dot('idle', _('not seen yet'));
}

function chosenSections() {
	return Object.keys(state.chosen).filter(name => state.chosen[name]);
}

/*
 * The account list, read exactly as the app reads it.
 *
 * Deliberately the same rules as parsePppoeList in the module - tab, comma,
 * semicolon, pipe or whitespace, an optional third VLAN field, # for a comment -
 * because the file somebody pastes here is the file they were given, and a list
 * that works in one place and not the other is a bug report nobody can act on.
 */
function splitLine(line) {
	if (line.indexOf('\t') >= 0) return line.split(/\t+/).map(part => part.trim());
	if (line.indexOf(',') >= 0) return line.split(',').map(part => part.trim());
	if (line.indexOf(';') >= 0) return line.split(';').map(part => part.trim());
	if (line.indexOf('|') >= 0) return line.split('|').map(part => part.trim());
	if (/\s/.test(line)) return line.trim().split(/\s+/);
	return null;
}

function parseAccounts(text) {
	const rows = [];
	const errors = [];
	const duplicates = [];
	const seen = {};

	String(text ?? '').split(/\r?\n/).forEach(function(raw, offset) {
		const line = raw.trim();
		if (!line.length || line.charAt(0) === '#')
			return;

		const fields = splitLine(line);
		if (!fields || fields.length < 2 || fields.length > 3) {
			errors.push(_('line %d: expected a username and a password, with an optional VLAN').format(offset + 1));
			return;
		}

		const user = fields[0] ?? '';
		const pass = fields[1] ?? '';
		const vlanText = fields[2] ?? '';

		if (!user.length || user.length > 64) {
			errors.push(_('line %d: the username has to be 1 to 64 characters').format(offset + 1));
			return;
		}
		if (!pass.length || pass.length > 64) {
			errors.push(_('line %d: the password has to be 1 to 64 characters').format(offset + 1));
			return;
		}

		const row = { user: user, pass: pass };

		if (vlanText.length) {
			const vlan = Number(vlanText);
			if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) {
				errors.push(_('line %d: the VLAN has to be a whole number from 1 to 4094').format(offset + 1));
				return;
			}
			row.vlan = vlan;
		}

		if (seen[user] && duplicates.indexOf(user) < 0)
			duplicates.push(user);
		seen[user] = true;

		rows.push(row);
	});

	return { rows: rows, errors: errors, duplicates: duplicates };
}

/**
 * Send everything after the first chunk.
 *
 * The first chunk is the caller's call - a create, or the first append - and
 * every chunk after it has the same shape, so this is written once and used by
 * both. It reports as it goes rather than at the end: five thousand accounts is
 * twenty-five calls, and a page that says nothing for that long looks stuck.
 */
function appendRest(id, rows, from, done, report) {
	if (from >= rows.length)
		return Promise.resolve({ ok: true, done: done });

	return api.ask(api.calls.poolAppend, { id: id, accounts: rows.slice(from, from + CHUNK) })
		.then(function(result) {
			if (!result.ok)
				return { ok: false, reason: result.error, done: done };

			const data = result.data ?? {};
			if (data.ok === false)
				return { ok: false, reason: data.reason ?? _('The router would not say why.'), done: done };

			const total = done + (data.created | 0);
			report(total, rows.length);

			return appendRest(id, rows, from + CHUNK, total, report);
		});
}

/** One labelled row of a modal form, in LuCI's own shape. */
function field(label, node, hint) {
	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, label),
		E('div', { 'class': 'cbi-value-field' }, [
			node,
			hint ? E('div', { 'class': 'cbi-value-description' }, hint) : ''
		])
	]);
}

function textInput(value, placeholder, width) {
	return E('input', {
		'type': 'text',
		'class': 'cbi-input-text',
		'value': value ?? '',
		'placeholder': placeholder ?? '',
		'style': 'width:%s'.format(width ?? '14em')
	});
}

/** A whole number from a field, or null when it is not one. */
function whole(node, low, high) {
	const raw = node.value.trim();
	if (!/^[0-9]+$/.test(raw))
		return null;

	const value = Number(raw);
	return (value >= low && value <= high) ? value : null;
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
				_('This page is drawn from what the router reports, and bm-agent did not answer: %s').format(first.error))]);
		}

		if (!api.has(first.data, 'pppoe')) {
			return E([], [banner, api.notice(
				_('bm-pppoe-pool is not installed'),
				_('Without it this router has no pools of its own. The Bored Manager app can still dial a pool here over SSH - it writes the sections a chunk at a time, so a pool of thousands takes proportionally longer to create, and sessions are noticed at the next poll rather than the moment netifd reports them.'),
				E('p', {}, _('Install it from Router packages in the app, or with "apk add bm-pppoe-pool" on this router.')))]);
		}

		const pools = E('div', {});
		const sessions = E('div', {});
		const controls = E('div', { 'style': 'margin:.5em 0' });

		const self = this;

		function refresh() {
			return Promise.all([
				api.ask(api.calls.poolInfo),
				api.ask(api.calls.poolSessions, { id: state.pool, scope: state.scope })
			]).then(answers => {
				self.paintPools(pools, answers[0]);
				// The router's own clock, taken from the same reply the pools
				// came from, so an age is never worked out against a browser
				// clock that disagrees with the router's.
				self.paintSessions(sessions, answers[1],
					answers[0].ok ? api.routerNow(answers[0].data) : 0);
			});
		}

		self.refresh = refresh;

		dom.content(controls, self.controlRow(refresh));

		poll.add(refresh, 5);
		refresh();

		return E([], [
			banner,
			E('h2', {}, _('PPPoE Pools')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Pools this router dials by itself. Sessions are watched through netifd events, so a line that drops is noticed when it drops.')),
			pools,
			controls,
			sessions
		]);
	},

	controlRow(refresh) {
		const self = this;

		const scope = E('select', {
			'class': 'cbi-input-select',
			'change': function(ev) {
				state.scope = ev.target.value;
				state.chosen = {};
				refresh();
			}
		}, SCOPES.map(entry => E('option', {
			'value': entry[0],
			'selected': entry[0] === state.scope ? '' : null
		}, entry[1])));

		function batch(action, label, confirmText) {
			return E('button', {
				'class': 'btn cbi-button-action',
				'click': ui.createHandlerFn(self, function() {
					const names = chosenSections();

					if (!names.length) {
						ui.addNotification(null, E('p', {}, _('Tick the sessions to act on first.')), 'warning');
						return Promise.resolve();
					}
					if (names.length > BATCH_LIMIT) {
						ui.addNotification(null, E('p', {},
							_('At most %d sessions in one call; %d are ticked.').format(BATCH_LIMIT, names.length)), 'warning');
						return Promise.resolve();
					}
					if (confirmText && !confirm(confirmText.format(names.length)))
						return Promise.resolve();

					return api.run(api.calls.poolAction, { action: action, sections: names },
						_('Asked the router to %s %d session(s).').format(label, names.length))
						.then(() => { state.chosen = {}; return refresh(); });
				})
			}, label);
		}

		this.counter = E('span', { 'style': 'opacity:.75;margin:0 1em' }, '');

		return E('div', {}, [
			E('label', { 'style': 'margin-right:.5em' }, _('Show:')),
			scope,
			' ',
			E('button', {
				'class': 'btn cbi-button-neutral',
				'click': ui.createHandlerFn(self, function() {
					for (const name of state.shown)
						state.chosen[name] = true;
					return refresh();
				})
			}, _('Tick all shown')),
			' ',
			E('button', {
				'class': 'btn cbi-button-neutral',
				'click': ui.createHandlerFn(self, function() {
					state.chosen = {};
					return refresh();
				})
			}, _('Clear')),
			this.counter,
			batch('up', _('Start'), null),
			' ',
			batch('down', _('Stop'), _('Stop %d session(s)? Anybody using them loses their connection.')),
			' ',
			batch('redial', _('Redial'), _('Redial %d session(s)? Each one drops and dials again.')),
			' ',
			E('button', {
				'class': 'btn cbi-button-neutral',
				'click': ui.createHandlerFn(self, function() {
					return api.run(api.calls.poolReconcile, {}, _('The router has re-read netifd and the counters.'))
						.then(() => self.refresh());
				})
			}, _('Refresh from netifd')),
			' ',
			E('button', {
				'class': 'btn cbi-button-add',
				'click': ui.createHandlerFn(self, function() {
					return self.askCreate(refresh);
				})
			}, _('Create a pool'))
		]);
	},

	/**
	 * The account textarea, its counter, and the block that reports progress.
	 *
	 * Shared by create and append because they ask for the same thing in the
	 * same way, and the counter under the box is the cheapest possible answer
	 * to "did my paste actually arrive" - which is the question somebody has
	 * after pasting four thousand lines into a text box.
	 */
	accountBox() {
		const count = E('div', { 'class': 'cbi-value-description' }, _('Nothing pasted yet.'));

		const box = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': '10',
			'style': 'width:100%;font-family:monospace',
			'placeholder': 'user@isp\tpassword\nuser2@isp\tpassword2',
			'input': function() {
				const parsed = parseAccounts(box.value);
				dom.content(count, parsed.errors.length
					? _('%d account(s), %d line(s) that cannot be read').format(parsed.rows.length, parsed.errors.length)
					: _('%d account(s)').format(parsed.rows.length));
			}
		});

		return { box: box, count: count };
	},

	/**
	 * Run a chunked send behind a modal, and report either way.
	 *
	 * The buttons go away for the duration rather than being disabled: a create
	 * that is half done cannot be cancelled from here in any meaningful sense -
	 * the sessions already written are written - so offering a Cancel would be
	 * offering something this page cannot do.
	 */
	sendAll(rows, buttons, status, firstCall, firstArgs, id, refresh) {
		function report(done, total) {
			dom.content(status, E('p', {}, _('Written %d of %d...').format(done, total)));
		}

		dom.content(buttons, '');
		report(0, rows.length);

		return api.ask(firstCall, firstArgs).then(function(result) {
			if (!result.ok)
				return { ok: false, reason: result.error, done: 0 };

			const data = result.data ?? {};
			if (data.ok === false)
				return { ok: false, reason: data.reason ?? _('The router would not say why.'), done: 0 };

			const done = data.created | 0;
			report(done, rows.length);

			return appendRest(id, rows, CHUNK, done, report);
		}).then(function(outcome) {
			ui.hideModal();

			if (outcome.ok) {
				ui.addNotification(null, E('p', {},
					_('%d session(s) written to pool %s. They are dialling now.').format(outcome.done, id)), 'info');
			}
			else if (outcome.done) {
				ui.addNotification(null, E('p', {},
					_('%d session(s) were written and then the router stopped: %s').format(outcome.done, outcome.reason)), 'warning');
			}
			else {
				ui.addNotification(null, E('p', {}, outcome.reason), 'warning');
			}

			return refresh();
		});
	},

	/** New pool: everything about it, and the accounts that fill it. */
	askCreate(refresh) {
		const self = this;

		const id = textInput('', 'ppp', '10em');
		const prefix = textInput('', 'ppp', '6em');
		const carrier = textInput('', 'eth1', '10em');
		const vlan = textInput('0', '0', '6em');
		const seqFrom = textInput('1', '1', '8em');
		const tableBase = textInput('1000', '1000', '8em');

		const accounts = self.accountBox();
		const status = E('div', { 'style': 'margin:.5em 0' });
		const buttons = E('div', { 'class': 'right' });

		function submit() {
			const parsed = parseAccounts(accounts.box.value);

			if (!parsed.rows.length) {
				dom.content(status, E('p', { 'class': 'alert-message warning' },
					_('Paste at least one account. One line each: username, then password, separated by a tab, a comma, a semicolon, a pipe or a space.')));
				return Promise.resolve();
			}

			if (parsed.errors.length) {
				dom.content(status, E('div', { 'class': 'alert-message warning' }, [
					E('p', {}, _('%d line(s) cannot be read, so nothing was created:').format(parsed.errors.length)),
					E('ul', {}, parsed.errors.slice(0, SHOWN_ERRORS).map(text => E('li', {}, text))),
					parsed.errors.length > SHOWN_ERRORS
						? E('p', {}, _('...and %d more.').format(parsed.errors.length - SHOWN_ERRORS))
						: ''
				]));
				return Promise.resolve();
			}

			const seq = whole(seqFrom, 1, 99999);
			const table = whole(tableBase, 1, 65535);
			const tag = whole(vlan, 0, 4094);

			if (seq === null || table === null || tag === null) {
				dom.content(status, E('p', { 'class': 'alert-message warning' },
					_('The first session number has to be 1 or more, the table base 1 to 65535, and the VLAN 0 to 4094. The VLAN may be 0, meaning none.')));
				return Promise.resolve();
			}

			// The two ranges the daemon checks when it reads the record back.
			// Said here because a create that writes a record the next read
			// throws away is worse than a refusal: the interfaces exist and
			// nothing is left that knows they are a pool.
			if (seq + parsed.rows.length - 1 > 99999) {
				dom.content(status, E('p', { 'class': 'alert-message warning' },
					_('Starting at %d, %d accounts would run past session number 99999, and a session is named with five digits.').format(seq, parsed.rows.length)));
				return Promise.resolve();
			}

			if (table + seq + parsed.rows.length - 1 > 65535) {
				dom.content(status, E('p', { 'class': 'alert-message warning' },
					_('A table base of %d plus session %d is past 65535, which is the highest routing table there is.').format(table, seq + parsed.rows.length - 1)));
				return Promise.resolve();
			}

			if (parsed.duplicates.length) {
				dom.content(status, E('p', {},
					_('Note: %d username(s) appear more than once. That is allowed and the pool is being created anyway.').format(parsed.duplicates.length)));
			}

			return self.sendAll(parsed.rows, buttons, status, api.calls.poolAdd, {
				id: id.value.trim(),
				prefix: prefix.value.trim(),
				carrier: carrier.value.trim(),
				seq_from: seq,
				table_base: table,
				vlan: tag,
				accounts: parsed.rows.slice(0, CHUNK)
			}, id.value.trim(), refresh);
		}

		dom.content(buttons, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', {
				'class': 'btn cbi-button-add',
				'click': ui.createHandlerFn(self, submit)
			}, _('Create it'))
		]);

		ui.showModal(_('Create a PPPoE pool'), [
			E('p', {}, _('One interface per account, dialled by netifd and watched by this router. The pool record is what makes deleting it later mean these interfaces and no others.')),
			field(_('Pool name'), id, _('Lower case letters, digits and underscores. This is what you delete it by.')),
			field(_('Interface prefix'), prefix, _('1 to 4 characters, starting with a letter. Sessions are named prefix00001 upwards.')),
			field(_('Carrier device'), carrier, _('The physical device the sessions dial over, such as eth1.')),
			field(_('VLAN'), vlan, _('0 for none. A VLAN device is created for it if one is needed.')),
			field(_('First session number'), seqFrom, _('Where this pool\'s numbering starts, from 1. Two pools sharing a prefix must not overlap.')),
			field(_('Routing table base'), tableBase, _('Each session gets its own table, counting up from here.')),
			field(_('Accounts'), E('div', {}, [accounts.box, accounts.count]),
				_('One per line: username, password, and optionally a VLAN. Separate them with a tab, a comma, a semicolon, a pipe or a space. Lines starting with # are ignored.')),
			E('p', {}, _('The passwords go to the router over this login\'s connection and are written straight into the network configuration. They are never an argument to any command, on this router or anywhere else.')),
			status,
			buttons
		]);

		return Promise.resolve();
	},

	/** More sessions on the end of a pool that already exists. */
	askAppend(pool, refresh) {
		const self = this;

		const accounts = self.accountBox();
		const status = E('div', { 'style': 'margin:.5em 0' });
		const buttons = E('div', { 'class': 'right' });

		const next = (pool.seqTo | 0) + 1;

		function submit() {
			const parsed = parseAccounts(accounts.box.value);

			if (!parsed.rows.length) {
				dom.content(status, E('p', { 'class': 'alert-message warning' },
					_('Paste at least one account.')));
				return Promise.resolve();
			}

			if (parsed.errors.length) {
				dom.content(status, E('div', { 'class': 'alert-message warning' }, [
					E('p', {}, _('%d line(s) cannot be read, so nothing was added:').format(parsed.errors.length)),
					E('ul', {}, parsed.errors.slice(0, SHOWN_ERRORS).map(text => E('li', {}, text)))
				]));
				return Promise.resolve();
			}

			if (next + parsed.rows.length - 1 > 99999) {
				dom.content(status, E('p', { 'class': 'alert-message warning' },
					_('Starting at %d, %d accounts would run past session number 99999, and a session is named with five digits.').format(next, parsed.rows.length)));
				return Promise.resolve();
			}

			if ((pool.tableBase | 0) + next + parsed.rows.length - 1 > 65535) {
				dom.content(status, E('p', { 'class': 'alert-message warning' },
					_('This pool\'s table base plus session %d is past 65535, which is the highest routing table there is.').format(next + parsed.rows.length - 1)));
				return Promise.resolve();
			}

			return self.sendAll(parsed.rows, buttons, status, api.calls.poolAppend, {
				id: pool.id,
				accounts: parsed.rows.slice(0, CHUNK)
			}, pool.id, refresh);
		}

		dom.content(buttons, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', {
				'class': 'btn cbi-button-add',
				'click': ui.createHandlerFn(self, submit)
			}, _('Add them'))
		]);

		ui.showModal(_('Add sessions to %s').format(pool.id), [
			E('p', {}, _('These go on the end of the pool, numbered from %s%05d. Everything else - the prefix, the carrier, the VLAN, the table base - is what the pool was created with.').format(pool.prefix, next)),
			E('p', {}, _('Adding here rather than creating a second pool with the same prefix is the point: a second pool whose numbering overlaps would quietly rewrite this one\'s credentials, and the router refuses it for that reason.')),
			field(_('Accounts'), E('div', {}, [accounts.box, accounts.count]),
				_('One per line: username, password, and optionally a VLAN.')),
			status,
			buttons
		]);

		return Promise.resolve();
	},

	paintPools(node, result) {
		if (!result.ok) {
			dom.content(node, E('p', { 'class': 'alert-message warning' }, result.error));
			return;
		}

		const info = result.data;
		const list = info.pools ?? [];
		const now = api.routerNow(info);
		const self = this;

		const table = new ui.Table([
			_('Pool'), _('Prefix'), _('Carrier'), _('Sessions'), _('Up'), _('Dialing'),
			_('Down'), _('Error'), _('Redials'), _('Throughput'), _('Last pass'), ''
		], {
			id: 'bm-pools',
			captionClasses: [null, null, null, null, null, null, null, null, null, null, null, 'cbi-section-actions']
		}, E('em', {}, _('This router has no pools yet. Create one with the button below, from the Bored Manager app, or with "bmpppoe create" at a console.')));

		table.update(list.map(one => [
			one.id,
			one.prefix,
			one.carrier,
			'%d'.format(one.count | 0),
			'%d'.format(one.up | 0),
			'%d'.format(one.dialing | 0),
			'%d'.format(one.down | 0),
			(one.error | 0) ? E('strong', {}, '%d'.format(one.error | 0)) : '0',
			'%d'.format(one.redials | 0),
			api.rate(((one.rate && one.rate.rxBps) | 0) + ((one.rate && one.rate.txBps) | 0)),
			api.ago(one.lastPassAt, now),
			E('div', {}, [
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(self, function() {
						state.pool = (state.pool === one.id) ? '' : one.id;
						state.chosen = {};
						return self.refresh();
					})
				}, state.pool === one.id ? _('Show all pools') : _('Show only this')),
				' ',
				E('button', {
					'class': 'btn cbi-button-add',
					'click': ui.createHandlerFn(self, function() {
						return self.askAppend(one, self.refresh);
					})
				}, _('Add sessions')),
				' ',
				E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(self, function() {
						return self.confirmDelete(one);
					})
				}, _('Delete'))
			])
		]));

		dom.content(node, [
			api.figures([
				[_('Pools'), '%d'.format(list.length)],
				[_('Counter interval'), _('%d s').format(info.counterInterval | 0)],
				[_('Redial after'), _('%d s').format(info.redialAfter | 0)],
				[_('Daemon up'), api.duration(info.uptime)]
			]),
			table.render()
		]);
	},

	/**
	 * Two steps, and the second one has to be typed.
	 *
	 * Deleting a pool takes away every interface in it at once. A confirm box
	 * that only wants a click is the same gesture as the button that opened
	 * it, which is no second step at all.
	 */
	confirmDelete(pool) {
		const self = this;
		const field = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:12em' });

		ui.showModal(_('Delete pool %s').format(pool.id), [
			E('p', {}, _('This removes all %d sessions in the pool and the interfaces behind them. Anybody dialling through one of them loses their connection.').format(pool.count | 0)),
			E('p', {}, _('The accounts themselves are not touched; they live wherever the list came from.')),
			E('p', {}, _('Type the pool name to confirm:')),
			field,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(self, function() {
						if (field.value !== pool.id) {
							ui.addNotification(null, E('p', {}, _('That is not the pool name; nothing was deleted.')), 'warning');
							return Promise.resolve();
						}
						ui.hideModal();
						return api.run(api.calls.poolDelete, { id: pool.id },
							_('Pool %s is gone.').format(pool.id)).then(() => self.refresh());
					})
				}, _('Delete it'))
			])
		]);

		return Promise.resolve();
	},

	paintSessions(node, result, now) {
		if (!result.ok) {
			dom.content(node, E('p', { 'class': 'alert-message warning' }, result.error));
			return;
		}

		const rows = result.data.sessions ?? [];
		const limit = result.data.limit | 0;

		// Rows that have gone out of view keep no tick. Otherwise a filter
		// change could leave a session selected that nobody can see, and the
		// next Stop would take down something that was never on the screen.
		const visible = {};
		state.shown = rows.map(row => row.section);
		for (const row of rows)
			visible[row.section] = true;
		for (const name of Object.keys(state.chosen))
			if (!visible[name]) delete state.chosen[name];

		if (this.counter) {
			const ticked = chosenSections().length;
			dom.content(this.counter, ticked
				? _('%d ticked').format(ticked)
				: _('nothing ticked'));
		}

		const table = new ui.Table([
			'', _('Session'), _('Pool'), _('State'), _('IPv4'), _('Table'), _('In this state'), _('Note')
		], {
			id: 'bm-sessions',
			sortable: [false, true, true, true, true, true, true, true]
		}, E('em', {}, this.emptyText()));

		table.update(rows.map(row => {
			// `since` is when it came up and `downSince` when it went away, so
			// which one is the age depends on where the session is now. A
			// session the router has never seen has neither.
			const stamp = (row.state === 'up') ? (row.since | 0) : (row.downSince | 0);

			return [
				E('input', {
					'type': 'checkbox',
					'checked': state.chosen[row.section] ? '' : null,
					'click': function(ev) {
						state.chosen[row.section] = ev.target.checked;
					}
				}),
				row.section,
				row.pool,
				stateDot(row.state),
				(row.ipv4 && row.ipv4.length) ? row.ipv4 : '-',
				(row.table === null || row.table === undefined) ? '-' : '%d'.format(row.table),
				(stamp && now) ? api.duration(now - stamp) : '-',
				(row.error && row.error.length) ? row.error : ''
			];
		}));

		dom.content(node, [
			table.render(),
			rows.length >= limit
				? E('p', { 'class': 'alert-message warning' },
					_('The router stopped at %d rows. Narrow this down with the filter above, or look at one pool at a time.').format(limit))
				: ''
		]);
	},

	/** Why a table is empty, which is never the same sentence twice. */
	emptyText() {
		if (state.scope === 'attention')
			return _('Nothing needs attention: every session in view is up or dialing.');
		if (state.scope === 'up')
			return _('No session is up.');
		if (state.scope === 'down')
			return _('Every session is up.');
		return _('This router knows of no sessions at all.');
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
