import { ImapFlow } from 'imapflow'
import crypto from 'node:crypto'
import tls from 'node:tls'

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
    greetingTimeout: Number(process.env.GMAIL_IMAP_GREETING_MS || 20_000),
    socketTimeout: Number(process.env.GMAIL_IMAP_SOCKET_MS || 60_000),
  })
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    const rows = []
    let uidCount = 0
    let keeperCount = 0
    let skippedJunk = 0
    try {
      const uids = (await client.search({ since }, { uid: true })) || []
      uidCount = uids.length
      // Phase 1: envelopes + labels only (cheap, streamable)
      const keepers = []
      for (let i = 0; i < uids.length; i += 50) {
        const batch = uids.slice(i, i + 50)
        for await (const msg of client.fetch(batch, { envelope: true, gmailLabels: true }, { uid: true })) {
          const labels = msg.gmailLabels || []
          if (labels.some((l) => JUNK_LABELS.includes(l))) { skippedJunk += 1; continue }
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
      keeperCount = keepers.length
    } finally {
      lock.release()
    }
    console.log(`gmail imap ${user}: uids=${uidCount} keepers=${keeperCount} skippedJunk=${skippedJunk} rows=${rows.length}`)
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

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64')
}

/** SMTP AUTH LOGIN over implicit TLS (Gmail app password). */
export function smtpSend({ user, pass, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' })
    let buf = ''
    let step = 0
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('smtp timeout'))
    }, 20000)
    const send = (line) => sock.write(line + '\r\n')
    const fail = (msg) => {
      clearTimeout(timer)
      sock.destroy()
      reject(new Error(msg))
    }
    sock.on('error', (e) => fail(e.message || 'smtp error'))
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      while (buf.includes('\n')) {
        const i = buf.indexOf('\n')
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (!/^\d{3}[ -]/.test(line) || line[3] === '-') continue
        const code = line.slice(0, 3)
        if (step === 0) {
          if (code !== '220') return fail(line)
          send('EHLO friday.local'); step = 1
        } else if (step === 1) {
          send('AUTH LOGIN'); step = 2
        } else if (step === 2) {
          send(b64(user)); step = 3
        } else if (step === 3) {
          send(b64(pass)); step = 4
        } else if (step === 4) {
          if (code !== '235') return fail('smtp auth failed')
          send(`MAIL FROM:<${user}>`); step = 5
        } else if (step === 5) {
          send(`RCPT TO:<${to}>`); step = 6
        } else if (step === 6) {
          send('DATA'); step = 7
        } else if (step === 7) {
          const payload = [
            `From: ${user}`,
            `To: ${to}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            text,
            '.',
          ].join('\r\n')
          send(payload); step = 8
        } else if (step === 8) {
          send('QUIT'); step = 9
          clearTimeout(timer)
          sock.end()
          resolve({ ok: true })
        }
      }
    })
  })
}
