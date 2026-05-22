import { FastifyPluginAsync } from 'fastify'

/**
 * POST /v1/users/sync
 * Called by the Flutter app right after Firebase sign-in.
 * Upserts the user into our PostgreSQL users table.
 *
 * GET /v1/users/me
 * Returns the current user's profile.
 */
const userRoutes: FastifyPluginAsync = async (fastify) => {

  // POST /v1/users/sync
  fastify.post('/sync', async (request, reply) => {
    const { uid, email, name } = request.user

    const { rows } = await fastify.pg.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET email        = EXCLUDED.email,
             display_name = EXCLUDED.display_name
       RETURNING *`,
      [uid, email ?? null, name ?? null],
    )

    return reply.code(201).send(rows[0])
  })

  // GET /v1/users/me
  fastify.get('/me', async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT * FROM users WHERE id = $1`,
      [request.user.uid],
    )
    if (!rows[0]) return reply.notFound('User not found — call /sync first')
    return rows[0]
  })
}

export default userRoutes
