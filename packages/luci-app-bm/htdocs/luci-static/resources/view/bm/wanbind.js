'use strict';
'require view';
'require ui';
'require uci';
'require poll';
'require dom';
'require bm.api as api';
'require bm.ui as bmui';

/*
 * Every rule this router writes, on one page - and the router writes all of
 * them.
 *
 * Until 2.4.0 half of this lived somewhere else. Instances were plain UCI
 * sections that this browser wrote itself, one-to-one bindings had no surface
 * here at all, and the app wrote their ip rules over SSH while the daemon,
 * which had never been told those rules were anybody's, removed them again
 * every thirty seconds. Two writers is the whole of that bug. There is one
 * writer now: the browser sends a spec and the daemon does the entire
 * sequence - take the old rules off, write the section, hand out the tables
 * and forwardings, run a pass - because only the daemon can do those in the
 * one order that never leaves a rule behind that nothing left admits to.
 *
 * The instance list still comes from `configured` and not from `instances`.
 * `instances` is the list the daemon built state for, so a section that is
 * switched off, or one it refused for a mistake, is not in it - and those are
 * exactly the two rows somebody opens this page to fix. When the daemon is not
 * answering at all the rows come from UCI instead, which loses the reasons and
 * keeps the names: a page that draws nothing is the one state a person cannot
 * act on.
 */

const TARGET_KINDS = [
	['ip', _('An address')],
	['mac', _('A device, wherever its lease puts it')]
];

const WHEN_DOWN = [
	['hold', _('Hold - nothing leaves until that WAN is back')],
	['fallback', _('Fall back - leave by whichever route the router would have used')]
];

/*
 * What a binding's state is, as a colour and a chosen word.
 *
 * `state` is the daemon's own vocabulary and reads as such: `stranded`,
 * `shadowed`, `fallback` and `refused` are precise inside the daemon and are
 * jargon on a screen. Three of them share the amber dot, so the word is the
 * only thing carrying the difference between an address that is parked, one
 * that has moved to a subnet this binding cannot reach, and one that is out on
 * the router's own connection - which is the difference between a client that
 * is blocked and a client that is online through the line the binding exists to
 * avoid. An untranslated token cannot carry that, and translating it is the
 * same job the owners map already does for rules.
 *
 * An unknown token still reaches the screen raw: a state this page has not
 * learnt yet is worth showing as the daemon spells it rather than dropping.
 */
const STATES = {
	'bound': ['ok', _('on its WAN')],
	'held': ['busy', _('held - its WAN is down')],
	'fallback': ['busy', _('out on the router\'s own connection')],
	'stranded': ['busy', _('moved off its LAN')],
	'shadowed': ['idle', _('another binding already has this address')],
	'waiting': ['idle', _('no lease answers to it yet')],
	'disabled': ['idle', _('switched off')],
	'refused': ['bad', _('refused - the section has a mistake')]
};

/*
 * Who each ip rule on the router belongs to, as a colour and a word. Colour
 * says how much it matters - ours and working, ours and blocking, somebody
 * else's - and the word says which, because colour is never the only carrier
 * of meaning on these pages.
 */
const OWNERS = {
	'manual': ['ok', _('by hand')],
	'client': ['ok', _('client')],
	'catch-all': ['warn', _('catch-all')],
	'hold': ['warn', _('hold')],
	// The most numerous owner on any multi-WAN router, and neither ours nor a
	// stranger's: netifd writes three rules for every interface carrying its
	// own routing table, so a box dialling 32 PPPoE sessions has 96 of them.
	// Neutral beside the kernel's own three for exactly that reason - this is
	// the router routing itself, and a page that left it to the raw-token
	// fallback would render the commonest rule on the router as an untranslated
	// word nobody chose.
	'netifd': ['idle', _('the router itself')],
	// One rule per LAN, consulted before every binding rule, so a bound address
	// still reaches the network beside it. Ours, and neutral: it is doing
	// nothing to anybody and there is nothing to go and look at.
	'local': ['idle', _('LAN-local escape')],
	'kernel': ['idle', _('kernel')],
	'foreign': ['bad', _('not ours')]
};

/*
 * The owners this package actually writes.
 *
 * "Everything that is not the kernel's and not a stranger's" was the same list
 * until netifd became an owner of its own, and then it was ninety-six rules
 * wrong on the router that prompted this: the tile read as this package having
 * covered the box in rules when it had written four. Named rather than
 * subtracted, so the next owner the daemon learns to tell apart is not silently
 * counted as ours the day it arrives.
 */
const OURS = { 'manual': true, 'client': true, 'catch-all': true, 'hold': true };

/*
 * What a routing table is to this router, in words rather than in the daemon's
 * tokens. Under a column headed Role, `catch-all` and `hold` are the two most
 * important tables on the page and the two nobody can read: one is the fence
 * that blocks a client rather than letting it out of the wrong line, and the
 * other is where a hand-placed binding waits out its WAN. Same treatment as the
 * owners map above, and for the same reason - an unknown token is shown as the
 * daemon spells it rather than hidden.
 */
const TABLE_ROLES = {
	'main': _('the router\'s own'),
	'wan': _('a WAN\'s own table'),
	'catch-all': _('an instance\'s fail-closed catch-all'),
	'hold': _('where a held binding is parked')
};

/*
 * Said in two places - over the table, and over the failure that replaces it -
 * and it has to be the same sentence both times: a reader who arrives at the
 * failure must not be left wondering whether they are looking at some other,
 * smaller table.
 */
const RULES_DESCR = _('The whole ip rule table as the kernel holds it, not as any configuration file describes it. LuCI\'s own Routing page reads /etc/config/network, where none of these are.');

const state = {
	/* '' every source, 'manual' the hand-placed ones, or an instance id. */
	source: '',
	info: null,
	infoError: null,
	bindings: null,
	bindingsError: null,
	waiting: null,
	waitingError: null,
	rules: null,
	rulesError: null,
	settings: null,
	settingsError: null,
	/* Whether /etc/config/bm_wanbind was read, which is not the same as its
	 * having no instance in it. */
	uciRead: false,
	/* Asked once when a form opens, not on the poll: neither changes while
	 * somebody is typing into the box it filled. */
	wans: [],
	carriers: [],
	layout: []
};

/** UCI has no booleans and every one of these means the same thing. */
function flag(value, fallback) {
	if (value === undefined || value === null || value === '')
		return fallback;
	return ['0', 'no', 'off', 'false', 'disabled'].indexOf(String(value)) < 0;
}

/** The instance filter, which is every filter except "the hand-placed ones". */
function instanceFilter() {
	return (state.source === 'manual') ? '' : state.source;
}

/**
 * What the toolbar is currently narrowed to, named so a sentence can be built
 * about it. Only ever said about a filter that is on: '' has no name because a
 * list that was not narrowed is not a filter anybody has to be told about.
 */
function sourceLabel() {
	return (state.source === 'manual')
		? _('the "By hand" filter')
		: _('instance %s').format(state.source);
}

/** Only the keys a filter actually names, so an older daemon sees none. */
function sourceArgs() {
	return state.source.length ? { source: state.source } : {};
}

function instanceArgs() {
	const id = instanceFilter();
	return id.length ? { instance: id } : {};
}

/**
 * Every configured instance, refused ones and switched-off ones included.
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
			clientsPerWan: (one.clientsPerWan === undefined || one.clientsPerWan === null) ? 1 : (one.clientsPerWan | 0),
			rangeFrom: one.rangeFrom ?? '',
			rangeTo: one.rangeTo ?? '',
			reason: (typeof one.reason === 'string' && one.reason.length) ? one.reason : null,
			source: one
		}));
	}

	return uci.sections('bm_wanbind', 'instance').map(section => ({
		id: section['.name'],
		lan: section.lan ?? '',
		carrier: section.carrier ?? '',
		enabled: flag(section.enabled, true),
		clientsPerWan: (section.clients_per_wan === undefined) ? 1 : (Number(section.clients_per_wan) | 0),
		rangeFrom: section.range_from ?? '',
		rangeTo: section.range_to ?? '',
		reason: null,
		source: null
	}));
}

/** Whole LAN, or the range the instance was given. */
function scopeText(row) {
	if (row.rangeFrom.length && row.rangeTo.length)
		return '%s - %s'.format(row.rangeFrom, row.rangeTo);
	return _('Whole LAN');
}

/** 1, N, or no limit at all. */
function perWanText(limit) {
	if ((limit | 0) === 0)
		return _('no limit');
	return '%d'.format(limit | 0);
}

/** How many of the seats this instance has are taken. */
function seatsText(live) {
	if (!live)
		return '-';
	const seats = live.seats | 0;
	if (seats < 0)
		return _('%d of no limit').format(live.bound | 0);
	return '%d / %d'.format(live.bound | 0, seats);
}

function whyText(row) {
	// 'reserved' is the generator declining to seat an address a hand-placed
	// binding already decides. Not a failure and not a queue - the client has
	// its WAN, from the other half - so it is said as the fact it is.
	if (row.why === 'reserved')
		return _('A binding placed by hand already decides this address');
	if (row.why === 'held' || row.held)
		return _('Held out of the pool by hand');
	if (row.why === 'exhausted')
		return _('No priority left in this instance\'s range - it has to be widened');
	return _('Waiting for a WAN to come free');
}

/** Which instance a row belongs to, whichever key the daemon named it in. */
function instanceOf(row) {
	if (row.instance && row.instance.length)
		return row.instance;
	return (row.source && row.source !== 'manual') ? row.source : '';
}

/**
 * A binding's state, and whether the kernel agrees.
 *
 * `verified: false` is the router saying the kernel took a rule and then did
 * not have it a moment later, which is what a second writer on this router
 * looks like from in here. It is marked on the row rather than only counted in
 * a tile, because the row is where somebody is looking when they wonder why
 * one client is not going where it was told.
 */
