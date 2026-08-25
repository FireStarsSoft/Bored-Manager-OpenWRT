// Every call site that once reached a name declared below it.
//
// ucode does not hoist. It resolves an identifier when it *compiles* the
// function that mentions it, so a call to something declared further down the
// same file compiles cleanly and raises the first time the line runs:
//
//   Reference error: access to undeclared variable poolPut
//
// scripts/check-packages.mjs refuses that lexically, which is the gate. This is
// the proof: these are the paths that were actually broken, run against the
// pinned interpreter rather than reasoned about. One of them is `guard cancel`,
// the Undo on the commit-confirm countdown, where the cost of finding out the
// other way is a router that did not come back.

import * as engine from 'bm.wanbind.engine';
import * as guard from 'bm.guard';
import * as pppoe from 'bm.pppoe.service';
import * as snapshot from 'bm.snapshot';
import * as wan from 'bm.wanbind.service';

import { check, report, resolves } from 'probe';

// poolReset -> poolPut -> poolHas
resolves('wanbind engine.poolReset', () => {
	let st = { freeWans: [], freePos: {} };
	engine.poolReset(st, [ 'wan1', 'wan2', 'wan1' ]);

	if (length(st.freeWans) != 2)
		die('poolReset kept ' + length(st.freeWans) + ' of 2');
});

// readdress -> unbindAfterFailure, on the branch where no priority is free.
resolves('wanbind engine.readdress', () => {
	let st = {
		instance: { id: 'probe', rulePrefBase: 20000, catchAllPref: 20001 },
		devices: {
			'aa:bb:cc:dd:ee:ff': {
				mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.10',
				wan: 'wan1', pref: 20000, table: 101
			}
		},
		wanOwner: { wan1: 'aa:bb:cc:dd:ee:ff' },
		freeWans: [], freePos: {},
		waiting: {}, waitOrder: [], waitHead: 0, nextOrder: 1,
		held: {}, sticky: {}, assignedAt: {},
		prefFree: [], prefNext: 20001,
		tables: {}, dirty: false, lastReason: ''
	};

	engine.readdress(st, 'aa:bb:cc:dd:ee:ff', '192.168.1.11');
});

// cancel -> finish. Nothing is armed here, so it stops at that check; what this
// proves is that reaching the module and calling it does not raise.
resolves('agent guard.cancel', () => {
	let result = guard.cancel();

	if (result.ok !== false)
		die('expected a refusal with no guard armed');
});

// poolAdd -> accountRows -> createPool -> poolIdRefusal, cfg.refusal,
// overlapRefusal. pool-lifecycle.uc drives the same chain with a working uci;
// this one only has to reach every name on it.
resolves('pppoe poolAdd', () => {
	let out = pppoe.poolAdd({ id: 'probe', accounts: [] });

	if (out.ok !== false)
		die('expected a refusal with no accounts');
});

resolves('pppoe poolAppend', () => {
	let out = pppoe.poolAppend({ id: 'nosuch', accounts: [ { user: 'u', pass: 'p' } ] });

	if (out.ok !== false)
		die('expected a refusal for a pool that is not there');
});

// info -> cfg.configured, and flush past the state loop into cfg.instances.
resolves('wanbind info', () => {
	let out = wan.info();

	if (type(out.configured) != 'array')
		die('info carries no configured list');
});

resolves('wanbind flush', () => {
	wan.flush({ instance: 'probe' });
});

// bundle -> meta -> validId, then exported.
resolves('snapshot bundle', () => {
	if (snapshot.bundle('nosuch') !== null)
		die('a snapshot that is not there should be null');
});

// A path traversal in a snapshot id must not become a path.
check('a snapshot id cannot escape its directory', snapshot.meta('../state'), null);
check('nor with a leading dot', snapshot.meta('./baseline'), null);

report();
