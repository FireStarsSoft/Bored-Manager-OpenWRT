#!/bin/sh
# Build every .uc file in packages/ with the exact ucode OpenWrt 25.12 ships -
# the modules are loaded, the entry points compiled - and then run the probes in
# packages/ci/probes, which drive the daemon code for real and read the answers
# back.
#
# This is the only check in the repository that is a real compiler. `npm run
# packages:check` is a word search - it catches digit separators, `.length` and
# an import that names nothing - and it is useful precisely because it runs on
# the machine the code was typed on. It is not a parser, and it never will be.
#
# The commit is pinned to PKG_SOURCE_VERSION in openwrt/package/utils/ucode/
# Makefile on the openwrt-25.12 branch. Tracking master would answer a different
# question every week; the question worth answering is "does this parse on the
# router".
#
# `.github/workflows/packages.yml` runs this file rather than repeating it, so
# what CI checks and what a developer can check are the same thing.
#
# Usage:
#   sh scripts/check-ucode.sh            build ucode if needed, then check
#   UCODE_WORK=/somewhere sh ...         build somewhere other than /tmp
#
# On Debian or Ubuntu the prerequisites are:
#   sudo apt-get install -y git cmake build-essential pkg-config libjson-c-dev
#
# pkg-config is named separately because it is not part of build-essential and
# ucode's CMakeLists finds json-c through it: without it the build stops with
# "pkg-config tool not found" and says nothing about json-c at all.

set -eu

UCODE_COMMIT=85922056ef7abeace3cca3ab28bc1ac2d88e31b1
UCODE_URL=https://github.com/jow-/ucode.git
WORK=${UCODE_WORK:-/tmp/bm-ucode}
UCODE="$WORK/build/ucode"

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

missing=
for tool in git cmake cc pkg-config; do
	command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done

# Checked separately because pkg-config finds it and reports its absence as its
# own, which sends people looking for the wrong package.
if command -v pkg-config >/dev/null 2>&1 && ! pkg-config --exists json-c; then
	missing="$missing libjson-c-dev"
fi

if [ -n "$missing" ]; then
	echo "check-ucode: missing:$missing" >&2
	echo "  On Debian or Ubuntu:" >&2
	echo "    sudo apt-get install -y git cmake build-essential pkg-config libjson-c-dev" >&2
	exit 2
fi

# Built once and kept. The second run of this script is the compile alone.
if [ ! -x "$UCODE" ]; then
	echo "==> building ucode $UCODE_COMMIT"

	if [ ! -d "$WORK/.git" ]; then
		rm -rf "$WORK"
		git clone --filter=blob:none "$UCODE_URL" "$WORK"
	fi

	git -C "$WORK" fetch --quiet origin "$UCODE_COMMIT" 2>/dev/null || true
	git -C "$WORK" checkout --quiet "$UCODE_COMMIT"

	# From scratch. A configure that stopped part way - a missing pkg-config is
	# the usual one - leaves a cache that the next configure reuses and that no
	# amount of installing the missing package corrects: the symbol probes it
	# never reached stay unset, and the build fails much later with json-c
	# redefinition errors that say nothing about the real cause.
	rm -rf "$WORK/build"

	# Every extension off. The point is the language, and the modules this
	# package tree imports are stubbed below rather than linked - which is also
	# what lets this build on a machine with no libubus, libuci or libnl.
	cmake -S "$WORK" -B "$WORK/build" \
		-DCMAKE_BUILD_TYPE=Release \
		-DFS_SUPPORT=OFF -DMATH_SUPPORT=OFF -DUBUS_SUPPORT=OFF \
		-DUCI_SUPPORT=OFF -DRTNL_SUPPORT=OFF -DNL80211_SUPPORT=OFF \
		-DRESOLV_SUPPORT=OFF -DSTRUCT_SUPPORT=OFF -DSOCKET_SUPPORT=OFF \
		-DZLIB_SUPPORT=OFF -DDIGEST_SUPPORT=OFF -DLOG_SUPPORT=OFF \
		-DDEBUG_SUPPORT=OFF >/dev/null
	cmake --build "$WORK/build" --parallel >/dev/null
fi

"$UCODE" -e 'print("==> ucode ready\n")'

