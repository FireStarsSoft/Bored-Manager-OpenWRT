#!/bin/bash
# Stand the rig up: two bridges, 500 VLANs, a PPPoE server, 500 DHCP clients in
# their own namespaces, and an OpenWrt VM with the three packages on it.
#
# Everything it creates is named `bmr-`. It writes a baseline first, so
# `down.sh` can prove the machine was left as it was found.
#
#   rig/up.sh                 the whole thing
#   rig/up.sh --no-clients    the VM and the sessions, no DHCP clients
#   rig/up.sh --vm-only       just the VM
#
# Times, on a 28-core machine with the downloads already cached: apt 1 min, the
# image 1, accel-ppp 4, the SDK and the four packages 25, the VM boot 2, the
# sessions 3, the clients 3.

. "$(dirname "$0")/lib.sh"

WANT_CLIENTS=1
WANT_SESSIONS=1

for arg in "$@"; do
	case "$arg" in
		--no-clients) WANT_CLIENTS=0 ;;
		--vm-only) WANT_CLIENTS=0; WANT_SESSIONS=0 ;;
		*) die "unknown option: $arg" ;;
	esac
done

mkdir -p "$WORK" "$OUT" "$SECRETS"
chmod 700 "$SECRETS"

[ -f "$WORK/baseline.links" ] || baseline

# --------------------------------------------------------------------- apt

APT_WANTED="qemu-system-x86 qemu-utils busybox-static iproute2 bridge-utils zstd \
build-essential cmake libpcre2-dev libssl-dev libnl-3-dev libnl-genl-3-dev \
gawk gettext unzip file python3 python3-distutils-extra rsync"

install_packages() {
	local missing=""

	for one in $APT_WANTED; do
		dpkg -s "$one" >/dev/null 2>&1 || missing="$missing $one"
	done

	if [ -z "$missing" ]; then
		log "every apt package the rig needs is already installed"
		: > "$WORK/installed.txt"
		return
	fi

	log "installing:$missing"
	sudo apt-get update -qq
	# shellcheck disable=SC2086
	sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing

	# What the rig added, so `down.sh --purge-apt` removes exactly that and
	# nothing that was already here.
	printf '%s\n' $missing > "$WORK/installed.txt"
}

# ------------------------------------------------------------------ downloads

fetch() {
	local url="$1" into="$2"

	[ -s "$into" ] && return 0
	log "downloading $(basename "$into")"
	curl -fL --retry 3 -o "$into.part" "$url"
	mv "$into.part" "$into"
}

fetch_image() {
	mkdir -p "$WORK/dl"
	fetch "$MIRROR/${IMAGE_NAME}.gz" "$WORK/dl/${IMAGE_NAME}.gz"
	fetch "$MIRROR/sha256sums" "$WORK/dl/sha256sums"

	( cd "$WORK/dl" && grep " ${IMAGE_NAME}.gz\$" sha256sums | sha256sum -c - ) \
		|| die "the image does not match the published sha256"

	if [ ! -s "$WORK/openwrt.img" ]; then
		gzip -dc "$WORK/dl/${IMAGE_NAME}.gz" > "$WORK/openwrt.img"
		qemu-img resize -f raw "$WORK/openwrt.img" +512M
	fi
}

# ------------------------------------------------------------------- accel-ppp

build_accel() {
	[ -x "$WORK/accel-ppp/build/accel-pppd/accel-pppd" ] && return 0

	log "building accel-ppp"
	mkdir -p "$WORK"
	[ -d "$WORK/accel-ppp/.git" ] || git clone -q --depth 1 --branch 1.14.0 \
		https://github.com/accel-ppp/accel-ppp.git "$WORK/accel-ppp" \
		|| git clone -q --depth 1 https://github.com/accel-ppp/accel-ppp.git "$WORK/accel-ppp"

	mkdir -p "$WORK/accel-ppp/build"
	( cd "$WORK/accel-ppp/build" && cmake -DBUILD_IPOE_DRIVER=FALSE \
		-DBUILD_VLAN_MON_DRIVER=FALSE -DRADIUS=FALSE -DSHAPER=FALSE \
		-DCMAKE_BUILD_TYPE=Release .. >/dev/null && make -j"$(nproc)" >/dev/null )

	[ -x "$WORK/accel-ppp/build/accel-pppd/accel-pppd" ] \
		|| die "accel-ppp did not build"
}

# -------------------------------------------------------------------- topology

make_bridges() {
	for br in "$LAN_BR" "$WAN_BR"; do
		guard_name "$br"
		ip link show "$br" >/dev/null 2>&1 && continue
		sudo ip link add name "$br" type bridge
		sudo ip link set "$br" up
	done

	log "bridges up: $LAN_BR, $WAN_BR"
}

make_vlans() {
	local made=0 vlan

	for i in $(seq 0 $((SESSIONS - 1))); do
		vlan=$((VLAN_FROM + i))
		guard_name "$WAN_BR.$vlan"
		ip link show "$WAN_BR.$vlan" >/dev/null 2>&1 && continue
		sudo ip link add link "$WAN_BR" name "$WAN_BR.$vlan" type vlan id "$vlan"
		sudo ip link set "$WAN_BR.$vlan" up
		made=$((made + 1))
	done

	log "carrier VLANs: $made created, $SESSIONS total"
}

make_taps() {
	local tap

	for pair in "bmr-tap0 $LAN_BR" "bmr-tap1 $WAN_BR"; do
		set -- $pair
		tap="$1"
		guard_name "$tap"
		ip link show "$tap" >/dev/null 2>&1 && continue
		sudo ip tuntap add dev "$tap" mode tap user "$(id -u -n)"
		sudo ip link set "$tap" master "$2"
		sudo ip link set "$tap" up
	done
}

