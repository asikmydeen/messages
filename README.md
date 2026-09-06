# messages

Central message hub on Dokploy (TrueNAS). Phone notifications + SMS + call log
captured via Termux:API, forwarded raw, filtered/deduped server-side, encrypted
in Supabase, embedded into Qdrant `messages`.

- `POST /ingest/raw` — Bearer `INGEST_TOKEN`; body `{postedAt, notifications:[], sms:[], calls:[]}`
- `GET /messages?limit&offset&app&source&q=` — JSON (Basic auth)
- `GET /` — web feed (Basic auth) · `GET /health` — public probe
- Phone side: `scripts/capture.sh` + `daemon.sh` (20s wake-locked loop) + `install-jobs.sh`
  (Android JobScheduler: 15-min backup + content://call_log + content://sms triggers)
