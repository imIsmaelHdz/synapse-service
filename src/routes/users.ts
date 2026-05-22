import { FastifyPluginAsync } from 'fastify'

/**
 * Called once right after the user signs in with Firebase on the Flutter app.
 * Upserts the user into our DB so the other tables can reference them.
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

}

export default userRoutes
