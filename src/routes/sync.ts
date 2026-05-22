import { FastifyPluginAsync } from 'fastify'

/**
 * Local-first sync — Hive is the source of truth on the device.
 * The backend holds snapshots purely for backup / cross-device restore.
 *
 * POST /v1/sync/push  — Flutter uploads a full graph snapshot
 * GET  /v1/sync/pull  — Flutter downloads the latest snapshot (new device / restore)
 */

// Shape of the graph payload sent from the Flutter app
interface GraphPayload {
  books:       unknown[]
  notes:       unknown[]
  links:       unknown[]
  exported_at: string
}

const syncRoutes: FastifyPluginAsync = async (fastify) => {

  // ── PUSH ────────────────────────────────────────────────────────────────────
  fastify.post<{ Body: GraphPayload }>('/push', {
    schema: {
      body: {
        type: 'object',
        required: ['books', 'notes', 'links', 'exported_at'],
        properties: {
          books:       { type: 'array' },
          notes:       { type: 'array' },
          links:       { type: 'array' },
          exported_at: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { uid } = request.user

    // Save new snapshot
    const { rows } = await fastify.pg.query(
      `INSERT INTO snapshots (user_id, payload)
       VALUES ($1, $2)
       RETURNING id, created_at`,
      [uid, JSON.stringify(request.body)],
    )

    // Keep only the 10 most recent snapshots per user — prune older ones
    await fastify.pg.query(
      `DELETE FROM snapshots
       WHERE user_id = $1
         AND id NOT IN (
           SELECT id FROM snapshots
           WHERE  user_id = $1
           ORDER  BY created_at DESC
           LIMIT  10
         )`,
      [uid],
    )

    return reply.code(201).send({
      snapshot_id: rows[0].id,
      saved_at:    rows[0].created_at,
    })
  })

  // ── PULL ────────────────────────────────────────────────────────────────────
  fastify.get('/pull', async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT id, payload, created_at
       FROM   snapshots
       WHERE  user_id = $1
       ORDER  BY created_at DESC
       LIMIT  1`,
      [request.user.uid],
    )

    if (!rows[0]) return reply.notFound('No snapshot found — push from your device first')

    return {
      snapshot_id: rows[0].id,
      saved_at:    rows[0].created_at,
      graph:       rows[0].payload,
    }
  })

}

export default syncRoutes
