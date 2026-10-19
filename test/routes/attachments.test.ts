// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

/**
 * Integration tests for attachment sync against a real Postgres.
 * Skipped unless TEST_DATABASE_URL points at a database with db/schema.sql
 * applied, e.g.:
 *
 *   docker run -d --name synapse-test-pg -e POSTGRES_USER=synapse \
 *     -e POSTGRES_PASSWORD=synapse -e POSTGRES_DB=synapse_test \
 *     -p 127.0.0.1:5436:5432 postgres:16-alpine
 *   psql postgres://synapse:synapse@127.0.0.1:5436/synapse_test -f db/schema.sql
 *   TEST_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:5436/synapse_test npm test
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'crypto'
import Fastify, { FastifyInstance } from 'fastify'
import sensible from '@fastify/sensible'
import postgres from '@fastify/postgres'
import blobsPlugin from '../../src/plugins/blobs'
import { MemoryBlobStore } from '../../src/lib/blob-store'
import syncRoutes from '../../src/routes/sync'
import attachmentRoutes from '../../src/routes/attachments'
import { VALID_ENCRYPTION_KEY } from '../helpers/fixtures'

const DB = process.env.TEST_DATABASE_URL
const A = 'test-user-a'
const B = 'test-user-b'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function attachmentMeta (id: string, noteId: string, bytes: number, extra = {}) {
  return {
    id, noteId, kind: 'image', fileName: 'Receipt.jpg', ext: 'jpg',
    mime: 'image/jpeg', bytes, width: 800, height: 600,
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...extra,
  }
}

function note (id: string, updatedAt = 1_700_000_000_000) {
  return { id, title: 'Meeting', body: '![[att_x.jpg]]', bookId: '', topic: '',
    createdAt: 1_700_000_000_000, updatedAt }
}

describe('attachments (integration)', { skip: !DB && 'TEST_DATABASE_URL not set' }, () => {
  let app: FastifyInstance
  const store = new MemoryBlobStore()

  const push = (uid: string, body: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/v1/sync/push', headers: { 'x-test-uid': uid },
    payload: { books: [], notes: [], links: [], exported_at: 'now', ...body },
  })
  const upload = (uid: string, id: string, bytes: Buffer, checksum = sha(bytes)) => app.inject({
    method: 'PUT', url: `/v1/attachments/${id}/content`,
    headers: { 'x-test-uid': uid, 'content-type': 'application/octet-stream', 'x-content-sha256': checksum },
    payload: bytes,
  })
  const download = (uid: string, id: string) => app.inject({
    method: 'GET', url: `/v1/attachments/${id}/content`, headers: { 'x-test-uid': uid },
  })
  const usage = async (uid: string) => (await app.inject({
    method: 'GET', url: '/v1/attachments/usage', headers: { 'x-test-uid': uid },
  })).json() as { used: number, quota: number }

  before(async () => {
    process.env.DB_ENCRYPTION_KEY = VALID_ENCRYPTION_KEY
    app = Fastify()
    await app.register(sensible)
    await app.register(postgres, { connectionString: DB })
    await app.register(blobsPlugin, { store })
    // Stand-in for the Firebase hook: the uid comes from a test header.
    app.addHook('onRequest', async (req) => {
      (req as any).user = { uid: req.headers['x-test-uid'] }
    })
    await app.register(syncRoutes, { prefix: '/v1/sync' })
    await app.register(attachmentRoutes, { prefix: '/v1/attachments' })
    await app.ready()
  })

  after(async () => { await app?.close() })

  beforeEach(async () => {
    await app.pg.query(`DELETE FROM users WHERE id = ANY($1)`, [[A, B]])
    await app.pg.query(`INSERT INTO users (id) VALUES ($1), ($2)`, [A, B])
    store.objects.clear()
  })

  it('uploads encrypted bytes and downloads the original', async () => {
    const bytes = randomBytes(5000)
    assert.equal((await push(A, { notes: [note('n1')], attachments: [attachmentMeta('att_aaaaaa111111', 'n1', bytes.length)] })).statusCode, 201)
    assert.equal((await upload(A, 'att_aaaaaa111111', bytes)).statusCode, 201)

    const stored = store.objects.get(`u/${A}/att/att_aaaaaa111111`)!
    assert.ok(stored)
    assert.equal(stored.includes(bytes.subarray(0, 64)), false, 'bucket holds ciphertext')

    const res = await download(A, 'att_aaaaaa111111')
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'image/jpeg')
    assert.deepEqual(res.rawPayload, bytes)
    assert.deepEqual(await usage(A), { used: 5000, quota: 52428800 })
  })

  it('stores the file name encrypted and returns it in pull', async () => {
    await push(A, { attachments: [attachmentMeta('att_aaaaaa111111', 'n1', 10)] })
    const { rows } = await app.pg.query(`SELECT file_name FROM attachments WHERE id = 'att_aaaaaa111111'`)
    assert.notEqual(rows[0].file_name, 'Receipt.jpg')

    const delta = (await app.inject({ method: 'GET', url: '/v1/sync/pull?since=1', headers: { 'x-test-uid': A } })).json()
    const ev = delta.events.find((e: any) => e.entityType === 'attachment')
    assert.equal(ev.payload.fileName, 'Receipt.jpg')
  })

  it('re-uploading is idempotent and does not double-count quota', async () => {
    const bytes = randomBytes(1000)
    await push(A, { attachments: [attachmentMeta('att_aaaaaa111111', 'n1', 1000)] })
    await upload(A, 'att_aaaaaa111111', bytes)
    assert.equal((await upload(A, 'att_aaaaaa111111', bytes)).statusCode, 200)
    assert.equal((await usage(A)).used, 1000)
  })

  it('rejects a checksum mismatch', async () => {
    await push(A, { attachments: [attachmentMeta('att_aaaaaa111111', 'n1', 10)] })
    const res = await upload(A, 'att_aaaaaa111111', randomBytes(10), 'f'.repeat(64))
    assert.equal(res.statusCode, 400)
    assert.equal(store.objects.size, 0)
  })

  it('requires metadata before bytes and validates the id', async () => {
    assert.equal((await upload(A, 'att_unknown12345', randomBytes(10))).statusCode, 404)
    assert.equal((await upload(A, 'att_..%2Fescape', randomBytes(10))).statusCode, 400)
    const bad = await push(A, { attachments: [attachmentMeta('../../x', 'n1', 10)] })
    assert.equal(bad.statusCode, 400)
  })

  it('isolates tenants: another user can neither read nor overwrite', async () => {
    const bytes = randomBytes(100)
    await push(A, { attachments: [attachmentMeta('att_aaaaaa111111', 'n1', 100)] })
    await upload(A, 'att_aaaaaa111111', bytes)

    assert.equal((await download(B, 'att_aaaaaa111111')).statusCode, 404)
    assert.equal((await upload(B, 'att_aaaaaa111111', randomBytes(100))).statusCode, 404)
    // B pushing metadata with A's id must not take the row over.
    await push(B, { attachments: [attachmentMeta('att_aaaaaa111111', 'nB', 100, { updatedAt: 1_800_000_000_000 })] })
    const { rows } = await app.pg.query(`SELECT user_id, note_id FROM attachments WHERE id = 'att_aaaaaa111111'`)
    assert.deepEqual(rows[0], { user_id: A, note_id: 'n1' })
    assert.deepEqual((await download(A, 'att_aaaaaa111111')).rawPayload, bytes)
  })

  it('enforces the per-user quota with 413', async () => {
    await app.pg.query(`INSERT INTO user_storage (user_id, quota_bytes) VALUES ($1, 1500)`, [A])
    await push(A, { attachments: [
      attachmentMeta('att_aaaaaa111111', 'n1', 1000),
      attachmentMeta('att_bbbbbb222222', 'n1', 1000),
    ] })
    assert.equal((await upload(A, 'att_aaaaaa111111', randomBytes(1000))).statusCode, 201)
    const full = await upload(A, 'att_bbbbbb222222', randomBytes(1000))
    assert.equal(full.statusCode, 413)
    assert.deepEqual({ used: full.json().used, quota: full.json().quota }, { used: 1000, quota: 1500 })
    assert.equal(store.objects.size, 1)
    assert.equal((await download(A, 'att_bbbbbb222222')).statusCode, 409)
  })

  it('tombstones delete the row, the object and release quota', async () => {
    await push(A, { attachments: [attachmentMeta('att_aaaaaa111111', 'n1', 800)] })
    await upload(A, 'att_aaaaaa111111', randomBytes(800))
    await push(A, { deletedAttachmentIds: ['att_aaaaaa111111'] })

    assert.equal(store.objects.size, 0)
    assert.equal((await usage(A)).used, 0)
    assert.equal((await download(A, 'att_aaaaaa111111')).statusCode, 404)
  })

  it('deleting a note deletes its attachments', async () => {
    await push(A, { notes: [note('n1')], attachments: [
      attachmentMeta('att_aaaaaa111111', 'n1', 300),
      attachmentMeta('att_cccccc333333', 'n2', 300),
    ] })
    await upload(A, 'att_aaaaaa111111', randomBytes(300))
    await upload(A, 'att_cccccc333333', randomBytes(300))
    await push(A, { deletedNoteIds: ['n1'] })

    assert.deepEqual([...store.objects.keys()], [`u/${A}/att/att_cccccc333333`])
    assert.equal((await usage(A)).used, 300)
    const delta = (await app.inject({ method: 'GET', url: '/v1/sync/pull?since=1', headers: { 'x-test-uid': A } })).json()
    assert.ok(delta.events.some((e: any) => e.entityType === 'attachment' && e.op === 'delete' && e.entityId === 'att_aaaaaa111111'))
  })

  it('syncs book covers and returns attachments in a full pull', async () => {
    await push(A, {
      books: [{ id: 'b1', title: 'Dune', author: 'Herbert', colorIndex: 1, type: 'book',
        coverUrl: 'https://covers.example/dune.jpg', coverColor: 0xFF336699,
        createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }],
      attachments: [attachmentMeta('att_aaaaaa111111', 'n1', 10)],
    })
    const full = (await app.inject({ method: 'GET', url: '/v1/sync/pull', headers: { 'x-test-uid': A } })).json()
    assert.equal(full.graph.books[0].coverUrl, 'https://covers.example/dune.jpg')
    assert.equal(full.graph.books[0].coverColor, 0xFF336699)
    assert.equal(full.graph.attachments[0].fileName, 'Receipt.jpg')
    assert.equal(full.graph.attachments[0].noteId, 'n1')
  })
})
