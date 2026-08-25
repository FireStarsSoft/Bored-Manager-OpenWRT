# Release keys

This directory ships the **public** halves of the keys a router will accept a
release manifest from. Every `.pub` here is installed to
`/usr/share/bm/keys/` and tried in turn by `bm.signature`.

It is empty in a fresh checkout, deliberately: the key belongs to whoever
publishes this repository, not to the source. Until one is generated, a router
asked to check for an update refuses with *"no release key is installed"* — and
the other three install paths still work, because they have their own trust
roots:

| Path | Trusted because |
|---|---|
| The module's pinned install | the sha256 is compiled into the module release |
| A `.apkbundle` from your machine | you chose the file |
| A path already on the router | it is already on the router |
| A GitHub release, fetched by the router | **this key**, and nothing else |

## Making one

```bash
./scripts/gen-release-key.sh
```

It writes `bm-release.pub` here and the secret half to a path **outside** the
repository, then tells you what to do with it: paste it into the repository's
`BM_RELEASE_SECKEY` GitHub Actions secret and delete the local copy. The script
refuses to write a secret key anywhere inside this checkout.

Commit the `.pub`. It is a public key; that is the point of it.

## Rolling it over

Add the new `.pub` beside the old one and release. Every router that takes that
update then accepts either key, which is what lets the switch happen without a
flag day. Once nothing is still running the old release, remove the old `.pub`
in a release of its own.

Never delete a key in the same release that adds its replacement: a router
running an older agent has only the old key, and a manifest signed with the new
one is a manifest it will refuse.
