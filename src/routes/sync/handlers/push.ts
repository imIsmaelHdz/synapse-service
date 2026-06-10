// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { FastifyInstance } from 'fastify'
import { encrypt } from '../../../lib/crypto'
import type { PushBody } from '../types'

export function registerPushRoute (fastify: FastifyInstance) {
  /**
   * PUSH (delta + last-write-wins)
   *
   * Upserts the books / notes / links the device changed since its last sync,
   * and deletes exactly the ids listed in deletedBookIds / deletedNoteIds /
   * deletedLinkIds. Rows the payload does NOT mention are left untouched — the
   * server is a merge target, never overwritten wholesale. This makes multi-
   * device sync lossless: a device can only ever delete what it explicitly
   * tombstoned, never what it simply hasn't heard about yet.
   *
   * Conflicts resolve by updatedAt (last-write-wins): an upsert carrying an
   * older updatedAt than the stored row is ignored, and no sync_event is
   * emitted for it, so stale data never propagates to other devices.
   *
   * graph_layout is intentionally NOT touched here — positions are separate.
   */
  fastify.post<{ Body: PushBody }>('/push', {
    schema: {
      body: {
        type: 'object',
        required: ['books', 'notes', 'links', 'exported_at'],
        additionalProperties: false,
        properties: {
          books: {
            type: 'array',
            maxItems: 500,
            items: {
              type: 'object',
              required: ['id', 'title', 'colorIndex', 'createdAt'],
              additionalProperties: false,
              properties: {
                id:         { type: 'string', maxLength: 100 },
                title:      { type: 'string', maxLength: 500 },
                author:     { type: 'string', maxLength: 500 },
                colorIndex: { type: 'integer', minimum: 0, maximum: 11 },
                type:       { type: 'string', maxLength: 50 },
                createdAt:  { type: 'number' },
                updatedAt:  { type: 'number' },
              },
            },
          },
          notes: {
            type: 'array',
            maxItems: 5000,
            items: {
              type: 'object',
              required: ['id', 'title', 'bookId', 'createdAt', 'updatedAt'],
              additionalProperties: false,
              properties: {
                id:        { type: 'string', maxLength: 100 },
                title:     { type: 'string', maxLength: 500 },
                body:      { type: 'string', maxLength: 50000 },
                bookId:    { type: 'string', maxLength: 100 },
                topic:     { type: 'string', maxLength: 200 },
                createdAt: { type: 'number' },
                updatedAt: { type: 'number' },
              },
            },
          },
          links: {
            type: 'array',
            maxItems: 10000,
            items: {
              type: 'object',
              required: ['id', 'sourceId', 'targetId', 'createdAt'],
              additionalProperties: false,
              properties: {
                id:        { type: 'string', maxLength: 100 },
                sourceId:  { type: 'string', maxLength: 100 },
                targetId:  { type: 'string', maxLength: 100 },
                isManual:  { type: 'boolean' },
                reason:    { type: 'string', maxLength: 2000 },
                createdAt: { type: 'number' },
                updatedAt: { type: 'number' },
              },
            },
          },
          exported_at:    { type: 'string', maxLength: 50 },
          deletedBookIds: { type: 'array', maxItems: 5000, items: { type: 'string', maxLength: 100 } },
          deletedNoteIds: { type: 'array', maxItems: 5000, items: { type: 'string', maxLength: 100 } },
          deletedLinkIds: { type: 'array', maxItems: 10000, items: { type: 'string', maxLength: 100 } },
        },
      },
    },
  }, async (request, reply) => {
    const { uid } = request.user
    const { books, notes, links } = request.body
    const deletedBookIds = request.body.deletedBookIds ?? []
    const deletedNoteIds = request.body.deletedNoteIds ?? []
    const deletedLinkIds = request.body.deletedLinkIds ?? []

    const client = await fastify.pg.connect()
    try {
      await client.query('BEGIN')

      // ── 1. Books — upsert with last-write-wins ──────────────────────────
      // updatedAt falls back to createdAt for older clients that don't send it.
      for (const b of books) {
        const updatedAt = b.updatedAt ?? b.createdAt
        const { rowCount } = await client.query(
          `INSERT INTO books (id, user_id, title, author, color_index, type, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0))
            ON CONFLICT (id) DO UPDATE SET
            title       = EXCLUDED.title,
            author      = EXCLUDED.author,
            color_index = EXCLUDED.color_index,
            type        = EXCLUDED.type,
            updated_at  = EXCLUDED.updated_at
            WHERE books.updated_at < EXCLUDED.updated_at
            RETURNING id`,
          [b.id, uid, b.title, b.author ?? '', b.colorIndex ?? 0, b.type ?? 'book', b.createdAt, updatedAt],
        )
        // Only log a sync_event when the write actually landed (newer than stored).
        if (rowCount && rowCount > 0) {
          await client.query(
            `INSERT INTO sync_events (uid, entity_type, entity_id, op, payload)
             VALUES ($1, 'book', $2, 'upsert', $3)`,
            [uid, b.id, JSON.stringify({ ...b, updatedAt })],
          )
        }
      }

      // ── 2. Notes — upsert with last-write-wins (title/body/topic encrypted)
      for (const n of notes) {
        const { rowCount } = await client.query(
          `INSERT INTO notes (id, user_id, title, body, book_id, topic, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0))
            ON CONFLICT (id) DO UPDATE SET
            title      = EXCLUDED.title,
            body       = EXCLUDED.body,
            book_id    = EXCLUDED.book_id,
            topic      = EXCLUDED.topic,
            updated_at = EXCLUDED.updated_at
            WHERE notes.updated_at < EXCLUDED.updated_at
            RETURNING id`,
          [
            n.id, uid,
            encrypt(n.title),
            encrypt(n.body ?? ''),
            n.bookId || null,
            encrypt(n.topic ?? ''),
            n.createdAt, n.updatedAt,
          ],
        )
        if (rowCount && rowCount > 0) {
          await client.query(
            `INSERT INTO sync_events (uid, entity_type, entity_id, op, payload)
             VALUES ($1, 'note', $2, 'upsert', $3)`,
            [uid, n.id, JSON.stringify({
              ...n,
              title: encrypt(n.title),
              body:  encrypt(n.body ?? ''),
              topic: encrypt(n.topic ?? ''),
            })],
          )
        }
      }

      // ── 3. Links — upsert with last-write-wins ──────────────────────────
      for (const l of links) {
        const updatedAt = l.updatedAt ?? l.createdAt
        const { rowCount } = await client.query(
          `INSERT INTO note_links (id, user_id, source_id, target_id, is_manual, reason, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0))
            ON CONFLICT (user_id, source_id, target_id) DO UPDATE SET
            is_manual  = EXCLUDED.is_manual,
            reason     = EXCLUDED.reason,
            updated_at = EXCLUDED.updated_at
            WHERE note_links.updated_at < EXCLUDED.updated_at
            RETURNING id`,
          [l.id, uid, l.sourceId, l.targetId, l.isManual ?? false, l.reason ?? null, l.createdAt, updatedAt],
        )
        if (rowCount && rowCount > 0) {
          await client.query(
            `INSERT INTO sync_events (uid, entity_type, entity_id, op, payload)
             VALUES ($1, 'link', $2, 'upsert', $3)`,
            [uid, l.id, JSON.stringify({
              id:        l.id,
              sourceId:  l.sourceId,
              targetId:  l.targetId,
              isManual:  l.isManual ?? false,
              reason:    l.reason ?? null,
              createdAt: l.createdAt,
              updatedAt,
            })],
          )
        }
      }

      // ── 4. Explicit deletes (tombstones) ────────────────────────────────
      // Delete exactly what the device tombstoned — never inferred from absence.
      // A book delete cascades to its notes; a note delete cascades to its links.
      for (const id of deletedBookIds) {
        const { rowCount } = await client.query(
          `DELETE FROM books WHERE user_id = $1 AND id = $2`, [uid, id],
        )
        if (rowCount && rowCount > 0) {
          await client.query(
            `INSERT INTO sync_events (uid, entity_type, entity_id, op)
             VALUES ($1, 'book', $2, 'delete')`,
            [uid, id],
          )
        }
      }
      for (const id of deletedNoteIds) {
        const { rowCount } = await client.query(
          `DELETE FROM notes WHERE user_id = $1 AND id = $2`, [uid, id],
        )
        if (rowCount && rowCount > 0) {
          await client.query(
            `INSERT INTO sync_events (uid, entity_type, entity_id, op)
             VALUES ($1, 'note', $2, 'delete')`,
            [uid, id],
          )
        }
      }
      for (const id of deletedLinkIds) {
        const { rowCount } = await client.query(
          `DELETE FROM note_links WHERE user_id = $1 AND id = $2`, [uid, id],
        )
        if (rowCount && rowCount > 0) {
          await client.query(
            `INSERT INTO sync_events (uid, entity_type, entity_id, op)
             VALUES ($1, 'link', $2, 'delete')`,
            [uid, id],
          )
        }
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    // Return the highest seq so clients can store it as their cursor
    const { rows } = await fastify.pg.query<{ seq: string }>(
      `SELECT MAX(seq)::text AS seq FROM sync_events WHERE uid = $1`, [uid],
    )
    const seq = rows[0]?.seq ? Number(rows[0].seq) : 0

    return reply.code(201).send({ saved_at: new Date().toISOString(), seq })
  })
}
