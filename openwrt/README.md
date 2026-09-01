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
collected, the Dashboard and Connection pages show the refusal instead of their
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
| PPPoE Dialer | fw4 + nft, plus `ppp`, `ppp-mod-pppoe` and kernel PPPoE, plus the router packages with `bm-pppoe-pool` 2.x (`kmod-macvlan` only for Direct + auto MAC) | The create check refuses and names the piece that is missing. Pools are owned end to end by the router's own daemon; there is no SSH path for them. |
| WAN binding instances | fw4 + nft, `ip rule` support, dnsmasq | The create check refuses; each of the three has its own reason. |
| Binding 1-1 - one address out one WAN port | fw4 + nft, `ip rule` support | The create check refuses, on those two and on nothing else. dnsmasq is deliberately not among them, because an address typed into the form needs nothing to be leasing for its rule to work; and a binding that names a MAC no lease can be found for is a **warning** on the check wherever the router leaves exactly one interface the forwarding could be written from - the binding is created and its rule appears the moment the device takes a lease. Where two or more interfaces are LAN candidates, that same binding is refused until the device has been seen once, because the forwarding is written from one LAN's firewall zone and with no address there is nothing that says which. dnsmasq is still not a requirement: the refusal is about how many LANs this router has, not about what is installed on it. |
| The binding monitor | nothing beyond the base system: reading rules needs no `ip-full`, since even BusyBox's `ip` answers `ip rule show`. A router blocked on its firmware is not scanned, because the reason is already on screen | Nothing. It describes a router whose policy routing is not what somebody expected, so a capability gate in front of it would be a refusal aimed at the page written to explain refusals. |
| PPPoE dial errors | `logread` | A failed session still shows as failed, with no reason for it. |

Three of those are package groups the module installs for you from Module
settings: PPPoE support (`ppp ppp-mod-pppoe kmod-pppoe`), policy routing
(`ip-full`) for `ip rule`, and DHCP leases (`dnsmasq`). `logread` is part of the
base system and is not installed from here. The router packages have a section
of their own - **Router packages**, under Module settings - and the PPPoE tab
points there whenever the pool daemon is what is missing.

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