function stateDot(row) {
	const word = String(row.state ?? '');
	const known = STATES[word];
	const dot = word.length
		? bmui.dot(known ? known[0] : 'idle', known ? known[1] : word)
		: bmui.dot('idle', _('no pass yet'));

	if (row.verified === false)
		return E('span', {}, [dot, ' ', bmui.pill('bad', _('not in the kernel'))]);

	return dot;
}

/** The address a binding follows, whichever kind it is. */
function addressText(row) {
	if (row.ip && row.ip.length)
		return row.ip;
	if (row.label && row.label.length)
		return row.label;
	if (row.mac && row.mac.length)
		return row.mac;
	return '-';
}

/** "by hand", or the instance a row was grown by. */
function sourceCell(row) {
	if (row.source === 'manual' || !row.source || !row.source.length)
		return bmui.pill('idle', _('by hand'));
	return bmui.pill('ok', row.source);
}

/**
 * What a rule matches, in the words the router already put it in.
 *
 * `selector` is built where the rule was read and is the whole of what it
 * matches: a rule selecting on an incoming interface and on a mark reads as
 * both rather than as half of itself. Rebuilding one from the other fields here
 * would be this page describing a rule that catches more traffic than it does.
 */
function ruleMatch(row) {
	if (row.selector && row.selector.length)
		return row.selector;

	return (row.cidr && row.cidr.length) ? row.cidr : '-';
}

/**
 * Which table a rule hands the packet to, or the plain fact that it hands it to
 * none.
 *
 * `action` is an FR_ACT constant, and falling back to it printed a bare "6" in
 * this column - a number that means something only to somebody with the kernel
 * headers open. A rule that answers the packet itself has no table to name, and
 * saying so is also why it is not among the tables listed underneath.
 */
function ruleTableCell(row) {
	if (row.table | 0)
		return '%d'.format(row.table | 0);

	return E('em', { 'class': 'bm-muted' }, _('looks up no table'));
}

/**
 * What one routing table is to this router.
 *
 * Empty is the daemon saying it could not tell, which is a real answer and not
 * a missing one: a table something else on this router made and nothing here
 * claims. A dash says that; a word this page does not know is passed through as
 * the daemon spelt it.
 */
function roleText(role) {
	const word = String(role ?? '');

	if (!word.length)
		return '-';

	return TABLE_ROLES[word] ?? word;
}

/**
 * What a routing table does with a packet handed to it. Three states, and they
 * are three different things rather than degrees of one.
 *
 * A default that goes somewhere is a way out. `unreachable` is a default that
 * was chosen - this package writes one into every table it parks an address in,
 * so it is a hold doing its job rather than a fault. Neither is a table a rule
 * points at that nobody ever filled in: the lookup finds nothing, the packet
 * carries on down the rule list as though the rule had never matched, and that
 * is the failure that looks from a client exactly like a binding being ignored.
 */
function tableDefault(one) {
	if (one.unreachable)
		return bmui.dot('busy', _('unreachable default - a client landing here is blocked'));

	if (one.hasDefault) {
		if (one.gateway && one.gateway.length && one.device && one.device.length)
			return bmui.dot('ok', _('via %s on %s').format(one.gateway, one.device));

		if (one.device && one.device.length)
			return bmui.dot('ok', _('out of %s, with the link itself as the next hop').format(one.device));

		return bmui.dot('ok', _('a default route, on a device the router did not name'));
	}

	return bmui.dot('idle', _('no default route - a lookup here finds nothing and carries on down the rule list'));
}

/** One end of a move. Nothing at all is one of the ends a field can move from. */
function moveValue(value) {
	const written = (value === undefined || value === null) ? '' : String(value);
	return written.length ? written : _('unset');
}

/** One WAN as a line in a picker: what it is, and what the router reads it as. */
function wanOptionLabel(one) {
	const parts = [];

	if (one.table | 0)
		parts.push(_('table %d').format(one.table | 0));
	if (one.device && one.device.length)
		parts.push(one.device);
	parts.push(one.up ? _('up') : _('down'));
	if (one.instance && one.instance.length)
		parts.push(_('in %s\'s pool').format(one.instance));

	if (one.role === 'lan') {
		const why = Array.isArray(one.evidence) ? one.evidence.join('; ') : '';
		return _('%s - this router reads it as a LAN%s').format(one.name, why.length ? ': ' + why : '');
	}

	return '%s - %s'.format(one.name, parts.join(', '));
}

/**
 * The WAN picker, with the LAN side of the router in it and unselectable.
 *
 * Leaving a LAN out of the list would answer the wrong question: somebody who
 * meant to pick br-lan needs to be told this router reads it as a LAN and what
 * made it think so, not to find the name missing and wonder whether the page
 * has gone stale.
 */
function wanSelect(value) {
	if (!state.wans.length)
		return bmui.textInput(value, 'wan1', '14em');

	const options = state.wans.map(one => E('option', {
		'value': one.name,
		'selected': one.name === value ? '' : null,
		'disabled': one.role === 'lan' ? '' : null
	}, wanOptionLabel(one)));

	if (value.length && !state.wans.some(one => one.name === value))
		options.unshift(E('option', { 'value': value, 'selected': '' }, value));

	return E('select', { 'class': 'cbi-input-select', 'style': 'max-width:100%' }, options);
}

/**
 * A text field with a picker beside it: choose one the router knows, or type
 * anything. The router's list is a suggestion and never a fence - an interface
 * that is about to exist is a perfectly good answer, and a form that refused
 * it would send somebody to a console for a name they had already typed.
 */
function pickerField(value, placeholder, width, options, prompt) {
	const input = bmui.textInput(value, placeholder, width);

	if (!options.length)
		return { node: input, input: input };

	const picker = bmui.selectInput([['', prompt]].concat(options), '');

	picker.addEventListener('change', function() {
		if (String(picker.value).length)
			input.value = picker.value;
		picker.value = '';
	});

	return { node: E('span', {}, [input, ' ', picker]), input: input };
}

/** The LAN candidates the router itself reads as a LAN, with the evidence. */
function lanCandidates() {
	return state.layout.filter(one => one.role === 'lan');
}

function evidenceHint(list) {
	if (!list.length)
		return _('The UCI interface name of the LAN whose clients are bound. Its subnet is read from the router.');

	return E('span', {}, [
		_('The UCI interface name of the LAN whose clients are bound. This router reads these as a LAN:'),
		E('ul', { 'style': 'margin:.3em 0 0 1.2em' }, list.map(one => E('li', {}, [
			E('strong', {}, one.name),
			one.cidr && one.cidr.length ? ' (%s)'.format(one.cidr) : '',
			(Array.isArray(one.lanEvidence) && one.lanEvidence.length)
				? ' - ' + one.lanEvidence.join('; ')
				: ''
		])))
	]);
}

