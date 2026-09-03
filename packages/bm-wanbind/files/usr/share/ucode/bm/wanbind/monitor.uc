// Everything steering traffic on this router, and why each address is not on
// the default connection.
//
// This is the file somebody reads when a device is not going out of the line
// they expected it to. Every other file here is about the rules this daemon
// writes; this one is about all of them, because the answer to "why is that
// laptop on wan1" is as often a rule somebody typed at a shell two years ago as
// it is anything this package did, and a monitor that listed only its own work
// would show a tidy table and explain nothing.
//
// Ownership is decided here rather than by whatever displays it. The module
// used to read `ip rule show` over SSH and infer whose a rule was from its
// priority alone, and a priority cannot tell an instance's client rule from a
// hand-written one at the same number, nor one instance's catch-all from
// another instance's stray - the bands overlap by construction, which is the
// fault `rules.ownedClientRules` next door exists to describe. The daemon holds
// the sections, the band, the seated assignments and the kernel's own two dumps
// in one place, so it is the only half that can say `owner` and be right.
//
// The sentences are what the rest of it is for. Each is built out of what the
// dumps and the configuration actually say - which table the rule looks up,
// what that table's default route is, which section claims it - and never out
// of what this daemon meant to do. "Bound by hand to wan2", said about a rule
// pointing at a table that cannot answer, is worse than saying nothing: it is
// the failure wearing the answer's clothes, and it sends somebody to look at
// the wrong end of their router.
//
// Nothing here writes. Not a rule, not a route, not a line of UCI - this is
// asked while somebody is working out what is wrong, which is the worst moment
// to also be changing it.

import { debug } from 'bm.log';

import * as netlink from 'bm.wanbind.netlink';
import * as wans from 'bm.wanbind.wans';

/**
 * How many rules one answer carries.
 *
 * A router with a thousand bound clients has a thousand rules, and the whole
 * point of the package is that this is ordinary - so the default is well above
 * anything a real table holds, and the ceiling exists only so that one ubus
 * reply cannot be asked to carry an unbounded one.
 */
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

// The kernel's own table numbers, and the names `ip rule` prints for them.
const MAIN_TABLE = 254;
const TABLE_NAMES = { '255': 'local', '254': 'main', '253': 'default' };

/**
 * The three rules the kernel puts in every routing policy database.
 *
 * `ip rule` prints them on a router nobody has touched: priority 0 to the local
 * table, 32766 to main, 32767 to default, each with no selector at all. They
 * are matched on the whole triple rather than on the priority, because 253 is
 * also the table this package ships as its catch-all - a bare rule at 32767 to
 * table 253 is the kernel's, one at 30000 from a LAN to table 253 is an
 * instance fencing that LAN, and calling either of them the other is the
 * difference between "your router is normal" and "your LAN is fenced".
 */
const BASELINE = { '255': 0, '254': 32766, '253': 32767 };

/**
 * FR_ACT_*, spelled out rather than read from `rtnl.const`.
 *
 * The argument rules.uc makes about its route types: this module never imports
 * rtnl - netlink.uc is the one place that does - and these have not moved since
 * fib rules gained actions. A rule whose action is not a table lookup answers
 * the packet itself, which is a different sentence from every other one here.
 */
const TO_TABLE = 1;
const ACT_BLACKHOLE = 6;
const ACT_UNREACHABLE = 7;
const ACT_PROHIBIT = 8;

// RTN_*, the two route types that mean "this lookup ends here, with nothing".
const RTN_BLACKHOLE = 6;
const RTN_UNREACHABLE = 7;

function arrayOr(value) {
	return (type(value) == 'array') ? value : [];
}

function objectOr(value) {
	return (type(value) == 'object') ? value : {};
}

function intOr(value, fallback) {
	return (type(value) == 'int') ? value : fallback;
}

function text(value) {
	return (type(value) == 'string') ? value : '';
}

/** Object keys are labels or strings in ucode, never integers. */
function key(value) {
	return sprintf('%d', value);
}

/**
 * Whether this is the route everything with nowhere better to go takes.
 *
 * An empty destination is the answer, and it is worth saying why rather than
 * testing a prefix length: a route dump hands back `dst` already in CIDR form -
 * `12.10.10.0/24` - and says nothing at all for the default, with no separate
 * length field to read. Checked against a real router. The other spellings are
 * kept because a caller may hand this a route it built rather than read.
 */
