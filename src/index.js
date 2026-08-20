import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import crypto from 'node:crypto'

const PORT = Number(process.env.PORT || 3000)
const INGEST_TOKEN = process.env.INGEST_TOKEN || ''
const FEED_USER = process.env.FEED_USER || 'asik'
const FEED_PASS = process.env.FEED_PASS || ''
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const SB_KEY = process.env.SUPABASE_ANON_KEY || ''
const QDRANT_URL = (process.env.QDRANT_URL || '').replace(/\/$/, '')
const OLLAMA_URL = (process.env.OLLAMA_URL || '').replace(/\/$/, '')

if (!INGEST_TOKEN || !SB_URL || !SB_KEY) {
  console.error('missing env: INGEST_TOKEN / SUPABASE_URL / SUPABASE_ANON_KEY')
  process.exit(1)
}

// AES-256-GCM key derived from the ingest token — the DB only ever sees ciphertext.
const AES_KEY = crypto.createHash('sha256').update(`enc:${INGEST_TOKEN}`).digest()
const enc = (s) => {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv)
  const ct = Buffer.concat([c.update(String(s ?? ''), 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}
const dec = (b) => {
  try {
    const raw = Buffer.from(String(b ?? ''), 'base64')
    const d = crypto.createDecipheriv('aes-256-gcm', AES_KEY, raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
  } catch { return '' }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 40)
const uuidFromKey = (k) => {
  const h = String(k).replace(/[^0-9a-f]/g, '').padEnd(32, '0').slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

const DENY_APPS = new Set([
  'com.termux', 'com.termux.api', 'com.termux.boot', 'com.termux.widget',
  'com.android.systemui', 'android',
])

function parseNotifications(list, postedAt) {
  const rows = []
  for (const n of Array.isArray(list) ? list : []) {
    const app = n.packageName || 'unknown'
    if (DENY_APPS.has(app) || n.ongoing) continue
    const title = (n.title || '').trim()
    const body = (n.content || n.text || '').trim()
    if (!title && !body) continue
    rows.push({
      dedup_key: sha(`${app}|${title}|${body}|${n.when || n.key || ''}`),
      source: 'notification',
      app, title, sender: '', body,
      msg_time: n.when || '',
      posted_at: postedAt,
    })
  }
  return rows
}

// Real termux-sms-list schema: threadid, address/number, received ("YYYY-MM-DD HH:MM:SS"), body.
// Older builds use threadID + epoch date — support both.
function parseSms(list, postedAt) {
  const rows = []
  for (const m of Array.isArray(list) ? list : []) {
    const body = (m.body || '').trim()
    if (!body) continue
    const thread = m.threadid ?? m.threadID ?? ''
    const addr = m.address || m.number || ''
    const when = m.received || (m.date ? new Date(Number(m.date)).toISOString().replace('T', ' ').slice(0, 19) : '')
    rows.push({
      dedup_key: sha(`sms|${thread}|${addr}|${body}|${when}`),
      source: 'sms',
      app: 'sms',
      title: m.person || addr || 'SMS',
      sender: addr,
      body,
      msg_time: when,
      posted_at: m.date ? Number(m.date) : postedAt,
    })
  }
  return rows
}

async function pgr(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  if (!r.ok) throw new Error(`postgrest ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r
}

async function insertRows(rows) {
  if (!rows.length) return []
  const payload = rows.map((r) => ({
    dedup_key: r.dedup_key, source: r.source,
    app_enc: enc(r.app), title_enc: enc(r.title), sender_enc: enc(r.sender), body_enc: enc(r.body),
    msg_time: r.msg_time, posted_at: r.posted_at,
  }))
  const r = await pgr('messages?on_conflict=dedup_key&select=id,dedup_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(payload),
  })
  const inserted = await r.json()
  return Array.isArray(inserted) ? inserted.map((x) => x.dedup_key) : []
}

async function fetchRecent(limit = 500) {
  const r = await pgr(`messages?select=*&order=id.desc&limit=${Math.min(limit, 2000)}`, {
    headers: { Prefer: 'count=exact' },
  })
  const range = r.headers.get('content-range') || '' // e.g. "0-499/1234"
  const total = range.includes('/') ? Number(range.split('/')[1]) : null
  const items = (await r.json()).map((m) => ({
    id: m.id, dedup_key: m.dedup_key, source: m.source,
    app: dec(m.app_enc), title: dec(m.title_enc), sender: dec(m.sender_enc), body: dec(m.body_enc),
    msg_time: m.msg_time, posted_at: m.posted_at, ingested_at: m.ingested_at,
  }))
  return { items, total }
}

// Brain sync: embed messages via Ollama (LAN) and upsert into Qdrant `messages`.
// Deterministic point IDs (from dedup_key) make it idempotent. Fire-and-forget
// at ingest; failures never break capture.
async function embedAndStore(rows) {
  if (!QDRANT_URL || !OLLAMA_URL || !rows.length) return 0
  try {
    const texts = rows.map((r) => `${r.title ? r.title + '\n' : ''}${r.body}`)
    const er = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: texts }),
    })
    if (!er.ok) throw new Error(`ollama ${er.status}: ${(await er.text()).slice(0, 120)}`)
    const { embeddings } = await er.json()
    const points = rows.map((r, i) => ({
      id: uuidFromKey(r.dedup_key),
      vector: embeddings[i],
      payload: { text: texts[i], source: r.source, app: r.app, msg_time: r.msg_time, type: 'message' },
    }))
    const qr = await fetch(`${QDRANT_URL}/collections/messages/points?wait=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points }),
    })
    if (!qr.ok) throw new Error(`qdrant ${qr.status}: ${(await qr.text()).slice(0, 120)}`)
    return points.length
  } catch (e) {
    console.error('brain sync failed:', e.message)
    return 0
  }
}

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))

