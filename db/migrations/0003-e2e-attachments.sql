-- 0003 · end-to-end encrypted attachments (2026-10-19)
-- Additive and idempotent; applied by the pre-deploy step (dist/migrate.js).
-- client_key: the per-file key wrapped by the app's account key (an e2e:v1
-- value). When set, the bucket object is the app's own ciphertext and the
-- server neither seals nor opens it (data_key stays NULL).
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS client_key TEXT;