function isDefault(one) {
	let dst = text(one.dst);
	return !length(dst) || dst == 'default' || dst == '0.0.0.0' || dst == '0.0.0.0/0';
}

/**
 * Whether the rule sends the packet to a table at all.
 *
 * Action 0 with a table is read as a lookup, because that is what a dump
 * missing the attribute means to every caller here. An action this file does
 * not know is not treated as one: a rule that answers the packet itself has no
 * table clause to say anything about.
 */
function looksUp(one) {
	return (one.action == TO_TABLE || one.action == 0) && one.table > 0;
}

/**
 * What the rule matches, in the words `ip rule` would use.
 *
 * The source alone when there is one, because that is what every rule this
 * package writes carries and what a person is looking for. The rest are joined
 * rather than picked between: a rule selecting on both an incoming interface
 * and a mark is one rule, and showing half of its selector would describe a
 * rule that matches far more traffic than it does.
 */
function selectorOf(one) {
	if (length(one.cidr) && length(one.dst))
		return sprintf('from %s to %s', one.cidr, one.dst);

	if (length(one.cidr))
		return 'from ' + one.cidr;

	let parts = [];

	// A destination selector before the rest: netifd writes one per interface
	// with a routing table of its own, and a rule reported as selecting
	// "everything" when it selects one address is the kind of description that
	// sends somebody looking for a fault that is not there.
	if (length(one.dst))
		push(parts, 'to ' + one.dst);

	if (length(one.iif))
		push(parts, 'iif ' + one.iif);

	if (length(one.oif))
		push(parts, 'oif ' + one.oif);

	if (one.fwmark)
		push(parts, sprintf('fwmark %d', one.fwmark));

	return length(parts) ? join(' ', parts) : 'everything';
}

/**
 * How a sentence about this rule begins, and the noun the rest of it uses.
 *
 * One shape per kind of selector, so every reason below can be written once
 * rather than once per rule shape. `thing` is what the later clauses call the
 * traffic, and it is not always "this address": a sentence saying that about a
 * whole LAN is the small wrongness that makes a person stop believing the rest
 * of the page.
 */
function subjectOf(one) {
	let host = length(one.cidr) ? wans.hostAddress(one.cidr) : null;

	if (host)
		return { subject: host, thing: 'this address' };

	if (length(one.cidr))
		return { subject: 'Everything from ' + one.cidr, thing: 'anything in ' + one.cidr };

	let selector = selectorOf(one);

	if (selector != 'everything')
		return { subject: 'Traffic matching ' + selector, thing: 'this traffic' };

	return { subject: 'Every packet no earlier rule has matched', thing: 'this traffic' };
}

/**
 * What each routing table does with a packet handed to it.
 *
 * Only the default route of each table is kept, because that is the whole of
 * what "where does this address end up" turns on: a rule sends traffic to a
 * table, and unless that table can answer - which for anything on the internet
 * means its default route - the lookup finds nothing and the packet carries on
 * down the rule list as though the rule had never matched.
 *
 * `hasDefault` is deliberately about a default that goes somewhere. A table
 * whose default is `unreachable` has one and is still a dead end, and the two
 * are different dead ends: one was chosen, by this package or by somebody, to
 * park an address; the other is a table a rule points at that nobody ever
 * filled in. Reporting them as one fact would leave every surface unable to
 * tell a working hold from a rule that does nothing at all.
 */
function routeFacts(routes) {
	let out = {};

	for (let one in arrayOr(routes)) {
		if (type(one) != 'object' || !isDefault(one))
			continue;

		let at = key(one.table);
		let facts = out[at];

		if (facts == null) {
			facts = { table: one.table, hasDefault: false, unreachable: false, device: '', gateway: '' };
			out[at] = facts;
		}

		if (one.kind == RTN_UNREACHABLE || one.kind == RTN_BLACKHOLE) {
			facts.unreachable = true;
			continue;
		}

		facts.hasDefault = true;

		// The first live default keeps its device. A load-balanced table has one
		// line per nexthop, and naming one of them is nearer the truth than
		// naming none of them.
		if (!length(facts.device))
			facts.device = one.oif;

		if (!length(facts.gateway))
			facts.gateway = one.gateway;
	}

	return out;
}

