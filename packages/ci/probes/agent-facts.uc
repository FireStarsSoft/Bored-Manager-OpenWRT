// What this router is, read off three routers that are not the one this runs on.
//
// Every fact in the capacity report starts here, and every one of them has a
// file format that differs by architecture. /proc/cpuinfo is the worst: x86 has
// `model name`, MIPS has `cpu model` and `system type`, ARM64 has neither and
// only a part number. A reader keyed on the x86 spelling returns nothing on the
// other two - and a caller that read "nothing" as zero would tell somebody
// their four-core router has no CPUs and cannot carry a pool.
//
// So the cases here are three cpuinfo layouts, a kernel with no MemAvailable, a
// filesystem that will not answer, and a router with none of it. The last one
// is the shape the whole report has to survive, because it is exactly what the
// probe harness looks like: `popen` and `stat` answer null, and only what has
// been seeded exists.

import { popenAsked, seed, setPopen, unlink, wipe } from 'fs';
import { cursor } from 'uci';

import * as facts from 'bm.facts';

import { check, report, resolves } from 'probe';

let uci = cursor();

const X86 = 'processor\t: 0\n' +
	'model name\t: Intel(R) Celeron(R) J4125 CPU @ 2.00GHz\n' +
	'processor\t: 1\n' +
	'model name\t: Intel(R) Celeron(R) J4125 CPU @ 2.00GHz\n' +
	'processor\t: 2\n' +
	'model name\t: Intel(R) Celeron(R) J4125 CPU @ 2.00GHz\n' +
	'processor\t: 3\n' +
	'model name\t: Intel(R) Celeron(R) J4125 CPU @ 2.00GHz\n';

const MIPS = 'system type\t\t: MediaTek MT7621 ver:1 eco:3\n' +
	'processor\t\t: 0\n' +
	'cpu model\t\t: MIPS 1004Kc V2.15\n' +
	'processor\t\t: 1\n' +
	'cpu model\t\t: MIPS 1004Kc V2.15\n' +
	'processor\t\t: 2\n' +
	'cpu model\t\t: MIPS 1004Kc V2.15\n' +
	'processor\t\t: 3\n' +
	'cpu model\t\t: MIPS 1004Kc V2.15\n';

const ARM64 = 'processor\t: 0\n' +
	'BogoMIPS\t: 48.00\n' +
	'CPU implementer\t: 0x41\n' +
	'CPU part\t: 0xd03\n' +
	'processor\t: 1\n' +
	'BogoMIPS\t: 48.00\n' +
	'CPU part\t: 0xd03\n';

resolves('facts.hardware', () => facts.hardware(null));

// ------------------------------------------------------------------- x86

seed('/proc/cpuinfo', X86);
check('x86 counts its processor lines', facts.cpus(), 4);
check('and reads the name off them', facts.cpuModel(), 'Intel(R) Celeron(R) J4125 CPU @ 2.00GHz');

// `online` wins where there is one, because it says what is running rather than
// what the kernel enumerated at boot.
seed('/sys/devices/system/cpu/online', '0-1' + chr(10));
check('the online list decides when there is one', facts.cpus(), 2);

seed('/sys/devices/system/cpu/online', '0,2-3' + chr(10));
check('and a range list is added up', facts.cpus(), 3);

// ------------------------------------------------------------------ MIPS

wipe();
seed('/proc/cpuinfo', MIPS);
check('MIPS counts its processors too', facts.cpus(), 4);
check('and finds a name where x86 keeps none', facts.cpuModel(), 'MIPS 1004Kc V2.15');

// ----------------------------------------------------------------- ARM64

wipe();
seed('/proc/cpuinfo', ARM64);
check('ARM counts its processors', facts.cpus(), 2);
check('and its part number becomes a name', facts.cpuModel(), 'Cortex-A53');

// A part nobody here knows is still said out loud rather than dropped.
wipe();
seed('/proc/cpuinfo', 'processor\t: 0' + chr(10) + 'CPU part\t: 0xdff' + chr(10));
check('an unknown part is reported as one', facts.cpuModel(), 'ARM part 0xdff');

// ------------------------------------------------------- nothing at all

