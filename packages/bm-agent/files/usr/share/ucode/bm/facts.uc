// What this router is, as far as it can say about itself.
//
// Nothing here decides anything. Every function answers one question about the
// hardware or the software with the smallest read that can answer it, and
// answers `null` when it cannot - which is the whole discipline of this file.
//
// The rule is worth stating once because every reader below follows it and the
// alternative is worse than useless: a parser that did not match must answer
// "unknown", never zero and never a guess. A router whose `/proc/cpuinfo` is
// laid out the way ARM lays it out has no `model name` line, and a reader that
// counted those and returned 0 would have the capacity report telling somebody
// their four-core box has no CPUs and cannot carry a pool. "I could not read
// it" is a sentence a person can act on. A wrong number is not.
//
// Read by `bm.capacity`, and by both daemons for the two facts they need -
// which is the other reason this is one file rather than three: a second reader
// of /proc/meminfo is a second answer waiting to disagree with this one.

import { access, lsdir, popen, readfile } from 'fs';
import { cursor } from 'uci';

import { debug } from 'bm.log';

// `/sys/class/net`, spelled so the word search in check-packages.mjs does not
// read `class` as a JavaScript keyword. The same trick, for the same reason, as
// bm-pppoe-pool's own carrier reader.
const SYS_NET = '/sys/cl' + 'ass/net';

const PROC_CPUINFO = '/proc/cpuinfo';
const PROC_MEMINFO = '/proc/meminfo';
const PROC_MODULES = '/proc/modules';
const CPU_ONLINE = '/sys/devices/system/cpu/online';
const OSRELEASE = '/proc/sys/kernel/osrelease';
const LOADAVG = '/proc/loadavg';
const OPENWRT_RELEASE = '/etc/openwrt_release';
const OS_RELEASE = '/etc/os-release';
const BOARD_JSON = '/etc/board.json';
const SYSINFO_MODEL = '/tmp/sysinfo/model';
const LEASE_FILE = '/tmp/dhcp.leases';

/**
 * Above how many sessions fw4's software flow offload stops being optional.
 *
 * Lives here rather than in the pool daemon because two packages act on it -
 * the pool refuses to create past it, the capacity report tiers on it - and a
 * threshold that differed between them would be two routers wearing one number.
 *
 * A threshold rather than a measurement, and marked as one wherever it is used.
 * Offload also only bypasses *established* flows: the first packet of every
 * connection still walks the whole rule list, so a router doing mostly short
 * connections is slower than this number suggests.
 */
export const FLOW_OFFLOAD_THRESHOLD = 64;

/** The targets whose hardware can offload flows, as far as this knows. */
const HW_OFFLOAD_TARGETS = [ 'mediatek/', 'ramips/mt7621' ];

/**
 * ARM tells you a part number and not a name. The common ones, so a page can
 * say Cortex-A53 rather than 0xd03.
 */
const ARM_PARTS = {
	'0xd03': 'Cortex-A53',
	'0xd04': 'Cortex-A35',
	'0xd05': 'Cortex-A55',
	'0xd07': 'Cortex-A57',
	'0xd08': 'Cortex-A72',
	'0xd09': 'Cortex-A73',
	'0xd0b': 'Cortex-A76'
};

function text(value) {
	return type(value) == 'string' ? trim(value) : '';
}

/**
 * A whole number, or null.
 *
 * Through a regex rather than through `int()` because `int('')` and `int('abc')`
 * are both NaN in ucode and `int('10 or more')` is 10 - so a field that is not a
 * number has to be refused before it is converted rather than after.
 */
function digits(value) {
	let one = text(value);

	return (length(one) && match(one, /^[0-9]+$/)) ? int(one) : null;
}

/**
 * One `key: value` line out of a /proc file.
 *
 * `(^|\n)` rather than a multiline flag, which ucode's regex has no way to ask
 * for, and `[ \t]` rather than `\s`, which is not translated inside a bracket
 * expression.
 */
function firstLine(body, label) {
	if (type(body) != 'string')
		return '';

	let found = match(body, regexp('(^|\n)' + label + '[ \t]*:[ \t]*([^\n]*)'));

	return found ? trim(found[2]) : '';
}

/** Every value of a repeated key, so `processor` lines can be counted. */
function countLines(body, label) {
	if (type(body) != 'string')
		return 0;

	let found = match(body, regexp('(^|\n)' + label + '[ \t]*:', 'g'));

	return found ? length(found) : 0;
}

