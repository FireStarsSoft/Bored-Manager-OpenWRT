# Bored Manager — OpenWRT module

The OpenWRT module for [Bored Manager](https://github.com/FireStarsSoft/Bored-Manager),
developed and released on its own. Manage an OpenWRT router over the app's
existing SSH connection without touching LuCI: a live dashboard, bulk PPPoE
dialing, and one-to-one LAN-device → WAN binding.

Everything the module itself does is documented in
[`openwrt/README.md`](openwrt/README.md); what changed in each version is in
[`openwrt/CHANGELOG.md`](openwrt/CHANGELOG.md). This file is about the
repository.

## Installing it

You do not need this repository to use the module. In Bored Manager, open
**Settings → Modules** and install it by any of:

| Source | What to enter |
|---|---|
| Catalog | pick **OpenWRT** from the reviewed list |
| GitHub repo | `FireStarsSoft/Bored-Manager-OpenWRT` |
| Zip URL / file | the `openwrt-<version>.zip` attached to a [release](../../releases) |

It installs **switched off** — enable it in the same place. Version 2.0.0 needs
Bored Manager **0.4.1** or newer, which is also the first app release that does
not bundle the module, **and OpenWrt 25.12 or newer** on the router — 25.12.0
replaced opkg with apk, and 2.0.0 speaks only apk, so it refuses a 24.10 router
outright rather than half-managing it. The 1.0.x line still runs on **0.3.3**.
An app already carrying 1.0.7 keeps it across the update, and updating to 1.0.8
or 2.0.0 from here keeps its rules, per-router state and history.

## Layout

```
openwrt/            the module, and nothing else — this folder is what ships
  module.json         manifest: pages, widgets, streams, methods
  main/               the main half, compiled by the app at install time
    index.ts            the six lifecycle hooks, and nothing else
    runtime/            wiring: the object graph, the readiness latch, the method names
    probe/ setup/       what the router can do, and installing what it lacks
    service/            fast and slow collection, the dashboard payload
    pppoe/ binding/     the two automations
    uci/ store/         everything written to the router, and the per-router document
    *.ts                what more than one of those folders shares
  ui/pages/*.json     page specs the app renders
  ui/widgets/*.json   Overview widget specs
  README.md           what the module does
  CHANGELOG.md        module versions, independent of the app's
shared/             vendored copy of the app's shared/ — what `@shared/*` means
vendor/             vendored copy of the app's module compiler, plus two shims
tests/              unit tests for main/, on the app's own module harness
scripts/            packaging and the checks CI runs
.github/workflows/  the same checks on push, the tagged release, the SDK drift watch
sdk.lock.json       which app ref the two vendored folders came from
```

Each folder under `main/` has an `index.ts` that is its only entrance: a file
imports `../binding`, never `../binding/reconcile`. That is what let the main
half be split into folders without touching a single call site — including
every import in `tests/` — and `npm run size` is what keeps it that way. The
three rules behind that split, and which file to open for what, are the **Code
map** in [`openwrt/README.md`](openwrt/README.md).

`openwrt/` is hashed byte for byte by the app that installs it, so the checkout
has to match the release zip exactly: `.gitattributes` pins the whole repository
to LF, and nothing that is not part of the module goes into that folder.

## Working on it

```bash
npm install
npm run check      # sdk:check + typecheck + test + specs + size + compile
```

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc` over the module, the vendored SDK and the tests |
| `npm test` | Vitest over `tests/`, using the app's `moduleHarness` |
| `npm run specs` | every `ui/*.json` through the app's own spec validator |
| `npm run size` | the structural rules for `openwrt/main/`: no file over 600 lines, no import that reaches past a folder's barrel, no CRLF |
| `npm run compile` | esbuild through the app's real scope guard — catches an import a module is not allowed to make |
| `npm run pack` | writes `dist/openwrt-<version>.zip` and its `.sha256` |
| `npm run sdk:check` | have the vendored copies been edited? (offline) |
| `npm run sdk:sync` | re-fetch them at the pinned ref |
| `npm run sdk:drift` | what has the app changed since the pin? (online) |

To try a build against a real app, unzip `dist/openwrt-<version>.zip` into the
app's `modules/` folder and press **Reload** in Settings → Modules, or install
the zip from **From file**.

### Why `shared/` and `vendor/` are copies

A module's main half may import its own files and `@shared/*`, and nothing else
— the app's `server/services/module-compiler.ts` enforces that when it compiles
the module, and `@shared` resolves to the **app's** `shared/` folder, not to
anything shipped with the module. To typecheck and unit-test that code outside
the app, this repository keeps a copy of the app files it compiles against,
pinned to one app ref in [`sdk.lock.json`](sdk.lock.json) and hashed there.

- `npm run sdk:check` (in CI, offline) fails if a vendored file was edited here.
  They are copies; fix the app instead.
- `npm run sdk:drift` (online) reports which of them the app's `main` has moved
  since the pin. Re-pin with `node scripts/sync-sdk.mjs --ref <tag>` and run
  `npm run check`.

`vendor/store.ts` and `vendor/modules-host.ts` are the only two files written
here rather than copied: they answer the two questions the compiler asks its
host (where the app root is, where a module folder is), so
`vendor/module-compiler.ts` can stay a byte-for-byte copy.

## Releasing

1. Bump `version` in `openwrt/module.json` and add a section to
   `openwrt/CHANGELOG.md`.
2. `npm run check`, then `npm run pack` and note the sha256 it prints. The
   archive is byte-reproducible — a fixed timestamp rather than the clock — so
   that hash is a property of the source, not of the run.
3. Tag `v<version>` and push it. The release workflow re-runs every check,
   rebuilds the zip, refuses to publish if the tag and the manifest disagree,
   and attaches `openwrt-<version>.zip` and its `.sha256`.
4. Update the catalog entry in the app repo's
   [`registry/modules.json`](https://github.com/FireStarsSoft/Bored-Manager/blob/main/registry/modules.json)
   with the new `version`, `download` URL, `sha256` and `verifiedAt`. Until that
   lands, installing still works — the user just gets the `unverified-source`
   warning and has to confirm.

Exactly one `.zip` may be attached to a release: the app picks the module
archive by "the only zip asset that is not the app's own", and a second one
makes the install fail rather than guess.

## Contributing

The rules a module has to follow — lifecycle, what `ctx` may be used for after
a stop, what a spec may name — are the app's:
[docs/MODULE-RULESET.md](https://github.com/FireStarsSoft/Bored-Manager/blob/main/docs/MODULE-RULESET.md)
and [docs/MODULES.md](https://github.com/FireStarsSoft/Bored-Manager/blob/main/docs/MODULES.md).
`npm run check` is what CI runs; a pull request that passes it locally passes
there.

## Licence

Apache-2.0, the same as the app. See [LICENSE](LICENSE).
