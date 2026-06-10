-- Synapse — PostgreSQL schema  (local-first, minimal backend)
-- Run once:  psql $DATABASE_URL -f db/schema.sql
-- or:  npm run db:migrate

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users 
-- id = Firebase UID. Created on first login via POST /v1/users/sync.
CREATE TABLE IF NOT EXISTS users (
  id           TEXT        PRIMARY KEY,
  email        TEXT,
  display_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Snapshots (legacy — kept for rollback during migration)
-- New pushes no longer write here; pull falls back here only when the
-- normalized tables are empty (first push after migration).
-- Safe to DROP after all users have pushed at least once.
CREATE TABLE IF NOT EXISTS snapshots (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload    JSONB       NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_user_date
  ON snapshots (user_id, created_at DESC);

-- Books
CREATE TABLE IF NOT EXISTS books (
  id          TEXT        PRIMARY KEY,                            -- UUID from Flutter
  user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  author      TEXT        NOT NULL DEFAULT '',
  color_index INT         NOT NULL DEFAULT 0,
  type        TEXT        NOT NULL DEFAULT 'book',
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_books_user ON books (user_id);

-- Migration: add updated_at for last-write-wins (backfill existing rows from created_at)
ALTER TABLE books ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE books SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE books ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE books ALTER COLUMN updated_at SET DEFAULT NOW();

-- Notes
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT        PRIMARY KEY,                            -- UUID from Flutter
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL,
  body       TEXT        NOT NULL DEFAULT '',
  book_id    TEXT        REFERENCES books(id) ON DELETE SET NULL,
  topic      TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_user ON notes (user_id);
CREATE INDEX IF NOT EXISTS idx_notes_book ON notes (book_id);

-- Note links
-- Both wiki-parsed ([[Title]]) and manual connections.
-- Unique on (user_id, source_id, target_id) — direction matters in the
-- Flutter model so we keep both orderings if they ever coexist.
CREATE TABLE IF NOT EXISTS note_links (
  id         TEXT        PRIMARY KEY,                            -- UUID from Flutter
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id  TEXT        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_id  TEXT        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  is_manual  BOOLEAN     NOT NULL DEFAULT false,
  reason     TEXT,                                              -- manual link explanation
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, source_id, target_id)
);

-- Migration: add reason column if upgrading from a schema without it
ALTER TABLE note_links ADD COLUMN IF NOT EXISTS reason TEXT;

-- Migration: add updated_at for last-write-wins (backfill existing rows from created_at)
ALTER TABLE note_links ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE note_links SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE note_links ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE note_links ALTER COLUMN updated_at SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_note_links_user   ON note_links (user_id);
CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links (source_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links (target_id);

-- Graph layout
-- Persists force-directed node positions so the graph doesn't re-randomise
-- across sessions. Positions are in canvas pixels (device-specific) so they
-- are best-effort across different screen sizes.
CREATE TABLE IF NOT EXISTS graph_layout (
  note_id    TEXT             NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id    TEXT             NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  x          DOUBLE PRECISION NOT NULL DEFAULT 0,
  y          DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_graph_layout_user ON graph_layout (user_id);

-- AI usage counters
-- Tracks per-user daily AI call counts.
-- suggest_count: hidden-connection generations used today.
CREATE TABLE IF NOT EXISTS ai_usage (
  uid           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          DATE NOT NULL,                                      -- UTC date
  suggest_count INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, date)
);

-- Auto-purge rows older than 7 days to keep the table small.
-- Run this periodically (e.g. pg_cron) or just let old rows accumulate —
-- the query always filters by today's date so stale rows are harmless.

-- Sync event log
-- Append-only. One row per entity change per push.
-- Clients pull delta by passing ?since=<last_seq> — server returns only
-- events with seq > last_seq, so they receive only what changed.
-- since=0 (new device / first load) returns all events → full restore.
CREATE TABLE IF NOT EXISTS sync_events (
  seq         BIGSERIAL    PRIMARY KEY,
  uid         TEXT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT         NOT NULL,   -- 'book' | 'note' | 'link'
  entity_id   TEXT         NOT NULL,
  op          TEXT         NOT NULL,   -- 'upsert' | 'delete'
  payload     JSONB,                   -- encrypted entity on upsert, NULL on delete
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_events_uid_seq
  ON sync_events (uid, seq);

-- One-time data migration
-- Extracts each user's latest snapshot and populates the normalized tables.
-- ON CONFLICT DO NOTHING makes this idempotent — safe to re-run.
-- Run after creating the new tables on an existing database.

-- 1. Books
INSERT INTO books (id, user_id, title, author, color_index, type, created_at)
SELECT
  b->>'id',
  s.user_id,
  COALESCE(b->>'title', ''),
  COALESCE(b->>'author', ''),
  COALESCE((b->>'colorIndex')::INT, 0),
  COALESCE(b->>'type', 'book'),
  to_timestamp(COALESCE((b->>'createdAt')::BIGINT, 0) / 1000.0)
FROM (
  SELECT DISTINCT ON (user_id) user_id, payload
  FROM   snapshots
  ORDER  BY user_id, created_at DESC
) s,
LATERAL jsonb_array_elements(s.payload->'books') AS b
ON CONFLICT DO NOTHING;

-- 2. Notes (only where the book already exists in the books table)
INSERT INTO notes (id, user_id, title, body, book_id, topic, created_at, updated_at)
SELECT
  n->>'id',
  s.user_id,
  COALESCE(n->>'title', ''),
  COALESCE(n->>'body', ''),
  NULLIF(n->>'bookId', ''),
  COALESCE(n->>'topic', ''),
  to_timestamp(COALESCE((n->>'createdAt')::BIGINT, 0) / 1000.0),
  to_timestamp(COALESCE((n->>'updatedAt')::BIGINT, 0) / 1000.0)
FROM (
  SELECT DISTINCT ON (user_id) user_id, payload
  FROM   snapshots
  ORDER  BY user_id, created_at DESC
) s,
LATERAL jsonb_array_elements(s.payload->'notes') AS n
ON CONFLICT DO NOTHING;

-- 3. Note links (only where both notes already exist)
INSERT INTO note_links (id, user_id, source_id, target_id, is_manual, created_at)
SELECT
  l->>'id',
  s.user_id,
  l->>'sourceId',
  l->>'targetId',
  COALESCE((l->>'isManual')::BOOLEAN, false),
  to_timestamp(COALESCE((l->>'createdAt')::BIGINT, 0) / 1000.0)
FROM (
  SELECT DISTINCT ON (user_id) user_id, payload
  FROM   snapshots
  ORDER  BY user_id, created_at DESC
) s,
LATERAL jsonb_array_elements(s.payload->'links') AS l
WHERE EXISTS (SELECT 1 FROM notes WHERE id = l->>'sourceId')
  AND EXISTS (SELECT 1 FROM notes WHERE id = l->>'targetId')
ON CONFLICT DO NOTHING;
