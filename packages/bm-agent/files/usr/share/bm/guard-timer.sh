#!/bin/sh
# The countdown behind `bmctl config guard`.
#
# Deliberately the dumbest process on the router: a loop, a command, a sleep. It
# is started by /etc/init.d/bm-guard and runs as its own procd instance, which
# is the point - a daemon that hangs, an `ip rule` that cuts SSH, an apply that
# never returns, none of them can stop this from coming round again.
#
# All of the thinking is in `bmctl config expire`, so this parses nothing. The
# three exit codes it acts on are the whole protocol:
#
#   2  still inside the deadline; sleep and ask again
#   0  nothing left to guard - confirmed, cancelled, or just restored
#   1  something is wrong that another few seconds will not fix
#
# Two seconds is short enough that a two-minute guard fires within about one
# percent of its deadline, and cheap enough to be invisible: one `ucode` that
# reads one small file and exits.

INTERVAL=2

while :; do
	/usr/sbin/bmctl config expire
	status=$?

	if [ "$status" -ne 2 ]; then
		# Anything but "still waiting" ends this instance. bmctl has already
		# stopped the service on the paths that resolve the guard; exiting here
		# is what covers the ones that do not, and procd's retry limit is what
		# stops that becoming a loop.
		exit "$status"
	fi

	sleep "$INTERVAL"
done
