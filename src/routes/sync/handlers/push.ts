// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { FastifyInstance } from 'fastify'
import { encrypt } from '../../../lib/crypto'
import type { PushBody } from '../types'

export function registerPushRoute (fastify: FastifyInstance) {
  /**
   * PUSH
   * Upserts books → notes → note_links in a single transaction.
   * Rows that no longer exist in the payload are deleted (device is source of truth).
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
                createdAt: { type: 'number' },
              },
            },
          },
          exported_at: { type: 'string', maxLength: 50 },
        },
      },
    },
  }, async (request, reply) => {
    const { uid } = request.user
    const { books, notes, links } = request.body

    const client = await fastify.pg.connect()
    try {
      await client.query('BEGIN')

      // 1. Upsert books
      for (const b of books) {
        await client.query(
          `INSERT INTO books (id, user_id, title, author, color_index, type, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
            ON CONFLICT (id) DO UPDATE SET
            title       = EXCLUDED.title,
            author      = EXCLUDED.author,
            color_index = EXCLUDED.color_index,
            type        = EXCLUDED.type`,
          [b.id, uid, b.title, b.author ?? '', b.colorIndex ?? 0, b.type ?? 'book', b.createdAt],
        )
      }

      // Delete books that no longer exist on the device (cascades → notes → links / layout)
      const bookIds = books.map(b => b.id)
      await client.query(
        `DELETE FROM books WHERE user_id = $1 AND id != ALL($2::text[])`,
        [uid, bookIds],
      )

      // 2. Upsert notes — title, body, and topic are encrypted at rest
      for (const n of notes) {
        await client.query(
          `INSERT INTO notes (id, user_id, title, body, book_id, topic, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0))
            ON CONFLICT (id) DO UPDATE SET
            title      = EXCLUDED.title,
            body       = EXCLUDED.body,
            book_id    = EXCLUDED.book_id,
            topic      = EXCLUDED.topic,
            updated_at = EXCLUDED.updated_at`,
          [
            n.id, uid,
            encrypt(n.title),
            encrypt(n.body ?? ''),
            n.bookId || null,
            encrypt(n.topic ?? ''),
            n.createdAt, n.updatedAt,
          ],
        )
      }

      // Delete notes that no longer exist (cascades → note_links + graph_layout for those notes)
      const noteIds = notes.map(n => n.id)
      await client.query(
        `DELETE FROM notes WHERE user_id = $1 AND id != ALL($2::text[])`,
        [uid, noteIds],
      )

      // 3. Replace note_links
      // Links are fully managed by the Flutter app (wiki + manual).
      // Simplest correct strategy: delete all and reinsert the current set.
      await client.query(`DELETE FROM note_links WHERE user_id = $1`, [uid])

      for (const l of links) {
        await client.query(
          `INSERT INTO note_links (id, user_id, source_id, target_id, is_manual, created_at)
            VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
            ON CONFLICT DO NOTHING`,
          [l.id, uid, l.sourceId, l.targetId, l.isManual ?? false, l.createdAt],
        )
      }

      // 4. Append to sync_events log
      // Books — upserts
      for (const b of books) {
        await client.query(
          `INSERT INTO sync_events (uid, entity_type, entity_id, op, payload)
           VALUES ($1, 'book', $2, 'upsert', $3)`,
          [uid, b.id, JSON.stringify(b)],
        )
      }
      // Books — deletes (ids present in DB but absent from this push)
      const { rows: dbBooks } = await client.query<{ id: string }>(
        `SELECT id FROM books WHERE user_id = $1`, [uid],
      )
      const bookIdSet = new Set(books.map(b => b.id))
      for (const row of dbBooks) {
        if (!bookIdSet.has(row.id)) {
          await client.query(
            `INSERT INTO sync_events (uid, entity_type, entity_id, op)
             VALUES ($1, 'book', $2, 'delete')`,
            [uid, row.id],
          )
        }
      }

      // Notes — upserts (store encrypted payload, same as the normalized table)
      for (const n of notes) {
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
      // Notes — deletes
      const { rows: dbNotes } = await client.query<{ id: string }>(
        `SELECT id FROM notes WHERE user_id = $1`, [uid],
      )
      const noteIdSet = new Set(notes.map(n => n.id))
      for (const row of dbNotes) {
        if (!noteIdSet.has(row.id)) {
          await client.query(
            `INSERT INTO sync_events (uid, entity_type, entity_id, op)
             VALUES ($1, 'note', $2, 'delete')`,
            [uid, row.id],
          )
        }
      }

      // Links — upserts
      for (const l of links) {
        await client.query(
          `INSERT INTO sync_events (uid, entity_type, entity_id, op, payload)
           VALUES ($1, 'link', $2, 'upsert', $3)`,
          [uid, l.id, JSON.stringify(l)],
        )
      }
      // Links — deletes (full replace strategy: anything not in this push is gone)
      const { rows: dbLinks } = await client.query<{ id: string }>(
        `SELECT id FROM note_links WHERE user_id = $1`, [uid],
      )
      const linkIdSet = new Set(links.map(l => l.id))
      for (const row of dbLinks) {
        if (!linkIdSet.has(row.id)) {
          await client.query(
            `INSERT INTO sync_events (uid, entity_type, entity_id, op)
             VALUES ($1, 'link', $2, 'delete')`,
            [uid, row.id],
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
