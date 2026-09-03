#!/bin/bash
# The one thing that cannot be done over ssh: getting ssh working.
#
# A fresh OpenWrt image has no root password and no authorized key. Driving the
# serial console to fix that means one keystroke per monitor call, which is
# unusable for a hundred-character public key - so the configuration is written
# into the image's own filesystem before it boots, as a `uci-defaults` script.
# OpenWrt runs those once on first boot and deletes them, which is exactly the
# shape wanted here.
#
# Run with the VM stopped. `up.sh` calls it before starting the VM.
#
# What it sets: a generated root password (written to rig/.secrets and typed
# nowhere), the rig's public key, a LAN address with room for a thousand leases,
# and ssh and http reachable from the host-forwarded WAN side.

. "$(dirname "$0")/lib.sh"

IMAGE="$WORK/openwrt.img"
STAMP="$WORK/.image-seeded"
MNT="$WORK/mnt"

[ -f "$IMAGE" ] || die "no image at $IMAGE"
[ -f "$STAMP" ] && { log "the image is already seeded"; exit 0; }

if [ -f "$WORK/qemu.pid" ] && kill -0 "$(cat "$WORK/qemu.pid" 2>/dev/null)" 2>/dev/null; then
	die "the VM is running - stop it before seeding the image"
fi

make_keys_if_missing() {
	[ -f "$SECRETS/id_rig" ] && return 0
	mkdir -p "$SECRETS"
	chmod 700 "$SECRETS"
	ssh-keygen -q -t ed25519 -N '' -C 'bm rig' -f "$SECRETS/id_rig"
	openssl rand -base64 18 > "$SECRETS/root-password"
	chmod 600 "$SECRETS/id_rig" "$SECRETS/root-password"
}

make_keys_if_missing

PASSWORD="$(cat "$SECRETS/root-password")"
PUBKEY="$(cat "$SECRETS/id_rig.pub")"

log "seeding the image with the rig's key and LAN"

LOOP="$(sudo losetup --find --show --partscan "$IMAGE")"
[ -n "$LOOP" ] || die "could not attach the image to a loop device"

cleanup() {
	sudo umount "$MNT" 2>/dev/null || :
	sudo losetup -d "$LOOP" 2>/dev/null || :
}
trap cleanup EXIT

# The combined image is boot + rootfs; the second partition is the one with
# /etc on it.
ROOT="${LOOP}p2"
[ -b "$ROOT" ] || die "no second partition on $LOOP - is this the combined image?"

mkdir -p "$MNT"
sudo mount "$ROOT" "$MNT"

sudo mkdir -p "$MNT/etc/uci-defaults" "$MNT/etc/dropbear"

sudo tee "$MNT/etc/dropbear/authorized_keys" >/dev/null <<EOF
$PUBKEY
EOF
sudo chmod 600 "$MNT/etc/dropbear/authorized_keys"

# uci-defaults runs once, as root, with uci available, and is deleted after.
sudo tee "$MNT/etc/uci-defaults/99-bm-rig" >/dev/null <<EOF
#!/bin/sh
# Written by the Bored Manager rig. Runs once, then deletes itself.

# The LAN the five hundred clients arrive on, with a lease ceiling above them
# and a range wide enough to hand every one an address.
uci -q set network.lan.ipaddr='10.10.0.1'
uci -q set network.lan.netmask='255.255.252.0'
uci -q set dhcp.lan.start='10'
uci -q set dhcp.lan.limit='1000'
uci -q set dhcp.lan.leasetime='12h'
uci -q set dhcp.@dnsmasq[0].dhcpleasemax='1500'

# The carrier the pool dials on. No address: PPPoE does not need one, and an
# address here would make it look like a network the router serves.
uci -q set network.bmcarrier=interface
uci -q set network.bmcarrier.device='eth2'
uci -q set network.bmcarrier.proto='none'
uci -q set network.bmcarrier.auto='1'

# ssh and http from the WAN side, which on this VM is a host-forwarded port and
# not a network anybody else is on.
uci -q add firewall rule >/dev/null
uci -q set firewall.@rule[-1].name='bmr-ssh'
uci -q set firewall.@rule[-1].src='wan'
uci -q set firewall.@rule[-1].proto='tcp'
uci -q set firewall.@rule[-1].dest_port='22'
uci -q set firewall.@rule[-1].target='ACCEPT'

uci -q add firewall rule >/dev/null
uci -q set firewall.@rule[-1].name='bmr-http'
uci -q set firewall.@rule[-1].src='wan'
uci -q set firewall.@rule[-1].proto='tcp'
uci -q set firewall.@rule[-1].dest_port='80'
uci -q set firewall.@rule[-1].target='ACCEPT'

uci commit

# Set the root password without a terminal, which is what makes LuCI let anyone
# in at all: it refuses every login while the account has none.
printf '%s\n%s\n' '$PASSWORD' '$PASSWORD' | passwd root >/dev/null 2>&1

exit 0
EOF

sudo chmod 755 "$MNT/etc/uci-defaults/99-bm-rig"

sync
cleanup
trap - EXIT

touch "$STAMP"
log "the image is seeded; the VM will apply it on its first boot"
