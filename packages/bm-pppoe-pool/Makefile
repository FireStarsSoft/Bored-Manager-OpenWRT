# bm-pppoe-pool: a pool of PPPoE sessions, dialled and watched on the router.
#
# The module can already create one over SSH and will keep doing it on a router
# without this package. What it cannot do from the far end of a connection is
# create five thousand sections without five thousand round trips, notice a
# session dropping the moment netifd says so rather than at the next poll, or
# read a counter pass without shipping the result back over the wire.
#
# There is a third thing, and it is the reason this package handles credentials
# at all: a password written through uci from inside the daemon never becomes a
# command line. /proc/<pid>/cmdline is world-readable, and the SSH path has to
# work hard to keep passwords off it - here they simply never get there.
#
# ucode only, so PKGARCH:=all.

include $(TOPDIR)/rules.mk

PKG_NAME:=bm-pppoe-pool
PKG_VERSION:=1.4.1
PKG_RELEASE:=1

PKG_MAINTAINER:=FireStarsSoft
PKG_LICENSE:=Apache-2.0

include $(INCLUDE_DIR)/package.mk

define Package/bm-pppoe-pool
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Bored Manager PPPoE session pool
  URL:=https://github.com/FireStarsSoft/Bored-Manager-OpenWRT
  # No rtnl: this package writes no routes and no rules. It writes UCI and
  # watches netifd, which is uci and ubus.
  DEPENDS:=+bm-agent +ucode +ucode-mod-fs +ucode-mod-ubus +ucode-mod-uci +ucode-mod-uloop
  PKGARCH:=all
endef

define Package/bm-pppoe-pool/description
  Creates and watches pools of PPPoE sessions.

  A pool is a run of `config interface` sections in /etc/config/network, each
  with its own credentials and its own routing table. This package writes them
  through uci from inside the service - so a password never appears in any
  process's command line - watches netifd for every session coming up and going
  down instead of polling for it, and redials the ones that stay down.

  Removing it leaves every session exactly where it is. The sections belong to
  whoever created them, not to this package, and netifd keeps dialling them
  whether or not anything is here to watch.
endef

define Package/bm-pppoe-pool/conffiles
/etc/config/bm_pppoe
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/bm-pppoe-pool/install
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/bm_pppoe $(1)/etc/config/bm_pppoe
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/bm-pppoe $(1)/etc/init.d/bm-pppoe
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) ./files/usr/sbin/bmpppoe $(1)/usr/sbin/bmpppoe
	# Entry points: read by ucode, never executed directly, so 0644 is right.
	$(INSTALL_DIR) $(1)/usr/share/bm
	$(INSTALL_DATA) ./files/usr/share/bm/*.uc $(1)/usr/share/bm/
	$(INSTALL_DIR) $(1)/usr/share/ucode/bm/pppoe
	$(INSTALL_DATA) ./files/usr/share/ucode/bm/pppoe/*.uc $(1)/usr/share/ucode/bm/pppoe/
	# How bm-agent - and through it the module - learns this router can dial.
	$(INSTALL_DIR) $(1)/usr/share/bm/features
	$(INSTALL_DATA) ./files/usr/share/bm/features/bm-pppoe-pool.json $(1)/usr/share/bm/features/bm-pppoe-pool.json
endef

# `default_postinst` has already enabled and started the service - see
# packages/README.md - so the only thing left is the restart that makes an
# upgrade actually run the new code, deferred and detached for the same reason
# bm-agent's is.
define Package/bm-pppoe-pool/postinst
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
(sleep 3; /etc/init.d/bm-pppoe restart) >/dev/null 2>&1 &
exit 0
endef

# Deliberately nothing, and it is worth saying why rather than leaving a gap.
#
# Every other package here takes something off the router when it is removed.
# bm-wanbind's ip rules are meaningless without the daemon maintaining them, so
# leaving them behind would be worse than never having installed it. A PPPoE
# pool is not like that: the sections live in /etc/config/network, they are the
# user's own configuration, and netifd dials them whether or not anything here
# is watching. Removing this package must not take somebody's five thousand
# sessions down with it.
#
# `default_prerm` - which runs immediately above this body - stops and disables
# the service, and that is the whole of what this package installed. Deleting a
# pool is a separate, explicit act with its own confirmation, in the app and in
# `bmpppoe delete`.
define Package/bm-pppoe-pool/prerm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
exit 0
endef

$(eval $(call BuildPackage,bm-pppoe-pool))
