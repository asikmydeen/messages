#!/data/data/com.termux/files/usr/bin/sh
# Re-arm Friday harvest so it survives Termux swipe, reboot, and Samsung sleep.
# Absolute paths: safe from Ubuntu proot. Fast. Do not start daemon.sh.
#
# What this does:
#   1. Poke Termux:API KeepAliveService (shade list hangs if it died)
#   2. Reinstall persisted Job 20 (15 min capture.sh)
#   3. Cancel Jobs 21/22 if something re-armed those hangers
#   4. Ongoing notification so Android treats harvest as a live task
#
# Call from: Termux:Boot, Termux ~/.bashrc (before proot), widget, capture.sh.
B=/data/data/com.termux/files/usr/bin
H=/data/data/com.termux/files/home
DIR="$H/.messages"
S="$DIR/capture.sh"
NOTIFY_ONLY=0
[ "$1" = "--notify-only" ] && NOTIFY_ONLY=1

if [ -x "$B/am" ]; then
  "$B/am" startservice --user 0 -n com.termux.api/.KeepAliveService >/dev/null 2>&1 || true
fi

if [ "$NOTIFY_ONLY" -eq 0 ]; then
  [ -x "$S" ] || { echo "missing $S" >&2; exit 1; }
  "$B/termux-job-scheduler" --cancel --job-id 21 >/dev/null 2>&1 || true
  "$B/termux-job-scheduler" --cancel --job-id 22 >/dev/null 2>&1 || true
  "$B/termux-job-scheduler" --job-id 20 --script "$S" --period-ms 900000 \
    --persisted true --battery-not-low false --network any >/dev/null 2>&1 || true
fi

LAST="never"
if [ -f "$DIR/last.ok" ]; then
  LAST=$(cat "$DIR/last.ok")
fi
if [ -x "$B/termux-notification" ]; then
  "$B/termux-notification" \
    --id 20 \
    --title "Friday harvest" \
    --content "Job 20 armed. Last ok: $LAST" \
    --ongoing \
    --priority high \
    --button1 "Capture now" \
    --button1-action "sh $S" \
    >/dev/null 2>&1 || true
fi

date -Iseconds > "$DIR/last.arm" 2>/dev/null || true
[ "$NOTIFY_ONLY" -eq 1 ] && exit 0
[ -t 1 ] && "$B/termux-job-scheduler" -p
exit 0
