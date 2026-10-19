-- 0001 · book covers + attachments + per-user storage (2026-10-18)
-- Additive and idempotent; applied by the pre-deploy step (dist/migrate.js).

-- Migration: book covers (URL from the app's cover search + dominant colour)
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_url   TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_color BIGINT;
-- Attachments
-- Photos and documents embedded in notebook notes. Postgres keeps metadata;
-- the bytes live in the private bucket under u/<uid>/att/<id>, encrypted with
-- a per-file data key that is itself wrapped with DB_ENCRYPTION_KEY.
-- note_id has no FK: metadata can arrive before or after its note, and note
-- deletes are handled in push so the bucket object and quota are released too.
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT        PRIMARY KEY,               -- att_… from Flutter
  user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id     TEXT        NOT NULL,
  kind        TEXT        NOT NULL,                  -- image | document
  file_name   TEXT        NOT NULL,                  -- AES-256-GCM encrypted
  ext         TEXT        NOT NULL,
  mime        TEXT        NOT NULL,
  bytes       BIGINT      NOT NULL,
  width       INT,
  height      INT,
  sha256      TEXT,                                  -- set on upload
  data_key    TEXT,                                  -- wrapped per-file key
  uploaded    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments (user_id);
CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments (note_id);

-- Per-user storage (each user is a storage tenant). used_bytes counts
-- uploaded attachments only; quota_bytes defaults to 50 MB and can be raised
-- per user without a schema change.
CREATE TABLE IF NOT EXISTS user_storage (
  user_id     TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  used_bytes  BIGINT  NOT NULL DEFAULT 0,
  quota_bytes BIGINT  NOT NULL DEFAULT 52428800
);

