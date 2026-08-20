#!/data/data/com.termux/files/usr/bin/sh
# Forward phone notifications + SMS to messages.asikmydeen.com
# Runs in Termux (or PRoot on the same phone). Raw JSON is sent; the hub
# does all filtering + dedup server-side. No jq/python needed here.
DIR="$(cd "$(dirname "$0")" && pwd)"
TB=/data/data/com.termux/files/usr/bin
HUB="https://messages.asikmydeen.com"
TOKEN="$(cat "$DIR/token" 2>/dev/null)"
[ -n "$TOKEN" ] || { echo "no token file" >&2; exit 1; }

N="$($TB/termux-notification-list 2>/dev/null)"; N="${N:-[]}"
S="$($TB/termux-sms-list 2>/dev/null)"; S="${S:-[]}"

curl -s -m 45 -X POST "$HUB/ingest/raw" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"postedAt\":$(date +%s000),\"notifications\":${N},\"sms\":${S}}"
