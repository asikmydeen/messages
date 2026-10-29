/** Pure query builder for GET /ingest/recent — unit-tested, no I/O. */

export function clampHours(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 24
  return Math.min(Math.max(n, 1), 168)
}

export function clampLimit(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 40
  return Math.min(Math.max(Math.trunc(n), 1), 200)
}

export function parseSources(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-z]+$/.test(s))
}

export function sinceString(hours, nowMs = Date.now()) {
  return new Date(nowMs - hours * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

export function buildRecentPath({ hours, limit, sources, now = Date.now() } = {}) {
  const h = clampHours(hours)
  const lim = clampLimit(limit)
  const srcs = parseSources(sources)
  const since = sinceString(h, now)
  // PostgREST: encode the space in the timestamp; keep source tokens [a-z]+ only.
  let path = `messages?select=*&msg_time=gte.${encodeURIComponent(since)}&order=msg_time.desc&limit=${lim}`
  if (srcs.length === 1) path += `&source=eq.${srcs[0]}`
  else if (srcs.length) path += `&source=in.(${srcs.join(',')})`
  return { path, hours: h, limit: lim, sources: srcs, since }
}
