# Changelog

Module versions are independent of the app's. From **3.3.0** the module needs
Bored Manager **0.7.0**, for a rail that expands in place and a row detail that
opens nearly full screen - both of them app features this module can only opt
into. OpenWRT 2.x and 3.0.0 to 3.2.1 need **0.4.1**, for the `statusCards` and
`meter` blocks, badge columns and forms that open pre-filled; every one of them
needs OpenWrt **25.12** on the router. The 1.0.x line needs **0.3.3**, for the
`subnav` and `note` blocks and the `file` form input. From 3.0.0 PPPoE pools
need the router packages at **2.x**, and from **3.4.0** WAN Binding needs them
at **2.4.0** - the dashboard, the interfaces and the device table still work
without them, and nothing else does.
Which release a module build installs is pinned in `main/agent/manifest.ts`.

## 3.4.0

Needs Bored Manager **0.7.0**, unchanged, and the router packages at **2.4.0**,
which is new and is not optional: WAN Binding is the router's now, and a router
without them has none.

### The bug this release exists for

Somebody created a dozen one-to-one bindings, saw nothing appear on the
router's own pages, and found nothing new under Routing or Firewall either. The
bindings were real. They were also being deleted and rewritten in a loop.

`bm-wanbind` owns ip rule priorities 19000-19999 and removes every rule in that
band that no `config direct` section asks for. This module wrote the rules there
over SSH and **never wrote the sections**. So the daemon cleared all thirty-four
of them every thirty seconds, and this module wrote them back about nine tenths
of a second later, for as long as the app stayed open. Each bound address spent
roughly a second in every thirty on the router's default connection instead of
the WAN it was bound to.

Neither half reported a conflict, because each was doing exactly what it had
been told. Read off the router itself:

    20:51:38.383  Deleted 19000: from 12.10.10.10 lookup 10001
    20:51:39.273          19000: from 12.10.10.10 lookup 10001
    20:52:08.403  Deleted 19000: from 12.10.10.10 lookup 10001
    20:52:09.223          19000: from 12.10.10.10 lookup 10001

The daemon's own counter said it: 103,868 rules removed across 3,071 passes,
and none written.

This also retires the mystery recorded against 3.3.2 - *"the daemon reports a
rule added, with no error from the socket, and `ip -4 rule show` has nothing at
that priority"*. That was this module's sweep. `direct` was held out of the
feature descriptor for a fault that never existed.

### So the router owns binding, and this module stopped writing

The fix is not a smaller sweep or a better lock. **Two writers of one priority
band is not a slower arrangement than one, it is a wrong one**, and it fails in
the way that shows up nowhere: green on every surface, traffic on the wrong line
a few percent of the time. So the daemon owns the sections, the routing tables,
the firewall paths, the fail-closed catch-all and every ip rule; this module
asks, shows, and sends changes back. PPPoE pools moved the same way at 3.0.0.

There is no fall back to writing, and there must never be one. A call that fails
means the rows are one tick stale, which the page says. The only fall back is at
the capability verdict, where no package, a package too old to drive and a
stopped service all mean the same thing - and the pages say so rather than
quietly doing a worse job.

`main/binding/` and `main/direct/` are gone. What replaces both is one folder,
because on the router they were always one thing.

### An instance is a generator of bindings

That is the other half of the change, and it is what makes "bind many clients to
one WAN" reuse the one-to-one machinery instead of sitting beside it. A binding
is a target, a WAN and what happens when that WAN is down. Somebody places one
by hand; an instance produces them from DHCP leases. Both go through one core on
the router, and both appear in one list, told apart by where they came from.

**Clients per WAN.** `1` gives every device a line of its own, which is what
every earlier release did and is still the default. A larger number lets that
many share one, and the pool fills by least-loaded rather than front-first, so
the last WAN is not idle while the first carries everybody. `0` is no limit -
and with a single-WAN pool that is the other thing a multi-WAN router gets
bought for: this whole LAN out of that one line, with the catch-all still
fencing everything the instance did not seat.

**An address range.** `range_from` and `range_to`, both inside the LAN. The
catch-all becomes the minimal set of blocks covering *exactly* the range, never
the whole LAN - a whole-LAN fence under a scoped instance would fail-close every
device the scope was chosen to leave alone. Two instances may now share a LAN
when their ranges do not overlap.

**Addresses a binding already decides are left alone.** An instance no longer
seats a device that a hand-placed binding follows. It used to: the binding's
rule sits below the whole client range, so the instance's rule steered nothing
while the instance held one of its WANs open for traffic that left by the other
one. Those devices are listed with a reason rather than vanishing from every
table.

### What happens to what you already have

Instances and bindings this module created are **handed over** on the first
connect after the packages are updated: each becomes a section on the router,
stamped with the numbers the rules already standing were written at, so the
daemon adopts those rules rather than writing a second set. The record is
dropped only once the router confirms; anything it refuses is kept, named, and
retried every pass, so fixing the reason needs no button.

Until the packages are there, the page says so: the rules stand exactly as they
were, nothing is maintaining them, and a new device on those LANs gets no WAN.
That is the honest description of a router in that state, and it is a state that
lasts as long as it takes to press Install.

**Do not run a module older than 3.4.0 against packages 2.4.0.** A 3.3.x module
treats `/etc/config/bm_wanbind` as a projection of records it no longer has and
removes every instance section the daemon holds. Update both together.

### Two doors onto switching a binding on

The row has an **Enable** button and an **Enabled** checkbox on its edit form.
They are one action, and only the button was ever refused on what the router can
do. The checkbox went through - and it went through all the way, because
`bm-wanbind` has no firewall test anywhere in `bind`: it writes the section, the
rule goes in over netlink, which needs no fw4 and no `ip` binary, and the row
comes back `bound`. On a router with no firewall zones the daemon also prepares
no forwarding, because it prepares one only for a path that is *missing* or
*wrong* and answers *no zone* by declining to act - nothing attempted, nothing
logged. So the Save said done, the page went green, and nothing was forwarding,
next to a button that had just said Firewall4 was required.

Both doors now refuse in one sentence from one place. The gate is on the
transition and not on the submitted value: this form posts all three of its
fields on every Save, so refusing whenever `Enabled` arrived true would refuse
every rename of every working binding. A rename and a change to *When that WAN
is down* still go through on a router that can do nothing else at all, and
switching one **off** is still never refused.

The row also carries the daemon's own verdict on the firewall path now -
**no firewall zone**, **no LAN to forward from**, **firewall path pending** -
which is the half no gate can reach: a binding switched on before fw4 was
removed, or switched on at a router shell, says so on the page instead of
reading as plainly bound.

### A Save no longer resends what the table happened to be showing

Every field a Save sends is read off the router first. It used to fall back to
the row on screen, which is up to one poll old, for any field the Save was not
about - so a rename typed in the tick after somebody chose *fallback* at a
router shell resent the cached *hold* and undid them, on the one field whose
whole job is to say what happens when a WAN dies. The same mechanism could
switch a binding back on that had just been switched off. Both answered
"Save: done".

### Settings moved

The priority bands, the catch-all table, the WAN table base and the three timers
are the daemon's and are edited under **Connection -> WAN Binding -> Daemon
settings**. They are defaults for instances created afterwards; a section
already on the router keeps the numbers it was stamped with. Module settings
keeps what is genuinely this module's: the monitor's interval, the charts and
the housekeeping.

The numbering rules are no longer locked while an instance exists, because there
is nothing here left for a rule on a router to have been written against.

### The monitor asks rather than works it out

Every ip rule on the router still gets a row and a sentence saying why that
address is not on the default connection - but the daemon classifies now,
because it is the half that knows which sections exist and which bands they own.
Two classifiers would be two answers about one rule.

It also learned **netifd**. Every interface carrying `option ip4table` gets three
rules from netifd without anybody asking, so a router dialling thirty-two PPPoE
sessions carries ninety-six of them, and the monitor called every one a
stranger's. On the router this was found on, that was 96 alarming rows burying
the handful worth reading.

### What a release audit found on the way out

Six things, all on the paths a user takes to get here from 3.3.x.

**The instance half was never told about instances.** Its page notice asked for
the one-to-one wording, so a user upgrading with binding instances was told
nothing at all about them - and a user with both kinds read the one-to-one count
on the instance tab. Every word of the instance sentence was unreachable.

**The same sentence told the commonest mid-update router the wrong thing.** On
packages 2.3.0 under this module it said the ip rules "still stand exactly as
they were". That daemon owns the one-to-one band and removes every rule in it no
section claims, which is every rule a 3.3.x module wrote: it is taking them off,
and the page was reporting health. The sentence now says which of the two
routers this is, and what stops it.

**A GitHub update undid itself.** `bmctl update` arms a commit-confirm guard and
deliberately leaves it armed for a person to confirm; the module ran the command
and stopped, so the countdown expired, the router put the previous packages
back, and the job reported success. It reads the router back and confirms now.

**The readiness card called a daemon this module cannot drive "ok".** The
binding row was the only feature row not gated on the contract version, so a
router on bm-wanbind 2.3.0 read "the router assigns clients itself" while every
WAN Binding surface refused. Its absent-package sentence also still promised the
SSH fallback this release removed.

**`ip-full` was named as what WAN Binding was missing.** The daemon writes its
rules over netlink and never opens the binary. The package is still offered -
a router somebody administers by hand is better off with it - and it is no
longer the answer the binding tab points at.

