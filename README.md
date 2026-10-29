# messages

Central message hub on Dokploy (TrueNAS). Phone notifications + SMS + call log
captured via Termux:API, forwarded raw, filtered/deduped server-side, encrypted
in Supabase, embedded into Qdrant `messages`.

- `POST /ingest/raw` — Bearer `INGEST_TOKEN`; body `{postedAt, notifications:[], sms:[], calls:[]}`
- `GET /ingest/recent?hours&limit&sources=` — last-N-hours rows for Friday briefings (Bearer `INGEST_TOKEN`)
- `GET /messages?limit&offset&app&source&q=` — JSON (Basic auth)
- `GET /` — web feed (Basic auth) · `GET /health` — public probe
- Gmail IMAP sync: boot + every hour (`GMAIL_SYNC_MS`, default 3600000). Promotions/social/forums labels are skipped.
- Phone side: **Job 20** (15 min) → `scripts/capture.sh`. See [PHONE_SETUP.md](PHONE_SETUP.md).
- `scripts/daemon.sh` is **retired** (do not use the 20s loop). `install-jobs.sh` installs Job 20 only — never Jobs 21/22.

Hub `parseCalls` (`source=call`) is on `main` at `7c5a786`. Live ingest may still store folded call rows as `source=sms` until that revision is deployed.
