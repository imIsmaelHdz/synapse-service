-- 0002 · end-to-end encryption flag (2026-10-19)
-- Additive and idempotent; applied by the pre-deploy step (dist/migrate.js).
-- Once true, pushes must carry e2e:v1-sealed text in protected fields
-- (src/lib/e2e.ts). Set by the app's enable flow (phase 4).
ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_enabled BOOLEAN NOT NULL DEFAULT FALSE;