/**
 * The priority at which this router first consults its main table.
 *
 * 32766 on every stock router, and still read off the dump rather than assumed,
 * because "before the main table is consulted" is the clause that makes every
 * sentence below mean anything. `ip rule add table main pref 100` is a thing
 * people do, and against an assumed 32766 this file would tell an operator that
 * a rule wins where it actually loses. The rules are in priority order by the
 * time this is asked, so the first bare one is the one traffic reaches first.
 */
function mainRulePref(ordered) {
	for (let one in ordered) {
		if (one.table != MAIN_TABLE || length(one.cidr) || length(one.iif) || length(one.oif) || one.fwmark)
			continue;

		return one.pref;
	}

	return intOr(BASELINE[key(MAIN_TABLE)], 32766);
}

/** Where this rule sits against the main table, which is what decides. */
function orderClause(pref, mainPref) {
	if (pref < mainPref)
		return 'that is before the main table is consulted';

	return 'that is only after the main table has already been consulted';
}

/** The first sentence: what the rule is, and when the kernel reaches it. */
function opening(one, subject, order) {
	if (one.action == ACT_BLACKHOLE)
		return sprintf('%s is dropped by a rule at priority %d, which looks up no table at all, and %s.', subject, one.pref, order);

	if (one.action == ACT_UNREACHABLE)
		return sprintf('%s is answered unreachable by a rule at priority %d, which looks up no table at all, and %s.', subject, one.pref, order);

	if (one.action == ACT_PROHIBIT)
		return sprintf('%s is refused by a rule at priority %d, which looks up no table at all, and %s.', subject, one.pref, order);

	if (!looksUp(one))
		return sprintf('%s is matched by a rule at priority %d whose action %d this monitor does not recognise, and %s.', subject, one.pref, one.action, order);

	return sprintf('%s has a policy rule at priority %d sending it to table %d, and %s.', subject, one.pref, one.table, order);
}

/**
 * The second sentence: what that table then does.
 *
 * The last branch is the one worth reading. A table with no default route does
 * not stop anything - a fib lookup that finds nothing is not a failure, the
 * kernel simply goes on to the next rule - and that is the entire reason
 * rules.uc writes `unreachable default` into every table it parks an address
 * in. So this says what really happens, and names the main table's own way out
 * when the dump gave one, rather than the tidier and untrue "no way out at
 * all": an operator told that would go looking for a broken table, when what
 * they have is a rule that is not doing anything.
 */
function tableClause(facts, table, thing, mainDevice) {
	let held = facts[key(table)];

	// What the table is, not what becomes of the traffic: the sentence after
	// this one draws that conclusion, and having both draw it read as the same
	// thing said twice in a row.
	if (held != null && held.unreachable)
		return sprintf('Table %d answers every lookup with unreachable, so it is a dead end rather than a way out.', table);

	if (held != null && held.hasDefault && length(held.device) && length(held.gateway))
		return sprintf('Table %d leaves through %s via %s.', table, held.device, held.gateway);

	if (held != null && held.hasDefault && length(held.device))
		return sprintf('Table %d leaves through %s.', table, held.device);

	if (held != null && held.hasDefault)
		return sprintf('Table %d has a default route, though the route dump names no device for it.', table);

	if (length(mainDevice)) {
		return sprintf('Table %d has no default route, so a lookup there finds nothing and %s carries on down the rule list - which, unless something below claims it, ends at the main table and leaves through %s.',
			table, thing, mainDevice);
	}

	return sprintf('Table %d has no default route, so a lookup there finds nothing and %s carries on down the rule list as though this rule had not matched.',
		table, thing);
}

/** What the rule does to the traffic in the end, once the table is known. */
function effect(one, facts) {
	if (!looksUp(one))
		return 'stops';

	if (one.table == MAIN_TABLE)
		return 'main';

	let held = facts[key(one.table)];

	if (held != null && held.unreachable)
		return 'parked';

	if (held != null && held.hasDefault)
		return 'elsewhere';

	return 'through';
}

/**
 * The sentence that answers the question this whole file exists for.
 *
 * "Not on the default connection" is a claim about the kernel and not about the
 * configuration, so it is only made where the table clause has just shown a way
 * out or a deliberate dead end. A rule naming a table that cannot answer
 * changes nothing at all, and saying it was bound by hand anyway would be this
 * monitor writing a confident sentence about a router it has just finished
 * reading the evidence against.
 */
