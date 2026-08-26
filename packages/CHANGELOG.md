# Changelog — router packages

These version independently of the module and of the app. A router package
release is tagged `pkg-v<version>`; the module's own tags are `v<version>`.

`release` is what is installed. `apiVersion` is the contract with the module — a
module that does not know an agent's API version falls back to SSH rather than
guessing, so it moves only when the shape of a call changes. `configSchema` is
the shape of what is written to `/etc`, and it is what a downgrade is refused
on. All three are in [`version.json`](version.json).

## 2.0.0

`bm-pppoe-pool` is rewritten around what a pool actually is, and the daemon now
owns a pool end to end: the record, the network sections, the tagged devices,
the firewall zone, the MACs. Nothing else writes any of it any more - not the
module over SSH, not a LuCI page - which is why this is 2.0.0 and why
`configSchema` moves to **2**. `bm.agent`'s own contract did not change shape,
so `apiVersion` stays 3; the pool daemon's feature descriptor carries its own
`apiVersion: 2`, and a module that only knows 1.x sees that number and says so
instead of guessing.

Pools written by 1.x are not migrated, because there is nothing to migrate them
*to*: the old model recorded a sequence range and the new one records members.
They are listed as **legacy** - visible, counted, delete-only - and
`pool_delete` still knows how to take one apart completely: the five-digit
sections, the shared `bmv<vid>` devices by refcount, the zone memberships. The
schema step exists so a 1.x router is stamped forward exactly once and a 1.x
build refuses to start over 2.x data rather than misreading it.

### One VLAN, one session

The old model was a prefix and a block of sequence numbers - `ppp00001` to
`ppp05000` - because it was written for an ISP that hands out five thousand
accounts. The ISPs these routers actually sit behind hand out something else: a
handful of VLANs on one uplink, each VLAN carrying one PPPoE session, often all
of them on **one shared account** that the BRAS tells apart by MAC.

So a v2 pool is a carrier and a list of VLAN members, at most 500 of them, and
everything else is derived: VLAN 101 on prefix `fpt` is section `fpt101`,
device `pppoe-fpt101`, tagged device `eth1.101` (VLAN 0 means untagged, straight
over the carrier), routing table `table_base + 101`. One spelling per rule, in
`config.uc`, quoted by both reconcilers, the status machine, the counters and
the delete - two spellings of one rule is how a delete misses a section.

Two modes, declared at creation and immutable afterwards. `multi` carries one
account at pool level and every member dials with it; `single` carries one
account per member. That distinction used to be five thousand pasted lines;
now it is the shape of the pool.

### The MAC is arithmetic, not luck

A shared account only works if every session presents its own MAC, and an
invented MAC only works until the pool is created again after a reboot and
invents different ones - at which point the BRAS drops every session and the
operator learns what "random" costs. So `mac_mode auto` derives them:
`02:` (locally administered, unicast), three octets of FNV-1a over the
carrier's own MAC and the pool id, and the VLAN in the last two. Two pools on
one carrier differ, the same pool re-created lands on the same MACs, and
nothing is stored - the reconciler recomputes and always gets the same answer.

The formula is pinned by a probe against fixed inputs, because moving it - by
accident, by refactor - redials every pool in the field on the next reconcile.

### Editing exists now

`pool_set` folds a partial spec over the stored record. A member kept by its
VLAN keeps its password, so relabelling a pool never means retyping five
hundred credentials; the prefix and the mode are refused outright (every
interface is named by the first, the account shape is the second); and the
changes that redial sessions - carrier, table base, zone, MAC mode, a `multi`
password - are warned about with the count of sessions they take down.
`pool_check` runs the same gate with the same sentences, so the preview a form
shows is the refusal the apply would have given.

### The firewall is the pool's own

Each pool names its zone (default `bmwanpool`), and the daemon reconciles it:
the zone section, its `network` list built from the members, masquerading, MTU
fix, and one forwarding from the LAN zone - found from the router's own
firewall configuration, not assumed to be `lan`. Deleting the pool takes the
memberships off and removes the zone when nothing else still uses it,
including a `bm-wanbind` that names it. `fw4 reload` is coalesced the same way
netifd reloads are: one reload per settled change, not one per section.

### The API is five verbs and a status machine

