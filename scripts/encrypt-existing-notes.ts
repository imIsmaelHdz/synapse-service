// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

/**
 * One-time migration: encrypt plain-text note fields already in PostgreSQL.
 *
 * Run ONCE after deploying the encryption change and setting DB_ENCRYPTION_KEY.
 * Safe to re-run — already-encrypted rows will fail GCM auth and be skipped.
 *
 * Usage:
 *   DB_ENCRYPTION_KEY=<your-key> DATABASE_URL=<railway-url> \
 *     npx ts-node scripts/encrypt-existing-notes.ts
 */

import 'dotenv/config'
import { Pool } from 'pg'
import { encrypt, decrypt } from '../src/lib/crypto'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{
      id: string; title: string; body: string; topic: string
    }>('SELECT id, title, body, topic FROM notes')

    console.log(`Found ${rows.length} notes to process`)

    let encrypted = 0
    let skipped   = 0

    for (const row of rows) {
      // If the row is already encrypted, decrypt() will succeed and we skip it.
      // If it's plain text, decrypt() will throw (GCM auth tag mismatch) and
      // we encrypt it.
      try {
        decrypt(row.title)
        // If we reach here the field is already encrypted — skip this row
        skipped++
        continue
      } catch {
        // Plain text — fall through to encrypt
      }

      await client.query(
        `UPDATE notes SET title = $1, body = $2, topic = $3 WHERE id = $4`,
        [
          encrypt(row.title),
          encrypt(row.body),
          encrypt(row.topic),
          row.id,
        ],
      )
      encrypted++

      if (encrypted % 100 === 0) {
        console.log(`  encrypted ${encrypted} rows so far…`)
      }
    }

    console.log(`Done. Encrypted: ${encrypted}, already encrypted (skipped): ${skipped}`)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