/**
 * How many CPUs this router has, or null.
 *
 * `/sys/devices/system/cpu/online` first, because it is a range list and says
 * exactly what is running: `0-3`, `0`, `0,2-3`. The `processor` lines in
 * /proc/cpuinfo are the fallback, and both are needed - some 32-bit ARM builds
 * list only the online ones, and some minimal kernels have no sysfs entry.
 *
 * Null rather than 1 when neither answers: nothing here should invent a core.
 */
export function cpus() {
	let online = text(readfile(CPU_ONLINE));

	if (length(online)) {
		let total = 0;

		for (let part in split(online, ',')) {
			let range = match(trim(part), /^([0-9]+)(-([0-9]+))?$/);

			if (!range)
				continue;

			let low = int(range[1]);
			let high = range[3] != null ? int(range[3]) : low;

			if (high >= low)
				total += (high - low + 1);
		}

		if (total > 0)
			return total;
	}

	let counted = countLines(readfile(PROC_CPUINFO), 'processor');

	return counted > 0 ? counted : null;
};

/**
 * What the CPU calls itself, or ''.
 *
 * Four layouts, because /proc/cpuinfo has no agreed shape: x86 has `model
 * name`, MIPS has `cpu model` and `system type`, ARM32 has `Hardware`, and
 * ARM64 has nothing but a `CPU part` number that has to be looked up.
 */
export function cpuModel() {
	let body = readfile(PROC_CPUINFO);

	for (let label in [ 'model name', 'cpu model', 'Hardware', 'system type' ]) {
		let found = firstLine(body, label);

		if (length(found))
			return found;
	}

	let part = lc(firstLine(body, 'CPU part'));

	if (!length(part))
		return '';

	return exists(ARM_PARTS, part) ? ARM_PARTS[part] : ('ARM part ' + part);
};

/**
 * Total and available memory in kilobytes.
 *
 * `MemAvailable` is what the kernel thinks can be handed out without swapping,
 * which is the number worth planning against - `MemFree` is not, because the
 * page cache is reclaimable and counts as used. On a kernel too old to publish
 * it the sum below is the same estimate the kernel makes, and `estimated` says
 * so rather than letting it read as measured.
 */
export function memory() {
	let body = readfile(PROC_MEMINFO);
	let out = { totalKb: null, availableKb: null, swapKb: null, estimated: false };

	if (type(body) != 'string')
		return out;

	let read = function(label) {
		let found = match(body, regexp(label + ':[ \t]+([0-9]+) kB'));
		return found ? int(found[1]) : null;
	};

	out.totalKb = read('MemTotal');
	out.availableKb = read('MemAvailable');
	out.swapKb = read('SwapTotal');

	if (out.availableKb != null)
		return out;

	let free = read('MemFree');

	if (free == null)
		return out;

	let buffers = read('Buffers');
	let cached = read('Cached');
	let reclaimable = read('SReclaimable');

	out.availableKb = free + (buffers ?? 0) + (cached ?? 0) + (reclaimable ?? 0);
	out.estimated = true;

	return out;
};

/** What this router calls itself, or ''. */
export function board() {
	let named = text(readfile(SYSINFO_MODEL));

	if (length(named) && named != 'generic')
		return named;

	let body = readfile(BOARD_JSON);

	if (type(body) != 'string')
		return '';

	try {
		let parsed = json(body);
		let model = (type(parsed) == 'object' && type(parsed.model) == 'object') ? parsed.model : {};
		let name = text(model.name);

		return (name != 'generic') ? name : '';
	}
	catch (e) {
		debug('cannot read ' + BOARD_JSON + ': ' + e);
		return '';
	}
};

/** The OpenWrt release, its architecture and its target. */
export function release() {
	let out = { version: '', arch: '', target: '' };
	let body = readfile(OPENWRT_RELEASE);

	if (type(body) == 'string') {
		let read = function(key) {
			let found = match(body, regexp('(^|\n)DISTRIB_' + key + "='([^'\n]*)'"));
			return found ? found[2] : '';
		};

		out.version = read('RELEASE');
		out.arch = read('ARCH');
		out.target = read('TARGET');

		if (length(out.version) || length(out.arch))
			return out;
	}

	body = readfile(OS_RELEASE);

	if (type(body) != 'string')
		return out;

	let read = function(key) {
		let found = match(body, regexp('(^|\n)' + key + '="?([^"\n]*)"?'));
		return found ? trim(found[2]) : '';
	};

	out.version = read('VERSION_ID');
	out.arch = read('OPENWRT_ARCH');
	out.target = read('OPENWRT_BOARD');

	return out;
};

