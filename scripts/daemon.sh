#!/data/data/com.termux/files/usr/bin/sh
# messages-hub capture daemon — wake-locked loop.
# Polls every 20s so new SMS / calls / shade items hit the hub quickly.
# Content-URI jobs (install-jobs.sh) also fire capture.sh on SMS/call-log changes.
B=/data/data/com.termux/files/usr/bin
M=/data/data/com.termux/files/home/.messages
L=$M/daemon.log
PIDF=$M/daemon.pid

if [ -f "$PIDF" ]; then
  old=$(cat "$PIDF" 2>/dev/null)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    exit 0
  fi
fi
echo $$ > "$PIDF"

$B/termux-wake-lock 2>/dev/null || true

nap() {
  sec=${1:-20}
  if [ -x /bin/sleep ]; then
    /bin/sleep "$sec"
  elif [ -x "$B/sleep" ]; then
    "$B/sleep" "$sec"
  else
    sleep "$sec"
  fi
}

while :; do
  sh "$M/capture.sh" >>"$L" 2>&1
  if [ -f "$L" ]; then
    sz=$(wc -c < "$L")
    [ "$sz" -gt 100000 ] && { tail -c 20000 "$L" >"$L.t" && mv "$L.t" "$L"; }
  fi
  nap 20
done