**The handover was one call and one flash commit per record.** It is `bind_many`
now, with one document write and one line in the event trail per batch rather
than per record. Batches are filled by size rather than by count, and that is
not a detail: every ubus call this module makes goes out as JSON on an SSH
command line, dropbear refuses an exec request longer than a few kilobytes
before any shell runs, and two hundred specs is thirty kilobytes. Batching by
the daemon's own limit of two hundred would have replaced a slow handover with
one that could not run at all, on precisely the routers it was added for. The
other thing that fell out of doing it: the specs go through the same argument
translation the single call does, or `when_down` never reaches the daemon.

### Capacity: what this router can carry

A fifth leaf on the Dashboard, second in the rail. It says what the hardware is,
what the configuration on it needs, roughly where it stops and what runs out
first, the four sizes at which the requirements change, and what is wrong now.

The arithmetic is the router's - `bm.agent capacity`, new in packages 2.4.0 -
and this module renders one reply. A second model on this side would be a second
answer, and the two would differ on the day somebody most needed one of them.

Every number is an estimate and the page says so. A ceiling is a `min` over the
things that can cap a router and the answer names which one it was: "about nine
hundred sessions, limited by memory" is something somebody can act on, and a bare
number is not. A fact the router would not answer stays `null` and drops out of
the `min` rather than becoming a zero, because a zero is a ceiling and "I could
not read your memory" is not a reason to tell somebody their router holds
nothing.

Where a problem has a fix this module already knows how to write, the row says
exactly what will be written and who writes it, and a button applies it. The
list of kinds is closed - `tune_set`, `wanbind_reconcile`, `wanbind_settings_set`,
`wanbind_instance_set`, `pool_reconcile` - and each carries its own allowlist of
arguments. A settings fix arriving with `enabled: false` beside the switch it is
allowed to throw is dropped; so is a conntrack figure outside the tunable's own
bounds; so is an instance fix naming an instance the same report does not list.
A report is a reply that arrived over a wire, and it cannot ask this module for
a write it was not already willing to make.

A fix is refused against a report more than five minutes old. A fix is decided
from what the report said, and five minutes later the router may have been
changed by somebody else.

An agent older than 2.4.0 answers "Method not found", which the tab turns into
a sentence naming the update. Everything else keeps working meanwhile.

### The monitor reads the whole rule table

It asked for one page of five hundred rows and published that as the router's
rule table. At five hundred sessions and five hundred bindings the router
carries about two thousand rules, so the page showed a third of them and the
tile above it said that third was the total. It walks the pages to the end now,
up to ten of them, and the tile states the daemon's own count of what the kernel
holds rather than this side's count of what it rendered. A collapsed row stands
for three rules and is counted as three.

The sentence explaining a rule no longer travels on every row. At fifteen
hundred rows the prose was most of a megabyte, which is what a ubus reply has in
total; the detail panel asks for the one it is showing.

### One payload per stream per tick

Each tick pushed two: one immediately and one when the fetch landed. At five
hundred bindings that is two full payloads down a stream where the second
differs from the first only in being newer, and the app renders both. It is one
now. The case the immediate emit existed for - a fetch that hangs - is caught by
its own start time instead, and the page is told the router has gone quiet at
the tick it went quiet rather than at the tick the transport gives up.

### Known cost

Four tables render up to five hundred rows. The row window that would fix that
is a change to the app's own `TableBlock`, not to this module, and it will
arrive with an app release rather than this one. The `direct` stream no longer
carries its rows at all, so the cost is now only in the renderer while the tab
is open.

### Requirements

`ip-full` is no longer required for binding: the daemon writes rules and routes
over netlink and never touches the `ip` binary. dnsmasq is still required for an
instance, which follows leases, and still not for a hand-placed binding on a
typed address.

## 3.3.2

Needs Bored Manager **0.7.0** and the router packages at **2.3.0**, both
unchanged from 3.3.1 in what they ask of you.

This release was written against a real router. Everything in it was reproduced
on an OpenWrt 25.12.5 box carrying two LANs and thirty-two PPPoE sessions,
which is where most of it was found.

### Binding 1-1 refused an address on a LAN carrying public address space

The report: `12.10.10.10` typed into Binding 1-1, answered with *"is on
LAN_WIRED, which this router uses as an uplink rather than as a LAN"* - about
an interface handing out 250 DHCP leases in the firewall zone named `lan`.

Three readings had to line up, and all three were wrong:

- **`option gateway` was weighted as heavily as anything else.** That LAN
  carries one, because there is a second router on it. Any interface may; it is
  not a statement about which side of this router the interface is on. It is a
  tie-breaker now and cannot outweigh a decisive reading either way.
- **An address the public internet routes to counted as evidence of an uplink.**
  That site runs its LANs on 12.10.x. Squatted ranges, real allocations and
  CGNAT are all ordinary, and a LAN holding one is still a LAN. **The reading is
  gone**, not softened.
- **Nothing asked the kernel.** An uplink is the interface the default route
  leaves by - that is what the word means, and the router will say it outright.
  The preparation probe reads `ip -o -4 route list table main` now, and that
  answer is decisive.

So is a `config dhcp` section actually serving an interface: a router does not
run a DHCP server on the interface its own address came from. Two decisive
statements pointing opposite ways gives **unclear**, said out loud, rather than
being settled by arithmetic.

A refusal also prints what argued the other way. These are sums of small
readings and the close ones are the ones worth doubting, but a refusal quoted
only the evidence that won - so a two-against-one verdict reached you looking
unanimous. It no longer offers a remedy the router has already applied, either.

### A rule this module wrote was reported as a rule it could not write

`ip -o -4 route list table main` is one half of the fix above. The other half
turned up on the router: **every `ip rule` the daemon writes was recorded as a
failure.** ucode's rtnl module answers a *dump* with an array and a *write* with
`null` - on success as well as on failure - so `if (!ok)` read every successful
write as a failed one. On a router with a binding that is an error line per
pass saying the address "is not going where its binding says", while the rule
sits in the kernel exactly where it belongs, and the counters stay at zero for
ever. The socket's own error is the only thing that tells the two apart, and it
is what is asked now. This was in 2.2.0 as well.

### The router packages know what a one-to-one binding is

`bm-wanbind` 2.3.0 gains the whole router-side half: `config direct` sections in
/etc/config/bm_wanbind, an interface classifier that weighs the same statements
this module does, a reconcile pass, ubus verbs, `bmwan bind`/`unbind`/`layout`,
and a netifd hotplug hook so a WAN coming back is not waited out on a timer.

**It is deliberately not advertised, and this module does not use it yet.** The
feature descriptor lists `binding` and not `direct`, so Binding 1-1 is still
written over SSH the way 3.3.1 wrote it - which is the half these tests cover.
The reason is honest: on a real router the daemon reports a rule added, with no
error from the socket, and `ip -4 rule show` has nothing at that priority. The
same call with the same arguments from a shell on the same router writes the
rule and reads back - before a dump, after a dump, after three dumps. What is
different inside the daemon has not been found, and a capability the daemon
cannot honour would be worse than none: this module would stop writing the
rules and nothing would start.

Putting `direct` back into `provides` is the whole of what turns it on, once a
rule written from inside the daemon can be shown to reach the kernel.

### Smaller things, each found by running the code rather than reading it

- The interface classifier on the router read a route's device under `dev`;
  rtnl answers with `oif`, so the one decisive reading it has was dead. The CI
  stub answered `null` to every request, which is why no probe could tell "this
  router has no default route" from "this code cannot read one".
- A WAN with no `option ip4table` - which is every WAN on a stock OpenWrt - was
  refused with an instruction to go and hand-edit /etc/config/network. The
  daemon numbers one itself now, from the base this module's own half uses.
- `bmwan bind` on an existing binding wiped its name, its LAN and its when-down
  setting, and switched a deliberately disabled binding back on. A field you do
  not give keeps what the section has; `--on` is the counterpart to `--off`.
- `option enabled '0'` on the main section is the *instance* half's switch. It
  never meant the bindings, and now says so.
- The monitor called every rule a router-owned daemon wrote "written outside
  this module" and advised removing it.
- Removing the packages takes any router-held binding with them, and the
  uninstall check now names them - this module keeps no copy it could restore.

## 3.3.1

Needs the same Bored Manager **0.7.0** and OpenWrt **25.12 or newer** that
3.3.0 does - nothing here asks anything new of the app. Router packages stay
pinned at **2.2.0**: nothing on the router side changed, nothing is written to
the router by the update, and no stored record is migrated. Nothing is *removed*
from the router either, which matters in one place - see *A one-to-one create no
longer leaves a firewall zone behind* for the empty zone a 3.3.0 router may
still be carrying and the one command that takes it off.

Every line below is a fix to what 3.3.0 shipped, and most of them are one fault
wearing different clothes: **a confident refusal, aimed at a router that is
configured perfectly correctly, reached by reading one narrow spelling of a fact
OpenWrt states in several legal ways.** The first of them was reported from a
real router; the sweep that followed found the others by looking for the same
shape.

### Binding 1-1 refused an address on a LAN that is not a bridge

The report was a create on an ordinary address answered with *"192.168.20.50 is
not inside any LAN subnet on this router"*, about a router where it plainly was.
Behind it was a guess: an interface running `pppoe`, `dhcp` or `static` whose
device did not begin with `br-` was read as an uplink. That is true of a stock
build and of nothing else. **A LAN on a VLAN (`eth0.1`), on a plain port
(`eth0`) or on a radio (`wlan0`) was classified as a WAN**, the LAN search came
back empty, and every address behind it was refused - with a sentence about a
router the operator does not have, naming nothing they could go and change.

