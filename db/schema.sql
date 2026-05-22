-- ─────────────────────────────────────────────────────────────────────────────
-- Synapse — PostgreSQL schema
-- Run once:  psql $DATABASE_URL -f db/schema.sql
--            or:  npm run db:migrate
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users ────────────────────────────────────────────────────────────────────
-- id = Firebase UID (string, not UUID)
CREATE TABLE IF NOT EXISTS users (
  id           TEXT        PRIMARY KEY,
  email        TEXT,
  display_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Books ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS books (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL,
  author     TEXT        NOT NULL,
  color      TEXT        NOT NULL DEFAULT 'teal'
               CHECK (color IN ('terracotta', 'sage', 'teal')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Notes ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notes (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    UUID        REFERENCES books(id) ON DELETE SET NULL,
  title      TEXT        NOT NULL,
  content    TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Links (graph edges) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS links (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_note_id  UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_note_id  UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  type            TEXT        NOT NULL DEFAULT 'manual'
                    CHECK (type IN ('wikilink', 'manual')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_link UNIQUE (source_note_id, target_note_id)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_books_user  ON books(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_user  ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_book  ON notes(book_id);
CREATE INDEX IF NOT EXISTS idx_links_user  ON links(user_id);
CREATE INDEX IF NOT EXISTS idx_links_src   ON links(source_note_id);
CREATE INDEX IF NOT EXISTS idx_links_tgt   ON links(target_note_id);

-- ── Auto-update updated_at on notes ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_updated_at ON notes;
CREATE TRIGGER notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