app.use('/ingest/*', async (c, next) => {
  const got = c.req.header('Authorization') || ''
  const want = `Bearer ${INGEST_TOKEN}`
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})

app.post('/ingest/raw', async (c) => {
  const payload = await c.req.json().catch(() => ({}))
  const postedAt = Number(payload.postedAt) || Date.now()
  const rows = [...parseNotifications(payload.notifications, postedAt), ...parseSms(payload.sms, postedAt)]
  try {
    const insertedKeys = await insertRows(rows)
    if (insertedKeys.length) {
      const newRows = rows.filter((r) => insertedKeys.includes(r.dedup_key))
      embedAndStore(newRows).catch(() => {}) // fire-and-forget brain sync
    }
    return c.json({ received: rows.length, inserted: insertedKeys.length, skipped: rows.length - insertedKeys.length })
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 502)
  }
})

// One-shot, idempotent: embed the last 500 stored messages into the brain.
app.post('/ingest/backfill', async (c) => {
  try {
    const { items } = await fetchRecent(500)
    const embedded = await embedAndStore(items)
    return c.json({ stored: items.length, embedded })
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 502)
  }
})

// Auth: Basic header, session cookie, or login link /?key=<password>.
// On any Basic-auth success we ALSO plant the session cookie — some browsers
// (Samsung Internet, in-app webviews) don't attach Basic auth to fetch() calls.
const COOKIE_VAL = FEED_PASS ? crypto.createHash('sha256').update(`mh:${FEED_USER}:${FEED_PASS}`).digest('hex') : ''
const SET_COOKIE = `mh_auth=${COOKIE_VAL}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`

app.use('*', async (c, next) => {
  if (!FEED_PASS) return next()
  const expected = 'Basic ' + Buffer.from(`${FEED_USER}:${FEED_PASS}`).toString('base64')
  const got = c.req.header('Authorization') || ''
  const basicOk = got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))
  const cookie = c.req.header('Cookie') || ''
  const cookieOk = cookie.includes(`mh_auth=${COOKIE_VAL}`)
  if (basicOk || cookieOk) {
    if (basicOk && !cookieOk) c.header('Set-Cookie', SET_COOKIE)
    return next()
  }
  const key = c.req.query('key') || ''
  if (key && (key === FEED_PASS || key === `${FEED_USER}:${FEED_PASS}`)) {
    c.header('Set-Cookie', SET_COOKIE)
    return next()
  }
  return c.body('Unauthorized — open your login link: messages.asikmydeen.com/?key=<feed password>', 401, { 'WWW-Authenticate': 'Basic realm="messages"' })
})

// Never let browsers cache stale page JS — every load gets fresh code.
app.use('*', async (c, next) => { await next(); c.res.headers.set('Cache-Control', 'no-store') })

app.get('/messages', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 500)
  const offset = Number(c.req.query('offset') || 0)
  const q = (c.req.query('q') || '').toLowerCase()
  const appF = c.req.query('app') || ''
  const sourceF = c.req.query('source') || ''
  try {
    const { items, total } = await fetchRecent(q ? 2000 : 500)
    let filtered = items
    if (appF) filtered = filtered.filter((m) => m.app === appF)
    if (sourceF) filtered = filtered.filter((m) => m.source === sourceF)
    if (q) filtered = filtered.filter((m) => `${m.title} ${m.body} ${m.sender} ${m.app}`.toLowerCase().includes(q))
    const page = filtered.slice(offset, offset + limit)
    return c.json({ total: q || appF || sourceF ? filtered.length : total, items: page })
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 502)
  }
})

