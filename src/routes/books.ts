import { FastifyPluginAsync } from 'fastify'

const COLORS = ['terracotta', 'sage', 'teal'] as const

const bookRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /v1/books
  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id:         { type: 'string' },
              title:      { type: 'string' },
              author:     { type: 'string' },
              color:      { type: 'string' },
              note_count: { type: 'integer' },
              created_at: { type: 'string' },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT b.*, COUNT(n.id)::int AS note_count
       FROM   books b
       LEFT JOIN notes n ON n.book_id = b.id
       WHERE  b.user_id = $1
       GROUP  BY b.id
       ORDER  BY b.created_at DESC`,
      [request.user.uid],
    )
    return rows
  })

  // POST /v1/books
  fastify.post<{
    Body: { title: string; author: string; color?: string }
  }>('/', {
    schema: {
      body: {
        type: 'object',
        required: ['title', 'author'],
        properties: {
          title:  { type: 'string', minLength: 1, maxLength: 200 },
          author: { type: 'string', minLength: 1, maxLength: 200 },
          color:  { type: 'string', enum: COLORS, default: 'teal' },
        },
      },
    },
  }, async (request, reply) => {
    const { title, author, color = 'teal' } = request.body
    const { rows } = await fastify.pg.query(
      `INSERT INTO books (user_id, title, author, color)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [request.user.uid, title, author, color],
    )
    return reply.code(201).send(rows[0])
  })

  // GET /v1/books/:id  (includes notes array)
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT b.*,
         COALESCE(
           json_agg(n ORDER BY n.created_at)
           FILTER (WHERE n.id IS NOT NULL), '[]'
         ) AS notes
       FROM   books b
       LEFT JOIN notes n ON n.book_id = b.id
       WHERE  b.id = $1 AND b.user_id = $2
       GROUP  BY b.id`,
      [request.params.id, request.user.uid],
    )
    if (!rows[0]) return reply.notFound('Book not found')
    return rows[0]
  })

  // PATCH /v1/books/:id
  fastify.patch<{
    Params: { id: string }
    Body: Partial<{ title: string; author: string; color: string }>
  }>('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          title:  { type: 'string', minLength: 1, maxLength: 200 },
          author: { type: 'string', minLength: 1, maxLength: 200 },
          color:  { type: 'string', enum: COLORS },
        },
      },
    },
  }, async (request, reply) => {
    const fields = Object.keys(request.body) as string[]
    if (fields.length === 0) return reply.badRequest('No fields provided')

    const setClauses = fields.map((f, i) => `${f} = $${i + 3}`).join(', ')
    const values     = fields.map((f) => (request.body as Record<string, unknown>)[f])

    const { rows } = await fastify.pg.query(
      `UPDATE books SET ${setClauses}
       WHERE  id = $1 AND user_id = $2
       RETURNING *`,
      [request.params.id, request.user.uid, ...values],
    )
    if (!rows[0]) return reply.notFound('Book not found')
    return rows[0]
  })

  // DELETE /v1/books/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      `DELETE FROM books WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.uid],
    )
    if (!rowCount) return reply.notFound('Book not found')
    return reply.code(204).send()
  })
}

export default bookRoutes
