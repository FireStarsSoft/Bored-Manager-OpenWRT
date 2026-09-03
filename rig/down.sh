#!/bin/bash
# Take the rig down and prove the machine is as it was found.
#
#   rig/down.sh              stop everything, remove every bmr- name
#   rig/down.sh --purge      the above, plus the downloads and the build trees
#   rig/down.sh --purge-apt  the above, plus exactly the apt packages up.sh added
#
# Exits non-zero when the interfaces, namespaces or processes on this machine
# differ from the baseline `up.sh` wrote. That is the only claim worth making
# about a script that created five hundred network namespaces on somebody's
# computer, and it is checked rather than asserted.

. "$(dirname "$0")/lib.sh"

PURGE=0
PURGE_APT=0

for arg in "$@"; do
	case "$arg" in
		--purge) PURGE=1 ;;
		--purge-apt) PURGE=1; PURGE_APT=1 ;;
		*) die "unknown option: $arg" ;;
	esac
done

stop_vm() {
	[ -f "$WORK/qemu.pid" ] || return 0
	local pid
	pid="$(cat "$WORK/qemu.pid" 2>/dev/null || echo)"
	[ -n "$pid" ] || return 0

	if kill -0 "$pid" 2>/dev/null; then
		log "stopping the VM"
		kill "$pid" 2>/dev/null || :
		sleep 3
		kill -9 "$pid" 2>/dev/null || :
	fi

	rm -f "$WORK/qemu.pid" "$WORK/qemu.sock"
}

stop_accel() {
	pgrep -f accel-pppd >/dev/null 2>&1 || return 0
	log "stopping accel-ppp"
	sudo pkill -f accel-pppd || :
	sleep 2
	sudo pkill -9 -f accel-pppd 2>/dev/null || :
}

drop_clients() {
	local ns veth gone=0

	for ns in $(ip netns list 2>/dev/null | awk '{print $1}' | grep "^${PREFIX}c" || :); do
		guard_name "$ns"
		# The udhcpc inside dies with the namespace, but killing it first keeps
		# the log honest about what stopped when.
		sudo ip netns exec "$ns" pkill udhcpc 2>/dev/null || :
		sudo ip netns del "$ns" 2>/dev/null || :
		gone=$((gone + 1))
	done

	for veth in $(ip -br link | awk '{print $1}' | sed 's/@.*//' | grep "^${PREFIX}v" || :); do
		guard_name "$veth"
		sudo ip link del "$veth" 2>/dev/null || :
	done

	[ "$gone" -gt 0 ] && log "removed $gone client namespaces"
	return 0
}

drop_links() {
	local one gone=0

	# VLANs and taps before the bridges they sit on, so nothing is deleted out
	# from under something still referring to it.
	for one in $(ip -br link | awk '{print $1}' | sed 's/@.*//' | grep "^${PREFIX}" | grep -v "^${LAN_BR}\$\|^${WAN_BR}\$" || :); do
		guard_name "$one"
		sudo ip link del "$one" 2>/dev/null || :
		gone=$((gone + 1))
	done

	for one in "$WAN_BR" "$LAN_BR"; do
		ip link show "$one" >/dev/null 2>&1 || continue
		guard_name "$one"
		sudo ip link del "$one" 2>/dev/null || :
		gone=$((gone + 1))
	done

	[ "$gone" -gt 0 ] && log "removed $gone interfaces"
	return 0
}

stop_vm
stop_accel
drop_clients
drop_links

if [ "$PURGE_APT" -eq 1 ] && [ -s "$WORK/installed.txt" ]; then
	log "removing the apt packages up.sh installed, and only those"
	# shellcheck disable=SC2046
	sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq $(cat "$WORK/installed.txt")
	sudo apt-get autoremove -y -qq
fi

if [ "$PURGE" -eq 1 ]; then
	log "removing the work tree"
	KEEP_LINKS="$WORK/baseline.links"
	cp "$WORK/baseline.links" /tmp/bmr-baseline.links 2>/dev/null || :
	cp "$WORK/baseline.netns" /tmp/bmr-baseline.netns 2>/dev/null || :
	cp "$WORK/baseline.procs" /tmp/bmr-baseline.procs 2>/dev/null || :
	rm -rf "$WORK"
	mkdir -p "$WORK"
	cp /tmp/bmr-baseline.links "$WORK/baseline.links" 2>/dev/null || :
	cp /tmp/bmr-baseline.netns "$WORK/baseline.netns" 2>/dev/null || :
	cp /tmp/bmr-baseline.procs "$WORK/baseline.procs" 2>/dev/null || :
	rm -f /tmp/bmr-baseline.*
fi

if diff_baseline; then
	log "the machine is as it was found"
	exit 0
fi

die "something the rig created is still here - the lines above say what"
