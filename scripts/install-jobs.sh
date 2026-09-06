#!/data/data/com.termux/files/usr/bin/sh
# Android JobScheduler: 15-min backup + fire on call-log / SMS provider changes.
B=/data/data/com.termux/files/usr/bin
S=/data/data/com.termux/files/home/.messages/capture.sh
[ -x "$S" ] || { echo "missing $S" >&2; exit 1; }

$B/termux-job-scheduler --job-id 20 --script "$S" --period-ms 900000 \
  --persisted true --battery-not-low false --network any
$B/termux-job-scheduler --job-id 21 --script "$S" \
  --trigger-content-uri content://call_log/calls --trigger-content-flag 1 \
  --persisted true --battery-not-low false --network any
$B/termux-job-scheduler --job-id 22 --script "$S" \
  --trigger-content-uri content://sms --trigger-content-flag 1 \
  --persisted true --battery-not-low false --network any
$B/termux-job-scheduler -p
