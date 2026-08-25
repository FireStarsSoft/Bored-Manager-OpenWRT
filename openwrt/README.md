# OpenWRT

Monitor and automate one OpenWRT router through Bored Manager's existing SSH
connection. The module does not use LuCI and does not open a second connection:
add the router as a machine, connect to it as `root`, then enable OpenWRT in
Settings → Modules.

## Requirements

**OpenWrt 25.12.0 or newer.** That is the release that replaced `opkg` with
`apk`, and apk is the only package manager this module speaks. **24.10 and every
older release are not supported.** The module refuses to manage such a router
rather than half-managing it, and names the release it found:

```text
This module needs OpenWrt 25.12 or newer. This router runs 24.10.2 and still uses opkg.
```

A router with neither database gets the other sentence - *"No apk package
database on this router. This module needs OpenWrt 25.12 or newer, which
replaced opkg with apk."* Either way the verdict is blocked: nothing is
collected, the Dashboard and Automation pages show the refusal instead of their
contents, and no install form is offered, because the flow that would fix it
speaks a package manager this router does not have.

What decides is the apk database on disk - `/lib/apk/db/installed`, or
`/etc/apk/world` - and never the release string, because a snapshot build calls
itself `SNAPSHOT` and would fail any version comparison while shipping exactly
the apk this needs. It is not the binary in `PATH` either: an apk router keeps
an `opkg` shim that answers `command -v` and then refuses to install anything.
A release number that does parse and is below 25.12 is a warning on the
readiness card rather than a refusal - untested, not unsupported.

Beyond the release, the module cannot run at all without `ubus`, `uci`, `ip` and
netifd. Those are part of the base system, so nothing here can install them: a
router missing one is blocked with the names it is missing. The connection has
to be a direct Bored Manager SSH connection to the router itself, and it should
be `root`: a non-root login is a warning rather than a refusal, but every write
this module makes - UCI, `ifup`, `ip rule`, a package install - needs it.

Everything else is per feature rather than all or nothing. A router missing all
of it still has a working dashboard:

| Feature | Needs | Without it |
|---|---|---|
| Dashboard, interfaces, history charts | nothing beyond the base system above | - |
| DHCP device table, and device discovery generally | dnsmasq | Leases are where devices come from, so the table stays empty. |
| Managed PPPoE pools | fw4 + nft, plus `ppp`, `ppp-mod-pppoe` and kernel PPPoE | The create check refuses and names the piece that is missing. |
| WAN binding | fw4 + nft, `ip rule` support, dnsmasq | The create check refuses; each of the three has its own reason. |
| PPPoE dial errors | `logread` | A failed session still shows as failed, with no reason for it. |

Three of those are package groups the module installs for you from Module
settings: PPPoE support (`ppp ppp-mod-pppoe kmod-pppoe`), policy routing
(`ip-full`) for `ip rule`, and DHCP leases (`dnsmasq`). `logread` is part of the
base system and is not installed from here.

fw4 is the one entry the module will not close for you, and it is deliberately
**not** a blocking requirement. A router still on fw3/iptables keeps its
dashboard, its interfaces and its device table; managed PPPoE pools and WAN
binding both need nftables masquerading and refuse on their own, with that
reason. Installing fw4 underneath a running fw3 would take the firewall down
rather than fix anything, so it is absent from the package allowlist.

Beyond the router itself:

- enough memory for the requested sessions. Budget roughly 1.5–2 MiB per
  `pppd`; 1,000 sessions normally means an x86 router with at least 2 GiB RAM;
- an access concentrator and ISP account policy that permit the requested
  number of simultaneous PPPoE sessions.

The app owns and encrypts the SSH credential; the module never stores a copy.

## Installing

This module is not part of the app download. Install it from **Settings →
Modules**, by any of:

- **Catalog** - pick *OpenWRT* from the reviewed list;
- **GitHub repo** - `FireStarsSoft/Bored-Manager-OpenWRT`, which installs the
  latest release;
