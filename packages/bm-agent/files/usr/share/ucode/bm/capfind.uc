// What is wrong with this router, and what would fix it.
//
// Split from `bm.capacity` next door because the two are different kinds of
// thing and the split keeps them honest: that file does arithmetic and this one
// writes sentences. Nothing here reads a file or calls anything; it is handed
// what the router said and what the model made of it, and turns that into rows
// somebody can act on.
//
// Every row is `{ key, level, label, detail, fix, values }`.
//
// `fix` is the part that has to be got right. It names an existing verb and
// arguments that verb already declares - ubus refuses an argument a method has
// not declared, so a fix that invented one would be a button that fails - and
// it is offered only when its precondition is *true*, not when it is unknown.
// Switching flow offload on where the kernel has no flowtable, for one, leaves
// a router whose firewall fails to load at the next boot; so that fix appears
// only where the kernel is known to have it, and where it is not the row says
// what to install instead.

const FIX_KINDS = [
	'tune_set',
	'wanbind_reconcile',
	'wanbind_settings_set',
	'wanbind_instance_set',
	'pool_reconcile'
];

function text(value) {
	return type(value) == 'string' ? value : '';
}

function number(value) {
	return type(value) == 'int' ? value : 0;
}

function mb(kb) {
	return (type(kb) == 'int') ? (kb / 1024) : 0;
}

/**
 * One row.
 *
 * `fix` is checked against the closed list above rather than trusted, because a
 * kind nothing knows how to run would be a button on a page that does nothing
 * and says nothing.
 */
function finding(out, key, level, label, detail, fix, values) {
	let one = {
		key: key,
		level: level,
		label: label,
		detail: text(detail),
		fix: null,
		values: (type(values) == 'object') ? values : {}
	};

	if (type(fix) == 'object' && (fix.kind in FIX_KINDS))
		one.fix = { kind: fix.kind, args: (type(fix.args) == 'object') ? fix.args : {} };

	push(out, one);
	return one;
}

// ---------------------------------------------------------------------------
// The requirements: one row per key, `pass` when the router meets it.

function memoryFindings(ctx, out) {
	let needed = ctx.needed.memKb;
	let have = ctx.hardware.memTotalKb;

	if (type(needed) != 'int' || type(have) != 'int' || have <= 0) {
		finding(out, 'memory', 'info', 'Memory for this configuration',
			'This router did not say how much memory it has, so nothing here is sized against it.');
		return;
	}

	let values = { neededKb: needed, totalKb: have };

	if (needed > have) {
		finding(out, 'memory', 'error',
			sprintf('This configuration needs about %d MB and the router has %d MB', mb(needed), mb(have)),
			'It will not hold. Add memory, or cut the number of sessions and bindings until it does.',
			null, values);
		return;
	}

	if (needed * 5 > have * 4) {
		finding(out, 'memory', 'warning',
			sprintf('This configuration needs about %d MB of the %d MB this router has', mb(needed), mb(have)),
			'That leaves little for bursts - a redial storm, a conntrack table filling, a firewall reload.',
			null, values);
		return;
	}

	finding(out, 'memory', 'pass',
		sprintf('Memory: about %d MB needed, %d MB fitted', mb(needed), mb(have)), '', null, values);
}

function offloadFindings(ctx, out) {
	if (!ctx.needed.flowOffload) {
		finding(out, 'flow-offload', 'pass', 'fw4 flow offload is not needed at this size',
			sprintf('Below %d sessions the kernel walks the rule list quickly enough that it is not what caps this router.',
				ctx.K.FLOW_OFFLOAD_THRESHOLD), null, {});
		return;
	}

	if (ctx.software.flowOffload === true) {
		finding(out, 'flow-offload', 'pass', 'fw4 flow offload is on', '', null, {});
		return;
	}

	if (ctx.software.flowOffloadKernel === false) {
		finding(out, 'flow-offload', 'error',
			'This kernel cannot do flow offload, and this many sessions need it',
			'Every session installs three routing rules and the kernel walks the whole list for every packet without a flowtable. `apk add kmod-nft-offload` at a router shell adds one; it ships with every image that has firewall4, so this router was built without it. Turning the fw4 option on before then would leave a firewall that fails to load at the next boot.',
			null, {});
		return;
	}

	if (ctx.software.flowOffload === false && ctx.software.flowOffloadKernel === true) {
		finding(out, 'flow-offload', 'error', 'This many sessions need fw4 flow offload, and it is off',
			'Every session installs three routing rules, and the kernel walks the whole list for every packet - at this size that walk is what caps the router, and it looks like a slow line rather than a setting. Turn it on here, or run `bmctl tune flow_offload=1` at a shell.',
			{ kind: 'tune_set', args: { flow_offload: true } }, {});
		return;
	}

	finding(out, 'flow-offload', 'warning', 'Could not read whether fw4 flow offload is on',
		'It is the difference between a router that carries this many sessions and one that looks like a slow line. `bmctl tune` prints it.',
		null, {});
}