# The stubs first, so `fs` resolves to the empty one rather than to nothing;
# then every package's own module directory, which is what makes `bm.snapshot`
# resolve to bm-agent's snapshot.uc and `bm.wanbind.engine` to bm-wanbind's.
#
# Quoted, so the shell does not expand the `*` before ucode sees it: the `*` is
# where ucode substitutes the module name with its dots turned into slashes.
set -- -L "$root/packages/ci/stubs/*.uc"
for dir in "$root"/packages/*/files/usr/share/ucode; do
	[ -d "$dir" ] || continue
	set -- "$@" -L "$dir/*.uc"
done

failed=0
checked=0

# Entry points, compiled and not run: running one connects to ubus, publishes an
# object and enters uloop, which is not a thing a check may do. They are the one
# place where "it compiles" is all this script can say.
for file in $(find "$root/packages" -path '*/usr/share/bm/*.uc' | sort); do
	checked=$((checked + 1))
	if "$UCODE" -R -S "$@" -c -o /dev/null "$file"; then
		printf 'ok    %s\n' "${file#"$root/"}"
	else
		printf 'FAIL  %s\n' "${file#"$root/"}" >&2
		failed=$((failed + 1))
	fi
done

# Modules, loaded through a generated one-line importer.
#
# Loaded, not compiled. A module that compiles is not a module that runs: a
# regex literal becomes a regcomp call only when the constant is built, which is
# at load, so `/[\x00-\x1f\x7f]/` - POSIX has no \x escape - is a clean
# compile and a package that dies on the router with "Invalid regular
# expression" before one line of it has run. Importing each module for real is
# what catches that, and everything else that only fails at module scope.
#
# They cannot be handed to ucode directly either way: `export` is only legal in
# a file ucode is loading *as a module*, so treating one as a program reports
# "Exports may only appear at top level of a module" for every export in it -
# which is a confusing way to be told the check itself was wrong. The importer
# is also the only way to reach a module nothing else imports yet.
#
# The sentinel is checked rather than the exit status, because ucode exits 0 on
# an uncaught exception: a crashed run and a clean one are indistinguishable by
# `$?` alone, and a check that trusted it would pass on every one of these.
probe="$WORK/probe.uc"
SENTINEL=bm-module-loaded

for file in $(find "$root/packages" -path '*/usr/share/ucode/*.uc' | sort); do
	# .../usr/share/ucode/bm/wanbind/engine.uc -> bm.wanbind.engine
	name=$(printf '%s' "${file##*/usr/share/ucode/}" | sed -e 's/\.uc$//' -e 's,/,.,g')
	checked=$((checked + 1))
	printf 'import * as probe from "%s";\nif (type(probe) == "object") print("%s\\n");\n' \
		"$name" "$SENTINEL" > "$probe"

	out=$("$UCODE" -R -S "$@" "$probe" 2>&1 || true)

	if printf '%s' "$out" | grep -q "^$SENTINEL$"; then
		printf 'ok    %s\n' "${file#"$root/"}"
	else
		printf 'FAIL  %s (as module %s)\n' "${file#"$root/"}" "$name" >&2
		printf '%s\n' "$out" | sed 's/^/      /' >&2
		failed=$((failed + 1))
	fi
done

rm -f "$probe"


# Not ucode, so not covered above - and an init script that will not parse is a
# service that never starts, with the reason only in syslog.
for file in "$root"/packages/*/files/etc/init.d/* "$root"/packages/*/files/usr/sbin/* \
            "$root"/packages/*/files/usr/share/bm/*.sh "$root"/packages/*/files/etc/hotplug.d/*/*; do
	[ -f "$file" ] || continue
	head -n 1 "$file" | grep -q '^#!/bin/sh' || continue
	checked=$((checked + 1))
	if sh -n "$file"; then
		printf 'ok    %s\n' "${file#"$root/"}"
	else
		printf 'FAIL  %s\n' "${file#"$root/"}" >&2
		failed=$((failed + 1))
	fi
done

# Probes: the daemons run, and the answers are read back.
#
# Everything above says a file builds. These say it is right - which for this
# tree means the arithmetic, because a pool that starts one sequence number too
# low silently rewrites another pool's credentials and nothing about that is
# visible to a compiler.
#
# They run against packages/ci/probes/lib, which holds a uci that actually
# stores what it is given. That directory is deliberately not packages/ci/stubs:
# the stubs are on the search path for every module load above, and a module
# that started writing configuration during a syntax check would be a worse
# problem than the one the stubs solve.
#
# The sentinel again, for the same reason: ucode exits 0 on an uncaught
# exception, so a probe that died half way through would otherwise be green.
probes=$(find "$root/packages/ci/probes" -maxdepth 1 -name '*.uc' | sort)

if [ -n "$probes" ]; then
	echo
	set -- -L "$root/packages/ci/probes/lib/*.uc" "$@"

	for file in $probes; do
		checked=$((checked + 1))
		out=$("$UCODE" -R -S "$@" "$file" 2>&1 || true)

		if printf '%s' "$out" | grep -q '^bm-probe-ok$'; then
			printf 'ok    %s\n' "${file#"$root/"}"

			# A probe may publish a table the TypeScript side has to agree with.
			#
			# The arithmetic behind `bmctl tune --recommend` is carried by the
			# module too, for the page that offers it, and two copies of one
			# formula are two answers waiting to disagree in front of somebody
			# deciding whether to raise a limit. So the ucode side writes the
			# numbers here and the module's own test reads the same file.
			printf '%s\n' "$out" | grep '^bm-fixture ' | while read -r _tag _name _json; do
				mkdir -p "$root/packages/ci/fixtures"
				printf '%s\n' "$_json" > "$root/packages/ci/fixtures/$_name.json"
			done
		else
			printf 'FAIL  %s\n' "${file#"$root/"}" >&2
			printf '%s\n' "$out" | sed 's/^/      /' >&2
			failed=$((failed + 1))
		fi
	done
fi

if [ "$failed" -ne 0 ]; then
	echo >&2
	echo "$failed of $checked file(s) would not build, or did not behave." >&2
	exit 1
fi

echo
echo "ok    $checked file(s) build and probe against ucode $UCODE_COMMIT"
