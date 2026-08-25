// Who is on the LAN, from the two places that know.
//
// dnsmasq tells this package twice, and both matter:
//
//   the hook   /etc/hotplug.d/dhcp/ fires the moment a lease is written, which
//              is what makes a client bound before it has finished asking
//   the file   /tmp/dhcp.leases is the whole truth, read on the reconcile pass
//
// The hook alone would drift: a lease that expired while the daemon was
// stopped, a dnsmasq restart, a router that lost power mid-evening. The file
// alone would be a poll. Together, an event moves one client in milliseconds
// and the file is what keeps the answer honest.

import { readfile } from 'fs';

// Where dnsmasq keeps them unless somebody moved it. `option leasefile` in
// /etc/config/dhcp can, and if it has, the file read simply finds nothing and
// the hook carries the whole load - which works, and is why this is a constant
// rather than another thing to read and get wrong.
export const LEASE_FILE = '/tmp/dhcp.leases';

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IPV4 = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/;

/** Lower case, or '' for anything that is not a MAC address. */
export function normalizeMac(value) {
	if (type(value) != 'string')
		return '';

	let text = lc(trim(value));
	return match(text, MAC) ? text : '';
};

export function validIp(value) {
	if (type(value) != 'string')
		return false;

	let parts = match(trim(value), IPV4);
	if (!parts)
		return false;

	for (let i = 1; i <= 4; i++) {
		if (int(parts[i]) > 255)
			return false;
	}

	return true;
};

/**
 * Every lease in the file, newest-wins per MAC.
 *
 * dnsmasq can briefly hold two rows for one MAC while a client renews onto a
 * different address. The later expiry is the live one; file order breaks a tie,
 * which is the same rule the module's own reconciler uses so that both sides
 * agree about which address a client is on.
 *
 * Null when the file could not be read at all, which the caller must treat as
 * "no information" rather than "nobody is here" - the second would unbind every
 * client on the LAN because a file was briefly missing during a dnsmasq restart.
 */
export function fromFile() {
	let text = readfile(LEASE_FILE);
	if (type(text) != 'string')
		return null;

	let out = {};
	let order = 0;

	for (let line in split(text, '\n')) {
		let fields = split(trim(line), /[ \t]+/);
		if (length(fields) < 4)
			continue;

		let mac = normalizeMac(fields[1]);
		if (!length(mac) || !validIp(fields[2]))
			continue;

		if (!match(fields[0], /^[0-9]+$/))
			continue;

		let expires = int(fields[0]);
		let previous = out[mac];

		// 0 means "never", which sorts above every real expiry rather than
		// below it - a static lease is the most current thing there is.
		let rank = (expires == 0) ? 0x7fffffff : expires;
		let previousRank = previous ? ((previous.expires == 0) ? 0x7fffffff : previous.expires) : -1;

		if (previous && (rank < previousRank || (rank == previousRank && order < previous.order)))
			continue;

		out[mac] = {
			mac: mac,
			ip: fields[2],
			host: (fields[3] == '*') ? '' : substr(fields[3], 0, 253),
			expires: expires,
			order: order
		};

		order++;
	}

	return out;
};

/**
 * One lease event from the hook, normalised, or null if it is not usable.
 *
 * `remove` carries no address worth keeping - dnsmasq sends the one being
 * released - so it comes through as a MAC and an action and nothing else. What
 * happens next is the engine's decision, not this file's: a client that has
 * gone still holds its WAN for the release grace, because most of the time it
 * is a laptop closing its lid rather than one leaving for good.
 */
export function fromEvent(args) {
	if (type(args) != 'object')
		return null;

	let mac = normalizeMac(args.mac);
	if (!length(mac))
		return null;

	let action = type(args.action) == 'string' ? args.action : '';
	if (!(action in [ 'add', 'update', 'remove' ]))
		return null;

	let ip = (type(args.ip) == 'string' && validIp(args.ip)) ? args.ip : '';

	// A hostname is whatever the client said it was, so it is cut to something
	// that cannot fill a log line or a table cell. Nothing is ever decided from
	// it; it is there so a person reading the table knows whose laptop this is.
	let host = type(args.host) == 'string' ? substr(trim(args.host), 0, 63) : '';

	return { mac: mac, ip: ip, host: host, action: action };
};
