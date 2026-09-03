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

import { seed, wipe } from 'fs';
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
