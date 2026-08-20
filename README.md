# messages

Central message hub on Dokploy (TrueNAS). Phone notifications + SMS captured
via Termux:API, forwarded raw, filtered/deduped server-side, SQLite-backed,
searchable web feed.

- `POST /ingest/raw` — Bearer `INGEST_TOKEN`; body `{postedAt, notifications:[], sms:[]}`
- `GET /messages?limit&offset&app&source&q=` — JSON (Basic auth)
- `GET /` — web feed (Basic auth) · `GET /health` — public probe
- Phone side: `scripts/capture.sh` + `token` file, scheduled in Termux
