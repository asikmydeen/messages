#!/data/data/com.termux/files/usr/bin/sh
# Install Job 20 only (15-min capture.sh) + KeepAlive + ongoing notice.
#
# Do NOT install Jobs 21/22. Content-URI triggers (content://sms,
# content://call_log/calls) hang termux-job-scheduler / Termux:API
# for hours and block this script. A future boot must not re-arm them.
exec /data/data/com.termux/files/home/.messages/arm.sh
