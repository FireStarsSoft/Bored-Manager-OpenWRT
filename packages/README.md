# Router packages

Everything in this folder runs **on the router**, not in the app. It is built
into `.apk` files by the OpenWrt SDK and installed on the router itself; none of
it is part of the module archive that `openwrt/` produces, and the two version
themselves independently.

| Package | ubus object | Config | What it is for |
|---|---|---|---|
| `bm-agent` | `bm.agent` | `/etc/config/bm_agent` | The common ground: a version handshake, readiness in one ubus call, the `bmctl` CLI, snapshots, the commit-confirm guard, schema migrations and the update engine |
| `bm-pppoe-pool` | `bm.pppoe` | `/etc/config/bm_pppoe` | Pools of PPPoE sessions, dialled and watched on the router: the `bmpppoe` CLI, netifd event tracking, counters and the redial watchdog |
| `bm-wanbind` | `bm.wanbind` | `/etc/config/bm_wanbind` | One DHCP client, one WAN, decided on the router: the `bmwan` CLI, the lease hotplug hook and the 30-second reconcile |
| `luci-app-bm` | — | — | The router's own pages: five tabs under Services in LuCI, calling the same three objects above |

## Why any of this exists

The module drives a router over one SSH connection. That works, and it keeps
working — but three things simply cannot be done from the other end of an SSH
session, however good the code is:

- **A change that cuts the connection cannot undo itself.** Once SSH is gone
  nobody is left to type the command that would put it back. A timer running on
  the router can; that is the commit-confirm guard.
- **Reconciling on an event costs nothing; polling for it costs a round trip.**
  dnsmasq will call a script the moment a lease changes. Reading the lease file
  over SSH every second is the same answer, later and far more expensively.
- **A pool of thousands of sessions is a lot of shell.** Chunked UCI writes over
  SSH are bounded by the round trip per chunk; the same loop on the router is
  bounded by the router.

So the packages are the main road and SSH becomes a compatibility mode. It is
never removed: a router running the module today has to keep working after an
update, and an agent whose `apiVersion` does not match the module has to fall
back rather than break.

## Layout

```
packages/
  version.json         release, apiVersion and configSchema, in one place
  CHANGELOG.md         what each package release changed
  ci/stubs/            empty stand-ins for the C modules, so every module loads
  ci/probes/           programs that drive the daemons and read the answers back
    lib/               a uci that stores things - deliberately not a stub
  bm-agent/
    Makefile           the OpenWrt package recipe
    files/             installed verbatim onto the router
      etc/config/bm_agent      UCI config; an apk conffile, so edits survive updates
      etc/init.d/bm-agent      procd service
      usr/sbin/bmctl           the CLI
      usr/share/bm/            entry points, run by ucode rather than executed
        migrations/            one file per schema step; empty at schema 1
        keys/                  public keys a release manifest is verified against
      usr/share/ucode/bm/      library modules, imported as `bm.<name>`
  luci-app-bm/
    Makefile           built through luci.mk rather than package.mk
    root/              installed verbatim onto the router, as files/ is elsewhere
      usr/share/luci/menu.d/       the five tabs under Services
      usr/share/rpcd/acl.d/        which ubus calls a LuCI session may make
      usr/share/bm/features/       how the agent learns the app is installed
    htdocs/luci-static/resources/
      bm/api.js                    the rpc declares, and the guard banner
      view/bm/*.js                 one file per tab
    po/                            i18n; po/vi is Vietnamese
```

`usr/share/ucode/bm/` is not an arbitrary choice: it is on ucode's default
module search path, so `import { info } from 'bm.agent';` resolves with no
flags, no relative paths and no wrapper. Nothing here is compiled, which is why
every package is `PKGARCH:=all` and one `.apk` runs on every target.

Entry points live in `usr/share/bm/` and are started as `ucode -R -S <file>`
rather than through a shebang. The two flags say what the file is — raw script,
strict mode — instead of depending on which default the router's ucode was
built with, and it means the files do not need to be executable.

## What is on the router, and who owns it

