// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

/**
 * Pre-deploy migration step (railway.toml → preDeployCommand).
 *
 * Applies every db/migrations/*.sql file in name order, each in its own
 * transaction. Files must be idempotent (IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS) — there is no ledger, every deploy re-runs them. If one fails the
 * process exits non-zero and Railway aborts the deploy, so new code never
 * goes live ahead of its schema.
 *
 * db/schema.sql stays the full reference for a fresh database.
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { Client } from 'pg'

async function main () {
  const dir = join(__dirname, '..', 'db', 'migrations')
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    for (const file of files) {
      await client.query('BEGIN')
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'))
        await client.query('COMMIT')
        console.log(`migrate: applied ${file}`)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`migrate: ${file} failed — ${(err as Error).message}`)
      }
    }
  } finally {
    await client.end()
  }
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
