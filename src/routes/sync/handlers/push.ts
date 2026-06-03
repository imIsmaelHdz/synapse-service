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

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return reply.code(201).send({ saved_at: new Date().toISOString() })
  })
}
