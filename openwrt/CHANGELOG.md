# Changelog

Module versions are independent of the app's. OpenWRT 2.x needs Bored Manager
**0.4.1**, for the `statusCards` and `meter` blocks, badge columns and forms
that open pre-filled, and OpenWrt **25.12** on the router. The 1.0.x line needs
**0.3.3**, for the `subnav` and `note` blocks and the `file` form input.

## 2.4.0

Needs the same Bored Manager **0.4.1** and OpenWrt **25.12 or newer**. Router
packages **1.4.0**, which is where the LuCI app arrives - see
`packages/CHANGELOG.md` for that half.

### Policy routing is tested by asking for the thing it needs

`ip -4 rule show` was taken as proof that a router could do policy routing, and
a stock 25.12 image passes it. Its `/sbin/ip` is a symlink to BusyBox, whose
`ip` answers `rule show` perfectly well and then refuses the only thing this
module ever asks of it:

```
ip: invalid argument '29999' to 'table'
ip: invalid argument '29999' to 'table ID'
```

Every rule and route WAN binding writes names a numeric table. So a router with
no `ip-full` reported **Firewall & routing 3/3 ok**, the install form said
*"Nothing is missing on this router"*, and a binding instance could be created
on it - at which point the firewall half of the apply committed, the routing
half failed on its first line, and the sweep retried it every two seconds for
as long as the instance existed.

The probe now also runs `ip -4 route show table 29999`, which is read-only,
fails on exactly the same argument, and is not an error on a router that has
iproute2. Such a router is now reported as needing `ip-full`, which the install
form has always known how to install and never offered.

The competing-rule row is its own fact now rather than being read off that
verdict. The two were the same question while it meant "`ip rule` answers"; it
does not any more, and a BusyBox `ip` lists rules fine - so the row stayed
useful on precisely the routers where a competing rule is most likely to be
what somebody is hunting for.

### Delete is the way out of a broken state again

`requirements.ts` says Stop and Delete never refuse. Delete refused: it ran one
reconcile pass before removing the record and threw on anything that pass
returned. The pass covers every instance rather than the one being deleted, and
on the router above it could never succeed - so an instance created on a router
the check had called ready could not then be removed, and the reason given was
`repair binding catch-all failed (exit 1)`.

What the failure means now decides, rather than that there was one. On the SSH
half the instance's own catch-all comes off by an explicit command after the
pass, so the pass failing is another instance's problem and the delete
continues, saying so in the log. On the router-owned half it stays fatal: the
flush inside that pass is the only thing that takes the rules off, and dropping
the record there would strand every one of them.

Stop is deliberately not included. It leaves the instance and its catch-all in
place, so "stopped" has to mean the router was told - recording it anyway would
show an instance as stopped while its rules were still steering traffic.

### The catch-all no longer blackholes the router that installs it

Starting a binding instance could take the router off the LAN being bound. It
was one line, and it had been there the whole time.

`ip rule` selects on **source**, and the selector is the LAN's network - which
contains the router's own address on that LAN. Pointed at a table holding
nothing but `unreachable default`, every packet the router itself sent to one of
its own clients came back EHOSTUNREACH: SSH, ping, and dnsmasq's DNS and DHCP
replies. Adding a fib rule flushes the route cache, so it took the session that
installed it with it; the rule is written to the kernel and the zone beside it
is committed, so a reboot brought the state straight back rather than clearing
it. The check step called this safe to apply.

The table now holds the LAN's connected route as well, written before the rule
that selects it so there is no instant in between. Nothing about fail-closed
changes: a client with no WAN yet still finds no default and still cannot leave
through the router's own uplink, which is the only reason the table exists. What
comes back is the traffic that never should have been in it.

Both halves had it, written twice from one design. `bm-wanbind` had it worse -
its config is a conffile and its reconcile re-asserts every thirty seconds, so
recovery there meant failsafe mode and a walk to the router. Both are fixed, and
`tests/unit/openwrt-catch-all-self.test.ts` asserts both the route and the
absence of any default in that table, because a fix that quietly opened the
blackhole would otherwise pass.

### The safety net can now undo what it exists to undo

`bm-guard` snapshots `/etc/config`, and the change most likely to take the
router away is not in there. Two gaps, both closed:

- **An `ip rule` has no UCI representation.** `snapshot.uc` said so out loud -
  rules and routes are captured for a human to read and never restored - so a
  guard could fire, import the configuration that predated the change, report
  success, and leave every rule exactly where it was. The restore now runs
  `bmwan flush` before the reloads, so the daemon rebuilds from what was just
  put back rather than racing it.
- **`uci commit` emits no procd trigger.** `bm_wanbind` and `bm_pppoe` were
  committed and never reloaded, so `bm-wanbind` went on re-asserting the rules
  of an instance the snapshot had just removed. Both are in `SERVICE_FOR` and
  `RELOAD_ORDER` now, after the stack they sit on.

### Smaller

- The binding path created the module's firewall zone with no `list network` and
  no `list device`. A memberless zone matches nothing, so this was cruft rather
  than an outage - but it was committed, it survived reboots, and the removal
  path never took it away. It now claims the same `pppoe-<prefix>+` glob the
  PPPoE path writes, rebuilt from the records so running it twice cannot
  duplicate it. `network` is left alone: in `networks` mode the PPPoE path owns
  that list.
- Deleting the last PPPoE batch tore the zone down while binding instances still
  had committed forwardings naming it as their `dest`. fw4 refuses to load a
  forwarding whose destination zone is missing, and it refuses the whole ruleset
  rather than the one section - so the firewall would not load, on that reload
  and on every boot after it. The zone now stays while anything still points at
  it.

### The half that owns the rules owns them during a change too

2.3.0 gave the sweep a branch: with `bm-wanbind` running the router is asked
rather than planned against, and a call that fails does not fall back, because
two writers in one ip rule priority range is the failure that boundary exists to
prevent.

Start, Stop, Delete and Apply did not have that branch. They called the SSH
reconciler unconditionally, and it was worst on Stop: the fast sweep reads
`ip -4 rule show` whether or not the agent is there, so the daemon's own rules
arrived as the instance's "actual", and stopping it planned a delete for every
one of them - against a daemon that would put them straight back.

They take the same branch now, and on the router-owned half the work is handed
over rather than skipped. Stopping and deleting also flush the instance's rules
*before* its section is disabled, because the daemon drops a disabled instance
when it reads its config and does not remove its rules on the way past.

### PPPoE actions fall back, and binding still does not

These look like the same rule and they are not, so both are now written down
where they are decided.

