# OpenWRT

Monitor and automate one OpenWRT router through Bored Manager's existing SSH
connection. The module does not use LuCI and does not open a second connection:
add the router as a machine, connect to it as `root`, then enable OpenWRT in
Settings → Modules.

## What it adds

| Where | What |
|---|---|
| Sidebar → OpenWRT → Dashboard | Router health, aggregate throughput, WAN state, interfaces, and DHCP clients in real time. |
| Sidebar → OpenWRT → Automation → PPPoE Dialer | Create, start, stop, redial, inspect, and remove one to thousands of PPPoE sessions from a text file or pasted list. |
| Sidebar → OpenWRT → Automation → WAN Binding | Assign every DHCP client on one selected LAN to one free WAN on one selected carrier, one-to-one. |
| Sidebar → OpenWRT → Automation → Jobs | Progress and partial failures for chunked operations. |
| Sidebar → OpenWRT → Module settings | Compatibility checks, operational hints, scaling and safety rules. |
| Overview cards | An optional WAN-pool and binding summary. |
| History | `openwrt`: aggregate WAN, device, receive, and transmit values. |

The module ships disabled. It is intentionally scoped to the currently selected
router: another connected router receives a separate module instance and
separate per-host state.

## Requirements

- OpenWRT with `ubus`, `uci`, `ip`, `logread`, netifd, and firewall4;
- `ppp`, `ppp-mod-pppoe`, and the matching kernel support for PPPoE automation;
- a direct Bored Manager SSH connection to the router as `root`;
- enough memory for the requested sessions. Budget roughly 1.5–2 MiB per
  `pppd`; 1,000 sessions normally means an x86 router with at least 2 GiB RAM;
- an access concentrator and ISP account policy that permit the requested
  number of simultaneous PPPoE sessions.

The capability panel reports missing tools or packages instead of presenting
empty data. The app owns and encrypts the SSH credential; the module never
stores a copy.

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

Creation and control happen in bounded chunks (100 by default) with a delay
between chunks. A 5,000-account import therefore creates about 50 job items,
not 5,000 UI items or 5,000 simultaneous commands. Netifd performs normal PPP
retry; the optional slow watchdog can redial a session that remains failed for
an unusually long time.

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

When remapping is enabled, a WAN that stays failed beyond the configured grace
period releases its client to another free WAN. Lease IP changes preserve the
MAC's WAN. Expired leases release their WAN after a separate grace period.
After an app restart, the engine derives current mappings from DHCP leases,
managed `ip rule` entries, and routing-table ownership. After a router reboot,
it reapplies missing rules.

Stopping an instance deliberately keeps its catch-all rule while removing
client rules, so scoped clients lose internet rather than falling through to
an unrelated WAN. Deleting the instance removes both client and catch-all
rules.

## Real-time data and scale

The browser/server transport is already one WebSocket. Small summaries and
chart points are pushed with module events. Tables that may contain thousands
of rows are requested over that same socket only while visible and are answered
from the server's RAM cache; opening a table never starts another SSH probe.

The router side runs one combined command per fast tick:

- system information, aggregate device counters, DHCP leases, and managed IP
  rules every tick;
- `network.interface dump` every tick up to 500 interfaces, every second tick
  up to 2,000, and every third tick above that;
- an immediate dump after configuration or interface actions.

PPPoE device counters are aggregated on the router before crossing SSH.
Version 1.0 therefore provides aggregate pool throughput, not a separate
throughput graph for every PPPoE session. At more than 2,000 sessions use the
Low (5 second) fast interval.

For more than roughly 1,000 LAN clients, review the findings shown before a
binding instance is applied. They cover:

- dnsmasq DHCP lease limits;
- `nf_conntrack_max`;
- neighbor-table garbage-collection thresholds;
- software flow offload, which reduces repeated policy-rule lookups for
  established flows.

## Hints

Every form field explains its accepted value, default, unit, and operational
effect. Page-level notes explain each workflow and warnings. Use **Hide hints**
or **Show hints** at the top of Module settings; the preference applies to all
three pages immediately and survives an app restart.