The same guess ran the other way in the **WAN port** dropdown, which excluded
anything on a `br-` device: it hid the uplink of every router whose modem port
sits on a bridge, and offered a LAN that does not as a WAN port.

Nothing reads a device name any more. Each interface is weighed from statements
the router itself makes - the protocol netifd reports, whether `/etc/config/dhcp`
holds a section actually serving it or the stub a stock build ships to switch
itself off with `option ignore`, whether the firewall zone it sits in
masquerades, whether it carries an address the public internet routes to,
whether it delegates an IPv6 prefix, and whether its network section carries
`option gateway`. Only `pppoe` and `dhcp` settle an interface on their own,
because a router that dials or takes a lease on an interface is a *client* of
the network beyond it, and a router is not a client of its own LAN. Where the
statements settle nothing the answer is **unclear**, which is an answer rather
than a failure: an interface merely not denied is still searched for the
address, after every LAN the router does state, and the create says so out loud
rather than choosing on the operator's behalf.

A refusal now prints what argued the other way, and stops offering a remedy the
router has already applied. These are sums of small readings and the close ones
are the ones worth doubting, but a refusal used to quote only the evidence that
won - so a two-against-one verdict reached the operator looking unanimous, with
the one fact on their side never mentioned. The address reading is narrower too.
Both ends of a routed public block carry an address the internet routes to, so
on its own it could not tell an ISP-facing WAN from the DMZ the block is routed
*to* - and it outweighed the quiet zone that was the DMZ's only defence, so
pinning a public server to a chosen WAN, which is the one thing Binding 1-1
exists for, was refused. It counts where the interface says something else
outward as well, or where nothing else on the router faces outwards at all,
which is the routed-prefix uplink the reading was written for in the first
place.

`option gateway` is new in the preparation probe, and it is what places the
awkward router. A statically addressed uplink on a private address - a modem in
bridge mode behind another router, a double-NAT lab, an ISP handing out RFC1918
- has no dnsmasq stub and no masquerading zone to read instead, but its next hop
is off this router and nothing on the inside has one. The probe's network filter
grows by low single digits on the router it was already largest on: a dialled
session is handed its gateway by its peer and never carries the option.

**Both refusals now say what was looked at.** An address in no LAN's subnet
names the LANs the search looked in *and* the uplinks it skipped, each with its
subnet. An address that turns out to be on an uplink is refused by that
interface's name, with the evidence that made it one and with the two statements
- a section in `/etc/config/dhcp`, a firewall zone that does not masquerade -
that would change the answer if the classification is the thing that is wrong.
A LAN the configuration does not actually place is used and warned about rather
than silently trusted, because the forwarding is written from its zone once and
never rewritten. And a **WAN port** pick the router describes as a LAN is now
refused, by name and with the router's own words for it, which is what lets that
dropdown stop hiding anything.

**And the report stopped contradicting itself half a page later.** Binding a MAC
that holds no lease right now is a warning on a router with exactly one
interface the binding could be installed on, and a refusal on a router with more
than one - the forwarding is written once, from one LAN's firewall zone, and
with no lease there is nothing to say which. The warning was printed before the
LAN was searched, so on every router with two candidates it said *"The binding
is created either way"* at the top of the report and *"cannot be created"*
below, and the sentence a person reads first is the one at the top. It is
written from the candidate count now: one candidate keeps the original promise,
two or more says the device is not on the network and this router has more than
one interface a binding could go on, so connect it once and check again, and a
router with no LAN at all promises nothing and points at the refusal that is
really in the way.

### Three dropdowns that dropped what the operator came for

All three lists are built from the last router sample, and all three were
quietly deciding things a list may not decide.

- **WAN port**, on Binding 1-1, is capped at 500 rows, and that cap was a plain
  truncation over a list sorted with PPPoE at the top. A managed pool at its
  documented maximum of five hundred members therefore filled the list on its
  own and pushed every `dhcp` and `static` interface off the end - including the
  separate uplink the operator opened the form to bind out of. Nothing on screen
  said so, and the field's own hint sent them to Refresh, which cannot help: the
  port was in the sample and was thrown away after it arrived. The cap is a
  budget now. Every interface that is not a PPPoE session keeps its place
  whatever else is on the router, and the sessions fill what is left, taken in
  turn over the port each one dials over - so a pool on one port cannot bury a
  single session dialed on another, and only the tail of the largest pool is
  ever dropped.
- **WAN carrier**, on Create an instance, had the same cap and the same plain
  truncation, and it lost more: that list names *devices*, so a five-hundred
  session pool arrives as `eth1.101` through `eth1.600`, which sort between
  `eth1` and everything after it alphabetically. A router running a full pool on
  `eth1` beside a second uplink on `wan` and an LTE stick on `wwan0` was offered
  the pool's own carrier and the pool's own five hundred VLANs, and neither of
  the two other ports - so an instance could not be created on the very
  interfaces that were not busy. It is fitted by the same budget now: every
  device the pool is not riding on keeps its place, the carrier the pool rides
  on keeps its place because that is the row an operator picks to claim the
  whole pool, and only the tail of the pool falls off. Membership is read from
  the session devices themselves rather than from the port they share: an
  ISP-style trunk carries the pool's VLANs and other things besides, and a
  static second uplink on one of those other VLANs was counted as a five-hundred
  and first pool member, sorted after every `eth1.1xx`, and became the exact row
  the budget ran out on - the one uplink on that router that was not busy. The
  pool form's own carrier list on PPPoE Dialer never had this problem and is
  unchanged - a tagged device cannot enter it, so no pool can fill it.
- **DHCP LAN interface**, on Create an instance, dropped the interface literally
  named `wan` and kept only `proto static`. Both halves were the device-name
  guess wearing different clothes: a second ISP or an LTE failover on `wan2` was
  offered as one of the router's own networks because the string did not match,
  while a LAN that takes its own address by DHCP - a dumb AP, a downstream
  router - was hidden with nothing on screen to say why. It now lists every
  interface carrying an IPv4 address and running `static` or `dhcp` - a `pppoe-`
  netdev aside, which has a peer at the far end rather than a subnet behind it -
  and it names the protocol on each row, because the list mixes the two now.

Being permissive is the right trade for a control that cannot read
`/etc/config`: opening a form never starts an SSH command, so a dropdown has
nothing to decide with, and hiding the interface somebody needs costs them the
feature with nothing on screen to say why. It puts the weight on the check
instead, which is where the evidence is, and both halves of that bargain are
paid here. A **WAN port** pick the router describes as a LAN is refused by name
and in the router's own words, and so is a **DHCP LAN interface** pick the
router describes as an uplink.

That second gate is worth stating on its own, because opening the list without
it would have been the worse bug of the two. **Check the scope would have
accepted the router's uplink as the LAN to serve** - `wan2`, an LTE failover,
a statically addressed modem - and nothing further down would have caught it,
since the pool-identity guard below only speaks about an interface
`/etc/config/dhcp` actually serves and an uplink is not one. The instance would
have written its firewall forwardings from the WAN zone, laid its fail-closed
catch-all over the uplink's own subnet, and begun handing pool WANs to whatever
sits upstream of this router. Check the scope now classifies the chosen LAN from
what the router states about it, refuses a pick that reads as an uplink, quotes
the lines it read, and names the two statements - a section in
`/etc/config/dhcp`, a firewall zone that does not masquerade - that would change
the answer. Where the configuration settles nothing it says nothing, which is
the same rule the **WAN port** refusal follows: an interface merely not proven
is still yours to get right.

### The Enabled checkbox and the Enable button now answer alike

Ticking **Enabled** on a one-to-one binding's edit form and pressing the row's
**Enable** button are the same action - the flag is written and the next pass
writes the rule from it - and they disagreed about it twice.

They disagreed first about whether the router can steer traffic by routing table
at all: on a router that had lost `ip-full`, Enable refused by name with a
remedy while Save answered *done* and failed later inside a reconcile, where
nobody was looking. A save that raises the flag is now held to exactly what
Enable requires, and fetches its sentence from that same entry so the two cannot
drift apart.

The first cut of that gate refused the whole Save, which is a second way of
losing the operator's work rather than the end of the first. **Binding name**
and **When that WAN is down** reach the router through nothing at all, and
throwing a rename away because an `ip rule` cannot be written is a surprise
stacked on a surprise - most of all in the first seconds after a machine is
connected, when the module has not finished probing, every switch-on is refused
for that reason alone, and the router may well turn out to be perfectly capable.
Both refusal paths now write the fields that cost nothing, then refuse only the
switch-on; where the save carried something else, both end in the same words -
*"... Enabled is still off and no rule was written. Binding name was saved."* -
and where it carried nothing else, the capability refusal is the **Enable**
button's sentence word for word, which is what a test holds the two side by side
to prove. The row detail's hint under **Enabled** promised exactly this and is
now true on both paths.

They then went on disagreeing about what happens when the write fails on a
router that meets every one of those requirements - `option ip4table` deleted
from the WAN section by hand is the reported way in. The save runs the pass now
and takes the flag back when it fails, exactly as the button does, and returns
the pass's own sentence instead of filing it in the job list, because a Save is
something a person is sitting in front of: *"... failed - Enabled is still off and
no rule was written. Binding name and When that WAN is down were saved."* This
one states what the binding was left doing whether or not anything else was
saved, because the router's words are about a single command and say nothing at
all about the rest of the row.

