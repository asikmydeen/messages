#!/data/data/com.termux/files/usr/bin/sh
# RETIRED. Do not run this 20s loop.
#
# Default harvest is Android Job 20 → ~/.messages/capture.sh every 15 minutes
# (termux-job-scheduler --period-ms 900000). See ../PHONE_SETUP.md.
# Jobs 21/22 (content://call_log, content://sms) hang Termux:API and must
# not be installed. This script previously re-armed them via install-jobs.sh.
#
# Kept on the phone so a leftover bashrc/boot line fails closed instead of
# starting a loop or re-hanging JobScheduler.
echo "daemon.sh is retired; Job 20 (15 min capture.sh) is the default." >&2
exit 1
