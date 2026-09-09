# New-phone harvest setup

Install **Job 20 only**. That is a 15-minute `capture.sh` via `termux-job-scheduler`. Do **not** run `daemon.sh` (retired 20s loop). Do **not** install Jobs 21 or 22 (`content://sms` / `content://call_log`) — those hang Termux:API for hours.

This is **not** Friday voice (`friday-talk` / `termux-fold`). Voice uses a different token and talks to `friday.asikmydeen.com`. Harvest POSTs raw SMS, call log, and notification shade snapshots to `https://messages.asikmydeen.com/ingest/raw`.

## 1. Clone this repo

On m4 (or any machine you use to copy files onto the phone):

```bash
git clone https://github.com/asikmydeen/messages.git
# checkout lives at /Users/ammydeen/projects/friday/friday-study/messages on m4
```

On the phone you can also `git clone` inside Termux if git + SSH/HTTPS work there. Either way the scripts that must land in `~/.messages` are:

| File | Role |
|---|---|
| `scripts/capture.sh` | Fetch SMS / calls / shade → POST `/ingest/raw` |
| `scripts/merge_calls.py` | Fold call-log rows into SMS-shaped ingest (until live hub `parseCalls` is deployed) |
| `scripts/install-jobs.sh` | Installs **Job 20 only** |
| `scripts/start-messages` | Termux:Boot: KeepAlive poke + reinstall Job 20 |
| `scripts/daemon.sh` | **Retired.** Exits 1. Do not schedule it. |

Never copy `token`, `last.*`, `daemon.pid`, or `daemon.log` into git.

## 2. Termux packages and permissions

F-Droid / GitHub (same app-id family so they can talk):

- **Termux**
- **Termux:API** (SMS, call log, notification list, KeepAliveService)
- **Termux:Boot** (reinstall Job 20 after reboot; also `start-sshd`)
- **Termux:Widget** — only if you also want `friday-talk`. Not required for harvest.

Packages inside Termux:

```bash
pkg install termux-api termux-services openssh python curl
```

Android permissions / settings (grant in the system UI, then reboot once):

- SMS (read) for `termux-sms-list`
- Call log (read) for `termux-call-log`
- Notification listener for `termux-notification-list` (Termux:API)
- Disable battery optimization for Termux and Termux:API
- Allow Termux:Boot to run at startup

## 3. Install scripts and the existing ingest bearer

```bash
mkdir -p ~/.messages ~/.termux/boot
cp /path/to/messages/scripts/capture.sh ~/.messages/
cp /path/to/messages/scripts/merge_calls.py ~/.messages/
cp /path/to/messages/scripts/install-jobs.sh ~/.messages/
cp /path/to/messages/scripts/daemon.sh ~/.messages/   # retired; fail-closed if something still calls it
cp /path/to/messages/scripts/start-messages ~/.termux/boot/start-messages
chmod 755 ~/.messages/*.sh ~/.messages/merge_calls.py ~/.termux/boot/start-messages
```

**Token — do not invent a new secret.** The ingest bearer is the same value the hub already uses as `INGEST_TOKEN` (Dokploy `messages` service) and that Fold already has at `~/.messages/token` (mode `600`).

- Copy from the live Fold file: `scp fold:~/.messages/token ~/.messages/token` (from the new phone) or `scp fold:~/.messages/token .` then push that file onto the new phone.
- Or copy from the live hub env (`INGEST_TOKEN`) locally on the NAS — do not paste it into chat, git, or `docker inspect` output.
- NAS vault root is `/mnt/asik_home_8/secrets` (on m4: `/Volumes/asik_home_8/secrets` or `~/NAS/pool/secrets`). There is **no** dedicated messages ingest file in that vault as of 2026-09-09. Do not create a new bearer. If you later vault the existing one, put a copy there first, still the same value.
- `friday-voice/clients.json` → `termux-fold` is a **different** token for Friday voice. Do not reuse it here.

```bash
# on the phone, after the file is in place
chmod 600 ~/.messages/token
# never: cat ~/.messages/token
```

## 4. Install Job 20 and boot

