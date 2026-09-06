#!/data/data/com.termux/files/usr/bin/sh
# Forward notifications + SMS + call log to messages.asikmydeen.com.
# Raw JSON; hub filters, dedups, encrypts, embeds into Qdrant `messages`.
DIR="$(cd "$(dirname "$0")" && pwd)"
TB=/data/data/com.termux/files/usr/bin
HUB="https://messages.asikmydeen.com"
TOKEN="$(cat "$DIR/token" 2>/dev/null)"
[ -n "$TOKEN" ] || { echo "no token file" >&2; exit 1; }

run() {
  if [ -x /usr/bin/timeout ]; then
    /usr/bin/timeout 20 "$@"
  elif command -v timeout >/dev/null 2>&1; then
    timeout 20 "$@"
  else
    "$@"
  fi
}

json_or_empty() {
  case "$1" in
    \[*) printf '%s' "$1" ;;
    *) printf '%s' '[]' ;;
  esac
}

N="$(run "$TB/termux-notification-list" 2>/dev/null)"
S="$(run "$TB/termux-sms-list" --message-limit=50 2>/dev/null)"
C="$(run "$TB/termux-call-log" -l 50 2>/dev/null)"
N="$(json_or_empty "${N:-[]}")"
S="$(json_or_empty "${S:-[]}")"
C="$(json_or_empty "${C:-[]}")"

# Fold calls into SMS-shaped rows so today's hub stores them even before
# parseCalls is deployed. Hub dedup keeps this idempotent.
PY=""
[ -x /usr/bin/python3 ] && PY=/usr/bin/python3
[ -z "$PY" ] && [ -x "$TB/python3" ] && PY="$TB/python3"
if [ -n "$PY" ] && [ -f "$DIR/merge_calls.py" ]; then
  printf '%s' "$C" > "$DIR/last.calls.json"
  S=$(printf '%s' "$S" | "$PY" "$DIR/merge_calls.py" "$DIR/last.calls.json") || S="$S"
  S="$(json_or_empty "${S:-[]}")"
fi

HASHBIN=""
[ -x "$TB/sha256sum" ] && HASHBIN="$TB/sha256sum"
[ -z "$HASHBIN" ] && command -v sha256sum >/dev/null 2>&1 && HASHBIN=sha256sum
H=""
if [ -n "$HASHBIN" ]; then
  H=$(printf '%s\n%s\n%s' "$N" "$S" "$C" | $HASHBIN | awk '{print $1}')
fi
if [ -n "$H" ] && [ -f "$DIR/last.hash" ] && [ "$H" = "$(cat "$DIR/last.hash")" ]; then
  echo '{"skipped":"unchanged"}'
  exit 0
fi

BODY="$DIR/last.body"
printf '{"postedAt":%s,"notifications":%s,"sms":%s,"calls":%s}\n' "$(date +%s000)" "$N" "$S" "$C" > "$BODY"
CURL="$TB/curl"
[ -x "$CURL" ] || CURL=curl
$CURL -s -m 45 -X POST "$HUB/ingest/raw" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @"$BODY"
echo
[ -n "$H" ] && echo "$H" > "$DIR/last.hash"
