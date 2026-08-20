import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'

const app = new Hono()

app.use('*', cors())

app.get('/', (c) => c.json({ status: 'ok', name: 'messages' }))
app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }))

const port = parseInt(process.env.PORT || '3000')
console.log(`🚀 messages on ${port}`)
serve({ fetch: app.fetch, port })
