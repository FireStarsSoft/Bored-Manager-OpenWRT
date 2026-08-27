'use strict';
'require baseclass';
'require ui';

/*
 * The pieces every Bored Manager tab is built from, and nothing that talks to
 * the router. bm.api owns the calls; this owns how their answers look.
 *
 * It exists because the five tabs had grown five slightly different copies of
 * the same card, the same labelled form row and the same type-the-name delete
 * modal, each styled inline. One stylesheet (bm/ui.css, loaded here so no view
 * has to remember to) and one set of builders keeps them the same page - and
 * keeps colour a *second* carrier of meaning: every dot and pill repeats its
 * status as a word, so nothing on these pages is said by colour alone.
 */

(function() {
	const href = L.resource('bm/ui.css');
	if (!document.querySelector('link[href="%s"]'.format(href)))
		document.head.appendChild(E('link', { 'rel': 'stylesheet', 'href': href }));
})();

return baseclass.extend({
	/** A coloured dot and a word. Kinds: ok, busy, bad, idle. */
	dot(kind, label) {
		const known = { ok: 1, busy: 1, bad: 1, idle: 1 };

		return E('span', {}, [
			E('span', { 'class': 'bm-dot bm-dot--%s'.format(known[kind] ? kind : 'idle') }),
			label
		]);
	},

	/** A status pill. Kinds: ok, warn, bad, idle. */
	pill(kind, label) {
		const known = { ok: 1, warn: 1, bad: 1, idle: 1 };

		return E('span', {
			'class': 'bm-pill bm-pill--%s'.format(known[kind] ? kind : 'idle')
		}, label);
	},

	/** The responsive grid a row of cards sits in. */
	cards(children) {
		return E('div', { 'class': 'bm-cards' }, children);
	},

	/**
	 * One card. `spec`: { title, pill, sub, body, footer } - everything but
	 * the title optional. The pill sits opposite the title, which is where a
	 * state belongs: readable before any of the body is.
	 */
	card(spec) {
		return E('div', { 'class': 'bm-card' }, [
			E('div', { 'class': 'bm-card-head' }, [
				E('h4', { 'class': 'bm-card-title' }, spec.title),
				spec.pill ?? ''
			]),
			spec.sub ? E('p', { 'class': 'bm-card-sub' }, spec.sub) : '',
			E('div', { 'class': 'bm-card-body' }, spec.body ?? ''),
			spec.footer ? E('div', { 'class': 'bm-actions' }, spec.footer) : ''
		]);
	},

	/** The row of big numbers at the top of a page: [[label, value], ...]. */
	tiles(items) {
		return E('div', { 'class': 'bm-tiles' }, items.map(item =>
			E('div', { 'class': 'bm-tile' }, [
				E('div', { 'class': 'bm-tile-value' }, item[1]),
				E('div', { 'class': 'bm-tile-label' }, item[0])
			])));
	},

	/** Label/value rows, for the inside of a card. */
	kv(pairs) {
		return E('div', { 'class': 'bm-kv' }, pairs.map(pair =>
			E('div', {}, [E('span', {}, pair[0]), E('span', {}, pair[1])])));
	},

	/** A titled block with a one-line explanation under the heading. */
	section(title, description, children) {
		return E('div', { 'class': 'cbi-section bm-section' }, [
			title ? E('h3', {}, title) : '',
			description ? E('div', { 'class': 'cbi-section-descr' }, description) : '',
			children ?? ''
		]);
	},

	/**
	 * The block that goes where a table would have been. Never an empty box:
	 * a page that shows nothing and explains nothing is the one thing this
	 * whole project has been trying not to build.
	 */
	notice(title, text, children) {
		return E('div', { 'class': 'cbi-section bm-section' }, [
			E('h3', {}, title),
			E('p', {}, text),
			children ?? ''
		]);
	},

	/** A row of buttons above a table. */
	toolbar(children) {
		return E('div', { 'class': 'bm-toolbar' }, children);
	},

	/** A wide table, scrollable sideways on a narrow screen. */
	tableWrap(node) {
		return E('div', { 'class': 'bm-table-wrap' }, node);
	},

	/** An amber note inside a form or a modal. */
	riskNote(text) {
		return E('div', { 'class': 'alert-message warning', 'style': 'margin:.5em 0' }, text);
	},

	groupHeading(text) {
		return E('h4', { 'style': 'margin:1.2em 0 .4em' }, text);
	},

	/** One labelled row of a modal form, in LuCI's own shape. */
	field(label, node, hint) {
		return E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, label),
			E('div', { 'class': 'cbi-value-field' }, [
				node,
				hint ? E('div', { 'class': 'cbi-value-description' }, hint) : ''
			])
		]);
	},

	textInput(value, placeholder, width, disabled) {
		return E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'value': value ?? '',
			'placeholder': placeholder ?? '',
			'disabled': disabled ? '' : null,
			'style': 'width:%s'.format(width ?? '14em')
		});
	},

	passwordInput(placeholder) {
		return E('input', {
			'type': 'password',
			'class': 'cbi-input-password',
			'value': '',
			'placeholder': placeholder ?? '',
			'style': 'width:14em'
		});
	},

	checkbox(checked) {
		return E('input', { 'type': 'checkbox', 'class': 'cbi-input-checkbox', 'checked': checked ? '' : null });
	},

	selectInput(options, value) {
		return E('select', { 'class': 'cbi-input-select' }, options.map(entry =>
			E('option', { 'value': entry[0], 'selected': entry[0] === value ? '' : null }, entry[1])));
	},

	/**
	 * A whole number from a field, or null when it is not one. Bounds are
	 * optional; a field whose caller checks ranges itself passes none.
	 */
	whole(node, low, high) {
		const raw = String(node.value ?? '').trim();
		if (!/^[0-9]+$/.test(raw))
			return null;

		const value = Number(raw);
		if (low !== undefined && low !== null && value < low)
			return null;
		if (high !== undefined && high !== null && value > high)
			return null;

		return value;
	},

	/** A findings list, exactly as a daemon worded it. */
	findingsList(findings) {
		const known = { error: 1, warning: 1, info: 1, pass: 1 };

		return E('div', { 'class': 'bm-findings' },
			(findings ?? []).map(one => E('div', { 'class': 'bm-finding' }, [
				E('strong', {
					'class': 'bm-finding-level bm-finding-level--%s'.format(known[one.level] ? one.level : 'info')
				}, String(one.level ?? '').toUpperCase()),
				one.label ?? '',
				one.detail ? E('div', { 'class': 'bm-finding-detail' }, one.detail) : ''
			])));
	},

	/**
	 * The type-the-name delete modal, shared so every destructive flow asks
	 * the same way. `spec`: { title, body (array), expected, actionLabel,
	 * run(fn) } - `run` is called only after the typed name matches, and the
	 * modal is already closed by then.
	 */
	confirmTyped(spec) {
		const nameField = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:12em' });

		ui.showModal(spec.title, [
			E('div', {}, spec.body),
			E('p', {}, _('Type %s to confirm:').format(spec.expected)),
			nameField,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(null, function() {
						if (nameField.value !== spec.expected) {
							ui.addNotification(null, E('p', {},
								_('That does not match; nothing was done.')), 'warning');
							return Promise.resolve();
						}

						ui.hideModal();
						return spec.run();
					})
				}, spec.actionLabel)
			])
		]);
	}
});