Switching a binding **off** is deliberately still a plain record write. Off is
the way out of a broken state, and it corrects itself: every later pass finds a
rule in the band with no enabled record behind it and removes it again. A failed
Enable also refreshes the rows now, instead of leaving the page saying a binding
is on until the next pass arrives.

### A one-to-one create no longer leaves a firewall zone behind

Creating a binding asked for the module's masquerading zone to be written
alongside its forwarding. That zone belongs to the instance half, which has a
pool of WANs to put in it; a one-to-one binding names one WAN section by hand
and can never acquire a second. So on a router with no pool and no instance the
first binding left an empty zone in `/etc/config/firewall` that matched nothing,
survived reboots, and that no delete ever took away again. It writes forwardings
and nothing else now - to the zone the router already has the chosen WAN in,
including the pool zone itself where that WAN really is a member of it, in which
case its masquerading is left exactly as the pool wrote it.

**Updating does not remove a zone that is already there.** This release stops
the zone being written; nothing in it deletes one, and a delete has never
touched it either. So a router that took a one-to-one binding on 3.3.0 with no
PPPoE pool and no binding instance still carries a `config zone` named
`bmwanpool` - or whatever **Module settings → Advanced rules → Binding
firewall zone** says - with `masq '1'` and no members. It is harmless: a zone
naming no network and no device matches no traffic.

**The zone is not the only thing 3.3.0 left, which is why there is no one-line
cleanup here.** Each binding created on 3.3.0 also carries a `config forwarding`
of its own pointing *at* that zone, beside the one pointing at its real WAN -
they were written together, from the same list, and a delete removes only the
ones belonging to the binding being deleted. Deleting the zone while any of them
still stands leaves a forwarding naming a zone that does not exist, and fw4 then
warns about it and skips it on every reload. That is worse than the empty zone
it replaced.

So the residue comes off a binding at a time, and the release does it for you:
**delete each binding that was created on 3.3.0 and create it again.** The delete
takes that binding's own `bmd` sections with it - including the one pointing at
the pool zone - and the new create writes only the WAN's own zone. Once no
3.3.0-created binding is left, and only then, the now-unreferenced zone can go,
at a router shell:

```sh
uci delete firewall.bmwanpool && uci commit firewall && /etc/init.d/firewall reload
```

**Only on a router that has no PPPoE pool and no binding instance.** That zone
is the pool half's, and where either of those exists it is the zone the pool's
WANs are members of and the zone every instance forwards to - deleting it there
takes a working router's NAT off its uplinks. Check that **PPPoE Dialer →
Pools** and **WAN Binding → Instances** are both empty first, confirm with
`uci show firewall | grep bmwanpool` that nothing but the zone section itself
still names it, and use the name the settings field actually shows if it was
ever changed.

### The 512-record ceiling is a refusal now, not a silent drop

The per-router document keeps 512 binding instances and 512 one-to-one bindings,
and the two create gates counted something else entirely - the one-to-one gate
refused only once every preference in its thousand-wide band was claimed, and
the instance gate only when the catch-all priority slots ran out. Past the
ceiling a create therefore succeeded, wrote its rules, its firewall sections and
its routing-table claim onto the router, **and then vanished from the module on
the next read of the document** with nothing left that could name them, let
alone remove them.

Both gates now refuse by that number, name the list to delete from, and count
the creates still in flight. On a router carrying the shipped *Safety-rule
priority base* of 29900 the instance gate is not the one anybody meets, because
a hundred catch-all slots run out first; lowered towards its 2000 minimum, which
is what running many IP-range instances asks for, the slots stop being the limit
and the document becomes it.

### A LAN device that bounced took the router off its own LAN

An instance's catch-all table holds two things: the `unreachable default` that
makes it fail closed, and the LAN's own connected route, which is what keeps the
router answering SSH, DHCP and ARP on the LAN it is blackholing. The kernel
drops every route whose device goes down, in every table - and a LAN device goes
down for reasons that have nothing to do with binding: a `service network
reload` recreates a VLAN netdev, restarting wifi takes a wireless-only LAN's
device with it, a bridge with no carrier goes down when the last port is
unplugged. The blackhole beside it has no device and survives all three.

The per-tick repair compared only the rules, found the catch-all correct, and
wrote nothing - so the router sat blackholing its own LAN until a reboot or an
unrelated rule mismatch happened to rebuild the group. A route is not in
`ip -4 rule show` and cannot be read back, so the module now remembers the line
each instance's table actually accepted and writes it again the moment what the
LAN needs differs from it: one `ip route replace` on the next tick. The memory
is dropped when an instance is deleted, when its LAN leaves the sample, and on
reset, because a belief that the route is already there is exactly what would
stop it being put back.

### Instance creates read the router instead of the interface's name

Same fault, other half of the feature. A WAN pool collects interfaces by
protocol and by the device they terminate on, and neither of those says an
interface is *not* a LAN - every LAN runs `proto static` too. So a carrier
naming a device a second LAN happens to sit on put that LAN in the pool, and
clients bound to it left through one of the router's own LANs while the page
called them bound.

- The create now reads `/etc/config/dhcp`. A pooled WAN the router hands out
  addresses on is refused by name; one that both dials an uplink and serves DHCP
  is left in the pool with a warning naming both halves, because those two facts
  disagree and settling them here would be another guess.
- **And it now asks the classifier about the pool, not only about the LAN.**
  `/etc/config/dhcp` is one fact, and a LAN whose addresses come from a server
  downstream has no `config dhcp` section at all - so a static-only VLAN pulled
  in by a carrier scoped one device too wide was skipped in silence, and the
  create wrote `option ip4table` onto one of the router's own LANs and began
  handing it out as a WAN. The reading that could see it was being computed in
  the same function and thrown away: one entry was read out of it, for the LAN
  the form named, and every verdict about a pool member was discarded. Each
  member is now weighed, and one the router describes as a LAN is refused in the
  same words the one-to-one gate uses for a WAN port that reads the same way. An
  interface the configuration does not settle is still not refused anywhere.
- A pooled WAN whose own subnet overlaps the LAN being bound is refused. Rules
  that select on source alone cannot separate the two: the catch-all would cover
  the uplink's own address, and a client bound to that WAN would route the rest
  of its LAN out through the modem. A double-NAT uplink handed an address in the
  same private range as the LAN is the ordinary way to arrive there.
- The lease-ceiling plan matched the first `config dhcp` section that either
  named the LAN or was called after it, so a section called `lan` carrying
  `option interface 'guest'` - what a LAN renamed in `/etc/config/network`
  leaves behind - won, and the whole plan was made against the wrong LAN's
  ceiling. A section that says which network it serves now wins over one that
  merely shares its name.
- **Pin** on a device whose address is bound one-to-one is refused with that
  reason. The instance leaves such an address alone on every path, so a pin
  would have been recorded, dropped at the same gate on the next tick, and
  reported as success for something that was never going to happen.

### UCI booleans, read the way fw4 and netifd read them

`1`, `on`, `true` and `yes` all mean true to the programs on the router. LuCI
writes only the first, so a reader comparing against `'1'` is right about every
configuration LuCI produced and wrong about every hand-edited or migrated one -
which is the population these readers exist to be correct on. A firewall zone
spelled `masq 'on'` read as not masquerading: that printed a permanent *"Firewall
zone does not have masquerading enabled"* warning about a correctly configured
router, and on a router behind a bridged modem it moved the uplink three points
towards being classified as a LAN, so choosing the only WAN port was refused with
*"is a LAN on this router, not a WAN port"*. `option ignore` on a DHCP section
is read the same way now, and so is `option flow_offloading` on the firewall
defaults - twice, because two readers of it were wrong. **Router limits** was
telling a router that already had software flow offload running that it was
switched off, and offering to turn on what was on with no way to turn it off,
while Check the scope printed the same claim as advice on every instance create.

There is one reader of a UCI boolean in this module now rather than four
near-copies of one, which is the actual repair: the four had been written
separately and three of them were applied to some of their own booleans and not
to others, so a fourth wrong answer was always going to be found next.

Three more spellings of the same kind were closed alongside it.

- A `config dhcp` section that names its network by being *called* after it,
  rather than by carrying `option interface`, is now read as serving that
  network - which is what dnsmasq does with it. Three readers of
  `/etc/config/dhcp` disagreed about that, so on exactly those routers the guard
  above could never fire at all.
- A firewall zone may name its members with `list device` instead of
  `list network`, which fw4 accepts and which is an ordinary way to put a VLAN
  or a plain port in a zone. Both the create gate and the apply that re-reads
  the zone a moment before writing resolve it that way now, and they had to land
  together: had only one of them learned it, every such router would have got
  *"the LAN firewall zone changed; check the form again"* instead of the refusal
  it used to get. A zone that still cannot be resolved is refused with both
  spellings named and with which of the two was searched, rather than with a
  flat claim that the interface is in no zone at all.
- A zone written `option network 'lan guest'` - one quoted token holding two
  names, which fw4 splits on whitespace - matched nothing, so a router spelled
  that way was told its LAN was in no firewall zone and its create was refused
  for something the operator had already done. That value is split now,
  everywhere `/etc/config/firewall` is read.

### The monitor stopped being certain about things it could not know

- **A router with no `/etc/iproute2/rt_tables` showed nothing at all.** The
  kernel's three baseline rules were recognised by the words `local`, `main` and
  `default`, which are names out of that file rather than facts about the
  kernel. A router that prints them as `lookup 255`, `254` and `253` had all
  three reported as foreign policy rules, at which point the scan read its own
  reply as one that had lost its baseline in transit and threw the whole thing
  away. They are compared by number now, so the same three rules are recognised
  said either way.