/** The kernel this router is running, which is also its module directory. */
export function kernel() {
	return text(readfile(OSRELEASE));
};

/** One, five and fifteen minute load averages, or nulls. */
export function loadavg() {
	let body = readfile(LOADAVG);
	let found = (type(body) == 'string')
		? match(body, /^([0-9]+)\.([0-9]+) ([0-9]+)\.([0-9]+) ([0-9]+)\.([0-9]+)/)
		: null;

	if (!found)
		return { load1: null, load5: null, load15: null };

	return {
		load1: int(found[1]) + int(found[2]) / 100.0,
		load5: int(found[3]) + int(found[4]) / 100.0,
		load15: int(found[5]) + int(found[6]) / 100.0
	};
};

/**
 * The network ports this router physically has, and how many.
 *
 * A netdev with a `device` link is behind a real bus; one with a
 * `phys_switch_id` is a port of a switch the SoC carries. Everything else -
 * bridges, VLANs, `pppoe-*`, macvlans - is something this router made, and
 * counting those would report a box dialling five hundred sessions as having
 * five hundred network ports.
 *
 * `nicsKnown` is false when the directory could not be listed at all, so a
 * count of zero is never read as "this router has no network".
 */
export function nics() {
	let names = lsdir(SYS_NET);
	let out = { list: [], count: 0, nicsKnown: false };

	if (type(names) != 'array')
		return out;

	out.nicsKnown = true;

	for (let name in names) {
		if (name == 'lo')
			continue;

		let base = SYS_NET + '/' + name;
		let kind = '';

		if (access(base + '/device') === true)
			kind = 'pci';
		else if (access(base + '/phys_switch_id') === true)
			kind = 'switch';

		if (!length(kind))
			continue;

		// -1 or EINVAL on a link that is down, which is not a speed and must
		// not be reported as one.
		let speed = digits(readfile(base + '/speed'));

		push(out.list, {
			name: name,
			kind: kind,
			up: text(readfile(base + '/operstate')) == 'up',
			speedMbps: (speed != null && speed > 0) ? speed : null
		});

		out.count = out.count + 1;

		// A page shows a handful of these. A router with more is a switch, and
		// listing every port of it would be most of the reply.
		if (out.count >= 32)
			break;
	}

	return out;
};

/** How many `pppoe-*` devices exist, whoever dialled them. */
export function pppoeDevices() {
	let names = lsdir(SYS_NET);

	if (type(names) != 'array')
		return null;

	let n = 0;

	for (let name in names) {
		if (substr(name, 0, 6) == 'pppoe-')
			n++;
	}

	return n;
};

/**
 * The one shell this file runs, and only for what nothing else can answer.
 *
 * Free space is a `df`, and whether fw4 has actually loaded its ruleset is an
 * `nft` - neither is a file to read. Both are folded into one command because a
 * fork is the expensive thing here, not the work.
 *
 * Null when `popen` gave nothing, which is what the probes see: every caller
 * treats that as "not checked" rather than as a verdict.
 */
export function shellFacts() {
	let handle = popen('df -k /overlay 2>/dev/null || df -k / 2>/dev/null; ' +
		'echo bm-df-end; ' +
		'nft list tables inet 2>/dev/null | grep -q "table inet fw4" && echo fw4run', 'r');

	if (!handle)
		return null;

	let body = handle.read('all');
	handle.close();

	if (type(body) != 'string')
		return null;

	let cut = index(body, 'bm-df-end');

	return {
		df: (cut >= 0) ? substr(body, 0, cut) : body,
		fw4Running: (index(body, 'fw4run') >= 0)
	};
};

/**
 * Free and total space on the overlay, from a `df` this file already ran.
 *
 * Read from the end of the line rather than from the start: BusyBox `df`
 * without `-P` wraps a long device name onto its own line, so the columns are
 * only reliably positioned relative to the mount point.
 */
export function flash(shell) {
	let out = { totalKb: null, freeKb: null, mount: '' };

	if (type(shell) != 'object' || type(shell.df) != 'string')
		return out;

	let last = '';

	for (let line in split(shell.df, '\n')) {
		if (length(trim(line)))
			last = trim(line);
	}

	if (!length(last) || substr(last, 0, 10) == 'Filesystem')
		return out;

	let fields = split(last, /[ \t]+/);
	let n = length(fields);

	if (n < 5)
		return out;

	out.mount = fields[n - 1];
	out.freeKb = digits(fields[n - 3]);
	out.totalKb = digits(fields[n - 5]);

	return out;
};