- **From file** - the `openwrt-<version>.zip` attached to a
  [release](https://github.com/FireStarsSoft/Bored-Manager-OpenWRT/releases).

It needs Bored Manager **0.4.1** or newer - as well as OpenWrt **25.12.0** or
newer on the router, above - and installs switched off; enable it in the same
place. (The 1.0.x line runs on 0.3.3; the 2.x line uses page blocks that only
0.4.1 has, so an older app refuses it rather than rendering it empty.)
Source, issues and changelog live in
[FireStarsSoft/Bored-Manager-OpenWRT](https://github.com/FireStarsSoft/Bored-Manager-OpenWRT).

## What it adds

| Where | What |
|---|---|
| Sidebar → OpenWRT → Dashboard | Router health, aggregate throughput, seven live tiles with sparklines, four history charts, DHCP clients, every device waiting for a WAN, and the interfaces *outside* the managed PPPoE pool - the first 64 by name, since this table is pushed on every tick. The pool itself is summarised rather than listed: a thousand `pppoe-*` sessions are a number, not a thousand rows, and the page says how many interfaces it is *not* listing. |
| Sidebar → OpenWRT → Automation → PPPoE Dialer | Create, start, stop, redial, inspect, and remove one to thousands of PPPoE sessions from a text file or pasted list. |
| Sidebar → OpenWRT → Automation → WAN Binding | Assign every DHCP client on one selected LAN to one free WAN on one selected carrier, one-to-one. |
| Sidebar → OpenWRT → Automation → Jobs | Live progress cards for chunked operations, per-step timings, and finished-job history. |
| Sidebar → OpenWRT → Automation → Events | Binding, PPPoE and router events in one table. Outside this page they reach the app log and stop there. |
| Sidebar → OpenWRT → Automation → Create | The two check-and-apply forms: a PPPoE batch, a binding instance. |
| Sidebar → OpenWRT → Module settings | Router readiness, Install missing packages, the install job's own progress and finished-job history, Display, and Rules - the scaling and safety numbers. A router shell sits beside the note about fw4, for the few things the module deliberately will not do for you. |
| Overview cards | An optional WAN-pool and binding summary. |
| History | `openwrt`: aggregate WAN, device, receive, transmit, bound, waiting, load and memory values, charted on the dashboard. |

The module installs disabled. It is intentionally scoped to the currently
selected router: another connected router receives a separate module instance and
separate per-host state.

## Router readiness and packages

Module settings opens on **Router readiness**: one card per group - Core,
Firewall & routing, PPPoE dialing, Extras, Install readiness - each listing the
checks behind it and what a missing one costs. It fills in from a single probe
that also reads which package manager the router has, whether the login is root,
and how much room `/overlay` has left.

The probe asks three kinds of question, and the difference between them matters.
A **binary in PATH** is not a working feature - BusyBox `ip` has no `rule`, and
an apk router keeps an `opkg` shim that installs nothing - so wherever it can,
the probe runs the thing instead of looking for it. A binary that is present is
also not a **running service**: dnsmasq stopped still answers `command -v`, and
the only symptom used to be a device table that emptied out under the words "No
active DHCP leases". And a router can have everything and still not do what this
module tells it, which is what *Competing policy routing* is about, below.

Where a question could not be asked, the answer is `unknown` rather than "no".
A router without `pidof` cannot say whether dnsmasq is running, and nothing here
is allowed to turn that into a refusal: an invented fault is worse than a
missing one.

**Install missing packages** sits underneath it, on any router where an install
could run at all - a working router, with apk, logged in as root - and otherwise
says which of those is in the way rather than showing an empty form. Check
reports what is genuinely absent, re-reads free space (a warning under 2 MiB, a
refusal under 512 KiB) and warns if the router has no default route to fetch
from. Apply runs a job: refresh the package index, then one install per package
as its own cancellable step, then a re-probe - which fails the job if the
capability is still missing afterwards, rather than reporting a success the
router does not agree with. That re-probe is also what puts the new capability
into force: the readiness cards go green and the create forms that were refusing
stop refusing. There is no reconnect step, and nothing has to be switched off
and on again.

Free space is read again **between packages**, not only at the check. A group of
three on a router with a few megabytes spare can run the overlay out on the
second one, and apk then reports that as a failed install on a router which is
now also full; the job stops before the command instead, names the package it
did not start, and says that what is already installed stays installed.

**Run the install again** is the last checkbox on the form. Off - the default -
a group the router already reports is skipped, and a form with nothing missing
is refused. On, every ticked group is installed again with the same `apk add`.
The report says plainly what that does and does not do: it puts back a package
that has gone missing, it leaves alone anything apk still considers installed,
and the verify step at the end says which of the two it was. That is narrower
than "repair" sounds, and it is deliberately worded that way - but it is more
than this page had before, which was *"Everything selected is already
installed"* and no path at all.

The same install form appears a second time, on the Automation page's **Create**
tab, whenever something the two forms below it depend on is missing. It is the
same check, the same job and the same allowlist; putting it there is only about
not answering "this needs ip-full" with directions to another page.

Installing needs root, and the only package manager is `apk`: a router still on
opkg is blocked well before this section, for the reasons under *Requirements*,
and never gets the form. A refusal here says which of the four reasons applies -
not probed yet, blocked by something more basic, no apk database, or not root.
One sentence used to send all four to a router shell.

The only verbs generated are `apk update` and `apk add`. `apk upgrade` is
deliberately impossible to produce: the OpenWrt documentation warns that
upgrading every package on a running router can leave it unbootable. A failed
index refresh is a warning rather than an abort, because one unreachable feed
should not cancel an install of packages the router already has cached. Two apk
failures are translated into something to act on: a locked database means LuCI's
Software page is holding it (retried once, three seconds later), and
`breaks: world[...]` means the index and the installed system disagree after a
sysupgrade - which this module reports and deliberately does not repair.

The package names are a fixed table in `main/packages.ts` and nothing else can
reach an install command line - no value typed into a form is ever part of one.
A router that is not ready is re-checked every 30 seconds, but only while a page
that shows readiness is open.

### Competing policy routing

WAN Binding works entirely by `ip rule`, and the **lowest preference wins**. The
fast sweep filters `ip rule show` down to this module's own window on the router
before sending anything back - which is what keeps the sweep small on a router
with a thousand bound clients, and also means a rule *below* that window steers
every packet while appearing nowhere in this module at all. Bindings read as
applied, the dashboard is green, and the traffic leaves by another WAN.

So the probe asks for exactly those rules, filtered and counted on the router,
and reports them on the Firewall & routing card. mwan3 is named separately
because it is the common case by a wide margin: `/etc/config/mwan3` is the
durable evidence and a running `mwan3track` the live one, and somebody with both
installed wants to be told which one is deciding rather than shown a list of
preferences to interpret.

It is a **warning, never a refusal**, on the card and on the WAN Binding check
report alike. A router with deliberate policy routing of its own is a router
somebody set up that way, and this module has no business overruling it. What it
does have business doing is saying so before an apply.

### What each control needs before it will run

Every method the pages can call is listed in `main/requirements.ts`, and
`runtime/handlers.ts` routes all thirty-four through the one gate that reads it.
Before that, the requirements were two hand-written `if` chains inside the two
create handlers: `pppoeBatchApply` would apply a plan the check had refused, and
`bindingStart` on an instance created months ago never asked again whether
`ip rule` still worked - a router that had lost `ip-full` answered a start with
whatever BusyBox prints for a subcommand that does not exist.

| Control | Needs |
|---|---|
| Every table, list and chip - `deviceRows`, `pppoeBatches`, `pppoeRows`, `bindingRows`, `eventRows`, `rulesEffective` | nothing. A table that refuses to render is strictly worse than an empty one that says why |
| Check now / refresh (`sweepNow`), the hints toggle | nothing. It is the only way out of a stale verdict, so nothing derived from that verdict may block it |
| Install missing packages (`setupCheck`, `setupApply`) | nothing. Gating the installer on the packages it exists to install is a loop with no way out; it does its own checking |
| Create a PPPoE batch (`pppoeBatchCheck`, `pppoeBatchApply`) | PPPoE support - Firewall4 present - its ruleset loaded - netifd running |
| Start / stop / redial a session (`pppoeBatchAction`, `pppoeConnAction`) | PPPoE support |
| Create a binding instance (`bindingCheck`, `bindingApply`) and Start (`bindingStart`) | Firewall4 present - its ruleset loaded - `ip rule` support - dnsmasq present - dnsmasq running - netifd running |
| Unassign / Reassign / Pin (`bindingUnassign`, `bindingReassign`, `bindingPin`) | `ip rule` support |
| Rename an instance (`bindingUpdate`), the Rules editor, job bookkeeping | nothing. None of them touches the router |
| Router packages (`agentRows`, `agentInstallCheck`, `agentInstallApply`, `agentUninstallCheck`, `agentUninstallApply`) | nothing, for the same reason the installer needs nothing: these are the flows that put a router into the state everything else asks for. Each does its own checking, in far more detail than a capability flag could carry |
| Stop and Delete (`bindingStop`, `bindingDelete`, `pppoeBatchDelete`) | nothing, deliberately. A pool on a router that has since lost ppp is exactly the pool somebody most wants to be able to delete |

A requirement is worded in exactly one place, so the card, the create form and
the row action cannot describe one router in three vocabularies. Where the fix
is an install, the sentence is the same `installHint` the settings page uses;
where it is a stopped service, it names the service and the command that starts
it, and never offers to install a package that is already there.

`npm run check` fails when the three lists disagree: a method declared in
`module.json` with no entry in `requirements.ts`, an entry for a method the
manifest does not declare, a handler registered with `ctx.handle` instead of
through the gate, or a requirement key that does not exist. That is what makes
"every future feature checks its requirements first" a property of the
repository rather than a line in a document.

### What the pages show while the router is not ready

The same verdict drives the Dashboard, the Automation page and the Overview
widget - the widget carries a one-line form of each - and it has five states:

| State | What you see |
|---|---|
| `connecting` | Nothing is connected yet. A short waiting note; nothing is wrong. |
| `checking` | Connected, first probe still out. A note saying nothing has been read off this router yet, and **Check now**. The router's own rows stay empty until the probe answers, rather than being filled with zeros the module invented. |
| `blocked` | The refusal panel, with the Problem row, instead of the page contents. |
| `attention` | A one-line banner **above a working page**: the figures are real, something optional is missing. |
| `ready` | The page. |

Two more banners appear on a router that is ready but whose collector is not.
One says the numbers are frozen, with the reason and the age of the last good
sample, when the fast sweep has stopped producing samples at all. The other says
only the *interface list* is frozen - the rest of the sweep is still answering,
the interface dump came back unreadable, and the interface table, the WAN tiles
and every WAN state the automation reads are the last list that could be parsed.
Both are better than stale numbers that look live.

## The router-side packages

Everything above is done over SSH, and always will work over SSH. But three
things simply cannot be done from the far end of one, however good the code is:

- **A change that cuts the connection cannot undo itself.** Once SSH is gone
  there is nobody left to type the command that would put it back.
- **Reconciling on an event costs nothing; polling for it costs a round trip.**
  dnsmasq will call a script the moment a lease changes.
- **A pool of thousands of sessions is a lot of shell**, one round trip per
  chunk.

So [`packages/`](../packages/README.md) builds a small agent that runs on the
router, and Module settings has a **Router packages** section that installs,
updates and removes it. A router without one is in **compatibility mode**: it
works exactly as it always did, the Dashboard and Automation pages carry a
banner saying so, and the readiness verdict is `attention` rather than `ready` -
not because anything is broken, but because the difference is worth a banner
rather than a sentence three pages deep.

### Four sources, one execution path

They differ in what they *trust*, not in what they install. Whatever route the
files took, they end as a directory of checksummed archives on the router and a
single `apk add --allow-untrusted`.

| Source | Trusted because | Needs |
|---|---|---|
| The release this module was built against | the sha256 of each file is compiled into the module, so a replaced release cannot be substituted without replacing the module | the router can reach GitHub |
| The latest release, fetched by the router | the release manifest is signed with `usign` and the agent has the public key | an agent already installed |
| A `.apkbundle` from this machine | you chose the file | **nothing** - no internet on the router at all |
| A path on the router | it is already on the router | you put it there |

The bundle is base64 text rather than a binary archive, deliberately: the app's
`file` input hands a module the file's *text*, and whether a binary survives
that trip intact is not something to find out by shipping it. It also means the
whole thing can be pasted into the box beside the picker, so the path does not
depend on any particular browser behaviour.

`apk upgrade` is as impossible to produce here as it is in the other install
flow, and for the same reason.

### The safety net

Once an agent is installed, every job that changes the router's network
configuration runs under the router's own commit-confirm guard: a snapshot and
a countdown before, a confirm after. If the change takes the connection down,
the confirm never arrives and the router restores itself - which is the one
case nothing on this side could ever handle.

The failure path needs no code, and that is the point of how it is wired: the
confirm is the last item of the job, jobs abort at the first failed item, so a
failure means nobody confirms. Nothing has to detect anything.

The guard is added by wrapping the `jobs` object each domain is handed, so
PPPoE and binding build their work exactly as they always did and know nothing
about it. A router with no agent, or one too old to have the call, is handed
straight through with no extra steps at all.

### Removing them

Uninstall refuses while a binding instance is running or a PPPoE pool exists,
and names what to stop first: removing the packages underneath one would leave
its ip rules and its fail-closed catch-all on the router with nothing
maintaining them. It takes a snapshot first, and offers to delete the
configuration and saved state as well - **except the baseline snapshot**, which
is never deleted whatever else is asked for, because it is the only way back to
how the router looked before any of this touched it.

Taking the `ip rule`s off and stopping the services is each package's own
`prerm`, not the module's. `apk del bm-agent` typed at a router shell has to
leave exactly the same router behind as pressing Remove here, and the only way
to promise that is for the module to do nothing the shell would not.

Not every package takes something back, and the difference is the point.
`bm-wanbind`'s ip rules are meaningless without the daemon maintaining them, so
leaving them behind would be worse than never having installed it - its `prerm`
removes them. A PPPoE pool is not like that: the sections live in
`/etc/config/network`, they are the user's own configuration, and netifd dials
them whether or not anything is watching. Removing `bm-pppoe-pool` must not take
somebody's five thousand sessions down with it, so it takes nothing at all.

### Which half does the work

Three states, and the readiness list names all three rather than folding the
middle one into either end:

| The router has | Binding and pools are | The safety net is |
|---|---|---|
| nothing | this module's, over SSH | not available |
| `bm-agent` only | this module's, over SSH | there |
| the feature packages too | the router's own | there |

The middle row is the one that used to have no name. It is not compatibility
mode - snapshots and the commit-confirm guard are working - and it is not fully
set up either, and a person looking at a router that binds a little slowly than
they expected deserves to be told which of the two they have.

When the router is binding, this module plans nothing and writes no ip rule at
all. That is not a preference, it is the only safe arrangement: two writers in
one priority range is worse than either being wrong alone. So a ubus call that
fails means rows one tick stale, never a fall back to writing - the fall back
lives at the capability verdict, where "no package" and "a stopped service" and
"an API version this module does not know" all mean the same thing.

## Automation 1: PPPoE Dialer

The input is one account per line:

```text
# username password [vlan]
account-001 password-001
account-002,password-002,35
account-003|password-003|35
```

Tab, comma, semicolon, pipe, or repeated whitespace can separate fields. Blank
and `#` comment lines are ignored. Uploading a `.txt` file and pasting the same
text are equivalent; uploaded text is read in the browser and sent through the
normal module RPC.

Each row becomes an OpenWRT `config interface` with:

- `proto pppoe`;
- the selected physical carrier or VLAN device;
- its own `ip4table`, derived from the section sequence;
- automatic netifd startup and retry;
- peer DNS and IPv6 disabled, so thousands of sessions do not fight over the
  router's default DNS or IPv6 routes.

The carrier dropdown on this form lists bare devices only - `eth1`, never
`eth1.835`. The VLAN field beside it is what builds the tagged device, so
offering a tagged one would have the batch dial on `eth1.835.100`. WAN Binding
has its own dropdown with the opposite rule; see below.

The check refuses a list before it writes anything. Two of its answers are worth
knowing in advance:

- **A control character in a username or a password is an error**, named by row
  and by field. The value is never quoted back - a password echoed into a check
  report is a password in whatever keeps that report - so re-export the list as
  plain text rather than looking for the offending character in the message. The
  same sieve applies to the batch name and to a binding instance name.
- **A username the router already dials is a warning**, whether it came from an
  earlier batch of this module's or from a `config interface` someone wrote by
  hand. Most access concentrators answer a second session on one account by
  dropping the first, which looks like a flapping line rather than a duplicate.

Creation and control happen in bounded chunks (100 by default) with a delay
between chunks. A 5,000-account import therefore creates about 50 job items,
not 5,000 UI items or 5,000 simultaneous commands. Netifd performs normal PPP
retry; the optional slow watchdog can redial a session that remains failed for
an unusually long time.

A session reads `up`, `dialing`, `error`, `stopped`, `missing` or `unknown`.
`missing` is a session this module has a record for that the router's interface
list does not contain; `unknown` is one that nothing has been read about yet,
which is the state of every session for the first tick after a connect. A
session that stays in `dialing` for five minutes - far longer than any real
PPPoE negotiation, and longer than the inter-chunk delays of the largest create
this module will run - becomes an error with code `DIAL_TIMEOUT`, so the
watchdog can pick it up and the batch chip stops calling it healthy.

Deleting a batch stops its sessions, removes its UCI sections and any VLAN
device nothing else is using, and rebuilds the shared firewall zone around
whatever is left. Deleting the *last* batch takes the zone and its LAN
forwarding off the router entirely rather than leaving an empty one behind.

PPPoE passwords must exist in `/etc/config/network` for netifd to dial. That
file is clear text on the router. Passwords are never copied into Bored Manager
config or host data, returned by a query, emitted in a stream, or placed on a
command line. Protect root access and router backups accordingly.

## Automation 2: WAN Binding

One binding instance owns exactly two scopes:

1. one logical LAN interface whose DHCP leases are watched;
2. one physical WAN carrier whose PPPoE, DHCP, or static WAN interfaces form
   the pool.

An interface cannot belong to two binding instances. Other LAN and WAN
interfaces are not modified.

The carrier here may be a VLAN as well as the device beneath it: many ISPs hand
the uplink over on a tagged VLAN, so `eth1.835` is selectable and is treated as
an uplink of its own - `eth1.835` and `eth1.836` do not overlap, while `eth1`
contains both. A bare bridge is still refused, because a bridge is a LAN rather
than an uplink, but a VLAN riding on one is exactly how a router carrying the
ISP VLAN on the LAN bridge is wired, and that is accepted.

The LAN's firewall zone is read from the router's own firewall configuration
rather than assumed to be `lan`. A router whose LAN zone is named something else
used to get forwarding installed from a zone that does not exist - every session
dialed, and none of them carried client traffic. The check names the zone it
found, and fails when the LAN belongs to no zone at all.

For every active DHCP lease the engine selects one unused, healthy WAN. The
mapping is sticky by MAC when enabled. It installs one source policy rule:

```text
client IPv4 /32 → that WAN's routing table
```

A WAN can serve only one client and a client can use only one WAN. If 1,001
clients compete for 1,000 usable WANs, the extra client enters a FIFO waiting
list. A catch-all unreachable table prevents a waiting client from leaking
through the router's ordinary default WAN. Local router services such as DNS
remain reachable.

Three actions act on one device from the Assignments and Waiting tables.
**Unassign** takes its WAN away and leaves it in the queue; **Reassign** moves
it to another free WAN; **Pin to a WAN** puts it on the one you name. A pin the
router cannot honour is refused rather than approximated - an empty name, a name
that is not in the pool, a WAN another device already carries, a WAN not in a
state to take one, and a selection of several devices for one WAN each come back
with their own reason - because the alternative is a random free WAN, which is
what Reassign already does.

**A pin needs somewhere to be recorded.** On an instance with *Keep a device on
the same WAN* switched on, it is written to the sticky map and survives a
reconnect and an app restart. With that flag off there is nowhere durable to put
it: every reconcile drops the sticky entries of an instance that does not keep
them, so the pin lives in the planner's memory alone and holds only while the
device keeps the lease it was pinned on. Pinning a device that holds no current
lease on such an instance is refused outright, and the refusal names both ways
out - turn the flag on, or pin the device once it is back on the network.

**An instance can be edited after it is created.** Its name and its two flags -
sticky and remap - open pre-filled in a Settings drawer on its row, and saving
writes nothing to the router: the planner reads the new values on its next pass
and the fast tick applies them. The LAN and the carrier cannot be changed. They
are the topology every rule was built from, so moving a running instance to
another LAN would leave its catch-all covering the old subnet and its client
rules written from addresses that are no longer behind it. Delete the instance
and create one for the LAN you want; the refusal says so.

When remapping is enabled, a WAN that stays failed beyond the configured grace
period releases its client to another free WAN. Lease IP changes preserve the
MAC's WAN. Expired leases release their WAN after a separate grace period.
After an app restart, the engine derives current mappings from DHCP leases,
managed `ip rule` entries, and routing-table ownership. After a router reboot,
it reapplies missing rules.

Stopping an instance deliberately keeps its catch-all rule while removing
client rules, so scoped clients lose internet rather than falling through to
an unrelated WAN. Deleting the instance removes both client and catch-all
rules. The catch-all is written with `ip route replace`, one netlink message, so
there is never an instant in which the table is empty and a client that was
pointing at it leaves through the router's own WAN instead.

Every slow tick audits the WAN-to-table map, because a deleted `option ip4table`
survives in the running netifd state until the next reboot and then silently
strands every assignment pointing at it. A table number this module did not
assign is never overwritten - it is reported as a conflict and left alone. A
missing one is rewritten while **Repair WAN routing tables automatically** is on,
and that repair is capped at three rounds per outstanding set: it is `uci set`,
`commit network` and a netifd reload on a production router, so on a box where
the option will not stick the module says so once and stops rather than writing
on every tick forever. With the rule off the audit still runs and still records
what it found.

When a reconcile fails, the tables keep the timestamp of the last pass that
actually reached the router rather than being restamped as fresh, and the tab
shows what went wrong.

While an instance is running, the PPPoE batch on the same carrier cannot be
deleted. The pool it hands out would go and the fail-closed catch-all would
stay, which leaves the scoped LAN with no route out and nothing on screen to
explain it. The refusal names the instance to stop first.

## Real-time data and scale

The browser/server transport is already one WebSocket. Small summaries and
chart points are pushed with module events. Tables that may contain thousands
of rows are requested over that same socket only while visible and are answered
from the server's RAM cache; opening a table never starts another SSH probe.

The two tables that can be genuinely large are split further. A batch drawer and
a binding instance's Assignments each sit behind a two-tab subnav - **Needs
attention** and **All** - and only the open tab is asked for. A 5,000-account
batch is about a megabyte of rows, and a drawer left open re-polls on the fast
interval for as long as it is open.

The fast sweep itself steps down when there is nothing to be fast for. On a
router with no PPPoE batch and no binding instance, and with neither the
Overview widget nor an OpenWRT page open, it runs at the *slow* interval instead:
there is nothing to reconcile, so it would only be feeding a dashboard nobody is
looking at. With either automation configured the rate never changes, because a
reconcile needs every tick and a client stranded on a WAN that has just dropped
costs far more than the sweeps do.

The router side runs one combined command per fast tick:

- system information, aggregate device counters, DHCP leases, and managed IP
  rules every tick;
- `network.interface dump` every tick up to 500 interfaces, every second tick
  up to 2,000, and every third tick above that;
- an immediate dump after configuration or interface actions.

PPPoE device counters are aggregated on the router before crossing SSH, so what
you get is aggregate pool throughput, not a separate throughput graph for every
PPPoE session. At more than 2,000 sessions use the Low (5 second) fast interval,
in the app's own Settings under General → Update intervals.

For more than roughly 1,000 LAN clients, review the findings shown before a
binding instance is applied. They cover:

- dnsmasq DHCP lease limits - the one finding apply can act on for you, with the
  checkbox on the Create tab. Raising them restarts dnsmasq, which briefly
  interrupts DHCP and DNS for the whole router;
- `nf_conntrack_max`;
- neighbor-table garbage-collection thresholds;
- software flow offload, which reduces repeated policy-rule lookups for
  established flows.

The last three are reported with the values to set and are applied at a router
shell.

## Hints

Every form field explains its accepted value, default, unit, and operational
effect. Page-level notes explain each workflow and its warnings. The checkbox
under Module settings → Display turns them off; the preference applies to all
three pages immediately and survives an app restart.

## Persistence and recovery

| Data | Location | Notes |
|---|---|---|
| Module rules and hint preference | `data/user-settings/module-config/openwrt.json` | Shared preference document; no credentials. |
| Batch metadata, binding instances, sticky MAC hints, binding events, PPPoE and router events, finished jobs | `data/module-data/openwrt/<hostKey>.json` | Per router; kept below the 512 KiB module-data limit. A file written by 1.0.x is read as-is; the two event rings are kept apart so binding churn cannot push out the rarer PPPoE and router entries, and each binding instance gets its own share of its ring so one busy LAN cannot empty a quiet instance's drawer. |
| PPPoE interface definitions and passwords | `/etc/config/network` on OpenWRT | Router is the source of truth. |
| Live assignments | `ip rule` plus DHCP leases on OpenWRT | Derived each tick; not duplicated in host data. |

Most writes are debounced by ten seconds. Creating, editing or deleting a batch
or a binding instance is not: that record is the only way the module can ever
find five thousand live PPPoE sections again, and a crash inside the debounce
would bring the module back distributing clients under flags the page it was
changed on has already forgotten. Those go straight to disk.

When the document will not fit, the sticky map is what shrinks first, down to a
floor of 100 entries, and only then the event rings and the job history - a
document is large because of sticky entries, so spending history first sacrifices
the record of what the module did to save something that was never the problem.
A job that has to be trimmed keeps its failures, warnings and cancellations
rather than its first few steps. Batches, binding instances and routing-table
assignments are never candidates; losing one of those loses the router.

Running jobs are in memory and are cancelled when the module stops;
already-running router commands finish. Finished job history is bounded.
Reconciliation, not job resumption, is what restores a correct state after
interruption.

The waiting queue itself is intentionally RAM-only. After an app restart,
active leases that still lack a WAN are queued again in current lease-file
order; existing kernel assignments and sticky MAC choices are preserved, but
the previous FIFO order among waiting clients is not.

## Manual verification

These checks need a real OpenWRT router. They are not covered by the unit suite;
items 1 to 6 are what 2.0.0 changed most, 15 to 19 what 2.1.0 did, 25 to 29
what 2.2.0 did, 30 to 37 what the router packages at 1.3.0 and module 2.3.0 did
together, and 38 to 49 the LuCI app, the two-writer fixes and the standing
promise that the router keeps every capability with no app attached, all in
1.4.0 / 2.4.0.

1. **The probe reads the router correctly.** At a router shell, `for t in ubus uci ip fw4 logread nft netifd pppd dnsmasq opkg apk; do command -v "$t"; done` and compare the result with the cards under Router readiness. Nothing present should be listed as missing. (`command -v ubus uci ip …` on one line is the 1.0.x form, and answers only the first name - that is the bug 2.0.0 fixes, so the two outputs disagreeing is the expected result.) Confirm too that `df -k /overlay` and `id -u` match what the Install readiness card reports.
2. **A 24.10 router is refused, and refused in the right words.** Connect one. Both pages must show the blocked panel - "This router cannot be managed yet" on the Dashboard, "This router cannot be automated yet" on Automation - with the Problem row reading *"This module needs OpenWrt 25.12 or newer. This router runs 24.10.2 and still uses opkg."*, naming the release the router actually runs. Nothing is collected, and **Install missing packages** must offer no form at all, only the sentence saying why. A router with neither package database instead reads *"No apk package database on this router. This module needs OpenWrt 25.12 or newer, which replaced opkg with apk."* - the two are deliberately different, because "no package manager" on a working 24.10 router sends the user hunting for a broken installer instead of at a firmware upgrade.
3. **Installing through apk.** On a 25.12 router that is genuinely missing one of the three groups, run Install missing packages. The job should run `apk update`, then one `apk add` per package as its own cancellable step, then a verify step that re-probes and turns the readiness card green - and the create form that was refusing should stop refusing, without a reconnect. On a snapshot build, `kmod-pppoe` may refuse over a kernel-version mismatch: the job must fail on that step and say so, not report success. Open LuCI's Software page and start an install with it held open: the step should say the database is locked, in words, and succeed on its retry three seconds later once the page is closed. The check report names the commands before you confirm them: they must only ever be `apk update` and `apk add <name>`, and never `apk upgrade`.
4. **A PPPoE batch on a VLAN-tagged uplink.** With the ISP on, say, VLAN 835, the carrier dropdown must offer `eth1` and **not** `eth1.835` - this form builds the tagged device itself. Choose `eth1`, put 835 in the VLAN field, and create a small batch. The router should end up with a `bmv835` device section describing `eth1.835`, every session dialing on that device, and the pool zone claiming `pppoe-<prefix>+` in `nft list ruleset`. Delete the batch afterwards and confirm the VLAN device goes with it once nothing else is using it.
5. **Deleting a batch under a running binding instance is refused.** Create a PPPoE batch on a carrier, create a binding instance on the same carrier, start it, then try to delete the batch. It must be refused by instance name - not queued, not partially executed - because the pool would go while the fail-closed catch-all stayed, leaving the scoped LAN with no route out. Repeat with the batch on the bare `eth1` and the instance on `eth1.835`: those count as the same uplink, and so does the reverse. Stop the instance and the delete should then be accepted.
6. **Pinning a device to a WAN.** From Assignments, pin a device to a named WAN and confirm it moves there and stays there across a lease renewal. Then confirm the refusals, each with its own message: a WAN that is not in the pool, a WAN another device already carries, a WAN that is dialing or in error, and several rows selected at once. Finally, on an instance with *Keep a device on the same WAN* switched **off**, pin a device that holds no lease - that must be refused outright, and the pin of a device that does hold one must be understood to last only as long as that lease.
7. **A cancelled create leaves a correctly shrunk record.** Start a create of several hundred sessions and cancel it mid-way. The firewall zone should already exist - it is prepared before the first chunk - and the batch record must cover exactly the chunks that reached `uci commit network`, including any chunk that committed and then failed its reload. Compare the batch's session count on the page with `uci -q show network | grep -cE "^network\.<prefix>[0-9]{5}=interface$"`. Then delete that batch: it must succeed, removing only what the router actually has, rather than aborting on the first section the create never wrote.
8. **The five readiness states.** Before connecting (`connecting`, a waiting note); while the first probe is still out (`checking`, its own panel saying nothing has been read yet, with Check now); a machine that is not OpenWRT, or a router still on opkg (`blocked`, the refusal panel); a router missing `ip-full` or dnsmasq (`attention`, a banner **above a working page**); and a complete router (`ready`). The failure this replaces was the blocked panel appearing during a normal startup.
9. **Connection.** Add the router as a Bored Manager machine, connect as `root` through dropbear, and confirm a Terminals session works.
10. **Firewall verification.** After creating a PPPoE batch, `nft list ruleset` contains `pppoe-<prefix>` (wildcard `+` on fw4, or explicit `network` members when `zoneMode` is `networks`), the zone masquerades, and the LAN zone's own `forward_<lan>` chain reaches it. Break either half deliberately - rename the LAN zone, or use an fw4 build that does not materialize the glob - and the job's "Register N interfaces with the firewall" step must finish as a **warning** rather than green, naming which half is missing.
11. **Soak.** Create 100, then 500, then 1,000 sessions from a text list. Record apply time, router CPU/RAM, and whether the dashboard stays smooth. Use the Low (5 s) fast interval above roughly 2,000 sessions. Open a batch drawer on the large pool and confirm the **Needs attention** tab is what loads first.
12. **Binding scenarios.** A new DHCP client gets an `ip rule` within two fast ticks and exits through its assigned WAN; a WAN that stays failed remaps after the grace period; an extra client waits with DNS but no internet; a lease IP change keeps the same WAN; a missing lease releases the WAN after its grace; a router reboot reapplies rules and shows a router event; an app restart rebuilds assignments from the router. LAN and WAN interfaces outside the instance stay untouched. On a router whose LAN firewall zone is not named `lan`, the check should name the zone it found rather than assuming one. Remove `option ip4table` from one pooled WAN by hand and confirm the audit repairs it, and that repeating the removal three times ends with the module saying it has stopped trying rather than writing on every slow tick.
13. **The UCI filters.** `uci -q show firewall | grep -E '=zone$|\.name=|\.network='`, `uci -q show network | grep -E '\.(ip4table|username)='`, and the `dhcp`, `network` and `firewall` filters in the binding preparation probe all return what the parsers expect under BusyBox grep, not GNU grep.
15. **A stopped service is not a missing package.** `service dnsmasq stop`. The Extras card must turn amber and read *"Installed, but the service is not running"* with `service dnsmasq start`, **not** "Present" and **not** an offer to install dnsmasq - it is already there. The WAN Binding create form must refuse in the same words. Start it again and both go back to green without a reconnect. Repeat with `service firewall stop`: Firewall & routing turns amber and says no `inet fw4` table is loaded. Then `service network stop` on a router you can still reach - the Core card must show netifd installed but not running, and the page must move to `attention` rather than to the blocked panel.
16. **A router with no `pidof`.** On a build without it, every service row must read *"This router has no pidof, so whether the service is running could not be checked"* and nothing may refuse. An answer nobody could obtain must never become a fault.
17. **Competing policy routing.** Install and enable mwan3. The Firewall & routing card and the WAN Binding check must both warn, name mwan3, say that the lowest preference wins, and **still let the check through** - it is a warning, not a refusal. Then remove mwan3 and add a rule of your own below the module's base, e.g. `ip -4 rule add from 192.168.9.0/24 lookup 42 pref 100`: the warning must name the preference and the rule text, and the count must be the number of such rules on the router, not the number shown. Delete it and the row goes back to green.
18. **The gate is one gate.** With `ip-full` removed from a router that has a binding instance, **Start** must be refused by name - "The ip command on this router has no rule support" plus where to install it - rather than failing somewhere inside a reconcile. Check a PPPoE batch on a healthy router, then remove `ppp` before pressing Apply: the apply must be refused, because a token is not permission for a router that has changed. **Stop**, **Delete** and the Rules editor must keep working throughout.
19. **Running the install again, and running out of room.** On a router with all three groups present, a plain check is refused and names the checkbox; with **Run the install again** ticked it plans `apk add` for every ticked group and the report says what that does and does not fix. Confirm the commands are still only `apk update` and `apk add <name>`. Then fill `/overlay` to a few hundred KB free part-way through a three-package group: the job must stop **before** the next `apk add`, name the package it did not start, and say the earlier ones stay installed - not fail inside apk on a router that is now full.

14. **Disable / uninstall.** With the module connected, switch it off and uninstall it. Pollers stop, `data/app.log` shows no leftover `openwrt:` execs, and UCI leftovers remain only if batches or binding instances were not deleted first.

25. **Install the agent from a bundle, on a router with no internet.** Unplug the WAN. Module settings, Router packages, source "A `.apkbundle` from this machine": the check must unpack and checksum it on the router and say nothing has been installed yet; apply must install it and the readiness card must go green without a reconnect. Then edit one byte of the bundle and check again - it must refuse before `apk add` runs, naming the checksum, and take its half-unpacked directory away with it.
26. **The compatibility banner is honest.** On a router with no agent, both the Dashboard and Automation must carry it and everything below it must still work: create a PPPoE batch and a binding instance, and confirm neither refuses. Then install the agent and confirm both banners go without anything being switched off and on again.
27. **The safety net does its job.** With an agent installed, create a binding instance and watch `logread -e bm-agent`: a guard is armed before the write and confirmed after it. Then, mid-apply, `killall -9 sshd` from a console - the confirm never arrives, and the router must restore the snapshot and reload the network on its own within the countdown.
28. **Remove them.** Try with a binding instance running: refused, by instance name. Stop it, remove with "Delete the configuration" **off**, reinstall: the configuration is still there. Remove again with it **on**: `/etc/config/bm_*` and `/etc/bm/` are gone **except `/etc/bm/snapshots/baseline`**, and `ip -4 rule show` has nothing left of this module. Compare against `apk del bm-agent` typed at a shell - the two must leave the same router.
29. **An agent from the future.** Set `apiVersion` higher than this module knows (edit `bm/version.uc` on the router and restart the service). Every page must keep working over SSH, the readiness row must say the module is the thing to update, and nothing anywhere may refuse.

30. **A lease binds before the client has finished asking.** With `bm-wanbind`
    installed and one instance running, plug a laptop in and watch
    `logread -e bm-agent`: the bind line appears while the DHCP exchange is
    still going, not at the next poll. Then `rm /etc/hotplug.d/dhcp/30-bm-wanbind`,
    reload dnsmasq, and confirm binding still works within thirty seconds - the
    reconcile pass is the floor, the hook is the speed.
31. **The catch-all is what makes it one-to-one.** Fill the pool so one client
    has no WAN, and confirm from that client that there is no route at all -
    not a working connection through the router's own WAN. Then
    `ip -4 route show table 253` and check `unreachable default` is there.
32. **Removing it removes the rules.** `apk del bm-wanbind` at a router shell:
    `ip -4 rule show` must have nothing left in the instance's priority range,
    the catch-all must be gone, and table 253 must be empty. Compare against
    pressing Remove in the app - the two must leave the same router.
33. **A password never reaches a command line.** Create a pool of a few hundred
    through `bm-pppoe-pool` and, while it runs, `grep -r pass /proc/*/cmdline`
    on the router. Nothing. Then check `/tmp` holds no account file afterwards:
    the daemon unlinks it before writing a single section.
34. **Removing the PPPoE package leaves every session dialling.** `apk del
    bm-pppoe-pool` with a pool up, then `ifstatus ppp00001` - still up, still
    dialling. This is the opposite of item 32 and deliberately so: those
    sections are the user's own configuration and netifd owns them.

35. **The two halves never both write.** With `bm-wanbind` running, watch the
    module's own traffic (`Jobs`, and `logread -e bm-agent` on the router): the
    module must issue `ubus call bm.wanbind assignments` and never an
    `ip -4 rule add`. Then stop the service on the router - `/etc/init.d/bm-wanbind
    stop` - and confirm the module goes back to writing rules itself within one
    readiness cycle, without a reconnect and without losing a client.
36. **The instance list converges.** Create an instance, then edit
    `/etc/config/bm_wanbind` by hand - change `sticky` to 0 - and wait for the
    slow tick. The module must put it back, because the records are the truth
    and the file is a projection of them. Then delete the instance from the app
    and confirm both its section and its ip rules are gone.
37. **Which half, on the readiness list.** Three routers, three answers: with no
    agent both feature rows read "There is no agent to ask"; with the agent and
    neither package they read "not installed" and say what is slower; with both
    they read what the router is doing instead. None of the three may be red.

38. **The countdown is on every tab.** With `luci-app-bm` installed, open
    Services -> Bored Manager on a phone, in dark mode. Then from a console:
    `bmctl config guard --timeout 120`. Every one of the five tabs must show the
    banner within five seconds, counting down. Press **Keep these changes** and
    it goes; arm it again and let it run out, and the router must restore on its
    own while the banner says it is doing so. Confirm the countdown is right on a
    router whose clock is wrong by a year - it is worked out from the seconds
    remaining, not from a timestamp.
39. **A tab explains itself when its package is missing.** On a router with only
    `bm-agent`, the PPPoE and WAN Binding tabs must say which package is absent
    and what happens without it, not show an empty table. Stop `bm-wanbind`
    without removing it and the WAN Binding tab must still list what is
    configured, say the service is not answering, and tell you how to start it.
40. **The ACL is the shortest one that works.** From a LuCI session:
    `ubus call bm.wanbind lease '{"action":"add","mac":"..","ip":".."}'` through
    the web must be refused - a forged lease event could move any client onto
    any line. So must `bm.pppoe pool_create`, which reads and unlinks a
    caller-named file as root and is an arbitrary delete in /tmp for anyone who
    can call it. `pool_add` does the same job and must work. Every button on
    every tab must work anyway.
41. **Stopping an instance stops it once.** With `bm-wanbind` running, press Stop
    in the app and watch both `Jobs` and `logread -e bm-wanbind`: there must be a
    `bm.wanbind flush` before the config is rewritten, and no `ip -4 rule del`
    from the module at all. Then confirm `ip -4 rule show` has nothing left in
    that instance's range - a disabled instance is one the daemon stops looking
    at, so rules left behind would stay forever.
42. **Two instances do not fight.** Two LANs, two carriers, two instances, both
    running. Leave them for a few minutes and confirm neither loses a client:
    they share a priority base and differ only in their catch-all, so an
    instance that claimed by priority alone would delete the other's rules once
    every thirty seconds.
43. **An older batch still starts and stops.** Create a PPPoE batch over SSH,
    then install `bm-pppoe-pool`, then press Stop on that batch. The router has
    no pool record for it, so the ubus call is refused - and the job must still
    succeed, over SSH, with the sessions actually down. Create a second batch
    now that the package is there and confirm that one goes through the daemon.
44. **Disconnect the app and lose nothing.** The rest of these are one test:
    close the app, or point it at another router, and do a full day's work from
    the router alone. Every one of them has to pass with nothing but a browser
    and a console.
45. **A pool of five thousand, created from a browser.** In LuCI, Create a pool,
    paste five thousand `user<tab>password` lines and watch the counter under
    the box agree before pressing anything. It must report progress in chunks
    and finish; `ubus call bm.pppoe info` must then show five thousand and
    `uci show network | grep ppp00001` the credentials. While it runs, check
    `ps` and `/proc/*/cmdline` on the router: not one password may appear in
    either. Close the browser tab half way through a second, smaller pool and
    confirm what did arrive is a real pool - Delete removes it, and **Add
    sessions** carries on from where it stopped.
46. **Add sessions rather than a second pool.** With a pool `ppp` covering
    1-500, try to create a second one with prefix `ppp` starting at 400: it must
    be refused by name, saying which pool holds that range. Then press Add
    sessions on `ppp`, add fifty, and confirm they are numbered from 00501 and
    that the pool record covers them.
47. **A binding instance, written from LuCI.** Add an instance with a priority
    range of 32: the form must refuse it while you are typing, not after saving.
    Fix it and add it. Then write a broken one by hand -
    `uci set bm_wanbind.bad=instance; uci set bm_wanbind.bad.catch_all_table=254;
    uci commit` - and confirm both the LuCI row and `bmwan check` name the
    reason. It must not simply be missing from the table.
48. **Stop, edit and delete all take the rules off first.** With an instance
    bound to real clients, press Stop in LuCI and confirm `ip -4 rule show` has
    nothing left in its range. Start it again, then Edit and move
    `rule_pref_base`: the same must be true, and there must be exactly one set
    of rules afterwards rather than two. Now stop `bm-wanbind` and press Stop on
    another instance - it must refuse, and name `bmwan flush --instance NAME`.
    Do that at a console, then `bmwan instance delete` the same one, and confirm
    both the section and the rules are gone.
49. **A snapshot that restores somewhere else.** Download a snapshot from the
    Backup tab and open the file: it must be plain `uci export` text with a
    `package` line per package and nothing wrapped around it. Copy it to a
    second router that has never had any of this installed and run
    `uci import < the-file` - it must be accepted.

## Safety and limitations

- Binding is IPv4 only. Disable or separately design IPv6 on a scoped LAN
  if clients must not bypass the selected IPv4 WAN.
- Many Linux policy rules are evaluated linearly. Flow offload is recommended
  at high client counts; benchmark the intended packet rate on the target
  hardware.
- The wildcard firewall zone is verified after creation. If a particular fw4
  build does not materialize it, the create job's firewall step finishes as a
  warning and names the setting: Firewall membership mode, under Module settings
  → Rules, switched to the explicit UCI network list.
- Only firewall4 is supported by the two automations, and it is the one missing
  piece the module will not install for you: putting fw4 under a running fw3
  would take the firewall down rather than fix anything. A router on fw3 is not
  blocked - the dashboard, the tables and the history all work - but PPPoE
  pools and WAN binding refuse to be created on it.
- Only OpenWrt 25.12.0 and newer are supported at all. A router on 24.10 or
  older is blocked with the release it runs; there is no opkg path left.
- The six numbering and firewall-layout rules are locked while a router has
  batches or binding instances - and also while no router is connected at all.
  The second half is deliberate: those records are per router while the rules
  are global, so a disconnected app cannot tell "this router has none" from "we
  cannot see this router", and answering the second as the first renumbers a
  live pool. Connect the router the rules apply to, then change them.
- A pin made on an instance that does not keep the same WAN across reconnects
  lasts only as long as the device's current DHCP lease. There is nowhere
  durable to record it on such an instance; turn *Keep a device on the same WAN*
  on if the choice has to survive.
- On a router with no PPPoE batch and no binding instance, and with no OpenWRT
  page or Overview widget open, the fast sweep runs at the slow interval. Open a
  page, or configure an automation, and it returns to full rate immediately.
- A module cannot watch multiple routers in one page. Add each router as a
  Bored Manager machine and switch machines in the host sidebar.
- Jump-host mode and router-side event daemons are still out of scope.
- Do not pause the fast OpenWRT interval while a WAN Binding instance is
  expected to assign new clients. The settings page warns about this.

## Code map

The point of this section is that someone opening the module in six months knows
which file to open.

```text
module.json         manifest: pages, widgets, streams, method names
main/
  index.ts          the six lifecycle hooks the app drives, and nothing else
  runtime/          the wiring: the object graph, the capability latch, the methods
  probe/            what this router can do, and the readiness verdict
  setup/            the install gate and the install job
  service/          the fast and slow collectors, and the dashboard payload
  pppoe/            the PPPoE dialer, end to end
  binding/          WAN binding, end to end
  uci/              everything written to a router
  store/            the per-router document
  *.ts              what more than one of those folders shares
ui/pages/*.json     the three page specs the app renders
ui/widgets/*.json   the Overview widget spec
```

| Where | Purpose |
|---|---|
| `main/index.ts` | The entry point: the six lifecycle hooks the app drives, and nothing else. |
| `main/runtime/` | The wiring. `container.ts` builds the object graph and writes the dependency objects the domains meet through, `readiness.ts` owns the capability verdict and the poller latch that decides when anything runs at all, `handlers.ts` is every method name the renderer can call. The only folder allowed to know all the others exist. |
| `main/probe/` | The one command that establishes what the router can do, and the pure function that turns its answers into the readiness verdict every surface renders. |
| `main/setup/` | The gate an install has to pass, and the job that runs it. The only place in the module that builds an apk command line. |
| `main/service/` | Adaptive fast/slow collection, the two remote shell commands, the small dashboard payload, and collector health. |
| `main/pppoe/` | Check, create, the action waves and their watchdog, delete, the router inspections, and the rows every surface renders. |
| `main/binding/` | WAN-pool discovery, the pure planner, one-to-one rule reconciliation, the routing-table audit, device actions, and its rows. |
| `main/uci/` | Everything this module writes to a router: legal names, PPPoE lines, the shared firewall zone and its verification, and the only code that executes a `uci batch`. |
| `main/store/` | The bounded, debounced per-router document, and the trimming that keeps it inside its size budget. |
| `main/packages.ts` | The allowlist: every package this module may install, and why. |
| `main/config.ts` | Effective module rules and the hint preference. |
| `main/events.ts` | The PPPoE, router and binding event rings, and the live log stream. |
| `main/jobs.ts` | Cancellable chunk-job progress and history. |
| `main/parse.ts` | OpenWRT output and account-list parsers. |
| `main/options.ts` | Dynamic form choices from the in-memory model - including the two carrier dropdowns and their different rules. |
| `main/queries.ts` | Large table rows built from the in-memory model. |
| `main/badges.ts` | One colour per meaning, for every status shown anywhere. |
| `main/util.ts` | The helpers more than one of the folders above needs. |
| `main/records.ts` | The stored shapes, and the caps on them, that two folders share. |
| `main/types.ts` | The shapes the halves above pass between themselves. |

Three rules hold that shape, and all three are what make a file findable rather
than a matter of taste.

**The barrel is the only entrance.** Every folder has an `index.ts`, and a file
in one folder imports `../binding`, never `../binding/reconcile`. That is why
splitting the main half into folders changed no call site at all - every import
path the module and its whole test suite already used still resolves - and why a
folder can be rearranged again tomorrow without touching one. A folder's barrel
is also its public surface: if a name is not exported there, nothing outside the
folder is meant to have it.

**The layering is one-way, and no domain imports another.** `runtime/` may import
anything below it and nothing imports `runtime/` back. Below it are the four
domains that do the work - `service/`, `pppoe/`, `binding/`, `setup/` - then
`probe/`, whose verdict `setup/` and `runtime/` both read, then the shared
libraries (`uci/`, `store/`, and the loose `*.ts` files, which may import each
other), then `@shared/*`.

`pppoe/` contains no mention of `binding/` and vice versa, and neither knows
`service/` exists. Where two of them genuinely need each other - the PPPoE
delete asking which carriers a binding instance is running on, the binding
engine asking the collector for a fresh interface dump - they meet
through a small dependency object written in `runtime/container.ts` and passed in
at construction. That file is the only place in the module where all the domains
appear together, and it is where to look first for how any two of them interact.

**A big class becomes a runtime record, free functions, and a thin facade.** The
mutable state lives on a small `Runtime` object; each thing the class used to do
is a free function taking that object as its first argument, filed under a name
that says what it does; and the class the rest of the module holds is a facade
over those functions. `binding/runtime.ts` beside `binding/reconcile.ts`,
`binding/devices.ts` and `binding/engine.ts` is the worked example.

**`npm run size` enforces the first rule and the size, in CI.** It fails any file
under `main/` over 600 lines (and warns over 400), any relative import that
reaches past a folder's barrel, and any CRLF - `openwrt/` is hashed byte for byte
by the app that installs it. Its two allowlists exist so that a step can land
with one exception named out loud, and are expected to be empty. The layering
rule is not machine-checked; the barrels and the dependency objects are what
make a violation obvious in review.
