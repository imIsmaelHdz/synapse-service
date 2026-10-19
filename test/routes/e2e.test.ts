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
import attachmentRoutes from '../../src/routes/attachments'
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
const keys = {
  note: purposeKey('synapse/notes/v1'),
  book: purposeKey('synapse/meta/v1'),
  link: purposeKey('synapse/meta/v1'),
  attachment: purposeKey('synapse/attachments/v1'),
}
type Kind = keyof typeof keys

function openRaw (raw: Buffer, key: Buffer, aad: string): Buffer {
  const nonce = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const body = raw.subarray(12, raw.length - 16)
  const d = createDecipheriv('aes-256-gcm', key, nonce)
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(body), d.final()])
}

function open (sealed: string, type: Kind, id: string, field: string): string {
  assert.ok(sealed.startsWith('e2e:v1:'), `${type}.${field} is not sealed`)
  const raw = Buffer.from(sealed.slice('e2e:v1:'.length), 'base64')
  return openRaw(raw, keys[type], `${type}|${id}|${field}`).toString('utf8')
}

/** A second device opening a downloaded e2e file: unwrap the file key, then the bytes. */
function openFileBytes (sealed: Buffer, wrappedKey: string, id: string): Buffer {
  const fileKey = Buffer.from(open(wrappedKey, 'attachment', id, 'key'), 'base64')
  return openRaw(sealed, fileKey, `attachment|${id}|bytes`)
}

describe('end-to-end encryption (integration)', { skip: !DB && 'TEST_DATABASE_URL not set' }, () => {
  let app: FastifyInstance
  const store = new MemoryBlobStore()
  const file = fixture.file
  const sealedBytes = Buffer.from(file.sealedBase64, 'base64')

  const upload = (uid: string, bytes: Buffer, wrappedKey?: string) => app.inject({
    method: 'PUT', url: `/v1/attachments/${file.id}/content`,
    headers: {
      'x-test-uid': uid, 'content-type': 'application/octet-stream',
      ...(wrappedKey ? { 'x-wrapped-key': wrappedKey } : {}),
    },
    payload: bytes,
  })
  const download = (uid: string) => app.inject({
    method: 'GET', url: `/v1/attachments/${file.id}/content`, headers: { 'x-test-uid': uid },
  })

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
      `SELECT row_to_json(a)::text AS t FROM attachments a WHERE user_id = $1`,
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
    await app.register(blobsPlugin, { store })
    app.addHook('onRequest', async (req) => {
      (req as any).user = { uid: req.headers['x-test-uid'] }
    })
    await app.register(syncRoutes, { prefix: '/v1/sync' })
    await app.register(attachmentRoutes, { prefix: '/v1/attachments' })
    await app.ready()
  })

  after(async () => { await app?.close() })

  beforeEach(async () => {
    await app.pg.query(`DELETE FROM users WHERE id = ANY($1)`, [[E2E_USER, PLAIN_USER]])
    await app.pg.query(`INSERT INTO users (id, e2e_enabled) VALUES ($1, TRUE), ($2, FALSE)`, [E2E_USER, PLAIN_USER])
    store.objects.clear()
  })

  it('stores an app-sealed photo untouched and a second device opens it', async () => {
    assert.equal((await push(E2E_USER, fixture.push)).statusCode, 201)
    assert.equal((await upload(E2E_USER, sealedBytes, file.wrappedKey)).statusCode, 201)

    // The bucket holds exactly the app's ciphertext: no server envelope.
    const obj = store.objects.get(`u/${E2E_USER}/att/${file.id}`)!
    assert.deepEqual(obj, sealedBytes)
    assert.equal(obj.includes(Buffer.from(MARKER)), false)
    const { rows } = await app.pg.query(
      `SELECT data_key, client_key, bytes FROM attachments WHERE id = $1`, [file.id])
    assert.equal(rows[0].data_key, null)
    assert.equal(rows[0].client_key, file.wrappedKey)
    assert.equal(Number(rows[0].bytes), sealedBytes.length)

    const res = await download(E2E_USER)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-wrapped-key'], file.wrappedKey)
    assert.deepEqual(res.rawPayload, sealedBytes)
    assert.deepEqual(openFileBytes(res.rawPayload, file.wrappedKey, file.id),
      Buffer.from(file.plainBase64, 'base64'))
  })

  it('syncs the attachment file name sealed and without dimensions', async () => {
    await push(E2E_USER, fixture.push)
    const delta = await pull(E2E_USER, 1)
    const att = delta.events.find((e: any) => e.entityId === file.id).payload
    assert.equal(open(att.fileName, 'attachment', file.id, 'fileName'),
      fixture.plaintext.attachments[0].fileName)
    assert.equal('width' in att, false)
    const full = await pull(E2E_USER)
    const fullAtt = full.graph.attachments.find((a: any) => a.id === file.id)
    assert.equal(fullAtt.width, undefined)
    assert.ok(fullAtt.fileName.startsWith('e2e:v1:'))
  })

  it('an e2e account must upload app-sealed bytes', async () => {
    await push(E2E_USER, fixture.push)
    const res = await upload(E2E_USER, Buffer.from(file.plainBase64, 'base64'))
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /must be end-to-end encrypted/)
    assert.equal(store.objects.size, 0)
  })

  it('rejects a malformed wrapped key', async () => {
    await push(E2E_USER, fixture.push)
    assert.equal((await upload(E2E_USER, sealedBytes, 'not-a-key')).statusCode, 400)
  })

  it('legacy uploads still get the server envelope', async () => {
    await push(PLAIN_USER, fixture.plaintext)
    const plain = Buffer.from(file.plainBase64, 'base64')
    assert.equal((await upload(PLAIN_USER, plain)).statusCode, 201)
    const obj = store.objects.get(`u/${PLAIN_USER}/att/${file.id}`)!
    assert.notDeepEqual(obj, plain)
    const res = await download(PLAIN_USER)
    assert.equal(res.headers['x-wrapped-key'], undefined)
    assert.deepEqual(res.rawPayload, plain)
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
