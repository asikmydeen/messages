#!/data/data/com.termux/files/usr/bin/sh
# Forward notifications + SMS + call log to messages.asikmydeen.com.
# Raw JSON; hub filters, dedups, encrypts, embeds into Qdrant `messages`.
#
# Scheduler: Android Job 20 every 15 min (see install-jobs.sh / start-messages).
# Do not run daemon.sh (retired 20s loop). Do not install Jobs 21/22.
#
# SMS + calls are fetched first. A hung notification listener must not
# starve those pipes. Termux:API KeepAlive is poked so NotificationList
# does not sit forever waiting for a dead listener.
DIR="$(cd "$(dirname "$0")" && pwd)"
TB=/data/data/com.termux/files/usr/bin
HUB="https://messages.asikmydeen.com"
TOKEN="$(cat "$DIR/token" 2>/dev/null)"
[ -n "$TOKEN" ] || { echo "no token file" >&2; exit 1; }

TIMEOUT=""
if [ -x /usr/bin/timeout ]; then
  TIMEOUT=/usr/bin/timeout
elif [ -x "$TB/timeout" ]; then
  TIMEOUT="$TB/timeout"
fi

run_to() {
  secs=$1
  out=$2
  shift 2
  : > "$out"
  if [ -n "$TIMEOUT" ]; then
    "$TIMEOUT" --signal=TERM --kill-after=2 "$secs" "$@" >"$out" 2>/dev/null || true
  else
    "$@" >"$out" 2>/dev/null || true
  fi
}

json_file_or_empty() {
  f=$1
  if [ -s "$f" ]; then
    first=$(dd if="$f" bs=1 count=1 2>/dev/null)
    if [ "$first" = "[" ]; then
      cat "$f"
      return 0
    fi
  fi
  printf '%s' '[]'
}

# Keep the companion app's process alive (NotificationList hangs if it died).
if [ -x "$TB/am" ]; then
  "$TB/am" startservice --user 0 -n com.termux.api/.KeepAliveService >/dev/null 2>&1 || true
fi

# Order is load-bearing: shade last, short timeout.
run_to 15 "$DIR/last.sms.json" "$TB/termux-sms-list" --message-limit=50
run_to 12 "$DIR/last.calls.json" "$TB/termux-call-log" -l 50
run_to 10 "$DIR/last.notifications.json" "$TB/termux-notification-list"

S="$(json_file_or_empty "$DIR/last.sms.json")"
C="$(json_file_or_empty "$DIR/last.calls.json")"
N="$(json_file_or_empty "$DIR/last.notifications.json")"

PY=""
[ -x /usr/bin/python3 ] && PY=/usr/bin/python3
[ -z "$PY" ] && [ -x "$TB/python3" ] && PY="$TB/python3"

# Fold calls into SMS-shaped rows so a hub without parseCalls still stores them.
if [ -n "$PY" ] && [ -f "$DIR/merge_calls.py" ]; then
  S=$(printf '%s' "$S" | "$PY" "$DIR/merge_calls.py" "$DIR/last.calls.json") || S="$S"
  case "$S" in
    \[*) ;;
    *) S='[]' ;;
  esac
fi

if [ -n "$PY" ]; then
  nc=$("$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d) if isinstance(d,list) else 0)" "$DIR/last.notifications.json" 2>/dev/null) || nc=0
  sc=$("$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d) if isinstance(d,list) else 0)" "$DIR/last.sms.json" 2>/dev/null) || sc=0
  cc=$("$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d) if isinstance(d,list) else 0)" "$DIR/last.calls.json" 2>/dev/null) || cc=0
  echo "{\"fetch\":{\"notifications\":${nc:-0},\"sms\":${sc:-0},\"calls\":${cc:-0}}}"
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
