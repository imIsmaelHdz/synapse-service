import { FastifyInstance, FastifyPluginAsync } from 'fastify'

// ── Wikilink sync helper ──────────────────────────────────────────────────────
// Called after every note create / update.
// Parses [[Note Title]] patterns and rebuilds wikilink edges in the links table.
async function syncWikilinks (
  fastify: FastifyInstance,
  noteId: string,
  content: string,
  userId: string,
) {
  // 1. Remove stale wikilinks for this note
  await fastify.pg.query(
    `DELETE FROM links WHERE source_note_id = $1 AND type = 'wikilink'`,
    [noteId],
  )

  // 2. Parse [[...]] patterns
  const titles = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim())
  if (titles.length === 0) return

  // 3. Resolve titles → note IDs (same user, not self)
  const { rows: targets } = await fastify.pg.query(
    `SELECT id FROM notes
     WHERE  user_id = $1
       AND  title   = ANY($2::text[])
       AND  id     != $3`,
    [userId, titles, noteId],
  )

  // 4. Insert new wikilink edges (ignore duplicates)
  for (const { id: targetId } of targets) {
    await fastify.pg.query(
      `INSERT INTO links (user_id, source_note_id, target_note_id, type)
       VALUES ($1, $2, $3, 'wikilink')
       ON CONFLICT (source_note_id, target_note_id) DO NOTHING`,
      [userId, noteId, targetId],
    )
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
const noteRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /v1/notes?book_id=<uuid>
  fastify.get<{ Querystring: { book_id?: string } }>('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          book_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request) => {
    const { uid }    = request.user
    const { book_id } = request.query

    const { rows } = await fastify.pg.query(
      `SELECT n.*,
         b.title  AS book_title,
         b.color  AS book_color,
         COUNT(l.id)::int AS link_count
       FROM   notes n
       LEFT JOIN books b ON b.id = n.book_id
       LEFT JOIN links l ON l.source_note_id = n.id OR l.target_note_id = n.id
       WHERE  n.user_id = $1
         ${book_id ? 'AND n.book_id = $2' : ''}
       GROUP  BY n.id, b.title, b.color
       ORDER  BY n.updated_at DESC`,
      book_id ? [uid, book_id] : [uid],
    )
    return rows
  })

  // POST /v1/notes
  fastify.post<{
    Body: { title: string; content?: string; book_id?: string }
  }>('/', {
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title:   { type: 'string', minLength: 1, maxLength: 300 },
          content: { type: 'string', default: '' },
          book_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { uid } = request.user
    const { title, content = '', book_id = null } = request.body

    const { rows } = await fastify.pg.query(
      `INSERT INTO notes (user_id, book_id, title, content)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [uid, book_id, title, content],
    )
    const note = rows[0]

    await syncWikilinks(fastify, note.id, content, uid)

    return reply.code(201).send(note)
  })

  // GET /v1/notes/:id  (includes outgoing + incoming links)
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { uid } = request.user
    const { id }  = request.params

    const { rows } = await fastify.pg.query(
      `SELECT n.*,
         COALESCE(
           (SELECT json_agg(row_to_json(l))
            FROM   links l
            WHERE  l.source_note_id = n.id OR l.target_note_id = n.id),
           '[]'
         ) AS links
       FROM notes n
       WHERE n.id = $1 AND n.user_id = $2`,
      [id, uid],
    )
    if (!rows[0]) return reply.notFound('Note not found')
    return rows[0]
  })

  // PATCH /v1/notes/:id
  fastify.patch<{
    Params: { id: string }
    Body: Partial<{ title: string; content: string; book_id: string }>
  }>('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          title:   { type: 'string', minLength: 1, maxLength: 300 },
          content: { type: 'string' },
          book_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { uid } = request.user
    const { id }  = request.params
    const fields  = Object.keys(request.body) as string[]
    if (fields.length === 0) return reply.badRequest('No fields provided')

    const setClauses = fields.map((f, i) => `${f} = $${i + 3}`).join(', ')
    const values     = fields.map((f) => (request.body as Record<string, unknown>)[f])

    const { rows } = await fastify.pg.query(
      `UPDATE notes SET ${setClauses}
       WHERE  id = $1 AND user_id = $2
       RETURNING *`,
      [id, uid, ...values],
    )
    if (!rows[0]) return reply.notFound('Note not found')

    // Re-sync wikilinks if content changed
    if ('content' in request.body) {
      await syncWikilinks(fastify, id, rows[0].content, uid)
    }

    return rows[0]
  })

  // DELETE /v1/notes/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      `DELETE FROM notes WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.uid],
    )
    if (!rowCount) return reply.notFound('Note not found')
    return reply.code(204).send()
  })
}

export default noteRoutes
