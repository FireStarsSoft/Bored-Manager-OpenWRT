# bm-agent: the common ground every other Bored Manager package builds on.
#
# There is nothing to compile. The whole package is ucode source and a handful
# of files copied onto the router, which is what makes PKGARCH:=all honest: one
# .apk installs on ath79, mediatek, x86_64 and everything else, so a release
# attaches one file per package rather than one per target.
#
# PKG_VERSION has to match packages/version.json and the RELEASE constant in
# files/usr/share/ucode/bm/version.uc. `npm run packages:check` fails the build
# when the three disagree - a router reporting one version while the release
# manifest claims another is the sort of thing that is only ever discovered at
# the worst possible moment.

include $(TOPDIR)/rules.mk

PKG_NAME:=bm-agent
PKG_VERSION:=1.4.0
PKG_RELEASE:=1

PKG_MAINTAINER:=FireStarsSoft
PKG_LICENSE:=Apache-2.0

include $(INCLUDE_DIR)/package.mk

define Package/bm-agent
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Bored Manager router agent
  URL:=https://github.com/FireStarsSoft/Bored-Manager-OpenWRT
  # ucode-mod-uloop is what turns a ubus connection into a served object: the
  # publish call registers the object, and uloop is the loop that answers it.
  DEPENDS:=+ucode +ucode-mod-fs +ucode-mod-ubus +ucode-mod-uci +ucode-mod-uloop +usign
  PKGARCH:=all
endef

define Package/bm-agent/description
  The service Bored Manager talks to instead of driving the router over SSH.

  On its own it answers a version handshake and reports which Bored Manager
  features this router has installed. It is also where the parts that cannot
  work from the far end of an SSH session live: configuration snapshots, the
  commit-confirm guard that puts a change back when nobody confirms it, and the
  update engine.

  It never reaches out to the internet by itself. Every check for a new release
  happens because somebody asked for one.
endef

# Kept across an update rather than overwritten. Everything a user can edit is
# in this one file for exactly that reason; state the agent writes for itself
# goes under /etc/bm/ instead, where a package update does not look.
define Package/bm-agent/conffiles
/etc/config/bm_agent
endef

