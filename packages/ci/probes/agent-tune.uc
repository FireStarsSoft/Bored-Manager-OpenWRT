// The scale limits: bounds, ordering, persistence - the arithmetic that
// decides whether a tune_set on somebody's production router raises a limit
// or quietly wrecks the neighbour cache staging. Driven against the probe
// lib's in-memory fs, so /proc/sys here is a seeded map and a "kernel refusal"
// is simply a path nobody seeded.

import { readfile, seed } from 'fs';

import { apply, CONF, current, recommended } from 'bm.tune';

import { check, report, resolves, says } from 'probe';

// A healthy x86 router's defaults.
seed('/proc/sys/net/netfilter/nf_conntrack_max', '65536\n');
seed('/proc/sys/net/netfilter/nf_conntrack_count', '1234\n');
seed('/proc/sys/net/ipv4/neigh/default/gc_thresh1', '128\n');
seed('/proc/sys/net/ipv4/neigh/default/gc_thresh2', '512\n');
seed('/proc/sys/net/ipv4/neigh/default/gc_thresh3', '1024\n');

resolves('current()', () => current());
resolves('apply({})', () => apply({}));

// ------------------------------------------------------------------ reading
let state = current();
check('current ok', state.ok, true);
check('current conntrack_max', state.values.conntrack_max, 65536);
check('current conntrack_count', state.values.conntrack_count, 1234);
check('current gc_thresh3', state.values.gc_thresh3, 1024);
check('nothing persisted yet', length(keys(state.persisted)), 0);

// ----------------------------------------------------------------- refusals
let low = apply({ conntrack_max: 3 });
check('a conntrack_max below the floor refuses', low.ok, false);
says('and names the bounds', low.reason, /16384 to 4194304/);

let typo = apply({ gc_tresh3: 16384 });
check('an unknown key refuses instead of vanishing', typo.ok, false);
says('and names the key', typo.reason, /unknown key "gc_tresh3"/);

let inverted = apply({ gc_thresh1: 9000 });
check('a thresh1 above the current thresh2 refuses', inverted.ok, false);
says('and says which pair inverted', inverted.reason, /gc_thresh1 cannot be above gc_thresh2/);

check('a refused apply changed nothing', current().values.gc_thresh1, 128);

// ------------------------------------------------------------------ applying
let raised = apply({ conntrack_max: 262144, gc_thresh1: 2048, gc_thresh2: 4096, gc_thresh3: 16384 });
check('an in-bounds apply succeeds', raised.ok, true);
check('and reports what it wrote', raised.applied.conntrack_max, 262144);
check('and the kernel value moved', current().values.gc_thresh3, 16384);
check('and it persisted', raised.persisted, true);

let pinned = readfile(CONF);
says('the drop-in pins conntrack', pinned, /net\.netfilter\.nf_conntrack_max=262144/);
says('the drop-in pins thresh3', pinned, /net\.ipv4\.neigh\.default\.gc_thresh3=16384/);

// A second apply of one key must keep the others pinned rather than rewrite
// the file down to the latest call - the file is the reboot story.
let again = apply({ conntrack_max: 524288 });
check('a follow-up apply succeeds', again.ok, true);
let merged = readfile(CONF);
says('the follow-up moved its own line', merged, /nf_conntrack_max=524288/);
says('and kept the thresholds pinned', merged, /gc_thresh3=16384/);

// conntrack_count is read-only context, never a tunable.
let sneaky = apply({ conntrack_count: 1 });
check('the read-only counter refuses as unknown', sneaky.ok, false);

// ---------------------------------------------------------- recommending
//
// The numbers here are also written to a fixture the module's own test reads,
// because the module carries the same arithmetic for the page that offers it.
// Two copies of a formula are two answers waiting to disagree in front of
// somebody deciding whether to raise a limit, so the two are diffed rather than
// trusted to have been kept in step.

const CASES = [
	{ clients: 0,    sessions: 0,    memTotalKb: 262144 },
	{ clients: 500,  sessions: 0,    memTotalKb: 524288 },
	{ clients: 500,  sessions: 0,    memTotalKb: 1048576 },
	{ clients: 500,  sessions: 500,  memTotalKb: 1048576 },
	{ clients: 500,  sessions: 500,  memTotalKb: 2097152 },
	{ clients: 4000, sessions: 1000, memTotalKb: 2097152 },
	{ clients: 4000, sessions: 1000, memTotalKb: 8388608 },
	{ clients: 4000, sessions: 1000, memTotalKb: 16777216 }
];

let table = [];

for (let one in CASES) {
	let out = recommended({ clients: one.clients, sessions: one.sessions }, one.memTotalKb);

	push(table, {
		clients: one.clients,
		sessions: one.sessions,
		memTotalKb: one.memTotalKb,
		conntrack_max: out.conntrack_max,
		gc_thresh1: out.gc_thresh1,
		gc_thresh2: out.gc_thresh2,
		gc_thresh3: out.gc_thresh3,
		mem_capped: out.mem_capped
	});
}

// A handful of them spelled out here as well, so that a change to the formula
// has to be a change somebody meant rather than a fixture quietly rewritten.
let small = recommended({ clients: 500, sessions: 0 }, 1048576);
check('five hundred clients on a gigabyte', small.conntrack_max, 262144);
check('and the neighbour table is about clients', small.gc_thresh3, 8192);
check('halved', small.gc_thresh2, 4096);
check('and quartered', small.gc_thresh1, 2048);

let tight = recommended({ clients: 500, sessions: 0 }, 524288);
check('the same load on half the memory is capped by it', tight.mem_capped, true);
check('to what an eighth of the memory would hold', tight.conntrack_max, 131072);

// Four thousand clients want the largest table there is, and eight gigabytes of
// RAM is not enough to be allowed it: four million entries is 1.3 GB if the
// table fills, and the ceiling here is an eighth of the router's memory.
let big = recommended({ clients: 4000, sessions: 1000 }, 8388608);
check('four thousand clients want a bigger table', big.conntrack_max, 2097152);
check('and a bigger neighbour table', big.gc_thresh3, 16384);
check('the memory is what decided the size', big.mem_capped, true);

let roomy = recommended({ clients: 4000, sessions: 1000 }, 16777216);
check('with the memory for it, they get the whole table', roomy.conntrack_max, 4194304);
check('and nothing capped it', roomy.mem_capped, false);

// Sessions are not clients: a PPP interface is NOARP and adds no neighbour.
check('sessions do not enlarge the neighbour table',
	recommended({ clients: 500, sessions: 500 }, 2097152).gc_thresh3,
	recommended({ clients: 500, sessions: 0 }, 2097152).gc_thresh3);

printf('bm-fixture tune-recommended %J' + chr(10), table);

report();
