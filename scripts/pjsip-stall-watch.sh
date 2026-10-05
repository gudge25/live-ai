#!/usr/bin/env bash
# Watches Asterisk's PJSIP distributor taskprocessors for a backed-up queue
# (the symptom seen when SIP registration/calls silently stop being processed
# even though the process is alive and the network path is fine). On a hit,
# captures a full thread backtrace plus current taskprocessor/channel state
# to a timestamped file, so the stuck frame is known *before* anyone restarts
# Asterisk and destroys the evidence. Does NOT restart or touch Asterisk.
#
# Install as a cron job (e.g. every minute) on the PBX host, as root:
#   * * * * * /opt/live-ai/scripts/pjsip-stall-watch.sh
#
# Requires: asterisk CLI, gdb, root (for gdb -p and asterisk -rx).

set -euo pipefail

THRESHOLD="${PJSIP_STALL_QUEUE_THRESHOLD:-15}"
OUT_DIR="${PJSIP_STALL_OUT_DIR:-/var/log/live-ai-asterisk-stall}"
COOLDOWN_SECS="${PJSIP_STALL_COOLDOWN_SECS:-900}"
STATE_FILE="$OUT_DIR/.last-capture"

mkdir -p "$OUT_DIR"

taskprocessors="$(asterisk -rx 'core show taskprocessors' 2>/dev/null || true)"
if [ -z "$taskprocessors" ]; then
  exit 0
fi

# Column 3 is "In Queue". Only look at the SIP distributor serializers —
# those are the threads that pick up new incoming SIP requests (REGISTER,
# INVITE, ...); a backed-up queue here means new SIP traffic isn't being
# processed even though Asterisk is still running.
worst_line="$(awk -v t="$THRESHOLD" '
  /^pjsip\/distributor-/ { if ($3 + 0 > t) print }
' <<<"$taskprocessors" | sort -k3 -n -r | head -1)"

if [ -z "$worst_line" ]; then
  exit 0
fi

now="$(date +%s)"
if [ -f "$STATE_FILE" ]; then
  last="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
  if [ "$((now - last))" -lt "$COOLDOWN_SECS" ]; then
    exit 0
  fi
fi
echo "$now" > "$STATE_FILE"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$OUT_DIR/stall-$ts"
mkdir -p "$out"

echo "$worst_line" > "$out/trigger-line.txt"
echo "$taskprocessors" > "$out/taskprocessors.txt"
asterisk -rx 'core show channels' > "$out/channels.txt" 2>/dev/null || true
asterisk -rx 'pjsip show contacts' > "$out/pjsip-contacts.txt" 2>/dev/null || true

pid="$(pgrep -x asterisk | head -1 || true)"
if [ -n "$pid" ]; then
  # -batch keeps gdb from attaching interactively; detach leaves Asterisk running.
  gdb -p "$pid" -ex "set pagination off" -ex "thread apply all bt" -ex detach -batch \
    > "$out/gdb-backtrace.txt" 2>&1 || echo "gdb failed, see stderr above" >> "$out/gdb-backtrace.txt"
else
  echo "asterisk pid not found" > "$out/gdb-backtrace.txt"
fi

logger -t pjsip-stall-watch "PJSIP distributor queue backed up (threshold=$THRESHOLD): $worst_line -- captured to $out"