function conntrackFindings(ctx, out) {
	let have = ctx.software.conntrackMax;
	let want = ctx.needed.conntrackMax;

	if (type(have) != 'int' || type(want) != 'int') {
		finding(out, 'conntrack-max', 'info', 'Connection tracking table',
			'This router did not say how big its conntrack table is.', null, {});
		return;
	}

	if (have < want) {
		let fix = null;

		// Only when the table would still hold what is in it now: a smaller
		// table drops live connections the moment it is written.
		if (type(ctx.load.live.conntrackCount) != 'int' || want >= ctx.load.live.conntrackCount) {
			fix = {
				kind: 'tune_set',
				args: {
					conntrack_max: want,
					gc_thresh1: ctx.needed.gcThresh1,
					gc_thresh2: ctx.needed.gcThresh2,
					gc_thresh3: ctx.needed.gcThresh3
				}
			};
		}

		finding(out, 'conntrack-max', 'warning',
			sprintf('The conntrack table is %d and this router should be sized for %d', have, want),
			'Below that the kernel starts dropping packets it cannot track, which reads as a flaky line rather than as a full table.',
			fix, { have: have, want: want });
	}
	else {
		finding(out, 'conntrack-max', 'pass', sprintf('Connection tracking sized for %d', have), '', null, {});
	}

	let count = ctx.load.live.conntrackCount;

	if (type(count) == 'int' && have > 0) {
		let used = (count * 100) / have;

		if (used >= 90) {
			finding(out, 'conntrack-full', 'error',
				sprintf('The conntrack table is %d%% full - %d of %d', used, count, have),
				'Connections that do not fit are dropped.', null, { used: used });
		}
		else if (used >= 80) {
			finding(out, 'conntrack-full', 'warning',
				sprintf('The conntrack table is %d%% full - %d of %d', used, count, have),
				'', null, { used: used });
		}
	}
}

function neighbourFindings(ctx, out) {
	let have = ctx.software.gcThresh3;
	let want = ctx.needed.gcThresh3;

	if (type(have) != 'int' || type(want) != 'int' || have >= want)
		return;

	finding(out, 'neigh-thresh', 'warning',
		sprintf('The neighbour table stops at %d and this router should be sized for %d', have, want),
		'Over it the kernel refuses to learn new addresses, and a client that cannot be learned drops off the LAN.',
		{
			kind: 'tune_set',
			args: {
				conntrack_max: ctx.needed.conntrackMax,
				gc_thresh1: ctx.needed.gcThresh1,
				gc_thresh2: ctx.needed.gcThresh2,
				gc_thresh3: want
			}
		},
		{ have: have, want: want });
}

function leaseFindings(ctx, out) {
	let ceiling = ctx.software.leaseMax;
	let want = ctx.needed.leaseMax;

	if (type(ceiling) != 'int' || type(want) != 'int')
		return;

	// A requirement gets a row whether or not it is met: a page that only shows
	// what is broken cannot be read as "and the rest was checked".
	if (ceiling >= want) {
		finding(out, 'lease-max', 'pass',
			sprintf('DHCP leases: %d wanted, %d allowed', want, ceiling), '', null,
			{ have: ceiling, want: want });
		return;
	}

	// Raising it is one call, but only where there is an instance to make it -
	// the verb belongs to an instance and there is nothing to name otherwise.
	let fix = length(text(ctx.load.instanceId))
		? { kind: 'wanbind_instance_set', args: { id: ctx.load.instanceId, raise_dhcp_limits: true } }
		: null;

	finding(out, 'lease-max', 'error',
		sprintf('dnsmasq stops at %d leases and this LAN wants %d', ceiling, want),
		fix
			? 'A client with no lease is a client with no address, and a client with no address is one no rule can be written for. Raising it is one call.'
			: 'A client with no lease is a client with no address. Raise it with `uci set dhcp.@dnsmasq[0].dhcpleasemax=...` and the LAN\'s own `limit` at a router shell.',
		fix, { have: ceiling, want: want });
}

