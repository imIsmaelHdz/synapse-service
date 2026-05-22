import { FastifyPluginAsync } from 'fastify'

/**
 * GET /v1/graph
 *
 * Single endpoint the Flutter graph view calls to get the full picture:
 *   { nodes: Note[], edges: Link[] }
 *
 * Each node carries enough data to render the graph canvas —
 * title, source book color, and link count for sizing.
 */
const graphRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            nodes: { type: 'array' },
            edges: { type: 'array' },
          },
        },
      },
    },
  }, async (request) => {
    const { uid } = request.user

    const [nodesResult, edgesResult] = await Promise.all([
      fastify.pg.query(
        `SELECT
           n.id,
           n.title,
           n.book_id,
           b.color  AS book_color,
           b.title  AS book_title,
           COUNT(l.id)::int AS link_count
         FROM   notes n
         LEFT JOIN books b ON b.id = n.book_id
         LEFT JOIN links l
           ON l.source_note_id = n.id OR l.target_note_id = n.id
         WHERE  n.user_id = $1
         GROUP  BY n.id, b.color, b.title
         ORDER  BY link_count DESC`,
        [uid],
      ),
      fastify.pg.query(
        `SELECT id, source_note_id, target_note_id, type
         FROM   links
         WHERE  user_id = $1`,
        [uid],
      ),
    ])

    return {
      nodes: nodesResult.rows,
      edges: edgesResult.rows,
    }
  })
}

export default graphRoutes
