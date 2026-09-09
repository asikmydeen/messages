#!/data/data/com.termux/files/usr/bin/sh
# Install Job 20 only (15-min capture.sh).
#
# Do NOT install Jobs 21/22. Content-URI triggers (content://sms,
# content://call_log/calls) hang termux-job-scheduler / Termux:API
# for hours and block this script. A future boot must not re-arm them.
B=/data/data/com.termux/files/usr/bin
S=/data/data/com.termux/files/home/.messages/capture.sh
[ -x "$S" ] || { echo "missing $S" >&2; exit 1; }

$B/termux-job-scheduler --job-id 20 --script "$S" --period-ms 900000 \
  --persisted true --battery-not-low false --network any
$B/termux-job-scheduler -p
