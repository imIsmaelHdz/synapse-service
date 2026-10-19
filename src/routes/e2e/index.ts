// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { FastifyPluginAsync } from 'fastify'
import type { PoolClient } from 'pg'
import { isValidE2e } from '../../lib/e2e'

/**
 * Turning end-to-end encryption on for an account (spec phase 4).
 *
 * GET  /v1/e2e/status  { enabled, keyCheck, pending } — pending counts what
 *                      is still not sealed by the app: notes, books, links,
 *                      attachment names, and uploaded files still in the
 *                      server's own envelope (these must be re-uploaded).
 * POST /v1/e2e/enable  { keyCheck } — once nothing is pending, in one
 *                      transaction: set e2e_enabled, store the key check,
 *                      delete the old sync_events (they hold server-readable
 *                      copies) and rebuild them from the now-sealed rows, and
 *                      drop legacy snapshots. 409 { pending } otherwise.
 *
 * The app drives it: create the account key, re-push everything sealed,
 * re-upload files sealed, poll status, then enable.
 */

interface Pending {
  notes:       number
  books:       number
  links:       number
  attachments: number
  files:       number
}

const SEALED = `LIKE 'e2e:v1:%'`

async function pendingFor (db: { query: PoolClient['query'] }, uid: string): Promise<Pending> {
  const { rows } = await db.query<Record<keyof Pending, string>>(
    `SELECT
       (SELECT count(*) FROM notes WHERE user_id = $1
          AND NOT (title ${SEALED} AND body ${SEALED} AND topic ${SEALED}))          AS notes,
       (SELECT count(*) FROM books WHERE user_id = $1
          AND NOT (title ${SEALED} AND author ${SEALED}
                   AND (cover_url IS NULL OR cover_url ${SEALED})))                  AS books,
       (SELECT count(*) FROM note_links WHERE user_id = $1
          AND reason IS NOT NULL AND NOT reason ${SEALED})                           AS links,
       (SELECT count(*) FROM attachments WHERE user_id = $1
          AND NOT file_name ${SEALED})                                               AS attachments,
       (SELECT count(*) FROM attachments WHERE user_id = $1
          AND uploaded AND client_key IS NULL)                                       AS files`,
    [uid],
  )
  const r = rows[0]
  return {
    notes:       Number(r.notes),
    books:       Number(r.books),
    links:       Number(r.links),
    attachments: Number(r.attachments),
    files:       Number(r.files),
  }
}

const total = (p: Pending) => p.notes + p.books + p.links + p.attachments + p.files

/** Rewrites the user's event log from current rows (all sealed by now). */
async function rebuildEvents (client: PoolClient, uid: string) {
  await client.query(`DELETE FROM sync_events WHERE uid = $1`, [uid])
  const ms = (col: string) => `round(extract(epoch from ${col}) * 1000)::bigint`
  await client.query(
    `INSERT INTO sync_events (uid, entity_type, entity_id, op, payload)
     SELECT $1, 'book', id, 'upsert', jsonb_strip_nulls(jsonb_build_object(
       'id', id, 'title', title, 'author', author, 'colorIndex', color_index,
       'type', type, 'coverUrl', cover_url, 'coverColor', cover_color,
       'createdAt', ${ms('created_at')}, 'updatedAt', ${ms('updated_at')}))
     FROM books WHERE user_id = $1 ORDER BY created_at`,
    [uid],
  )
  await client.query(
    `INSERT INTO sync_events (uid, entity_type, entity_id, op, payload)
     SELECT $1, 'note', id, 'upsert', jsonb_build_object(
       'id', id, 'title', title, 'body', body, 'bookId', COALESCE(book_id, ''),
       'topic', topic, 'createdAt', ${ms('created_at')}, 'updatedAt', ${ms('updated_at')})
     FROM notes WHERE user_id = $1 ORDER BY created_at`,
    [uid],
  )
  await client.query(
    `INSERT INTO sync_events (uid, entity_type, entity_id, op, payload)
     SELECT $1, 'link', id, 'upsert', jsonb_build_object(
       'id', id, 'sourceId', source_id, 'targetId', target_id, 'isManual', is_manual,
       'reason', reason, 'createdAt', ${ms('created_at')}, 'updatedAt', ${ms('updated_at')})
     FROM note_links WHERE user_id = $1 ORDER BY created_at`,
    [uid],
  )
  await client.query(
    `INSERT INTO sync_events (uid, entity_type, entity_id, op, payload)
     SELECT $1, 'attachment', id, 'upsert', jsonb_build_object(
       'id', id, 'noteId', note_id, 'kind', kind, 'fileName', file_name, 'ext', ext,
       'mime', mime, 'bytes', bytes, 'createdAt', ${ms('created_at')}, 'updatedAt', ${ms('updated_at')})
     FROM attachments WHERE user_id = $1 ORDER BY created_at`,
    [uid],
  )
}

const e2eRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/status', async (request) => {
    const { uid } = request.user
    const { rows } = await fastify.pg.query<{ e2e_enabled: boolean, e2e_key_check: string | null }>(
      `SELECT e2e_enabled, e2e_key_check FROM users WHERE id = $1`, [uid],
    )
    return {
      enabled:  rows[0]?.e2e_enabled ?? false,
      keyCheck: rows[0]?.e2e_key_check ?? null,
      pending:  await pendingFor(fastify.pg, uid),
    }
  })

  fastify.post<{ Body: { keyCheck: string } }>('/enable', {
    schema: {
      body: {
        type: 'object',
        required: ['keyCheck'],
        additionalProperties: false,
        properties: { keyCheck: { type: 'string', maxLength: 500 } },
      },
    },
  }, async (request, reply) => {
    const { uid } = request.user
    const { keyCheck } = request.body
    if (!isValidE2e(keyCheck)) return reply.badRequest('keyCheck must be an e2e:v1 value')

    const client = await fastify.pg.connect()
    try {
      await client.query('BEGIN')
      // Serialise against concurrent pushes from this user's other devices.
      const { rows } = await client.query<{ e2e_enabled: boolean, e2e_key_check: string | null }>(
        `SELECT e2e_enabled, e2e_key_check FROM users WHERE id = $1 FOR UPDATE`, [uid],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return reply.notFound('Unknown user')
      }
      // Already on: never let a second device swap in a different key — its
      // data would be sealed with a key the other devices don't have.
      if (rows[0].e2e_enabled) {
        await client.query('ROLLBACK')
        return reply.code(409).send({
          statusCode: 409,
          error:      'Conflict',
          message:    'End-to-end encryption is already on for this account',
          alreadyEnabled: true,
        })
      }
      const pending = await pendingFor(client, uid)
      if (total(pending) > 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({
          statusCode: 409,
          error:      'Conflict',
          message:    'Some data is not end-to-end encrypted yet',
          pending,
        })
      }
      await client.query(
        `UPDATE users SET e2e_enabled = TRUE, e2e_key_check = $2 WHERE id = $1`,
        [uid, keyCheck],
      )
      await rebuildEvents(client, uid)
      await client.query(`DELETE FROM snapshots WHERE user_id = $1`, [uid])
      const { rows: seqRows } = await client.query<{ seq: string | null }>(
        `SELECT MAX(seq)::text AS seq FROM sync_events WHERE uid = $1`, [uid],
      )
      await client.query('COMMIT')
      return { enabled: true, seq: Number(seqRows[0]?.seq ?? 0) }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })
}

export default e2eRoutes
