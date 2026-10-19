-- 0004 · end-to-end encryption key check (2026-10-19)
-- Additive and idempotent; applied by the pre-deploy step (dist/migrate.js).
-- e2e_key_check: a constant sealed with the user's account key (an e2e:v1
-- value) when E2E is turned on. A new device opens it to confirm a typed
-- recovery key is the right one. The server can't open it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_key_check TEXT;