On `bm.pppoe`: `pool_check`, `pool_create`, `pool_add`, `pool_set`,
`pool_delete`, plus `action` (up, down, redial, enable, disable - the last two
persist `option auto`, so a disabled member stays down across reboots),
`sessions`, `carriers`, `info`, `stats`, `settings_get`, `settings_set` and
`reconcile`. A member's state is one of six: `up`, `dialing`, `down`, `error`,
`stopped`, and `unwritten` - recorded but not yet on the router, which is the
state a create that died half way leaves behind and the state every other
surface used to have no word for.

`pool_append` is gone. It existed because a 5,000-account pool did not fit in
one message; a 500-member pool does, so the whole spec travels in one call and
a pool is never half-created by a browser that went away.

The two credential paths survive unchanged in shape: `pool_create` reads and
unlinks a `0600` file for callers that have a filesystem (the module over SSH,
`bmpppoe` at a console), and `pool_add` takes the spec inline for callers that
do not (a LuCI page, where the call is a binary message on a unix socket and
never a command line). `pool_create` stays out of the LuCI ACL for the same
reason as before: reading and unlinking a caller-named file as root is an
arbitrary delete in `/tmp`, and the browser gets the capability without the
primitive.

The daemon's own knobs - counter interval, the redial watchdog's patience and
batch size - are `settings_get`/`settings_set` now, stored in `bm_pppoe` where
they always were, editable from every surface instead of from none.

### The probes grew a filesystem

`packages/ci/probes/lib/` gained an in-memory `fs` beside its storing `uci`, so
a probe can seed `/sys/class/net/eth1/address` and the daemon under test reads
a carrier MAC the same way it does on a router. `pool-lifecycle.uc` drives the
real daemon through create, check-refusals, edit and delete and reads every
section back; `pool-legacy.uc` seeds an old-model pool and proves it is listed
as legacy, refused for editing, and deleted cleanly. The golden MAC vectors
live there too, which is what makes the formula pinned rather than described.

### Also

- `bmpppoe` is rewritten around the new verbs: `status`, `list`, `carriers`,
  `stats`, `reconcile`, `up`/`down`/`redial`/`enable`/`disable`,
  `check`/`create`/`set` from a spec file, `delete`, `settings`.
- The LuCI PPPoE tab is rewritten against the same calls: pools with their
  members and states, create and edit forms that run `pool_check` while you
  type, the legacy list, and the daemon settings.
- `/etc/config/bm_pppoe` is `chmod 600` on install: it can carry account
  passwords, and it always could.
- `bm-agent`, `bm-wanbind` and `luci-app-bm` move to 2.0.0 with it - the
  release number is one number across the tree. `bm-agent` carries the schema
  step and `luci-app-bm` the rewritten tab; `bm-wanbind` changes nothing but
  its version.

## 1.4.1

The one that matters was found on a real router: every LuCI page answered "There
is no agent on this router" while all three daemons were up and answering
`ubus call`. The second came out of reading the error path the first unblocked.

### LuCI can actually call the daemons now

LuCI's dispatcher appends `ubus_rpc_session` to every call it forwards, and
ucode's `publish` refuses any named argument the method's template does not
declare - so every call from a LuCI page came back `UBUS_STATUS_INVALID_ARGUMENT`
while the same call typed at a console worked. The one line every view starts
with, `bm.agent info`, failed first, which is why the pages drew the "no agent"
notice instead of data.

Every published method on `bm.agent`, `bm.wanbind` and `bm.pppoe` now declares
`ubus_rpc_session` and strips it before the handler runs, so no handler ever
sees a session id. The hotplug `lease` call and the console paths never sent
the field and are unchanged. The contract the module drives is the same shape,
so `apiVersion` stays 3.

