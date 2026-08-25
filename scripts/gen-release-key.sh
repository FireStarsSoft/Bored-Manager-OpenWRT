#!/bin/sh
# Generate the ed25519 key pair a router verifies release manifests with.
#
# Run once, by whoever publishes this repository. The public half is committed;
# the secret half goes into a GitHub Actions secret and is then deleted from
# this machine. Nothing here ever writes a secret key inside the checkout, and
# it refuses rather than overwrite a public key that is already committed - a
# rollover adds a second key, it does not replace the first. The reasons are in
# packages/bm-agent/files/usr/share/bm/keys/README.md.
#
# usign is OpenWrt's own tool and produces exactly the format the router reads.
# signify-openbsd writes the same format and is what a Debian or Ubuntu machine
# has to hand; `-n` is what makes it write a secret key with no passphrase,
# which is what a CI runner needs.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYDIR="$ROOT/packages/bm-agent/files/usr/share/bm/keys"
NAME="${1:-bm-release}"
PUB="$KEYDIR/$NAME.pub"
SEC="$HOME/$NAME.sec"
COMMENT="Bored Manager OpenWRT packages ($NAME)"

if [ -e "$PUB" ]; then
	echo "$PUB already exists." >&2
	echo "Rolling a key over means adding a second one, not replacing this:" >&2
	echo "  $0 bm-release-2" >&2
	exit 1
fi

case "$SEC" in
	"$ROOT"/*)
		echo "refusing to write a secret key inside the repository ($SEC)" >&2
		exit 1
		;;
esac

if [ -e "$SEC" ]; then
	echo "$SEC already exists - move it out of the way first" >&2
	exit 1
fi

mkdir -p "$KEYDIR"
umask 077

if command -v usign >/dev/null 2>&1; then
	usign -G -c "$COMMENT" -p "$PUB" -s "$SEC"
elif command -v signify-openbsd >/dev/null 2>&1; then
	signify-openbsd -G -n -c "$COMMENT" -p "$PUB" -s "$SEC"
elif command -v signify >/dev/null 2>&1; then
	signify -G -n -c "$COMMENT" -p "$PUB" -s "$SEC"
else
	echo "need usign or signify-openbsd (apt install signify-openbsd)" >&2
	exit 1
fi

chmod 600 "$SEC"
chmod 644 "$PUB"

cat <<EOF

Public key  $PUB
            commit this - it is what routers verify against.

Secret key  $SEC
            do NOT commit this, and do not leave it here.

Next:
  1. Copy the whole of $SEC into a new repository secret named
     BM_RELEASE_SECKEY (Settings -> Secrets and variables -> Actions).
  2. Delete the local copy:  shred -u "$SEC"  (or rm)
  3. Commit $PUB and release. Until that release is on a router, that
     router has no key and will refuse a manifest fetched over the network -
     which is the correct answer, not a bug.
EOF
