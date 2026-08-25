// Writing and removing the `config interface` sections a pool is made of.
//
// This is the file that justifies the package on its own. The module can write
// these over SSH and does, in chunks, one `uci batch` per round trip; five
// thousand sessions is fifty round trips and a great deal of shell. Here it is
// one process on the router with the uci library open, and the whole pool is
// written before netifd is told about any of it.
//
// It is also where the credential handling gets simpler rather than more
// careful. Over SSH a password has to be kept off every command line, because
// /proc/<pid>/cmdline is world-readable - the module writes payloads to a 0600
// file and pipes them through stdin for exactly that reason. Here the password
// goes from a JSON document into `uci.set` inside this process and never
// becomes an argument to anything, so there is no command line to keep it off.
//
// Nothing here logs a credential. Not at debug, not in an error, not in a
// summary. The only thing that ever leaves this file about an account is its
// username, and only where a person needs to see which account failed.

import { cursor } from 'uci';

import { debug, err, notice } from 'bm.log';

import { safeValue, sectionName, tableFor } from 'bm.pppoe.config';

const NETWORK = 'network';

// How many sections to write before committing. A commit is a file rewrite, so
// committing per section on a pool of five thousand is five thousand rewrites;
// committing once at the end means a power cut in the middle leaves nothing at
// all. Five hundred is about a hundred kilobytes of config text.
const COMMIT_EVERY = 500;

/** `eth1` and VLAN 101 -> `eth1.101`, or just `eth1`. */
export function deviceFor(carrier, vlan) {
	return (type(vlan) == 'int' && vlan >= 1 && vlan <= 4094)
		? sprintf('%s.%d', carrier, vlan)
		: carrier;
};

/**
 * The VLAN device a pool needs, if it uses one.
 *
 * One `config device` section for the whole pool rather than one per session:
 * every session on a VLAN shares the same tagged device, and netifd only needs
 * to be told about it once.
 *
 * `bmv<vlan>` is the module's name for the same section, and matching it is the
 * point. Only one half writes a given pool, but the other half cleans up after
 * it: uninstall this package and the module deletes the pool over SSH, looking
 * for exactly this section by exactly this name. A second spelling would leave
 * a `config device` behind declaring a tagged interface with no pool on it, and
 * nothing on either side would ever look for it again.
 */
function vlanSection(uci, carrier, vlan) {
	let name = sprintf('bmv%d', vlan);
	let device = deviceFor(carrier, vlan);

	if (length(device) > 15)
		return { ok: false, reason: device + ' is longer than Linux allows for an interface name' };

	uci.set(NETWORK, name, 'device');
	uci.set(NETWORK, name, 'type', '8021q');
	uci.set(NETWORK, name, 'ifname', carrier);
	uci.set(NETWORK, name, 'vid', sprintf('%d', vlan));
	uci.set(NETWORK, name, 'name', device);

	return { ok: true, section: name, device: device };
};

/**
 * Write one pool's sections.
 *
 * `accounts` is `[ { user, pass, vlan? }, ... ]` in sequence order. It is held
 * in memory for the length of this call and never written anywhere but into
 * uci; the caller is expected to have read it from a 0600 file and deleted the
 * file before getting here.
 *
 * Returns { ok, written, reason }. A failure part way through is committed
 * anyway: the sections that were written are real, netifd will dial them, and
 * the pool record covers the whole range - so `pool delete` can still remove
 * every one of them. Rolling back would mean deleting working sessions to tidy
 * up after a problem that has already been reported.
 */
