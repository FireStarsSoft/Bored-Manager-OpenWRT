// The scale limits: bounds, ordering, persistence - the arithmetic that
// decides whether a tune_set on somebody's production router raises a limit
// or quietly wrecks the neighbour cache staging. Driven against the probe
// lib's in-memory fs, so /proc/sys here is a seeded map and a "kernel refusal"
// is simply a path nobody seeded.

import { readfile, seed } from 'fs';

import { apply, CONF, current } from 'bm.tune';

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

report();