make_clients() {
	local ns veth made=0

	for i in $(seq 1 "$CLIENTS"); do
		ns=$(printf 'bmr-c%03d' "$i")
		veth=$(printf 'bmr-v%03d' "$i")
		guard_name "$ns"
		guard_name "$veth"

		ip netns list 2>/dev/null | grep -qx "$ns" && continue

		sudo ip netns add "$ns"
		sudo ip link add "$veth" type veth peer name eth0 netns "$ns"
		sudo ip link set "$veth" master "$LAN_BR"
		sudo ip link set "$veth" up
		sudo ip netns exec "$ns" ip link set lo up
		sudo ip netns exec "$ns" ip link set eth0 up
		made=$((made + 1))

		# In batches, so five hundred DHCP DISCOVERs do not arrive in the same
		# millisecond - which is a test of dnsmasq's backlog rather than of
		# anything this release changed.
		if [ $((i % 50)) -eq 0 ]; then sleep 2; fi
	done

	log "client namespaces: $made created, $CLIENTS total"
}

dial_clients() {
	local ns

	log "asking $CLIENTS clients for a lease"

	for i in $(seq 1 "$CLIENTS"); do
		ns=$(printf 'bmr-c%03d' "$i")
		sudo ip netns exec "$ns" pgrep -f "udhcpc -i eth0" >/dev/null 2>&1 && continue
		sudo ip netns exec "$ns" busybox udhcpc -i eth0 -b -q -t 4 -T 3 \
			-x "hostname:$(printf 'client%03d' "$i")" >/dev/null 2>&1 || :
		if [ $((i % 50)) -eq 0 ]; then sleep 2; fi
	done
}

# ------------------------------------------------------------------- accel-ppp

start_accel() {
	pgrep -f 'accel-pppd.*bmr' >/dev/null 2>&1 && { log "accel-ppp is already running"; return; }

	sed -e "s|@CHAP@|$WORK/chap-secrets|" -e "s|@WAN@|$WAN_BR|" \
		"$RIG_DIR/accel-ppp.conf.tmpl" > "$WORK/accel-ppp.conf"

	printf 'rig\t*\trigpass\t*\n' > "$WORK/chap-secrets"
	chmod 600 "$WORK/chap-secrets"

	sudo "$WORK/accel-ppp/build/accel-pppd/accel-pppd" \
		-d -c "$WORK/accel-ppp.conf" -p "$WORK/accel-pppd.pid" \
		>> "$WORK/accel-pppd.log" 2>&1

	sleep 3
	pgrep -f 'accel-pppd' >/dev/null 2>&1 || die "accel-ppp did not start - see $WORK/accel-pppd.log"
	log "accel-ppp is listening on ${SESSIONS} VLANs of $WAN_BR"
}

# -------------------------------------------------------------------- the VM

make_keys() {
	[ -f "$SECRETS/id_rig" ] && return 0
	ssh-keygen -q -t ed25519 -N '' -C 'bm rig' -f "$SECRETS/id_rig"
	openssl rand -base64 18 > "$SECRETS/root-password"
	chmod 600 "$SECRETS/id_rig" "$SECRETS/root-password"
}

start_vm() {
	if [ -f "$WORK/qemu.pid" ] && kill -0 "$(cat "$WORK/qemu.pid")" 2>/dev/null; then
		log "the VM is already running"
		return
	fi

	log "starting the VM: ${VM_CPUS} vCPU, ${VM_MEM} MB"

	qemu-system-x86_64 -enable-kvm -cpu host -smp "$VM_CPUS" -m "$VM_MEM" \
		-drive file="$WORK/openwrt.img",if=virtio,format=raw \
		-netdev tap,id=lan,ifname=bmr-tap0,script=no,downscript=no \
		-device virtio-net-pci,netdev=lan \
		-netdev user,id=wan,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22,hostfwd=tcp:127.0.0.1:${HTTP_PORT}-:80 \
		-device virtio-net-pci,netdev=wan \
		-netdev tap,id=carrier,ifname=bmr-tap1,script=no,downscript=no \
		-device virtio-net-pci,netdev=carrier \
		-nographic -serial "file:$WORK/console.log" \
		-monitor "unix:$WORK/qemu.sock,server,nowait" \
		-pidfile "$WORK/qemu.pid" -daemonize

	sleep 20
}

# ------------------------------------------------------------------- the parts

install_packages
fetch_image
make_keys
# Before the VM starts: a fresh image has no root password and no key, and the
# only way in without one is to write into its filesystem while it is stopped.
"$RIG_DIR/vm-firstboot.sh"
make_bridges
make_taps
[ "$WANT_SESSIONS" -eq 1 ] && { make_vlans; build_accel; }
start_vm

log "waiting for the VM to answer on 127.0.0.1:${SSH_PORT}"
wait_for_vm 240 || die "the VM never answered on ssh - see $WORK/console.log"

log "the VM answers. Installing the packages."
"$RIG_DIR/build-packages.sh"

[ "$WANT_SESSIONS" -eq 1 ] && start_accel
[ "$WANT_CLIENTS" -eq 1 ] && { make_clients; dial_clients; }

cat <<EOF

  The rig is up.

    LuCI      http://localhost:${HTTP_PORT}      root / $(cat "$SECRETS/root-password")
    ssh       127.0.0.1 port ${SSH_PORT}, key $(wslpath -w "$SECRETS/id_rig" 2>/dev/null || echo "$SECRETS/id_rig")
    console   $WORK/console.log

  rig/verify.sh runs the matrix. rig/down.sh takes it all down and proves the
  machine is as it was found.

EOF
