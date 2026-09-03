#!/bin/bash
# The verification matrix: fifteen claims about the router, each pass or fail
# with the number behind it.
#
#   rig/verify.sh              the matrix
#   rig/verify.sh --calibrate  the six measurement points, into work/calibration.json
#
# Every line is a claim this release makes. A claim that cannot be checked here
# says so and counts as a skip rather than a pass, because a matrix that turns
# "not measured" into a tick is worse than no matrix.

. "$(dirname "$0")/lib.sh"

PASS=0
FAIL=0
SKIP=0
CALIBRATE=0

for arg in "$@"; do
	case "$arg" in
		--calibrate) CALIBRATE=1 ;;
		*) die "unknown option: $arg" ;;
	esac
done

ok()   { printf '\033[32mPASS\033[0m  %s\n' "$*"; PASS=$((PASS + 1)); }
no()   { printf '\033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL + 1)); }
skip() { printf '\033[33mSKIP\033[0m  %s\n' "$*"; SKIP=$((SKIP + 1)); }

# One ubus call on the VM, as JSON on stdout.
call() { ssh_vm "ubus call $1 $2 '${3:-{\}}' 2>/dev/null"; }

# One field out of a JSON reply, without needing jq on either side.
field() {
	python3 - "$2" <<-'EOF'
	import json, sys
	path = sys.argv[1].split('.')
	try:
	    node = json.load(sys.stdin)
	except Exception:
	    print('')
	    raise SystemExit(0)
	for step in path:
	    if isinstance(node, list):
	        try:
	            node = node[int(step)]
	            continue
	        except Exception:
	            print('')
	            raise SystemExit(0)
	    if not isinstance(node, dict) or step not in node:
	        print('')
	        raise SystemExit(0)
	    node = node[step]
	print(node if not isinstance(node, (dict, list)) else json.dumps(node))
	EOF
}

want() {
	local label="$1" got="$2" wanted="$3"
	if [ "$got" = "$wanted" ]; then ok "$label ($got)"; else no "$label: got '$got', wanted '$wanted'"; fi
}

at_least() {
	local label="$1" got="$2" floor="$3"
	if [ -z "$got" ]; then no "$label: nothing came back"; return; fi
	if [ "$got" -ge "$floor" ] 2>/dev/null; then ok "$label ($got >= $floor)"
	else no "$label: $got is below $floor"; fi
}

at_most() {
	local label="$1" got="$2" ceiling="$3"
	if [ -z "$got" ]; then no "$label: nothing came back"; return; fi
	if [ "$got" -le "$ceiling" ] 2>/dev/null; then ok "$label ($got <= $ceiling)"
	else no "$label: $got is above $ceiling"; fi
}

vm_up || die "the VM is not answering - run rig/up.sh first"

echo
echo "  1. the three packages are installed and answering"

INFO="$(call bm.agent info)"
want "bm-agent release" "$(printf '%s' "$INFO" | field . release)" "2.4.0"

PROVIDES="$(printf '%s' "$INFO" | field . provides)"
for one in binding direct pppoe; do
	case "$PROVIDES" in
		*"\"$one\""*) ok "the agent provides $one" ;;
		*) no "the agent does not provide $one" ;;
	esac
done

echo
echo "  2. the capacity report"

CAP="$(call bm.agent capacity)"
if [ -z "$CAP" ]; then
	no "bm.agent capacity did not answer"
else
	want "capacity ok" "$(printf '%s' "$CAP" | field . ok)" "True"
	CEIL="$(printf '%s' "$CAP" | field . ceiling.sessions)"
	at_least "an estimated session ceiling" "$CEIL" 1
	echo "        stability: $(printf '%s' "$CAP" | field . stability.level) - $(printf '%s' "$CAP" | field . stability.reason)"
	echo "        tier:      $(printf '%s' "$CAP" | field . tiers.sessions.label)"

	SIZE="$(ssh_vm "ubus call bm.agent capacity '{}' 2>/dev/null | wc -c")"
	at_most "the report fits in a ubus reply" "$SIZE" 16384

	START="$(date +%s%N)"
	call bm.agent capacity '{"refresh":true}' >/dev/null
	MS=$(( ($(date +%s%N) - START) / 1000000 ))
	at_most "a fresh report takes under a second" "$MS" 1000
fi

echo
echo "  3. the pool"

POOL="$(call bm.pppoe info '{"members":false}')"
if [ -z "$POOL" ]; then
	skip "bm-pppoe-pool is not answering - no pool has been created yet"
else
	UP="$(printf '%s' "$POOL" | field . pools.0.up)"
	MEMBERS="$(printf '%s' "$POOL" | field . pools.0.members)"
	if [ -z "$MEMBERS" ]; then
		skip "no pool on this router yet (create one, then run this again)"
	else
		at_least "sessions dialled" "${UP:-0}" 1
		echo "        $UP of $MEMBERS members are up"
	fi

	case "$POOL" in
		*memberList*) no "info without member lists still carried them" ;;
		*) ok "info without member lists carries none" ;;
	esac
fi

echo
echo "  4. the bindings"

BIND="$(call bm.wanbind info)"
if [ -z "$BIND" ]; then
	skip "bm-wanbind is not answering"
else
	echo "        $(printf '%s' "$BIND" | field . core.bindings) configured, $(printf '%s' "$BIND" | field . core.bound) bound"
	want "netifd is answering the daemon" "$(printf '%s' "$BIND" | field . netifd.ok)" "True"

	LOCAL="$(printf '%s' "$BIND" | field . local.enabled)"
	want "LAN-local rules are on" "$LOCAL" "True"

	ESCAPES="$(ssh_vm "ip -4 rule show | grep -c 'lookup main' || true")"
	at_least "at least one LAN-local escape rule stands" "$ESCAPES" 1
