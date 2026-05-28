import { FastifyPluginAsync } from 'fastify'
import { encrypt, decrypt } from '../lib/crypto'

/**
 * Local-first sync — Hive is the source of truth on the device.
 *
 * POST /v1/sync/push   — Flutter uploads the full graph; backend upserts into
 *                        normalized tables (books / notes / note_links).
 * GET  /v1/sync/pull   — Flutter downloads the latest graph (new device / restore).
 *                        Reads from normalized tables; falls back to legacy
 *                        snapshots table if the user hasn't pushed yet.
 * POST /v1/sync/layout — Save force-directed node positions.
 * GET  /v1/sync/layout — Restore node positions.
 */

// Payload types (mirror Flutter's toMap() output)
interface BookPayload {
  id: string
  title: string
  author: string
  colorIndex: number
  createdAt: number   // milliseconds since epoch
  type: string
}

interface NotePayload {
  id: string
  title: string
  body: string
  bookId: string
  topic: string
  createdAt: number
  updatedAt: number
}

interface LinkPayload {
  id: string
  sourceId: string
  targetId: string
  isManual: boolean
  createdAt: number
}

interface PushBody {
  books: BookPayload[]
  notes: NotePayload[]
  links: LinkPayload[]
  exported_at: string
}

interface LayoutPoint {
  note_id: string
  x: number
  y: number
}

// Database row types (SELECT result shapes)

interface BookRow {
  id: string
  title: string
  author: string
  color_index: number
  type: string
  created_at: string
}

interface NoteRow {
  id: string
  title: string
  body: string
  book_id: string | null
  topic: string
  created_at: string
  updated_at: string
}

interface LinkRow {
  id: string
  source_id: string
  target_id: string
  is_manual: boolean
  created_at: string
}

const syncRoutes: FastifyPluginAsync = async (fastify) => {

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

  // PULL
  // Assembles the graph from normalized tables.
  // Falls back to the legacy snapshots table for users who haven't pushed yet
  // after the migration (empty books table = no data migrated yet for this user).
  fastify.get('/pull', async (request, reply) => {
    const { uid } = request.user

    // Check if this user has data in the normalized tables
    const { rows: bookRows } = (await fastify.pg.query(
      `SELECT id, title, author, color_index, type,
              round(extract(epoch from created_at) * 1000)::bigint AS created_at
       FROM   books
       WHERE  user_id = $1`,
      [uid],
    )) as { rows: BookRow[] }

    // Legacy fallback
    if (bookRows.length === 0) {
      const { rows } = await fastify.pg.query(
        `SELECT id, payload, created_at
         FROM   snapshots
         WHERE  user_id = $1
         ORDER  BY created_at DESC
         LIMIT  1`,
        [uid],
      )
      if (!rows[0]) return reply.notFound('No snapshot found — push from your device first')
      return {
        snapshot_id: rows[0].id,
        saved_at: rows[0].created_at,
        graph: rows[0].payload,
      }
    }

    // Assemble from normalized tables
    const { rows: noteRows } = (await fastify.pg.query(
      `SELECT id, title, body, book_id, topic,
              round(extract(epoch from created_at) * 1000)::bigint AS created_at,
              round(extract(epoch from updated_at) * 1000)::bigint AS updated_at
       FROM   notes
       WHERE  user_id = $1`,
      [uid],
    )) as { rows: NoteRow[] }

    const { rows: linkRows } = (await fastify.pg.query(
      `SELECT id, source_id, target_id, is_manual,
              round(extract(epoch from created_at) * 1000)::bigint AS created_at
       FROM   note_links
       WHERE  user_id = $1`,
      [uid],
    )) as { rows: LinkRow[] }

    return {
      saved_at: new Date().toISOString(),
      graph: {
        books: bookRows.map(r => ({
          id: r.id,
          title: r.title,
          author: r.author,
          colorIndex: r.color_index,
          type: r.type,
          createdAt: Number(r.created_at),
        })),
        notes: noteRows.map(r => ({
          id: r.id,
          title: decrypt(r.title),
          body: decrypt(r.body),
          bookId: r.book_id ?? '',
          topic: decrypt(r.topic),
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        })),
        links: linkRows.map(r => ({
          id: r.id,
          sourceId: r.source_id,
          targetId: r.target_id,
          isManual: r.is_manual,
          createdAt: Number(r.created_at),
        })),
        exported_at: new Date().toISOString(),
      },
    }
  })

  // LAYOUT — save
  // Upserts canvas pixel positions for each note node.
  // Called by Flutter after the force-directed simulation settles.
  fastify.post<{ Body: { layout: LayoutPoint[] } }>('/layout', {
    schema: {
      body: {
        type: 'object',
        required: ['layout'],
        properties: {
          layout: {
            type: 'array',
            items: {
              type: 'object',
              required: ['note_id', 'x', 'y'],
              properties: {
                note_id: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { uid } = request.user
    const { layout } = request.body

    if (layout.length === 0) return reply.send({ updated: 0 })

    for (const { note_id, x, y } of layout) {
      // Only persist layout for notes that actually belong to this user
      await fastify.pg.query(
        `INSERT INTO graph_layout (note_id, user_id, x, y, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (note_id, user_id) DO UPDATE
         SET x = EXCLUDED.x, y = EXCLUDED.y, updated_at = NOW()`,
        [note_id, uid, x, y],
      )
    }

    return reply.send({ updated: layout.length })
  })

  // LAYOUT — restore
  // Returns saved node positions for the current user's graph.
  fastify.get('/layout', async (request, reply) => {
    const { uid } = request.user

    const { rows } = await fastify.pg.query<{
      note_id: string; x: number; y: number
    }>(
      `SELECT note_id, x, y
       FROM   graph_layout
       WHERE  user_id = $1`,
      [uid],
    )

    return { layout: rows }
  })

}

export default syncRoutes