function offDefault(went, thing, because) {
	if (went == 'elsewhere')
		return sprintf(' So %s is not on the router\'s default connection - %s.', thing, because);

	if (went == 'parked')
		return sprintf(' So %s is not reaching anything at all - %s.', thing, because);

	if (went == 'stops')
		return sprintf(' So %s gets no route out of this rule at all - %s.', thing, because);

	if (went == 'main')
		return sprintf(' Table %d is the router\'s own main table, so although %s, this rule puts %s exactly where it would have gone with no rule at all.', MAIN_TABLE, because, thing);

	return sprintf(' So this rule does not take %s off the default connection at all: %s, but the table it names cannot answer, and the packet carries on down the rule list as though the rule had not matched.',
		thing, because);
}

/**
 * Each instance, with the address blocks the router shows it is fencing.
 *
 * The scope is read off the catch-all rules in the dump rather than out of the
 * configuration, and that is what makes a client rule attributable at all:
 * `configured()` gives the LAN's *name*, and it is the LAN's subnet that says
 * whether an address is one this instance would ever seat. The catch-all this
 * daemon installs carries exactly those blocks - the subnet for a whole-LAN
 * instance, the range's blocks for a scoped one - so the router is already
 * holding the answer, and asking netifd for it again would be one more thing
 * that can be unavailable at the moment somebody needs the page.
 *
 * Usable instances come first, and the classifier takes the first that fits. An
 * instance the configuration has refused wrote nothing this pass; its rules are
 * left over from before it was refused, and where the two could both claim an
 * address the one still maintaining rules is the truer answer.
 */
function instanceViews(instances, all) {
	let usable = [];
	let refused = [];

	for (let one in arrayOr(instances)) {
		let cidrs = [];

		for (let rule in all) {
			if (rule.pref == one.catchAllPref && rule.table == one.catchAllTable && length(rule.cidr))
				push(cidrs, rule.cidr);
		}

		let view = {
			one: one,
			cidrs: cidrs,
			ranged: length(text(one.rangeFrom)) > 0 && length(text(one.rangeTo)) > 0
		};

		push((one.usable === false) ? refused : usable, view);
	}

	return [ ...usable, ...refused ];
}

/**
 * Whether this instance would ever seat that address.
 *
 * Both readings have to agree wherever both exist. The range is what the
 * operator asked for and the catch-all blocks are what the router is actually
 * fencing, and an address inside one and outside the other is exactly what two
 * instances sharing a LAN produce - attributing it to the wrong one would print
 * another instance's client under this instance's name, in the one surface
 * anybody reads when they are already confused.
 *
 * With neither, the priority band is all there is, and that is a real router:
 * an instance whose catch-all has not been installed yet, on the first pass
 * after a restart. Refusing to attribute anything there would report every
 * client rule the daemon itself had just written as somebody else's.
 */
function seats(view, host) {
	if (view.ranged && !wans.inRange(view.one.rangeFrom, view.one.rangeTo, host))
		return false;

	if (!length(view.cidrs))
		return true;

	for (let cidr in view.cidrs) {
		if (wans.contains(cidr, host))
			return true;
	}

	return false;
}

/**
 * Whether this is one of the three rules netifd writes for an `ip4table`.
 *
 * Their addresses are the interface's own, so the test is the selector shape
 * plus the table already being that interface's - which is what makes it a
 * statement about the router's plumbing rather than a guess from a number.
 */
function netifdShape(one, iface) {
	// The third of the three: locally-generated traffic, written `from all iif
	// lo lookup <table>`.
	//
	// Recognised by having no selector this dump can read rather than by the
	// `iif`, and that is not a shortcut - **ucode's rtnl does not return
	// FRA_IFNAME on these at all.** `ip rule show` prints `iif lo`, and the
	// same rule over netlink comes back carrying nothing but its priority,
	// action and table. Checked on a router with thirty-two of them.
	//
	// A rule with no readable selector that looks up an interface's own routing
	// table is netifd's either way: nothing in this package ever writes a rule
	// without a source, and the kernel's own three are settled before this is
	// reached.
	let bare = !length(one.cidr) && !length(one.dst) && !length(one.iif) &&
		!length(one.oif) && !one.fwmark;

	if (bare)
		return true;

	if (!length(iface.address))
		return false;

	// `from <its own address>/32 lookup <table>`.
	let host = length(one.cidr) ? wans.hostAddress(one.cidr) : null;

	if (host != null && host == iface.address)
		return true;

	// `from all to <its own address>/32 lookup <table>`.
	let target = length(one.dst) ? wans.hostAddress(one.dst) : null;

	return (target != null && target == iface.address);
}

