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

const decodeBody = (part) => {
  if (!part) return ''
  let buf = Buffer.isBuffer(part) ? part : Buffer.from(part)
  return buf.toString('utf8').replace(/\r\n/g, '\n')
}

function pickText(msg) {
  // prefer text/plain, else stripped html
  const parts = msg.bodyParts || {}
  if (parts['text/plain'] !== undefined) {
    const t = decodeBody(typeof parts['text/plain'] === 'string' ? parts['text/plain'] : '')
    if (t) return t
  }
  return ''
}

// Sync Gmail over IMAP: since = Date. Returns rows in hub shape.
// Filter: skip Gmail category junk (promotions/social/forums), skip empty.
export async function fetchGmail({ user, pass, since, onProgress }) {
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass },
    logger: false,
    emitLogs: false,
  })
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    const rows = []
    try {
      await client.mailboxOpen('INBOX', { readOnly: true })
      const uids = (await client.search({ since }, { uid: true })) || []
      let done = 0
      for (let i = 0; i < uids.length; i += 50) {
        const batch = uids.slice(i, i + 50)
        for await (const msg of client.fetch(batch, { envelope: true, gmailLabels: true, bodyStructure: true }, { uid: true })) {
          const labels = msg.gmailLabels || []
          if (labels.some((l) => JUNK_LABELS.includes(l))) continue
          const env = msg.envelope || {}
          const subject = (env.subject || '').trim()
          const from = env.from && env.from[0] ? (env.from[0].name ? `${env.from[0].name} <${env.from[0].address}>` : env.from[0].address || '') : ''
          const date = env.date ? new Date(env.date).toISOString().replace('T', ' ').slice(0, 19) : ''
          const msgId = env.messageId || env.inReplyTo || `${subject}|${date}|${from}`
          // fetch body lazily per keeper
          let body = ''
          try {
            const full = await client.fetchOne(String(msg.uid), { bodyStructure: true, source: true }, { uid: true })
            body = extractFromSource(full?.source)
          } catch { /* body optional */ }
          if (!subject && !body) continue
          rows.push({
            dedup_key: sha(`gmail|${msgId}`),
            source: 'gmail',
            app: 'gmail',
            title: subject || '(no subject)',
            sender: from,
            body: body.slice(0, 4000),
            msg_time: date,
            posted_at: Date.now(),
          })
        }
        done += batch.length
        if (onProgress) onProgress(done, uids.length)
      }
    } finally {
      lock.release()
    }
    return rows
  } finally {
    await client.logout().catch(() => client.close())
  }
}

// Fallback text extraction from raw RFC822 source: find first text/plain part,
// else strip HTML from the first text/html part.
function extractFromSource(source) {
  if (!source) return ''
  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source)
  const headerEnd = raw.indexOf('\r\n\r\n') !== -1 ? raw.indexOf('\r\n\r\n') + 4 : raw.indexOf('\n\n') + 2
  const body = raw.slice(headerEnd)
  // crude multipart split
  const bMatch = raw.slice(0, headerEnd).match(/boundary="?([^";\r\n]+)/i)
  if (bMatch) {
    const parts = body.split('--' + bMatch[1])
    let html = ''
    for (const p of parts) {
      if (/content-type:\s*text\/plain/i.test(p) && !/content-disposition:\s*attachment/i.test(p)) {
        const t = p.slice(p.indexOf(/\r?\n\r?\n/))
        const clean = t.replace(/^\s*(\r?\n)+/, '').replace(/\r\n/g, '\n')
        if (clean.trim()) return clean.trim()
      }
      if (/content-type:\s*text\/html/i.test(p) && !html) {
        const t = p.slice(p.indexOf(/\r?\n\r?\n/))
        html = t
      }
    }
    if (html) return stripHtml(html).slice(0, 5000)
  }
  if (/content-type:\s*text\/html/i.test(raw.slice(0, headerEnd))) return stripHtml(body).slice(0, 5000)
  return body.replace(/\r\n/g, '\n').trim()
}
