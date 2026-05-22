import { FastifyPluginAsync } from 'fastify'

const linkRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /v1/links  — all edges for this user
  fastify.get('/', async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT l.*,
         sn.title AS source_title,
         tn.title AS target_title
       FROM   links l
       JOIN   notes sn ON sn.id = l.source_note_id
       JOIN   notes tn ON tn.id = l.target_note_id
       WHERE  l.user_id = $1
       ORDER  BY l.created_at DESC`,
      [request.user.uid],
    )
    return rows
  })

  // POST /v1/links  — create a manual link
  fastify.post<{
    Body: { source_note_id: string; target_note_id: string }
  }>('/', {
    schema: {
      body: {
        type: 'object',
        required: ['source_note_id', 'target_note_id'],
        properties: {
          source_note_id: { type: 'string', format: 'uuid' },
          target_note_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { uid } = request.user
    const { source_note_id, target_note_id } = request.body

    if (source_note_id === target_note_id) {
      return reply.badRequest('A note cannot link to itself')
    }

    // Verify both notes belong to this user
    const { rowCount } = await fastify.pg.query(
      `SELECT 1 FROM notes
       WHERE  id = ANY($1::uuid[]) AND user_id = $2`,
      [[source_note_id, target_note_id], uid],
    )
    if ((rowCount ?? 0) < 2) return reply.notFound('One or both notes not found')

    const { rows } = await fastify.pg.query(
      `INSERT INTO links (user_id, source_note_id, target_note_id, type)
       VALUES ($1, $2, $3, 'manual')
       ON CONFLICT (source_note_id, target_note_id) DO NOTHING
       RETURNING *`,
      [uid, source_note_id, target_note_id],
    )
    // If nothing was inserted it already exists
    if (!rows[0]) return reply.conflict('Link already exists')

    return reply.code(201).send(rows[0])
  })

  // DELETE /v1/links/:id  — remove a manual link (wikilinks are auto-managed)
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT type FROM links WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.uid],
    )
    if (!rows[0]) return reply.notFound('Link not found')
    if (rows[0].type === 'wikilink') {
      return reply.forbidden('Wikilinks are managed automatically — remove [[...]] from the note content')
    }

    await fastify.pg.query(`DELETE FROM links WHERE id = $1`, [request.params.id])
    return reply.code(204).send()
  })
}

export default linkRoutes