/** A number a form left empty, which means "the router picks one". */
function optionalNumber(node, spec, key, low, high) {
	const raw = String(node.value ?? '').trim();
	if (!raw.length)
		return true;

	const value = bmui.whole(node, low, high);
	if (value === null)
		return false;

	spec[key] = value;
	return true;
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

		// Whether the file behind the fallback rows was read at all. `load`
		// swallows that failure on purpose, so that a router whose daemon is
		// down still gets a page - and swallowing it is exactly what makes an
		// empty `uci.sections()` mean either "no instance is configured" or
		// "nobody managed to open the file". It resolves to the list of
		// packages it loaded, which is an array and never null.
		state.uciRead = Array.isArray(loaded[1]);

		if (!first.ok) {
			return E([], [banner, bmui.notice(
				_('There is no agent on this router'),
				_('This page is drawn from what the router reports, and bm-agent did not answer: %s').format(first.error))]);
		}

		if (!api.has(first.data, 'binding')) {
			return E([], [banner, bmui.notice(
				_('bm-wanbind is not installed'),
				_('Without it there is no WAN Binding on this router: nothing hands a client its own WAN, and nothing keeps a hand-placed binding in force.'),
				E('p', {}, _('Install it from Router packages in the Bored Manager app, or with "apk add bm-wanbind" on this router.')))]);
		}

		const version = E('div', {});
		const tiles = E('div', {});
		const instances = E('div', {});
		const bindings = E('div', {});
		const waiting = E('div', {});
		const rules = E('div', {});
		const settings = E('div', {});

		const self = this;

		function repaint() {
			self.paintVersion(version);
			self.paintTiles(tiles);
			self.paintInstances(instances, refresh);
			self.paintBindings(bindings, refresh);
			self.paintWaiting(waiting, refresh);
		}

		function refresh() {
			return Promise.all([
				api.ask(api.calls.wanbindInfo),
				api.ask(api.calls.wanbindBindings, sourceArgs()),
				api.ask(api.calls.wanbindWaiting, instanceArgs())
			]).then(answers => {
				state.info = answers[0].ok ? answers[0].data : null;
				state.infoError = answers[0].ok ? null : answers[0].error;

				state.bindings = answers[1].ok ? answers[1].data : null;
				state.bindingsError = answers[1].ok ? null : answers[1].error;

				state.waiting = answers[2].ok ? answers[2].data : null;
				state.waitingError = answers[2].ok ? null : answers[2].error;

				repaint();
				return null;
			});
		}

		function refreshRules() {
			// The call is skipped on a daemon that has no such method, so a
			// router running 2.3.0 is not asked the same unanswerable question
			// every ten seconds for as long as the page is open. The block is
			// still painted: the two buttons in it are as old as the daemon.
			if (!self.modern()) {
				state.rules = null;
				state.rulesError = null;
				self.paintRules(rules, refreshRules);
				return Promise.resolve(null);
			}

			// Page by page to the end of the table, without the sentences.
			//
			// One call carries five hundred rows. At five hundred sessions and
			// five hundred bindings this router has about fifteen hundred, so a
			// single call showed a third of them under a heading that did not
			// say so. The sentences are asked for one at a time instead - see
			// the Why column - because fifteen hundred paragraphs is most of the
			// megabyte a ubus reply has.
			const PAGE = 500;
			const MAX_PAGES = 10;

			function walk(collected, offset, pages) {
				return api.ask(api.calls.wanbindRules, {
					limit: PAGE, offset: offset, reasons: false, collapse: true
				}).then(result => {
					if (!result.ok) {
						state.rules = null;
						state.rulesError = result.error;
						return null;
					}

					const data = result.data || {};
					const rows = Array.isArray(data.rules) ? data.rules : [];
					const seen = collected.concat(rows);
					const total = data.count | 0;
					const done = !rows.length || seen.length >= total || pages + 1 >= MAX_PAGES;

					if (!done)
						return walk(seen, seen.length, pages + 1);

					data.rules = seen;
					// Whether the table was cut is decided once, here: every
					// page carries the daemon's `capped` about that page, and
					// the first one always says yes on a large router.
					data.capped = seen.length < total;
					state.rules = data;
					state.rulesError = null;
					return null;
				});
			}

			return walk([], 0, 0).then(() => {
				self.paintRules(rules, refreshRules);
				self.paintTiles(tiles);
				return null;
			});
		}

		function refreshSettings() {
			if (!self.modern())
				return Promise.resolve(null);

			return api.ask(api.calls.wanbindSettingsGet).then(result => {
				state.settings = result.ok ? result.data : null;
				state.settingsError = result.ok ? null : result.error;

				self.paintSettings(settings, refreshSettings);
				return null;
			});
		}

		self.refresh = refresh;

		poll.add(refresh, 5);
		poll.add(refreshRules, 10);

		refresh().then(refreshRules).then(refreshSettings);

		return E([], [
			banner,
			E('h2', {}, _('WAN Binding')),
			E('div', { 'class': 'cbi-map-descr' },
				_('One client, one WAN - decided on this router the moment a lease arrives, or written by hand for an address that always leaves the same way. Everything on this page is the router\'s own: the sections, the ip rules, the routing tables and the firewall forwardings.')),
			version,
			tiles,
			instances,
			bindings,
			waiting,
			rules,
			settings
		]);
	},

	/** Whether this daemon is 2.4.0 or newer, which is what owns its own list. */
	modern() {
		return !!state.info && (state.info.apiVersion | 0) >= 2;
	},

	paintVersion(node) {
		if (!state.info || this.modern()) {
			dom.content(node, null);
			return;
		}

		dom.content(node, bmui.notice(
			_('The bm-wanbind on this router is older than 2.4.0'),
			_('It reports version %s, ubus API %d. Instances, one-to-one bindings and the daemon\'s own numbers cannot be edited from here against that version - the calls that do it are not in it.').format(
				state.info.release ?? '?', state.info.apiVersion | 0),
			E('p', {}, _('What is running is shown below and keeps working. Update the router packages from the Bored Manager app, or with "apk add bm-wanbind" against a 2.4 feed.'))));
	},

	/**
	 * Seven numbers, and the last one is the one nobody thinks to look for: a
	 * write the kernel accepted and then did not have. That is what a second
	 * tool writing into these priorities looks like from in here, and it is the
	 * failure that took a year to find by any other means.
	 *
	 * Both halves of the router are added up, and both are read off the one
	 * `info` reply so that they are the same tick of the same clock. `core` is
	 * the hand-placed bindings and nothing else, `instances` is the pools; a
	 * tile built from either on its own prints a number smaller than the tables
	 * under it, which is the shape this page was wrong in before.
	 *
	 * Held is every binding that is neither on its own WAN nor queued for one -
	 * parked, stranded on the wrong LAN, falling back to the router's own
	 * connection, or shadowed by a binding that already decides its address.
	 * Four different sentences, and the table below says which; what a tile is
	 * for is that none of them is quietly left out of the count. Shadowed is the
	 * one that is easiest to forget, because it is the one down state that
	 * writes no rule at all - which is exactly why a reader who cannot find a
	 * binding in any tile needs it counted here.
	 */
	paintTiles(node) {
		const info = state.info;
		const core = (info && info.core) ? info.core : null;
		const counts = (state.bindings && state.bindings.counts) ? state.bindings.counts : null;

		let bound = core ? (core.bound | 0) : 0;
		let held = core
			? ((core.held | 0) + (core.stranded | 0) + (core.fallback | 0) + (core.shadowed | 0))
			: 0;
		let waiting = core ? (core.waiting | 0) : 0;

		for (const one of (info && info.instances) ? info.instances : []) {
			bound += one.bound | 0;
			held += one.held | 0;
			waiting += one.waiting | 0;
		}

		// `counts` is about the whole router even while the list beside it is
		// filtered, which is why it is asked first: "3 by hand" over a filtered
		// list of one is the number somebody wanted, and the filter is theirs.
		const byHand = counts ? (counts.manual | 0) : (core ? (core.bindings | 0) : null);

		// Nothing rather than zero when the kernel would not answer. An unread
		// rule table is not a router with none of our rules on it, and a tile
		// reading 0 is the same lie as an empty table, told in one character.
		const read = !!state.rules && state.rules.read !== false;
		const listed = (read && Array.isArray(state.rules.rules)) ? state.rules.rules : null;
		const ours = listed ? listed.filter(one => OURS[one.owner] === true).length : null;

		// And a floor rather than a count when that list was capped. The daemon
		// answers with the first `limit` rules and reports the true total apart
		// from them, keeping the lowest priorities - the half the kernel reads
		// first. This package numbers above them, from 19000 up unless somebody
		// moved the band, so on a capped router its catch-alls and client rules
		// are exactly the part that was cut and this tile is counting the part
		// they are not in. It can honestly read nought on a router covered in
		// our rules. `count` is no help either: it is everybody's rules and not
		// ours, so there is no number here to correct it with - what is known is
		// a floor, and both halves of the tile say so rather than letting it be
		// read as a total.
		const capped = ours !== null && state.rules.capped === true;

		const netlink = (info && info.netlink) ? info.netlink : null;
		const unverified = netlink ? (netlink.unverified | 0) : null;

		dom.content(node, bmui.tiles([
			[_('Bound'), info ? '%d'.format(bound) : '-'],
			[_('Held'), info ? '%d'.format(held) : '-'],
			[_('Waiting'), info ? '%d'.format(waiting) : '-'],
			[_('By hand'), byHand === null ? '-' : '%d'.format(byHand)],
			[_('Instances'), info ? '%d'.format((info.configured ?? []).length) : '-'],
			[capped ? _('Rules we wrote, of the %d listed').format(listed.length) : _('Rules we wrote'),
				ours === null ? '-' : (capped ? '%d+'.format(ours) : '%d'.format(ours))],
			[_('Unverified writes'), unverified === null ? '-' : '%d'.format(unverified)]
		]));
	},

	// -------------------------------------------------------------- instances

	paintInstances(node, refresh) {
		const info = state.info;
		const configured = instanceRows(info);
		const running = {};
		const editable = this.modern();
		const self = this;

		for (const one of (info && info.instances) ? info.instances : [])
			running[one.id] = one;

		// An empty list is an empty file only if something read the file. These
		// rows come from the daemon when it answered and from UCI when it did
		// not; when that failed as well nothing was asked of this router at
		// all, and "there is no instance yet" would be this page describing the
		// contents of a file nobody managed to open - and inviting somebody to
		// write a second copy of an instance that may already be in it.
		const read = !!info || state.uciRead;

		const table = new ui.Table([
			_('Instance'), _('LAN'), _('Carrier'), _('Scope'), _('Per WAN'), _('Seats'),
			_('State'), _('Waiting'), _('Held'), _('Free WANs'), _('Clients seen'), _('Last pass'), ''
		], {
			id: 'bm-instances',
			captionClasses: [
				null, null, null, null, null, null, null, null, null, null, null, null,
				'cbi-section-actions'
			]
		}, E('em', {}, read
			? _('There is no instance yet. Add one with the button below; "bmwan instances" reads them back from a console.')
			: _('Nothing was read: the daemon did not answer and /etc/config/bm_wanbind could not be read either. Whether this router has instances is unknown from here - it is not a router with none.')));

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
				// Two different routers arrive here with no live state, and only
				// one of them has a fault. A daemon that answered and did not
				// name this instance is a real per-instance fault, in red. A
				// daemon that was never asked - these rows came out of UCI - has
				// said nothing about any instance, and painting every row red
				// would invent a fault per section out of one failed call.
				dot = info
					? bmui.dot('bad', _('configured, but the daemon has no state for it'))
					: bmui.dot('idle', _('nothing was asked - the daemon is not answering'));
			else if (!live.ready)
				dot = bmui.dot('busy', live.reason ?? _('not ready'));
			else
				dot = bmui.dot('ok', _('binding'));

			const actions = [
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(self, function() {
						state.source = (state.source === one.id) ? '' : one.id;
						return refresh();
					})
				}, state.source === one.id ? _('Show all') : _('Show only this'))
			];

			if (editable) {
				actions.push(' ');
				actions.push(E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(self, function() {
						return self.openInstanceEditor(one, refresh);
					})
				}, _('Edit')));
				actions.push(' ');
				actions.push(E('button', {
					'class': one.enabled ? 'btn cbi-button-reset' : 'btn cbi-button-apply',
					'click': ui.createHandlerFn(self, function() {
						return self.toggleInstance(one, refresh);
					})
				}, one.enabled ? _('Stop') : _('Start')));
				actions.push(' ');
				actions.push(E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(self, function() {
						return self.confirmDeleteInstance(one, refresh);
					})
				}, _('Delete')));
			}

			return [
				one.id,
				one.lan,
				one.carrier,
				scopeText(one),
				perWanText(one.clientsPerWan),
				seatsText(live),
				dot,
				live ? '%d'.format(live.waiting | 0) : '-',
				live ? '%d'.format(live.held | 0) : '-',
				live ? '%d'.format(live.free | 0) : '-',
				live ? '%d'.format(live.devices | 0) : '-',
				(live && info) ? api.ago(live.lastPassAt, api.routerNow(info)) : '-',
				E('div', {}, actions)
			];
		}));

		dom.content(node, bmui.section(_('Instances'),
			_('One instance is one LAN, or one range of it, and one pool of WANs on one carrier. Everything an instance needs - the routing tables, the firewall forwardings, the fail-closed catch-all - is written by the router when the instance is saved.'),
			E('div', {}, [
				state.infoError
					? E('p', { 'class': 'alert-message warning' }, [
						_('The bm-wanbind service is not answering, so the numbers below are missing: %s').format(state.infoError),
						E('br'),
						_('What is configured is still shown. Start it with "/etc/init.d/bm-wanbind start".')
					])
					: '',
				bmui.tableWrap(table.render()),
				editable
					? bmui.toolbar([
						E('button', {
							'class': 'btn cbi-button-add',
							'click': ui.createHandlerFn(self, function() {
								return self.openInstanceEditor(null, refresh);
							})
						}, _('Add an instance'))
					])
					: ''
			])));
	},

	/**
	 * Switch one instance on or off.
	 *
	 * Off takes its rules away, and the router is the one that does it: the
	 * daemon flushes before it writes the section, in that order, inside the
	 * one call. A browser that wrote `enabled 0` itself would leave a section
	 * the daemon never reads again and a set of rules nothing knows are its.
	 */
	toggleInstance(one, refresh) {
		return api.run(api.calls.wanbindInstanceSet, {
			id: one.id,
			lan: one.lan,
			carrier: one.carrier,
			enabled: !one.enabled
		}, one.enabled
			? _('Instance %s is stopped and its rules are off the router.').format(one.id)
			: _('Instance %s is running.').format(one.id)).then(refresh);
	},

	confirmDeleteInstance(one, refresh) {
		const self = this;

		bmui.confirmTyped({
			title: _('Delete instance %s').format(one.id),
			body: [
				E('p', {}, _('Every client this instance was binding goes back to being routed the way the rest of the router routes, and its fail-closed catch-all goes with it.')),
				E('p', {}, _('The router takes its ip rules off, removes the firewall forwardings it made and then removes the section. Nothing is left that only a name could have explained.'))
			],
			expected: one.id,
			actionLabel: _('Delete it'),
			run: function() {
				return api.run(api.calls.wanbindInstanceDelete, { id: one.id },
					_('Instance %s is gone.').format(one.id)).then(refresh);
			}
		});

		return Promise.resolve();
	},

	/** Ask the router what it has before drawing a form full of its names. */
	openInstanceEditor(one, refresh) {
		const self = this;

		return this.readRouter().then(function() {
			self.instanceEditor(one, refresh);
			return null;
		});
	},

	openBindingEditor(row, refresh) {
		const self = this;

		return this.readRouter().then(function() {
			self.bindingEditor(row, refresh);
			return null;
		});
	},

	/**
	 * The two read-only calls every form is built out of: what the router reads
	 * each interface as, and what it can hand out. Both are allowed to fail -
	 * a form with an empty picker and a text box still works, and is a great
	 * deal better than no form.
	 */
	readRouter() {
		return Promise.all([
			api.ask(api.calls.wanbindLayout),
			api.ask(api.calls.wanbindWans)
		]).then(answers => {
			const layout = (answers[0].ok && answers[0].data.ok !== false) ? answers[0].data : null;
			const wans = (answers[1].ok && answers[1].data.ok !== false) ? answers[1].data : null;

			state.layout = layout ? (layout.interfaces ?? []) : [];
			state.wans = wans ? (wans.wans ?? []) : [];
			state.carriers = wans ? (wans.carriers ?? []) : [];
			return null;
		});
	},

	/**
	 * Add an instance, or edit one, through the daemon.
	 *
	 * Two steps, always: `instance_check` writes nothing and answers with the
	 * findings, and only a check that passed puts a Save button on the screen.
	 * That is the same pair the CLI and the app use, so the sentence somebody
	 * reads here is the sentence they would have read anywhere else.
	 *
	 * A number left empty is left out of the spec entirely, which is how this
	 * form says "the router picks one". Absent is not zero: zero is a real
	 * answer to `clients per WAN`, and the daemon reads it as "no limit".
	 */
	instanceEditor(one, refresh) {
		const self = this;
		const creating = !one;
		const previous = (one && one.source) ? one.source : {};

		const idInput = bmui.textInput(creating ? '' : one.id, 'home', '10em', !creating);
		const nameInput = bmui.textInput(previous.name ?? '', _('optional'), '14em');

		const lanCands = lanCandidates();
		const lan = pickerField(creating ? '' : one.lan, 'lan', '12em',
			lanCands.map(entry => [entry.name, entry.name]),
			_('Interfaces this router reads as a LAN'));

		const carrier = pickerField(creating ? '' : one.carrier, 'eth1', '12em',
			state.carriers.map(entry => [
				entry.device,
				_('%s - %d WAN(s), %s').format(entry.device, (entry.wans ?? []).length, entry.up ? _('up') : _('down'))
			]),
			_('Devices this router carries WANs on'));

		const sticky = bmui.checkbox(creating ? true : previous.sticky !== false);
		const remap = bmui.checkbox(creating ? true : previous.remap !== false);
		const raiseDhcp = bmui.checkbox(false);

		const perWan = bmui.textInput(
			creating ? '1' : '%d'.format(one.clientsPerWan | 0), '1', '6em');
		const rangeFrom = bmui.textInput(creating ? '' : one.rangeFrom, _('whole LAN'), '12em');
		const rangeTo = bmui.textInput(creating ? '' : one.rangeTo, _('whole LAN'), '12em');

		function advanced(key, placeholder) {
			const held = previous[key];
			return bmui.textInput(
				(held === undefined || held === null) ? '' : '%d'.format(held | 0),
				placeholder, '8em');
		}

		const prefBase = advanced('rulePrefBase', _('the router picks'));
		const catchPref = advanced('catchAllPref', _('the router picks'));
		const catchTable = advanced('catchAllTable', _('the router picks'));
		const warnUptime = advanced('wanWarnUptime', '5');
		const errorGrace = advanced('wanErrorGrace', '20');
		const releaseGrace = advanced('releaseGrace', '120');

		const status = E('div', { 'style': 'margin:.5em 0' });
		const buttons = E('div', { 'class': 'right' });

		/** The spec this form describes right now, or null with the reason shown. */
		function buildSpec() {
			const spec = {};

			spec.id = creating ? String(idInput.value).trim() : one.id;

			if (!spec.id.length) {
				dom.content(status, bmui.riskNote(_('Name the instance. The section name is what every other surface calls it by.')));
				return null;
			}

			// Sent only when it carries something. `configured` does not report
			// a label, so this form cannot prefill one on an edit - and a key
			// that is present and empty says "this instance has no label any
			// more", which is not what an untouched box means.
			const label = String(nameInput.value).trim();
			if (label.length)
				spec.name = label;

			spec.lan = String(lan.input.value).trim();
			spec.carrier = String(carrier.input.value).trim();
			spec.sticky = sticky.checked;
			spec.remap = remap.checked;
			spec.raise_dhcp_limits = raiseDhcp.checked;

			const limit = bmui.whole(perWan, 0, 4096);
			if (limit === null) {
				dom.content(status, bmui.riskNote(_('Clients per WAN is a whole number: 1 for one client per WAN, a larger number for how many may share one, 0 for no limit.')));
				return null;
			}
			spec.clients_per_wan = limit;

			// Sent whether or not they carry anything, because an empty one is
			// the only way to say "the whole LAN again" - absent would mean
			// "keep the range this instance already has".
			spec.range_from = String(rangeFrom.value).trim();
			spec.range_to = String(rangeTo.value).trim();

			if (creating)
				spec.enabled = true;

			const numbers =
				optionalNumber(prefBase, spec, 'rule_pref_base', 1, 2147483647) &&
				optionalNumber(catchPref, spec, 'catch_all_pref', 1, 2147483647) &&
				optionalNumber(catchTable, spec, 'catch_all_table', 1, 65535) &&
				optionalNumber(warnUptime, spec, 'wan_warn_uptime', 0, 86400) &&
				optionalNumber(errorGrace, spec, 'wan_error_grace', 0, 86400) &&
				optionalNumber(releaseGrace, spec, 'release_grace', 0, 86400);

			if (!numbers) {
				dom.content(status, bmui.riskNote(_('Every number under Advanced is either empty, which lets the router pick, or a whole number in range: priorities 1 to 2147483647, tables 1 to 65535, timers 0 to 86400 seconds.')));
				return null;
			}

			return spec;
		}

		function submit() {
			const spec = buildSpec();
			if (!spec)
				return Promise.resolve();

			dom.content(status, E('p', { 'class': 'spinning' }, _('Asking the router to check it...')));

			return api.ask(api.calls.wanbindInstanceCheck, spec).then(function(result) {
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
				const allocated = data.allocated ?? {};

				// A list, and an empty list is truthy - which is how this note
				// came to appear on every check, including the ones that move
				// nothing. Its length is the question, and the fields in it are
				// the answer: a warning that says only "this will disturb the
				// rules already on the router" has told somebody to be nervous
				// without telling them what about.
				const moves = Array.isArray(data.moves) ? data.moves : [];

				dom.content(status, [
					bmui.findingsList(data.findings),
					(allocated.rule_pref_base | 0)
						? E('p', { 'class': 'bm-small bm-muted' },
							_('The router would stamp this instance with client priority %d, catch-all priority %d and catch-all table %d.').format(
								allocated.rule_pref_base | 0, allocated.catch_all_pref | 0, allocated.catch_all_table | 0))
						: '',
					moves.length
						? bmui.riskNote(E('div', {}, [
							E('p', {}, _('This change moves what the rules already on the router were written against, so the router takes those rules off before it writes and puts them back on the pass after. Bound clients lose their route for a few seconds. What moves:')),
							E('ul', { 'style': 'margin:.3em 0 0 1.2em' }, moves.map(one => E('li', {}, [
								E('strong', {}, one.field ?? '?'),
								' ',
								_('%s becomes %s').format(moveValue(one.from), moveValue(one.to))
							])))
						]))
						: '',
					passed
						? E('div', { 'class': 'right' }, [
							E('button', {
								'class': 'btn cbi-button-%s'.format(creating ? 'add' : 'apply'),
								'click': ui.createHandlerFn(self, function() {
									return api.run(api.calls.wanbindInstanceSet, spec, creating
										? _('Instance %s created. The router has prepared it and run a pass.').format(spec.id)
										: _('Instance %s saved.').format(spec.id))
										.then(function(done) {
											if (done) ui.hideModal();
											return refresh();
										});
								})
							}, creating ? _('Create it') : _('Save'))
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

		ui.showModal(creating ? _('Add an instance') : _('Edit instance %s').format(one.id), [
			E('p', {}, _('One instance is one LAN and one pool of WANs on one carrier device. Two instances may share a LAN when their address ranges do not overlap; a router with one pool has one of these.')),

			bmui.field(_('Name'), idInput, creating
				? _('Letters, digits and underscores, up to 32. This is the section name, and what every other surface calls this instance by.')
				: _('The section name. It cannot be changed.')),
			bmui.field(_('Label'), nameInput, _('Only for people; shown wherever the instance is.')),
			bmui.field(_('LAN interface'), lan.node, evidenceHint(lanCands)),
			bmui.field(_('Carrier device'), carrier.node, _('The device the WAN pool sits on. Every interface on it, or on a VLAN of it, is in the pool.')),
			bmui.field(_('Clients per WAN'), perWan, _('1 gives every client a WAN of its own. A larger number is how many may share one. 0 is no limit, which is how everybody leaves by the same line when only one is up.')),
			bmui.field(_('Address range from'), rangeFrom, _('Leave both ends empty to bind the whole LAN. A range lets a second instance take the rest of it.')),
			bmui.field(_('Address range to'), rangeTo, _('Both ends or neither, both inside the LAN\'s own subnet.')),
			bmui.field(_('Remember each client\'s WAN'), sticky, _('Give a client the same WAN back when it returns, if that WAN is free.')),
			bmui.field(_('Move a client off a failing WAN'), remap, _('Off means it waits for its own WAN to come back.')),

			bmui.groupHeading(_('Advanced')),
			E('p', { 'class': 'bm-small bm-muted' },
				_('Every number here may be left empty, and empty is the right answer unless something on this router already owns the numbers. The router allocates a range nothing else is using and stamps it on the section, where it stays for the life of the instance.')),
			bmui.field(_('Client rule priority'), prefBase, _('Client rules are written from here upwards. The distance to the catch-all is also the most clients this instance can seat.')),
			bmui.field(_('Catch-all priority'), catchPref, _('Where the fail-closed rule sits. Nothing outside this range is ever touched.')),
			bmui.field(_('Catch-all table'), catchTable, _('The routing table holding "unreachable default". A client with no WAN lands here and is blocked, rather than leaking out of whichever WAN the router would have picked.')),
			bmui.field(_('WAN settle time'), warnUptime, _('Seconds a WAN has to have been up before it is handed to a client. Freshly dialled PPPoE sessions come up before they carry traffic.')),
			bmui.field(_('Failure grace'), errorGrace, _('Seconds a WAN has to have been failing before a client is moved off it.')),
			bmui.field(_('Lease grace'), releaseGrace, _('Seconds a client keeps its WAN after its lease disappears. Covers a reboot, a cable pulled for a minute, and dnsmasq restarting.')),
			bmui.field(_('Raise dnsmasq lease limits'), raiseDhcp, _('Widen this LAN\'s DHCP pool and lease limit if they are smaller than the pool of WANs. Off leaves /etc/config/dhcp exactly as it is.')),

			status,
			buttons
		]);

		return Promise.resolve();
	},

	// --------------------------------------------------------------- bindings

	/**
	 * Every binding the router holds, whichever way it got there.
	 *
	 * One table and not two, because they are one thing: a hand-placed binding
	 * and one grown from a lease are the same rule at different priorities, and
	 * a page that split them would hide the single most useful fact on it -
	 * that the hand-placed one wins, and which client it is winning over.
	 */
	paintBindings(node, refresh) {
		const rows = (state.bindings && Array.isArray(state.bindings.bindings))
			? state.bindings.bindings : [];
		const now = state.info ? api.routerNow(state.info) : 0;
		const editable = this.modern();
		const self = this;

		// A call that failed and a router with nothing on it produce the same
		// empty table, and only one of them is a fact about the router. The
		// warning above says the call failed; the empty space in the middle of
		// the page has to say the same thing, because that is where somebody
		// looking for their binding is actually reading.
		const answered = !!state.bindings;

		// And a narrowed list is a third case, one this table asked for itself:
		// the buttons in its own toolbar are what narrows it. `filtered` is
		// the daemon saying an id or a source was asked for. The filter this
		// page is holding is checked beside it, because a daemon that does not
		// report the field must not be able to make this table state a fact
		// about the whole router out of a view that was asked a narrower
		// question - the wrong way round of that mistake is the safe one.
		const filtered = answered && (state.bindings.filtered === true || state.source.length > 0);

		// `counts` is the whole router even while the list is narrowed, which is
		// what lets the sentence below say what is being hidden rather than only
		// that something is - and what makes "this router holds none" a thing
		// this page knows under a filter rather than one it read off a list that
		// could never have contained a row.
		const counts = (state.bindings && state.bindings.counts) ? state.bindings.counts : null;

		function emptyText() {
			if (!answered)
				return _('The router did not answer with its bindings, so none are listed. This is not a router that holds none - what it holds is unknown from here until the call works.');

			// -1 is a daemon that reports no counts, which is not nought.
			const total = counts ? ((counts.manual | 0) + (counts.derived | 0)) : -1;

			if (!filtered || total === 0)
				return _('This router holds no binding. Add one below, or add an instance and let a lease grow them.');

			if (total > 0)
				return _('Nothing matched %s. This is not a router with no bindings: it holds %d in all, and "All" above lists every one.').format(
					sourceLabel(), total);

			return _('Nothing matched %s. This is not a router with no bindings, it is a list narrowed to one filter - "All" above widens it.').format(sourceLabel());
		}

		const table = new ui.Table([
			_('Binding'), _('Source'), _('Address'), _('Host'), _('WAN'), _('LAN'),
			_('State'), _('Rule'), _('Table'), _('Since'), _('Reason'), ''
		], {
			id: 'bm-bindings',
			captionClasses: [
				null, null, null, null, null, null, null, null, null, null, null,
				'cbi-section-actions'
			]
		}, E('em', {}, emptyText()));

		table.update(rows.map(row => [
			row.name && row.name.length && row.name !== row.id
				? '%s (%s)'.format(row.name, row.id)
				: row.id,
			sourceCell(row),
			addressText(row),
			(row.host && row.host.length) ? row.host : '-',
			row.wan,
			(row.lan && row.lan.length) ? row.lan : '-',
			stateDot(row),
			(row.pref | 0) ? '%d'.format(row.pref | 0) : '-',
			(row.table | 0) ? '%d'.format(row.table | 0) : '-',
			api.ago(row.since, now),
			row.reason ?? '',
			self.bindingActions(row, editable, refresh)
		]));

		// The instances the reply names, or failing that the ones in the file:
		// the filter is about which rows to ask for, and a router whose reply
		// does not carry the list still has one.
		const named = (state.bindings && Array.isArray(state.bindings.instances))
			? state.bindings.instances
			: ((state.info && state.info.configured) ?? []);

		const filters = [
			['', _('All')],
			['manual', _('By hand')]
		].concat(named.map(one => [one.id, one.id]));

		const toolbar = filters.map(entry => E('button', {
			'class': state.source === entry[0] ? 'btn cbi-button-apply' : 'btn cbi-button-neutral',
			'click': ui.createHandlerFn(self, function() {
				state.source = entry[0];
				return refresh();
			})
		}, entry[1]));

		if (editable) {
			toolbar.push(E('button', {
				'class': 'btn cbi-button-add',
				'click': ui.createHandlerFn(self, function() {
					return self.openBindingEditor(null, refresh);
				})
			}, _('Add a binding')));
		}

		const band = (state.bindings && state.bindings.band) ? state.bindings.band : null;
		const maintained = state.bindings ? state.bindings.maintained : null;

		dom.content(node, bmui.section(_('Bindings'),
			_('A binding is one address, or one device, and the WAN it leaves by. The ones placed by hand are written into the router\'s own configuration and outlive the daemon, the app and the reboot; the ones an instance grew live as long as the lease behind them.'),
			E('div', {}, [
				state.bindingsError
					? E('p', { 'class': 'alert-message warning' }, state.bindingsError)
					: '',
				(band && band.usable === false)
					? bmui.riskNote(_('Hand-placed bindings have nowhere to sit: %s').format(band.reason ?? _('the priority band is not usable')))
					: '',
				(maintained === false)
					? bmui.riskNote(_('Nothing is keeping these in force. The rows below are intentions, not the state of the router.'))
					: '',
				bmui.tableWrap(table.render()),
				bmui.toolbar(toolbar)
			])));
	},

	/**
	 * What can be done to a row, which depends on who made it.
	 *
	 * A hand-placed binding is a section, so it is edited and deleted. One an
	 * instance grew is a decision, so it is moved, pinned or held - deleting it
	 * would mean deleting the lease, and the next pass would put it straight
	 * back.
	 */
	bindingActions(row, editable, refresh) {
		const self = this;
		const manual = (row.source === 'manual' || !row.source || !row.source.length);

		if (!editable)
			return '';

		if (manual) {
			return E('div', {}, [
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(self, function() {
						return self.openBindingEditor(row, refresh);
					})
				}, _('Edit')),
				' ',
				E('button', {
					'class': row.enabled === false ? 'btn cbi-button-apply' : 'btn cbi-button-reset',
					'click': ui.createHandlerFn(self, function() {
						return self.toggleBinding(row, refresh);
					})
				}, row.enabled === false ? _('Enable') : _('Disable')),
				' ',
				E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(self, function() {
						return self.confirmUnbind(row, refresh);
					})
				}, _('Delete'))
			]);
		}

		const instance = instanceOf(row);

		if (!instance.length || !row.mac || !row.mac.length)
			return '';

		return E('div', {}, [
			E('button', {
				'class': 'btn cbi-button-action',
				'click': ui.createHandlerFn(self, function() {
					return api.run(api.calls.wanbindReassign, { instance: instance, mac: row.mac },
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
					return api.run(api.calls.wanbindUnassign, { instance: instance, mac: row.mac },
						_('%s is held out of the pool.').format(row.mac)).then(refresh);
				})
			}, _('Hold'))
		]);
	},

	/**
	 * On and off is `bind` with one key changed, because there is one method
	 * for writing a binding and an edit that says only "switched off" must not
	 * also be read as saying it has no name and no LAN. The address and the WAN
	 * travel with it: `bind` needs a target and a WAN on every call.
	 */
	toggleBinding(row, refresh) {
		const spec = { id: row.id, wan: row.wan, enabled: row.enabled === false };

		if (row.targetKind === 'mac')
			spec.mac = row.mac ?? row.label;
		else
			spec.ip = row.ip ?? row.label;

		return api.run(api.calls.wanbindBind, spec, spec.enabled
			? _('Binding %s is in force.').format(row.id)
			: _('Binding %s is switched off and its rule is off the router.').format(row.id)).then(refresh);
	},

	confirmUnbind(row, refresh) {
		bmui.confirmTyped({
			title: _('Delete binding %s').format(row.id),
			body: [
				E('p', {}, _('%s goes back to being routed the way the rest of the router routes it, and the section is removed.').format(addressText(row))),
				E('p', {}, _('The router takes its rule off first. After the section is gone nothing knows the rule was its.'))
			],
			expected: row.id,
			actionLabel: _('Delete it'),
			run: function() {
				return api.run(api.calls.wanbindUnbind, { id: row.id },
					_('Binding %s is gone.').format(row.id)).then(refresh);
			}
		});

		return Promise.resolve();
	},

	/**
	 * Add a binding, or edit one. Same two steps as an instance: `bind_check`
	 * writes nothing and says what it found, and only a check that passed puts
	 * a Save button on the screen.
	 */
	bindingEditor(row, refresh) {
		const self = this;
		const creating = !row;

		const idInput = bmui.textInput(creating ? '' : row.id, 'laptop', '10em', !creating);
		const nameInput = bmui.textInput(
			(!creating && row.name && row.name !== row.id) ? row.name : '', _('optional'), '14em');

		const kindSelect = bmui.selectInput(TARGET_KINDS,
			(!creating && row.targetKind === 'mac') ? 'mac' : 'ip');
		const addressInput = bmui.textInput(
			creating ? '' : (row.targetKind === 'mac' ? (row.mac ?? row.label) : (row.ip ?? row.label)),
			'192.168.1.50', '14em');

		const wanPick = wanSelect(creating ? '' : (row.wan ?? ''));

		const lanCands = lanCandidates();
		const lan = pickerField(creating ? '' : (row.lan ?? ''), _('the router works it out'), '12em',
			lanCands.map(entry => [entry.name, entry.name]),
			_('Interfaces this router reads as a LAN'));

		const whenDown = bmui.selectInput(WHEN_DOWN,
			(!creating && row.whenDown === 'fallback') ? 'fallback' : 'hold');
		const enabled = bmui.checkbox(creating ? true : row.enabled !== false);

		const status = E('div', { 'style': 'margin:.5em 0' });
		const buttons = E('div', { 'class': 'right' });

		function syncKind() {
			addressInput.placeholder = (kindSelect.value === 'mac')
				? 'aa:bb:cc:dd:ee:ff'
				: '192.168.1.50';
		}

		kindSelect.addEventListener('change', syncKind);
		syncKind();

		function buildSpec() {
			const spec = {};

			spec.id = creating ? String(idInput.value).trim() : row.id;

			if (!spec.id.length) {
				dom.content(status, bmui.riskNote(_('Name the binding. The section name is its identity here, in the app and in every log line about it.')));
				return null;
			}

			const address = String(addressInput.value).trim();
			if (!address.length) {
				dom.content(status, bmui.riskNote(_('Give it an address or a MAC. There is nothing for this binding to follow otherwise.')));
				return null;
			}

			if (kindSelect.value === 'mac')
				spec.mac = address;
			else
				spec.ip = address;

			spec.wan = String(wanPick.value ?? '').trim();
			if (!spec.wan.length) {
				dom.content(status, bmui.riskNote(_('Name the WAN this binding leaves through.')));
				return null;
			}

			spec.name = String(nameInput.value).trim();
			spec.lan = String(lan.input.value).trim();
			spec.when_down = whenDown.value;
			spec.enabled = enabled.checked;

			return spec;
		}

		function submit() {
			const spec = buildSpec();
			if (!spec)
				return Promise.resolve();

			dom.content(status, E('p', { 'class': 'spinning' }, _('Asking the router to check it...')));

			return api.ask(api.calls.wanbindBindCheck, spec).then(function(result) {
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
									return api.run(api.calls.wanbindBind, spec, creating
										? _('Binding %s written. The router has put its rule in.').format(spec.id)
										: _('Binding %s saved.').format(spec.id))
										.then(function(done) {
											if (done) ui.hideModal();
											return refresh();
										});
								})
							}, creating ? _('Add it') : _('Save'))
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

		ui.showModal(creating ? _('Add a binding') : _('Edit binding %s').format(row.id), [
			E('p', {}, _('One address, one WAN, written into the router\'s own configuration. The priority and the routing table are the router\'s to pick and to keep.')),

			bmui.field(_('Name'), idInput, creating
				? _('Letters, digits and underscores, up to 32. This is the section name.')
				: _('The section name. It cannot be changed.')),
			bmui.field(_('Label'), nameInput, _('Only for people; shown wherever the binding is.')),
			bmui.field(_('Follow'), kindSelect, _('An address binds whatever holds it. A device binds one MAC and follows it to whichever address its lease gives it.')),
			bmui.field(_('Address'), addressInput, _('The IPv4 address, or the MAC, this binding is about.')),
			bmui.field(_('WAN'), wanPick, _('Where this address leaves by. An interface this router reads as a LAN cannot be chosen, and says what made it think so.')),
			bmui.field(_('LAN'), lan.node, _('Which side of the router this address is on. Empty lets the router work it out from its own subnets.')),
			bmui.field(_('While its WAN is down'), whenDown, _('Hold is fail-closed: nothing leaves rather than leaving by a line this binding exists to avoid.')),
			bmui.field(_('In force'), enabled, _('Off keeps the section and takes its rule off the router.')),

			status,
			buttons
		]);

		return Promise.resolve();
	},

	/**
	 * Which WAN to pin to, chosen from the pool this client's instance hands
	 * out rather than typed. A name that is not in that pool is not a mistake
	 * the daemon should have to explain twice.
	 */
	askPin(row, refresh) {
		const self = this;
		const instance = instanceOf(row);

		return this.readRouter().then(function() {
			const pool = state.wans.filter(one => one.instance === instance);
			const options = (pool.length ? pool : state.wans.filter(one => one.role !== 'lan'))
				.map(one => [one.name, wanOptionLabel(one)]);

			const picker = options.length
				? bmui.selectInput(options, row.wan)
				: bmui.textInput('', row.wan, '14em');

			ui.showModal(_('Pin %s').format(row.mac), [
				E('p', {}, _('Name the WAN to keep this client on. It is on %s now.').format(row.wan)),
				E('p', {}, _('Whoever is on that WAN loses it and goes back in the queue, newest holder first.')),
				picker,
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button-apply',
						'click': ui.createHandlerFn(self, function() {
							const wan = String(picker.value ?? '').trim();

							if (!wan.length) {
								ui.addNotification(null, E('p', {}, _('Name a WAN first.')), 'warning');
								return Promise.resolve();
							}

							ui.hideModal();
							return api.run(api.calls.wanbindPin,
								{ instance: instance, mac: row.mac, wan: wan },
								_('%s is pinned to %s.').format(row.mac, wan)).then(refresh);
						})
					}, _('Pin it'))
				])
			]);

			return null;
		});
	},

	// ---------------------------------------------------------------- waiting

	paintWaiting(node, refresh) {
		// The same three cases the bindings table above tells apart, because
		// an empty queue is the reassuring end of this page and the one place a
		// wrong sentence costs the most: "nobody is waiting" read off a call
		// that failed, or off a list narrowed to one instance while another has
		// a queue, sends somebody away from the fault they came here to find.
		//
		// This list carries no `filtered` of its own, and needs none: the
		// narrowing is this page's, `instance` is what it sent, and the only
		// honest thing to say about the instances it did not ask about is that
		// it did not ask.
		const answered = !!state.waiting && Array.isArray(state.waiting.waiting);
		const rows = answered ? state.waiting.waiting : [];
		const only = instanceFilter();
		const now = state.info ? api.routerNow(state.info) : 0;
		const self = this;

		function emptyText() {
			if (!answered)
				return _('The router did not answer with its queue, so nothing is listed. This is not a router where nobody is waiting - who is waiting is unknown from here until the call works.');

			if (only.length) {
				// What the narrowed list cannot show, `info` was asked for on
				// the same tick and has: every instance's queue depth. So the
				// sentence names the number rather than warning vaguely that
				// there might be one. -1 is a router that answered none.
				//
				// The named instance's own count is left out rather than
				// subtracted at the end: the two calls are answered a moment
				// apart, so a client that joined this instance's queue between
				// them would otherwise be reported as waiting somewhere else.
				let across = state.info ? 0 : -1;

				for (const one of (state.info && state.info.instances) ? state.info.instances : [])
					if (one.id !== only)
						across += one.waiting | 0;

				if (across > 0)
					return _('Nobody is waiting in instance %s, but %d client(s) are waiting elsewhere on this router. "All" above the bindings table widens both lists.').format(only, across);

				if (across === 0)
					return _('Nobody is waiting in instance %s, and no other instance has a queue either.').format(only);

				return _('Nobody is waiting in instance %s. This list is narrowed to it and says nothing about the others, which may have queues of their own: "All" above the bindings table widens both lists.').format(only);
			}

			// A router with nothing handing out WANs has an empty queue for a
			// reason that is not "everybody has one", and the difference is the
			// whole state of the feature: nothing is being bound at all.
			if (state.info && !(state.info.instances ?? []).length)
				return _('No instance is handing out WANs on this router, so nothing is queueing for one. Clients are routed the way the rest of the router routes them.');

			return _('Nobody is waiting: every client the router has seen has a WAN.');
		}

		const table = new ui.Table([
			_('Client'), _('IP'), _('Hostname'), _('Place'), _('Since'), _('Why'), ''
		], {
			id: 'bm-waiting',
			captionClasses: [null, null, null, null, null, null, 'cbi-section-actions']
		}, E('em', {}, emptyText()));

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

		dom.content(node, bmui.section(_('Waiting'),
			_('Clients with no WAN, in the order they asked. A client the pool cannot seat is blocked rather than quietly sent out of whichever WAN the router would have used.'),
			E('div', {}, [
				state.waitingError
					? E('p', { 'class': 'alert-message warning' }, state.waitingError)
					: '',
				bmui.tableWrap(table.render())
			])));
	},

	// ------------------------------------------------------------------ rules

	/**
	 * Every ip rule on this router, ours and everybody's, read straight off
	 * netlink.
	 *
	 * Read-only on purpose, and it is the answer to the question LuCI itself
	 * cannot answer: Network - Routing shows `config route` and `config rule`
	 * out of UCI, which is not where any of these live. A rule marked "not
	 * ours" beside one of ours at a nearby priority is the whole diagnosis of
	 * the bug this release exists to fix, on one screen.
	 */
	paintRules(node, refreshRules) {
		if (!state.info) {
			dom.content(node, null);
			return;
		}

		// A daemon older than 2.4.0 cannot read its rule table out to a page,
		// but it has always been able to run a pass and to take its rules off.
		// Those two are what somebody with a router in a bad state came here
		// for, so they stay whatever version is answering.
		if (!this.modern()) {
			dom.content(node, bmui.section(_('Rules on this router'),
				_('This bm-wanbind cannot read its own rule table out to a page; that arrived with 2.4.0. "ip -4 rule show" at a console is the same list without the owners.'),
				this.ruleToolbar(refreshRules, false)));
			return;
		}

		const data = state.rules ?? {};

		// `read` false is the kernel refusing the dump, and it is not a router
		// with no rules on it. The two arrive here in exactly the same shape -
		// an empty list - so a page that drew the table anyway would say the
		// single most misleading thing it is capable of saying, in a table that
		// looks as authoritative as any other. It says what it knows instead,
		// and keeps the buttons: a pass and a flush are what somebody with a
		// router in this state came here to press.
		if (data.read === false) {
			dom.content(node, bmui.section(_('Rules on this router'), RULES_DESCR,
				E('div', {}, [
					bmui.riskNote(_('The router could not read its ip rules, so nothing is listed here. This is not a router with no rules on it - what is standing in the kernel is unknown from this page until the read works, and nothing should be concluded from the empty space.')),
					E('p', { 'class': 'bm-small bm-muted' },
						_('The netlink dump failed inside the daemon. "ip -4 rule show" at a console reads the same table without going through it, and "logread -e bm-wanbind" says why this one did not.')),
					this.ruleToolbar(refreshRules, true)
				])));
			return;
		}

		const rows = Array.isArray(data.rules) ? data.rules : [];

		/**
		 * A button that fetches this rule's sentence and replaces itself with it.
		 *
		 * The sentence is kept in `state.reasons` rather than only in the cell,
		 * because the rules poll rebuilds this whole table every ten seconds -
		 * so an answer somebody waited for was replaced by the link again
		 * before they had finished reading it.
		 */
		function explainCell(row) {
			const cell = E('span', { 'class': 'bm-small' });
			const key = '%d|%s|%s|%d'.format(row.pref | 0, row.cidr || '', row.dst || '', row.table | 0);

			if (state.reasons && state.reasons[key]) {
				dom.content(cell, state.reasons[key]);
				return cell;
			}

			dom.content(cell, E('a', {
				'href': '#',
				'click': ui.createHandlerFn(this, function(ev) {
					ev.preventDefault();
					dom.content(cell, E('em', { 'class': 'spinning' }, _('Asking...')));

					return api.ask(api.calls.wanbindRuleExplain, {
						pref: row.pref | 0,
						cidr: row.cidr || '',
						dst: row.dst || '',
						table: row.table | 0
					}).then(function(result) {
						if (!result.ok) {
							dom.content(cell, E('span', { 'class': 'bm-muted' }, result.error));
							return null;
						}

						const answer = result.data || {};

						if (answer.found === false) {
							dom.content(cell, E('span', { 'class': 'bm-muted' },
								_('The router no longer has this rule. Something has removed it since this table was read.')));
							return null;
						}

						const said = String((answer.rule || {}).reason || '');

						if (!state.reasons)
							state.reasons = {};

						state.reasons[key] = said;
						dom.content(cell, said);
						return null;
					});
				})
			}, _('Explain')));

			return cell;
		}

		const table = new ui.Table([
			_('Priority'), _('Matches'), _('Table'), _('Owner'), _('Binding'), _('Why')
		], { id: 'bm-rules' },
			// Two different empty tables, because they are two different
			// routers: one has not answered yet, and the other answered with a
			// rule table that does not even hold the kernel's own three.
			E('em', {}, state.rules
				? _('The router answered, and there is not one ip rule on it - not even the three the kernel writes for itself, which is worth a look at a console.')
				: _('The router has not answered with its rule table yet.')));

		table.update(rows.map(row => {
			const owner = OWNERS[row.owner] ?? ['idle', row.owner ?? ''];

			return [
				'%d'.format(row.pref | 0),
				ruleMatch(row),
				ruleTableCell(row),
				bmui.pill(owner[0], owner[1]),
				row.id && row.id.length
					? (row.instance && row.instance.length
						? '%s (%s)'.format(row.id, row.instance)
						: row.id)
					: '-',
				// The sentence the router wrote about this rule, which is the
				// whole point of asking it rather than reading `ip rule show`:
				// anybody can list the rules, and what somebody standing in
				// front of a router needs is why this address is not on the
				// default connection.
				//
				// Asked for the one row somebody opens, rather than carried on
				// every row: at fifteen hundred rules the prose is most of a
				// megabyte, which is what a ubus reply has in total.
				explainCell(row)
			];
		}));

		const tables = Array.isArray(data.tables) ? data.tables : [];

		const tableList = new ui.Table([
			_('Table'), _('WAN'), _('Role'), _('Default route')
		], { id: 'bm-rule-tables' },
			// The same two routers the rule table above distinguishes, for the
			// same reason. The daemon describes the main table whether or not
			// any listed rule names it, so an answer with no table in it at all
			// is a finding rather than an ordinary empty list.
			E('em', {}, state.rules
				? _('The router answered and named no routing table at all, not even its own main one, which is worth a look at a console.')
				: _('The router has not answered with its routing tables yet.')));

		tableList.update(tables.map(one => [
			'%d'.format(one.table | 0),
			(one.wan && one.wan.length) ? one.wan : '-',
			roleText(one.role),
			tableDefault(one)
		]));

		// Null and never-asked are the same absent key, and only one of them is
		// a fact about this router: `state.rules` is what says the daemon
		// answered at all. Past the `read` gate above, an answer with no main
		// route is the router having none.
		const answered = !!state.rules;
		const main = data.main;

		dom.content(node, bmui.section(_('Rules on this router'), RULES_DESCR,
			E('div', {}, [
				state.rulesError
					? E('p', { 'class': 'alert-message warning' }, state.rulesError)
					: '',
				// Null here is not "not checked": the dump succeeded, and the
				// main table has no default route in it. That is the whole
				// answer to a binding that holds, or a client that reaches
				// nothing, while every rule and table on this page looks right -
				// everything this package hands back to the router's own routing
				// arrives at a table with no way out. Drawing nothing left the
				// one router that most needs a sentence with the blankest page.
				main
					? E('p', { 'class': 'bm-small bm-muted' },
						_('The router\'s own default route leaves by %s%s.').format(
							main.device || '?',
							main.gateway ? ' ' + _('via %s').format(main.gateway) : ''))
					: (answered
						? E('p', { 'class': 'bm-small' }, bmui.dot('busy',
							_('The router\'s main table has no default route. Every address this package does not claim - and every one it hands back when a WAN goes down - is looked up there and finds nothing.')))
						: ''),
				// `count` is the true total and the list is the first `limit`
				// of it, lowest priority first - which is the half worth
				// having, because it is the half the kernel reads first.
				data.capped
					? bmui.riskNote(_('This router has %d ip rules and the list below is the first %d of them, in the order the kernel walks them. Ask for the rest with "bmwan rules --limit" at a console.').format(data.count | 0, data.limit | 0))
					: '',
				bmui.tableWrap(table.render()),
				bmui.groupHeading(_('Routing tables')),
				bmui.tableWrap(tableList.render()),
				this.ruleToolbar(refreshRules, true)
			])));
	},

	/** Run a pass, check the kernel agrees, take everything off. */
	ruleToolbar(refreshRules, modern) {
		const self = this;

		function after() {
			return Promise.all([self.refresh(), refreshRules()]);
		}

		const buttons = [
			E('button', {
				'class': 'btn cbi-button-neutral',
				'click': ui.createHandlerFn(self, function() {
					// `wait` because a person pressed this and is watching the
					// page. Without it the daemon folds the request into the
					// pass already due and answers "in a moment", which is what
					// the hotplug hooks want and not what a button does.
					return api.run(api.calls.wanbindReconcile, { ...instanceArgs(), wait: true },
						_('The router has run a full pass.')).then(after);
				})
			}, _('Run a pass now'))
		];

		if (modern) {
			buttons.push(E('button', {
				'class': 'btn cbi-button-neutral',
				'click': ui.createHandlerFn(self, function() {
					return self.verifyNow();
				})
			}, _('Verify')));
		}

		buttons.push(E('button', {
			'class': 'btn cbi-button-remove',
			'click': ui.createHandlerFn(self, function() {
				if (!confirm(_('Remove every ip rule this package wrote? Every bound client loses its route until the next pass puts it back, and the fail-closed catch-all goes too.')))
					return Promise.resolve();

				return api.run(api.calls.wanbindFlush, instanceArgs(),
					_('The rules are off the router.')).then(after);
			})
		}, _('Remove every rule')));

		return bmui.toolbar(buttons);
	},

	/**
	 * Ask the router to compare what it believes it wrote against what the
	 * kernel actually holds, and say either way.
	 *
	 * Not `api.run`, because a verify that finds something missing is not a
	 * refusal and must not be reported as one: the call worked perfectly and
	 * the answer is bad news about the router.
	 *
	 * Three answers, not two, and the third is the one this button existed
	 * without for a release: `read: false` is the kernel refusing the dump, and
	 * it arrives in exactly the shape of a router in perfect order - the
	 * transport fine, both lists empty. Checked before either list is looked at,
	 * because "every rule is in the kernel" said about a comparison that never
	 * ran is the most misleading sentence on this page, and it is the same lie
	 * the rule table next door already refuses to tell.
	 */
	verifyNow() {
		return api.ask(api.calls.wanbindVerify, instanceArgs()).then(result => {
			if (!result.ok) {
				ui.addNotification(null, E('p', {}, result.error), 'error');
				return null;
			}

			const data = result.data ?? {};

			if (data.read === false) {
				ui.addNotification(null, E('div', {}, [
					E('p', {}, _('Nothing was compared: %s').format(
						data.reason ?? _('the router could not read its ip rules'))),
					E('p', {}, _('This is not a router whose rules are all in place. What the kernel is holding is unknown until the read works, and nothing should be concluded from the two empty lists. "logread -e bm-wanbind" says why it did not.'))
				]), 'warning');
				return null;
			}

			const missing = Array.isArray(data.missing) ? data.missing : [];
			const extra = Array.isArray(data.extra) ? data.extra : [];

			if (!missing.length && !extra.length) {
				ui.addNotification(null, E('p', {},
					_('All %d rule(s) the router meant to write are in the kernel, and it holds nothing extra in these priorities.').format(data.checked | 0)), 'info');
				return null;
			}

			ui.addNotification(null, E('div', {}, [
				E('p', {}, _('%d rule(s) the router wrote are not in the kernel, and %d it did not write are.').format(missing.length, extra.length)),
				missing.length
					? E('p', {}, _('Missing: %s').format(missing.map(one => '%d'.format(one.pref | 0)).join(', ')))
					: '',
				extra.length
					? E('p', {}, _('Unexpected: %s').format(extra.map(one => '%d'.format(one.pref | 0)).join(', ')))
					: '',
				E('p', {}, _('Something else on this router is writing into these priorities. A Bored Manager module older than 3.4.0 does exactly that, every two seconds, while the app is connected.'))
			]), 'warning');

			return null;
		});
	},

	// --------------------------------------------------------------- settings

	/** The daemon's own numbers, and the defaults every new instance is cut from. */
	paintSettings(node, refreshSettings) {
		if (!this.modern()) {
			dom.content(node, null);
			return;
		}

		if (state.settingsError) {
			dom.content(node, bmui.section(_('Daemon settings'), null,
				E('p', { 'class': 'alert-message warning' }, state.settingsError)));
			return;
		}

		const settings = state.settings ?? {};
		// The band is the daemon's, and it travels on `settings_get` beside the
		// numbers - reading it off `state.bindings` was reading a key that reply
		// does not carry, so the sentence under this form printed two zeroes.
		const band = settings.band ?? (state.bindings ?? {}).band ?? {};
		const self = this;

		const enabled = bmui.checkbox(settings.enabled !== false);
		const interval = bmui.textInput('%d'.format(settings.interval | 0), '30', '6em');

		const directBase = bmui.textInput('%d'.format(settings.direct_pref_base | 0), '19000', '8em');
		const ruleBase = bmui.textInput('%d'.format(settings.rule_pref_base | 0), '20000', '8em');
		const catchBase = bmui.textInput('%d'.format(settings.catch_all_pref_base | 0), '30000', '8em');
		const catchTable = bmui.textInput('%d'.format(settings.catch_all_table | 0), '253', '8em');
		const tableBase = bmui.textInput('%d'.format(settings.wan_table_base | 0), '10000', '8em');

		// On by default, and off is a real answer rather than an unset one - so
		// this is a checkbox and its base is a number sent beside it.
		const lanLocal = bmui.checkbox(settings.lan_local !== false);
		const localBase = bmui.textInput('%d'.format(settings.local_pref_base | 0), '18000', '8em');

		const warnUptime = bmui.textInput('%d'.format(settings.wan_warn_uptime | 0), '5', '6em');
		const errorGrace = bmui.textInput('%d'.format(settings.wan_error_grace | 0), '20', '6em');
		const releaseGrace = bmui.textInput('%d'.format(settings.release_grace | 0), '120', '6em');

		function save() {
			const values = {
				enabled: enabled.checked,
				interval: bmui.whole(interval, 1, 3600),
				direct_pref_base: bmui.whole(directBase, 1, 2147483647),
				rule_pref_base: bmui.whole(ruleBase, 1, 2147483647),
				catch_all_pref_base: bmui.whole(catchBase, 1, 2147483647),
				catch_all_table: bmui.whole(catchTable, 1, 65535),
				wan_table_base: bmui.whole(tableBase, 1, 65535),
				local_pref_base: bmui.whole(localBase, 1000, 27999),
				wan_warn_uptime: bmui.whole(warnUptime, 0, 86400),
				wan_error_grace: bmui.whole(errorGrace, 0, 86400),
				release_grace: bmui.whole(releaseGrace, 0, 86400)
			};

			for (const key of Object.keys(values)) {
				if (values[key] === null) {
					ui.addNotification(null, E('p', {},
						_('The interval is 1-3600 seconds, priorities 1-2147483647, the LAN-local base 1000-27999, tables 1-65535 and the timers 0-86400 seconds.')), 'warning');
					return Promise.resolve();
				}
			}

			// The escape rules are read before every binding rule, so their band
			// has to end below where the bindings start. Refused here rather
			// than by the daemon so the person is still looking at the box.
			if (values.local_pref_base + 64 > values.direct_pref_base) {
				ui.addNotification(null, E('p', {},
					_('The LAN-local base %d opens a band 64 wide that reaches %d, which is not below the binding base %d. Every LAN escape has to be read before any binding rule, or a bound address stops reaching the printer beside it.').format(
						values.local_pref_base, values.local_pref_base + 63, values.direct_pref_base)), 'warning');
				return Promise.resolve();
			}

			values.lan_local = lanLocal.checked;

			if (!values.enabled && !confirm(_('Switching the instance half off takes every instance\'s rules away first. Hand-placed bindings stay in force. Go on?')))
				return Promise.resolve();

			return api.run(api.calls.wanbindSettingsSet, values, _('Daemon settings applied.'))
				.then(function() {
					return Promise.all([self.refresh(), refreshSettings()]);
				});
		}

		dom.content(node, bmui.section(_('Daemon settings'),
			_('The pass timer, and the numbers every instance written after this is cut from. An instance already on this router keeps the numbers stamped on its own section: changing these never moves a rule that exists.'),
			E('div', {}, [
				(band.usable === false)
					? bmui.riskNote(_('These priorities do not hold together: %s').format(band.reason ?? _('the router did not say why')))
					: E('p', { 'class': 'bm-small bm-muted' },
						_('Hand-placed bindings live in priorities %d to %d. Nothing outside the ranges below is ever read or written by this package.').format(band.base | 0, band.top | 0)),

				bmui.field(_('Hand out WANs to clients'), enabled, _('Off stops every instance and takes their rules off. Bindings placed by hand are not an instance and stay in force.')),
				bmui.field(_('Pass interval (s)'), interval, _('How often the router re-reads its leases and its rules. A lease arriving is acted on immediately whatever this says.')),

				bmui.field(_('Keep LAN traffic local'), lanLocal,
					_('On by default. One rule per LAN - "to <LAN subnet> lookup main" - read before every binding rule, so a bound device still reaches the devices beside it. Off, a binding sends every packet from that address out of its WAN, the ones for its own LAN included.')),

				bmui.groupHeading(_('Numbering')),
				bmui.field(_('Binding priority base'), directBase, _('Where hand-placed bindings are numbered from. They sit below every instance, so the kernel reads them first.')),
				bmui.field(_('Client priority base'), ruleBase, _('Where the first instance\'s client rules start.')),
				bmui.field(_('Catch-all priority base'), catchBase, _('Where the first instance\'s fail-closed rule sits.')),
				bmui.field(_('Catch-all table'), catchTable, _('The first instance\'s "unreachable default" table.')),
				bmui.field(_('WAN table base'), tableBase, _('Where routing tables are handed out from for WANs that have none.')),
				bmui.field(_('LAN-local priority base'), localBase,
					_('1000 to 27999, 18000 by default. The band is 64 wide and has to end below the binding priority base and below every instance\'s own.')),

				bmui.groupHeading(_('Timers')),
				bmui.field(_('WAN settle time'), warnUptime, _('Seconds a WAN has to have been up before it is handed to a client.')),
				bmui.field(_('Failure grace'), errorGrace, _('Seconds a WAN has to have been failing before a client is moved off it.')),
				bmui.field(_('Lease grace'), releaseGrace, _('Seconds a client keeps its WAN after its lease disappears.')),

				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn cbi-button-apply',
						'click': ui.createHandlerFn(self, save)
					}, _('Save'))
				])
			])));
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