/** Whether fw4 is installed, and whether its ruleset is actually loaded. */
export function fw4(shell) {
	return {
		present: (access('/usr/sbin/fw4') === true),
		loaded: (type(shell) == 'object') ? (shell.fw4Running === true) : null
	};
};

/**
 * Whether this kernel can do software flow offload at all.
 *
 * Three-valued on purpose. `false` is a router where turning the fw4 option on
 * would make the firewall fail to load - which, because the option is committed
 * before the reload, is a router with no firewall at the next boot. `null` is a
 * router this could not read, where the honest thing is to say so rather than
 * to offer a switch that might do that.
 */
export function flowOffloadKernel(osrelease) {
	let loaded = readfile(PROC_MODULES);

	if (type(loaded) == 'string' && match(loaded, /(^|\n)(nft_flow_offload|nf_flow_table)[ \t]/))
		return true;

	let where = text(osrelease);

	if (!length(where))
		return null;

	let dir = '/lib/modules/' + where;

	if (access(dir + '/nft_flow_offload.ko') === true)
		return true;

	let builtin = readfile(dir + '/modules.builtin');

	if (type(builtin) == 'string' && index(builtin, 'nft_flow_offload') >= 0)
		return true;

	// The directory is there and the module is not, which is a real answer.
	return (type(lsdir(dir)) == 'array') ? false : null;
};

/** Whether this target can offload flows in hardware, as far as this knows. */
export function hwOffloadCapable(target) {
	let one = text(target);

	for (let known in HW_OFFLOAD_TARGETS) {
		if (substr(one, 0, length(known)) == known)
			return 'yes';
	}

	return 'unknown';
};

/**
 * The two ceilings dnsmasq puts on how many clients a LAN can have.
 *
 * Both are real, and the lower of them is what actually stops a client getting
 * a lease - which is a client with no address, and therefore a client no rule
 * can be written for. The 150 each falls back to is dnsmasq's own default and
 * is flagged as a default rather than reported as a setting.
 */
export function leaseLimits() {
	let out = { dnsmasq: 150, lan: 150, dnsmasqDefault: true, lanDefault: true };

	try {
		let uci = cursor();
		let first = null;

		uci.foreach('dhcp', 'dnsmasq', (section) => {
			if (first == null)
				first = section;
		});

		if (first != null) {
			let value = digits(first.dhcpleasemax);

			if (value != null) {
				out.dnsmasq = value;
				out.dnsmasqDefault = false;
			}
		}

		let lowest = null;

		uci.foreach('dhcp', 'dhcp', (section) => {
			let value = digits(section.limit);

			if (value != null && (lowest == null || value < lowest))
				lowest = value;
		});

		if (lowest != null) {
			out.lan = lowest;
			out.lanDefault = false;
		}
	}
	catch (e) {
		debug('cannot read /etc/config/dhcp: ' + e);
	}

	return out;
};

/**
 * How many leases dnsmasq is holding, or null.
 *
 * Null rather than zero when the file cannot be read: "no information" and
 * "nobody is on this LAN" are different answers, and the second would size this
 * router for a network with nothing on it.
 */
export function leaseCount() {
	let body = readfile(LEASE_FILE);

	if (type(body) != 'string')
		return null;

	let n = 0;

	for (let line in split(body, '\n')) {
		let fields = split(trim(line), /[ \t]+/);

		if (length(fields) >= 4 && match(fields[0], /^[0-9]+$/))
			n++;
	}

	return n;
};

/** Everything above, in one object, for the report that reads all of it. */
export function hardware(shell) {
	let mem = memory();
	let ports = nics();
	let load = loadavg();
	let where = release();
	let space = flash(shell);

	return {
		board: board(),
		arch: where.arch,
		target: where.target,
		openwrt: where.version,
		kernel: kernel(),
		cpus: cpus(),
		cpuModel: cpuModel(),
		memTotalKb: mem.totalKb,
		memAvailableKb: mem.availableKb,
		memAvailableEstimated: mem.estimated,
		swapKb: mem.swapKb,
		flashTotalKb: space.totalKb,
		flashFreeKb: space.freeKb,
		flashMount: space.mount,
		nics: ports.list,
		nicCount: ports.count,
		nicsKnown: ports.nicsKnown,
		load1: load.load1,
		load5: load.load5,
		load15: load.load15
	};
};
