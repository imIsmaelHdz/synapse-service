// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { FastifyPluginAsync } from 'fastify'
import { openBlob, sealBlob, sha256Hex } from '../../lib/blob-crypto'
import { attachmentKey } from '../../lib/blob-store'
import { isValidE2e } from '../../lib/e2e'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const DEFAULT_QUOTA_BYTES  = 50 * 1024 * 1024

// Same shape the app generates: att_ + 12 lowercase hex/alnum chars.
// Validated because the id becomes part of the bucket object key.
export const ATTACHMENT_ID_PATTERN = '^att_[a-z0-9]{6,40}$'
const ID_RE = new RegExp(ATTACHMENT_ID_PATTERN)

interface ContentRow {
  mime:       string
  data_key:   string | null
  client_key: string | null
  uploaded:   boolean
}

/**
 * Attachment bytes. Metadata travels through /v1/sync/push like notes; the
 * bytes go through here, after their metadata row exists.
 *
 * PUT /v1/attachments/:id/content  raw bytes (application/octet-stream),
 *                                  header x-content-sha256; reserves quota,
 *                                  encrypts, writes the object. Idempotent.
 *                                  End-to-end: with header x-wrapped-key (the
 *                                  app's per-file key, wrapped by the user's
 *                                  account key) the bytes are already the
 *                                  app's ciphertext and are stored untouched.
 *                                  E2E accounts must send it.
 * GET /v1/attachments/:id/content  decrypted bytes; 409 until uploaded. For
 *                                  e2e files: the stored ciphertext plus
 *                                  x-wrapped-key, for the app to open.
 * GET /v1/attachments/usage        { used, quota } for Settings.
 *
 * Every query filters by the caller's Firebase uid and objects live under
 * u/<uid>/, so one user can never read or overwrite another user's files.
 */
const attachmentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES },
    (_req, body, done) => done(null, body),
  )

  const rateLimit = { max: 60, timeWindow: '1 minute' }

  fastify.get('/usage', async (request) => {
    const { rows } = await fastify.pg.query<{ used_bytes: string, quota_bytes: string }>(
      `SELECT used_bytes, quota_bytes FROM user_storage WHERE user_id = $1`,
      [request.user.uid],
    )
    return {
      used:  Number(rows[0]?.used_bytes ?? 0),
      quota: Number(rows[0]?.quota_bytes ?? DEFAULT_QUOTA_BYTES),
    }
  })

  fastify.put<{ Params: { id: string }, Body: Buffer }>('/:id/content', {
    bodyLimit: MAX_ATTACHMENT_BYTES,
    config:    { rateLimit },
  }, async (request, reply) => {
    const { uid } = request.user
    const { id } = request.params
    const blobs = fastify.blobs
    if (!blobs) return reply.serviceUnavailable('Attachment storage is not configured')
    if (!ID_RE.test(id)) return reply.badRequest('Invalid attachment id')

    const body = request.body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.badRequest('Expected application/octet-stream bytes')
    }
    const sha = sha256Hex(body)
    const claimed = request.headers['x-content-sha256']
    if (typeof claimed === 'string' && claimed.toLowerCase() !== sha) {
      return reply.badRequest('Checksum mismatch')
    }
    const wrappedHeader = request.headers['x-wrapped-key']
    const clientKey = typeof wrappedHeader === 'string' ? wrappedHeader : null
    if (clientKey !== null && !isValidE2e(clientKey)) {
      return reply.badRequest('x-wrapped-key is not a valid e2e:v1 value')
    }

    const client = await fastify.pg.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{
        uploaded: boolean, e2e_enabled: boolean, client_key: string | null, bytes: string
      }>(
        `SELECT a.uploaded, u.e2e_enabled, a.client_key, a.bytes
           FROM attachments a JOIN users u ON u.id = a.user_id
          WHERE a.id = $1 AND a.user_id = $2
          FOR UPDATE OF a`,
        [id, uid],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return reply.notFound('Push the attachment metadata first')
      }
      if (rows[0].e2e_enabled && clientKey === null) {
        await client.query('ROLLBACK')
        return reply.badRequest('Attachments must be end-to-end encrypted for this account')
      }
      // Already uploaded: idempotent, unless this is the switch to E2E —
      // app-sealed bytes replacing a file still in the server's envelope.
      const replacing = rows[0].uploaded && rows[0].client_key === null && clientKey !== null
      if (rows[0].uploaded && !replacing) {
        await client.query('ROLLBACK')
        return reply.send({ id, uploaded: true })
      }
      // A replacement only reserves the difference in size.
      const reserve = replacing ? body.length - Number(rows[0].bytes) : body.length

      // Reserve quota atomically: the UPDATE only matches while the new total
      // still fits, so concurrent uploads can't overshoot.
      await client.query(
        `INSERT INTO user_storage (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [uid],
      )
      const reserved = await client.query(
        `UPDATE user_storage SET used_bytes = used_bytes + $2
          WHERE user_id = $1 AND used_bytes + $2 <= quota_bytes
        RETURNING used_bytes`,
        [uid, reserve],
      )
      if (!reserved.rowCount) {
        const { rows: s } = await client.query<{ used_bytes: string, quota_bytes: string }>(
          `SELECT used_bytes, quota_bytes FROM user_storage WHERE user_id = $1`, [uid],
        )
        await client.query('ROLLBACK')
        return reply.code(413).send({
          statusCode: 413,
          error:      'Storage Full',
          message:    'Attachment storage quota exceeded',
          used:       Number(s[0]?.used_bytes ?? 0),
          quota:      Number(s[0]?.quota_bytes ?? DEFAULT_QUOTA_BYTES),
        })
      }

      // App-sealed (e2e) bytes are stored as they are; legacy uploads get the
      // server's envelope encryption.
      let dataKey: string | null = null
      if (clientKey !== null) {
        await blobs.put(attachmentKey(uid, id), body)
      } else {
        const { sealed, wrappedKey } = sealBlob(body)
        dataKey = wrappedKey
        await blobs.put(attachmentKey(uid, id), sealed)
      }
      await client.query(
        `UPDATE attachments
            SET uploaded = TRUE, data_key = $3, client_key = $6, sha256 = $4, bytes = $5
          WHERE id = $1 AND user_id = $2`,
        [id, uid, dataKey, sha, body.length, clientKey],
      )
      await client.query('COMMIT')
      return reply.code(201).send({ id, uploaded: true })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  fastify.get<{ Params: { id: string } }>('/:id/content', {
    config: { rateLimit },
  }, async (request, reply) => {
    const { uid } = request.user
    const { id } = request.params
    const blobs = fastify.blobs
    if (!blobs) return reply.serviceUnavailable('Attachment storage is not configured')
    if (!ID_RE.test(id)) return reply.badRequest('Invalid attachment id')

    const { rows } = await fastify.pg.query<ContentRow>(
      `SELECT mime, data_key, client_key, uploaded FROM attachments WHERE id = $1 AND user_id = $2`,
      [id, uid],
    )
    const row = rows[0]
    if (!row) return reply.notFound('Attachment not found')
    if (!row.uploaded || (!row.data_key && !row.client_key)) {
      return reply.conflict('Not uploaded yet')
    }

    const sealed = await blobs.get(attachmentKey(uid, id))
    if (!sealed) return reply.notFound('Attachment bytes missing')
    if (row.client_key) {
      // End-to-end: hand back the app's ciphertext and its wrapped key.
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Cache-Control', 'private, no-store')
        .header('x-wrapped-key', row.client_key)
        .send(sealed)
    }
    return reply
      .header('Content-Type', row.mime)
      .header('Cache-Control', 'private, no-store')
      .send(openBlob(sealed, row.data_key!))
  })
}

export default attachmentRoutes