wipe();
check('a router that says nothing about its CPUs is unknown', facts.cpus(), null);
check('rather than zero', facts.cpuModel(), '');

let bare = facts.hardware(null);

check('and the whole answer is still built', type(bare), 'object');
check('with memory unknown', bare.memTotalKb, null);
check('flash unknown', bare.flashFreeKb, null);
check('and no ports listed', bare.nicCount, 0);
check('which is not the same as having none', bare.nicsKnown, false);

// ----------------------------------------------------------------- memory

seed('/proc/meminfo',
	'MemTotal:        1017428 kB' + chr(10) +
	'MemFree:          612000 kB' + chr(10) +
	'MemAvailable:     700000 kB' + chr(10) +
	'SwapTotal:             0 kB' + chr(10));

let mem = facts.memory();
check('memory is read in kilobytes', mem.totalKb, 1017428);
check('and available is what the kernel says it is', mem.availableKb, 700000);
check('measured rather than estimated', mem.estimated, false);

// A kernel too old to publish MemAvailable. The estimate is the same one the
// kernel makes, and it says it is an estimate rather than passing for measured.
seed('/proc/meminfo',
	'MemTotal:         262144 kB' + chr(10) +
	'MemFree:          100000 kB' + chr(10) +
	'Buffers:            5000 kB' + chr(10) +
	'Cached:            20000 kB' + chr(10));

let older = facts.memory();
check('an older kernel is estimated from free, buffers and cache', older.availableKb, 125000);
check('and says so', older.estimated, true);

// `Cached` is a substring of `SwapCached`, and which one an unanchored search
// finds depends on the order the kernel prints them in. It prints `Cached`
// first today; nothing says it must, and a router that swaps would have had
// its available memory read off the wrong line.
seed('/proc/meminfo',
	'MemTotal:         262144 kB' + chr(10) +
	'MemFree:          100000 kB' + chr(10) +
	'Buffers:            5000 kB' + chr(10) +
	'SwapCached:       999999 kB' + chr(10) +
	'Cached:            20000 kB' + chr(10) +
	'SwapTotal:        200000 kB');

check('the cache line is read by name, not by whichever line contains the word',
	facts.memory().availableKb, 125000);

// ------------------------------------------------------------------ flash

check('a filesystem that will not answer leaves flash unknown', facts.flash(null).freeKb, null);

// BusyBox df without -P wraps a long device name onto its own line, so the
// columns are only reliably positioned relative to the mount point.
let wrapped = {
	df: 'Filesystem           1K-blocks      Used Available Use% Mounted on' + chr(10) +
		'/dev/mapper/a-very-long-name-indeed' + chr(10) +
		'                        122880     24576     98304  20% /overlay' + chr(10)
};

let space = facts.flash(wrapped);
check('a wrapped df line is read from the end', space.freeKb, 98304);
check('with its total', space.totalKb, 122880);
check('and its mount point', space.mount, '/overlay');

// -------------------------------------------------------------------- fw4
//
// The check that was wrong on every real router: the code asked
// `access('/usr/sbin/fw4')` and firewall4 installs `/sbin/fw4`, so a router
// with a working firewall was told it had none - while the readiness card,
// which has always used `command -v fw4`, said it was fine about the same
// router. Nothing here asserted fw4 at all, and the capacity probe seeded the
// same wrong path the code guessed, so both agreed with the bug.

