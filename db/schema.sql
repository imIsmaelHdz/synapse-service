-- ─────────────────────────────────────────────────────────────────────────────
-- Synapse — PostgreSQL schema  (local-first, minimal backend)
-- Run once:  psql $DATABASE_URL -f db/schema.sql
--            or:  npm run db:migrate
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users ─────────────────────────────────────────────────────────────────────
-- id = Firebase UID. Created on first login via POST /v1/users/sync.
CREATE TABLE IF NOT EXISTS users (
  id           TEXT        PRIMARY KEY,
  email        TEXT,
  display_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Snapshots (cloud backup of the local Hive graph) ──────────────────────────
-- payload is the full graph JSON exported from the Flutter app:
--   { books: [...], notes: [...], links: [...], exported_at: "..." }
-- We keep the 10 most recent snapshots per user (pruned on every push).
CREATE TABLE IF NOT EXISTS snapshots (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload    JSONB       NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_user_date
  ON snapshots (user_id, created_at DESC);