app.get('/apps', async (c) => {
  try {
    const { items } = await fetchRecent(500)
    const counts = {}
    for (const m of items) counts[m.app] = (counts[m.app] || 0) + 1
    return c.json({ items: Object.entries(counts).map(([app, n]) => ({ app, n })).sort((a, b) => b.n - a.n) })
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 502)
  }
})

// NOTE: browser JS below must contain NO backslash-escaped quotes — this whole
// page lives inside a JS template literal, and Node consumes \' before the
// browser ever sees it. Chips use data-app attributes + event delegation.
const PAGE = `<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>messages</title><style>
:root{color-scheme:dark}
body{font:15px/1.45 -apple-system,system-ui,sans-serif;background:#0e1116;color:#dce3ed;margin:0;padding:16px;max-width:760px;margin-inline:auto}
h1{font-size:18px;margin:0 0 12px}
form{display:flex;gap:8px;margin-bottom:12px}
input{background:#1a2029;color:inherit;border:1px solid #2c3542;border-radius:8px;padding:8px 12px;font:inherit;flex:1}
button{background:#2b6cb0;color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.chip{background:#1a2029;border:1px solid #2c3542;border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer;color:#9fb0c3}
.chip.on{background:#2b6cb0;color:#fff;border-color:#2b6cb0}
.msg{border:1px solid #232c38;border-radius:10px;padding:10px 12px;margin-bottom:8px;background:#141a22}
.meta{font-size:11.5px;color:#8296ab;display:flex;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.src{padding:0 6px;border-radius:4px;background:#233043;font-weight:600}
.src.sms{background:#3a2d51}
.t{font-weight:600;margin-right:auto}
.b{white-space:pre-wrap;word-break:break-word}
#count{color:#8296ab;font-size:12.5px;margin:0 0 10px}
</style></head><body>
<h1>messages</h1>
<form id=f><input id=q placeholder="search…"><button>Search</button></form>
<div class=chips id=chips></div>
<p id=count></p><div id=list></div>
<script>
console.log('boot: fetch=' + (typeof fetch))
let app=null
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
async function load(){
  try{
    const q=document.getElementById('q').value
    const u=new URL('/messages',location);u.searchParams.set('limit','200')
    if(q)u.searchParams.set('q',q); if(app)u.searchParams.set('app',app)
    console.log('load: fetching '+u.pathname)
    const r=await fetch(u,{credentials:'same-origin'})
    console.log('load: status '+r.status)
    if(r.status===401){document.getElementById('list').innerHTML='<div class=msg>Session expired — reopen your login link.</div>';return}
    const d=await r.json()
    console.log('load: total '+(d.total??'?'))
    document.getElementById('count').textContent=(d.total??0)+' messages'
    document.getElementById('list').innerHTML=(d.items||[]).map(m=>
      '<div class=msg><div class=meta><span class="src '+m.source+'">'+esc(m.source)+'</span><span class=t>'+esc(m.title)+'</span><span>'+esc(m.app)+'</span><span>'+esc(m.msg_time)+'</span></div><div class=b>'+esc(m.body)+'</div></div>').join('')
  }catch(e){console.error('load failed: '+(e&&e.message?e.message:e));document.getElementById('list').innerHTML='<div class=msg>Error loading: '+esc(e&&e.message?e.message:e)+'</div>'}
}
async function chips(){
  try{
    const r=await fetch('/apps',{credentials:'same-origin'})
    if(!r.ok){console.log('chips: status '+r.status);return}
    const d=await r.json()
    document.getElementById('chips').innerHTML=
      '<span class="chip'+(app?'':' on')+'" data-app="">all</span>'+
      (d.items||[]).map(x=>'<span class="chip'+(app===x.app?' on':'')+'" data-app="'+esc(x.app)+'">'+esc(x.app)+' ('+x.n+')</span>').join('')
  }catch(e){console.error('chips failed: '+(e&&e.message?e.message:e))}
}
function pick(a){app=a||null;chips();load()}
document.getElementById('chips').addEventListener('click',function(e){
  var t=e.target&&e.target.closest?e.target.closest('.chip'):null
  if(t)pick(t.getAttribute('data-app')||'')
})
document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();load()})
chips();load();setInterval(load,60000)
</script></body></html>`

app.get('/', (c) => c.html(PAGE))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`messages-hub on :${info.port} → ${SB_URL}${QDRANT_URL ? ' + brain(' + QDRANT_URL + ')' : ''} (encrypted at rest)`)
})
