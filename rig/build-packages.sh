#!/bin/bash
# Build the four router packages against the SDK the VM's own image came from,
# and install them on it.
#
# The steps are the ones `.github/workflows/packages.yml` runs, with the same
# SDK version as the image - which is the point of doing it here at all: a
# package built against a different release is a package whose ucode may not
# load, and the CI's own build is the thing being reproduced.

. "$(dirname "$0")/lib.sh"

REPO="$(cd "$RIG_DIR/.." && pwd)"
SDK="$BUILD/sdk"

# The feed is a copy rather than a symlink into the repo, for the same reason
# the SDK is not under it: a `src-link` pointing at `/mnt/f` puts every package
# source back on the case-insensitive filesystem the build refuses to run on.
FEED="$BUILD/packages"

fetch_sdk() {
	mkdir -p "$BUILD" "$WORK/dl"
	[ -d "$SDK" ] && return 0

	local tarball="$WORK/dl/${SDK_NAME}.tar.zst"

	if [ ! -s "$tarball" ]; then
		log "downloading the SDK (about 270 MB)"
		curl -fL --retry 3 -o "$tarball.part" "$MIRROR/${SDK_NAME}.tar.zst"
		mv "$tarball.part" "$tarball"
	fi

	log "unpacking the SDK onto $BUILD"
	tar -I zstd -xf "$tarball" -C "$BUILD"
	mv "$BUILD/$SDK_NAME" "$SDK"
	[ -d "$SDK" ] || die "the SDK did not unpack to $SDK"
}

# The sources the feed builds, copied out of the repo every time so a build is
# never against something stale. rsync rather than a symlink: see `FEED`.
sync_feed() {
	mkdir -p "$FEED"
	rsync -a --delete "$REPO/packages/" "$FEED/"
}

prepare_feeds() {
	sync_feed
	[ -f "$SDK/.bm-feeds" ] && return 0

	log "setting up the feeds"
	(
		cd "$SDK"
		cp feeds.conf.default feeds.conf
		echo "src-link bm $FEED" >> feeds.conf
		./scripts/feeds update -a >/dev/null 2>&1 || ./scripts/feeds update -a
		./scripts/feeds install -a -p bm >/dev/null 2>&1 || :
		./scripts/feeds install luci-base >/dev/null 2>&1 || :
		touch .bm-feeds
	)
}

build() {
	log "building the four packages (this is the slow step)"
	(
		cd "$SDK"
		make defconfig >/dev/null

		for one in bm-agent bm-wanbind bm-pppoe-pool luci-app-bm; do
			echo "CONFIG_PACKAGE_${one}=m" >> .config
		done

		make defconfig >/dev/null
		make package/bm-agent/compile package/bm-wanbind/compile \
			package/bm-pppoe-pool/compile package/luci-app-bm/compile \
			-j"$(nproc)" > "$BUILD/build.log" 2>&1 \
			|| die "the build failed - the tail of $BUILD/build.log says why"
	)

	rm -f "$OUT"/*.apk 2>/dev/null || :
	mkdir -p "$OUT"
	find "$SDK/bin" -name 'bm-*.apk' -o -name 'luci-app-bm*.apk' -o -name 'luci-i18n-bm*.apk' \
		| while read -r one; do cp "$one" "$OUT/"; done

	log "built: $(ls "$OUT" | tr '\n' ' ')"
}

install_on_vm() {
	vm_up || die "the VM is not answering on ssh"

	log "installing ppp and the kernel module the pool needs"
	ssh_vm 'apk update >/dev/null 2>&1; apk add ppp ppp-mod-pppoe kmod-pppoe >/dev/null 2>&1' || :

	log "copying the packages onto the VM"
	ssh_vm 'rm -f /tmp/bm-*.apk /tmp/luci-*.apk'
	scp_vm "$OUT"/*.apk root@127.0.0.1:/tmp/

	# One `apk add`, because the two daemons declare a version dependency on
	# bm-agent and apk refuses a new daemon beside an old agent rather than
	# pulling one - the agent is in no repository.
	log "installing them, all in one command"
	ssh_vm 'apk add --allow-untrusted /tmp/bm-*.apk /tmp/luci-*.apk' \
		|| die "apk refused the packages - the output above says why"

	ssh_vm 'service bm-agent restart >/dev/null 2>&1; service bm-wanbind restart >/dev/null 2>&1; service bm-pppoe restart >/dev/null 2>&1; sleep 3' || :

	log "installed: $(ssh_vm 'ubus call bm.agent info 2>/dev/null | tr -d "\n" | head -c 200')"
}

fetch_sdk
prepare_feeds
build
install_on_vm