`bm/api.js` also learned the sentence for the dispatcher's own `-32002 Access
denied`: it means the login predates the ACL file, and the fix is logging out
and back in, not reinstalling anything.

### Two ubus status codes had each other's sentence

`describe()` answered codes 2 **and** 7 with one sentence about arguments, and
code 9 with "The router took too long to answer." The numbers are raw ubus status
values - LuCI's `rpc.js` prints them and nothing else - and its own table says
what they are: 2 is `INVALID_ARGUMENT`, 7 is `TIMEOUT`, 9 is `UNKNOWN_ERROR`.

So the two that were wrong were wrong in the way that costs the most time. A
daemon that had stopped answering - a pool with thousands of sessions, say - told
the operator to go and check the arguments of the call. A handler that threw told
them the router was slow.

9 has its own sentence now and it names `logread`, because that is the one code
whose reason exists nowhere else: it is what ucode replies immediately before an
uncaught exception takes the daemon down with it.

Only reachable at all because of the fix above. Until this release no call from a
LuCI page got far enough to come back with any of these.

## 1.4.0

Adds `luci-app-bm`, closes the last gaps between what a router can do with the
app and what it can do without one, and fixes several things that could only
have been found by running the code rather than by compiling it - including one
that stopped `bm-pppoe-pool` from starting at all.

### The catch-all keeps the router on its own LAN

`bm-wanbind` wrote the fail-closed rule as `from <lan network>` into a table
holding only `unreachable default`. That selector matches on source and the LAN
network contains the router's own address, so the router stopped answering on
the interface being bound - no SSH, no ping, no DNS or DHCP replies. Here it was
worse than on the module's SSH path: `/etc/config/bm_wanbind` is a conffile and
`reconcile` re-asserts every thirty seconds, so a reboot did not clear it and
recovery meant failsafe mode.

`unreachableDefault` now writes the LAN's connected route into the same table,
and refuses to install the catch-all at all if that route will not go in - a
half-built table is the state that caused this. `removeUnreachableDefault`
flushes the table rather than deleting one route from it, so the pair leaves
together.

### `bm-agent` restores rules, not just configuration

A snapshot is a copy of `/etc/config`, and `ip rule` is not in it. `bm.restore`
now runs `bmwan flush` before its reloads, and reloads `bm-wanbind` and
`bm-pppoe` rather than only netifd, fw4 and dnsmasq - `uci commit` emits no
procd trigger and both daemons read their configuration once at start, so a
restore used to commit a file the daemon never looked at again while reporting
success.

### The router's own pages

Five tabs under Services in LuCI: an overview of the three daemons, the PPPoE
pools, the WAN bindings, the snapshots, and the updater. They call the same ubus
API the app drives, so what they show is what the router thinks rather than a
second opinion assembled somewhere else.

Written last on purpose. By the time this existed the API of all three daemons
had stopped moving, so each view was written once against a fixed contract
rather than chased through three releases of it.

The commit-confirm countdown is at the top of every tab, not on a page of its
own. The moment it matters is the moment somebody has applied a change that may
be about to take their connection away - and by then the app is not the thing
they are looking at, which is the whole reason the guard runs on the router.

### Nothing here needs the app any more

The app connects to a router to drive it. A router whose app has gone away -
uninstalled, on another network, replaced - has to keep every capability it had,
and three did not survive that test. All three are closed, and each is closed in
the same place for LuCI and for a console.

**Pools are created from LuCI, credentials and all.** The obstacle was real and
the answer was not to weaken it. A password must never become an argument to a
process, because `/proc/<pid>/cmdline` is world-readable, which is why the app
writes a `0600` file and passes only its path. But a ubus call from a web page
is not a command line either: it travels over a unix socket as a binary message
and reaches the daemon as a parsed object. So `pool_add` takes the accounts
inline, and `pool_create` - which reads *and unlinks* a caller-named file as
root, an arbitrary delete in `/tmp` for anyone who can call it - stays out of
the ACL. Two methods rather than one is what gives the browser the capability
without the primitive.

`pool_append` adds sessions to the end of a pool, which is both how a list
longer than one ubus message gets there (200 at a time, with the record widened
before each chunk so a browser that goes away leaves a smaller pool rather than
wreckage) and the answer to a trap the daemon could previously only refuse:
adding capacity by creating a second pool with the same prefix, one sequence
number too low, silently rewrites the first pool's credentials. `bmpppoe append`
is the same thing at a console.

**Binding instances are added, edited and deleted from LuCI**, with the same
refusals the daemon applies, said while you are typing rather than after saving.
And an instance the daemon refused now appears in its own list with the reason
on the row: it used to be dropped from every list there was, which is the
hardest kind of mistake to find - nothing is broken, nothing is red, and the row
that should be there simply is not. `bmwan check` prints the same thing at a
console, without needing the daemon to be running.

**Snapshots download from LuCI**, and with no file grant at all: `config_export`
returns the stored `uci export` text over the same rpc connection as everything
else. What comes down is the snapshot rather than a report about it - `uci
import < file` restores it on any router, including one that never had any of
this installed.

`bmwan` also gained `reassign`, which the ubus API had and the console did not,
and `instance delete`, which exists only to do two steps in the right order:
rules off, then section removed.

### Stopping an instance left its rules behind

`bm-wanbind` decides what to look at by reading its config, so a section that is
switched off or deleted is a section it never reads again - and every ip rule it
wrote stays on the router with nothing left that knows whose they were. A rule
is recognised by *where it sits*, so moving `rule_pref_base`, `catch_all_pref`
or `lan` does the same: the next pass finds none of its own work and writes a
second complete set, and the first set stays, pointing at whatever those
priorities used to mean.

The module learned this in 2.4.0. The LuCI page had the same bug on its Stop
button, and it now flushes first and refuses the change outright if the flush
does not happen, naming the command that does work.

`bm.wanbind flush` was half the problem: it walked the daemon's own state, so an
instance that was already switched off had no state and could never be flushed
through ubus at all - only `bmwan flush`, which reads the file, could reach it.
It reads the file too now, so the two paths do the same thing.

### The package that could not start

`bm-pppoe-pool` had `const UNSAFE = /[\x00-\x1f\x7f]/` - the obvious way to
write "no control characters in a credential". ucode does not implement regular
expressions; it hands the pattern to `regcomp` with `REG_EXTENDED`, and POSIX
has no `\x` escape. regcomp refuses it, and refuses it when the constant is
*built*, which is when the module is loaded. Every module that imported it went
down with it, which is all of them: the daemon, `bmpppoe`, the lot.

`ucode -c` compiles a regex literal into the bytecode without ever calling
regcomp, so the compile check passed every time. It loads each module for real
now, and `npm run packages:check` refuses `\x` outright - and refuses `\d`,
`\w`, `\s` and `\b`, which are the quieter version: GNU extensions that glibc
accepts, so an Ubuntu runner sees nothing, and that musl - which is what the
router runs - reads as literal letters.

The check itself was rewritten as a loop over the bytes, which fixed a second
thing no regex could have: a subject reaches `regexec` as a NUL-terminated C
string, so a value with a NUL in it was only ever scanned as far as the NUL.

### And the daemons are run before they ship

`packages/ci/probes/` is new. A build says a file is well formed; these say it
is right, which for this tree mostly means arithmetic. They create a pool,
extend it, refuse one that would overlap it, delete it and read every section
back out of an in-memory uci - and they hold the binding daemon to saying *why*
it refused an instance rather than dropping it. Starting an append one sequence
number too low now fails the build with the section it would have overwritten
named, instead of rewriting somebody's credentials on a router.

### Two more silent drops

- **A pool could be created that the next read threw away.** `pools()` refuses a
  record whose table base runs past 65535 or whose carrier is empty; `create`
  checked neither, so it could write a record that vanished on the next read -
  leaving interfaces nothing knew the names of. Both paths use the same check
  now.
- **A refused pool or instance said so only to syslog.** Both now carry the
  reason to every surface that shows a configuration.

### ucode does not hoist, and three things were relying on it

A ucode function is compiled when the parser reaches it, and a name it mentions
is resolved at that moment. A call to something declared further down the same
file therefore compiles cleanly and becomes a global load that raises the first
time the line runs:

    Reference error: access to undeclared variable poolPut

Which is why building every file with the real interpreter never caught it.
Three were live: the free-WAN pool reset, the rule-write recovery path, and -
worst - `guard cancel`, the Undo on the commit-confirm countdown, where the cost
of finding out is a router that did not come back. `npm run packages:check` now
refuses a callee declared below its caller, and the three probes that prove the
fix are run against the pinned interpreter rather than reasoned about.

### And the rest of what a full read found

- **Two binding instances on one router took each other's rules off.** Every
  instance shares one `rule_pref_base` and differs only in where its catch-all
  sits, so instance 1's range contained the whole of instance 0's - including
  its fail-closed catch-all - and each pass removed what it could not attribute.
  A rule is now this instance's only if it is also about a client on this
  instance's LAN.
- **A restore could delete the snapshot it was restoring.** The before-restore
  copy is taken by the same function that prunes the store to ten, so restoring
  the oldest of a full store removed the very files the next line was about to
  read - and returned "nothing could be read back" having changed nothing. The
  snapshot is now read into memory before anything is written.
- **The updater staged into a fixed `/tmp/bm-update`.** Any process on the
  router could create it first, as a directory or as a symlink, and the download,
  the checksum, the `apk add` and the cleanup would all have run as root inside a
  path somebody else chose. It is `mktemp -d` now, which is what the app's own
  side has used since 2.2.0.
- **A snapshot id went into a path unchecked.** `config_delete` with `./baseline`
  walked past the one refusal that protects the baseline, and `../state` reached
  a recursive delete. Ids are validated where they become a path.
- **`bmwan unassign` did not survive a restart.** A held client has no rule, so
  it is the one decision that cannot be re-derived from the router; it is in the
  state file now.
- **Two PPPoE pools could name the same interfaces.** Sharing a prefix with
  overlapping sequence ranges silently rewrote the other pool's credentials and
  redialled its sessions on them. Refused at create.
- **ucode's uci module returns null rather than raising**, so the `try/catch`
  around a `set` or a `commit` never fired. A failed commit now fails the call
  instead of reporting success.
- **Throughput was attributed by prefix alone**, so two pools sharing a prefix
  gave one of them every byte and the other a flat zero.
- **A daemon refusing on schema was respawned every five seconds forever.** procd
  does not look at the exit status, so the init scripts check `bmctl schema`
  before registering an instance at all.
- The VLAN device section is named `bmv<vlan>` on both sides. The two halves had
  two spellings, so whichever did not write it could never clean it up.

## 1.3.0

The two packages that do the work, and the first release any of this was
compiled by a real ucode.

### `bm-wanbind`

One DHCP client, one WAN, decided on the router. The module has been able to do
this over SSH since 2.0.0 and still can; what it cannot do from the far end of a
connection is any of the three things this package exists for.

**A lease is an event, not something noticed at the next poll.** dnsmasq turns
`--dhcp-script` on when any file exists in `/etc/hotplug.d/dhcp/` and forwards
every lease through `ubus call hotplug.dhcp`, so the package ships one small
script there and the rule for a new client is written while it is still
finishing its DHCP exchange. No `option dhcpscript`, which only one package on a
router can hold at a time, and therefore no fallback for it being taken.

**Binding a client is constant time.** A hash lookup for the device, a pop off a
free-WAN list, a pop off a returned-priority stack, and one netlink message. It
costs the same on a router with four clients and one with four thousand, which
is the opposite of the SSH path - there the cheapest way to find out anything is
to read the whole router back and work it out again.

**Rules are written over netlink.** A thousand `ip -4 rule add` processes is a
fork, an exec, a dynamic link and a netlink round trip each, and about a minute
of a small router's CPU. `ucode-mod-rtnl` makes it a thousand messages on one
socket, and about a second.

The policy is the package's own: a sticky map that gives a returning client the
same WAN, a FIFO for when the pool has run out, and remap to move a client off a
WAN that has been failing longer than the grace. All of it survives a restart
without being written down, because it is re-derived from the router's own ip
rules on every pass - the rules are the record, the lease file says whose
address each one is, and the table numbers say which line. Only the sticky map
is persisted, and only when it changes.

Unassigned clients are blocked rather than shared. Each instance installs
`unreachable default` in a table of its own and one rule sending the LAN subnet
there below every client rule, so a client with no WAN has no route instead of
quietly using whichever one the router would have picked. That route is the one
thing here written with `ip` rather than netlink, and read back after writing:
it is the single most consequential line in the package.

`bmwan` reads and drives it from a console. `bmwan flush` deliberately does not
go through ubus - the moment it is wanted is usually the moment the service has
been stopped - which is what lets `apk del bm-wanbind` leave exactly the same
router behind as pressing Remove in the app.

### `bm-pppoe-pool`

Pools of PPPoE sessions, written and watched on the router.

**Credentials stop being difficult.** Over SSH a password has to be kept off
every command line, because `/proc/<pid>/cmdline` is world-readable - the module
writes payloads to a `0600` file and pipes them through stdin for exactly that
reason. Here the accounts arrive as a file the daemon reads and unlinks before
writing a single section, and the password goes from that JSON straight into
`uci.set` inside one process. It never becomes an argument to anything, so there
is no command line to keep it off.

**Sessions are watched, not polled.** `ubus listen network.interface` fires the
moment netifd brings a session up or drops one; the `dump` on the counter pass
is the correction, not the source. Counters are one read of `/proc/net/dev`
summed by prefix, which costs the same for five sessions and five thousand.

**The watchdog is a queue, not a scan.** A session that goes down is pushed with
the time it went down; times only increase, so the queue is already in
longest-down-first order and the front of it is the next candidate. A session
coming back costs nothing at all - its entry is skipped when it is reached -
which matters when a provider drops four thousand of them and brings them back a
minute later. Redialling is a last resort with a two-minute default: netifd
retries a session better than anything here could, and this is for the ones it
has given up on.

Removing this package takes nothing away. The sections it wrote are ordinary
`config interface` entries in `/etc/config/network` - the user's own
configuration - and netifd dials them whether or not anything is watching. That
is a deliberate difference from `bm-wanbind`, whose rules mean nothing without
the daemon maintaining them and are therefore removed with it.

### Everything here now compiles before it ships

`npm run packages:ucode` builds the exact ucode OpenWrt 25.12 ships - pinned to
`PKG_SOURCE_VERSION` in `openwrt/package/utils/ucode/Makefile` - and compiles
every `.uc` file and every `/bin/sh` script with it. CI runs the same script.

It found things reading could not. `120_000` is not a number in ucode: its lexer
ends a number at the first non-digit, so that is `120` followed by a label, and
the whole update module failed to compile. And `export function f() { ... }`
needs a trailing `};` - an `export` is a statement, and without the semicolon the
error is reported against whatever line comes next. Every ucode module in the
OpenWrt tree closes them `};`; not one closes them `}`. 104 of ours did.

`npm run packages:check` gained the parts of that a word search can do, so they
are caught on the machine the code was typed on: fourteen kinds of JavaScript
that ucode does not have, every `import` resolving to a real export, and a ucode
module imported from another package being paid for in `DEPENDS` - which CI
cannot catch at all, because it compiles against stubs.

### Also

`bm-agent` moves to 1.3.0 with the rest. Its `postinst` and `prerm` were rewritten
against what OpenWrt's apk packaging actually does rather than what it looks
like it does: `default_postinst` has already enabled and started every service
before the package's own body runs, and `default_prerm` has already stopped and
disabled them - including skipping the `disable` on an upgrade, which the old
body then undid by hand. An upgrade now restarts the agent, deferred three
seconds and detached, because otherwise procd's `start` on an already-running
service does nothing and the daemon keeps executing the files apk just replaced.

## 1.2.0

The update engine. `configSchema` stays at 1, so a 1.0.0 or 1.1.0 router takes
this with no migration.

### `bmctl check-update`

Fetches the manifest named by `update_url` in `/etc/config/bm_agent`, verifies
its `usign` signature, and compares versions. That is the **only** thing on this
router that reaches out to the internet, and it only does so because somebody
asked: no timer, no boot-time check, nothing in the background. A router that
phones home on its own is a router doing something its owner did not ask for.

An unsigned manifest, a signature that does not verify, a router with no key
installed and a router with no `usign` are four different refusals with four
different fixes, and they are worded as four different sentences. So is a
missing `ca-bundle`, which is reported as itself rather than as "the download
failed" — the fix has nothing to do with the URL somebody would otherwise start
checking.

A version that will not parse is `newer: null`, never `false`. "Cannot tell" and
"older" are different answers, and treating the first as the second is how a
router talks itself into a downgrade.

### `bmctl update`

Guard, download, verify, install, migrate, verify again — in that order, every
time.

- The **guard** is armed before anything is written, so an update that breaks
  the network undoes itself. What it restores is the router's *configuration*,
  not its packages: an update that writes a broken firewall rule is undone by
  it, an update whose new agent simply crashes is not. `--no-guard` exists and
  is not the default.
- Each `.apk` is checked against the hash **in the signed manifest**, not
  against one computed from the same download. That is the whole difference
  between "it arrived intact" and "it is what was published".
- The install is one `apk add --allow-untrusted` with every file, so apk
  resolves them against each other instead of failing on a dependency that is in
  the next argument.
- The **migration runs as a new process**. apk has just replaced every file
  under `/usr/share/ucode/bm/`, and the process doing the update is still
  running the code it compiled from the old ones — so migrating in place would
  migrate with the previous release's idea of what the data should look like.
- The version is then read back off the router by asking a fresh `bmctl`, rather
  than assumed from apk's exit code. Unreadable is reported as `verified: null`,
  which a surface shows as "unverified" rather than as success or failure.

Three refusals happen before anything is downloaded: a release that is not
newer, one that needs a newer agent to apply it than this router has (naming
the intermediate step), and one whose `configSchema` is lower than the data
already on disk — because the service would refuse to start afterwards, and it
is better to say so while the router still works.

### `bmctl rollback`

Every successful update keeps the `.apk` files it installed under
`/etc/bm/packages/current/`, moving the previous set to `previous/` first.
Rollback reinstalls `previous/`: there is nothing to download and nothing to
verify, because those files were verified on the way in.

It deliberately does not migrate. Going back to an older build cannot move data
forward, and there is no `down` step by design — if the data was migrated by the
version being removed, the older service refuses to start and says so, and the
snapshot taken before the update is the way back.

A router whose first install came from the app has no previous set, and is told
that rather than left to guess why nothing happened.

### Interfaces

`update_check`, `update_apply`, `update_rollback` and `update_status` on
`bm.agent`; `check-update`, `update` and `rollback` on `bmctl`. `update_status`
reads a file and never fetches anything: a surface asking what happened last
time must not make the router call out.

`apiVersion` moves to **3**.

## 1.1.0

The safety net. Nothing on disk changed shape, so `configSchema` stays at 1 and
a 1.0.0 router takes this update with no migration.

### Snapshots

`uci export` of the six packages this project writes to - `network`, `firewall`,
`dhcp` and the three `bm_*` - one file each, plus a capture of `ip rule` and
`ip route` for a person to read. Deliberately not `sysupgrade -b`: that is a
backup of the whole of /etc, and restoring it would put back an SSH key, a
hostname and a wireless password along with the one interface somebody meant to
undo.

Ten are kept, plus a **baseline** that is never pruned and never deleted - the
first snapshot ever taken on a router, which is the only answer to "put this
back the way it was before any of this touched it". The directory has a 2 MB
ceiling, because a router that fills its own overlay with its safety net has
made things worse.

One is taken automatically before anything is written, and `bmctl config
snapshot` takes one on demand.

### Restore, and a diff first

`uci import` per package, without `-m`, so a restore removes the sections a
change added rather than merely correcting the ones it edited. Each package is
imported and committed on its own, so a failure part way leaves what already
went back in place. Reloads run in one order - netifd, then fw4, then dnsmasq -
because each builds on what the one before it made.

`bmctl config diff <id>` is a line comparison of the UCI exports, which is the
right granularity for the question somebody actually asks: a UCI export is
already one setting per line. It is order-insensitive, because uci does not
promise to export sections in the order it read them and a reshuffle reported
as a hundred changes is unreadable.

### The guard

`bmctl config guard` is the part that could never be done from the app. Once a
change has taken SSH down there is nobody left to type the command that would
undo it - the connection that command would arrive on is the thing that broke.
So:

```
bmctl config guard --timeout 120     snapshot, write the deadline, start the timer
   ... the change is applied ...
