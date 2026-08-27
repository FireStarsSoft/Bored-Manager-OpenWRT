// The requirements report and the allowlisted installer.
//
// The probe lib's fs answers popen with null - there is deliberately no shell
// here - so what is being proved is the half that must hold anyway: the report
// says "not asked" rather than inventing a router with everything missing,
// and the installer refuses everything that is not a key in its own table
// before it would ever reach apk.

import { install, report as requirements } from 'bm.requirements';

import { check, report, resolves, says } from 'probe';

resolves('report()', () => requirements());
resolves('install({})', () => install({}));

// ---------------------------------------------------- no shell, no invention
let told = requirements();
check('report answers ok', told.ok, true);
check('but says it could not ask', told.asked, false);
check('and still lists every row', length(told.rows), 6);

let unknowns = 0;
for (let row in told.rows) {
	if (row.ok == null)
		unknowns++;
}
check('every row is unknown, none invented', unknowns, 6);

// -------------------------------------------------------------- the installer
let junk = install({ group: 'curl' });
check('a package name is not a group', junk.ok, false);
says('and the refusal lists the groups', junk.reason, /dnsmasq, ipfull, pppoe/);

let traversal = install({ group: '../etc' });
check('a path is not a group either', traversal.ok, false);

let planned = install({ group: 'pppoe', dry_run: true });
check('a dry run answers ok', planned.ok, true);
check('and changes nothing', planned.dryRun, true);
check('and names all three packages', join(' ', planned.packages), 'ppp ppp-mod-pppoe kmod-pppoe');

let ipfull = install({ group: 'ipfull', dry_run: true });
check('ipfull is one package', join(' ', ipfull.packages), 'ip-full');

// A real run in this harness has no apk to find - and must say that, not die.
let ran = install({ group: 'dnsmasq' });
check('a real run without apk refuses', ran.ok, false);
says('and says why', ran.reason, /no apk on this router/);

report();
