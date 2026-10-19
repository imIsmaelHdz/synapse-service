// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

/**
 * End-to-end encryption through the real push/pull handlers and Postgres.
 *
 * test/fixtures/e2e-push.json is a push body sealed by the Synapse app's own
 * codec (Dart, test/e2e_sync_codec_test.dart) with a fixed test-only account
 * key. The server must store and return those values byte for byte, keep
 * them out of its at-rest sealing, and never hold readable note text. A small
 * Node implementation of the e2e:v1 format plays the "second device" that
 * holds the same account key and reads the notes back.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with db/schema.sql
 * applied (see test/routes/attachments.test.ts for the docker command).
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, hkdfSync, randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import Fastify, { FastifyInstance } from 'fastify'
import sensible from '@fastify/sensible'
import postgres from '@fastify/postgres'
import blobsPlugin from '../../src/plugins/blobs'
import { MemoryBlobStore } from '../../src/lib/blob-store'
import syncRoutes from '../../src/routes/sync'
import { VALID_ENCRYPTION_KEY } from '../helpers/fixtures'

const DB = process.env.TEST_DATABASE_URL
const E2E_USER = 'test-e2e-user'
const PLAIN_USER = 'test-plain-user'

const fixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/e2e-push.json'), 'utf8'))
const MARKER: string = fixture.marker

// ── Reference reader for e2e:v1 (same format as lib/services/e2e in the app)
const accountKey = Buffer.from(fixture.accountKeyHex, 'hex')
const purposeKey = (purpose: string) =>
  Buffer.from(hkdfSync('sha256', accountKey, Buffer.from('synapse-e2e'), Buffer.from(purpose), 32))
const keys = { note: purposeKey('synapse/notes/v1'), book: purposeKey('synapse/meta/v1'), link: purposeKey('synapse/meta/v1') }

function open (sealed: string, type: 'note' | 'book' | 'link', id: string, field: string): string {
  assert.ok(sealed.startsWith('e2e:v1:'), `${type}.${field} is not sealed`)
  const raw = Buffer.from(sealed.slice('e2e:v1:'.length), 'base64')
  const nonce = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const body = raw.subarray(12, raw.length - 16)
  const d = createDecipheriv('aes-256-gcm', keys[type], nonce)
  d.setAAD(Buffer.from(`${type}|${id}|${field}`))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(body), d.final()]).toString('utf8')
}

describe('end-to-end encryption (integration)', { skip: !DB && 'TEST_DATABASE_URL not set' }, () => {
  let app: FastifyInstance

  const push = (uid: string, body: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/v1/sync/push', headers: { 'x-test-uid': uid },
    payload: { books: [], notes: [], links: [], exported_at: 'now', ...body },
  })
  const pull = async (uid: string, since?: number) => (await app.inject({
    method: 'GET', url: since ? `/v1/sync/pull?since=${since}` : '/v1/sync/pull',
    headers: { 'x-test-uid': uid },
  })).json()

  /** Every text the server stores for a user: rows and the event log. */
  async function storedText (uid: string): Promise<string> {
    const parts: string[] = []
    for (const sql of [
      `SELECT row_to_json(b)::text AS t FROM books b WHERE user_id = $1`,
      `SELECT row_to_json(n)::text AS t FROM notes n WHERE user_id = $1`,
      `SELECT row_to_json(l)::text AS t FROM note_links l WHERE user_id = $1`,
      `SELECT payload::text AS t FROM sync_events WHERE uid = $1 AND payload IS NOT NULL`,
    ]) {
      const { rows } = await app.pg.query<{ t: string }>(sql, [uid])
      parts.push(...rows.map(r => r.t))
    }
    return parts.join('\n')
  }

  before(async () => {
    process.env.DB_ENCRYPTION_KEY = VALID_ENCRYPTION_KEY
    app = Fastify()
    await app.register(sensible)
    await app.register(postgres, { connectionString: DB })
    await app.register(blobsPlugin, { store: new MemoryBlobStore() })
    app.addHook('onRequest', async (req) => {
      (req as any).user = { uid: req.headers['x-test-uid'] }
    })
    await app.register(syncRoutes, { prefix: '/v1/sync' })
    await app.ready()
  })

  after(async () => { await app?.close() })

  beforeEach(async () => {
    await app.pg.query(`DELETE FROM users WHERE id = ANY($1)`, [[E2E_USER, PLAIN_USER]])
    await app.pg.query(`INSERT INTO users (id, e2e_enabled) VALUES ($1, TRUE), ($2, FALSE)`, [E2E_USER, PLAIN_USER])
  })

  it('stores no readable text for an e2e account, in rows or sync_events', async () => {
    assert.equal((await push(E2E_USER, fixture.push)).statusCode, 201)
    const stored = await storedText(E2E_USER)
    assert.ok(stored.length > 0)
    assert.equal(stored.includes(MARKER), false, 'plaintext marker found in the database')

    // Sealed values are kept as-is: not re-sealed with the server's master key.
    const { rows } = await app.pg.query(`SELECT body FROM notes WHERE id = 'note-e2e-1'`)
    assert.equal(rows[0].body, fixture.push.notes[0].body)
  })

  it('returns sealed values byte for byte and a second device reads them', async () => {
    await push(E2E_USER, fixture.push)
    const delta = await pull(E2E_USER, 1)
    const note = delta.events.find((e: any) => e.entityId === 'note-e2e-1').payload
    const book = delta.events.find((e: any) => e.entityId === 'book-e2e-1').payload
    const link = delta.events.find((e: any) => e.entityId === 'link-e2e-1').payload
    assert.equal(note.body, fixture.push.notes[0].body)

    const plain = fixture.plaintext
    assert.equal(open(note.title, 'note', 'note-e2e-1', 'title'), plain.notes[0].title)
    assert.equal(open(note.body, 'note', 'note-e2e-1', 'body'), plain.notes[0].body)
    assert.equal(open(note.topic, 'note', 'note-e2e-1', 'topic'), plain.notes[0].topic)
    assert.equal(open(book.title, 'book', 'book-e2e-1', 'title'), plain.books[0].title)
    assert.equal(open(book.coverUrl, 'book', 'book-e2e-1', 'coverUrl'), plain.books[0].coverUrl)
    assert.equal(open(link.reason, 'link', 'link-e2e-1', 'reason'), plain.links[0].reason)

    const full = await pull(E2E_USER)
    const fullNote = full.graph.notes.find((n: any) => n.id === 'note-e2e-1')
    const empty = full.graph.notes.find((n: any) => n.id === 'note-e2e-2')
    assert.equal(open(fullNote.body, 'note', 'note-e2e-1', 'body'), plain.notes[0].body)
    assert.equal(open(empty.topic, 'note', 'note-e2e-2', 'topic'), '')
    const fullBook = full.graph.books.find((b: any) => b.id === 'book-e2e-1')
    assert.equal(open(fullBook.author, 'book', 'book-e2e-1', 'author'), plain.books[0].author)
  })

  it('rejects plaintext from an e2e account and writes nothing', async () => {
    const res = await push(E2E_USER, fixture.plaintext)
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /must be end-to-end encrypted/)
    assert.equal(await storedText(E2E_USER), '')
  })

  it('keeps legacy accounts working: plaintext is sealed at rest as before', async () => {
    assert.equal((await push(PLAIN_USER, fixture.plaintext)).statusCode, 201)
    const { rows } = await app.pg.query(`SELECT body FROM notes WHERE id = 'note-e2e-1'`)
    assert.equal(rows[0].body.includes(MARKER), false)
    const delta = await pull(PLAIN_USER, 1)
    const note = delta.events.find((e: any) => e.entityId === 'note-e2e-1').payload
    assert.equal(note.body, fixture.plaintext.notes[0].body)
  })

  it('allows sealed notes beyond the plaintext cap, rejects oversized plaintext', async () => {
    const note = fixture.push.notes[0]
    const bigSealed = 'e2e:v1:' + randomBytes(51000).toString('base64')
    assert.equal((await push(E2E_USER, { books: fixture.push.books, notes: [{ ...note, body: bigSealed }] })).statusCode, 201)

    const plainNote = fixture.plaintext.notes[0]
    const res = await push(PLAIN_USER, { books: fixture.plaintext.books, notes: [{ ...plainNote, body: 'x'.repeat(50001) }] })
    assert.equal(res.statusCode, 400)
  })

  it('rejects malformed sealed values', async () => {
    const note = fixture.push.notes[0]
    const res = await push(E2E_USER, { books: fixture.push.books, notes: [{ ...note, body: 'e2e:v1:not base64!' }] })
    assert.equal(res.statusCode, 400)
  })
})