It needs Bored Manager **0.7.0** or newer - as well as OpenWrt **25.12.0** or
newer on the router, above - and installs switched off; enable it in the same
place. (The 1.0.x line runs on 0.3.3; the 2.x line and 3.0.0 to 3.2.1 use page
blocks that only 0.4.1 has; from 3.3.0 the Connection page's rail expands in
place and a row's detail opens as a near-fullscreen modal, and both of those
are app features rather than anything a module can ship. An older app refuses
the module rather than rendering it empty.)
Source, issues and changelog live in
[FireStarsSoft/Bored-Manager-OpenWRT](https://github.com/FireStarsSoft/Bored-Manager-OpenWRT).

## What it adds

| Where | What |
|---|---|
| Sidebar → OpenWRT → Dashboard | Four groups on a rail. **Overview**: router health and seven live tiles with sparklines. **History**: four charts at 1 hour, 6 hours or 24 hours. **Devices**: DHCP clients, and every device waiting for a WAN. **Interfaces**: the interfaces *outside* the managed PPPoE pool - the first 64 by name, since this table is pushed on every tick. The pool itself is summarised rather than listed: a thousand `pppoe-*` sessions are a number, not a thousand rows, and the page says how many interfaces it is *not* listing. |
| Sidebar → OpenWRT → Connection → PPPoE Dialer | The dialer expands in the rail into its own three entries, one click from anywhere on the page: **Pools** - every pool the router's daemon holds, member states, throughput, per-row and per-pool actions, the pool charts, and the legacy list; **Create a pool** - one member per VLAN, from a pasted or uploaded list; **Daemon settings** - the counter interval and the redial watchdog, edited on the router where they live. Opening a pool opens its six tabs as a near-fullscreen modal rather than a drawer. |
| Sidebar → OpenWRT → Connection → WAN Binding | Binding expands into six entries: **Overview** - the charts and the aggregate, bound against waiting, free WANs and the two one-to-one counts; **Binding 1-1** - one address nailed to one WAN port by hand; **Instances** - the instances that hand a whole LAN or one address range out one device per WAN; **Create an instance**; **Monitor** - every source-routed address on the router, including the ones this module never wrote; **Behaviour** - the defaults new instances start from. Three of the four tables in the module that open a row as the near-fullscreen modal rather than the right-hand drawer are on this page - **Binding 1-1**, **Instances** and **Monitor** - and the fourth is the pool table on the tab above. It is opted into per table, which is why the number is worth stating: a table that loses the opt-in silently goes back to the drawer. |
| Sidebar → OpenWRT → Connection → Jobs | Live progress cards for chunked operations, per-step timings, and finished-job history. |
| Sidebar → OpenWRT → Connection → Events | Binding, PPPoE and router events in one table. Outside this page they reach the app log and stop there. |
| Sidebar → OpenWRT → Module settings | Six groups on a rail. **Router readiness** with Install missing packages, **Router packages**, **Jobs** - the install jobs' own progress and finished history, **Display & charts** - the hints toggle and the charts' sample interval, **Router limits** - conntrack, the neighbour thresholds and fw4's flow offload, read live and applied with a check-then-apply, and **Advanced rules**, the numbering, the binding monitor's cadence and the housekeeping both automations share. A router shell sits beside the note about fw4, for the few things the module deliberately will not do for you. |
| Overview cards | An optional WAN-pool and binding summary. |
| History | `openwrt`: aggregate WAN, device, receive, transmit, bound, waiting, load and memory values, charted on the Dashboard's own history tabs. This release adds five more - the free WANs and the failed WANs in the binding pools, the sessions dialling, and the one-to-one bindings bound and held - charted on the Connection page, under PPPoE Dialer → Pools and WAN Binding → Overview. |

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

The same install form appears on every tab that creates something, whenever the
automation behind it is missing a package - **Create a pool**, ticked for `ppp`;
**Binding 1-1** and **Create an instance**, both ticked for `ip-full` and
`dnsmasq`. It is the same check, the same job and the same allowlist; putting it
there is only about not answering "this needs ip-full" with directions to
another page. The two binding tabs offer the same two packages because the
verdict is about binding as a whole rather than about one form, and the field
hints are where the difference is said out loud: on Binding 1-1, `ip-full` is
the only thing a create is really gated on, and the hint beside dnsmasq says so.

Which automation is held back is decided in the verdict (`missingFor`) rather
than in the page, because binding is blocked by *either* a missing `ip rule` or
a missing dnsmasq and a page spec cannot ask "either of these two" - the
alternative was the same install section written out twice.

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

### When `ip-full` is installed and policy routing still does not work

"This router cannot steer by routing table" is three faults wearing one
sentence, and only one of them is an install. The probe asks `ip -4 route show
table 29999`, and when that fails it also asks where `ip` resolves and whether a
working iproute2 is sitting beside it unused:

| What the router has | What the card says |
|---|---|
| BusyBox `ip`, no iproute2 | the BusyBox paragraph, and the install form's *Policy routing (ip-full)* box |
| `ip-full` on disk, working when called directly, and `/sbin/ip` still BusyBox | the alternatives link never switched: `ln -sf /usr/libexec/ip-full /sbin/ip` at a router shell, and **no** offer to install it again |
| `ip-full` on disk and the kernel still refusing a numeric table | policy routing is not built into this firmware; no package adds it. A table that merely does not exist yet is not this: iproute2's *"FIB table does not exist"* passes the probe, and when `bm-wanbind` is running the row says the verdict is probably the probe being wrong - the daemon binds over netlink and does not consult `/sbin/ip` at all |

The middle row is why this exists. `apk add ip-full` reports success, the binary
is on disk and answers a numeric table when called by its own path, and `ip`
still means the BusyBox applet - so the capability the install job verifies is
still missing. That used to end at *"still not available after installing; the
router may need a reboot"*, which is the one remedy that cannot help, and the
job finished `partial` however many times it was run.

The install job also asks the router twice now before calling a capability
missing. `refreshCapabilities` joins a probe that is already in flight, and the
readiness poller is guaranteed to be ticking on the page the job was started
from, so a probe sent before `apk add` returned could otherwise answer the
verify step with what was true beforehand.

### Competing policy routing

WAN Binding works entirely by `ip rule`, and the **lowest preference wins**. The
fast sweep filters `ip rule show` down to this module's own window on the router
before sending anything back - which is what keeps the sweep small on a router
with a thousand bound clients, and also means a rule *below* that window steers
every packet while appearing nowhere in the module's own reconcile at all.
Bindings read as applied, the dashboard is green, and the traffic leaves by
another WAN.

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

The card gives a count, which is the right size of answer for a readiness
check. **The binding monitor**, below, is where those rules stop being a number
and become a table: one row per source-routed address on the router, who wrote
it, and where that address actually leaves. Where the readiness card warns that
something else is deciding, the monitor says what it decided.

### What each control needs before it will run

Every method the pages can call is listed in `main/requirements.ts`, and
`runtime/handlers.ts` routes all fifty-seven through the one gate that reads it.
Before that, the requirements were two hand-written `if` chains inside the two
create handlers: an apply would run on a plan its own check had refused, and
`bindingStart` on an instance created months ago never asked again whether
`ip rule` still worked - a router that had lost `ip-full` answered a start with
whatever BusyBox prints for a subcommand that does not exist.

| Control | Needs |
|---|---|
| Every table, list and chip - `deviceRows`, `pppoePools`, `pppoeRows`, `pppoeLegacyRows`, `pppoeCarriers`, `pppoeSettingsGet`, `bindingRows`, `directRows`, `scanRows`, `eventRows`, `rulesEffective` | nothing. A table that refuses to render is strictly worse than an empty one that says why - and the monitor's is the extreme case, since it exists to describe a router whose policy routing is not what somebody expected |
| Check now / refresh (`sweepNow`), the hints toggle | nothing. It is the only way out of a stale verdict, so nothing derived from that verdict may block it |
| Install missing packages (`setupCheck`, `setupApply`) | nothing. Gating the installer on the packages it exists to install is a loop with no way out; it does its own checking |
| Create or edit a pool (`poolCreateCheck`, `poolCreateApply`, `poolSetCheck`, `poolSetApply`) | PPPoE support - Firewall4 present - its ruleset loaded - the pool daemon - netifd running |
| Up / down / redial / enable / disable (`pppoePoolAction`, `pppoeConnAction`), Delete a pool (`poolDelete`), the daemon settings (`pppoeSettingsCheck`, `pppoeSettingsApply`) | the pool daemon. Every one of them is a daemon call now, including delete - see below |
| Create a binding instance (`bindingCheck`, `bindingApply`) and Start (`bindingStart`) | Firewall4 present - its ruleset loaded - `ip rule` support - dnsmasq present - dnsmasq running - netifd running |
| Unassign / Reassign / Pin (`bindingUnassign`, `bindingReassign`, `bindingPin`) | `ip rule` support |
| Create a one-to-one binding (`directCheck`, `directApply`) and switch one back on (`directEnable`) | Firewall4 present - its ruleset loaded - `ip rule` support - netifd running. Deliberately **not** dnsmasq: an instance exists to distribute whatever DHCP hands out, while a binding on a typed address does not care whether anything is leasing at all. A MAC target does need the lease file, and says so as a finding on the check rather than as a refusal here - the device may simply be offline this minute. The **Enabled** checkbox on a row's edit form is the same action arriving by a second door, and is refused on the same terms; see the row below |
| Edit a one-to-one binding (`directUpdate`) | nothing for a rename or a change to *When that WAN is down*. Ticking **Enabled** is a different matter: that save writes the flag and the next pass writes the rule from it, so a save that switches a binding from off to on is held to exactly what the row above needs - Firewall4 present, its ruleset loaded, `ip rule` support, netifd running - and refuses in the same sentence the row's **Enable** button refuses with, because both fetch it from that one entry rather than each wording it. The gate runs *inside* the save rather than in front of it, though, so a rename or a change to *When that WAN is down* in the same submission still lands and the refusal ends by naming what was kept; a form that returned the refusal before reaching the domain threw away edits that needed nothing from the router, on the router where they are most likely to be wanted. Switching a binding off, and every save that leaves it as it already was, stay ungated: the way out of a broken state is never refused, and a running binding arrives at every save with the box already ticked |
| Rename an instance (`bindingUpdate`), the Rules editor, job bookkeeping | nothing. None of them touches the router |
| Scan again (`scanNow`) | nothing. A monitor that refused to look at a router until that router was already understood would be a refusal aimed at the one page written to explain the refusals |
| Router limits (`limitsEffective`, `limitsCheck`, `limitsApply`) | nothing, deliberately. The domain gates itself - no router connected, no slow-sweep reading yet, a conntrack max below the entries in use - because raising a kernel limit is sometimes the fix for the very state a capability gate would refuse on. Who writes is decided per apply: the agent's `tune_set` from packages 2.1.0, SSH before that |
| Router packages (`agentRows`, `agentInstallCheck`, `agentInstallApply`, `agentUninstallCheck`, `agentUninstallApply`) | nothing, for the same reason the installer needs nothing: these are the flows that put a router into the state everything else asks for. Each does its own checking, in far more detail than a capability flag could carry |
| Stop and Delete a binding instance (`bindingStop`, `bindingDelete`), disable and delete a one-to-one binding (`directDisable`, `directDelete`) | nothing, deliberately. An instance - or a binding - on a router that has since lost `ip-full` is exactly the one somebody most wants to be able to remove |

Deleting a pool is the one flow that moved the other way, and on purpose: only
the pool daemon knows everything a pool derived - the sections, the tagged
devices, the zone memberships, the record - so a router that lost
`bm-pppoe-pool` cannot delete a pool until the package is back, and the refusal
says to reinstall it. That is also the only path that ever removes the pool;
netifd keeps dialling the sessions meanwhile, so nothing is stranded by
waiting.

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

The same verdict drives the Dashboard, the Connection page and the Overview
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
works exactly as it always did, the Dashboard and Connection pages carry a
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

| The router has | Binding is | PPPoE pools are | The safety net is |
|---|---|---|---|
| nothing | this module's, over SSH | not available | not available |
| `bm-agent` only | this module's, over SSH | not available | there |
| the feature packages too | the router's own | the router's own | there |

The middle row is the one that used to have no name. It is not compatibility
mode - snapshots and the commit-confirm guard are working - and it is not fully
set up either, and a person looking at a router that binds a little slower than
they expected deserves to be told which of the two they have.

The two automations sit differently in that table, and the difference is
deliberate. Binding predates the packages and keeps its SSH half for ever: a
router that loses `bm-wanbind` falls back at the capability verdict and every
client keeps its WAN. Pools moved to the router entirely at 3.0.0 - the daemon
owns the record, the sections, the firewall and the MACs, and this module is a
client of it. A router without `bm-pppoe-pool` has no pool surface beyond the
sentence saying what to install; the sessions of a pool created before the
package went missing keep dialling regardless, because they are ordinary
netifd configuration.

When the router is binding, this module plans nothing and writes no ip rule at
all. That is not a preference, it is the only safe arrangement: two writers in
one priority range is worse than either being wrong alone. So a ubus call that
fails means rows one tick stale, never a fall back to writing - the fall back
lives at the capability verdict, where "no package" and "a stopped service" and
"an API version this module does not know" all mean the same thing.

## Connection 1: PPPoE Dialer

A pool is one uplink and a list of VLANs, one PPPoE session each - which is the
shape ISPs actually hand these routers: a handful of tagged VLANs on one cable,
often all of them on one shared account that the access concentrator tells
apart by MAC. The router's own daemon, `bm-pppoe-pool`, owns the pool end to
end; this module is a client of it, and so is the router's LuCI page, and so is
`bmpppoe` at a console - one gate, one set of refusals, whichever surface asks.

Two modes, chosen at creation and fixed for the pool's life:

- **One shared account** - the username and password sit on the pool, every
  member dials with them, and every member presents its own derived MAC so the
  BRAS can keep the sessions apart. This is the mode the model exists for.
- **One account per VLAN** - each member line carries its own credentials.

The member list is one line per VLAN:

```text
# vlan [username password]
101
102
35 account-003 password-003
0
```

Tab, comma, semicolon, pipe, or repeated whitespace can separate fields; blank
and `#` comment lines are ignored; uploading a `.txt` file and pasting the same
text are equivalent. VLAN 0 means untagged - the pool dials straight over the
carrier, and only one member can. A pool holds at most 500 members, which is
also why the whole spec travels in one call and a create is never half-done by
a connection that dropped.

Everything else about a member is derived on the router, never stored, and
never spelled twice: prefix `fpt` and VLAN 101 are interface section `fpt101`
dialling as device `pppoe-fpt101` over `eth1.101`, with routing table
`table base + 101` and a MAC hashed from the carrier's own MAC and the pool id.
Deterministic MACs are what make the shared account safe: a pool re-created
after a reboot presents the same addresses, so the BRAS never meets a stranger
and never drops the lot. Each pool also names its firewall zone (pools may
share one); the daemon builds its member list, masquerading and MTU fix, and
writes one forwarding from the LAN zone - found from the router's own firewall
configuration, not assumed to be called `lan`.

The carrier dropdown is served by the router's daemon and offers bare devices
only - `eth1`, never `eth1.835` - because the VLANs are the member list's job.
It refuses bridges, tunnels and already-tagged devices with the same sentences
the daemon would refuse them with. WAN Binding has its own dropdown with the
opposite rule; see below.

The check runs on the router, through the same gate the apply uses, so what the
preview says is what the apply would refuse. Local parse errors are named by
line number; a control character in a credential is an error named by VLAN and
never quoted back - a password echoed into a check report is a password in
whatever keeps that report. Two accounts the same within a pool is a warning
(that is what shared-account mode is for); a VLAN another pool already dials on
the same carrier is a refusal by pool name.

**A pool can be edited.** Members, label, credentials, DNS, MTU, the firewall
switches, the advanced pppd knobs - everything except the prefix and the mode,
which name what the pool is; the refusal for those says to delete and recreate.
A member kept by its VLAN keeps whatever the edit does not restate, so
reshaping the list never means retyping secrets, and the check says which
changes redial sessions - a moved carrier, a changed table base, a new shared
password - with the count of sessions they take down, before anything is
applied.

A member reads `up`, `dialing`, `down`, `error`, `stopped` or `unwritten`.
`stopped` is a member somebody took down or disabled; `unwritten` is one the
record names that has no section on the router - what a create that died half
way leaves behind, and what any later edit of the pool writes out.
**Enable and disable** persist `option auto` on the router, so a disabled
member stays down across reboots rather than dialling again at the next one.
The redial watchdog is the daemon's own - netifd retries a session better than
anything else could, and the watchdog is for the ones it has given up on - and
its patience and batch size are edited on the **Daemon settings** tab, stored
in `/etc/config/bm_pppoe` where the daemon reads them.

Deleting a pool is the daemon's teardown: sessions down, interface sections and
tagged devices removed, zone memberships dropped and the zone with them when
nothing else uses it, record last. This module adds the one gate the daemon
cannot see - a delete is refused by instance name while a running WAN Binding
instance is distributing clients across that pool's carrier, because the pool
would go while the fail-closed catch-all stayed. Pools created by releases
before 3.0.0 appear in a **legacy** list: visible, counted, and delete-only,
because the old model recorded a sequence range and there is nothing safe to
translate it into.

PPPoE passwords must exist in `/etc/config/network` for netifd to dial, and
the pool record in `/etc/config/bm_pppoe` carries them too (the daemon's
install marks that file `0600`). Both files are clear text on the router. Passwords
are never copied into Bored Manager config or host data, returned by a query,
emitted in a stream, or placed on a command line - a spec travels to the router
as a `0600` file that the daemon unlinks as it reads. Protect root access and
router backups accordingly.

## Connection 2: WAN Binding

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

The **DHCP LAN interface** dropdown is built on the same terms the Binding 1-1
**WAN port** list is built on, and for the same reason. It used to drop the
interface literally named `wan` and keep only `proto static`, which was the
device-name guess wearing different clothes: a second ISP or an LTE failover on
`wan2` running static was offered as one of the router's own networks because
the string did not match, while a LAN that takes its own address by DHCP - a
dumb AP, a downstream router - was hidden with nothing on screen to say why. It
now lists every interface carrying an IPv4 address and running `static` or
`dhcp`, this router's uplinks included, and names the protocol on each row
because the list mixes the two. What is still left out is left out on what it
*is* rather than on what it is called: a `pppoe-` netdev has one peer at the
far end and no subnet behind it, so there is no LAN there to hand leases out
on. The rest is the check's business - a form may not read `/etc/config`,
because opening one never starts an SSH command.

Three of the checks that follow speak about the pick, and the three of them
together are the shape of this feature. A LAN with no usable IPv4 subnet is
refused by name. A LAN that `/etc/config/dhcp` switches off with `option
ignore` - which is exactly what a stock router's uplink stub looks like - is a
warning saying the instance would have nothing to bind, because no client on
that interface would ever take a lease. And an interface the router's own
configuration reads as an **uplink** is refused outright, by the same classifier
the Binding 1-1 half uses and in the same shape: the two are one decision read
from opposite ends, and the sentences are written next to each other so they can
never come to disagree. It quotes what it read - a next hop, a firewall zone
that masquerades, an address the public internet routes to, a protocol that
dials or takes a lease - then says what the instance would have done with the
pick, which is the part worth reading: an instance hands a WAN to every DHCP
client it sees on the interface it is given and writes its forwardings from that
interface's own zone, so it would have distributed the pool to whatever sits
upstream of this router rather than to the clients behind it, and laid its
fail-closed catch-all over the uplink's own subnet. It ends with the two
statements that would change the answer - a section in `/etc/config/dhcp`, a
firewall zone that does not masquerade - and with **Refresh now**.

What is deliberately **not** refused is the interface the configuration does not
settle. Where nothing in `/etc/config` says which side of the router an
interface is on, the classifier answers *unclear* and this check says nothing at
all: it will not refuse a pick it cannot justify, so that pick is still yours to
get right. The middle fact stated without the third reads as a stricter module
than this one is, which is why all three are here. The list itself refuses
nothing either, and that is the same principle from the other end - listing an
interface that turns out to be an uplink costs a refusal the operator can read
and act on, while hiding a LAN whose name looks wrong costs them the feature
with nothing on screen to say why.

The LAN's firewall zone is read from the router's own firewall configuration
rather than assumed to be `lan`. A router whose LAN zone is named something else
used to get forwarding installed from a zone that does not exist - every session
dialed, and none of them carried client traffic. The check names the zone it
found, and fails when the LAN belongs to no zone at all.

Which zone that is, is read in every spelling fw4 reads it in, because every
spelling that went unread was a router this module refused while telling it
something untrue about itself. A zone may name its members with `list network`, naming logical
interfaces, or with `list device`, naming the netdevs themselves - an ordinary
way to write a LAN that is not a bridge - and both are searched: `list network`
first, because it is a statement about the interface rather than about the wire
underneath it, and the device pass as the fallback for the zone that made no
such statement. The netdevs an interface answers to are its `device` and its
`l3Device`, and they are passed in from the check and from the apply alike, so
the zone the check approved is the zone the forwarding is written from. `uci
show` then prints a member list two different ways, and both arrive here: one
entry per value for `list network 'lan'` written twice, and a single entry
holding `lan guest` for `option network 'lan guest'`. fw4 splits that one on
whitespace, so this splits it too - compared whole, a token holding two names
matched neither, and a correctly configured router was told its LAN was in no
firewall zone at all.

The refusal that is left is honest about its own reach rather than only about
what it did not find: it says no zone lists the LAN under `list network`, and
then either that none names the interface's devices under `list device` either,
naming them, or that the device names were not available to this check - which
happens when the interface is not in the current sample. The router is not told
it is misconfigured when the reading is what fell short.

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
sticky and remap - open pre-filled under Settings in its row's detail, and saving
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

While an instance is running, the PPPoE pool on the same carrier cannot be
deleted. The WANs it hands out would go and the fail-closed catch-all would
stay, which leaves the scoped LAN with no route out and nothing on screen to
explain it. The refusal names the instance to stop first, and `eth1` and
`eth1.835` count as the same uplink in both directions.

### Binding 1-1: one address out one WAN port

An instance is an automation: it watches a LAN and hands out whatever WANs are
free. A **one-to-one binding** is the opposite of that, and it is what people
ask for when one machine has to leave by one line and no other - a camera
recorder on the metered link, a till on the line the payment processor
whitelisted. It names one target and one WAN port, and nothing about it is
allocated, remapped or released.

The target is an **IP address** or a **MAC address**, chosen per binding. An IP
is its own answer. A MAC is resolved through the router's leases on every pass,
taking that MAC's longest-running lease rather than the first line for it -
a device that has moved from one LAN to another leaves the abandoned lease in
`/tmp/dhcp.leases` until it runs out, and a rule written for the old address
steers nothing while looking, on the page, exactly like a binding that works.
When the lease moves, the pass deletes the rule at the old address and adds it
at the new one. When the device leaves the network altogether, the rule stays
at the last address it was seen at for the same lease-release grace an instance
gives a disappearing device - a laptop that sleeps for thirty seconds should
not lose and regain its WAN - and comes off when the grace expires.

A MAC with no lease at all is a **warning on the create form rather than a
refusal, on a router where only one interface could be the LAN**. There the
address is not needed to know where the forwarding goes, because there is
nowhere else for it to go: the binding is recorded, and its rule appears the
moment the device takes a lease. On a router with two or more candidates - the
ordinary LAN and a guest VLAN, or any interface the classification below leaves
*unclear* - the same create is **refused**, headed *"The device has to be seen
on the network once before it can be bound"* and naming the candidate LANs with
their subnets. That is not a stricter reading of the same rule but a different
question being unanswerable: the forwarding is written once, from the firewall
zone of the LAN the address turns out to be on, and an unresolved MAC gives
nothing to decide between two zones with. Connecting the device once is what
settles it: the check resolves the MAC against the leases the router holds at
that moment, the address answers the question, and the LAN it lands on is
stamped on the record and never derived again. It has to be on the network for
that one check - there is no grace here, unlike on the reconcile pass - and
once the binding exists it may come and go like any other.

The warning itself is worded on that same count, and it is worth saying why. It
used to sit near the top of the report and promise flatly that *"the binding is
created either way"* - a sentence that is true only on the router with one
candidate, and on the router with two the report went on to refuse the create
fifty lines further down. A report is read top to bottom, so the reassurance was
the sentence the operator read first and the refusal the one they reached
second. It now sits below the LAN block, after the count exists, and says one of
three things: that the binding is created either way, where it is; that there is
nothing to say which LAN it belongs to and to connect the device once; or, on a
router with no LAN candidate at all, that the missing lease is not what stops
this binding, since there is no interface for it to be installed on. It never
promises a create that something else in the same report refuses.

The other field is the **WAN port**, and behind both of them sits the one
question this feature cannot afford to get wrong: which of this router's
interfaces are LANs, and which are the way out. The first version of that
decision was a guess about a device name - an interface running `pppoe`, `dhcp`
or `static` whose device did not begin with `br-` was read as an uplink - which
is true of a stock build and of nothing else. A LAN on a VLAN, on a plain port
or on a radio was therefore classified as a WAN, the LAN search came back empty,
and every address on that LAN was refused with *"is not inside any LAN subnet on
this router"*: a sentence about a router the operator does not have, and one
they could do nothing about. The same guess ran the other way in the WAN
dropdown, where it hid the uplink of every router whose modem port is bridged.

So nothing reads a name any more. Each verdict is weighed from statements the
router itself makes - the protocol netifd reports, whether `/etc/config/dhcp`
holds a section actually serving that interface or the stub a stock build ships
to switch itself off with `option ignore`, whether the firewall zone the
interface sits in masquerades, whether it carries a routable address, whether it
delegates an IPv6 prefix, and whether its network section carries an
`option gateway`. Only `pppoe` and `dhcp` settle an interface on their own,
because a router that dials or takes a lease on an interface is a *client* of
the network on the far side of it, and a router is not a client of its own LAN.
The gateway is what places the awkward ones: a statically addressed uplink on a
private address - a bridged modem, a double-NAT lab, an ISP handing out RFC1918
- has no dnsmasq stub and no masquerading zone to read instead, but its next hop
is off this router, and nothing on the inside has one. Where the statements
settle nothing the answer is *unclear*, and that is an answer rather than a
failure: an interface merely not denied is still searched for the address, after
every LAN the router does state, and only the port this binding is about to
leave through is put with the uplinks whatever its configuration says - a WAN
port supplies no firewall *source* zone, so it can never be the LAN a forwarding
is written from. When the address does land on an unclear interface the create
goes ahead and says so, as a **warning** rather than a refusal: it names the
interface, says nothing in the configuration settles it either way - or, on a
check that could not read the configuration at all, says that instead - and
says what the cost would be if it is really an uplink, which is a forwarding
written from the uplink's own zone and a device with no path at all. That is the
shape the whole classifier is for: the module states what it knows, states how
far that goes, and refuses only where the router has actually contradicted the
pick.

Every one of those statements is read the way the router's own daemons read it,
which is a smaller point than it sounds and is where most of these refusals came
back from. There are three readings, and each of them is one legal spelling of a
fact this module used to know only one spelling of.

A `config dhcp` section names its network with `option interface`, or by being
named after it - dnsmasq accepts both, so both count here.

A UCI boolean is true when it says `1`, `on`, `true` or `yes`, all of which fw4
and netifd honour and none but the first of which LuCI ever writes: a firewall
zone enabling masquerading as `masq 'on'` used to read as not masquerading at
all. That is worth two points of uplink evidence on its own, and a third the
other way where some other zone on the router masquerades in a spelling that
*was* read, since a quiet zone beside a masquerading one is one of the things
that says LAN. On a router behind a bridged modem it was enough to get the only
WAN port there is refused with *"is a LAN on this router, not a WAN port"*, and
to leave a permanent warning that that zone *"does not have masquerading
enabled"* against a zone that plainly does. There is now exactly one reader of a
UCI boolean in the module and every one of these callers goes through it - the
classifier, the instance check, the capacity reader and the sweep's parser. It
had been written down four times, and three of the four copies had been applied
to some of their own booleans and not to others, which is how **Router limits**
came to offer to switch on software flow offload for a router already running it
under `flow_offloading 'on'`. A second copy of the right answer is not the fix
for that; one reader is.

And a firewall zone states its membership in more than one shape too - `list
network` or `list device`, and a network list written either as repeated values
or as one space-separated `option network 'lan guest'`. All of those are read,
in the classifier and in the instance check alike, for the reason described under
WAN Binding above: the classifier's two zone readings, *masquerades* and *quiet
zone beside a masquerading one*, are both lost on a zone this module cannot find,
and an interface that loses them is pushed towards *unclear* by a gap in the
reading rather than by anything the router actually said.

Nothing about any of those routers was wrong; the reading of them was.

Both refusals now carry what was looked at. An address in no LAN's subnet names
the LANs the search did look in and the uplinks it skipped, each with its
subnet; an address that turns out to be **on** an uplink is refused by that
interface's name, with the evidence that made it one and with the two statements
- a section in `/etc/config/dhcp`, a firewall zone that does not masquerade -
that would change the answer if the classification is the thing that is wrong.
The **WAN port** dropdown, for its part, filters nothing: it lists every
interface running `pppoe`, `dhcp` or `static`, with the `pppoe` and `dhcp` ones
at the top because those are the two that mean something on their own while
`static` is what every LAN on the router runs as well, and it leaves the
refusing to the check. Each row names the protocol, the device, the address and
whether the interface is up, since a list ordered by a fact it does not print
reads as an arbitrary order. Listing an interface that turns out to be a LAN
costs a refusal the
operator can read; hiding the one they actually need costs them the feature,
with nothing on screen to say why.

There is a **ceiling of 500 rows** on it, and the difference between a ceiling
and a filter is the whole of what that sentence means. The number is about the
control rather than about the router - past a few hundred rows a select stops
being a list anybody can read, and a payload pushed on every form open stops
being small - so which rows fall under it is decided rather than fallen into.
Every interface that is **not** a PPPoE session keeps its place whatever else is
on the router, and the sessions fill what is left, taken in turn over the port
each one dials over. A managed pool at its full five hundred members therefore
cannot push the DHCP uplink beside it off the end, and a single hand-dialed
session on a second port is not buried by a pool on the first; only the tail of
the largest pool is ever dropped, and a pool member is the row least likely to
be the answer here. The plain truncation this replaced did make the cap a
filter, on exactly the router this module is written for: the list was sorted
with `pppoe` at the top and cut at five hundred, so a pool filled it on its own
and every `dhcp` and `static` interface on the router fell off the end with
nothing on screen to say so. That is the original refusal wearing a dropdown
instead of a sentence, which is why the ordering is now something this page can
explain.

The instance form's **WAN carrier** list carries the same ceiling and the same
budget, arrived at the same way. Its rows are devices rather than interfaces, so
the family is read one step away from the row - off the device each PPPoE
session actually dials over - and every bare port, plus every VLAN outside a
dialing port's family, keeps its place unconditionally while the pooled
`eth1.<vid>` rows fill what is left. On a router running five hundred sessions
on `eth1.101` through `eth1.600`, with a second uplink on `wan` and an LTE stick
on `wwan0`, a plain truncation sorted by label kept `eth1` and dropped both of
the others off the end of the alphabet; now the tail of the pool is what falls
and the two uplinks are always there. The pool's own carrier is never dropped
either, because it is one of the bare ports.

A port added since the tab was opened is not in the list, because opening a form
never starts an SSH command - **Refresh now**, at the top of the same tab, is
what puts it there, and it is what the refusals naming a WAN this module has not
seen are asking for. Refresh is the remedy for a port that is not in the
*sample*; it is not the remedy for a port that lost the cap, which is why the
cap was made something no port an operator is likely to want can lose.

Three things are written on the router, in this order:

1. **`option ip4table` on the WAN's network section, if it has none.** The
   number comes from the same allocator the instance half uses, from the
   routing-table base upwards, and a table this module did not assign is never
   overwritten - a WAN already carrying a table keeps it, and a table shared by
   two WANs is a refusal, because a bound address looks up one table and that
   table has to belong to one WAN.
2. **A scoped firewall forwarding**, from the firewall zone of the LAN the
   address turns out to be on to the zone the router already has the chosen WAN
   in, written under this binding's own `bmd<slot>_` section prefix. That prefix
   is what makes removal exact: a delete takes its own sections and cannot reach
   an instance's `bmf<slot>_` ones. Nothing else in `/etc/config/firewall` is
   written, and in particular **no firewall zone is created**. The module's own
   masquerading zone belongs to the instance half, which has a pool to put in
   it; a binding names one WAN section by hand and can never acquire a second,
   so conjuring that zone here only left an empty section on a router with no
   pool and no instance - the one thing a delete never took away again, which
   reads, correctly, as residue. Where the chosen WAN really is a member of that
   zone, the forwarding names it like any other zone and its masquerading is
   left exactly as the pool wrote it. The LAN is not asked for on the form: it
   is derived from which LAN subnet the address falls in, because that is what
   decides the source zone.
3. **The rule**: `ip -4 rule add from <ip>/32 lookup <table> pref <pref>`, at a
   preference from the one-to-one band - 1,000 preferences starting at
   **One-to-one rule priority base** (Module settings → Advanced rules, default
   19000), which sits *below* the client-rule base every instance writes from.

That band placement is the whole trick, and it buys two things at once. The
lowest preference wins, so where an instance has already assigned the same
device a WAN of its own, the hand-placed rule is the one the kernel matches.
And the instance planner starts reading at its own base, so a rule down here is
invisible to it: it cannot adopt a one-to-one binding as one of its assignments
and cannot delete it on the next tick. The band may not overlap the instance
band in either direction - the create check refuses a binding when it would,
naming the instance, and a saved setting that would make the two overlap is
discarded when the rules are next read rather than acted on.

The instance half is told about the binding as well, rather than left to lose
the race: an enabled one-to-one binding's address is excluded from the
instance planner's three paths - it is not adopted from the rules already on
the router, its rule is not kept alive on grace, and it is not queued for a
WAN. A device that already held an instance assignment when the binding was
created therefore loses that assignment on the next tick and frees the WAN it
was holding; it appears in the waiting table with the reason **bound
one-to-one**, which is a statement rather than a complaint.

**When the WAN goes down**, each binding does one of two things, chosen per
binding and defaulting to the first:

- **Hold**, which the form and the row call **Keep it off the internet** (fail
  closed). The rule is **re-pointed at the module's unreachable
  catch-all table**, and that table's `unreachable default` is installed with
  `ip route replace` before anything is aimed at it - safe to repeat, and
  necessary on a router with no instances, where nothing else would have
  written it. The address has no way out until its WAN returns.
- **Fall back**, which the form and the row call **Let it use the default
  connection**. The rule is re-pointed at the **main** table, so the address
  uses the router's ordinary default connection until the WAN comes back. Not
  removed: on a LAN a binding instance owns, that instance's fail-closed
  catch-all would have caught the address the moment the rule went, and the
  option chosen to keep a device online would have taken it off the network
  entirely. A rule that names the main table reaches the default connection
  from underneath any catch-all, and reads the same on a router with no
  instance at all.

Hold is an explicit re-point, and the reason is the single most important
sentence in this section: **a rule whose lookup table has no matching route
does not fail.** The kernel's fib-rule walk simply carries on to the next rule
and out of the main table - the router's default connection. So a "hold" that
left the rule pointing at a dead WAN's empty table would send exactly the
traffic it was supposed to detain out of exactly the link it was supposed to
avoid, while the page said *held*. Pointing it at the blackhole table is what
makes the word true. A held `/32` source rule can never match the router's own
address, so the connected-route hazard that shapes the instance catch-all does
not apply here.

Two more states exist, and both mean the row is telling you something rather
than nothing. **Stranded** is a MAC-target binding whose device has appeared on
a LAN this binding has no firewall path from. The forwarding was written once,
at create time, from the zone of the LAN the address was on then, and nothing
ever rewrites it - so the rule would go on steering the device into the bound
WAN's table while fw4 has no forwarding from the zone it is now in, and every
packet would be dropped while the row said *bound*. A stranded binding is
therefore treated **exactly as though its WAN had gone down**, and it follows
its own **When that WAN is down** setting, both options meaning here exactly
what they mean there: *Keep it off the internet* parks it on the unreachable catch-all table and it has no way
out, while *Let it use the default connection* points it at the main table and
it leaves through the router's ordinary connection until it comes home. What it
is never allowed to become is a binding with no rule at all, which would let the
address out through main by accident - the leak `hold` exists to deny, arrived
at from the other direction. The event row names the LAN it was stamped with,
the address it answers to now, and which of the two it did.

The table row says it too, in two places that cannot disagree. Its first State
chip, *moved off its LAN*, is the condition and is printed whichever setting is
in force. The second is the one that has to be asked rather than
assumed, and it names where the address actually comes out: **no way out** for
the parked half, in the same two words the `held` row uses, and **on the main
table** for the half that fell back, in the same four the `fallback` row uses.
So a stranded row is read with the vocabulary already on the page rather than
with one of its own. That second chip used to read *no firewall path* on both
halves - which is true either way, since the forwarding this binding was stamped
with really is gone - and therefore said nothing about the only difference that
matters here, while reading, on the binding that had fallen back, as though a
device that is online had been taken off the network. That is the misreading
worth naming out loud: a stranded binding set to fall back is **not**
fail-closed, and its traffic is leaving by the ordinary WAN - which for a
recorder on a metered link is the link the binding existed to keep it off.

The **Table** cell answers the same question a second way, and the two cannot
drift apart because both are asked of one predicate: the catch-all table's
number for a parked binding, the word `main` for one that fell back, matching
what `ip rule show` prints for table 254. The Overview's **Held** tile is drawn
from that same predicate rather than from the state word: it counts every
binding whose rule points at the blackhole, which is every `held` one and the
parked half of the stranded ones, and not the half that fell back. Counting the
word alone is what once left a device that had roamed onto another VLAN
overnight sitting on the unreachable table with the tile reporting nothing
detained. There is no tile for the other half yet, and it is worth knowing what
that means before trusting the tiles: a binding out on the router's ordinary WAN
- whether it fell back because its own WAN is down or was stranded and told to
fall back - is counted by **One-to-one bindings** and by neither of the two
tiles beside it, in a residue it shares with the waiting, the disabled and the
shadowed. Subtracting the two from the first therefore gives a number and not an
answer. The table below is where that half is read, from either the chip or the
cell, and it is the surface to check when a device pinned to a metered or
whitelisted line is the thing at stake.

**Shadowed** is the rarer one: two bindings resolved to the same
address, which the create gate cannot always catch because a MAC target created
while its device is offline has no address to compare yet. The lower preference
wins - it is the one the kernel would consult first anyway - and the other row
names it, instead of both claiming to be in force.

A delete undoes the create in reverse, with one exception worth stating rather
than leaving somebody to find with `uci show network`. The rule at its stamped
preference goes first, because it is the thing that steers traffic, and a
failure there is fatal to the delete: dropping the record while the rule stood
would leave nothing on the router that knew the rule existed. Then the
`bmd<slot>_` forwardings, where a failure is logged and the delete carries on -
a leftover forwarding under this slot's own prefix permits traffic the LAN zone
almost certainly permits anyway, and refusing here would leave a binding nothing
can remove. Then the module's **claim** on the routing table, which is a line in
this module's own document rather than anything on the router: dropping it is
this module saying it no longer owns that number, which is what stops the
slow-tick repair that puts a hand-deleted `option ip4table` back from putting
this one back.

What the delete does **not** do is take `option ip4table` back off the WAN's
network section. If the create put it there, it stays. Removing it means
rewriting `/etc/config/network` and reloading netifd - bouncing every session on
that WAN - to tidy away a line that steers nothing by itself, costs nothing to
leave, and is what any second binding or instance on that WAN would want to find
already there. So the mirror is deliberately not exact: the rule, the
forwardings and the claim go, and one `uci` option is left behind on purpose. A
table this module did not assign is never written in either direction, so a WAN
that carried its own `ip4table` before any of this is left exactly as it was.

Switching a binding back on writes a rule, so it is gated exactly as the apply
is - and that is true of both doors, the row's **Enable** button and the edit
form's **Enabled** checkbox, which are one action spelled two ways: the rule is
written while you wait, and if the router will not take it the flag goes back
off and the Save is refused with what the router said. The rest of that same
Save is kept, and the refusal says so - **Binding name** and **When that WAN is
down** reach the router through nothing at all, and undoing a rename because an
`ip rule` would not write is a second surprise stacked on the first. That holds
for both ways a switch-on can be refused, and the second is the one that used to
lose the rename: a router with no `ip-full`, or one whose readiness has not been
read yet, is refused before any command is sent at all, in the same sentence the
row's **Enable** button gives - the two doors may not describe one router two
ways. Where that Save carried something else, the sentence ends by saying the
binding is still off, that no rule was written, and which fields did save.
Switching
the checkbox the other way stays a plain record write for the same reason
inverted: off is how somebody stops the module managing an address, and a save
refused because the removal would not write is exactly the moment they would
have no door left. **Disable and delete are never refused on capability grounds**
either, because a binding on a router that has since lost `ip-full` is exactly
the one somebody most needs to be able to remove.

On a router where `bm-wanbind` owns binding, one-to-one bindings are still
written by this module, into their own band - the two writers never touch the
same preferences. What the daemon cannot do is skip an address: it has no
reserved-address list, so it will also allocate a bound device a WAN from the
pool, one the device never uses and one every surface will show it bound to.
That is a warning on the create form, in those words. One related quirk is
worth knowing at a console: `bmwan flush` removes rules by priority range
alone, so flushing an instance whose stamped base had been allowed to overlap
the one-to-one band would take these rules with it. The band check is what
prevents that overlap existing; the next reconcile puts the rules back either
way.

### An instance can be scoped to an address range

A binding instance normally watches a whole LAN. It can instead watch an
**address range** inside one - `192.168.1.100` to `192.168.1.199` - which is
how a network gets one automated block for the machines that must each have
their own line, while everything else on the same LAN keeps the router's
ordinary connection. Both endpoints have to be IPv4, the start has to be at or
below the end, and both have to sit inside the selected LAN's subnet; each of
those is its own refusal. There is no maximum range size, because nothing
anywhere iterates the addresses in one - every per-device decision is driven by
a lease.

**One instance per LAN is still the rule**, range or whole-LAN, and that is not
a simplification: rule ownership is scoped by LAN subnet, so two instances on
one LAN would delete each other's rules every tick. For the same reason there
is deliberately no cross-instance range-overlap check - two instances can never
be on the same LAN, so their ranges can never see the same address.

The part that had to change is the **fail-closed catch-all**. A whole-LAN
instance writes one catch-all rule covering the LAN's subnet, which is what
stops a device with no WAN of its own leaking out of the router's default
connection. Under a range, that same rule would blackhole every device on the
LAN *outside* the range: the planner only ever assigns leases inside the range,
so nothing else would ever get a rule of its own to outrank it. So a range
instance's catch-all is written as the **minimal set of CIDR blocks covering
exactly the range** - at most 62 of them for any IPv4 range, all at the one
catch-all preference the instance owns, since the kernel is happy with a group
of rules sharing a preference. The per-tick repair compares that preference
group as a **set** - every block present once, at the right table, and nothing
extra - rather than asserting a single rule, which is what would otherwise tear
a hand-built multi-block catch-all back to one whole-LAN rule every thirty
seconds. Router reachability is unaffected: the connected local route stays
scoped to the whole LAN, because reaching the router is a destination question
rather than a source one.

The range is fixed for the instance's life, like its LAN and its carrier, and
the refusal says to delete and recreate. And a range is **refused outright
while `bm-wanbind` owns binding on the router**: the daemon reads its instances
from `/etc/config/bm_wanbind`, whose sections carry a LAN and a carrier and
nothing else, so it would bind the whole LAN while the range existed only in
this module's records. The refusal names the package and both ways out - create
a whole-LAN instance, or remove the daemon and let the module drive the router
itself. Extending the daemon's schema is future work in its own repository.

## The binding monitor

Everything above is about rules this module wrote. The monitor - **Connection →
WAN Binding → Monitor** - is about every source-routed address on the router,
and it exists because the module used to be structurally incapable of seeing
most of them. The fast sweep filters `ip -4 rule show` down to the module's own
preference window *on the router*, which is what keeps a sweep small on a
router with a thousand bound clients and also means a rule below that window
steers every packet while appearing nowhere: bindings read as applied, the
dashboard is green, and the traffic leaves by another WAN.

So the monitor reads the whole table instead, in one round trip:

- the entire `ip -4 rule show`, capped at 500 lines;
- the main table's default routes;
- for each distinct lookup token those rules name, up to 8 route lines, over at
  most 64 tables. The three built-in tokens - `local`, `main` and `default` -
  are skipped: the main table's default already has a section of its own, and
  the other two would spend slots on lines that steer nothing.

Three properties make that safe to run against a production router. The output
is capped on the router, because a reply that overran the executor's output
limit would lose its tail - the sentinel and the routes - and arrive looking
like a clean read of a small rule table. `===SCANOK===` is a fail-closed
sentinel: a router that could not read its own rule table reports a **failed
scan**, and a truncated reply is discarded, because *"this router has no policy
rules"* is the single most misleading sentence this feature could ever produce.
And every table token is validated before it reaches a command line - a name in
`/etc/iproute2/rt_tables` is written by whoever administers the router, so it
is untrusted text arriving in the middle of a shell script.

The reply gets its own parser rather than the sweep's. The sweep's parser
requires a numeric lookup and a `from`, so it drops a rule with a named table
(`lookup vpn`) and every selector-only rule (`fwmark`, `iif`, `oif`) - which is
to say it drops precisely what the monitor exists to find. The monitor keys
rules and routes by the lookup token as text, maps `main`, `default` and
`local` to their numbers for display, shows selector-only rules as rules with
no source address and counts them separately. The kernel's own three baseline
rules are skipped: they are on every Linux machine ever booted and steer
nothing, and listing them would put three permanent false positives at the top
of a table whose whole value is that a row in it means something.

Each row gets an owner, decided by evidence and never by trust, strongest first:

| Owner | How it is recognised |
|---|---|
| **One-to-one binding** | a stored binding was stamped with that exact preference *and* the rule's source address is one of the two this binding may legitimately hold a rule for: the address it resolves to against the router's leases now, or the address the one-to-one pass last actually wrote a rule for. Those two part company for the length of **Lease release grace (s)** - the lease resolution gives up the instant a MAC's lease disappears, while the pass keeps the rule standing at the last address it saw - and on the live answer alone the monitor spent that entire window publishing a rule this module wrote, at a preference in this module's own band, as *written outside this module*, next to advice telling the reader to go and remove it. The row says which of the two it matched, so a rule sitting at an address nothing currently answers to is credited by name and told when it goes rather than left as a puzzle. The preference alone is never the answer: nothing stops a stranger's rule from being numbered where this module numbers its own, and crediting that rule to a binding would be the exact mistake this page exists to catch, made in the module's own voice - so a rule at that preference matching neither address is *foreign*, and says which addresses it was compared against. The rule's **table** is deliberately not asked about at all, because a binding in hold keeps its address and its preference while being re-pointed at the blackhole, and matching on the table would have called every held binding on the router foreign |
| **Binding instance** | the preference is inside one of the stamped assignment bands *and* the instance half has that address assigned |
| **Safety catch-all** | the preference is the catch-all preference an instance owns |
| **Router agent** | `bm-wanbind` provides binding on this router and the module's cached view has that address assigned - the daemon writes at its own base, which this side cannot read back per rule, so a cached assignment is the only evidence there is, and one fast tick of staleness is something a monitor can live with where a reconcile could not |
| **mwan3** | mwan3 is configured and the rule is outside every band this module writes |
| **Outside this module** | everything left over - and being left over is the answer the feature was built to produce |

The bands come from each instance's **stamped** layout rather than from the
settings in force, so moving a priority base does not make the module start
calling its own assignments foreign. The one-to-one row above refuses the same
trap one step harder: the live one-to-one band is not consulted at all, only the
preference each record was stamped with. **One-to-one rule priority base** can
be edited while bindings exist, and the rules already on the router keep the
numbers they were written with, so a band read from the setting in force is how
this page came to say *"this module did not write this rule"* about every
one-to-one binding at once, the moment somebody saved a new base. A rule inside
the band with no record behind it is still unattributed and still falls through
to the bottom of the table, which is the only thing the band was ever able to
say that the record does not.

Beside the owner, each row says where that address actually leaves, against
what the main table's default does, in a sentence built from the evidence
rather than a status word: which table the rule looks up, which interface that
table's default route leaves through, and therefore whether this address is on
the router's default connection or not. The honest variants matter as much as
the ordinary one. A table with no matching route reads *no way out* - but only
when the routes pass actually reached that table, since a pass that ran out of
slots would otherwise put "no way out" against a working VPN. A blackholed
table reads *held*, which is what a one-to-one binding in hold looks like from
the outside. And a rule below the lowest preference this module writes
anywhere is flagged as **outranking** it - the sentence that has been missing
for as long as the module has had bindings, because it is the one that explains
why a binding this page shows as applied is not where the traffic actually goes.
A low preference alone does not earn that flag, though, because "a binding shown
as applied is not where the traffic goes" is far too heavy a sentence to say on
arithmetic: the rule also has to be able to *take* something, so its selector is
asked whether it covers an address this module has actually placed. A rule with
no source at all matches every packet a managed rule would and always qualifies;
a `from 10.0.0.0/8 lookup vpn` on a router whose bindings all live in
192.168.1.0/24 does not. The addresses it is measured against are the same union
the owner column uses, live and still-installed both, so the warning does not go
quiet for exactly the five minutes in which an address is hardest to account
for.

**The monitor never touches a rule.** It has no write path at all. The rules it
is best at finding are exactly the ones whose purpose nobody here can know, and
a router with deliberate policy routing of its own is a router somebody set up
that way.

It also costs nothing on a router nobody is watching. The scan runs only while
the **Connection page** is open - the page's `monitor` stream is what arms the
poller, and closing the page disarms it - and never on a router whose readiness
verdict is already a refusal. The gate is per page, not per tab on it, because
that is the granularity the app answers "is anybody reading this stream" at: on
Pools or on Jobs the scan is still running. Leaving the page is what stops
it. Its cadence is **Binding scan interval** (Module settings →
Advanced rules, 15 to 3600 seconds, default 60), and changing it re-times the
poller rather than waiting for a reconnect. A button on the page forces a pass
whenever the interval is the only thing in the way, and a press arriving while
a scan is in flight joins that scan rather than opening a second one.

## Real-time data and scale

The browser/server transport is already one WebSocket. Small summaries and
chart points are pushed with module events. Tables that may contain thousands
of rows are requested over that same socket only while visible and are answered
from the server's RAM cache; opening a table never starts another SSH probe.

The one table that can be genuinely large is split further: a binding
instance's Assignments sit behind a two-tab subnav - **Needs attention** and
**All** - and only the open tab is asked for. A pool is at most 500 members, so
its detail is one filterable table; the member rows come from the daemon's
record, cached module-side with a short TTL, and a detail left open re-polls on
the fast interval for as long as it is open.

The fast sweep itself steps down when there is nothing to be fast for. On a
router with no PPPoE pool and no binding instance, and with neither the
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
PPPoE session. At more than 2,000 sessions use the Low (5 second) fast interval, in the app's own
Settings under General → Update intervals.

How often a point reaches the *charts* is a separate number, because it is a
different cost: **Module settings → Display & charts → Chart sample interval**,
5 to 3600 seconds, default 60. It used to be "once per slow sweep", which is why
a chart window shorter than an hour looked like a staircase however fast the
router was being read. Lowering it buys resolution against the history retention
and storage cap in the app's own Settings → Data & storage. The live tiles are
not affected either way - they read the module's own `series` stream on every
fast tick.

For more than roughly 1,000 LAN clients, review the findings shown before a
binding instance is applied. They cover:

- dnsmasq DHCP lease limits - the one finding apply can act on for you, with the
  checkbox on the create form. Raising them restarts dnsmasq, which briefly
  interrupts DHCP and DNS for the whole router;
- `nf_conntrack_max`;
- neighbor-table garbage-collection thresholds;
- software flow offload, which reduces repeated policy-rule lookups for
  established flows.

The last three are reported with the values to set and are applied at a router
shell.

## Hints

Every form has a panel beside it explaining what each of its fields accepts, its
default, its unit and its operational effect, and page-level notes explain each
workflow and its warnings. The checkbox under **Module settings → Display &
charts** turns all of them off; the preference applies to all three pages
immediately, is shared by every router this module manages, and survives an app
restart.

It really is all of them. The explanations used to be `help` strings on the form
fields themselves, which the app renders as an always-on paragraph under each
field and which nothing in a module's spec can gate - so the toggle reached the
notes and left fifty lines of prose on screen. There are none left: an
explanation is a note, and a note can be switched off.

What the toggle deliberately does **not** hide is a state banner - a router that
cannot be managed, a collector that has stopped, a frozen interface list,
compatibility mode. Those describe the router in front of you rather than
explaining the page, and a page that went quiet about them would be tidier and
wrong.

## Persistence and recovery

| Data | Location | Notes |
|---|---|---|
| Module rules and hint preference | `data/user-settings/module-config/openwrt.json` | Shared preference document; no credentials. |
| Binding instances, one-to-one bindings, sticky MAC hints, binding events, PPPoE and router events, finished jobs | `data/module-data/openwrt/<hostKey>.json` | Per router; kept below the 512 KiB module-data limit. A file written by an earlier release is read as-is - the batch records a 2.x file carries are deliberately not read, because the router's own pool records replaced them as the truth. A one-to-one binding is a record here and a rule on the router, and it is the record that makes the rule the module's: a build that cannot read these records leaves the rules standing and stops recognising them. The two event rings are kept apart so binding churn cannot push out the rarer PPPoE and router entries, and each binding instance gets its own share of its ring so one busy LAN cannot empty a quiet instance's ring. |
| Pool records - members, credentials, zone, table base | `/etc/config/bm_pppoe` on OpenWRT | The daemon's own; `0600`; snapshotted and restored by `bm-agent` with the rest. |
| PPPoE interface definitions and passwords | `/etc/config/network` on OpenWRT | Router is the source of truth. |
| Live assignments | `ip rule` plus DHCP leases on OpenWRT | Derived each tick; not duplicated in host data. |

Most writes are debounced by ten seconds. Creating, editing or deleting a
binding instance is not: that record is the only place its flags live, and a
crash inside the debounce would bring the module back distributing clients
under flags the page it was changed on has already forgotten. Those go straight
to disk. A pool needs no such care on this side any more - its record lives on
the router, and the module's copy is a cache that refills on the next read.

When the document will not fit, the sticky map is what shrinks first, down to a
floor of 100 entries, and only then the event rings and the job history - a
document is large because of sticky entries, so spending history first sacrifices
the record of what the module did to save something that was never the problem.
A job that has to be trimmed keeps its failures, warnings and cancellations
rather than its first few steps. Binding instances and routing-table
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
1.4.0 / 2.4.0. The PPPoE items among them - 4, 5, 7, 10, 11, 26, 43, 45 and
46 - are written against the pool model of 3.0.0 and the 2.x packages, which
replaced the batches every earlier release tested.

1. **The probe reads the router correctly.** At a router shell, `for t in ubus uci ip fw4 logread nft netifd pppd dnsmasq opkg apk; do command -v "$t"; done` and compare the result with the cards under Router readiness. Nothing present should be listed as missing. (`command -v ubus uci ip …` on one line is the 1.0.x form, and answers only the first name - that is the bug 2.0.0 fixes, so the two outputs disagreeing is the expected result.) Confirm too that `df -k /overlay` and `id -u` match what the Install readiness card reports.
2. **A 24.10 router is refused, and refused in the right words.** Connect one. Both pages must show the blocked panel - "This router cannot be managed yet" on the Dashboard, "This router cannot be automated yet" on Connection - with the Problem row reading *"This module needs OpenWrt 25.12 or newer. This router runs 24.10.2 and still uses opkg."*, naming the release the router actually runs. Nothing is collected, and **Install missing packages** must offer no form at all, only the sentence saying why. A router with neither package database instead reads *"No apk package database on this router. This module needs OpenWrt 25.12 or newer, which replaced opkg with apk."* - the two are deliberately different, because "no package manager" on a working 24.10 router sends the user hunting for a broken installer instead of at a firmware upgrade.
3. **Installing through apk.** On a 25.12 router that is genuinely missing one of the three groups, run Install missing packages. The job should run `apk update`, then one `apk add` per package as its own cancellable step, then a verify step that re-probes and turns the readiness card green - and the create form that was refusing should stop refusing, without a reconnect. On a snapshot build, `kmod-pppoe` may refuse over a kernel-version mismatch: the job must fail on that step and say so, not report success. Open LuCI's Software page and start an install with it held open: the step should say the database is locked, in words, and succeed on its retry three seconds later once the page is closed. The check report names the commands before you confirm them: they must only ever be `apk update` and `apk add <name>`, and never `apk upgrade`.
4. **A pool of tagged members.** With the ISP handing VLANs 101 and 102 on `eth1`, the carrier dropdown must offer `eth1` and **not** `eth1.101` - the VLANs are the member list's job. Create a pool with members 101 and 102. The router should end up with a `config device` section per member describing `eth1.101` and `eth1.102`, each carrying a derived `macaddr` starting `02:`, two `config interface` sections named `<prefix>101` and `<prefix>102` whose `ip4table` is the table base plus the VLAN, and the pool's zone listing both in `uci -q show firewall`. Delete the pool afterwards and confirm the device sections and the zone memberships go with it.
5. **Deleting a pool under a running binding instance is refused.** Create a pool on a carrier, create a binding instance on the same carrier, start it, then try to delete the pool. It must be refused by instance name - not queued, not partially executed - because the WANs would go while the fail-closed catch-all stayed, leaving the scoped LAN with no route out. Repeat with the pool on the bare `eth1` and the instance on `eth1.835`: those count as the same uplink, and so does the reverse. Stop the instance and the delete should then be accepted.
6. **Pinning a device to a WAN.** From Assignments, pin a device to a named WAN and confirm it moves there and stays there across a lease renewal. Then confirm the refusals, each with its own message: a WAN that is not in the pool, a WAN another device already carries, a WAN that is dialing or in error, and several rows selected at once. Finally, on an instance with *Keep a device on the same WAN* switched **off**, pin a device that holds no lease - that must be refused outright, and the pin of a device that does hold one must be understood to last only as long as that lease.
7. **The record survives what the router loses.** With a pool up, remove one member's interface section by hand - `uci delete network.<prefix>101; uci commit network; ubus call network reload` - and wait a tick: the member's row must read `unwritten` rather than disappearing, because the daemon's record still names it, and nothing may quietly decide the pool shrank. Then apply any edit to the pool - changing the label is enough - and confirm the daemon writes the section back and the row returns to `up`: an edit reconciles every member against the record, which is also how a create that died half way is finished.
8. **The five readiness states.** Before connecting (`connecting`, a waiting note); while the first probe is still out (`checking`, its own panel saying nothing has been read yet, with Check now); a machine that is not OpenWRT, or a router still on opkg (`blocked`, the refusal panel); a router missing `ip-full` or dnsmasq (`attention`, a banner **above a working page**); and a complete router (`ready`). The failure this replaces was the blocked panel appearing during a normal startup.
9. **Connection.** Add the router as a Bored Manager machine, connect as `root` through dropbear, and confirm a Terminals session works.
10. **Firewall verification.** After creating a pool, `uci -q show firewall` must show the pool's zone with every member in its `network` list, masquerading and MTU fix on, and one forwarding from the LAN zone - and `nft list ruleset` must show the LAN zone's `forward_<lan>` chain reaching it. On a router whose LAN zone is not named `lan`, the forwarding must name the zone the daemon actually found. Edit the pool with *Allow LAN to reach this zone* off and the forwarding must go while the zone stays; delete the pool and the zone must go too, unless another pool or a `bm-wanbind` instance still names it.
11. **Soak.** Create a pool of 100 members, then one of 500 - the cap, and one call rather than fifty chunks. Record apply time, router CPU/RAM, and whether the dashboard stays smooth with several pools up. Use the Low (5 s) fast interval above roughly 2,000 sessions across all pools. Open the largest pool and confirm the member table filters in place inside its modal rather than pushing the page around.
12. **Binding scenarios.** A new DHCP client gets an `ip rule` within two fast ticks and exits through its assigned WAN; a WAN that stays failed remaps after the grace period; an extra client waits with DNS but no internet; a lease IP change keeps the same WAN; a missing lease releases the WAN after its grace; a router reboot reapplies rules and shows a router event; an app restart rebuilds assignments from the router. LAN and WAN interfaces outside the instance stay untouched. On a router whose LAN firewall zone is not named `lan`, the check should name the zone it found rather than assuming one. Remove `option ip4table` from one pooled WAN by hand and confirm the audit repairs it, and that repeating the removal three times ends with the module saying it has stopped trying rather than writing on every slow tick.
13. **The UCI filters.** `uci -q show firewall | grep -E '=zone$|\.name=|\.network='`, `uci -q show network | grep -E '\.(ip4table|username)='`, and the `dhcp`, `network` and `firewall` filters in the binding preparation probe all return what the parsers expect under BusyBox grep, not GNU grep. The network filter is the one to read twice: it keeps `option gateway` as well as `ip4table` and `ip6assign`, because a statically addressed uplink on a private address is recognised by that key and by nothing else, so a dump that comes back without it is a router whose WAN the one-to-one create will call *unclear*. On a router with a few statically addressed interfaces and a `config route` or two it should add low single digits of lines, and a pool of a thousand dialled sessions should add none at all - a session is handed its gateway by its peer and never carries the option. The preparation probe's firewall filter is the other one to read: it keeps `.device=` beside `.name=`, `.network=`, `.masq=` and `.flow_offloading=`, because a zone that names its members with `list device` is invisible without it and a LAN written that way was refused outright with *"is not assigned to a firewall zone"*. Its cost is bounded by the number of firewall sections a router has, which is dozens - `/etc/config/firewall` does not grow with clients or with managed WANs, unlike the other two dumps. While you have the output, check the three spellings the parsers have to survive on a hand-edited router: `option masq 'on'` rather than `'1'`, a zone written `option network 'lan guest'` with two names in one token, and a zone naming a plain port or a VLAN under `list device`. All three are correct configuration, none of them is what LuCI writes, and each of them used to produce a refusal that told the router something untrue about itself.
14. **Disable / uninstall.** With the module connected, switch it off and uninstall it. Pollers stop, `data/app.log` shows no leftover `openwrt:` execs, and UCI leftovers remain only if pools or binding instances were not deleted first - a pool outlives the app by design, since its record and its sections are the router's own.
15. **A stopped service is not a missing package - and the two binding forms do not ask for the same ones.** `service dnsmasq stop`. The Extras card must turn amber and read *"Installed, but the service is not running"* with `service dnsmasq start`, **not** "Present" and **not** an offer to install dnsmasq - it is already there. Then try both create forms under WAN Binding, because since 3.3.0 there are two of them and they are gated differently, and this is the step that proves the difference is real rather than an oversight. On **Create an instance**, *Check the scope* must refuse, headed *"dnsmasq is installed but not running"* and naming the same command the card does: an instance exists to hand out WANs to whatever DHCP leases, so with nothing writing the lease file it would sit empty with no reason given. On **Binding 1-1**, nothing may refuse: *Check this binding* and *Create it* on a **typed IPv4 address** must both go through and the rule must appear on the router, because an address somebody typed needs nothing to be leasing for its rule to steer. A binding on that same tab that names a **MAC** is the case to watch rather than the case to fail: it reads its address out of a lease file nothing is updating any more, so a MAC that file still holds is created on whatever address it holds, with no refusal. A MAC that file does **not** hold is the one to read carefully, because what happens next is a fact about the router rather than about dnsmasq - on a router where exactly one interface is a LAN candidate it is a warning and the binding is created, and on a router with two or more it is refused, headed *"The device has to be seen on the network once before it can be bound"* and naming the candidate LANs with their subnets. Neither outcome is dnsmasq's absence talking, and confusing that refusal for one is precisely what this step is meant to rule out; if you want it unambiguous, run this step with a MAC the lease file still holds. Start dnsmasq again and both cards and both forms go back to green without a reconnect. Repeat with `service firewall stop`: Firewall & routing turns amber and says no `inet fw4` table is loaded. Then `service network stop` on a router you can still reach - the Core card must show netifd installed but not running, and the page must move to `attention` rather than to the blocked panel.
16. **A router with no `pidof`.** On a build without it, every service row must read *"This router has no pidof, so whether the service is running could not be checked"* and nothing may refuse. An answer nobody could obtain must never become a fault.
17. **Competing policy routing.** Install and enable mwan3. The Firewall & routing card and the WAN Binding check must both warn, name mwan3, say that the lowest preference wins, and **still let the check through** - it is a warning, not a refusal. Then remove mwan3 and add a rule of your own below the module's base, e.g. `ip -4 rule add from 192.168.9.0/24 lookup 42 pref 100`: the warning must name the preference and the rule text, and the count must be the number of such rules on the router, not the number shown. Delete it and the row goes back to green.
18. **The gate is one gate.** With `ip-full` removed from a router that has a binding instance, **Start** must be refused by name - "This router cannot steer traffic by routing table" plus where the reason is - rather than failing somewhere inside a reconcile. Check a pool on a healthy router, then remove `ppp` before pressing Apply: the apply must be refused, because a token is not permission for a router that has changed. Binding **Stop** and **Delete** and the Rules editor must keep working throughout; a pool delete is the daemon's and needs it, which item 43's legacy path also exercises.
19. **Running the install again, and running out of room.** On a router with all three groups present, a plain check is refused and names the checkbox; with **Run the install again** ticked it plans `apk add` for every ticked group and the report says what that does and does not fix. Confirm the commands are still only `apk update` and `apk add <name>`. Then fill `/overlay` to a few hundred KB free part-way through a three-package group: the job must stop **before** the next `apk add`, name the package it did not start, and say the earlier ones stay installed - not fail inside apk on a router that is now full.

25. **Install the agent from a bundle, on a router with no internet.** Unplug the WAN. Module settings, Router packages, source "A `.apkbundle` from this machine": the check must unpack and checksum it on the router and say nothing has been installed yet; apply must install it and the readiness card must go green without a reconnect. Then edit one byte of the bundle and check again - it must refuse before `apk add` runs, naming the checksum, and take its half-unpacked directory away with it.
26. **The compatibility banner is honest.** On a router with no agent, both the Dashboard and Connection must carry it and binding must still work: create a binding instance and confirm nothing refuses. The pool create must refuse - pools are the router's own from 3.0.0 - and the refusal must point at Router packages rather than at a missing firmware feature. Then install the packages and confirm the banners go, the pool form opens, and nothing was switched off and on again.
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
    bm-pppoe-pool` with a pool up, then `ifstatus <prefix>101` - still up,
    still dialling. This is the opposite of item 32 and deliberately so: those
    sections are the user's own configuration and netifd owns them. The app's
    pool surfaces go back to naming the missing package until it returns.

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
43. **A batch from an earlier release is legacy, and says so.** On a router
    whose packages were upgraded from 1.x with an old batch still configured,
    the Pools tab must list it under legacy with its prefix and range, offer
    Delete and nothing else, and `bmpppoe status` must show it as legacy too.
    Its sessions keep dialling untouched throughout. Delete it and confirm the
    five-digit sections and any `bmv<vid>` device nothing else uses go with
    it - and that a v2 pool on the same router never flinched.
44. **Disconnect the app and lose nothing.** The rest of these are one test:
    close the app, or point it at another router, and do a full day's work from
    the router alone. Every one of them has to pass with nothing but a browser
    and a console.
45. **A pool of five hundred, created from a browser.** In LuCI, Create a pool
    in shared-account mode, paste five hundred VLAN lines and watch the member
    counter under the box agree before pressing anything. It must land as one
    call; `ubus call bm.pppoe info` must then show the pool, and
    `uci show network.<prefix>101` the derived `02:` MAC and the right
    `ip4table`. While it runs, check `ps` and `/proc/*/cmdline` on the router:
    not one password may appear in either - from a browser the spec travels
    inline over ubus, never through a file or a command line. Close the browser
    tab mid-create and confirm the result is a pool or nothing - never half of
    one.
46. **Edit rather than a second pool.** With a pool `fpt` dialling VLANs
    101-105 on `eth1`, try to create a second pool on `eth1` with VLAN 101 in
    its list: it must be refused by name, saying which pool holds that VLAN on
    that carrier. Then Edit `fpt`, add VLAN 106 without retyping anything else,
    and confirm the new member dials, the other five never dropped, and their
    credentials were kept.
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

Items 50 to 53 are what module 3.1.0 and packages 2.1.0 changed together.

50. **A fresh router is not failed for an empty table.** On a stock 25.12.5
    (QEMU is fine) where `ip -4 route show table 29999` answers *"FIB table
    does not exist"*, the readiness card must show policy routing **Present**
    and all three checks green - and `bindingStart` must not refuse over the
    `ip` binary while `bm-wanbind` is installed. Then check the same card on a
    genuinely BusyBox-only router: still refused, with the `ip-full` offer.
51. **Router limits, both writers.** Module settings, Router limits, with
    packages 2.1.0: check reports usage and the recommendation, apply must go
    through the agent (`logread -e bm-agent`), and `bmctl tune` must read the
    same values back. Downgrade to 2.0.x packages, apply again: it must go
    over SSH, write the same `/etc/sysctl.d/60-bm-scale.conf`, and say so.
    Reboot; `sysctl net.netfilter.nf_conntrack_max` must hold either way.
52. **The check refuses what would drop traffic.** With `nf_conntrack_count`
    high (a busy router, or `conntrack -L` noise), enter a conntrack max
    below the live count - refused by the count, not by the bounds. Enter
    gc_thresh1 above the router's own gc_thresh2 with the other fields blank -
    refused for the inversion the merge would create.
53. **The router's own pages carry the new surfaces.** In LuCI: Overview shows
    the Requirements card with a live report and an Install button that runs
    apk for a missing group; the Updates card asks the release server only on
    the button; Maintenance holds the snapshots, the updater and Scaling with
    the two presets. Remove `dnsmasq`, reload the page: the row goes red, the
    install button puts it back, and `bmctl requirements` agrees at a console
    throughout.

Items 54 to 57 are what module 3.2.0 and packages 2.2.0 changed together.

54. **Both account modes and both carrier modes.** On LuCI PPPoE Dialer and
    on the app Connection tab: Shared account and One account per VLAN both
    show. Carrier mode VLAN / Direct and MAC mode auto / inherit show on
    both create forms. A router still on packages 2.1.x must refuse Direct
    with a sentence that names the update, and still create a VLAN pool.
55. **Maintenance does not throw.** Open the LuCI Maintenance tab on a
    router with no snapshots and no pending update. The page renders. The
    browser console has no `TypeError`.
56. **Direct inherit and Direct auto, small.** Create a 2-slot Direct +
    inherit pool on the live carrier. `uci show network` must show both
    interfaces on the bare device, each with its own `host_uniq`, and no
    macvlan device section. Delete it. Install `kmod-macvlan`, create a
    2-slot Direct + auto pool: each member rides `ethXmN` with a derived
    MAC. If the ISP answers untagged PPPoE, at least one session must leave
    Discovery. Delete both.
57. **The stale LuCI face is gone.** After apk reports 2.2.0, log out and
    hard-refresh. The menu title is PPPoE Dialer, not an older label, and
    the editor matches the sources in this tree. A same-number reinstall of
    2.1.0 must not be treated as an update.

Items 58 to 65 are what module 3.3.0 and Bored Manager 0.7.0 changed together.
Items 60 to 63 are the ones to run twice - once on a router the module drives
over SSH, once on a router where `bm-wanbind` owns binding - because the two
halves reach the same rule table by different routes.

58. **The rail expands in place.** Open Connection. PPPoE Dialer and WAN
    Binding must be expandable entries rather than tabs that reveal a second
    rail inside the page: click one and it opens under itself, click a leaf and
    that leaf's page is one click away from anywhere. The page must open on
    Pools with PPPoE Dialer already expanded, because that is where the active
    leaf is. Narrow the window below the `md` breakpoint: the rail becomes the
    horizontal strip and every leaf appears in it flattened, with no
    disclosure to press. Switch away to the Dashboard and back - the leaf
    selection is client state and is not expected to survive; landing on Pools
    again is correct, landing on a blank page is not.
59. **A pool opens nearly full screen.** From Pools, open a pool. It must be a
    centred modal at roughly 94% of the window over a dimmed page - not the
    right-hand drawer - and all six of its tabs must be legible without
    horizontal scrolling, which is the whole reason for the change. Press
    Escape and confirm the row polling stops with it. Four tables opt into
    this shape and all four have to be checked, because the opting-in is per
    table and a page spec can lose one silently: **Pools**, **Binding 1-1**,
    **Instances** and **Monitor**. Open a row in each and confirm the same
    centred modal, and that Escape closes each of them. Then open a table on
    the Dashboard or Module settings and confirm those still open the
    right-hand drawer: nothing outside those four may have changed shape.
60. **A one-to-one binding on an address, on a router that is not a stock box.**
    Connection → WAN Binding → Binding 1-1. Run this step on a router whose LAN
    terminates on a **VLAN (`eth0.1`) or a plain port (`eth0`) rather than on
    `br-lan`**, and if the only hardware to hand is a stock build, make one:
    that is the shape the create used to refuse outright, with *"is not inside
    any LAN subnet on this router"*, and a bridge is the one shape that never
    failed. A pass on `br-lan` proves nothing this step was written to prove.
    Bind `192.168.1.50` to a WAN port and apply. On the router,
    `ip -4 rule show | grep 192.168.1.50` must show one rule at a preference in
    the one-to-one band - by default between 19000 and 19999, below every
    instance rule - and `ip -4 route show table <n>` for the table it names
    must leave through the WAN you chose. `uci -q show firewall | grep bmd`
    must show the forwarding written under this binding's own prefix - and on
    a router carrying no PPPoE pool and no binding instance,
    `uci -q show firewall | grep bmwanpool` - or whatever **Binding firewall
    zone** under Module settings → Advanced rules is set to - must show
    **nothing at all**: this create writes forwardings and no zone, because the
    masquerading zone belongs to the half that has a pool to put in it. From
    the device itself,
    confirm the traffic really leaves that way rather than trusting the row.
    Then create the binding again for the same address: it must be refused by
    the first binding's name. Delete it and confirm the rule and the `bmd`
    sections go, and that the firewall is left with nothing this binding put
    there - no zone, and an instance's `bmf` sections on the same LAN
    untouched. Then check the one thing the delete is **not** expected to take
    back: `uci -q show network.<wan>.ip4table` must still print the table the
    create assigned. That is deliberate and is not a leak to file - taking it
    off means rewriting `/etc/config/network` and reloading netifd, bouncing
    every session on that WAN, to remove a line that steers nothing on its own
    and that the next binding or instance on that WAN would want to find
    already there. What must be gone is the module's own *claim* on that table.
    Prove that rather than assuming it: with the binding deleted, remove the
    option by hand (`uci delete network.<wan>.ip4table; uci commit network`) and
    confirm that no later tick puts it back - the slow-tick repair restores a
    hand-deleted `ip4table` only for a WAN this module still holds a claim on,
    and it no longer holds one here. Create a fresh binding on that same WAN
    afterwards and it will assign a table again, taking over the option the way
    the first create did. If your
    router carried its own `ip4table` on that WAN before any of this, confirm
    instead that the value is untouched from beginning to end: a table this
    module did not assign is never written in either direction. On a router where the chosen WAN genuinely **is** a member of
    the pool zone, run the same delete and confirm the opposite: the zone and
    its `option masq` are still there afterwards, because the binding forwarded
    to that zone by name and never wrote a line of it.
61. **The same binding on a MAC, and a lease that moves.** Bind a laptop by MAC
    instead. Confirm the rule is written for whatever address it currently
    holds. Now force a new lease on a different address (`ip addr flush` and a
    fresh DHCP request, or shorten the lease and wait): within a tick the rule
    at the old address must be gone and one at the new address present - one
    rule, not two. Take the device off the network entirely: the rule must
    stay for the lease-release grace and then come off, and the row must say
    so rather than continuing to claim the device is bound. Bring it back and
    the rule must return. Finally create a binding for a MAC that holds no
    lease at all, and before you press *Check this binding*, work out which of
    two outcomes **your** router should give: count the interfaces that are LAN
    candidates, which is every one the check reads as a LAN plus every one it
    leaves *unclear*, with the WAN port you are binding out of excluded. On a
    router where exactly one qualifies - a plain single-LAN box - that is a
    **warning**, the binding is created, and its rule must appear the moment the
    device first appears. On a router where two or more qualify, which a guest
    VLAN beside the ordinary LAN is enough to make, it must be **refused**,
    headed *"The device has to be seen on the network once before it can be
    bound"* and naming the candidate LANs with their subnets. Both are correct
    behaviour; running this on a single-LAN box, meeting the warning and filing
    the refusal as a regression - or the reverse - is the confusion this
    sentence exists to prevent. Then connect the device once and repeat: the
    address is what answers the question, and on either router the create must
    now go through.
62. **Hold, and fall back, and the difference between them.** This is the step
    that proves the two options are two different rules rather than one rule
    and its absence, so run both halves on the same binding and compare them
    line for line. With the binding in the default *When that WAN is down* →
    **Keep it off the internet**, take its WAN down (`ifdown <wan>`). The rule
    must still be there and must now look up the module's unreachable table,
    and that table must contain `unreachable default`. Then prove the address
    really has no way out rather than trusting the row: from the bound device,
    a ping to anything off-net must get no reply, and on the router
    `ip route get 1.1.1.1 from 192.168.1.50 iif <lan>` must report the address
    unreachable - **not** silently resolve through the router's default WAN.
    That last check is the entire point of hold: a rule left pointing at a dead
    WAN's empty table falls through to the main table, which is the leak. Bring
    the WAN back and the rule must return to its own table. Now switch the
    binding to **Let it use the default connection**, take the WAN down again,
    and confirm the mirror image of all of that. The rule **must still be
    there**, at the same preference it was stamped with, and `ip -4 rule show`
    must print it as `lookup main` - the router prints table 254 by that word,
    which is why the row's table cell reads *main* too, alongside the chips
    **WAN down** and **on the main table**. It is deliberately not removed:
    on a LAN an instance owns, removing it would drop the address into that
    instance's fail-closed catch-all, and the option chosen to keep a device
    online would have taken it off the network instead. So prove that end of it
    too rather than trusting the row: from the bound device, browsing must work,
    and on the router the same `ip route get 1.1.1.1 from 192.168.1.50 iif
    <lan>` must now resolve through the default connection instead of reporting
    the address unreachable. Bring the WAN back and the rule must return to the
    WAN's own table. A rule that has vanished, at either setting, is the bug
    this step exists to catch - it disappeared under an earlier release, and
    the step used to tell you to expect that.
63. **The Monitor finds what this module never wrote.** At a router shell write
    two rules by hand: a numeric one, `ip -4 rule add from 192.168.1.77/32
    lookup 900 pref 900`, and a **named** one - add `200 vpn` to
    `/etc/iproute2/rt_tables`, give the table a default route, then
    `ip -4 rule add from 192.168.1.78/32 lookup vpn pref 901`. Open Connection
    → WAN Binding → Monitor. Both must appear, named as written outside this
    module, each with a sentence saying which table it looks up, where that
    table leads, and how that differs from the router's default connection. The
    named one is the one to check hardest: the fast sweep's parser drops
    `lookup vpn` entirely, so a Monitor that lists only the numeric rule is
    running the wrong parser. The rule at preference 900 must also be flagged
    as outranking this module. Then remove the `vpn` table's default route and
    confirm the row changes to *no way out*. Leave both rules alone for several
    scans and confirm neither is ever modified or removed - and that the
    kernel's own `local`, `main` and `default` rules are not listed as
    findings. Delete them by hand afterwards.
64. **A range instance leaves the rest of the LAN alone.** Create an instance on
    a LAN with the source set to a range - say `192.168.1.100` to
    `192.168.1.199` - and a device holding a lease **outside** it, e.g.
    `192.168.1.20`. Devices inside the range must each get their own WAN as
    usual. The device outside must keep working through the router's ordinary
    connection: browse from it, and confirm `ip -4 rule show` has no catch-all
    rule matching its address. The catch-all must be several rules covering
    exactly the range, all at one preference, and it must still be exactly
    those rules after several ticks rather than being rewritten as one
    whole-LAN rule. Then confirm the refusals: a range whose end is below its
    start, a range that reaches outside the LAN's subnet, an attempt to edit
    the range after creation, and - on a router where `bm-wanbind` owns
    binding - the range refusal naming the package.
65. **The charts fill, and the watching stops when you stop watching.** Leave
    Connection open for a few minutes on both automations: the pool chart and
    the binding Overview charts must fill in and follow the page's own window
    picker rather than a fixed range. Then close the page (or switch to another
    module) and confirm from the router's own process accounting that the
    periodic whole-table `ip rule show` stops within one interval, while the
    binding reconcile carries on. Change **Binding scan interval** under Module
    settings → Advanced rules and confirm the new cadence takes effect without
    a reconnect.

Items 66 to 69 are what module 3.3.1 changed. Every one of them is the same
bug read from a different angle - a confident refusal, or a confident promise,
aimed at a router the module had not actually read properly - so run them on a
router that is *not* a stock single-LAN box, because a stock box passes all four
by accident.

66. **The router's own uplink cannot be picked as a LAN, and an interface the
    router does not describe is not refused for it.** On a router with a second
    uplink that is **not** named `wan` - an LTE failover or a second ISP on
    `wan2` - open **Create an instance** and pick it as the **DHCP LAN
    interface**. The router has to actually state something about it for this
    half of the step to be the one you are running: a `proto` of `dhcp` or
    `pppoe` settles it on its own, and a static one needs `option gateway`, a
    masquerading zone or a public address. The interface must be offered by the
    list, because that list refuses nothing, and *Check
    the scope* must then refuse it: headed *"`wan2` is an uplink on this router,
    not a LAN"*, quoting the evidence it read (the next hop, the masquerading
    zone, the routable address, or the protocol that dials or takes a lease -
    whichever of them your router actually states), and ending with the two
    things that would change the answer. No plan and no token may be issued. The
    failure this replaces is worth understanding before you run it: the list used
    to drop the interface literally named `wan` and nothing else, so an uplink
    under any other name was accepted, the instance wrote its forwardings from
    the WAN zone, laid its fail-closed catch-all over the uplink's own subnet,
    and started handing pool WANs to whatever sits upstream of this router.
    Then run the other half, which is the half a stricter module would get
    wrong: give the router an interface with an address, no dnsmasq section, no
    firewall zone and no gateway - the classifier calls that one *unclear* - and
    confirm the uplink sentence does **not** appear against it. Whatever else
    stops that create, it may not be this.
67. **A stranded binding says which way it went, twice.** Take a MAC-target
    binding that is up and move its device onto another LAN the binding has no
    forwarding from - a guest VLAN is enough. With *When that WAN is down* on
    **Keep it off the internet**, the row must read **moved off its LAN** and
    **no way out**, and its **Table** cell must be the catch-all table's number.
    Change the same binding to **Let it use the default connection** and the
    second chip must become **on the main table** while the cell becomes `main`.
    The chip and the cell must agree in both cases; if they ever disagree, that
    is the finding. Then prove the second one from the device rather than from
    the row - browsing must work, through the router's ordinary connection - and
    confirm the Overview's **Held with no way out** tile counts the parked one
    and not this one. A stranded binding set to fall back is not fail-closed,
    and reading it as though it were is the whole reason the second chip is
    asked rather than assumed.
68. **A zone the router writes its own way is still found.** Take the LAN out of
    its zone's `list network` and put it in by `list device` instead - naming the
    bridge, the VLAN or the plain port the interface actually terminates on -
    then run both create checks. Neither may refuse with *"is not assigned to a
    firewall zone"*, and the pass line must name the zone. Do the same with the
    two names in one token, `option network 'lan guest'`, and with `option masq
    'on'` on the WAN zone: the WAN port must not be refused as a LAN and no
    permanent warning may appear saying that zone does not masquerade. Then
    apply a create and confirm the forwarding was written from the zone the check
    named - the check and the apply read the zone the same way, and a router
    where they did not would pass the check and dial without carrying traffic.
    Finally, set `option flow_offloading 'on'` in the firewall defaults and
    check two places for the fourth boolean: the instance check's findings must
    no longer carry *"Software flow offload is disabled"*, and **Module settings
    → Router limits** must open with the switch already on, so an apply that
    changes nothing else does not commit the firewall and reload fw4 to turn on
    something the router is already doing.
69. **A rule the module is about to withdraw is not called a stranger's.** Bind
    a laptop by MAC, confirm the rule, then take the device off the network and
    watch the Monitor while **Lease release grace (s)** runs down. Throughout
    that window the rule must stay credited to that binding by name, with the
    sentence saying nothing on this router answers to the device at the moment
    and that this module withdraws the rule itself when the grace runs out. It
    may not appear as *written outside this module*: that verdict, on a rule
    sitting in the module's own band, is what sends somebody to a console to
    remove a rule this module wrote and would have taken back by itself a few
    minutes later. Let the grace expire and confirm the rule goes and the row
    with it.
    Then check the same window from the other side: a hand-written rule below
    the module's band whose source covers that address must still be flagged as
    outranking the module, rather than going quiet for the five minutes the
    address is hardest to account for.

## Safety and limitations

- Binding is IPv4 only. Disable or separately design IPv6 on a scoped LAN
  if clients must not bypass the selected IPv4 WAN.
- Many Linux policy rules are evaluated linearly. Flow offload is recommended
  at high client counts; benchmark the intended packet rate on the target
  hardware.
- A pool holds at most 500 members - one per VLAN, which is the model. A
  deployment that genuinely needs more sessions than that on one uplink runs
  more pools, each with its own prefix and table base.
- A router holds at most **512 one-to-one bindings**, and the create check
  refuses the 513th by that number. The limit is the per-router document rather
  than the priority band, which is a thousand wide: the document is written
  whole into a 512 KB budget, the trimming that makes an over-budget write fit
  may only spend the expendable rings and never a topology record, and both
  arrays full already come to roughly 370 KB. A binding exists only for as long
  as its record does, so refusing here is the honest end of it - accepting the
  513th would mean the next read of the document threw that record away while
  its `ip rule`, its `bmd<slot>_` firewall sections and its `ip4table` claim
  stayed on the router with nothing left that could name them, let alone remove
  them. **Binding instances** are bounded at the same number for the same reason,
  and *Check the scope* refuses the 513th there by that number too, in the same
  sentence pointed at the **Binding instances** list instead. Both gates count
  the creates still in flight as well as the records already stored, because
  each of those is a record about to arrive. Which of the two
  ceilings a router actually meets depends on one setting: on the shipped
  **Safety-rule priority base** of 29900 there are a hundred catch-all priority
  slots, so the slot refusal arrives at the 101st instance and the document
  ceiling is unreachable. Lowered towards its minimum of 2000 - which is exactly
  what running many range-scoped instances asks for - the range opens to 28,000
  slots, the slots stop being the limit, and the document becomes it. That the
  slot gate hid the missing one for as long as it did is worth noticing: it is
  the shape of every other bug in this feature, a limit that reads one narrow
  spelling of a fact and looks correct until the router is configured in one of
  the other legal ways.
- PPPoE pools need the router packages; there is no SSH path for them. A router
  that cannot take the packages can still be monitored and can still bind, but
  its PPPoE is its own to configure.
- Only firewall4 is supported by the two automations, and it is the one missing
  piece the module will not install for you: putting fw4 under a running fw3
  would take the firewall down rather than fix anything. A router on fw3 is not
  blocked - the dashboard, the tables and the history all work - but PPPoE
  pools and WAN binding refuse to be created on it.
- Only OpenWrt 25.12.0 and newer are supported at all. A router on 24.10 or
  older is blocked with the release it runs; there is no opkg path left.
- The three rules that place binding's objects - the two priority bases and the
  catch-all table - are locked while a router has binding instances, and also
  while no router is connected at all. The second half is deliberate: those
  records are per router while the rules are global, so a disconnected app
  cannot tell "this router has none" from "we cannot see this router", and
  answering the second as the first renumbers a live instance. Connect the
  router the rules apply to, then change them.
- The one-to-one priority base is deliberately not locked in the same way: each
  binding carries the preference it was stamped with, so moving the base leaves
  every existing rule where it was written and only decides where new ones go.
  What it may never do is run the band into the instance band - the create
  check refuses a binding that would, and a saved value that would is discarded
  the next time the rules are read.
- The monitor reports and never writes. A rule it names as written outside this
  module stays exactly where it is, including one that outranks everything this
  module does; removing it is a decision for whoever put it there.
- A pin made on an instance that does not keep the same WAN across reconnects
  lasts only as long as the device's current DHCP lease. There is nowhere
  durable to record it on such an instance; turn *Keep a device on the same WAN*
  on if the choice has to survive.
- On a router with no PPPoE pool and no binding instance, and with no OpenWRT
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
  pppoe/            the PPPoE pools, as a client of the router's own daemon
  binding/          WAN binding, end to end
  direct/           one-to-one bindings: one address, one WAN port
  scan/             the binding monitor: every source-routed address, and who wrote it
  agent/            the router packages: every ubus call, the guard, the installer
  uci/              the `uci batch` primitive binding still writes through
  store/            the per-router document
  config/           effective module rules and the hint preference
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
| `main/pppoe/` | The pool client: the daemon's answers cached behind a short TTL, the check/apply sessions for create and edit, the actions, the delete with its binding gate, and the rows every surface renders. |
| `main/binding/` | WAN-pool discovery, the pure planner, per-client rule reconciliation, the routing-table audit, device actions, and its rows. |
| `main/direct/` | Hand-placed bindings: the create gate, the apply job, the pure per-tick pass that decides every rule this folder ever writes, and the lifecycle. `layout.ts` is the one to open first when a refusal is wrong about the router - it is where an interface is weighed into LAN, uplink or unclear from what `/etc/config` says, and where every sentence the gate says about that answer is written. It shares the instance half's runtime helpers through `binding/`'s barrel rather than copying them, which is why the two can never disagree about what a forwarding or a table claim looks like. |
| `main/scan/` | The monitor: one bounded router command, a parser that keeps the rules the sweep's parser is right to drop, the owner verdicts and the evidence sentence behind each, and the poller that only runs while the Connection page is open. `classify.ts` is the file to open when the page names one of this module's own rules as a stranger's - it holds every fact a verdict is allowed to rest on, and the deliberate omissions are commented as such. |
| `main/agent/` | The client for the router packages: every `bm.agent`, `bm.wanbind` and `bm.pppoe` call, the `0600` spec push, the commit-confirm guard wrapper, and the package install and remove flows. |
| `main/uci/` | What this side still writes to a router: the legal-name and value sieves, and the only code that executes a `uci batch` - binding's, now that pool sections are the daemon's. |
| `main/store/` | The bounded, debounced per-router document, and the trimming that keeps it inside its size budget. |
| `main/packages.ts` | The allowlist: every package this module may install, and why. |
| `main/config/` | Effective module rules and the hint preference: the schema and defaults, the cached store, and the settings-form editor. |
| `main/events.ts` | The PPPoE, router and binding event rings, and the live log stream. |
| `main/jobs.ts` | Cancellable chunk-job progress and history. |
| `main/parse.ts` | OpenWRT output parsers, and the UCI value quoting. |
| `main/options.ts` | Dynamic form choices from the in-memory model - including the two carrier dropdowns and their different rules, and the one budgeter that decides which rows a list at its 500-row ceiling gives up. Every list here is deliberately permissive: hiding an interface costs the operator the feature with nothing on screen to say why, and the checks are where a pick is refused. |
| `main/queries.ts` | Large table rows built from the in-memory model. |
| `main/badges.ts` | One colour per meaning, for every status shown anywhere. |
| `main/util.ts` | The helpers more than one of the folders above needs - among them `uciBoolean`, the module's single reader of a UCI boolean, and `ifaceDevices`, the netdev names a firewall zone written with `list device` has to be matched against. Both are here rather than beside any one caller because each had been written down several times and the copies had drifted. |
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

**The layering is one-way, and a domain imports another only downward.**
`runtime/` may import anything below it and nothing imports `runtime/` back.
Below it are the domains that do the work - `service/`, `pppoe/`, `binding/`,
`direct/`, `scan/`, `setup/` - then `probe/`, whose verdict `setup/` and
`runtime/` both read, then the shared libraries (`agent/`, `uci/`, `store/`,
`config/`, and the loose `*.ts` files, which may import each other), then
`@shared/*`.

`pppoe/` contains no mention of `binding/` and vice versa, and neither knows
`service/` exists. Where two of them genuinely need each other - the PPPoE
delete asking which carriers a binding instance is running on, the binding
engine asking the collector for a fresh interface dump - they meet
through a small dependency object written in `runtime/container.ts` and passed in
at construction. That file is the only place in the module where all the domains
appear together, and it is where to look first for how any two of them interact.

`direct/` and `scan/` are the one deliberate exception, and it is a one-way
one: both import `binding/`'s barrel, and `binding/` imports neither back. The
alternative was a second copy of the pieces that decide what a firewall
forwarding, a routing-table claim, a WAN's usability or a rule chunk looks like
- and two copies of those would eventually disagree about the same router,
which is the failure this whole layer exists to make impossible. What they take
is named in `binding/index.ts` like anything else a folder is allowed to have.

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