| Path | Written by | Survives an update because |
|---|---|---|
| `/etc/config/bm_*` | a person | it is declared as an apk **conffile** |
| `/etc/bm/` | the agent | no package ships it, so apk neither writes nor removes it |
| `/usr/share/bm/`, `/usr/share/ucode/bm/` | the package | it is replaced wholesale, which is the point |

`/etc/bm/state/meta.json` records the schema the data on disk is written at. It
is deliberately not a UCI section: UCI is for what a person edits, and this is
the one number nobody should edit - setting it by hand does not change the data,
it only makes the next migration skip the step that would have. It is also
deliberately outside the snapshot set, because restoring an old schema number
over data that has already been migrated is exactly the corruption snapshots
exist to prevent.

## The router does not need the app

Every one of these packages works on its own, and that is a requirement rather
than a nice property: the app connects to a router to drive it, and a router
whose app has gone away - uninstalled, on a different network, replaced - has to
keep every capability it had. So each feature has three ways in, and all three
end at the same daemon call.

| | LuCI | console | app |
|---|---|---|---|
| Create a PPPoE pool, credentials and all | Create a pool | `bmpppoe create ID --from F` | yes |
| Add sessions to one | Add sessions | `bmpppoe append ID --from F` | - |
| Delete a pool, start/stop/redial sessions | yes | `bmpppoe delete` / `up` / `down` / `redial` | yes |
| Add, edit, delete a binding instance | yes | `uci` + `bmwan instance delete` | yes |
| See why an instance was refused | on the row | `bmwan check` | yes |
| Pin, move, hold, release a client | yes | `bmwan pin` / `reassign` / `unassign` / `release` | yes |
| Snapshot, compare, restore, download | yes | `bmctl config ...` | yes |
| Check for updates, update, roll back | yes | `bmctl check-update` / `update` / `rollback` | yes |

Two things are only in the app, and neither is a router capability: installing
the packages in the first place, and installing them from a file on your own
machine rather than from a release.

## The LuCI app

`luci-app-bm` is the same three daemons seen from the router instead of from
the app. It is built through `luci.mk`, which is why its layout differs from the
others: `root/` rather than `files/`, `htdocs/` served from `/www`, and one
extra `luci-i18n-bm-<lang>` package per directory under `po/`. `PKG_PO_VERSION`
is pinned to `PKG_VERSION` so those carry the release number rather than one
derived from git timestamps - a bundle whose manifest cannot say what is in it
is not much of a manifest.

The guard countdown is at the top of every tab. The moment it matters is the
moment somebody has applied a change that may be about to cut their connection,
and by then the app is not the thing they are looking at.

### Credentials from a browser

A password must never become an argument to a process: `/proc/<pid>/cmdline` is
world-readable for as long as the process lives. That is why the app writes a
`0600` file over the SSH connection it already has and passes only its path, and
why `bmpppoe create` does the same.

A ubus call from a LuCI page is not a command line. It travels over a unix
socket as a binary message and reaches the daemon as a parsed object, so
credentials sent that way are never an argument to anything either. `pool_add`
and `pool_append` take them inline for exactly that reason.

What the LuCI ACL does *not* grant is `pool_create`, and that is the interesting
half. It names a file for the daemon to read **and unlink** as root - a
narrow-looking primitive that in a web session is an arbitrary delete for any
file directly in `/tmp`. Two methods rather than one is what lets the browser
have the capability without the primitive.

The inline calls are capped at 200 accounts, so a pool of five thousand is one
`pool_add` and twenty-four `pool_append`s. That is not only about message size:
one call writing five thousand sections would hold the daemon's event loop for
the whole of it. The pool record is written before the first section and widened
before each chunk, so a browser that goes away half way leaves a smaller pool
that Delete removes and Add sessions continues.

### The shortest ACL that works

| Not granted | Why |
|---|---|
| `bm.wanbind lease` | A lease event is the hotplug hook's to send. A session that could forge one could move any client onto any line |
| `bm.pppoe pool_create` | It reads and unlinks a caller-named file as root. `pool_add` is the same capability without the primitive |

Downloading a snapshot needs no file grant at all: `config_export` returns the
stored `uci export` text over the same rpc connection as everything else, and
the browser saves it. What comes down is the snapshot itself rather than a
report about it - `uci import < file` restores it on any router, including one
that has never had any of this installed.

