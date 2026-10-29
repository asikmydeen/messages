import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRecentPath, clampHours, clampLimit, parseSources } from '../src/recent_query.js'

test('clamps hours and limit', () => {
  assert.equal(clampHours('nope'), 24)
  assert.equal(clampHours(0), 1)
  assert.equal(clampHours(999), 168)
  assert.equal(clampLimit(-3), 1)
  assert.equal(clampLimit(5000), 200)
})

test('drops injected source tokens', () => {
  assert.deepEqual(parseSources('gmail,sms,source=eq.x,DROP TABLE'), ['gmail', 'sms'])
  assert.deepEqual(parseSources('GMAIL,sms'), ['sms'])
})

test('builds recency path with encoded timestamp and source filter', () => {
  const now = Date.parse('2026-09-20T12:00:00.000Z')
  const { path, since, hours } = buildRecentPath({ hours: 24, limit: 20, sources: 'gmail', now })
  assert.equal(hours, 24)
  assert.equal(since, '2026-09-19 12:00:00')
  assert.ok(path.includes('msg_time=gte.2026-09-19%2012%3A00%3A00'))
  assert.ok(path.includes('source=eq.gmail'))
  assert.ok(path.includes('order=msg_time.desc'))
})

test('multi-source uses in() and ignores junk', () => {
  const { path, sources } = buildRecentPath({ sources: 'sms,notification,call,evil 1', limit: 5 })
  assert.deepEqual(sources, ['sms', 'notification', 'call'])
  assert.ok(path.includes('source=in.(sms,notification,call)'))
  assert.ok(path.includes('limit=5'))
})