/**
 * Whose rule this is, decided in the order the claims can be trusted.
 *
 * The kernel's own three are asked first, because a router where an instance
 * has been given `catch_all_pref 32767` would otherwise have the kernel's
 * default-table rule reported as that instance's catch-all. Exact priorities -
 * a binding's stamped number, an instance's catch-all - come before the bands,
 * because a band is a range of numbers while a stamped priority is a section
 * naming one rule as its own. Only then the client band, which is the one claim
 * that also has to be true of the address itself.
 */
function classify(one, ctx) {
	let out = { owner: 'foreign', id: '', instance: '', wan: '' };
	let bare = !length(one.cidr) && !length(one.iif) && !length(one.oif) && !one.fwmark;

	if (bare && intOr(BASELINE[key(one.table)], -1) == one.pref) {
		out.owner = 'kernel';
		return out;
	}

	let host = length(one.cidr) ? wans.hostAddress(one.cidr) : null;
	let stamped = ctx.bindingByPref[key(one.pref)];

	if (stamped != null || (ctx.band.base >= 1 && one.pref >= ctx.band.base && one.pref <= ctx.band.top)) {
		let named = (stamped != null) ? stamped : ((host != null) ? ctx.bindingByIp[host] : null);

		out.owner = 'manual';
		out.id = (named != null) ? text(named.id) : '';
		return out;
	}

	for (let view in ctx.views) {
		if (view.one.catchAllPref != one.pref)
			continue;

		out.owner = 'catch-all';
		out.instance = text(view.one.id);
		return out;
	}

	// An assignment is the strongest claim there is - the planner naming the
	// address, the priority and the WAN it seated, together - so it is asked
	// before the scope is inferred from anything.
	let seated = (host != null) ? ctx.seatedByKey[sprintf('%d|%s', one.pref, host)] : null;

	if (seated != null) {
		out.owner = 'client';
		out.instance = text(seated.instance);
		out.id = text(seated.mac);
		out.wan = text(seated.wan);
		return out;
	}

	if (host != null) {
		for (let view in ctx.views) {
			if (one.pref < view.one.rulePrefBase || one.pref >= view.one.catchAllPref)
				continue;

			if (!seats(view, host))
				continue;

			out.owner = 'client';
			out.instance = text(view.one.id);
			return out;
		}
	}

	// The LAN-local escapes: a destination, no source, straight to main. Asked
	// before netifd's own shape because netifd writes `to <its address> lookup
	// <its table>` rules that are the same shape from a distance - what tells
	// them apart is the table and the band, and both are exact here.
	if (!length(one.cidr) && length(one.dst) && one.table == MAIN_TABLE &&
		ctx.bands.local.base >= 1 && one.pref >= ctx.bands.local.base && one.pref <= ctx.bands.local.top) {
		out.owner = 'local';
		out.id = one.dst;
		return out;
	}

	let parked = ctx.parked[key(one.table)];

	if (parked != null) {
		out.owner = 'hold';
		out.instance = parked.instance;
		return out;
	}

	// netifd's own, and this is the reading a real router insisted on.
	//
	// Every interface carrying `option ip4table` gets three rules from netifd
	// without anybody asking: its address to its table, traffic *to* its address
	// to its table, and locally-generated traffic out of it. On a router running
	// thirty-two PPPoE sessions that is ninety-six rules, and calling every one
	// of them a stranger's - with a sentence about traffic going somewhere
	// nobody chose - buries the handful that are actually worth looking at under
	// a page of alarm about the router doing its job.
	//
	// They are recognised by what they are rather than by their priority:
	// netifd's numbers are netifd's to change, and the shape is not.
	let owned = ctx.tableOwner[key(one.table)];

	if (owned != null && netifdShape(one, owned)) {
		out.owner = 'netifd';
		// The interface, in the slot that answers "which named thing is this
		// rule about" for every other owner too - a binding's section, a
		// client's MAC. A reader scanning the column should not have to know
		// that one owner puts its subject somewhere else.
		out.id = owned.name;
		out.wan = owned.name;
		return out;
	}

	return out;
}

