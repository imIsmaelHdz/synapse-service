import { FastifyPluginAsync } from 'fastify'
import admin from 'firebase-admin'

// Row type for the users table
interface UserRow {
  id:           string
  email:        string | null
  display_name: string | null
  created_at:   string
}

/**
 * Called once right after the user signs in with Firebase on the Flutter app.
 * Upserts the user into our DB so the other tables can reference them.
 */
const userRoutes: FastifyPluginAsync = async (fastify) => {

  // POST /v1/users/sync
  fastify.post('/sync', async (request, reply) => {
    const { uid, email, name } = request.user

    const { rows } = await fastify.pg.query<UserRow>(
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

  /**
   * DELETE /v1/users/me
   *
   * Permanently deletes the authenticated user:
   *   1. Removes the row from Postgres `users` table.
   *      All child rows (books, notes, note_links, ai_usage, etc.)
   *      cascade-delete automatically via ON DELETE CASCADE.
   *   2. Deletes the Firebase Auth account so the UID can never sign in again.
   *
   * Apple App Store guidelines (June 2022) require in-app account deletion.
   */
  fastify.delete('/me', async (request, reply) => {
    const { uid } = request.user

    // 1. Delete from Postgres — cascade handles all child data
    await fastify.pg.query(
      `DELETE FROM users WHERE id = $1`,
      [uid],
    )

    // 2. Delete from Firebase Auth
    try {
      await admin.auth().deleteUser(uid)
    } catch (err) {
      // Log but don't fail — Postgres data is already gone.
      // The Firebase account will be an orphan; it can't access any data.
      fastify.log.warn({ uid, err }, 'Firebase deleteUser failed after Postgres delete')
    }

    return reply.code(204).send()
  })

}

export default userRoutes
