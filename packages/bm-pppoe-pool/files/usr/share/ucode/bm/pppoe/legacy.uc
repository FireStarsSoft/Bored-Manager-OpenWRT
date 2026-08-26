// Deleting pools the old model wrote. Nothing else about them works any more.
//
// The old model numbered sessions: pool `ppp` sequence 7 was section
// `ppp00007`, five digits always, with one shared `config device 'bmv<vid>'`
// per VLAN refcounted between pools. This build neither creates nor manages
// that shape - a v2 record is a member list, not a range - but routers that
// ran the old model still hold such pools, and the one thing owed to them is
// a delete that removes exactly what the old create added.
//
// So this file is the old removal logic, moved whole and kept apart, so that
// dropping the legacy path one release is deleting one file. `info` lists
// these pools under `legacy`; every method except pool_delete refuses them
// with the same sentence: delete and recreate.

import { cursor } from 'uci';

import { debug, err, notice } from 'bm.log';

import { dropMemberships } from 'bm.pppoe.firewall';

const NETWORK = 'network';

// The old five-digit spelling. vlanOfSection() in config.uc deliberately does
// not match it - a leading zero is refused there - which is what keeps the v2
// reconcilers' hands off these sections.
function sectionName(prefix, seq) {
	return sprintf('%s%05d', prefix, seq);
};

/** `eth1` and VLAN 101 -> `eth1.101`, or just `eth1`. The old device rule. */
function deviceFor(carrier, vlan) {
	return (type(vlan) == 'int' && vlan >= 1 && vlan <= 4094)
		? sprintf('%s.%d', carrier, vlan)
		: carrier;
};

/** Every section name a legacy pool owns, in sequence order. */
export function sectionsOf(one) {
	let out = [];
	for (let seq = one.seqFrom; seq <= one.seqTo; seq++)
		push(out, sectionName(one.prefix, seq));
	return out;
};

/**
 * Remove every network section a legacy pool owns, and its shared VLAN
 * device when no other interface still dials over it.
 *
 * By derived name rather than by scanning for PPPoE interfaces, so a router
 * that had sessions before this package arrived keeps them. A name that is
 * not there is not an error: a pool half written by a create that failed is
 * exactly the case this has to clean up.
 */
function removeSections(one) {
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
			debug('legacy pool ' + one.id + ': ' + section + ' would not delete: ' + e);
		}
	}

	if (one.vlan) {
		// Only if nothing else is using it. Another pool on the same VLAN was
		// the normal case on a router with two providers on one cable.
		let shared = false;
		try {
			uci.foreach(NETWORK, 'interface', (section) => {
				if (section.device == deviceFor(one.carrier, one.vlan))
					shared = true;
			});
		}
		catch (e) {
			// Unknown means leave it. A VLAN device left behind costs
			// nothing; one removed from under a live pool costs every
			// session on it.
			shared = true;
		}

		if (!shared) {
			try {
				uci.delete(NETWORK, sprintf('bmv%d', one.vlan));
			}
			catch (e) {
				debug('legacy pool ' + one.id + ': the VLAN device would not delete: ' + e);
			}
		}
	}

	if (uci.commit(NETWORK) === null) {
		// Reported rather than swallowed, because of what the caller does
		// next: the record is forgotten on success, and the record is the
		// only thing that names these sections.
		err(sprintf('legacy pool %s: the network configuration would not commit', one.id));
		return {
			ok: false,
			removed: removed,
			reason: 'the network configuration could not be committed, so the pool record is being kept'
		};
	}

	notice(sprintf('legacy pool %s: removed %d interface(s)', one.id, removed));

	return { ok: true, removed: removed };
};

/**
 * The whole legacy delete: network sections, then whatever zone memberships
 * the module of that era wrote for them. The record itself is the caller's
 * to forget, after this returns ok - the same order as a v2 delete.
 */
export function remove(one) {
	let gone = removeSections(one);
	if (!gone.ok)
		return gone;

	// The old module kept zone membership as an explicit network list too;
	// its entries are these exact names. A zone emptied by this stays - the
	// old model shared zones in ways only the module understood, and a
	// leftover empty zone is rubbish, not a hazard.
	let membership = dropMemberships(sectionsOf(one));
	if (!membership.ok)
		debug('legacy pool ' + one.id + ': ' + membership.reason);

	gone.firewallChanged = membership.ok ? membership.changed : false;

	return gone;
};