/** One rule, as one sentence somebody can act on. */
function reasonFor(one, verdict, ctx, facts) {
	if (verdict.owner == 'local') {
		return sprintf('This daemon wrote it. Traffic from any bound or pooled address to %s, one of this router\'s own LANs, is sent to the main table before any binding is consulted, so a bound machine can still reach the network beside it rather than being sent out of its WAN addressed to a private network that would drop it.',
			verdict.id);
	}

	if (verdict.owner == 'netifd') {
		// Said as plumbing rather than as policy, because that is what it is
		// and because there are three of them per interface: a router dialling
		// thirty-two PPPoE sessions carries ninety-six, and a page that framed
		// each one as somebody's decision would bury the handful that are.
		return sprintf('netifd wrote this. Every interface given a routing table of its own gets three rules like it - its own address to its table, traffic addressed to it to its table, and traffic the router itself sends out of it - so this one is %s being routed, rather than a decision anybody made about an address.',
			length(verdict.wan) ? verdict.wan : 'an interface');
	}

	if (verdict.owner == 'kernel') {
		return sprintf('This is one of the three rules the kernel ships on every Linux router. All it does is have the %s table (%d) consulted at priority %d - it selects nothing, and it steers no address anywhere on its own.',
			text(TABLE_NAMES[key(one.table)]), one.table, one.pref);
	}

	let named = subjectOf(one);
	let head = opening(one, named.subject, orderClause(one.pref, ctx.mainPref));
	let where = looksUp(one) ? (' ' + tableClause(facts, one.table, named.thing, ctx.mainDevice)) : '';
	let went = effect(one, facts);

	if (verdict.owner == 'manual') {
		let row = length(verdict.id) ? ctx.bindingById[verdict.id] : null;

		if (row == null) {
			return head + where + sprintf(' Its priority is inside the band this daemon numbers one-to-one bindings in (%d to %d) and no binding section claims it, so nothing is maintaining it and the next pass takes it off.',
				ctx.band.base, ctx.band.top);
		}

		if (row.state == 'held') {
			return head + where + offDefault(went, named.thing,
				sprintf('the one-to-one binding %s is held, which parks the address rather than letting it out over a connection nobody chose', row.id));
		}

		if (row.state == 'bound' && length(text(row.wan)))
			return head + where + offDefault(went, named.thing, sprintf('it is bound by hand to %s', row.wan));

		if (length(text(row.wan))) {
			return head + where + offDefault(went, named.thing,
				sprintf('the one-to-one binding %s names %s and is %s', row.id, row.wan, row.state));
		}

		return head + where + offDefault(went, named.thing, sprintf('the one-to-one binding %s put it there', row.id));
	}

	if (verdict.owner == 'client') {
		let because = (length(verdict.id) && length(verdict.wan))
			? sprintf('instance %s seated %s on %s', verdict.instance, verdict.id, verdict.wan)
			: sprintf('instance %s counts this address as one of its own clients', verdict.instance);

		return head + where + offDefault(went, named.thing, because);
	}

	if (verdict.owner == 'catch-all') {
		let tail = offDefault(went, named.thing,
			sprintf('this is instance %s\'s catch-all, the rule every client it has not given a WAN of its own falls through to', verdict.instance));

		if (went == 'parked')
			return head + where + tail + ' Without it, a client with no WAN of its own would not be unbound - it would be sharing the router\'s own connection with everybody else in the same position, silently.';

		return head + where + tail + ' A catch-all that does not dead-end is the failure it was installed to prevent, so this one is worth looking at first.';
	}

	if (verdict.owner == 'hold') {
		let purpose = length(verdict.instance)
			? sprintf('the table instance %s dead-ends its unassigned clients in', verdict.instance)
			: 'the table this daemon parks held one-to-one bindings in';

		return head + where + sprintf(' No section here claims this rule, so something else on this router wrote it - but table %d is %s, so whatever wrote it has parked %s rather than routed it.',
			one.table, purpose, named.thing);
	}

	// Precedence and effect are two different claims, and a rule that outranks
	// the band while naming a table that cannot answer has the first without the
	// second. Saying it wins anyway would send somebody to delete the rule that
	// is not the one moving their traffic.
	if (one.pref < ctx.low && went == 'through')
		return head + where + ' Nothing in this daemon\'s configuration claims this rule. It sits below every priority this daemon writes, so it is reached before any binding - but the table it names cannot answer, so as it stands it takes nothing away from them.';

	if (one.pref < ctx.low)
		return head + where + ' Nothing in this daemon\'s configuration claims this rule. It sits below every priority this daemon writes, so an address it matches goes where this rule says whatever any binding below claims.';

	if (one.pref > ctx.high) {
		return head + where + sprintf(' Nothing in this daemon\'s configuration claims this rule. It is consulted only after every priority this daemon writes (%d to %d), so it decides where %s goes only when nothing here has claimed it first.',
			ctx.low, ctx.high, named.thing);
	}

	return head + where + sprintf(' Nothing in this daemon\'s configuration claims this rule, and its priority falls inside the range this daemon numbers in (%d to %d), so whether it or a binding wins depends on the exact numbers either side of it.',
		ctx.low, ctx.high);
}