Binding refuses to fall back for the reason above. Nothing about a PPPoE action
is like that: netifd owns the sections whichever half asks it, and `ifup` and
the daemon's `up` are the same verb. And the daemon only acts on sections
belonging to a pool record it wrote itself - so every batch created before
`bm-pppoe-pool` was installed is refused by name, which is every batch on a
router that gained the package later. Stop failed those jobs and Start and
Redial were dropped in silence while the wave still reported success. They run
over SSH now when the router will not, and a wave is capped at the 500 sections
the daemon accepts rather than being refused whole and re-run.

### Smaller, and one that was silent

- The Router packages table lists `luci-app-bm`, and uninstalling takes its
  translation archives with it - they depend on it, so leaving one behind would
  leave the app behind too. `npm run packages:check` fails the build if a
  language is added without a name in that list.
- A client rule priority range narrower than 64 is refused. It passed every
  check here while `bm-wanbind` refused the instance outright - and refused it
  by leaving it out of its own list, so the binding table showed nothing bound,
  nothing waiting and no error at all.
- The offline bundle carries the LuCI translations. It was assembled from folder
  names, and a translation archive is not named after its folder, so they were
  dropped without a word - installing successfully and simply being in English.

## 2.3.0

Needs the same Bored Manager **0.4.1** and OpenWrt **25.12 or newer**. A router
with no Bored Manager packages behaves exactly as it did on 2.2.0, which is
still most of them; a router that has them now does the work itself, and this
release is mostly about where the line between the two halves is drawn.

### The router does the binding, when it can

`bm-wanbind` sees a lease the moment dnsmasq writes it, binds a client in
constant time, and writes its ip rules over netlink. None of those is something
that can be done from the far end of an SSH connection, so when the agent
reports that package installed, this module stops planning and starts asking.

The rows on every page are unchanged, and that is deliberate: the agent owns the
assignment and this module already reads the interfaces on every sweep, so the
tables are built from the router's answer and the sweep's interface state,
through exactly the same builders the SSH path uses. Nothing above knows which
half answered.

**A call that fails does not fall back**, and it is the one rule here worth
reading twice. Two writers in one ip rule priority range is the failure this
boundary exists to make impossible, so a router that did not answer this tick
means rows one tick stale - which the staleness marker already says - and
nothing else. The fall back happens one level up, at the capability verdict: no
package, a stopped service, or an API version this module does not know all mean
the router is not binding, and the SSH pass runs as it always did.

Unassign, Reassign and Pin go to the router too. `bm-wanbind` gained a
`reassign` call rather than having the module compose one from unassign and
release: releasing would put the client back in the queue and its sticky choice
would hand it straight back the line it just came off, which is not what the
button says.

The instance list the router reads is a projection of this module's own records,
kept in step by one convergent function rather than by a branch in create, start,
stop, rename and delete. That also makes it a repair: a router restored from a
backup, or one that gained the package after the instances existed, converges on
the next pass. An instance being removed has its rules flushed *before* its
section goes - once the section is gone the daemon has no instance for that
priority range and would never look at it again.

### The router writes the PPPoE pools, when it can

Creating a pool of five thousand over SSH is fifty round trips of `uci batch`.
`bm-pppoe-pool` does it in one call, and the credentials get simpler rather than
more careful: the account list is written to a `0600` file made by `mktemp`, the
path is all that travels on the ubus call, and the daemon unlinks it before it
writes a single section. A password is never an argument to anything, on either
side of the connection - which is the same invariant the SSH path already keeps,
reached the same way.

Only the section writing moves. The firewall zone, the record, the verify step
and the whole delete path are this module's either way, because they are things
`bm-pppoe-pool` does not do. Unlike binding this is not a boundary that has to
hold - netifd owns the sections whichever half wrote them - so it is a choice
about cost and about credentials, and a router that loses the package mid-create
fails that create and does the next one the slow way.

Deleting a batch now asks the router to release its own record of the pool
first, so `bmpppoe status` does not go on reporting a pool whose interfaces are
gone. Start, stop and redial go through the agent as one call per wave, and the
daemon refuses any section that is not in one of its own pools - so a call
naming the router's own WAN cannot take it down.

### Which half is doing the work, said out loud

Two new readiness rows, one per feature package. They exist because there is now
a middle state that nothing described: a router with the agent but neither
package has the safety net and does the work over SSH, which is neither
compatibility mode nor fully set up.

Neither row is ever a failure, and on a router with no agent both read `unknown`
rather than `warn` - it has already been told so one row above, and repeating it
twice more as three separate problems is how a readiness list stops being read.

## 2.2.0

Needs the same Bored Manager **0.4.1** and OpenWrt **25.12 or newer**. Nothing
carries over differently, nothing is written to the router by the update, and a
router with no Bored Manager packages installed behaves exactly as it did on
2.1.0 - which is most of them, and the point.

### The router now has a side of its own

The module has always driven a router over one SSH connection. Three things
cannot be done from the far end of one, however good the code is: a change that
cuts the connection cannot undo itself, because there is nobody left to type
the command; reconciling on a lease event costs nothing while polling for it
costs a round trip; and a pool of thousands of sessions is a lot of shell, one
round trip per chunk.