- **A table token this reader will not accept is now recorded as unread** rather
  than truncated to its leading acceptable characters. A rule pointing at a
  table named `x;reboot` - and an `rt_tables` name is whatever the administrator
  typed - came back as pointing at table `x`, which on that router is a
  different table with a different way out, stated as fact. Such a row says the
  table could not be read, which is not the same thing as a rule that names no
  table at all and is acted on directly.
- **`wan6` was printed as the WAN an address is bound to.** Resolving a netdev
  to an interface answered with whichever claimant came first, and on every
  dual-stacked OpenWrt `wan` and `wan6` sit on the same netdev by both spellings
  at once. Everything this folder reads is IPv4, so a tie is broken on which
  claimant carries an IPv4 address at all - and where that still leaves two, the
  answer is the bare netdev name: less than the reader wanted, and true.
- **A stranger's rule at a catch-all preference was described as this module's
  own fail-closed catch-all.** The preference alone was the evidence, on the one
  rule whose job is to take a LAN off the internet. Three more facts are checked
  now - a source address at all, one inside that instance's LAN, and that
  instance's own catch-all table - each only where the router actually states
  it, and a rule failing any of them is reported as foreign with the coincidence
  spelled out.
- **mwan3 was named as the writer of every unattributed rule** on a router where
  mwan3 is merely installed - which would file the hand-written rule somebody
  opened this page to find under somebody else's name. It now says mwan3 is the
  likeliest thing to have written it and that nothing here can be sure, unless
  the rule steers on a firewall mark the way mwan3's own rules do.
- **A binding pointed at the WAN the rest of the router already uses** was
  described as not using the router's default connection. Pinning the NAS to the
  primary while a pool moves everything else is a legitimate thing to do, and a
  table whose default leaves through the same interface main's does is not
  taking that address anywhere.
- **A binding whose device had just left the network was reported as somebody
  else's rule, and the page's advice was to go and delete it.** A binding that
  names a MAC keeps its rule at the last address the device was seen at for the
  whole of **Lease release grace (s)** - five minutes by default - which is the
  point of the setting: a laptop that sleeps for thirty seconds does not lose
  and regain its WAN. The monitor judged ownership on the live lease alone, so
  for that whole window it filed the module's own rule, at a preference inside
  the module's own band, under *written outside this module* - and what this
  page says to do about a foreign rule outranking the module is to remove it. It
  now asks both addresses, the one the binding resolves to now and the one its
  rule still stands at, and says which of the two it matched. The `outranks
  module` reading is kept alive across the grace by the same union, instead of
  going quiet for exactly the five minutes when a rule is least explicable.
- The sentinel that discards an unreadable scan now names both halves of what
  can fail - `ip -4 rule show`, or the temporary file its output is captured to -
  instead of sending a reader whose `/tmp` had filled up to look at their `ip`
  command.
- **A WireGuard rule was told it outranked the module.** "A binding shown as
  applied is not where the traffic actually goes" was said of any low-numbered
  rule with no source selector, which is every rule keyed on an ingress or
  egress interface - so `ip rule add iif wg0 lookup 51820`, which can only match
  packets arriving on the tunnel, got the red chip and that sentence on any
  router that also had a binding. A rule naming `iif` or `oif` names the wire a
  packet came in on or leaves by, and the packets this module steers arrive on a
  LAN, so there is nothing of ours underneath it. A rule selecting on `fwmark`
  still gets the warning: a marked packet from a LAN client is exactly the case
  it is right about. Either way the low preference is still reported - only the
  consequence and the chip are withheld.

### What the module says about itself

- **The Held tile counted the wrong thing.** It counted the word `held` and not
  the rule, so a MAC binding whose device had walked onto another LAN overnight
  and whose owner had chosen *Keep it off the internet* sat parked on the
  unreachable table with the tile reporting nothing detained. It counts every
  binding whose rule points at that table now - which is the same condition the
  row's own Table cell uses, so the two can no longer disagree - and the
  `directHeld` history series behind the chart is corrected with it. The
  Overview's own note names both detentions now instead of only the first.
- **The same roamed binding's State chips said the same thing whichever way it
  was set.** A binding whose device has walked off the LAN it was bound on read
  *moved off its LAN / no firewall path* regardless of **When that WAN is
  down**, and those two answers send it to opposite ends of the router: parked
  on the unreachable table with the device off the internet, or re-pointed at
  **main** and out through the router's ordinary WAN. So a device quietly
  leaking past the metered line it was pinned to looked, at a glance, exactly
  like one that had been switched off. The second chip is asked now rather than
  assumed - *no way out* when it is parked, *on the main table* when it is not -
  in the same words the **held** and **fallback** rows already use, and the
  row's own **Table** cell is drawn from the same question, so the two cells
  cannot drift apart again.
- **The One-to-one bindings table's When down column printed the stored word.**
  `fallback` is also the State chip's word for a binding whose WAN is down right
  this minute, so one table carried the same word for a setting and for a
  condition and a row could read *fallback / fallback*. The column prints the
  option as the two selects word it - *Keep it off the internet*, *Let it use
  the default connection* - while the edit form's own select still opens on the
  stored value, which is what it has to match.
- **A range-scoped instance did not say so anywhere.** The Binding instances
  table showed `br-lan` for an instance serving a window of that bridge exactly
  as for one serving all of it, so a device simply left outside the range looked
  like an assignment the planner had lost. There is an **Addresses** column now,
  it is one of the columns the filter box searches, the row detail repeats it as
  *Addresses served*, and the note about what cannot be edited names the range
  alongside the LAN and the carrier.
- **Binding 1-1 had no Refresh now control** while its refusals told the reader
  to press one and its field hint sent them to another tab for it. It has one.
- **Binding 1-1 had no install form** either, so the tab that is gated on
  `ip-full` was the only create on the page that could not offer it - and the
  banner above, which still spoke of two creates rather than three, sent the
  reader to Module settings for a package the tab in front of them could have
  installed. It carries the same form the other two create tabs carry; its
  hints say which of those packages a create *there* is really gated on, which
  is `ip-full` and nothing else; and the banner now names all three creates.
- **Both When-down hints described falling back as removing the rule.** It has
  never removed it since the feature shipped: the rule stays at its own priority
  and is re-pointed at the **main** table, which is the whole reason the option
  is safe on a LAN an instance owns - removing it would drop the address into
  that instance's fail-closed catch-all and take the device off the network
  entirely. Both hints now say so, and say that *Rule as it should stand* names
  the table to compare against `ip -4 rule show` by eye.
- **Several refusals sent people to a settings group by a name it does not
  have.** *Module settings, Rules* is called **Advanced rules** on screen, and
  eight sentences said the first - five create refusals about priority bases and
  routing tables, the catch-all installer's own error, the Monitor's note about
  its scan interval and the Dashboard's note about a waiting device. All of them
  name the group as the rail spells it now; the Monitor's names the field
  (**Binding scan interval (s)**) as well, and the Dashboard's names
  **Client-rule priority base** the way the form does.

## 3.3.0

Needs Bored Manager **0.7.0** and OpenWrt **25.12 or newer**. Router packages
stay pinned at **2.2.0**: nothing on the router side changed, and a router
running the 2.2.0 packages needs no attention for any of this.

### Why the app floor moved

A module ships JSON block specs and nothing else - no React, no CSS, no chart
component. So two of this release's surfaces could not be built here at all;
they were built in the app first and are opted into by the page spec.

- **The Connection rail expands in place.** PPPoE Dialer and WAN Binding are
  groups now, and their entries live under them in the rail instead of behind a
  second rail nested inside the page. WAN Binding has six: Overview, Binding
  1-1, Instances, Create an instance, Monitor, Behaviour. Any of them is one
  click from anywhere on the page, where operate, create and tune used to be
  three scrolls apart below a table that can be a thousand rows tall. Below the
  `md` breakpoint the horizontal strip flattens the groups away, because an
  accordion inside a strip is not one.
- **A row's detail opens nearly full screen.** A pool's detail is six tabs, and
  a `sm:max-w-xl` drawer was the wrong container for it by a wide margin. Four
  tables on Connection ask for a modal at roughly 94% of the window over a
  dimmed page: the pool table under PPPoE Dialer → Pools, and under WAN
  Binding the **One-to-one bindings** table on Binding 1-1, the **Binding
  instances** table on Instances, and **Rules on the router** on Monitor.
  Every other table in this module still opens the drawer, and so does every
  table in every other module: it is opted into per table and defaults to what
  was there before.

An app below 0.7.0 refuses to install this release rather than rendering the
page half-built.

### Binding 1-1: one address out one WAN port

An instance is an automation - it watches a LAN and hands out whatever WANs are
free. Until now that was the only binding this module could do, and it is not
what somebody wants when one machine has to leave by one line and no other. A
one-to-one binding names one target and one WAN port, and nothing about it is
allocated, remapped or released.

The target is an **IP or a MAC**, chosen per binding. A MAC is resolved through
the leases on every pass, taking that MAC's longest-running lease rather than
the first line for it: a device that moved between LANs leaves the abandoned
lease behind, and a rule written for the old address steers nothing while
looking exactly like a binding that works. A lease that moves moves the rule; a
device that leaves keeps its rule for the lease-release grace and then loses
it; a MAC with no lease at all is a warning rather than a refusal **on a router
with exactly one interface the binding could be put on**, and its rule appears
when the device does. Where more than one could be, it is a refusal instead: the
forwarding is written once, from one LAN's firewall zone, and with no lease to
place the device there is nothing that says which.

