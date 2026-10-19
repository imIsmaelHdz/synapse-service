// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import type { PoolClient } from 'pg'
import { attachmentKey } from './blob-store'

/**
 * Deletes attachment rows (by id, or by owning note) inside the caller's
 * transaction, releases their quota, and logs a delete sync_event for each.
 * Returns the bucket keys to remove once the transaction commits — objects
 * are deleted after COMMIT so a rollback never leaves rows without bytes.
 */
export async function deleteAttachments (
  client: PoolClient,
  uid: string,
  ids: string[],
  noteIds: string[],
): Promise<string[]> {
  if (ids.length === 0 && noteIds.length === 0) return []
  const { rows } = await client.query<{ id: string, bytes: string, uploaded: boolean }>(
    `DELETE FROM attachments
      WHERE user_id = $1 AND (id = ANY($2::text[]) OR note_id = ANY($3::text[]))
    RETURNING id, bytes, uploaded`,
    [uid, ids, noteIds],
  )
  if (rows.length === 0) return []

  const freed = rows
    .filter(r => r.uploaded)
    .reduce((sum, r) => sum + Number(r.bytes), 0)
  if (freed > 0) {
    await client.query(
      `UPDATE user_storage SET used_bytes = GREATEST(used_bytes - $2, 0) WHERE user_id = $1`,
      [uid, freed],
    )
  }
  for (const r of rows) {
    await client.query(
      `INSERT INTO sync_events (uid, entity_type, entity_id, op)
       VALUES ($1, 'attachment', $2, 'delete')`,
      [uid, r.id],
    )
  }
  return rows.filter(r => r.uploaded).map(r => attachmentKey(uid, r.id))
}
