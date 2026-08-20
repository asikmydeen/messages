import { ImapFlow } from 'imapflow'
import crypto from 'node:crypto'

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 40)

const JUNK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']

const stripHtml = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()

// Decode a MIME part (headers+content segment) to readable text:
// handles base64 and quoted-printable transfer encodings, then UTF-8.
function decodePart(seg) {
  const sp = seg.search(/\r?\n\r?\n/)
  const phead = sp >= 0 ? seg.slice(0, sp).toLowerCase() : ''
  let content = sp >= 0 ? seg.slice(sp).replace(/^[\s\r\n]+/, '') : seg
  if (/content-transfer-encoding:\s*base64/.test(phead)) {
    try {
      content = Buffer.from(content.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8')
    } catch { /* keep raw */ }
  } else if (/content-transfer-encoding:\s*quoted-printable/.test(phead)) {
    content = content.replace(/=\r?\n/g, '')
    const bytes = []
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '=' && /^[0-9A-F]{2}$/i.test(content.substr(i + 1, 2))) {
        bytes.push(parseInt(content.substr(i + 1, 2), 16))
        i += 2
      } else bytes.push(content.charCodeAt(i) & 0xff)
    }
    try { content = Buffer.from(bytes).toString('utf8') } catch { /* keep raw */ }
  }
  return content.replace(/\r\n/g, '\n')
}

// Sync Gmail over IMAP: since = Date. Returns rows in hub shape.
// Filter: skip Gmail category junk (promotions/social/forums), skip empty.
// Two phases — envelopes+labels first, THEN body fetches. (Fetching bodies
// inside the envelope stream deadlocks imapflow on one connection.)
export async function fetchGmail({ user, pass, since, onProgress }) {
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass },
    logger: false, emitLogs: false,
    greetingTimeout: 30000, socketTimeout: 300000,
  })
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    const rows = []
    try {
      const uids = (await client.search({ since }, { uid: true })) || []
      // Phase 1: envelopes + labels only (cheap, streamable)
      const keepers = []
      for (let i = 0; i < uids.length; i += 50) {
        const batch = uids.slice(i, i + 50)
        for await (const msg of client.fetch(batch, { envelope: true, gmailLabels: true }, { uid: true })) {
          const labels = msg.gmailLabels || []
          if (labels.some((l) => JUNK_LABELS.includes(l))) continue
          const env = msg.envelope || {}
          const subject = (env.subject || '').trim()
          const from = env.from && env.from[0] ? (env.from[0].name ? `${env.from[0].name} <${env.from[0].address}>` : env.from[0].address || '') : ''
          const date = env.date ? new Date(env.date).toISOString().replace('T', ' ').slice(0, 19) : ''
          if (!subject && !env.messageId) continue
          keepers.push({ uid: String(msg.uid), subject, from, date, messageId: env.messageId || `${subject}|${date}|${from}` })
        }
        if (onProgress) onProgress(i + batch.length, uids.length)
      }
      // Phase 2: bodies for keepers only, sequential (no concurrent commands)
      for (let i = 0; i < keepers.length; i++) {
        const k = keepers[i]
        let body = ''
        try {
          const full = await client.fetchOne(k.uid, { source: true }, { uid: true })
          body = extractFromSource(full && full.source)
        } catch { /* body optional */ }
        if (!k.subject && !body) continue
        rows.push({
          dedup_key: sha(`gmail|${k.messageId}`),
          source: 'gmail',
          app: 'gmail',
          title: k.subject || '(no subject)',
          sender: k.from,
          body: body.slice(0, 4000),
          msg_time: k.date,
          posted_at: Date.now(),
        })
        if (onProgress && i % 50 === 0) onProgress(i, keepers.length)
      }
    } finally {
      lock.release()
    }
    return rows
  } finally {
    await client.logout().catch(() => client.close())
  }
}

// Text extraction from raw RFC822 source: first text/plain part, else stripped HTML.
// All parts go through decodePart (base64 / quoted-printable aware).
function extractFromSource(source) {
  if (!source) return ''
  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source)
  const headerEnd = raw.indexOf('\r\n\r\n') !== -1 ? raw.indexOf('\r\n\r\n') + 4 : raw.indexOf('\n\n') + 2
  const headers = raw.slice(0, headerEnd)
  const body = raw.slice(headerEnd)
  const bMatch = headers.match(/boundary="?([^";\r\n]+)/i)
  if (bMatch) {
    const parts = body.split('--' + bMatch[1])
    let html = ''
    for (const p of parts) {
      if (/content-type:\s*text\/plain/i.test(p) && !/content-disposition:\s*attachment/i.test(p)) {
        const decoded = decodePart(p)
        if (decoded.trim()) return decoded.trim()
      }
      if (/content-type:\s*text\/html/i.test(p) && !html && !/content-disposition:\s*attachment/i.test(p)) {
        html = decodePart(p)
      }
    }
    if (html) return stripHtml(html).slice(0, 5000)
  }
  if (/content-type:\s*text\/html/i.test(headers)) return stripHtml(decodePart(raw.slice(headerEnd - 2))).slice(0, 5000)
  return decodePart(raw.slice(headerEnd - 2)).trim()
}
