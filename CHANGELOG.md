# Changelog

Module versions are independent of the app's. OpenWRT 1.0.0 needs Bored Manager
**0.3.3** for the `subnav` and `note` blocks and the `file` form input.

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
