# Shared by every rig script: names, guards, logging, and the baseline.
#
# The one rule this file exists to enforce: the rig runs inside WSL, and this
# WSL shares its network namespace with the machine it is on. `eth1` here is a
# real Wi-Fi adapter on a real network. So every interface, bridge, namespace
# and tap the rig creates is named `bmr-`, `guard_name` refuses anything else,
# and nothing is ever enslaved, deleted or reconfigured unless its name starts
# that way.
#
# `baseline` writes down what the machine looked like before anything was
# created. `down.sh` diffs against it and exits non-zero if the two differ,
# which is the only honest way to say the machine is as it was found.

set -eu

RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
WORK="$RIG_DIR/work"
OUT="$RIG_DIR/out"
SECRETS="$RIG_DIR/.secrets"

PREFIX="bmr-"
LAN_BR="bmr-lan"
WAN_BR="bmr-wan"
CLIENTS="${RIG_CLIENTS:-500}"
SESSIONS="${RIG_SESSIONS:-500}"
VLAN_FROM=101
VM_MEM="${RIG_VM_MEM:-2048}"
VM_CPUS="${RIG_VM_CPUS:-2}"
SSH_PORT=2222
HTTP_PORT=8080

OPENWRT_VERSION="${RIG_OPENWRT:-25.12.5}"
OPENWRT_TARGET="x86/64"
IMAGE_NAME="openwrt-${OPENWRT_VERSION}-x86-64-generic-ext4-combined.img"
SDK_NAME="openwrt-sdk-${OPENWRT_VERSION}-x86-64_gcc-14.3.0_musl.Linux-x86_64"
MIRROR="https://downloads.openwrt.org/releases/${OPENWRT_VERSION}/targets/x86/64"

log() { printf '\033[36m==\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# Every name the rig is allowed to touch. A name that is not the rig's is a
# name belonging to the machine this is running on, and the machine this is
# running on is somebody's actual computer.
guard_name() {
	case "$1" in
		"$PREFIX"*) ;;
		*) die "refusing to touch '$1': the rig only ever creates and removes names starting with '$PREFIX'" ;;
	esac

	case "$1" in
		eth[0-9]*|docker*|br-[0-9a-f]*|lo|loopback*)
			die "refusing to touch '$1': that is this machine's own interface" ;;
	esac
}

need() {
	command -v "$1" >/dev/null 2>&1 || die "missing '$1' - run rig/up.sh, which installs what it needs"
}

# What the machine looked like before the rig existed.
baseline() {
	mkdir -p "$WORK"
	ip -br link | awk '{print $1}' | sort > "$WORK/baseline.links"
	ip netns list 2>/dev/null | awk '{print $1}' | sort > "$WORK/baseline.netns" || : > "$WORK/baseline.netns"
	pgrep -fa 'bmr-|accel-pppd|qemu-system' 2>/dev/null | sort > "$WORK/baseline.procs" || : > "$WORK/baseline.procs"
	log "baseline written: $(wc -l < "$WORK/baseline.links") links, $(wc -l < "$WORK/baseline.netns") namespaces"
}

# The same three lists now, against the three from before.
diff_baseline() {
	local bad=0

	[ -f "$WORK/baseline.links" ] || { warn "no baseline to compare against"; return 0; }

	ip -br link | awk '{print $1}' | sort > "$WORK/now.links"
	ip netns list 2>/dev/null | awk '{print $1}' | sort > "$WORK/now.netns" || : > "$WORK/now.netns"
	pgrep -fa 'bmr-|accel-pppd|qemu-system' 2>/dev/null | sort > "$WORK/now.procs" || : > "$WORK/now.procs"

	if ! diff -q "$WORK/baseline.links" "$WORK/now.links" >/dev/null; then
		warn "interfaces differ from the baseline:"
		diff "$WORK/baseline.links" "$WORK/now.links" >&2 || :
		bad=1
	fi

	if ! diff -q "$WORK/baseline.netns" "$WORK/now.netns" >/dev/null; then
		warn "network namespaces differ from the baseline:"
		diff "$WORK/baseline.netns" "$WORK/now.netns" >&2 || :
		bad=1
	fi

	if ! diff -q "$WORK/baseline.procs" "$WORK/now.procs" >/dev/null; then
		warn "rig processes differ from the baseline:"
		diff "$WORK/baseline.procs" "$WORK/now.procs" >&2 || :
		bad=1
	fi

	return $bad
}

ssh_vm() {
	ssh -q -p "$SSH_PORT" -i "$SECRETS/id_rig" \
		-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
		-o ConnectTimeout=10 root@127.0.0.1 "$@"
}

scp_vm() {
	scp -q -O -P "$SSH_PORT" -i "$SECRETS/id_rig" \
		-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$@"
}

vm_up() {
	ssh_vm true >/dev/null 2>&1
}

wait_for_vm() {
	local waited=0

	while [ "$waited" -lt "${1:-180}" ]; do
		if vm_up; then return 0; fi
		sleep 5
		waited=$((waited + 5))
	done

	return 1
}