It writes three things: `option ip4table` on the WAN section if it has none,
a firewall forwarding from the address's own LAN zone under this binding's own
`bmd<slot>_` prefix, and `ip -4 rule add from <ip>/32 lookup <table> pref
<pref>` at a preference from a band of 1,000 that sits **below** every
instance's. The lowest preference wins, so a binding somebody placed by hand
beats the assignment an instance handed the same device - and because the
instance planner starts reading at its own base, a rule down here is invisible
to it and can be neither adopted nor deleted. The planner is told about the
address as well, on all three of its paths, so a device that already held an
assignment loses it on the next tick, frees the WAN it was holding, and appears
in the waiting table reading *bound one-to-one*.

**When the WAN goes down** a binding either holds (the default, fail closed) or
falls back to the router's ordinary connection, per binding. Hold is an
explicit re-point at the module's unreachable table, not a rule left where it
was, and the reason is worth stating plainly: a rule whose lookup table has no
matching route **does not fail**. The kernel's fib-rule walk carries on to the
next rule and out of the main table - the default connection. A "hold" that
left the rule alone would send exactly the traffic it was meant to detain out
of exactly the link it was meant to avoid, while the page said *held*.

Falling back is a re-point too, at the **main** table rather than at nothing.
Removing the rule only reaches the default connection on a LAN no instance
owns; where one does, its fail-closed catch-all would catch the address the
instant the rule went, and the option somebody chose to keep a device online
would have taken it off the network altogether. Two further states say so out
loud rather than lying quietly: a MAC binding whose device turns up on a LAN
this binding has no firewall path from reads **stranded**, and is then treated
exactly as though its WAN had gone down - *Keep it off the internet* parks it
on the unreachable table, *Let it use the default connection* re-points it at
main - rather than writing a rule fw4 would drop. And two bindings that
resolve to one address leave the lower-preference one in force with the other
reading **shadowed** and naming it.

On a router where `bm-wanbind` owns binding, one-to-one bindings are still
written by this module into their own band; the two writers never touch the
same preferences. What the daemon cannot do is skip an address, so it will also
allocate a bound device a pool WAN it never uses - a warning on the create
form, in those words.

### An instance can watch an address range

A binding instance can be scoped to an IP range inside one LAN instead of the
whole of it, which is how a network gets one automated block for the machines
that each need their own line while everything else on the LAN carries on
normally. Both endpoints must be IPv4, in order, and inside the LAN's subnet.
There is no maximum size, because nothing anywhere iterates the addresses in a
range - every per-device decision is lease-driven.

The part that had to be redesigned is the **fail-closed catch-all**. A
whole-LAN catch-all under a range instance would blackhole every device on the
LAN outside the range: the planner only assigns leases inside it, so nothing
else would ever get a rule of its own to outrank the catch-all. So a range
instance's catch-all is written as the minimal set of CIDR blocks covering
exactly the range, all sharing the one catch-all preference the instance owns,
and the per-tick repair compares that preference group as a **set** rather than
asserting a single rule - which is also what stops it tearing a multi-block
catch-all back to one whole-LAN rule every thirty seconds.

One instance per LAN is still the rule, range or whole-LAN. The range is fixed
for the instance's life, like its LAN and its carrier. And a range is refused
outright while `bm-wanbind` owns binding: the daemon's sections carry a LAN and
a carrier and nothing else, so it would bind the whole LAN while the range
existed only in this module's records. The refusal names the package and both
ways out.

### The binding monitor

The fast sweep filters `ip rule show` down to this module's own preference
window on the router. That is what keeps a sweep small at a thousand bound
clients, and it is also why a rule *below* that window has always been able to
steer every packet while appearing nowhere: bindings read as applied, the
dashboard is green, and the traffic leaves by another WAN. The readiness card
has warned about the count since 2.x. It could not say what those rules do.

**Connection → WAN Binding → Monitor** reads the whole table instead - one
round trip, capped at 500 rule lines, 64 tables and 8 route lines each, with a
fail-closed sentinel so a router that could not read its own rule table reports
a failed scan and never an empty one. It has its own parser, because the
sweep's requires a numeric lookup and a `from` and would silently drop a rule
with a named table (`lookup vpn`) and every selector-only rule - which is to
say, precisely what the monitor exists to find.

Each row gets an owner decided by evidence: a **one-to-one binding** (a
preference in the band with a record stamped to it), an **instance**, a
**safety catch-all**, the **bm-wanbind daemon**, **mwan3**, or **outside this
module** - the last being the answer the feature was built to produce. Bands
come from each instance's stamped layout rather than today's settings, so
moving a base does not make the module start calling its own rules foreign.
Beside the owner, each row says which table the address looks up, where that
table leads, and how that differs from the router's default connection, plus
the honest variants: *no way out* for a table with no matching route (claimed
only when the routes pass actually reached that table), *held*, and
*outranks module* - which is the sentence that finally explains a binding shown
as applied whose traffic goes somewhere else.

**It never touches a rule.** It has no write path at all, and the rules it is
best at finding are exactly the ones whose purpose nobody here can know. It
also costs nothing on a router nobody is watching: the scan runs only while the
Connection page is open and stops when it closes. The gate is per page rather
than per tab - that is what the app can answer - so sitting on Pools keeps it
running.

### Charts on both automations

Neither automation had a chart - only number tiles, on the page where the
consequences show. PPPoE Dialer's Pools now carries the session states over
time and pool throughput; WAN Binding's Overview carries bound against
waiting, the free WANs against errors, the WAN pool as a pie, a bound-percent
meter and the one-to-one counts. Five history keys are new - `wanFree`,
`wanErrBound`, `pppDial`, `directOk` and `directHeld`. `wanUp` is the one key
reused as it stood: *Sessions by state* draws it as **Up**, relabelled rather
than duplicated, so that series has history from the day it was first
recorded. Error is the one worth reading twice, because this release ends up
with two of them. `wanErr` - failed sessions in the dialer's own pool - is
reused the same way on that same chart, but *WANs free and WANs failing* on
WAN Binding's Overview draws `wanErrBound`, which sums the failed WANs across
the pools binding instances hand out from. An instance can be bound to a
carrier the dialer never touches, and a dialer pool can be failing while no
instance uses it, so charting either number in the other's place read as a
flat zero on the first router and as somebody else's problem on the second.
`wanErrBound` is new here and starts with nothing behind it. The `binding`
stream carries a WAN-pool aggregate and a bound percentage, because a spec can
render a ratio but cannot compute one.

### Automation is now Connection

The page is called **Connection**, in full: label, id and spec filename. It has
not been only about automation for a while - it holds the dialer, binding, the
jobs both of them run and the events both of them raise.

One consequence worth knowing before it surprises anybody: **a saved active tab
pointing at `openwrt/automation` no longer resolves, and the app falls back to
Overview once.** Pick Connection again and it sticks. Nothing else is affected,
and no per-router state is touched by the rename.

### Two new settings

Both are in Module settings → Advanced rules, beside the numbering they belong
with.

- **One-to-one rule priority base** - 1000 to 28000, default 19000. Where the
  band of 1,000 preferences that one-to-one bindings are stamped from begins.
  It is deliberately not locked the way the instance bases are: each binding
  carries the preference it was written with, so moving the base only decides
  where new ones go. What it may never do is run the band into the instance
  band, and a saved value that would is discarded when the rules are next read.
- **Binding scan interval (s)** - 15 to 3600, default 60. How often the Monitor
  re-reads the rule table while somebody has that page open. Changing it
  re-times the poller rather than waiting for a reconnect.

### Downgrading below 3.3.0 leaves rules behind

The per-router document is at schema **v3**. A v2 document loads unchanged, as
v1 did into v2 - but the reverse is not symmetrical, and this is the one thing
in this release that can bite quietly.

A build below 3.3.0 has never heard of one-to-one bindings. It discards those
records on load **while their rules stay on the router**, where the older build
cannot recognise them and this build's own monitor would name them as written
outside the module. There is then nothing in any app that knows what they were
or removes them; they have to be taken off by hand at a router shell.

**Delete every one-to-one binding before downgrading.** Deleting takes the
rule, the `bmd<slot>_` firewall sections and the routing-table claim with it,
which is exactly what a downgrade does not do.

## 3.2.1

- **Declares the storage it uses.** Bored Manager 0.5.0 lets a module say in its
  manifest what it needs kept for it, and grants that rather than applying one
  fixed cap to everything. This module asks for what it already used: the same
  512 KB for its settings and for what it remembers per machine.
  It writes one history stream of its own (`openwrt`) and is granted 32 MB of the
  metrics store for it.
- **Nothing else changed**, and nothing about it needs a newer app. `minAppVersion`
  is untouched: an app that has never heard of a `storage` block ignores it, so
  this release installs on 0.4.3 exactly as the previous one did. On 0.5.0 and
  later it also shows up in Settings → Data & storage with its own figures.

## 3.2.0

Needs the same Bored Manager **0.4.1** and OpenWrt **25.12 or newer**. Router
packages **2.2.0** for Direct carrier mode; a router still on 2.1.x keeps
working over the VLAN path and the create form refuses Direct until the
packages are updated.

### Direct carrier mode, same two account modes

