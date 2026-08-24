# Changelog

Module versions are independent of the app's. OpenWRT 1.0.0 needs Bored Manager
**0.3.3** for the `subnav` and `note` blocks and the `file` form input.

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