function bandFindings(ctx, out) {
	let span = ctx.K.DIRECT_PREF_SPAN;
	let taken = ctx.load.configured.prefsClaimed;

	if (type(taken) != 'int')
		return;

	if (taken >= span) {
		finding(out, 'band', 'error',
			sprintf('Every one of the %d one-to-one priorities is taken', span),
			'A new binding has no number to take. Remove bindings that are no longer wanted, or seat those clients through an instance instead.',
			null, { taken: taken, span: span });
	}
	else if (taken * 10 > span * 9) {
		finding(out, 'band', 'warning',
			sprintf('%d of %d one-to-one priorities are taken', taken, span),
			'', null, { taken: taken, span: span });
	}
}

function poolFindings(ctx, out) {
	for (let pool in ctx.load.configured.pools) {
		if (pool.members > ctx.K.MEMBER_MAX) {
			finding(out, 'pool-cap', 'error',
				sprintf('Pool %s has %d members and %d is the ceiling', pool.id, pool.members, ctx.K.MEMBER_MAX),
				'The rest go in a second pool with its own prefix and table base.', null, {});
			return;
		}

		if (pool.members == ctx.K.MEMBER_MAX) {
			finding(out, 'pool-cap', 'info',
				sprintf('Pool %s is full at %d members', pool.id, pool.members),
				'Nothing is wrong with it. The next member needs a second pool, with its own prefix and its own table base.',
				null, {});
			return;
		}
	}

	if (ctx.needed.pools > length(ctx.load.configured.pools)) {
		finding(out, 'pools-needed', 'warning',
			sprintf('%d members need %d pools of %d, and %d are configured',
				ctx.load.configured.members, ctx.needed.pools, ctx.K.MEMBER_MAX,
				length(ctx.load.configured.pools)),
			'', null, {});
	}
}

function replyFindings(ctx, out) {
	let ceiling = ctx.ceiling.dimensions.dump;

	if (type(ceiling) != 'int' || ceiling <= 0)
		return;

	let have = ctx.load.configured.members;

	if (have >= ceiling) {
		finding(out, 'dump-size', 'error',
			sprintf('At %d interfaces the router\'s own interface list passes what ubus can carry', have),
			'Every daemon here reads that list on every pass, and so does the firewall. Past this size they stop seeing interfaces rather than seeing them late.',
			null, { have: have, ceiling: ceiling });
	}
	else if (have * 5 > ceiling * 4) {
		finding(out, 'dump-size', 'warning',
			sprintf('%d interfaces, against about %d before the router\'s interface list stops fitting in a ubus message', have, ceiling),
			'', null, { have: have, ceiling: ceiling });
	}
}

function fw4Findings(ctx, out) {
	if (!ctx.software.fw4) {
		finding(out, 'fw4', 'error', 'Firewall4 is not installed',
			'Nothing forwards a LAN out of a WAN without it, so no binding and no pool can carry traffic.',
			null, {});
		return;
	}

	if (ctx.software.fw4Loaded === false) {
		finding(out, 'fw4', 'error', 'Firewall4 is installed and its ruleset is not loaded',
			'`fw4 reload` at a router shell says why it would not load.', null, {});
		return;
	}

	if (ctx.software.fw4Loaded === null) {
		finding(out, 'fw4', 'info', 'Whether the firewall ruleset is loaded was not checked', '', null, {});
		return;
	}

	finding(out, 'fw4', 'pass', 'Firewall4 is loaded', '', null, {});
}

/** One row per requirement, whether or not this router meets it. */
export function requirements(ctx) {
	let out = [];

	memoryFindings(ctx, out);
	offloadFindings(ctx, out);
	conntrackFindings(ctx, out);
	neighbourFindings(ctx, out);
	leaseFindings(ctx, out);
	bandFindings(ctx, out);
	poolFindings(ctx, out);
	replyFindings(ctx, out);
	fw4Findings(ctx, out);

	return out;
};

// ---------------------------------------------------------------------------
// The problems: rows only when there is one.