`npm run packages:check` reads the daemons' own `methods` tables and fails the
build when the ACL grants something they do not publish, when a view calls
something the ACL does not grant, when a menu entry points at a view that is not
in the tree, or when a `require` names a class that is neither in luci-base nor
in this package. Renaming a ubus method therefore fails the build rather than
one button.

### Taking rules off before the config stops describing them

`bm-wanbind` decides what to look at by reading its config, so a section that is
switched off or deleted is a section it never reads again - and its ip rules
stay on the router with nothing left that knows whose they were. A rule is
recognised by *where it sits*, so moving `rule_pref_base`, `catch_all_pref` or
`lan` has the same effect: the next pass finds none of its own work and writes a
second complete set.

So Stop, Delete and any edit that moves those three call `bm.wanbind flush`
first, and refuse the change outright if the flush does not happen - naming
`bmwan flush --instance NAME` as the way out. `bmwan instance delete` does the
two steps in the same order at a console, which is the only reason that command
exists rather than leaving it to `uci delete`.

## Signing

A release manifest fetched over the network is verified against a public key in
`/usr/share/bm/keys/`. No key ships in this repository; generating one is

```bash
sh scripts/gen-release-key.sh
```

and it belongs to whoever publishes the repository. Until one is committed and
released, a router refuses to update itself over the network - and the three
install paths that do not go over the network keep working, because each has its
own trust root. The details, including how to roll a key over without a flag
day, are in
[`bm-agent/files/usr/share/bm/keys/README.md`](bm-agent/files/usr/share/bm/keys/README.md).

## What OpenWrt does before and after these scripts

Written against the 25.12 tree rather than from memory, because in every case
below the obvious guess is wrong and the router is where it would be found out.