On the phone, **inside Termux** (not Ubuntu proot):

```bash
termux-job-scheduler --job-id 20 --script /data/data/com.termux/files/home/.messages/capture.sh \
  --period-ms 900000 --persisted true --battery-not-low false --network any
# equivalent: sh ~/.messages/install-jobs.sh
```

`~/.termux/boot/start-messages` reinstalls Job 20 after reboot and pokes `com.termux.api/.KeepAliveService`. It must **not** start `daemon.sh`.

Optional backup from m4 (does not replace Job 20; Termux:API still runs on the phone):

```bash
# crontab -e on m4
*/15 * * * * ssh fold /data/data/com.termux/files/home/.messages/capture.sh
```

Non-interactive `ssh fold '…'` can run Termux:API. Interactive `ssh fold` must not start the retired daemon.

## 5. What not to install

- `daemon.sh` 20s wake-locked loop
- Jobs **21** / **22** (`--trigger-content-uri content://call_log/calls` or `content://sms`)
- Any bashrc line that `nohup`s `~/.messages/daemon.sh`
- A new ingest token
- Friday Swarm / WhatsApp changes (out of scope)

`install-jobs.sh` in this repo is Job 20 only so a future boot cannot re-arm 21/22.

## 6. Verify

On the phone (Termux, not proot):

```bash
termux-job-scheduler -p
# expect: Pending Job 20 … capture.sh (periodic: 900000ms)

# APIs return JSON arrays (counts only — do not dump bodies)
python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else type(d))' \
  < <(termux-sms-list --message-limit=5)
python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else type(d))' \
  < <(termux-call-log -l 5)
python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else type(d))' \
  < <(termux-notification-list)

pgrep -af 'daemon.sh' || echo 'daemon not running'
sh ~/.messages/capture.sh
# expect a fetch JSON line, then either {"skipped":"unchanged"} or a hub ingest JSON.
# do not print ~/.messages/token or last.body
```

Hub / brain:

- `GET https://messages.asikmydeen.com/health` is public.
- `GET https://messages.asikmydeen.com/messages?limit=5` (Basic auth) should show recent rows.
- Qdrant collection `messages` should grow. Points use `source=sms|notification|call|gmail` as applicable. Today’s live hub may still store folded calls as `source=sms` until `parseCalls` from commit `7c5a786` is deployed (do not deploy from this setup).

## 7. SSH and the Ubuntu proot trap

Fold (and a new phone, if you want the same ops) uses **Termux OpenSSH**, not Dropbear:

- Listen port **8023**
- User is the Termux UID (`u0_a423` on Fold)
- `sshd` under `runsv` (`$PREFIX/var/service/sshd`) plus `~/.termux/boot/start-sshd` as a watchdog
- From m4: `ssh fold` → `Host fold` in `~/.ssh/config` (`100.64.0.8`, port `8023`)

Non-interactive SSH (`ssh fold 'termux-sms-list …'`) does **not** source interactive `~/.bashrc`, so Termux:API works.

Interactive login **does** source `~/.bashrc`. On Fold that file still runs `proot-distro login ubuntu`, which replaces the shell. Inside Ubuntu, `termux-sms-list` / `termux-job-scheduler` are not on `PATH`. Setup and harvest commands must run in Termux:

```bash
ssh fold 'sh ~/.messages/capture.sh'          # good
ssh -t fold                                 # drops into Ubuntu proot — bad for APIs
```

Do **not** add `daemon.sh` to bashrc. Do **not** remove `proot-distro login ubuntu` unless you intend to change the interactive Ubuntu workflow. If you add a harvest note to bashrc, put it **above** the proot line and never `exec`/block before it.

## Fold (reference host)

| Item | Value |
|---|---|
| Mesh | Headscale `fold` / `100.64.0.8` |
| SSH | Termux OpenSSH `:8023`, user `u0_a423` |
| Scripts | `~/.messages/` |
| Keeper job | Job **20**, 900000 ms → `capture.sh` |
| Boot | `~/.termux/boot/start-messages` + `start-sshd` |