/** What one table is to this router, as far as the inputs can say. */
function roleOf(table, ctx) {
	if (table == MAIN_TABLE)
		return 'main';

	let parked = ctx.parked[key(table)];

	if (parked != null)
		return parked.kind;

	if (length(text(ctx.tableWan[key(table)])))
		return 'wan';

	return '';
}

/**
 * The whole answer to the `rules` verb.
 *
 * `read` false is the one thing this function is careful about above every
 * other. Both dumps come back null when the netlink socket cannot answer, and
 * the difference between that and an empty router is the difference between
 * "ask again in a moment" and "somebody has flushed every rule on this box" -
 * which is the single most misleading thing this monitor could ever say. So a
 * failed dump answers with nothing at all, and says so in the one field every
 * surface has to read before it renders a word.
 */
export function report(input) {
	let asked = objectOr(input);
	let limit = intOr(asked.limit, 0);

	if (limit < 1)
		limit = DEFAULT_LIMIT;

	if (limit > MAX_LIMIT)
		limit = MAX_LIMIT;

	let band = objectOr(asked.band);
	let instances = arrayOr(asked.instances);
	let bindings = arrayOr(asked.bindings);
	let assignments = arrayOr(asked.assignments);

	let local = objectOr(asked.local);

	let bands = {
		direct: { base: intOr(band.base, 0), top: intOr(band.top, 0) },
		local: { base: intOr(local.base, 0), top: intOr(local.top, 0) },
		instances: []
	};

	for (let one in instances) {
		let pref = intOr(one.catchAllPref, 0);

		push(bands.instances, {
			id: text(one.id),
			base: intOr(one.rulePrefBase, 0),
			top: (pref > 0) ? (pref - 1) : 0,
			catchAllPref: pref,
			catchAllTable: intOr(one.catchAllTable, 0)
		});
	}

	let all = netlink.allRules();
	let routes = netlink.routes();

	if (all === null || routes === null) {
		debug('the rule monitor was asked while a netlink dump was not answering, so it is reporting nothing rather than an empty router');

		return {
			ok: false,
			read: false,
			count: 0,
			capped: false,
			limit: limit,
			rules: [],
			bands: bands,
			main: null,
			tables: []
		};
	}

	// Sorted before anything is dropped, and by priority because that is the
	// order the kernel walks them in. A cap that kept an arbitrary slice would
	// be a report missing exactly the rules that win, which on a router with
	// more rules than the limit is the only part of the table worth having.
	let ordered = sort(all, (a, b) => {
		if (a.pref != b.pref)
			return a.pref - b.pref;

		if (a.cidr != b.cidr)
			return (a.cidr < b.cidr) ? -1 : 1;

		return a.table - b.table;
	});

	let facts = routeFacts(routes);
	let mainFacts = facts[key(MAIN_TABLE)];
	let main = (mainFacts != null && mainFacts.hasDefault)
		? { device: mainFacts.device, gateway: mainFacts.gateway }
		: null;

	let bindingById = {};
	let bindingByPref = {};
	let bindingByIp = {};
	let tableWan = {};
	let parked = {};

	for (let one in bindings) {
		let id = text(one.id);

		if (length(id))
			bindingById[id] = one;

		if (intOr(one.pref, 0) > 0)
			bindingByPref[key(one.pref)] = one;

		if (length(text(one.ip)) && bindingByIp[one.ip] == null)
			bindingByIp[one.ip] = one;

		// Only a bound binding says anything about a table. A held one points at
		// the hold table, and reading a WAN's name off that would label the one
		// table on this router that deliberately goes nowhere with the name of
		// the connection the address is being kept off.
		if (one.state == 'bound' && intOr(one.table, 0) > 0 && length(text(one.wan)))
			tableWan[key(one.table)] = one.wan;

		if (one.state == 'held' && intOr(one.table, 0) > 0 && parked[key(one.table)] == null)
			parked[key(one.table)] = { instance: '', kind: 'hold' };
	}

	let seatedByKey = {};

	for (let one in assignments) {
		if (length(text(one.ip)) && intOr(one.pref, 0) > 0)
			seatedByKey[sprintf('%d|%s', one.pref, one.ip)] = one;

		if (intOr(one.table, 0) > 0 && length(text(one.wan)))
			tableWan[key(one.table)] = one.wan;
	}

	// An instance's catch-all table is written over a hold entry for the same
	// number on purpose: `rules.holdTable` parks bindings in an instance's table
	// whenever the router has one, and the instance is who maintains it.
	let low = bands.direct.base;
	let high = bands.direct.top;

	for (let one in instances) {
		parked[key(one.catchAllTable)] = { instance: text(one.id), kind: 'catch-all' };

		if (one.rulePrefBase >= 1 && (low < 1 || one.rulePrefBase < low))
			low = one.rulePrefBase;

		if (one.catchAllPref > high)
			high = one.catchAllPref;
	}

	// Which interface each routing table belongs to, as netifd reports it. The
	// classifier needs it to tell the router's own plumbing from a rule somebody
	// wrote, and nothing else here can supply it: a table number on its own says
	// nothing about whose it is.
	let tableOwner = {};

	for (let one in arrayOr(input.interfaces)) {
		if (type(one) != 'object' || !(one.table > 0))
			continue;

		tableOwner[key(one.table)] = {
			name: text(one.name),
			address: (type(one.ipv4) == 'object' && type(one.ipv4.addr) == 'string')
				? one.ipv4.addr
				: ''
		};
	}

	let ctx = {
		band: bands.direct,
		bands: bands,
		tableOwner: tableOwner,
		views: instanceViews(instances, ordered),
		bindingById: bindingById,
		bindingByPref: bindingByPref,
		bindingByIp: bindingByIp,
		seatedByKey: seatedByKey,
		tableWan: tableWan,
		parked: parked,
		mainPref: mainRulePref(ordered),
		mainDevice: (main != null) ? main.device : '',
		low: low,
		high: high
	};

	let count = length(ordered);
	let wanted = (count > limit) ? limit : count;
	let rows = [];
	let seen = {};

	for (let i = 0; i < wanted; i++) {
		let one = ordered[i];
		let verdict = classify(one, ctx);

		push(rows, {
			pref: one.pref,
			cidr: one.cidr,
			table: one.table,
			action: one.action,
			selector: selectorOf(one),
			owner: verdict.owner,
			id: verdict.id,
			instance: verdict.instance,
			reason: reasonFor(one, verdict, ctx, facts)
		});

		if (looksUp(one))
			seen[key(one.table)] = true;
	}

	// The main table is always described, whether or not a listed rule names it.
	// Every sentence above measures itself against it, and a page that says an
	// address is "not on the router's default connection" without ever saying
	// what that connection is has answered half the question.
	seen[key(MAIN_TABLE)] = true;

	let numbers = [];

	for (let at in seen)
		push(numbers, int(at));

	sort(numbers, (a, b) => a - b);

	let tables = [];

	for (let table in numbers) {
		let held = facts[key(table)];

		push(tables, {
			table: table,
			wan: text(tableWan[key(table)]),
			role: roleOf(table, ctx),
			hasDefault: (held != null) && held.hasDefault,
			device: (held != null) ? held.device : '',
			gateway: (held != null) ? held.gateway : '',
			unreachable: (held != null) && held.unreachable
		});
	}

	return {
		ok: true,
		read: true,
		count: count,
		capped: (count > wanted),
		limit: limit,
		rules: rows,
		bands: bands,
		main: main,
		tables: tables
	};
};
