#!/usr/bin/env bash
# rollback.sh — reference wrapper that drives a rollback through the control API (which runs the
# verified drain/switch/reload/verify/resume state machine). Rollback is NEVER a manual symlink
# edit in normal operation; it goes through the same audited, verified path as deploy so a
# rollback that fails verification is itself caught.
#
# Requires a valid admin ops token and a confirmation token bound to (rollback, releaseId). This
# script does not mint tokens — obtain them from the admin panel / your token minter.
set -euo pipefail

RELEASE_ID="${1:?usage: rollback.sh <releaseId>}"
BASE="${BRC_CONTROL_URL:-http://127.0.0.1:8091}"
ADMIN_TOKEN="${BRC_ADMIN_TOKEN:?set BRC_ADMIN_TOKEN to a valid ops token}"

log() { printf '[rollback] %s\n' "$*" >&2; }

log "requesting confirmation token for rollback $RELEASE_ID"
CONFIRM="$(curl -fsS -X POST "$BASE/v1/confirm" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"action\":\"rollback\",\"releaseId\":\"$RELEASE_ID\"}" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).confirmToken")"

log "submitting rollback"
curl -fsS -X POST "$BASE/v1/rollback" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "x-confirm-token: $CONFIRM" \
  -H "idempotency-key: rollback-$RELEASE_ID-$(date +%s)" \
  -H 'content-type: application/json' \
  -d "{\"releaseId\":\"$RELEASE_ID\"}"
echo
