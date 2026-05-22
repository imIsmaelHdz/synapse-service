#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DEV_TOKEN="${DEV_TOKEN:-dev:smoke-test-user:smoke@example.com:Smoke Test}"

echo "→ Health check"
curl -sf "$BASE_URL/health" | grep -q '"status":"ok"'

echo "→ User sync"
curl -sf -X POST "$BASE_URL/v1/users/sync" \
  -H "Authorization: Bearer $DEV_TOKEN" \
  | grep -q '"id":"smoke-test-user"'

echo "→ Sync push"
curl -sf -X POST "$BASE_URL/v1/sync/push" \
  -H "Authorization: Bearer $DEV_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "books": [{"id": "b1", "title": "Test Book"}],
    "notes": [{"id": "n1", "title": "Note A", "content": "First note"}],
    "links": [],
    "exported_at": "2026-05-22T12:00:00Z"
  }' \
  | grep -q 'snapshot_id'

echo "→ Sync pull"
curl -sf "$BASE_URL/v1/sync/pull" \
  -H "Authorization: Bearer $DEV_TOKEN" \
  | grep -q '"graph"'

echo "→ Auth required (expect 401)"
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/v1/sync/pull")
test "$status" = "401"

echo ""
echo "All smoke tests passed."
