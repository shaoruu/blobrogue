#!/usr/bin/env sh
# Liveness/readiness probe for the game server. Exits 0 if /healthz reports status "ok".
# Usage: ./healthcheck.sh [host] [port]   (defaults 127.0.0.1 8090)
set -eu

HOST="${1:-127.0.0.1}"
PORT="${2:-8090}"

BODY="$(curl -fsS "http://${HOST}:${PORT}/healthz")" || { echo "healthz unreachable" >&2; exit 1; }
echo "$BODY"
echo "$BODY" | grep -q '"status":"ok"' || { echo "status not ok" >&2; exit 1; }