So there are now router packages -
[`packages/`](https://github.com/FireStarsSoft/Bored-Manager-OpenWRT/tree/main/packages)
- and a **Router packages** section in Module settings that installs, updates
and removes them.

A router without them is in **compatibility mode**. It works exactly as it did;
the Dashboard and Automation pages carry a banner saying what is missing, and
the readiness verdict is `attention` rather than `ready` - not because anything
is broken, but because the difference is worth a banner rather than a sentence
three pages deep. Nothing refuses, and nothing was removed.

### Four ways to install them, and why there are four

They differ in what they trust, not in what they install:

| Source | Trusted because | Needs |
|---|---|---|
| The release this module was built against | the sha256 of each file is compiled into the module | the router can reach GitHub |
| The latest release, fetched by the router | the manifest is signed and the agent has the key | an agent already installed |
| A `.apkbundle` from this machine | you chose the file | **nothing at all** |
| A path on the router | it is already there | you put it there |

The third is the one the app can do and the router cannot: a bundle carries
every package as one base64 text file, pushed up the connection that already
exists, unpacked and checksummed on the router before anything is installed. A
router with no internet whatsoever can be set up from it.

Base64 text rather than a binary archive on purpose. The app's `file` input
hands a module the file's *text*, and whether a binary survives that trip
intact is not something to find out by shipping it - and the same property
means the whole bundle can be pasted into the box beside the picker, so the
path does not depend on any particular browser behaviour.

Whatever route the files took they converge on one execution path: a directory
of checksummed archives on the router and one `apk add --allow-untrusted`.
`apk upgrade` remains impossible to produce, here as everywhere else.

### The safety net around every change

With an agent installed, every job that changes the router's network
configuration runs under the router's own commit-confirm guard: snapshot and
arm a countdown before, confirm after. If the change takes the connection down,
the confirm never arrives and the router restores itself.

The failure path needs no code, which is how it is meant to be read: the
confirm is the last item of the job, jobs abort at the first failed item, so a
failure means nobody confirms. Nothing has to notice anything.

It is wired by wrapping the `jobs` object each domain is handed, so PPPoE and
binding construct their work exactly as before and know nothing about it. A
router with no agent, or one too old to have the call, is handed through with
no extra steps and no warning - the banner has already said it once, in the
right place.

### Removing them

Refused while a binding instance is running or a PPPoE pool exists, naming what
to stop: removing the packages underneath one would leave its ip rules and its
fail-closed catch-all with nothing maintaining them. A snapshot is taken first,
and the configuration and saved state can be deleted as well - **except the
baseline snapshot**, which is never deleted whatever is asked for.

Taking the rules off and unhooking `dhcpscript` is each package's own `prerm`,
not the module's, so `apk del` at a router shell leaves exactly the same router
behind as pressing Remove here.

### Also

The probe learned to read the agent in the same round trip as everything else -
ubus first, `bmctl info --json` as the fallback, which is what tells an
installed-but-stopped agent from one that was never there. An agent whose API
version this module does not know is a fall back to SSH with a sentence, never
a failure: an app from last month must not stop a router working because
somebody updated its packages.

`probe/readiness.ts` was split into `text.ts` (the sentences more than one file
says), `checks.ts` (the checklist rows) and the verdict itself. Nothing moved
outside the folder.

### Two things a reading of OpenWrt's own source corrected

**A stock router has no `base64`.** OpenWRT builds BusyBox with
`BUSYBOX_DEFAULT_BASE64` off, and uuencode and uudecode with it, so the one
install path that exists for a router with no internet could not decode its own
bundle. It now decodes with `ucode`'s built-in `b64dec` when there is no base64
command - which costs nothing, since firewall4 is written in ucode and every
default image therefore has the interpreter, and `bm-agent` depends on it
anyway. A router with neither is told which two things are missing rather than
failing at `tar`.

**"Run the install again" now runs it again.** `apk add` on a package apk
already lists is a no-op, which made repair mode able to restore a package that
had gone missing and nothing at all for one whose files were damaged - said
plainly at the time, for want of a verb that could do better. OpenWrt patched
one into apk for 25.12.3 (`--force-reinstall`), so repair uses it, and on an
older router reads apk's own refusal and falls back to the plain command with a
warning that says what it could and could not do. Decided by running it, never
by a version string: a snapshot build calls itself `SNAPSHOT`.

## 2.1.0

Needs the same Bored Manager **0.4.1** and OpenWrt **25.12 or newer** that 2.0.0
does. Nothing carries over differently and nothing is written to the router by
the update. Two things behave differently on a router that was already working:
**a stopped dnsmasq, firewall or netifd is now reported and refused on** where it
used to pass silently, and **every method checks its requirements**, not just the
two create forms.

### Every method checks, not just the two create forms

Requirements used to be two hand-written `if` chains, one inside
`pppoeBatchCheck` and one inside `bindingCheck`. Everything else was ungated. So:

- `pppoeBatchApply` and `bindingApply` would apply a plan their own check had
  refused, because a token was treated as permission on its own;
- `bindingStart` on an instance created months ago never asked again whether
  `ip rule` still worked - a router that had lost `ip-full` answered a start with
  whatever BusyBox prints for a subcommand that does not exist, from somewhere
  in the middle of a reconcile;
- a method added tomorrow arrived with no gate at all, and nothing anywhere
  would notice.

What each of the thirty-four methods needs is now declared in
`main/requirements.ts`, and `runtime/handlers.ts` routes every registration
through the one gate that reads it. The table is in the module README, under
*What each control needs before it will run*.

Three things it deliberately does **not** gate. Reads never refuse - a table
that will not render is worse than an empty one that says why. **Stop** and
**Delete** never refuse, because a pool on a router that has since lost ppp is
exactly the pool somebody most wants to be able to remove. And the installer and
**Check now** never refuse, because gating either on the verdict they exist to
change is a loop with no way out.

`npm run check` gained `npm run requirements`, which fails the build when the
manifest, the handlers and the registry disagree - including a handler that
reaches `ctx.handle` directly instead of going through the gate.

### A binary in PATH is not a running service

The probe read binaries, files and one functional test, and never asked whether
anything was actually running. A router with dnsmasq installed and its service
stopped reported `hasDnsmasq: true`; the lease file went stale, the device table
emptied out under the words "No active DHCP leases", and nothing anywhere said
why.

Three new rows read the state rather than the package: dnsmasq running, netifd
running, and whether fw4's ruleset is actually loaded. Each says what to do -
`service dnsmasq start`, not an offer to install a package that is already
there. A stopped netifd is a `bad` row, because nothing written through UCI
takes effect without it.

Where the question could not be asked at all - a router with no `pidof`, an
`nft` this login cannot run - the answer is `unknown`, and `unknown` never
refuses anything. An invented fault is worse than a missing one.

### The rule that outranks everything, which nothing could see

WAN Binding is nothing but `ip rule`, and the lowest preference wins. The fast
sweep filters `ip rule show` down to the managed window **on the router**, which
is what keeps it small on a router with a thousand bound clients - and also
meant a rule below that window steered every packet while appearing nowhere in
this module. Bindings read as applied, the dashboard was green, and the traffic
left by another WAN.

The probe now asks for exactly those rules, filtered and counted router-side,
and reports them on the Firewall & routing card and on the WAN Binding check.
mwan3 is named separately, since it is the common case by a long way and its
rules only exist while it runs. Both are warnings and never refusals: a router
with policy routing of its own is a router somebody set up that way.

### Installing: run it again, and stop before the overlay fills

**Run the install again** is a new checkbox. Off, nothing changes. On, a group
the router already reports is installed again rather than skipped, which is the
only answer this page ever had for a package that is present and not working -
it used to say *"Everything selected is already installed"* and stop there. The
report is explicit that `apk add` on a package apk already has is a no-op, so
this restores what has gone missing and cannot repair what apk still believes in;
the verify step says which of the two it was.

Free space is read again between packages. A three-package group on a router
with a few megabytes spare could run the overlay out on the second one, which
apk reports as a failed install on a router that is now also full. The job now
stops before the command, names the package it did not start, and says the
earlier ones stay installed.

The install form is also on the Automation page's **Create** tab now, whenever
one of the forms below it is about to refuse for want of a package. Same check,
same job, same allowlist - it is only about not answering "this needs ip-full"
with directions to another page.

The verbs are still `apk update` and `apk add`, and `apk upgrade` is still
impossible to produce.

## 2.0.0

Needs Bored Manager **0.4.1** and OpenWrt **25.12 or newer**. Rules, batches,
binding instances, sticky mappings, events, finished jobs and the `openwrt`
history file all carry over, and the update writes nothing to the router. Four
things deliberately behave differently: **the router must be on OpenWrt 25.12 or
newer**, **a blank rules field now means "leave this rule as it is"** rather than
"put it back to its default", **the fast sweep drops to the slow interval on a
router that has neither automation configured and that nobody is looking at**,
and `hintsToggle` has been replaced by `hintsSet`.

### Breaking: OpenWrt 25.12 or newer, apk only

OpenWrt 25.12.0 replaced opkg with apk. This release speaks apk and drops opkg
rather than carrying both, which is a deliberate narrowing rather than something
that fell out of the rewrite: the install flow is the only part of the module
that talks to a package manager, and keeping the opkg path would mean shipping a
second set of command lines that nothing here can test on a release that is out
of support anyway.

A user still on 24.10 gets one sentence and no module: *"This module needs
OpenWrt 25.12 or newer. This router runs 24.10.2 and still uses opkg."* It is
the Problem row of the blocked panel - "This router cannot be managed yet" on
the Dashboard, "This router cannot be automated yet" on Automation - which both
pages show instead of their contents. Nothing is collected, and **Install
missing packages** never gets past its note, because the form would be offering
to run a package manager the router does not have. A router with neither
database gets a different sentence, *"No apk package database on this router.
This module needs OpenWrt 25.12 or newer, which replaced opkg with apk."* The
two are separate on purpose: "no package manager" on a working 24.10 router
sends the user hunting for a broken installer instead of at a firmware upgrade.

The gate is the apk database on disk - `/lib/apk/db/installed`, or
`/etc/apk/world` - and never a parsed version string, because a snapshot build
calls itself `SNAPSHOT` and would fail every comparison while shipping exactly
the apk this needs. It is not the binary in `PATH` either: an apk router keeps
an `opkg` shim that answers `command -v` and then refuses to install anything. A
release number that does parse and is below 25.12 is only a warning on the
firmware card - untested, not refused.

Only `apk update` and `apk add` can be produced. `apk upgrade` is deliberately
impossible to reach: the OpenWrt documentation warns that upgrading every
package on a running router can leave it unbootable. A failed index refresh is a
warning the job continues past rather than an abort, because one unreachable
feed should not cancel an install of packages the router already has cached. The
two apk failures common enough to name are translated into something to act on:
a locked database is LuCI's Software page holding it, which is why the command
is retried once three seconds later, and `breaks: world[...]` is the package
index disagreeing with the installed system after a sysupgrade - reported, and
deliberately not repaired from here.

### Fixed: most routers were told they had no uci, no ip and no netifd

The capability probe asked one question - `command -v ubus uci ip fw4 logread
nft netifd pppd` - and BusyBox ash's `command -v` builtin describes only its
first operand and discards the rest. POSIX defines a single operand too, so
this was never going to work anywhere `/bin/sh` is ash, which is every stock
OpenWRT. A healthy router answered `/sbin/ubus` and nothing else. `uci`, `ip`
and `netifd` are the module's own blockers, so all three read as missing: the
dashboard and Automation showed the "cannot be managed" panel, every create
form refused, and the advice was to install packages the router already had.
Each tool is now asked for on its own, in a `for` loop.

This is the single most important thing to confirm on a real router, and the
first item under *Manual verification* in the README.

### Requirements are a view now, and the missing pieces can be installed

Module settings opens on **Router readiness**: one status card per group - Core,
Firewall & routing, PPPoE dialing, Extras, Install readiness - each carrying the
checks behind it, what is missing, and what that costs. It replaces thirteen
raw booleans that named a capability and never said what it was for.

To fill it in, the probe reads five things it never read before: which package
manager the router actually has (from `/usr/lib/opkg/status` and
`/lib/apk/db/installed` rather than from `PATH`, because an apk router keeps an
`opkg` shim that answers `command -v` and then refuses to install anything),
whether the login is root, free space on `/overlay`, whether `ip -4 rule show`
really works (BusyBox ships a cut-down `ip` on some targets, and WAN binding is
built entirely on ip rules), and whether dnsmasq is present.

When something installable is missing, a second section appears: **Install
missing packages**, with a checkbox per group - PPPoE support
(`ppp`, `ppp-mod-pppoe`, `kmod-pppoe`), Policy routing (`ip-full`), DHCP leases
(`dnsmasq`). Check reports what is genuinely absent, re-reads free space,
warns below 2 MiB and refuses below 512 KiB, and warns when there is no default
route to fetch from. Apply runs a job: refresh the package index, one install
per package as its own cancellable step, then a re-probe that fails the job if
the capability is still missing afterwards. That re-probe is also what puts the
new capability into force: the readiness cards go green and the create gates
that were refusing stop refusing, without a reconnect and without switching the
module off and on again.

Package names come only from a fixed table in `main/packages.ts`. Nothing typed
into a form reaches a command line, and firewall4 is deliberately not in that
table: a router still on fw3 keeps its dashboard but can host neither
automation, and installing fw4 under a running fw3 would take the firewall down
rather than fix anything.

Installing needs root. Refusals used to send every unready router to a shell
with the same sentence; they now say which of the four reasons applies - not
probed yet, blocked by something more basic, no apk database, or not root.

While a router is not ready, a readiness poller re-checks every 30 seconds -
but only while a page showing readiness is open, so nothing hammers a router
nobody is looking at.

### Fixed: a normal startup looked like a failure

Both pages replaced their entire contents with an error panel whenever the
capability payload carried a `problem`, and "not connected yet" is a problem by
that definition. Opening the module during its first probe therefore showed the
same red panel as a genuinely unsupported router. There are now five states.
`connecting` - nothing to connect to yet - is a quiet waiting note. `checking` -
connected, with the first probe still out - is a state of its own rather than a
shade of either neighbour: it says nothing has been read off this router yet and
offers Check now, with the router's own rows sitting empty beside it until the
probe fills them, because at that moment the honest answer to "what does this
router have" is "nobody has asked it" and not a page of zeros. `blocked`
keeps the panel, `attention` shows a one-line banner **above the working page**,
and `ready` shows the page.

### The pages

**Dashboard.** Router details and system figures side by side; seven live stats
each with a sparkline - DHCP devices, WANs up, WANs failing, devices bound to a
WAN, devices waiting for one, and pool receive and transmit - plus a memory
`meter`; and four history charts - WAN-pool throughput, WAN pool and devices,
devices bound and waiting, router health - which are the first readers of the
`openwrt` history the module has been writing since 1.0.0 and nothing ever
displayed. `bound`, `waiting`, `load1` and `memPct` were added to the series so
the last two charts have something to draw. The first two of those had been
computed and pushed on every tick since 1.0.0 and then thrown away, so a pool
that ran dry overnight left both counters sitting at their current value with no
way to see when the queue had started. Interface and DHCP rows carry status
badges instead of bare words, and elapsed times are sent as epoch milliseconds
for the renderer to count, rather than as strings frozen at collection time.
DHCP devices can be grouped by LAN, by WAN or by binding state and reassigned or
unassigned from the row, and a table beneath them lists every device waiting for
a WAN across all instances, with the reason each one is waiting.

**Automation** is five tabs instead of two pages of stacked forms: PPPoE
Dialer, WAN Binding, Jobs, Events, Create. Running jobs render as status cards
with a step chip each, and a job's drawer has a progress meter and per-step
timings instead of a paragraph of text. **Events** is new, and is the first
place in the app that PPPoE and router events appear at all - before this they
reached `data/app.log` and stopped there. **Create** collects the two check
forms that used to sit at the bottom of the tab they belonged to.

**The two large tables now send only the tab that is open.** A batch drawer and
a binding instance's Assignments both open on **Needs attention** - the failed
and missing sessions, the devices whose WAN is not healthy - with **All** beside
it, and which tab is open reaches the row method as an argument instead of being
filtered in the browser. On a 5,000-account pool the drawer used to push about a
megabyte of rows every fast interval, for as long as it stayed open, whether or
not anyone was reading them.

**Where the copy means "open a router shell", there is a shell.** A `terminal`
block sits under the binding tab's scaling notes, next to the sysctl values this
module deliberately will not write, and under Module settings next to the
sentence about fw4. Both used to be an instruction to go and find one.

**WAN Binding rows gained a third device action.** Unassign takes a device's
WAN away and Reassign only says "not the one it has"; neither could name the
WAN to use. **Pin to a WAN** does, from the Assignments and Waiting tables, and
it is refused rather than approximated: an empty name, a name that is not in the
instance's pool, a WAN another device already carries, a WAN not in a state to
take one, and a multi-row selection for a single WAN each come back with their
own reason and the thing to do about it. The alternative was a near miss - the
planner falls back to a random free WAN, which is Reassign, and the opposite of
what was asked for.

One limit on a pin is worth knowing about. On an instance with **Keep a device
on the same WAN** switched off there is nowhere durable to record the choice:
every reconcile drops the sticky entries of an instance with that flag off, so
the pin lives in the planner's memory alone and holds only for as long as the
device keeps the lease it was pinned on. Pinning a device that holds no current
lease on such an instance is refused rather than silently doing nothing, and the
refusal names both ways out - turn the flag on, or pin the device once it is
back on the network.

**A binding instance can be edited.** Its name and its two behaviour flags -
sticky, and remap after a WAN failure - open pre-filled in a Settings drawer on
its row and are saved without touching the router; the planner reads them on its
next pass, so the fast tick applies them. The LAN and the carrier are not
editable, and the refusal says why rather than leaving the fields greyed out:
the catch-all and every client rule were installed for that exact pair, so
moving a running instance to another LAN would leave the catch-all covering the
old subnet and the client rules written from addresses no longer behind it - one
device keeping a WAN it can no longer reach, and a new one leaking onto the
router's own. Delete and recreate is the only honest way to do that.

**Module settings** is Router readiness, then Install missing packages - which
carries the form only while there is something installable and says why not
otherwise - then the install job's own progress and the finished-job history,
then Display and Rules. The "Rules in force" list is gone: every field now opens
filled in with the value actually in force, so the form is that list.

**The Overview widget** reads the same verdict rather than its own: the refusal
when the router is blocked, a waiting note while there is nothing connected, a
second one while the first probe is still out, and the one-line banner when
something optional is missing. It also no longer starts the PPPoE collector just
because someone opened Overview.

### Rules

- **A blank field means "keep the current value".** The 22 fields are now four
  smaller forms, and each submission carries only its own group. Merging those
  over the defaults meant saving one group silently reset the other three - the
  check even reported "3 rule override(s) will be saved" while dropping four.
  Merging over what is in force fixes that, and changes what an empty box
  means. Placeholders still name the defaults; **Reset every rule** is how to
  go back to them, and typing a default explicitly still clears one override.
  The check now lists which rules will change, not just how many.
- **New rule `autoRepairTables`** (default on): the slow-tick audit rewrites a
  WAN's missing `option ip4table`. Switched off, the audit still runs and
  records an event instead of writing.
- `hintsSet` replaces `hintsToggle`. A checkbox knows which state it wants; the
  toggle it replaced meant "the opposite of whatever the server currently has",
  which is the wrong answer whenever the page was opened before another surface
  changed it.

### Collection and storage

**A router with neither automation configured, that nobody is looking at, is
swept at the slow interval.** With a PPPoE batch or a binding instance on it the
rate never moves - a reconcile genuinely needs every tick, and a client left
stranded on a WAN that has just died costs far more than the sweeps do - but
with neither, the fast sweep is only feeding a dashboard, and it was still
asking a router over SSH thirty times a minute, for every pooled machine the app
was connected to, with no page open on any of them. The fall-back is the
configured slow interval rather than a number of its own, so the two intervals a
user can actually set are still the only two that exist, and the answer is
re-read on every tab switch, connect and settings change without going back
through a probe.

**The per-router document now gives up the right things when it will not fit.**
Four changes, every one of them visible only when something has gone wrong,
which is exactly when they matter:

- The sticky map is spent before history is. A document is large because of
  sticky entries, so cutting the event rows to 20 and the job history to 3
  almost never made the write fit - it just lost the record of what the module
  had done, permanently, on every flush, to save something that was never the
  problem.
- A trimmed job keeps its failures, warnings and cancellations. The positional
  cap it replaced kept the first few steps, and a 60-chunk job fails at the end
  and succeeds at the front.
- Deleting a binding instance drops the `[wan, table]` assignments its
  preparation wrote. Nothing removed them before, so they stayed for the life of
  the router and kept overriding the WAN-to-table map for every instance created
  afterwards; a document already carrying them heals on its next read.
- Each instance gets its own share of the event ring instead of one shared
  budget. A single reconcile over a busy LAN can push a hundred entries, which
  emptied the drawer of every quieter instance beside it.

**A batch or an instance being created or deleted is written straight through.**
Ten seconds of history is a nuisance to lose; ten seconds covering the record of
a pool that now exists on the router is the router's identity - the app comes
back knowing nothing about five thousand live PPPoE sections, and nothing in the
module can find them again. Everything else still waits out the ten-second
debounce.

### Fixed

- **A firewall verify that found nothing still showed green, and it was only
  asking half the question.** Applying a firewall plan counted `pppoe-<prefix>`
  rules in the live nft ruleset afterwards, and a count of zero was reported as
  success. That count also matches the pool zone's own device glob whether or
  not a single client can reach it - so the failure this check exists to catch,
  a LAN zone read wrongly or assumed to be `lan` on a router that calls it
  something else, produced a clean pass over a pool where every session dialed
  and no client packet crossed. One `nft list ruleset` now answers both
  questions, kept apart by awk: are the pool's devices in a zone at all, and
  does the LAN zone's own `forward_<zone>` chain reach that zone. Job steps can
  finish as `warning`, and each answer is one - the job still completes, but the
  step says which half is missing and names the setting or the zone to check.
- **A cancelled PPPoE create left sessions with no forwarding.** The firewall
  zone was configured after the interface chunks, so cancelling in the middle
  left interfaces on the router that belonged to no zone. The zone is now
  prepared first, and cancel keeps only what committed.
- **Deleting a PPPoE pool could take the LAN behind it off the internet.** A WAN
  Binding instance running on the same carrier spreads LAN clients across that
  pool behind a fail-closed `unreachable` catch-all. Deleting the pool removed
  every WAN the instance was handing out while the catch-all stayed exactly
  where it was, so the scoped clients lost the internet with nothing on screen
  connecting the two. The two automations now meet at one point: delete asks the
  binding side which carriers it is running on and refuses by instance name,
  counting `eth1` and `eth1.835` as the same uplink in both directions.
- **Deleting the last batch rebuilt the shared firewall zone empty.** The zone
  exists to carry this module's sessions, and the delete job rebuilt it whether
  or not any were left - still masquerading, still forwarded to from the LAN,
  and in wildcard mode still claiming `pppoe-<prefix>+` for a prefix no batch
  used any more, which the rebuild had to invent out of the batch it was
  deleting. A router this module has finished with now gets the zone and its one
  named LAN forwarding taken back off. The forwarding goes first, because fw4
  refuses to load one whose destination zone does not exist, and each half is
  only named in the batch if the router actually has it - `uci delete` on a
  section that is not there prints an error and fails the whole run.
- **A duplicate account was only ever looked for inside the pasted list.** Two
  batches made from two exports of the same customer list dial the same account
  twice, and most access concentrators answer the second session by dropping the
  first, which looks like a flapping line rather than a duplicate. The check now
  also compares the list against every PPPoE username already configured on the
  router - the ones the slow probe read out of `/etc/config/network`, plus the
  ones this module put there itself this session - and warns with the names.
- **A control character in a username, a password or an instance name went
  straight through.** `uciQuote` quotes, it does not strip, so a newline inside
  a password survived into `/etc/config/network` and came back out on the line
  `uci batch` echoes when it rejects a command - the one output in this module
  that may never be shown to anyone. The same character in a batch or instance
  name forges a whole line in an event row or the app log. All three are now
  sieved, at the check gate and again at the last point before the value becomes
  a line on `uci batch`'s stdin. The refusal names the field and the row number
  and never the value, because a password quoted back into a check report is a
  password in whatever keeps that report.
- **A chunk that committed and then failed its reload was dropped from the batch
  record.** Which chunks reached `uci commit network` is recorded by the commit
  itself now, rather than inferred from how the job item ended: sections that
  are on the router but whose `network reload` failed are committed, and the
  record has to keep covering them or delete will never remove them. The shrink
  also runs on the failure path instead of only in the job's completion hook,
  which the runner drops when the connected host changed underneath it - and
  when that has happened it is skipped entirely, because by then the document it
  would rewrite belongs to a different router.
- **A create and a delete could run on the same batch at once.** The job runner
  does not serialize jobs, and each of the two was written as though it were the
  only one touching that record: a delete started while a create was still
  committing chunks removed sections the create was about to add, and both jobs
  rewrote the same batch record on their way out. Every batch is now held for
  the life of its job. Delete refuses while a create is in flight and says to
  cancel that job first, a second delete is refused, and batch and
  per-connection actions refuse on a batch in either state rather than acting on
  half a pool.
- **A start or redial wave stopped at its first failure and left the rest of the
  chunk down.** The script ran under `set -e`, so one command that returned
  non-zero - a session netifd had already dropped, a stale name - aborted it and
  every interface after that point in the wave stayed down, with nothing to
  bring it back up. `start` and `redial` now run best-effort per interface and
  are verified afterwards against what netifd actually lists, which is the thing
  that is true immediately: PPPoE takes seconds to dial, so asserting the
  sessions are up would report a false failure. `stop` stays strict - it is the
  action whose failure the user has to hear about.
- **The locked numbering rules could be unlocked by disconnecting.** The six
  rules that say where this module's objects live on a router - table base, the
  two priority bases, the catch-all table, the zone name, the membership mode -
  are locked once batches or binding instances exist. Those records are per
  router while the rules are global, so "no records" read off a disconnected
  context, or off a different machine in the pool, was answered as "none": the
  numbering of a router sitting on a hundred live sessions unlocked, and the
  next create wrote them into a different table range than the one already in
  use. There is a third answer now, `unknown`, and it fails closed - changing or
  resetting a locked rule while no router is connected is refused, and says to
  connect the router those rules apply to.
- **An uplink delivered on a tagged VLAN could not be bound.** The carrier
  dropdown offered bare devices only, so a router whose ISP hands the uplink
  over on `eth1.835` had nothing to select for WAN Binding. Binding has its own
  list now, which takes a tagged device as well: `eth1.835` and `eth1.836` are
  two separate uplinks, `eth1` contains both, and a VLAN riding on the LAN
  bridge is offered where the bare bridge is not. The PPPoE list deliberately
  keeps the old rule - that form takes a VLAN of its own and builds
  `<carrier>.<vid>` itself, so offering it a tagged device would have the batch
  dial on `eth1.835.100`.
- **The LAN firewall zone was hardcoded to `lan`.** A router whose LAN zone is
  named anything else got rules in a zone that does not exist. The slow probe
  now reads the firewall zone map and finds the zone that actually contains the
  selected LAN, warning at check time when it cannot.
- **A PPPoE interface that had been deleted on the router read as "stopped"**,
  which is also what a session a user stopped by hand reads as - and so did
  every session in every batch before the first interface dump had even landed,
  which is a claim about a router nothing had read. Interfaces the module still
  has a record for but that are absent from a sample which *did* list interfaces
  now read `missing`; before there is any list at all they read `unknown`, on a
  deliberately uncoloured chip, because "nothing has been read yet" is neither
  healthy nor wrong. The counts, the batch chips and the attention list keep all
  three apart.
- **A session stuck in `dialing` was a green chip forever.** `dialing` is the
  catch-all of the status reader: netifd lists the section, it is not up,
  nothing is pending and no error code came back. That is what a session dialing
  right now looks like, and also what one whose pppd has been retrying PADO for
  a week looks like, because netifd stops reporting an error for it. With no
  clock behind it the row stayed green, the batch summary counted it busy rather
  than broken, and the watchdog - which only redials `error` rows - never
  touched it. Five minutes in `dialing`, far past any real negotiation and past
  the inter-chunk delays of the largest create this module will run, is now an
  error with code `DIAL_TIMEOUT`. The clock starts on the first sighting and is
  cleared by anything else, so a session that dials, drops and dials again gets
  the full window each time.
- **Collector failures were only ever written to the app log.** The overview
  now carries collector health - which of the fast, slow, dump and hook paths
  last succeeded, when, and the last error - and the dashboard says the numbers
  are frozen, with the reason, instead of quietly showing stale ones.
- **A frozen interface list looked exactly like a live one.** The rest of the
  fast probe can keep answering while the interface dump comes back unreadable,
  and the module then keeps the last list it could parse - which is the right
  thing to do and was completely invisible. The interface table, the WAN up and
  WAN error tiles and every WAN state the automation reads are that old list,
  so both pages now carry a banner that says so, with the reason, the age of the
  last good sample, and what usually causes it.
- **A router reboot emitted a malformed stream message** and only when the ip
  rule probe had succeeded, which is the one condition a reboot tends to break.
  The reboot notice is now a router event, and no longer sits behind that gate.
- **A router that recovered stayed blocked until a reconnect.** The latch that
  remembers "this machine is not manageable" was never cleared when a later
  probe disagreed. Losing its problem now restarts the collectors.
- **The binding preparation probe dumped three whole UCI configs.** `uci -q show
  dhcp`, `network` and `firewall` were fetched in full and mostly thrown away -
  and on a router carrying per-host firewall rules the last of those is larger
  than everything else this module reads put together. Each is now filtered on
  the router down to the keys the parsers actually use, and an output too large
  for one command is detected instead of being parsed as empty, which is the
  same overflow guard the fast sweep got in 1.0.3. The slow sweep, which gained
  a firewall read of its own to find the LAN zone, is filtered the same way and
  carries a fail-closed `UCIOK` sentinel beside it: an empty answer is otherwise
  indistinguishable from a router on which every managed WAN has lost its
  routing table, and that is the condition that triggers rewriting `option
  ip4table` across the entire pool.
- **Running out of WAN preferences was silent.** A client that can never be
  assigned - because every WAN it prefers is taken - now records an event and
  says which of the two reasons it is waiting for in the waiting table.
- **The routing-table repair rewrote the same missing option on every slow
  tick.** A repair is `uci set`, `commit network` and `/etc/init.d/network
  reload` on a production router. The audit latched on the event it had already
  said, not on the write, so on a router where the option would not stick - a
  read-only overlay, a config something else rewrites - the three commands ran
  again every slow tick, silently, for as long as the router stayed that way.
  The latch is on the write now and it is capped at three rounds, which rides
  out a transient failure; past that the condition is standing, one event says
  the repair has stopped and no further write is made. An audit that comes back
  clean clears the latch, so a later loss is news again with its own full quota.
- **A reconcile that failed republished the previous answer with a fresh
  timestamp.** The rows are still pushed - a page with nothing on it says less
  than stale rows that admit they are stale - but they now keep the timestamp of
  the last pass that actually reached the router and carry `hookOk` and
  `lastError` with them, so the binding tab can say the last reconcile did not
  finish and why. A rename or any other change made without going near the
  router republishes without claiming either a new sample or a new verdict, so
  it cannot make a reconcile that is still failing look like it recovered.
- **Re-establishing an instance's catch-all left its table empty for an
  instant.** The fail-closed `unreachable` default was flushed and then added
  back, and every client whose rule already pointed at that table fell through
  to the next matching rule - the main table - and left through the router's own
  WAN for as long as the add took. It is one `ip route replace` now, a single
  netlink message, so there is no moment in which the blackhole is not there.
- **The dashboard's interface table stopped mid-list and said nothing.** Managed
  pool sessions are never rows - they are what the WAN pool tiles count - and
  what is left is cut twice, by a flat row cap and by a byte budget on the
  pushed payload. The overview now carries how many interfaces the router has
  and how many the table is not listing, and the dashboard prints both above it.
  `counts.ifTotal` had been published and drawn nowhere at all.
- **A fast sweep too large for one command retried forever.** Past the
  executor's output cap the whole sample is discarded, and the interface dump -
  the only section that grows with the router, since the rest is filtered or
  aggregated in awk - was asked for again on the very next tick, so nothing ever
  got through and the only remedy on offer was to dismantle a PPPoE pool that
  works. The dump now backs off for the same few ticks an unparseable one does:
  the cheap sections land, and the dashboard keeps moving on the last interface
  list it could read.
- **The fast sweep wrote its `ip rule` output to a predictable path in `/tmp`.**
  `/tmp/.bm-owrt-rules.$$` names a PID, and a PID is guessable, so anything else
  on the router could pre-create that path as a symlink and have the sweep
  truncate whatever it pointed at. It is `mktemp` now, which creates the file
  itself and refuses to reuse one; a `mktemp` that fails leaves the sweep's
  fail-closed rules sentinel reading 0, exactly as a failing `ip` does, rather
  than letting an empty answer be read as an empty rule table.

### Internals

**The main half is eight folders, one per domain.** It was four files carrying
most of it - `binding.ts` at 3,506 lines, `pppoe.ts` at 1,428, `service.ts` at
729, `uci.ts` at 546 - and every bug fix in them began with a hunt. They are now
`runtime/`, `probe/`, `setup/`, `service/`, `pppoe/`, `binding/`, `uci/` and
`store/`, each with an `index.ts` that is its only entrance: a file imports
`../binding`, never `../binding/reconcile`. That barrel is why the split
changed no call site at all - every import path the module and the whole test
suite already used still resolves - and why a folder can be rearranged again
without touching one. `runtime/` is the only folder allowed to know the domains
exist; the domains meet each other through the dependency objects it builds,
never by importing one another. Inside a folder, what used to be a long method
on a large class is a free function taking a small mutable runtime record as its
first argument, with a thin facade for the module to hold. `npm run size` in the
repository is what keeps all of it that way: it fails any file over 600 lines,
any import that reaches past a barrel, and any CRLF in a folder the installing
app hashes byte for byte. The README's **Code map** is the same thing written
for someone opening the repository cold.

`main/util.ts` and `main/records.ts` hold what several files each declared for
themselves: `isRecord`, the IPv4 subnet helpers, the PPPoE batch record, and -
the ones no compiler check was guarding - the job history caps, which existed as
two pairs of plain numbers under two sets of names. The live job-state unions
are now derived from the persisted ones, so a state the store cannot write
cannot be introduced by accident. Seven unused functions were removed, along
with a progress callback that was declared and called but that nothing ever
supplied.

## 1.0.8

- **The module now lives in its own repository** and is installed rather than
  shipped: [FireStarsSoft/Bored-Manager-OpenWRT](https://github.com/FireStarsSoft/Bored-Manager-OpenWRT).
  Bored Manager 0.4.1 is the first release that does not bundle it - get it from
  Settings → Modules (catalog, `FireStarsSoft/Bored-Manager-OpenWRT`, or the
  release zip). An install that already has 1.0.7 keeps working untouched across
  the app update, and updating to 1.0.8 keeps its rules, per-router state and
  history: nothing about the module's behaviour, manifest ids or stored shapes
  changed here.
- README: an Installing section, since the module is no longer in the app
  download, and a link back to the repository.

## 1.0.7

- Fixed: every DHCP lease read as expired on a router whose clock had not
  reached NTP. Lease expiry is an absolute epoch on the router's clock, rebased
  onto the app's using the localtime that `ubus call system info` reports - but
  a router still waiting for NTP does not report one, and the raw router epoch
  was passed on as though it were ours. Both places that read it compare
  against the app's clock, so a router sitting near the start of 1970 made the
  lease table say "expired" for every client and the binding automation skip
  every one of them. There is no offset to recover in that case, so nothing
  pretends there is: the lease counts as active and its remaining time reads
  "unknown" until the router can say what time it thinks it is.

## 1.0.6

- README: the Dashboard row now says which interfaces the page lists. The
  table is the interfaces *outside* the managed PPPoE pool, capped at 64 -
  the pool is summarised, so a thousand sessions are a number rather than a
  thousand rows, and the old wording read as if every interface appeared.
- README: `main/types.ts` was missing from the Files table.

## 1.0.5

- Removed the dead `interfaceRows` and `bindingList` methods. Both were
  declared and handled but no page or widget ever called them - the dashboard
  reads the streamed model and the Automation page has its own row methods -
  so they were untestable surface waiting to rot.

## 1.0.4

- Performance: the module config was re-read from disk and re-validated on
  every `effectiveRules()` call - many times per fast tick, since every batch,
  every rule number and every table poll asks for it. It is now parsed once
  and kept until any connected router's instance of this module writes it.

## 1.0.3

- **Fixed: PPPoE was reported as unsupported on every recent OpenWRT release.**
  Support was read from `opkg list-installed`, and 25.12 - like every main
  snapshot since late 2024 - ships apk instead. On those routers Module
  settings said there was no PPPoE support and Check answered "install ppp,
  ppp-mod-pppoe and kmod-pppoe" for packages that were already installed, so
  no batch could ever be created. Support is now read from the files those
  packages install, which is the same under either manager and also covers a
  pppoe driver built into the kernel.
- **Fixed: a PPPoE batch whose creation was cancelled or failed part-way could
  never be deleted.** The record covered the whole requested range while UCI
  only had the chunks that committed, and `uci delete` on a section that is
  not there prints an error line, which failed the chunk and aborted the job -
  identically on every retry, so the name, the sequence range and any VLAN
  device stayed occupied for good. Delete now removes only what the router
  actually has, and skips the firewall zone when a failed create never got as
  far as adding it.
- **Fixed: a create that aborted left the batch claiming interfaces that were
  never made.** The record is written before the first chunk runs; it is now
  shrunk to the chunks that reached the router, or dropped when none did.
- **Fixed: a fast sweep too large for one command retried forever in silence.**
  Past roughly ten thousand interfaces the output is truncated and the run
  comes back as an overflow, which was parsed as though it had succeeded: the
  dashboard reported zero interfaces, the binding engine ran against an empty
  interface list, and nothing was logged. An overflow is now a sweep failure,
  and an interface dump that cannot be parsed is logged once and backed off
  instead of being requested again on every single tick.
- **Fixed: connecting a machine that is not a router re-probed it over SSH
  forever.** With no capability key recorded for a "not an OpenWRT router"
  answer, every connect, settings change, tab switch and module toggle paid
  for another probe. The answer is now remembered until the connection or the
  intervals change; a probe that failed rather than answered still retries.

## 1.0.2

- **Fixed: manually running Sweep only refreshed the fast model**, leaving
  the WAN binding tables and PPPoE state stale until the next scheduled slow
  probe. Sweep now re-runs the slow probe too.
- **Added: the Router section now has a refresh button and age label for the
  slow probe** (UCI tables, PPPoE log).

## 1.0.1

- **Fixed: the WAN binding engine never ran and PPPoE never sampled.** The fast
  sweep marks whether `ip -4 rule show` succeeded, but it wrote the marker as
  `===RULES_OK===1`, which is not a section header the app recognises (capitals
  only, no underscore, nothing after the closing `===`). The check therefore
  read "failed" on every tick: `skipping binding reconcile` in the log, no
  router model for the binding engine, every binding action answering "no
  router sample is available", and no PPPoE sample. The marker is now its own
  section with its value on the next line.
- **Fixed: past a few thousand sticky WAN assignments nothing was saved at
  all.** How much to keep was worked out against the compact `stickyPacked`
  form, but the raw object went to disk - roughly twice the size - so beyond
  about five thousand entries every flush was refused by the 512 KB cap. The
  store stayed dirty and every batch and binding created afterwards lived only
  in memory until a restart threw it away. The written document is now the one
  that was measured; a file an older build wrote is still read.
- The module is no longer excluded from `npm run typecheck`.

## 1.0.0

- **Direct OpenWRT dashboard.** Router health, aggregate throughput and WAN
  counts are pushed live over WebSocket. Interface and DHCP detail rows travel
  over the same socket only while their tables are visible and are answered
  from the in-memory sample.
- **Bulk PPPoE dialer.** Check and create one to thousands of PPPoE interfaces
  from an uploaded or pasted account list, then start, stop, redial, inspect, or
  remove them in bounded chunks.
- **One-to-one WAN binding.** Assign every DHCP client on one selected LAN to
  one free PPPoE, DHCP, or static WAN on one selected carrier. Sticky mappings,
  waiting clients, failure grace, optional remapping, and reboot reconciliation
  are included.
- **Bounded jobs and detail traffic.** Long operations return immediately as
  cancellable jobs. Small summaries are pushed; thousand-row tables are served
  from RAM only while visible.
- **Operational guidance.** Every field has inline help, page notes explain
  scaling and safety, and Module settings can hide or show all hints.
- **Scale and recovery hardening.** A failed `ip rule` probe no longer looks
  like an empty rule table; firewall rebuilds are serialized and recomputed
  from live host data; binding deletion restores the catch-all on failure;
  sticky persistence shrinks by bytes instead of dropping to 1,000 entries;
  live binding logs emit a short tail; and Unassign holds can be released
  from the waiting table.
