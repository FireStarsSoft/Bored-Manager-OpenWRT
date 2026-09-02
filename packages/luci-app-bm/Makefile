# luci-app-bm: the router's own pages for Bored Manager.
#
# Written last, deliberately. By the time this existed the ubus API of all three
# daemons had stopped moving, so every view was written once against a fixed
# contract rather than chased through three releases of it.
#
# It is also the only surface that works when the app cannot reach this router
# at all - which is the situation these pages matter most in, and the reason the
# guard countdown sits at the top of every one of them rather than on a page of
# its own that nobody would be looking at.
#
# Built through luci.mk rather than package.mk. That is what installs htdocs/
# and root/, what turns po/ into the .lmo catalogs LuCI reads, and what builds a
# separate luci-i18n-bm-<lang> package for each language directory. The include
# path is the feeds one because this package lives outside the LuCI tree; inside
# it, apps write ../../luci.mk.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-bm
PKG_VERSION:=2.4.0
PKG_RELEASE:=1

# luci.mk would otherwise derive this from the last commit that touched po/,
# which is a different number on every edit and no number at all in a checkout
# with no git history. A translation ships with the release it was written for,
# so it carries that release's version - and `npm run packages:check` holds it
# to that, because a bundle whose i18n archive is versioned by a timestamp is a
# bundle whose manifest cannot say what is in it.
PKG_PO_VERSION:=$(PKG_VERSION)

PKG_MAINTAINER:=FireStarsSoft
PKG_LICENSE:=Apache-2.0

LUCI_TITLE:=Bored Manager
# bm-agent, not the feature packages. Every page here begins by asking the agent
# what this router has, so the app installs and the pages follow; a router with
# only the agent gets an Overview that says so rather than four broken tabs.
LUCI_DEPENDS:=+luci-base +bm-agent
LUCI_PKGARCH:=all

# Defined here rather than through LUCI_DESCRIPTION because luci.mk runs that
# through $(strip), which collapses a paragraph into one line. Defining it
# before the include also means luci.mk leaves it alone.
define Package/luci-app-bm/description
  The Bored Manager pages, served by the router itself.

  Four tabs under Services: an overview of the three daemons, the PPPoE Dialer,
  the one-to-one WAN bindings, and Maintenance (snapshots, updates, scaling).
  They read the same ubus API the app drives, so what they show is what the
  router thinks rather than a second opinion assembled somewhere else.

  Every tab carries the commit-confirm countdown at the top. A change that cuts
  the connection is exactly when a person needs to see it, and by then the app
  is not the thing they are looking at.
endef

# Nothing to do here that default_prerm has not done - there is no service and
# no rule to take off. What is left is a cache: LuCI keeps its menu index under
# /tmp and would go on offering pages whose files are about to disappear, which
# is a click that ends in a blank error rather than a menu that lost an entry.
#
# postrm is the one that matters, and it repeats this for the ordinary reason -
# a request served between here and the files actually going would rebuild the
# cache with the entries still in it. Doing it here as well only costs two rm's
# on tmpfs and closes the window somebody is most likely to click in.
define Package/luci-app-bm/prerm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache/
exit 0
endef

# After the files are gone: the menu index is rebuilt without them, and rpcd
# forgets the ACL group this package shipped. Without the reload rpcd keeps
# granting access to bm.* through an ACL file that no longer exists on disk,
# until something else happens to restart it.
define Package/luci-app-bm/postrm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache/
/etc/init.d/rpcd reload >/dev/null 2>&1 || true
exit 0
endef

# No postinst here on purpose. luci.mk ships one - it clears the same caches and
# reloads rpcd so the new ACL group is picked up - and defines it with `ifndef`,
# so writing our own above the include would silently replace it with a worse
# copy of itself.
include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