**`postinst` and `prerm` are appended to OpenWrt's own.** In apk mode
`include/package-pack.mk` builds `post-install` as `add_group_and_user`, then
`default_postinst`, then this package's body with its shebang stripped - and
`default_postinst` (in base-files' `lib/functions.sh`) *ends* by running
`enable` and `start` for every `/etc/init.d/` file the package ships. So both
services are already running by the time `postinst` gets its first line, and
`default_prerm` has already stopped and disabled them before `prerm` gets its.
Neither body repeats any of that. `prerm` in particular must not: `default_prerm`
skips the `disable` when `PKG_UPGRADE` is set, and an unconditional one here
would take the agent off the boot sequence on every update.

**An upgrade needs a restart, not a start.** procd's `start` on a service
already running with the same parameters does nothing, so after `apk add` of a
newer `bm-agent` the daemon is still executing the files apk replaced while
`bmctl version` - a new process - reports the new release. `postinst` therefore
restarts it, three seconds later and detached, because an update taken from the
router runs `apk add` from inside that very service and would otherwise kill its
own reply.

**There is no `base64` on a stock router.** OpenWrt builds BusyBox with
`BUSYBOX_DEFAULT_BASE64=n`, and uuencode and uudecode with it. The module's
bundle install decodes with `ucode`'s built-in `b64dec` when there is no
`base64` command - which costs nothing, since `ucode` is in every default image
(firewall4 is written in it) and is a hard dependency of `bm-agent` anyway.

**`--force-reinstall` exists, from 25.12.3.** OpenWrt carries it as
`package/system/apk/patches/0100-add-add-force-reinstall-option.patch`, first
tagged in v25.12.3. It is what makes "install it again" mean anything: plain
`apk add` on a package apk already lists is a no-op. The module tries it and
reads what apk says rather than gating on a version string.

**Lease events arrive through `/etc/hotplug.d/dhcp/`.** dnsmasq's init script
turns `--dhcp-script` on when *any* file exists in that directory (`has_handler`
in `dnsmasq.init`), and its `dhcp-script.sh` forwards each event to
`ubus call hotplug.dhcp`. So a package that wants lease events drops a file
there and reloads dnsmasq - it does not need `option dhcpscript`, which only one
package can hold at a time.

## Checking it before a router does

Two checks, in the order they cost:

```bash
npm run packages:check     # offline, instant: versions, install lists, imports
npm run packages:ucode     # a real ucode compiler; needs Linux and a toolchain
```

`packages:check` is a word search. It holds the three version numbers together,
checks every file a Makefile promises to install exists, checks every `import`
resolves and names a real export, checks a ucode module imported from another
package is paid for in `DEPENDS`, and refuses fourteen kinds of JavaScript that
ucode does not have - digit separators, `.length`, `.push()`, `throw`, and an
exported function closed with `}` instead of `};`. It runs anywhere node runs.

Two of its rules are not about syntax at all, and both exist because the real
compiler cannot see them.

**A callee declared below its caller.** ucode resolves a name when it compiles
the function that mentions it, so a call to something declared further down the
same file compiles cleanly and raises the first time the line runs:

```
Reference error: access to undeclared variable poolPut
```

Three of these were live at once when the rule was written, one of them in the
commit-confirm Undo path where the cost of finding out is a router that did not
come back.

**A regex literal POSIX will not take.** ucode does not implement regular
expressions; it hands the pattern to `regcomp` with `REG_EXTENDED`. `\x` is not
a POSIX escape, so `/[\x00-\x1f\x7f]/` - the obvious way to write "no control
characters" - is refused, and refused when the constant is *built*, which is
when the module is loaded. `bm-pppoe-pool` shipped that for a release: a clean
compile, and a package that died on the router with "Invalid regular expression"
before one line of it had run, taking every module that imported it with it.
`\d`, `\w`, `\s` and `\b` are the quieter version - GNU extensions that glibc
takes and musl, which is what the router runs, reads as literal letters.

`packages:ucode` ([`scripts/check-ucode.sh`](../scripts/check-ucode.sh)) is the
real thing: it builds the exact ucode OpenWrt 25.12 ships, pinned to the commit
in `openwrt/package/utils/ucode/Makefile`, and runs every `.uc` file and every
`/bin/sh` script here through it. Modules are **loaded** through a generated
importer rather than compiled: a module that compiles is not a module that runs,
which is how the regex above got as far as it did. Entry points are compiled and
not run, because running one connects to ubus and enters uloop.

Then it runs the probes in [`ci/probes/`](ci/probes), which are the other half:
a build says a file is well formed, a probe says it is right. They create a
pool, extend it, refuse an overlapping one, delete it and read every section
back out of an in-memory uci - because a pool created one sequence number too
low silently rewrites another pool's credentials, and no compiler will ever see
that. On Debian or Ubuntu it needs:

```bash
sudo apt-get install -y git cmake build-essential pkg-config libjson-c-dev
```

`.github/workflows/packages.yml` runs the same script, so what CI checks and
what you can check are the same thing rather than two copies that drift.

## Building

`.apk` files are built by `.github/workflows/packages.yml`. It runs both checks
above - see [`ci/README.md`](ci/README.md) for what the stubs are - then fetches
the OpenWrt SDK for the release named in that workflow, drops this folder into
it, and builds. `packages-release.yml` calls that same workflow on a `pkg-v*` tag rather
than repeating it, so a tag cannot publish something a branch would have
rejected.

Locally, with an SDK already unpacked:

```bash
ln -s "$PWD/packages/bm-agent" /path/to/sdk/package/bm-agent
cd /path/to/sdk && make defconfig && make package/bm-agent/compile V=s
```

The result lands in `bin/packages/all/base/bm-agent-*.apk`.

## Versions

`version.json` is the source of truth, and it holds three numbers that move for
three different reasons.

| | Moves when | Enforced by |
|---|---|---|
| `release` | anything ships | `PKG_VERSION` in each Makefile and `RELEASE` in `bm/version.uc` must match |
| `apiVersion` | a ubus call changes shape | the module falls back to SSH on a version it does not know |
| `configSchema` | what is written to `/etc` changes | a build refuses to start on data written at a higher one |

`npm run packages:check` fails the build when any of them disagree with the
files that quote them - the same arrangement that stops a release tag
disagreeing with `openwrt/module.json`. It also checks that the migration chain
from schema 1 to the current one has no hole in it, because a release that
cannot bring an existing router forward should never be built, let alone
published.

The tag is `pkg-v<release>`, and `packages-release.yml` refuses to publish when
it does not match `version.json`.