/** What is wrong now, or is about to be. */
export function issues(ctx) {
	let out = [];

	let free = ctx.hardware.memAvailableKb;
	let total = ctx.hardware.memTotalKb;

	if (type(free) == 'int' && type(total) == 'int' && total > 0) {
		if (free * 10 < total) {
			finding(out, 'mem-low', 'error',
				sprintf('%d MB of %d MB is free', mb(free), mb(total)),
				'Below a tenth the kernel starts killing processes to get memory back, and a dialler is a process.',
				null, {});
		}
		else if (free * 5 < total) {
			finding(out, 'mem-low', 'warning',
				sprintf('%d MB of %d MB is free', mb(free), mb(total)), '', null, {});
		}
	}

	let load = ctx.hardware.load1;
	let cpus = ctx.hardware.cpus;

	if (type(load) == 'double' && type(cpus) == 'int' && cpus > 0 && load > cpus * 1.5) {
		finding(out, 'cpu-load', 'warning',
			sprintf('The one-minute load is %.1f on %d core(s)', load, cpus),
			(ctx.needed.flowOffload && ctx.software.flowOffload === false)
				? 'Flow offload is off, which at this many sessions is the first thing to turn on.'
				: '',
			null, {});
	}

	if (!ctx.load.answered.wanbind && ctx.software.packages.wanbind != null) {
		finding(out, 'wanbind-down', 'error', 'bm-wanbind is installed and not answering',
			'The live binding numbers below are missing; everything else about it is read from its configuration. `service bm-wanbind start` at a router shell.',
			null, {});
	}

	if (!ctx.load.answered.pppoe && ctx.software.packages.pppoe != null) {
		finding(out, 'pppoe-down', 'error', 'bm-pppoe-pool is installed and not answering',
			'The live session numbers below are missing. `service bm-pppoe start` at a router shell.',
			null, {});
	}

	if (ctx.daemons.netifdOk === false) {
		finding(out, 'netifd-blind', 'error', 'netifd is not answering the daemons',
			'Nothing either daemon decides is grounded until it does: every row is the last thing it saw. `ubus call network.interface dump` at a shell says whether netifd is alive.',
			null, {});
	}

	if (ctx.daemons.blind) {
		finding(out, 'pppoe-blind', 'error', 'The pool daemon cannot see the router\'s interfaces',
			'Session states are running on events alone, so one that dropped may still read up.', null, {});
	}

	if (ctx.daemons.localUsable === false) {
		finding(out, 'local-band', 'error', 'The LAN-local escape rules cannot be written',
			text(ctx.daemons.localReason), null, {});
	}
	else if (ctx.daemons.lanLocal === false) {
		finding(out, 'local-off', 'info', 'Bound addresses cannot reach this router\'s other networks',
			'A one-to-one binding sends everything from an address to its WAN, and that table knows only how to leave the building - so a bound machine reaches the internet and not the printer beside it.',
			ctx.daemons.localWritable
				? { kind: 'wanbind_settings_set', args: { lan_local: true } }
				: null,
			{});
	}

	if (number(ctx.daemons.missingRules) > 0) {
		finding(out, 'verify-missing', 'error',
			sprintf('%d rule(s) the daemon decided are not in the kernel', ctx.daemons.missingRules),
			'Something else is removing rules in this band. A pass puts them back and the log names what it found.',
			ctx.daemons.netifdOk === true ? { kind: 'wanbind_reconcile', args: {} } : null,
			{});
	}

	if (number(ctx.daemons.foreignInBands) > 0) {
		finding(out, 'foreign-rules', 'warning',
			sprintf('%d ip rule(s) inside this daemon\'s own priority bands were written by something else',
				ctx.daemons.foreignInBands),
			'`bmwan rules` names them. A rule in these bands decides before the ones this daemon writes.',
			null, {});
	}

	if (number(ctx.daemons.queueDepth) > 0) {
		finding(out, 'queue', 'warning',
			sprintf('%d session(s) are waiting to be redialled', ctx.daemons.queueDepth), '', null, {});
	}

	if (number(ctx.daemons.lastPassMs) > ctx.K.PASS_BUDGET_MS) {
		finding(out, 'pass-slow', 'warning',
			sprintf('bm-wanbind\'s last pass took %d ms', ctx.daemons.lastPassMs),
			'A pass has to finish well inside the interval between passes, or a router that is busy never catches up with itself. `bmwan status` breaks the time down by phase.',
			null, {});
	}

	// The files on disk and the code in memory, which after an upgrade are two
	// different releases until somebody restarts the service - and the running
	// one is the one deciding.
	if (ctx.load.answered.wanbind && length(text(ctx.daemons.release)) &&
	    ctx.software.packages.wanbind != null &&
	    ctx.daemons.release != ctx.software.packages.wanbind) {
		finding(out, 'running-stale', 'warning',
			sprintf('bm-wanbind is running %s and %s is installed',
				ctx.daemons.release, ctx.software.packages.wanbind),
			'The installed files were replaced under the running service. `service bm-wanbind restart` at a router shell.',
			null, {});
	}

	for (let zone in ctx.load.configured.zones) {
		if (zone.networks > ctx.K.FLOW_OFFLOAD_THRESHOLD && zone.devices == 0) {
			finding(out, 'zone-network-list', 'warning',
				sprintf('Firewall zone %s names %d interfaces one by one', zone.name, zone.networks),
				'fw4 reloads the whole firewall every time one of them comes up, so a pool dialling after a reboot is a reload per session. A pass moves the zone to one device pattern instead.',
				ctx.load.answered.pppoe ? { kind: 'pool_reconcile', args: {} } : null,
				{});
		}
	}

	return out;
};