Create a pool with Carrier mode VLAN (802.1Q per member) or Direct (every
member dials the carrier itself, untagged). MAC mode auto or inherit is
available on both. Direct needs `bm-pppoe-pool` API 3; the module refuses
it locally on an older daemon and never sends the key.

`kmod-macvlan` is installable from Module settings but optional: a VLAN-only
router without it is not unfinished. The readiness card warns, it does not
turn the router red.

### Naming

Every user-facing label is **PPPoE Dialer**. Package ids stay `bm-pppoe-pool`,
`bm.pppoe`, `bm_pppoe`.

### Pin

`main/agent/manifest.ts` pins **2.2.0**, the release this module ships against.

## 3.1.0

Needs the same Bored Manager **0.4.1** and OpenWrt **25.12 or newer**. Router
packages **2.1.0** for the new agent calls; every new surface also works
without them, over SSH, and says which half is doing the writing.

### A healthy router was failing the policy-routing probe

The probe proves policy routing by dumping a numeric table:
`ip -4 route show table 29999`. The kernel creates FIB tables lazily, so on a
router where nothing has written to a high-numbered table yet - a fresh
OpenWrt 25.12.5 under QEMU, for one - modern iproute2 answers that dump with
exit 1 and `Error: ipv4: FIB table does not exist.` The probe required exit 0,
read the refusal as BusyBox-or-worse, and the readiness card said *"the kernel
refuses numeric routing tables - no package fixes that"* about firmware whose
own `bm-wanbind` was binding clients over netlink at that very moment. Two of
three readiness checks passed; the third was wrong.

The fragment now captures stderr and treats that one exact sentence - matched
case-insensitively, from the PATH `ip` and the libexec binary separately - as
the pass it is: the kernel *parsed the numeric table and looked it up*, which
is the capability under test. BusyBox's `invalid argument` stays a failure,
and a kernel genuinely without `CONFIG_IP_MULTIPLE_TABLES` still fails
`ip -4 rule show` itself. The QEMU router reads 3/3 ready.

### The module and the router agree about WAN binding now

Same root, second symptom: with `bm-wanbind` installed and binding, the module
still gated `bindingStart` and friends on its own `ip` probe - so LuCI said
"binding" while the app refused to start an instance over a binary the daemon
path never uses. The `ipRule` requirement is met by *either* half now: the
local `ip` passing the numeric-table test, or a usable agent whose features
provide `binding` - the daemon writes rules over netlink and does not care
what `/sbin/ip` links to. And on a router where the kernel-refuses verdict
does still come up while the daemon is running, the readiness row says out
loud that the verdict is probably the probe being wrong, instead of sending
somebody to reflash working firmware.

### Router limits: the scale advice became a page that applies it

Since 2.x the binding capacity check has *named* the values a big deployment
needs - conntrack, the neighbour thresholds, flow offload - and left the user
a shell. Vietnamese ISP-scale routers hit exactly those two tables first:
conntrack full drops new connections, neighbour overflow drops ARP, both with
one dmesg line to show for it.

**Module settings, Router limits** reads them live (the slow sweep carries a
`===SYSCTL===` section now, five sysctls and fw4's `flow_offloading` in the
same trip it already made), sizes a recommendation from what this router is
actually carrying - leases and pool sessions, floored at 262144/2048/4096/8192
so an idle router is never told to shrink - and applies through
check-then-apply with the same token discipline as the rules editor. The check
refuses a conntrack max below the entries in use right now (legal bounds
cannot catch that; only the live count can), refuses an inverted threshold
trio merged against what the router holds, and reports current usage with a
warning from 80%.

Who writes is decided per apply: the router's own `bm-agent` (packages 2.1.0+,
`tune_set`) or SSH when it is older - both pin the same
`/etc/sysctl.d/60-bm-scale.conf`, so the reboot story is one file whichever
half wrote it. The guard's snapshots deliberately do not cover that file: a
restore must never quietly shrink a capacity fix. The three capacity findings
now point at the page instead of printing raw `sysctl -w` lines, and the
create-instance hint about "the module deliberately does not write them" now
says where the deliberate place is.

`limitsEffective`, `limitsCheck` and `limitsApply` bring the method table to
forty-eight, all through the same requirements gate.

## 3.0.1

Needs the same Bored Manager **0.4.1** and OpenWrt **25.12 or newer**. Router
packages **2.0.1**. One fix, and it is the one that decided whether 3.0.0 could
be deployed at all.

### The pinned install put the wrong packages on the router

`main/agent/manifest.ts` is what *"the release this module was built against"*
means: the router downloads each `.apk` from the URL in that file and checks it
against a sha256 compiled into the module. It is written by
`npm run pin:packages`, which can only read a package release after that release
is published - so the correct order is to tag the packages, pin, commit, then
tag the module. 3.0.0 was tagged without the pinning step, and shipped pointing
at **packages 1.4.1**.

Nothing failed where it could be seen. The install downloaded, every checksum
matched, apk reported success - and the router ended up running the 1.4.x
daemons under a module that drives the 2.x pool API. So `bm-pppoe-pool`
declared API 1, the pool gate refused with *"the installed bm-pppoe-pool speaks
version 1 of its contract and this module drives 2"*, and the remedy it named -
Router packages, install from the pinned release - installed 1.4.1 again. The
same shape as the `ip-full` loop 2.5.0 fixed: a correct refusal, and the only
button on offer could never change the answer.

The pin is now packages 2.0.1, and `npm run pin:check` runs on the module's
release tag so a module can no longer be published pinned to anything other
than the release in `packages/version.json`. It is deliberately not part of
`npm run check`, because the commit that bumps the package version legitimately
predates the release it names - the reasoning is written out in
`scripts/check-pin.mjs`.

### Both router-fetched paths work now

Packages 2.0.1 is the first release with a signed manifest, which is what
`bmctl check-update` on the router and *Latest release, fetched by the router*
in Router packages both verify before downloading anything. Until now there was
no release key at all, so both refused - correctly, and with no way forward.

One bootstrap remains and is not a fault: a router has to receive the public key
before it can verify anything, so the first 2.0.1 install comes from the pinned
source or a bundle. After that the router looks after itself.

## 3.0.0

Needs the same Bored Manager **0.4.1** and OpenWrt **25.12 or newer**. The
router packages move to **2.0.0** alongside it, and for the first time one of
them is load-bearing: **PPPoE pools exist only through `bm-pppoe-pool` 2.x**.
The SSH path that wrote batches of numbered interfaces is gone, and so is the
batch model itself. Everything else - the dashboard, WAN binding, events, jobs,
the installer - works exactly as it did on a router with nothing installed.

### Breaking: PPPoE is the router's own, or it is not at all

Since 2.3.0 a pool could be written by either half, and that was the wrong
generosity. Three writers - this module over SSH, the daemon, a LuCI page -
shared one prefix arithmetic, one zone, one idea of what a pool was, and every
release had to keep the three from drifting. The daemon owns all of it now: the
record, the network sections, the tagged devices, the firewall zone, the MACs.
This module carries a spec to the router (a `0600` file over the connection it
already has - a password still never becomes an argument to anything) and asks
`bm.pppoe` to check, create, edit or delete; it writes no PPPoE section of its
own any more, over any transport.

A router without the package keeps everything else. The PPPoE tab says what is
missing and where to install it - Router packages, in Module settings, same as
ever - and the create form refuses with the same sentence. A router whose
`bm-pppoe-pool` is still 1.x is named too: the readiness row says the package
speaks version 1 of a contract this module drives at 2, and that updating the
packages is the fix. Its pools keep dialling throughout - netifd needs no
opinion from anyone here.

**Batches created by earlier releases appear as legacy pools**: listed with
their prefix, range and carrier, counted on the tab, and delete-only. There is
nothing to migrate them into - the old model recorded a sequence range, the new
one records members - and deleting one still takes everything it wrote off the
router, five-digit sections, shared VLAN devices and zone memberships included.
The 2.4.0 SSH fallback for start/stop/redial on old batches is gone with the
model: a legacy pool is a pool being wound down, not operated.

### A pool is VLANs now, not sequence numbers

The old form asked for five thousand account lines because it was written for
an ISP that hands out five thousand accounts. The ISPs these routers actually
sit behind hand out a few VLANs on one uplink, one PPPoE session each - often
all on one shared account the BRAS tells apart by MAC. That is what a pool is
now:

- **One member per VLAN**, at most 500, on one carrier. VLAN 0 means untagged.
  Member lines are `vlan`, or `vlan,user,pass` - comma, tab, semicolon, pipe or
  spaces, same as before, with blank and `#` lines ignored.
- **Two modes, chosen at creation.** *One shared account* (`multi`) carries the
  account on the pool; *one account per VLAN* (`single`) carries it per line.
- **MACs are derived, not stored**: locally administered, hashed from the
  carrier's own MAC and the pool id, VLAN in the last two octets. Two pools on
  one carrier differ; the same pool re-created lands on the same MACs, so the
  BRAS never meets a stranger. This is what makes a shared account workable.
- **Everything else is arithmetic the router owns.** Prefix `fpt` and VLAN 101
  are section `fpt101` on device `pppoe-fpt101`, routing table `table base +
  101`, member of the pool's own zone. There is no module-side numbering left
  to collide with anything.

Editing exists for the first time: members, label, credentials, DNS, MTU, the
whole advanced set - everything but the prefix and the mode, which name what a
pool *is*. The check runs on the router while you type, comes back with the
same findings an apply would refuse on, and says which changes redial sessions
before you make them.

### The tab is three errands again