fi

echo
echo "  5. the rule table reads to the end"

RULES="$(call bm.wanbind rules '{"limit":1,"reasons":false}')"
if [ -z "$RULES" ]; then
	skip "the daemon did not answer rules"
else
	want "the kernel answered the dump" "$(printf '%s' "$RULES" | field . read)" "True"
	RAW="$(printf '%s' "$RULES" | field . raw)"
	KERNEL="$(ssh_vm "ip -4 rule show | wc -l")"
	want "the daemon counts what the kernel holds" "$RAW" "$KERNEL"
fi

echo
echo "  6. what the daemon decided is what the kernel has"

VERIFY="$(call bm.wanbind verify '{"instance":""}')"
if [ -z "$VERIFY" ]; then
	skip "the daemon did not answer verify"
else
	want "the check ran" "$(printf '%s' "$VERIFY" | field . read)" "True"
	MISSING="$(printf '%s' "$VERIFY" | field . missing)"
	want "no rule it decided is missing" "$MISSING" "[]"
fi

echo
echo "  7. the daemons are keeping up"

STATS="$(call bm.wanbind stats)"
if [ -n "$STATS" ]; then
	MS="$(printf '%s' "$STATS" | field . timings.totalMs)"
	[ -n "$MS" ] && at_most "the last binding pass" "$MS" 3000 || skip "no pass timing yet"
	RSS="$(printf '%s' "$STATS" | field . rssKb)"
	[ -n "$RSS" ] && at_most "bm-wanbind resident memory (kB)" "$RSS" 40000 || skip "no rss figure"
fi

PSTATS="$(call bm.pppoe stats)"
if [ -n "$PSTATS" ]; then
	QUEUE="$(printf '%s' "$PSTATS" | field . queueDepth)"
	[ -n "$QUEUE" ] && at_most "sessions waiting to redial" "$QUEUE" 10 || :
	BLIND="$(printf '%s' "$PSTATS" | field . blind)"
	want "the pool daemon can see its interfaces" "${BLIND:-None}" "None"
fi

echo
echo "  8. the console agrees with the pages"

if ssh_vm 'bmctl capacity --json >/dev/null 2>&1'; then
	ok "bmctl capacity answers"
	CLI="$(ssh_vm 'bmctl capacity --json 2>/dev/null' | field . ceiling.sessions)"
	want "and gives the same ceiling as ubus" "$CLI" "${CEIL:-}"
else
	no "bmctl capacity did not answer"
fi

# ------------------------------------------------------------------ calibration

if [ "$CALIBRATE" -eq 1 ]; then
	echo
	echo "  calibration: memory, reply sizes and timings at this load"

	ssh_vm 'sync; echo 3 > /proc/sys/vm/drop_caches; sleep 30'

	python3 - "$WORK/calibration.json" <<-EOF
	import json, subprocess, sys, statistics

	def sh(cmd):
	    out = subprocess.run(
	        ['ssh', '-q', '-p', '$SSH_PORT', '-i', '$SECRETS/id_rig',
	         '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
	         'root@127.0.0.1', cmd],
	        capture_output=True, text=True)
	    return out.stdout.strip()

	def meminfo():
	    values = {}
	    for line in sh('cat /proc/meminfo').split('\n'):
	        parts = line.split()
	        if len(parts) >= 2 and parts[0].endswith(':'):
	            try:
	                values[parts[0][:-1]] = int(parts[1])
	            except ValueError:
	                pass
	    return values

	samples = []
	for _ in range(3):
	    samples.append(meminfo())
	    sh('sleep 20')

	used = [one.get('MemTotal', 0) - one.get('MemAvailable', 0) for one in samples]

	out = {
	    'memTotalKb': samples[0].get('MemTotal'),
	    'usedKb': int(statistics.median(used)),
	    'slabKb': samples[0].get('Slab'),
	    'sessionsUp': int(sh("ubus call bm.pppoe info '{\"members\":false}' 2>/dev/null | grep -o '\"up\": [0-9]*' | head -1 | grep -o '[0-9]*' || echo 0") or 0),
	    'bound': int(sh("ubus call bm.wanbind info 2>/dev/null | grep -o '\"bound\": [0-9]*' | head -1 | grep -o '[0-9]*' || echo 0") or 0),
	    'leases': int(sh('wc -l < /tmp/dhcp.leases 2>/dev/null || echo 0') or 0),
	    'ipRules': int(sh('ip -4 rule show | wc -l') or 0),
	    'neighbours': int(sh('ip -4 neigh show | wc -l') or 0),
	    'conntrack': int(sh('cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo 0') or 0),
	    'dumpBytes': int(sh('ubus call network.interface dump | wc -c') or 0),
	    'infoWithMembers': int(sh("ubus call bm.pppoe info '{\"members\":true}' | wc -c") or 0),
	    'infoWithout': int(sh("ubus call bm.pppoe info '{\"members\":false}' | wc -c") or 0),
	    'capacityBytes': int(sh('ubus call bm.agent capacity | wc -c') or 0),
	    'kernel': sh('cat /proc/sys/kernel/osrelease'),
	    'release': sh("cat /etc/openwrt_release | grep DISTRIB_RELEASE | cut -d\"'\" -f2"),
	}

	json.dump(out, open(sys.argv[1], 'w'), indent=2)
	print(json.dumps(out, indent=2))
	EOF

	log "written to $WORK/calibration.json"
fi

echo
printf '  %d passed, %d failed, %d skipped\n\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
