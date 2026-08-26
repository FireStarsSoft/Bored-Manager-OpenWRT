# bm-wanbind: one DHCP client, one WAN, decided on the router.
#
# The module can already do this over SSH and will keep doing it on a router
# without this package. What it cannot do from the far end of a connection is
# react to a lease in milliseconds rather than at the next poll, or write a
# thousand ip rules without a thousand round trips - which is the whole reason
# this exists.
#
# ucode only, so PKGARCH:=all: one .apk installs on ath79, mediatek, x86_64 and
# everything else.
#
# PKG_VERSION has to match packages/version.json and the RELEASE constant in
# bm-agent's version.uc; `npm run packages:check` fails the build when they
# disagree.

include $(TOPDIR)/rules.mk

PKG_NAME:=bm-wanbind
PKG_VERSION:=1.4.1
PKG_RELEASE:=1

PKG_MAINTAINER:=FireStarsSoft
PKG_LICENSE:=Apache-2.0

include $(INCLUDE_DIR)/package.mk

define Package/bm-wanbind
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Bored Manager one-to-one WAN binding
  URL:=https://github.com/FireStarsSoft/Bored-Manager-OpenWRT
  # bm-agent for the snapshot and guard machinery, and because this package
  # declares itself into its feature directory. rtnl because ip rules are
  # written over netlink rather than by forking `ip` a thousand times - the
  # difference at a thousand clients is a second against a minute.
  DEPENDS:=+bm-agent +ucode +ucode-mod-fs +ucode-mod-ubus +ucode-mod-uci +ucode-mod-uloop +ucode-mod-rtnl
  PKGARCH:=all
endef

define Package/bm-wanbind/description
  Gives every DHCP client on a LAN its own WAN, one to one, and keeps it there.

  A lease arriving is an event, not something noticed at the next poll: dnsmasq
  calls into /etc/hotplug.d/dhcp/ and the rule is written before the client has
  finished its DHCP exchange. Clients with no free WAN wait in a queue in the
  order they arrived; a WAN that fails hands its client to a free one; and a
  client the pool cannot seat is blocked by a fail-closed catch-all rather than
  quietly sent out of whichever WAN the router would have used.

  Everything it decides survives a restart and a reboot, and it reconciles
  itself against the router every thirty seconds, so a rule somebody removed by
  hand comes back rather than becoming a client with no route.
endef

define Package/bm-wanbind/conffiles
/etc/config/bm_wanbind
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/bm-wanbind/install
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/bm_wanbind $(1)/etc/config/bm_wanbind
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/bm-wanbind $(1)/etc/init.d/bm-wanbind
	# The lease hook. Its presence is also the switch: dnsmasq's init script
	# turns --dhcp-script on when any file exists in this directory, so shipping
	# it is all that is needed - no `option dhcpscript`, which only one package
	# on the router can hold at a time.
	#
	# 0644, because hotplug-call sources it (`. $$script`) rather than running
	# it - the same reason the ucode entry points below are not executable.
	$(INSTALL_DIR) $(1)/etc/hotplug.d/dhcp
	$(INSTALL_DATA) ./files/etc/hotplug.d/dhcp/30-bm-wanbind $(1)/etc/hotplug.d/dhcp/30-bm-wanbind
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) ./files/usr/sbin/bmwan $(1)/usr/sbin/bmwan
	# Entry points: read by ucode, never executed directly, so 0644 is right.
	$(INSTALL_DIR) $(1)/usr/share/bm
	$(INSTALL_DATA) ./files/usr/share/bm/*.uc $(1)/usr/share/bm/
	$(INSTALL_DIR) $(1)/usr/share/ucode/bm/wanbind
	$(INSTALL_DATA) ./files/usr/share/ucode/bm/wanbind/*.uc $(1)/usr/share/ucode/bm/wanbind/
	# How bm-agent - and through it the module - learns this router can bind.
	# A directory listing rather than a table the agent has to be taught.
	$(INSTALL_DIR) $(1)/usr/share/bm/features
	$(INSTALL_DATA) ./files/usr/share/bm/features/bm-wanbind.json $(1)/usr/share/bm/features/bm-wanbind.json
endef

# `default_postinst` has already enabled and started the service by the time
# this runs - see packages/README.md - so what is left is the two things it
# cannot know about.
#
# dnsmasq is reloaded because the hook file only takes effect when dnsmasq is
# next told to rebuild its command line: `has_handler` in its init script is
# read at start, so without this the first lease event would arrive whenever
# somebody else happened to reload it.
#
# The restart is deferred and detached for the same reason bm-agent's is: an
# install driven from the router runs apk from inside a service, and killing it
# before it has answered looks exactly like the install breaking the router.
define Package/bm-wanbind/postinst
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
/etc/init.d/dnsmasq reload >/dev/null 2>&1 || true
(sleep 3; /etc/init.d/bm-wanbind restart) >/dev/null 2>&1 &
exit 0
endef

# The rules come off here, not in the module.
#
# `apk del bm-wanbind` typed at a router shell has to leave the same router
# behind as pressing Remove in the app, and the only way to promise that is for
# the removal to do nothing the shell would not. Leaving the ip rules behind
# would be worse than never having installed: every bound client keeps a rule
# pointing at a table nothing maintains, and the fail-closed catch-all keeps
# blocking everyone else, with no service left to explain either.
#
# `default_prerm` has already stopped the service, which is what this needs:
# `bmwan flush` is its own process and would otherwise race the reconcile loop
# putting the rules straight back.
#
# The PKG_UPGRADE guard is belt and braces. apk runs pre-upgrade/post-upgrade
# on an upgrade and reaches pre-deinstall only on a real removal, so it should
# never fire - but being wrong about that would take every client's route away
# for the length of an update, and being wrong the other way costs nothing.
define Package/bm-wanbind/prerm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
[ "$$PKG_UPGRADE" = "1" ] || /usr/sbin/bmwan flush >/dev/null 2>&1 || true
exit 0
endef

# After the files are gone, so dnsmasq rebuilds its command line without the
# hook this package was providing - otherwise it keeps calling a script that is
# no longer there until something else reloads it.
define Package/bm-wanbind/postrm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
[ "$$PKG_UPGRADE" = "1" ] || /etc/init.d/dnsmasq reload >/dev/null 2>&1 || true
exit 0
endef

$(eval $(call BuildPackage,bm-wanbind))
