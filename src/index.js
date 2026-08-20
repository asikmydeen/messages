import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.PORT || 3000)
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'messages.db')
const INGEST_TOKEN = process.env.INGEST_TOKEN
const FEED_USER = process.env.FEED_USER || 'asik'
const FEED_PASS = process.env.FEED_PASS || ''

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
  create table if not exists messages (
    id integer primary key autoincrement,
    dedup_key text unique not null,
    source text not null,
    app text,
    title text,
    sender text,
    body text,
    msg_time text,
    posted_at integer,
    ingested_at text default (datetime('now'))
  );
  create index if not exists idx_messages_app on messages(app);
  create index if not exists idx_messages_source on messages(source);
`)

// Packages never worth capturing: Termux itself (feedback loop), system chrome.
const DENY_APPS = new Set([
  'com.termux', 'com.termux.api', 'com.termux.boot', 'com.termux.widget',
  'com.android.systemui', 'android',
])

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 40)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function parseNotifications(list, postedAt) {
  const rows = []
  for (const n of Array.isArray(list) ? list : []) {
    const app = n.packageName || 'unknown'
    if (DENY_APPS.has(app)) continue
    if (n.ongoing) continue
    const title = (n.title || '').trim()
    const body = (n.content || n.text || '').trim()
    if (!title && !body) continue
    rows.push({
      dedup_key: sha(`${app}|${title}|${body}|${n.when || n.key || ''}`),
      source: 'notification',
      app,
      title,
      sender: '',
      body,
      msg_time: n.when || '',
      posted_at: postedAt,
    })
  }
  return rows
}

function parseSms(list, postedAt) {
  const rows = []
  for (const m of Array.isArray(list) ? list : []) {
    const body = (m.body || '').trim()
    if (!body) continue
    const when = m.date ? new Date(Number(m.date)).toISOString().replace('T', ' ').slice(0, 19) : ''
    rows.push({
      dedup_key: sha(`sms|${m.smsID ?? ''}|${m.threadID}|${m.address}|${body}|${m.date ?? ''}`),
      source: 'sms',
      app: 'sms',
      title: m.person || m.address || 'SMS',
      sender: m.address || '',
      body,
      msg_time: when,
      posted_at: m.date ? Number(m.date) : postedAt,
    })
  }
  return rows
}

const insert = db.prepare(`
  insert into messages (dedup_key, source, app, title, sender, body, msg_time, posted_at)
  values (@dedup_key, @source, @app, @title, @sender, @body, @msg_time, @posted_at)
  on conflict(dedup_key) do nothing
`)

function insertRows(rows) {
  let inserted = 0
  const tx = db.transaction((batch) => {
    for (const r of batch) if (insert.run(r).changes) inserted++
  })
  tx(rows)
  return inserted
}

const app = new Hono()

// Health probe: public, no auth
app.get('/health', (c) => c.json({ ok: true }))

// Ingest: Bearer token
app.use('/ingest/*', async (c, next) => {
  const got = c.req.header('Authorization') || ''
  const want = `Bearer ${INGEST_TOKEN}`
  if (!INGEST_TOKEN || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})

app.post('/ingest/raw', async (c) => {
  const payload = await c.req.json().catch(() => ({}))
  const postedAt = Number(payload.postedAt) || Date.now()
  const rows = [
    ...parseNotifications(payload.notifications, postedAt),
    ...parseSms(payload.sms, postedAt),
  ]
  const inserted = insertRows(rows)
  return c.json({ received: rows.length, inserted, skipped: rows.length - inserted })
})

// Everything else: Basic auth (web feed + JSON API)
app.use('*', async (c, next) => {
  if (!FEED_PASS) return next()
  const expected = 'Basic ' + Buffer.from(`${FEED_USER}:${FEED_PASS}`).toString('base64')
  const got = c.req.header('Authorization') || ''
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return c.body('Unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="messages"' })
  }
  await next()
})

app.get('/messages', (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 500)
  const offset = Number(c.req.query('offset') || 0)
  const conditions = []
  const params = {}
  if (c.req.query('app')) { conditions.push('app = @app'); params.app = c.req.query('app') }
  if (c.req.query('source')) { conditions.push('source = @source'); params.source = c.req.query('source') }
  if (c.req.query('q')) {
    conditions.push('(title like @q or body like @q or sender like @q or app like @q)')
    params.q = `%${c.req.query('q')}%`
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : ''
  const items = db.prepare(`select * from messages ${where} order by id desc limit @limit offset @offset`)
    .all({ ...params, limit, offset })
  const { total } = db.prepare(`select count(*) as total from messages ${where}`).get(params)
  return c.json({ total, items })
})

app.get('/apps', (c) => {
  const items = db.prepare('select app, count(*) as n from messages group by app order by n desc').all()
  return c.json({ items })
})

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
.meta{font-size:11.5px;color:#8296ab;display:flex;gap:8px;margin-bottom:4px}
.src{padding:0 6px;border-radius:4px;background:#233043;font-weight:600}
.src.sms{background:#3a2d51}
.t{font-weight:600;margin-right:auto}
.b{white-space:pre-wrap;word-break:break-word}
#count{color:#8296ab;font-size:12.5px;margin:0 0 10px}
</style></head><body>
<h1>📨 messages</h1>
<form onsubmit="return go(event)"><input id=q placeholder="search…"><button>Search</button></form>
<div class=chips id=chips></div>
<p id=count></p><div id=list></div>
<script>
let app=null
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
async function load(){
  const q=document.getElementById('q').value
  const u=new URL('/messages',location);u.searchParams.set('limit','200')
  if(q)u.searchParams.set('q',q); if(app)u.searchParams.set('app',app)
  const r=await fetch(u), d=await r.json()
  document.getElementById('count').textContent=d.total+' messages'
  document.getElementById('list').innerHTML=d.items.map(m=>
    '<div class=msg><div class=meta><span class="src '+m.source+'">'+esc(m.source)+'</span><span class=t>'+esc(m.title)+'</span><span>'+esc(m.app)+'</span><span>'+esc(m.msg_time)+'</span></div><div class=b>'+esc(m.body)+'</div></div>').join('')
}
async function chips(){
  const r=await fetch('/apps'), d=await r.json()
  document.getElementById('chips').innerHTML='<span class="chip'+(app?'':' on')+'" onclick="pick(\'\')">all</span>'+
    d.items.map(x=>'<span class="chip'+(app===x.app?' on':'')+'" onclick="pick(\''+esc(x.app)+'\')">'+esc(x.app)+' ('+x.n+')</span>').join('')
}
function pick(a){app=a||null;chips();load()}
function go(e){e.preventDefault();load();return false}
chips();load();setInterval(load,60000)
</script></body></html>`

app.get('/', (c) => c.html(PAGE))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`messages-hub listening on :${info.port} (db: ${DB_PATH})`)
})