## Persistence and recovery

| Data | Location | Notes |
|---|---|---|
| Module rules and hint preference | `data/user-settings/module-config/openwrt.json` | Shared preference document; no credentials. |
| Batch metadata, binding instances, sticky MAC hints, events, finished jobs | `data/module-data/openwrt/<hostKey>.json` | Per router; kept below the 512 KiB module-data limit. |
| PPPoE interface definitions and passwords | `/etc/config/network` on OpenWRT | Router is the source of truth. |
| Live assignments | `ip rule` plus DHCP leases on OpenWRT | Derived each tick; not duplicated in host data. |

Host-data writes are debounced and trimmed. Running jobs are in memory and are
cancelled when the module stops; already-running router commands finish.
Finished job history is bounded. Reconciliation, not job resumption, is what
restores a correct state after interruption.

The waiting queue itself is intentionally RAM-only. After an app restart,
active leases that still lack a WAN are queued again in current lease-file
order; existing kernel assignments and sticky MAC choices are preserved, but
the previous FIFO order among waiting clients is not.

## Manual verification

These checks need a real OpenWRT router. They are not covered by the unit suite.

1. **Connection.** Add the router as a Bored Manager machine, connect as `root` through dropbear, and confirm a Terminals session works.
2. **Firewall wildcard.** After creating a PPPoE batch, `nft list ruleset` contains `pppoe-<prefix>` (wildcard `+` on fw4, or explicit `network` members when `zoneMode` is `networks`) and the zone masquerades.
3. **Soak.** Create 100, then 500, then 1,000 sessions from a text list. Record apply time, router CPU/RAM, and whether the dashboard stays smooth. Use the Low (5 s) fast interval above roughly 2,000 sessions.
4. **Binding scenarios.** A new DHCP client gets an `ip rule` within two fast ticks and exits through its assigned WAN; a WAN that stays failed remaps after the grace period; an extra client waits with DNS but no internet; a lease IP change keeps the same WAN; a missing lease releases the WAN after its grace; a router reboot reapplies rules; an app restart rebuilds assignments from the router. LAN and WAN interfaces outside the instance stay untouched.
5. **Disable / uninstall.** With the module connected, switch it off and uninstall it. Pollers stop, `data/app.log` shows no leftover `openwrt:` execs, and UCI leftovers remain only if batches or binding instances were not deleted first.

## Safety and limitations

- Version 1.0 binds IPv4 only. Disable or separately design IPv6 on a scoped LAN
  if clients must not bypass the selected IPv4 WAN.
- Many Linux policy rules are evaluated linearly. Flow offload is recommended
  at high client counts; benchmark the intended packet rate on the target
  hardware.
- The wildcard firewall zone is verified after creation. If a particular fw4
  build does not materialize it, switch the module rule to explicit network
  membership.
- A module cannot watch multiple routers in one page. Add each router as a
  Bored Manager machine and switch machines in the host sidebar.
- Jump-host mode and router-side event daemons are not part of 1.0.
- Do not pause the fast OpenWRT interval while a WAN Binding instance is
  expected to assign new clients. The settings page warns about this.

## Files

| File | Purpose |
|---|---|
| `main/index.ts` | Activation, RPC handlers, streams, and lifecycle. |
| `main/service.ts` | Adaptive fast/slow collection and small push payloads. |
| `main/probe.ts` | OpenWRT and package capability checks. |
| `main/parse.ts` | OpenWRT output and account-list parsers. |
| `main/config.ts` | Effective module rules and hint preference. |
| `main/store.ts` | Bounded, debounced per-router state. |
| `main/jobs.ts` | Cancellable chunk-job progress and history. |
| `main/uci.ts` | Safe UCI batches, VLAN devices, and firewall setup. |
| `main/pppoe.ts` | PPPoE check/apply, status, and batch controls. |
| `main/binding.ts` | WAN-pool discovery and one-to-one rule reconciliation. |
| `main/options.ts` | Dynamic form choices from the in-memory model. |
| `main/queries.ts` | Large table rows built from the in-memory model. |
