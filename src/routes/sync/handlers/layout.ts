import { FastifyInstance } from 'fastify'
import type { LayoutPoint, LayoutRow } from '../types'

export function registerLayoutRoutes (fastify: FastifyInstance) {
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

    // Single batch upsert — one round-trip regardless of graph size.
    // Builds: ($1,$2,$3,$4,NOW()), ($5,$6,$7,$8,NOW()), …
    const values: (string | number)[] = []
    const placeholders = layout.map(({ note_id, x, y }, i) => {
      const base = i * 4
      values.push(note_id, uid, x, y)
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, NOW())`
    })

    await fastify.pg.query(
      `INSERT INTO graph_layout (note_id, user_id, x, y, updated_at)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (note_id, user_id) DO UPDATE
        SET x = EXCLUDED.x, y = EXCLUDED.y, updated_at = NOW()`,
      values,
    )

    return reply.send({ updated: layout.length })
  })

  // LAYOUT — restore
  // Returns saved node positions for the current user's graph.
  fastify.get('/layout', async (request, reply) => {
    const { uid } = request.user

    const { rows } = await fastify.pg.query<LayoutRow>(
      `SELECT note_id, x, y
        FROM   graph_layout
        WHERE  user_id = $1`,
      [uid],
    )

    return { layout: rows }
  })
}
