// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { FastifyInstance } from 'fastify'
import { openAtRest } from '../../../lib/e2e'
import type { AttachmentRow, BookRow, LinkRow, NoteRow, SnapshotRow } from '../types'

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
            title: openAtRest(payload.title as string),
            body:  openAtRest(payload.body  as string),
            topic: openAtRest(payload.topic as string),
          }
        }
        if (r.op === 'upsert' && r.entity_type === 'attachment' && payload) {
          payload = { ...payload, fileName: openAtRest(payload.fileName as string) }
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
      `SELECT id, title, author, color_index, type, cover_url, cover_color,
              round(extract(epoch from created_at) * 1000)::bigint AS created_at,
              round(extract(epoch from updated_at) * 1000)::bigint AS updated_at
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
      `SELECT id, source_id, target_id, is_manual, reason,
              round(extract(epoch from created_at) * 1000)::bigint AS created_at,
              round(extract(epoch from updated_at) * 1000)::bigint AS updated_at
        FROM   note_links
        WHERE  user_id = $1`,
      [uid],
    )

    const { rows: attachmentRows } = await fastify.pg.query<AttachmentRow>(
      `SELECT id, note_id, kind, file_name, ext, mime, bytes, width, height, uploaded,
              round(extract(epoch from created_at) * 1000)::bigint AS created_at,
              round(extract(epoch from updated_at) * 1000)::bigint AS updated_at
        FROM   attachments
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
          ...(r.cover_url ? { coverUrl: r.cover_url } : {}),
          ...(r.cover_color != null ? { coverColor: Number(r.cover_color) } : {}),
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        })),
        notes: noteRows.map(r => ({
          id: r.id,
          title: openAtRest(r.title),
          body: openAtRest(r.body),
          bookId: r.book_id ?? '',
          topic: openAtRest(r.topic),
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        })),
        links: linkRows.map(r => ({
          id: r.id,
          sourceId: r.source_id,
          targetId: r.target_id,
          isManual: r.is_manual,
          reason:   r.reason ?? undefined,
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        })),
        attachments: attachmentRows.map(r => ({
          id: r.id,
          noteId: r.note_id,
          kind: r.kind,
          fileName: openAtRest(r.file_name),
          ext: r.ext,
          mime: r.mime,
          bytes: Number(r.bytes),
          ...(r.width != null ? { width: r.width } : {}),
          ...(r.height != null ? { height: r.height } : {}),
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        })),
        exported_at: new Date().toISOString(),
      },
    }
  })
}