**Pools** carries the tables: the state counts across every pool, one row per
pool with its member rows in a drawer, per-row and per-pool actions - up, down,
redial, and now **enable and disable**, which persist on the router so a
disabled member stays down across reboots. A member the record names but the
router does not yet have reads `unwritten`, on its own badge - the state a
create that died half way leaves, and the state nothing had a word for. The
legacy table sits below with its one action. A pool is at most 500 members, so
the two-tab split the 5,000-row batch drawers needed is not carried over: the
drawer is one filterable table.

**Create a pool** is the form above, with the carrier list served by the
router's own daemon - it refuses bridges, tunnels and already-tagged devices
with the same sentences the daemon would.

**Daemon settings** is new: the counter interval and the redial watchdog's
patience and batch size live in `/etc/config/bm_pppoe` on the router, and this
is the first surface that can edit them. The module-side imitations of those
knobs are gone from the rules (below).

### Delete needs the daemon now, and that is a rule changing

"Stop and Delete never refuse" has been the standing promise since 2.1.0, and
for binding instances it still holds. For pools it cannot: only the daemon
knows everything a pool derived, so a router that lost the package cannot
delete a pool until the package is back, and the refusal says to reinstall it -
which is also the only path that ever removes the pool. What this module still
adds is the gate the daemon cannot see: a delete is refused by instance name
while a **running** binding instance is distributing clients across the pool's
carrier, because the pool would go while the fail-closed catch-all stayed, and
`eth1` and `eth1.835` still count as the same uplink in both directions.

### Six rules are gone, because their subject is

*Interface prefix*, *firewall membership mode*, *UCI chunk size*, *chunk
delay*, *max batch rows* and *auto-redial after* have no module-side meaning
left: pools carry their own prefix and zone on the router, nothing is chunked
over SSH any more, and the watchdog is the daemon's, tuned on the Daemon
settings tab. The rules form keeps what binding still uses, and only the three
rules that place binding's own objects - the two priority bases and the
catch-all table - stay locked while instances exist. Saved overrides for the
removed rules are dropped on read.

The per-router document moves to version 2 the same way: the batch records and
their sequence counter are gone, and a version-1 document loads cleanly - its
`batches` and `nextSeq` are deliberately not read, because the daemon's answer
has replaced them as the truth. Job history, events, binding instances and
sticky maps all carry over untouched.

### Inside

`main/agent/pppoe.ts` is the entire client for the daemon - every call, the
`0600` spec push, the reply shapes - and `main/pppoe/` was rewritten from a
planner into a view: a short-TTL cache of the daemon's `info`, `sessions` and
`stats`, the check/apply session plumbing, and the actions. `main/uci/` shrank
to the primitive binding still needs (`uci batch` over SSH) plus the name
sieves; the PPPoE plan builder, the firewall builder and the sequence
arithmetic are deleted, not moved. The methods the pages call are renamed to
match what they do - `poolCreateCheck`/`poolCreateApply`,
`poolSetCheck`/`poolSetApply`, `poolDelete`, `pppoePoolAction`,
`pppoeConnAction`, `pppoeSettingsGet`/`Check`/`Apply`, `pppoePools`,
`pppoeRows`, `pppoeLegacyRows`, `pppoeCarriers` - and every one of the
forty-five goes through the same requirements gate as before, with one new
requirement key behind it: the pool daemon itself.

## 2.5.0

Needs the same Bored Manager **0.4.1** and OpenWrt **25.12 or newer**. The
router packages move to **1.4.1** alongside it: one fix, which is what lets the
router's own LuCI pages call the daemons at all - see `packages/CHANGELOG.md`.
This release is about where things are on the three pages, and about two
answers the module was giving that were not true.

### Every page is grouped by a rail

The Dashboard and Module settings were each one column of stacked sections - six
and seven of them - so a wide monitor got one very long scroll and everything
below the first screen was found by scrolling past it. Both now sit behind the
same `subnav` rail the Automation page already used, which is the block the
app's own Settings page is built from:

| Page | Rail |
|---|---|
| Dashboard | Overview · History · Devices · Interfaces |
| Automation | PPPoE Dialer · WAN Binding · Jobs · Events |
| Module settings | Router readiness · Router packages · Jobs · Display & charts · Advanced rules |

Forms sit beside their explanation in a two-column section rather than under it,
the readiness cards go up to six across instead of three, and the seven live
tiles go four across.

### Automation: each automation owns its own configuration

**Create is gone as a tab.** It held four unrelated things - the PPPoE create
form, the binding create form, a second copy of the package installer and a
second copy of the job monitor - which meant neither automation's own tab could
create anything, and the tab that could was about both of them at once.

*Create a PPPoE batch* is on the PPPoE Dialer tab now and *Create a WAN Binding
instance* is on the WAN Binding tab, each with the install prompt for what *that*
automation is missing - decided by the verdict rather than by `setupNeeded`,
because binding needs either `ip rule` or dnsmasq and a spec cannot ask "either
of these". The duplicate job monitor is gone; the Jobs tab was always the one
that kept every step.

Two rule groups moved with them. *Batch pacing and limits* is a PPPoE setting and
now sits on the PPPoE tab; *Binding behaviour* is a binding setting and sits on
the binding tab. Module settings keeps what the two share - the numbering and
firewall layout, housekeeping, and Reset every rule.

Each of those two tabs then got a rail of its own: *Sessions · Create a batch ·
Pacing and limits* on the dialer, *Instances · Create an instance · Behaviour*
on binding. Operating, creating and tuning are three different errands, and on
one scroll the last two sat below a table that can be a thousand rows tall.

### The hints toggle now switches off everything it says it does

*Show the explanatory notes* reached 12 of 48 notes and none of the 50 field
help lines, because `FormField.help` renders as an always-on paragraph and
nothing in the spec language can gate it. So there is no field help left
anywhere: every explanation is a note, one per form, beside it rather than under
each field, and the toggle switches all of them off. State banners are
deliberately not affected - "this router cannot be managed", "the numbers below
are frozen" and "compatibility mode" are not hints, and a page that went quiet
about them would be tidier and wrong.

### The dashboard charts have a range, and a sample interval

All four charts pinned `window: 21600`, which overrides the range picker the app
draws above the page - so that control was visible and inert, and every chart was
six hours wide whatever anyone pressed. History is a rail item now with its own
**1 hour / 6 hours / 24 hours** switch.

Underneath it, a history point used to be written once per slow sweep, because
that is where the call happened to sit. One point per minute however fast the
router was being read is why every window shorter than an hour looked like a
staircase. It is now a setting - **Module settings → Display & charts → Chart
sample interval**, 5 to 3600 seconds, default 60, which is exactly what the slow
sweep produced - and the fast tick is what offers the sample. The live tiles were
never affected either way; they read the module's own `series` stream.

### Policy routing: three faults, not one

"This router cannot do policy routing" was three different problems wearing one
sentence, and only one of them is fixed by installing a package. The probe now
asks where `ip` resolves and whether an unused iproute2 is sitting beside it:

| What the router has | What it says |
|---|---|
| BusyBox `ip`, no iproute2 | the BusyBox paragraph, and an offer to install `ip-full` |
| `ip-full` installed, working, and `/sbin/ip` still BusyBox | the alternatives link never switched: `ln -sf /usr/libexec/ip-full /sbin/ip`, and **no** offer to install it again |
| `ip-full` installed and the kernel still refuses a numeric table | policy routing is not in this firmware; no package adds it |

The second row is the one that mattered. `apk add ip-full` succeeded, the binary
was on disk and worked when called by its own path, and `ip` still meant the
BusyBox applet - so the capability the install job verifies was still missing,
the job finished `partial`, and the only remedy on offer was to run it again.
Which somebody did, three times.

"No offer to install it again" is every surface, not just the card. The list of
missing packages was built from `hasIpRule` alone, so on both of the rows no
package can fix, Module settings went on listing *ip-full* with its box ticked,
the router stayed at **Needs attention** for ever, and the new install prompt on
the WAN Binding tab offered the same job - directly contradicting the card one
page over. A group only counts as missing now when installing it could still
change the answer, which is also what lets the router finally read as ready.

### Readiness cards say what to do about a failure

Every check has carried an `install` field since the install flow existed and no
surface ever read it, so the three rows this module can actually fix - policy
routing, PPPoE support, DHCP leases - were the only ones whose detail named no
next step, while every row it *cannot* fix spelled one out. The card now carries
the same sentence the create-form refusals use, which also means it says *"needs
root"* or *"no apk database"* where that is what is really in the way, rather
than pointing at a form that would refuse.

### The install job stopped guessing

`... still not available after installing; the router may need a reboot` was the
whole of that failure, and a reboot is the one thing that cannot help the case
above. It now names the cause, and:

- asks the router **twice** before failing. `refreshCapabilities` joins a probe
  that is already in flight, and the readiness poller is guaranteed to be ticking
  on the page the job was started from - so a probe sent before `apk add`
  returned could answer the verify step with what was true beforehand;
- a finished `partial` job reads amber on its card as well as on its badge. It
  was tinted red by the failure count and labelled amber by its state, so a
  three-step install whose last step could not confirm looked like a router on
  fire.

### Inside

`main/config.ts` was eight lines under the 600-line limit, so it is a folder now
- `rules.ts`, `store.ts`, `editor.ts` behind an `index.ts`. Every call site
already imported `'../config'`, so nothing else changed. The history writer moved
out of the slow tick into `service/history.ts`, which is now the only file that
calls `addHistory` - and a test says so.

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