bmctl config confirm                 still reachable, so the change stands
   ... or nobody confirms ...
   -> the snapshot goes back and the network reloads, on its own
```

The countdown is `/etc/init.d/bm-guard`, a **separate procd service** running a
shell loop that calls `bmctl config expire` every two seconds. Separate on
purpose: a daemon that hangs applying something, or that is killed by the very
`ip rule` it just wrote, cannot stop it.

The deadline lives in a file, not in the timer's memory, which is what makes it
survive both the timer being killed - procd brings it back and it resumes - and
the router being rebooted. `bm-guard` is enabled at boot and opens no instance
unless a record exists, so a router that reboots mid-change comes up, finds the
record, and expires it immediately. Which is correct: a router that rebooted
mid-change was never confirmed.

Expiring takes a snapshot of the broken state before undoing it. That copy is
the only evidence of what actually went wrong, and it is worth far more than the
few kilobytes it costs.

### Interfaces

Ten new ubus methods on `bm.agent` - `config_list`, `config_show`,
`config_diff`, `config_restore`, `config_snapshot`, `config_delete`,
`guard_arm`, `guard_confirm`, `guard_cancel`, `guard_status` - and the matching
`bmctl config` commands. `info` now carries the guard's state too, so one poll
tells a surface whether to show a countdown.

Every one of them is a wrapper over a function that does not know ubus exists,
and `bmctl` calls those same functions. There is one implementation of "restore
this snapshot", not a console one and an app one that drift until they disagree
about what a router did.

`apiVersion` moves to **2**: these are new calls, and a module that does not
know about them should not be assuming they are there.

## 1.0.0

The first release. One package, `bm-agent`, and everything in it is groundwork:
nothing here drives PPPoE or WAN binding yet, and a module talking to a router
that has this installed still does all its work over SSH.

What it does do is make the next four releases possible without a flag day.

### `bm.agent`

Two ubus methods. `info` is the version handshake — release, `apiVersion`, the
schema this build understands, the schema actually on the disk, and which other
Bored Manager packages are installed. `stats` reports resident memory, uptime
and how many requests have been served, which is the shape every daemon in this
tree will report so that the performance budgets can be checked rather than
asserted.

Which packages are installed is a directory listing of
`/usr/share/bm/features/`, not a table in the agent. A package declares itself
by dropping a descriptor there and takes it away in its own `prerm`, so adding
`bm-wanbind` later is a new package and no change here at all.

### `bmctl`

`version`, `info`, `stats`, `schema`, `migrate`, all with `--json`. It reads the
same functions the ubus object does rather than relaying ubus for everything,
because the moment somebody runs it is usually the moment the service is not
answering — `bmctl info` on a router with the service stopped still reports the
version, and says the service is stopped.

### Data that survives an update

Two kinds of file, kept apart on purpose:

- `/etc/config/bm_agent` is an apk **conffile**. Edits survive an update.
- `/etc/bm/` is the agent's own, shipped by no package, so apk neither writes
  nor removes it. Every write is a temporary file and a rename, because the
  failure being guarded against is a power cut rather than a bug.

`/etc/bm/state/meta.json` records the schema the data is written at. It is
deliberately **not** a UCI section and **not** in the snapshot set: restoring an
old schema number over data that has already been migrated is exactly the
corruption snapshots exist to prevent.

### Migrations, before there is anything to migrate

`/usr/share/bm/migrations/` is empty at schema 1, and the runner that reads it is
not. A framework retrofitted after two releases of data are in the wild has to
guess what the first release wrote; this one knows, because every router was
stamped on the way in.

Three rules the loader enforces rather than documents: a step moves exactly one
number, so a router three releases behind can be brought forward and resumed
after a power cut; a step is idempotent, because it runs again after a crash
between the change and the stamp; and there is no `down`, because undoing a
migration correctly needs the data it discarded — the way back is the snapshot
taken before the update.

A build refuses to start against data written at a **newer** schema, and says
so, rather than reading fields that moved.

### Signatures

`bm.signature` verifies a release manifest with `usign`, OpenWrt's own ed25519
tool, against any public key in `/usr/share/bm/keys/`. It fails closed on every
path: no key, no usign, an unreadable signature or a verify that did not return
zero are all "not verified".

No key ships in this release. Generating one is
[`sh scripts/gen-release-key.sh`](../scripts/gen-release-key.sh) and it belongs
to whoever publishes the repository, not to the source. Until a key is
committed and released, a router refuses to update itself over the network — and
the three install paths that do not go over the network keep working, because
each has its own trust root.

### Building and shipping

`PKGARCH:=all`: nothing here is compiled, so one `.apk` installs on every
target. `.github/workflows/packages.yml` builds them, after precompiling every
`.uc` file against the stubs in `packages/ci/stubs/` — which catches a typo, an
unbalanced brace or a name imported from a module that does not export it,
before any of it reaches a router.

`pkg-v*` publishes the `.apk` files, `bm-packages.json`, its signature, and
`bm-packages-<version>.apkbundle` — every package in one base64 text file, which
is how the app installs them onto a router with no internet at all.