export function write(one, accounts, onProgress) {
	if (length(accounts) != one.count) {
		return {
			ok: false,
			written: 0,
			reason: sprintf('the pool covers %d sequences and %d account(s) were supplied',
				one.count, length(accounts))
		};
	}

	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		return { ok: false, written: 0, reason: 'cannot open uci: ' + e };
	}

	// Every VLAN any row asks for, written once before the interfaces that use
	// it - netifd resolves `device` by name, and a name nothing defines is an
	// interface that never comes up.
	let vlans = {};
	for (let row in accounts) {
		let vlan = (type(row.vlan) == 'int' && row.vlan >= 1 && row.vlan <= 4094) ? row.vlan : one.vlan;
		if (vlan)
			vlans[sprintf('%d', vlan)] = vlan;
	}

	for (let key in vlans) {
		let made = vlanSection(uci, one.carrier, vlans[key]);
		if (!made.ok)
			return { ok: false, written: 0, reason: made.reason };
	}

	let written = 0;

	for (let index = 0; index < length(accounts); index++) {
		let row = accounts[index];
		let seq = one.seqFrom + index;
		let section = sectionName(one.prefix, seq);

		// The last gate before a credential becomes a line in a config file. It
		// names the row, never the value - the value is a password.
		if (!safeValue(row.user) || !safeValue(row.pass)) {
			uci.commit(NETWORK);
			return {
				ok: false,
				written: written,
				reason: sprintf('account row %d has a username or password with a control character in it', index + 1)
			};
		}

		let vlan = (type(row.vlan) == 'int' && row.vlan >= 1 && row.vlan <= 4094) ? row.vlan : one.vlan;
		let device = deviceFor(one.carrier, vlan);
		let table = tableFor(one.tableBase, seq);

		uci.set(NETWORK, section, 'interface');
		uci.set(NETWORK, section, 'proto', 'pppoe');
		uci.set(NETWORK, section, 'device', device);
		uci.set(NETWORK, section, 'username', row.user);
		uci.set(NETWORK, section, 'password', row.pass);
		uci.set(NETWORK, section, 'ipv6', '0');
		uci.set(NETWORK, section, 'peerdns', '0');
		uci.set(NETWORK, section, 'defaultroute', '1');
		// Its own routing table, which is what makes a session something a
		// binding rule can point at. Metric matches so that the main table
		// orders them the same way if anything ever looks there.
		uci.set(NETWORK, section, 'ip4table', sprintf('%d', table));
		uci.set(NETWORK, section, 'metric', sprintf('%d', table));

		written++;

		if (written % COMMIT_EVERY == 0) {
			uci.commit(NETWORK);
			if (onProgress)
				onProgress(written, one.count);
		}
	}

	uci.commit(NETWORK);
	notice(sprintf('pool %s: wrote %d interface(s) as %s%05d-%s%05d',
		one.id, written, one.prefix, one.seqFrom, one.prefix, one.seqTo));

	return { ok: true, written: written };
};

/**
 * Remove every section a pool owns.
 *
 * By derived name rather than by scanning for PPPoE interfaces, so a router
 * that had sessions before this package arrived keeps them. A name that is not
 * there is not an error: a pool half written by a create that failed is exactly
 * the case this has to clean up.
 */
export function remove(one) {
	let uci;
	try {
		uci = cursor();
	}
	catch (e) {
		return { ok: false, removed: 0, reason: 'cannot open uci: ' + e };
	}

	let removed = 0;

	for (let seq = one.seqFrom; seq <= one.seqTo; seq++) {
		let section = sectionName(one.prefix, seq);

		try {
			if (uci.get(NETWORK, section) === null)
				continue;

			// null is how ucode's uci reports a failure - it does not raise -
			// so counting the delete before testing it would report sections
			// gone that are still on the router.
			if (uci.delete(NETWORK, section) === null)
				continue;

			removed++;
		}
		catch (e) {
			debug('pool ' + one.id + ': ' + section + ' would not delete: ' + e);
		}

		if (removed && removed % COMMIT_EVERY == 0)
			uci.commit(NETWORK);
	}

	if (one.vlan) {
		// Only if nothing else is using it. Another pool on the same VLAN is
		// the normal case on a router with two providers on one cable.
		let shared = false;
		try {
			uci.foreach(NETWORK, 'interface', (section) => {
				if (section.device == deviceFor(one.carrier, one.vlan))
					shared = true;
			});
		}
		catch (e) {
			// Unknown means leave it. A VLAN device left behind costs nothing;
			// one removed from under a live pool costs every session on it.
			shared = true;
		}

		if (!shared) {
			try {
				uci.delete(NETWORK, sprintf('bmv%d', one.vlan));
			}
			catch (e) {
				debug('pool ' + one.id + ': the VLAN device would not delete: ' + e);
			}
		}
	}

	if (uci.commit(NETWORK) === null) {
		// Reported rather than swallowed, because of what the caller does next:
		// poolDelete forgets the pool record on a success, and the record is
		// the only thing that names these sections. Losing it while they are
		// still in /etc/config/network leaves PPPoE credentials on the router
		// that nothing can enumerate, let alone remove.
		err(sprintf('pool %s: the network configuration would not commit', one.id));
		return {
			ok: false,
			removed: removed,
			reason: 'the network configuration could not be committed, so the pool record is being kept'
		};
	}

	notice(sprintf('pool %s: removed %d interface(s)', one.id, removed));

	return { ok: true, removed: removed };
};