// The shell string itself, driven end to end. This is the half that was checked
// by nothing: the sentinel the command echoes and the sentinel the parser looks
// for could be spelled differently and every other assertion here would still
// pass - which is exactly the shape of the bug this section exists for.
//
// The transcript is what a router prints, not what the code expects: df, the
// separator, then the two sentinels.
wipe();
setPopen('Filesystem           1K-blocks      Used Available Use% Mounted on
' +
	'/dev/root               122880     24576     98304  20% /overlay
' +
	'bm-df-end
' +
	'fw4here
' +
	'fw4run
');

let live = facts.shellFacts();

check('the shell said fw4 is there', live.fw4Present, true);
check('and that its ruleset is loaded', live.fw4Running, true);
check('and the df survived the same read', facts.flash(live).freeKb, 98304);
check('and fw4 reads as present from it', facts.fw4(live).present, true);

// The same router with no firewall: the separator is printed, neither sentinel
// is.
wipe();
setPopen('Filesystem           1K-blocks      Used Available Use% Mounted on
' +
	'/dev/root               122880     24576     98304  20% /overlay
' +
	'bm-df-end
');

let bare2 = facts.shellFacts();

check('no sentinel means no fw4', bare2.fw4Present, false);
check('and no ruleset', bare2.fw4Running, false);
check('and the finding follows', facts.fw4(bare2).present, false);

// The command has to actually ask. A parser looking for a word nothing echoes
// is the failure that hid for six review rounds.
let asked = popenAsked();
let saidHere = false;

for (let one in asked) {
	if (index(one, 'echo fw4here') >= 0)
		saidHere = true;
}

check('and the command it ran is the one that echoes that word', saidHere, true);

wipe();

// The shell is the answer where there is one, because it finds the binary
// wherever the distribution put it.
let told = facts.fw4({ fw4Present: true, fw4Running: true });
check('a shell that finds fw4 is what decides', told.present, true);
check('and it says whether the ruleset is loaded', told.loaded, true);

let quiet = facts.fw4({ fw4Present: false, fw4Running: false });
check('a shell that does not find it says so', quiet.present, false);

// With no shell at all - which is what this harness is - the fallback looks for
// the binary. Both paths, because guessing one is what went wrong.
wipe();
// Unknown, not absent. Not finding a binary in the two places it is usually put
// is not the same as knowing there is none, and a fallback that turned a failed
// guess into a verdict would be the original bug wearing a different hat.
check('no shell and no binary is unknown rather than absent', facts.fw4(null).present, null);
check('and the loaded question is unanswered rather than answered no',
	facts.fw4(null).loaded, null);

seed('/sbin/fw4', '');
check('fw4 where OpenWrt actually installs it is found', facts.fw4(null).present, true);

wipe();
seed('/usr/sbin/fw4', '');
check('and somewhere else on the path is found too', facts.fw4(null).present, true);

// ---------------------------------------------------------------- offload

wipe();
check('a kernel this cannot read is unknown rather than unable', facts.flowOffloadKernel(''), null);

seed('/proc/modules', 'nft_flow_offload 16384 1 - Live 0x0000000000000000' + chr(10));
check('a loaded module is a yes', facts.flowOffloadKernel('6.6.73'), true);

wipe();
seed('/lib/modules/6.6.73/nft_flow_offload.ko', 'x');
check('and one on disk is too', facts.flowOffloadKernel('6.6.73'), true);

wipe();
seed('/lib/modules/6.6.73/pppoe.ko', 'x');
seed('/lib/modules/6.6.73/modules.builtin', 'kernel/net/ipv4/ip_tunnel.ko' + chr(10));
check('a module directory without it is a no', facts.flowOffloadKernel('6.6.73'), false);

// `nf_flow_table` is `kmod-nf-flow`. `kmod-nft-offload` depends on it and so do
// several other things, so finding it loaded says the flowtable core is there -
// not that fw4's `flow_offloading` has an nftables expression to compile to.
// Counting it was an offer to switch on a firewall that would then not load.
wipe();
seed('/proc/modules', 'nf_flow_table 24576 1 - Live 0x0000000000000000' + chr(10) + '');
seed('/lib/modules/6.6.73/pppoe.ko', 'x');
check('the flowtable core on its own is not the expression fw4 needs',
	facts.flowOffloadKernel('6.6.73'), false);

check('a target known to offload in hardware says so', facts.hwOffloadCapable('ramips/mt7621'), 'yes');
check('and one nobody here knows about says that instead', facts.hwOffloadCapable('x86/64'), 'unknown');

// ------------------------------------------------------------------ ports

wipe();
seed('/sys/cl' + 'ass/net/eth0/device', '');
seed('/sys/cl' + 'ass/net/eth0/operstate', 'up' + chr(10));
seed('/sys/cl' + 'ass/net/eth0/speed', '1000' + chr(10));
seed('/sys/cl' + 'ass/net/lan1/phys_switch_id', 'aa' + chr(10));
seed('/sys/cl' + 'ass/net/lan1/operstate', 'down' + chr(10));
seed('/sys/cl' + 'ass/net/br-lan/uevent', 'x');
seed('/sys/cl' + 'ass/net/pppoe-fpt101/uevent', 'x');
seed('/sys/cl' + 'ass/net/lo/uevent', 'x');

let ports = facts.nics();

check('a port behind a bus and a switch port are both ports', ports.count, 2);
check('and the answer was actually read', ports.nicsKnown, true);
check('a bridge is not a port', ports.count, 2);
check('nor is a dialled session', ports.count, 2);
check('a link that is down has no speed', ports.list[1].speedMbps, null);
check('and one that is up has the one it negotiated', ports.list[0].speedMbps, 1000);

// The sessions are counted separately, because "how many ports does this router
// have" and "how many sessions are dialled on them" are different questions.
check('sessions are counted on their own', facts.pppoeDevices(), 1);

// ------------------------------------------------------------------ leases

wipe();
check('a lease file that is not there is unknown', facts.leaseCount(), null);

seed('/tmp/dhcp.leases',
	'1893456000 aa:bb:cc:dd:ee:01 10.9.0.10 one *' + chr(10) +
	'1893456000 aa:bb:cc:dd:ee:02 10.9.0.11 two *' + chr(10));
check('rather than zero, which is a different thing', facts.leaseCount(), 2);

let limits = facts.leaseLimits();
check('dnsmasq stops somewhere by default', limits.dnsmasq, 150);
check('and the report says it is a default', limits.dnsmasqDefault, true);

uci.set('dhcp', 'cfg01', 'dnsmasq');
uci.set('dhcp', 'cfg01', 'dhcpleasemax', '1500');
uci.set('dhcp', 'lan', 'dhcp');
uci.set('dhcp', 'lan', 'interface', 'lan');
uci.set('dhcp', 'lan', 'limit', '1000');

let raised = facts.leaseLimits();
check('a raised ceiling is read', raised.dnsmasq, 1500);

// A pool that hands nothing out does not get to decide the router's ceiling.
// A guest network switched off, or one with `limit 0`, made the LAN with five
// hundred clients on it look like it was allowed none.
uci.set('dhcp', 'guest', 'dhcp');
uci.set('dhcp', 'guest', 'interface', 'guest');
uci.set('dhcp', 'guest', 'limit', '10');
uci.set('dhcp', 'guest', 'ignore', '1');

uci.set('dhcp', 'iot', 'dhcp');
uci.set('dhcp', 'iot', 'interface', 'iot');
uci.set('dhcp', 'iot', 'limit', '0');

check('a switched-off pool does not decide the ceiling', facts.leaseLimits().lan, 1000);

// A section that never had the option is not a section with no ceiling.
// `dnsmasq.init` reads `config_get limit "$cfg" limit 150`, so this LAN has
// been handing out 150 addresses all along - and skipping it reported that the
// router had no per-LAN ceiling at all.
uci.set('dhcp', 'spare', 'dhcp');
uci.set('dhcp', 'spare', 'interface', 'spare');

check('a section with no limit carries dnsmasq own default', facts.leaseLimits().lan, 150);

uci.delete('dhcp', 'spare');
check('and no longer called a default', raised.dnsmasqDefault, false);
check('the per-LAN limit is read too', raised.lan, 1000);

// ------------------------------------------------------------- the release

wipe();
seed('/etc/openwrt_release',
	"DISTRIB_ID='OpenWrt'" + chr(10) +
	"DISTRIB_RELEASE='25.12.5'" + chr(10) +
	"DISTRIB_TARGET='x86/64'" + chr(10) +
	"DISTRIB_ARCH='x86" + "_64'" + chr(10));

let where = facts.release();
check('the release is read', where.version, '25.12.5');
check('with its architecture', where.arch, 'x86' + '_64');
check('and its target', where.target, 'x86/64');

// A snapshot is a real answer, not a missing one.
seed('/etc/openwrt_release', "DISTRIB_RELEASE='SNAPSHOT'" + chr(10) + "DISTRIB_ARCH='mipsel_24kc'" + chr(10));
check('a snapshot says so', facts.release().version, 'SNAPSHOT');
check('and still names its architecture', facts.release().arch, 'mipsel_24kc');

report();
