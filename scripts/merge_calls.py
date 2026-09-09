#!/usr/bin/env python3
"""Fold termux-call-log JSON into SMS-shaped rows so a hub without parseCalls
still stores them (source=sms). Harmless extra if the hub also parses `calls`."""
import json
import sys

sms = json.load(sys.stdin)
try:
    calls = json.load(open(sys.argv[1]))
except Exception:
    calls = []
if not isinstance(sms, list):
    sms = []
if not isinstance(calls, list):
    calls = []
for c in calls:
    if not isinstance(c, dict):
        continue
    num = str(c.get("phone_number") or c.get("number") or "").strip()
    name = str(c.get("name") or "").strip()
    typ = str(c.get("type") or "CALL").strip().upper()
    when = c.get("date") or c.get("when") or ""
    dur = c.get("duration") or ""
    if not num and not name:
        continue
    who = name if name and name != "UNKNOWN_CALLER" else (num or "unknown")
    extra = f" {num}" if num and who != num else ""
    sms.append({
        "body": f"CALL {typ} {who}{extra} dur={dur}".strip(),
        "address": num or "call-log",
        "received": when,
        "threadid": f"call:{num}",
        "type": "inbox",
        "person": f"{typ} {who}",
    })
json.dump(sms, sys.stdout, separators=(",", ":"))
