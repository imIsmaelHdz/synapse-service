// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { FastifyInstance } from 'fastify'
import { decrypt } from '../../../lib/crypto'
import type { BookRow, LinkRow, NoteRow, SnapshotRow } from '../types'

interface SyncEventRow {
  seq:         string   // bigint comes back as string from pg driver
  entity_type: string
  entity_id:   string
  op:          string
  payload:     unknown
}

export function registerPullRoute (fastify: FastifyInstance) {
  // PULL
  // ?since=0 (default) — full restore from normalized tables (new device / first web load).
  // ?since=N           — delta: returns only sync_events with seq > N so the
  //                      client applies just what changed since its last pull.
  // Falls back to the legacy snapshots table for users who haven't pushed yet.
  fastify.get<{ Querystring: { since?: string } }>('/pull', async (request, reply) => {
    const { uid } = request.user
    const since = Number(request.query.since ?? 0)

    // ── Delta path ──────────────────────────────────────────────────────────
    if (since > 0) {
      const { rows } = await fastify.pg.query<SyncEventRow>(
        `SELECT seq, entity_type, entity_id, op, payload
         FROM   sync_events
         WHERE  uid = $1 AND seq > $2
         ORDER  BY seq ASC
         LIMIT  2000`,
        [uid, since],
      )

      const events = rows.map(r => {
        let payload = r.payload as Record<string, unknown> | null
        // Decrypt note fields before sending to client
        if (r.op === 'upsert' && r.entity_type === 'note' && payload) {
          payload = {
            ...payload,
            title: decrypt(payload.title as string),
            body:  decrypt(payload.body  as string),
            topic: decrypt(payload.topic as string),
          }
        }
        return {
          seq:        Number(r.seq),
          entityType: r.entity_type,
          entityId:   r.entity_id,
          op:         r.op,
          payload:    r.op === 'upsert' ? payload : null,
        }
      })

      return {
        events,
        next_seq: events.at(-1)?.seq ?? since,
      }
    }

    // Check if this user has data in the normalized tables
    const { rows: bookRows } = await fastify.pg.query<BookRow>(
      `SELECT id, title, author, color_index, type,
              round(extract(epoch from created_at) * 1000)::bigint AS created_at
        FROM   books
        WHERE  user_id = $1`,
      [uid],
    )

    // Legacy fallback — user hasn't pushed via the new sync path yet
    if (bookRows.length === 0) {
      const { rows } = await fastify.pg.query<SnapshotRow>(
        `SELECT id, payload, created_at
          FROM   snapshots
          WHERE  user_id = $1
          ORDER  BY created_at DESC
          LIMIT  1`,
        [uid],
      )
      if (!rows[0]) return reply.notFound('No snapshot found — push from your device first')
      return {
        snapshot_id: rows[0].id,
        saved_at:    rows[0].created_at,
        graph:       rows[0].payload,
      }
    }

    // Assemble from normalized tables
    const { rows: noteRows } = await fastify.pg.query<NoteRow>(
      `SELECT id, title, body, book_id, topic,
              round(extract(epoch from created_at) * 1000)::bigint AS created_at,
              round(extract(epoch from updated_at) * 1000)::bigint AS updated_at
        FROM   notes
        WHERE  user_id = $1`,
      [uid],
    )

    const { rows: linkRows } = await fastify.pg.query<LinkRow>(
      `SELECT id, source_id, target_id, is_manual,
              round(extract(epoch from created_at) * 1000)::bigint AS created_at
        FROM   note_links
        WHERE  user_id = $1`,
      [uid],
    )

    return {
      saved_at: new Date().toISOString(),
      graph: {
        books: bookRows.map(r => ({
          id: r.id,
          title: r.title,
          author: r.author,
          colorIndex: r.color_index,
          type: r.type,
          createdAt: Number(r.created_at),
        })),
        notes: noteRows.map(r => ({
          id: r.id,
          title: decrypt(r.title),
          body: decrypt(r.body),
          bookId: r.book_id ?? '',
          topic: decrypt(r.topic),
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        })),
        links: linkRows.map(r => ({
          id: r.id,
          sourceId: r.source_id,
          targetId: r.target_id,
          isManual: r.is_manual,
          createdAt: Number(r.created_at),
        })),
        exported_at: new Date().toISOString(),
      },
    }
  })
}