# No source tree, so the three build steps are stubs. Without the Build/Prepare
# stub the SDK looks for a tarball that does not exist.
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/bm-agent/install
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/bm_agent $(1)/etc/config/bm_agent
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/bm-agent $(1)/etc/init.d/bm-agent
	# A service of its own, not a thread inside bm-agent. That separation is the
	# safety property: the thing that puts a change back must not be stoppable
	# by the change.
	$(INSTALL_BIN) ./files/etc/init.d/bm-guard $(1)/etc/init.d/bm-guard
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) ./files/usr/sbin/bmctl $(1)/usr/sbin/bmctl
	# Entry points: read by ucode, never executed directly, so 0644 is right.
	$(INSTALL_DIR) $(1)/usr/share/bm
	$(INSTALL_DATA) ./files/usr/share/bm/*.uc $(1)/usr/share/bm/
	# The guard countdown, which procd runs as `sh <file>` - so it needs to be
	# readable rather than executable, the same as the entry points above.
	$(INSTALL_DATA) ./files/usr/share/bm/guard-timer.sh $(1)/usr/share/bm/guard-timer.sh
	# Library modules, on ucode's default search path as `bm.<name>`.
	$(INSTALL_DIR) $(1)/usr/share/ucode/bm
	$(INSTALL_DATA) ./files/usr/share/ucode/bm/*.uc $(1)/usr/share/ucode/bm/
	# Where every other Bored Manager package declares itself. Created here so
	# that a router with only the agent still has somewhere to read, and reads
	# an empty list rather than failing to read at all.
	$(INSTALL_DIR) $(1)/usr/share/bm/features
	# The migration chain. Empty at schema 1 and read by directory listing, so a
	# later release adds a step by shipping one more file here.
	$(INSTALL_DIR) $(1)/usr/share/bm/migrations
	$(if $(wildcard ./files/usr/share/bm/migrations/*.uc),\
		$(INSTALL_DATA) ./files/usr/share/bm/migrations/*.uc $(1)/usr/share/bm/migrations/)
	# Public keys only. A checkout with none installs none, and a router with no
	# key refuses a manifest fetched over the network - which is the correct
	# answer rather than a missing feature. See the README in that folder.
	$(INSTALL_DIR) $(1)/usr/share/bm/keys
	$(if $(wildcard ./files/usr/share/bm/keys/*.pub),\
		$(INSTALL_DATA) ./files/usr/share/bm/keys/*.pub $(1)/usr/share/bm/keys/)
endef

# What OpenWrt has already done before this runs, and what is therefore left.
#
# In apk mode the build wraps this body (include/package-pack.mk) as:
#
#   add_group_and_user; default_postinst; <this file, shebang stripped>
#
# and `default_postinst` (package/base-files/.../lib/functions.sh) ends by
# running `enable` and then `start` for every /etc/init.d/ file the package
# ships. So both services are already enabled and already started by the time
# the first line below executes, and repeating either would be noise.
#
# Two things are left, and both matter:
#
# Migrate. The service refuses to run against data written at a schema it does
# not understand, so on a router that needs a migration it has just refused and
# said so in syslog. Running the migration here is what turns that into a
# working router; the restart below is what picks it up.
#
# Restart, deferred. `default_postinst` calls `start`, and procd's `start` on a
# service already running with identical parameters does nothing - which on an
# upgrade leaves the daemon executing the code apk has just replaced while
# `bmctl version` reports the new one. Only a restart loads the new files.
#
# It is deferred and detached because of who may be calling. An update taken
# from the router - `bmctl update`, or `ubus call bm.agent update_apply` - runs
# `apk add` from inside this very service, so restarting it before it has
# answered would look to the caller exactly like the update killing the router.
# Three seconds is long enough for apk to finish and the reply to go out, and
# short enough that nobody watching notices the gap.
#
# A failed migration deliberately does not fail the install: apk has already
# unpacked the files, so a non-zero exit leaves the package half recorded and
# nothing better on the router. The service refusing to start and saying why is
# a state somebody can act on, and `bmctl schema` is what reports it.
define Package/bm-agent/postinst
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
/usr/sbin/bmctl migrate || echo "bm-agent: migration did not finish - run 'bmctl schema' to see why" >&2
(sleep 3; /etc/init.d/bm-agent restart) >/dev/null 2>&1 &
exit 0
endef

# Every package here has to take back what it put on the router. The agent adds
# no rules and no hooks, so there is very little - but the rule is the
# package's, not the module's: `apk del bm-agent` at a router shell has to leave
# the same router behind as pressing Uninstall in the app.
#
# Stopping and disabling both services is not here because `default_prerm` has
# already done it, immediately above this body and for every /etc/init.d/ file
# the package ships. It also skips the `disable` when PKG_UPGRADE is set, which
# is the behaviour an upgrade needs and the reason repeating it by hand here
# would be wrong rather than merely redundant: an unconditional `disable` would
# take a router's agent off the boot sequence every time it was updated.
#
# Configuration and /etc/bm/ deliberately stay. Reinstalling then comes back to
# the same router rather than a blank one; wiping them is a separate, explicit
# choice offered by the module's uninstall dialog.
define Package/bm-agent/prerm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
# An armed guard is dropped, not fired. Uninstalling is a deliberate act, and
# reloading somebody's network in the middle of one - because a countdown they
# had forgotten about ran out - is a surprise, not a safety net. `forget` says
# that and only that; `confirm` would have the same effect today and read as a
# promise that the change was checked. The snapshot stays under /etc/bm/, so the
# way back is still there.
/usr/sbin/bmctl config forget >/dev/null 2>&1 || true
exit 0
endef

$(eval $(call BuildPackage,bm-agent))
