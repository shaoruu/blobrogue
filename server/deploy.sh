#!/usr/bin/env sh
# Deploy TEMPLATE for the blobrogue game server (mirrors town's ./deploy.sh + pm2 flow).
# This is a REFERENCE — it is intentionally not wired to any host and must be reviewed before
# first use. Do NOT run it against a live box from CI/automation.
#
# Coexistence: its own pm2 app (blobrogue-gs), own /opt dir, own logs, mem-capped — town is
# untouched. Shares only nginx + TLS + 443 and the pm2 daemon.
set -eu

HOST="${GS_DEPLOY_HOST:-deploy@HETZNER-HOST}"
REMOTE_DIR="${GS_REMOTE_DIR:-/opt/blobrogue-gs}"

# --- Option A: build locally, rsync the artifacts, reload on the box ---
# npm ci
# npm run build                       # tsc -> dist/ (server + shared src/sim)
# rsync -az --delete dist ecosystem.config.cjs package.json package-lock.json "$HOST:$REMOTE_DIR/"
# ssh "$HOST" "cd $REMOTE_DIR && npm ci --omit=dev && pm2 startOrReload ecosystem.config.cjs && pm2 save"

# --- Option B: build ON the box (whichever matches town's flow; keep ONE mental model) ---
# ssh "$HOST" "cd $REMOTE_DIR && git pull && npm ci && npm run build && pm2 startOrReload ecosystem.config.cjs && pm2 save"

# One-time box setup (run once, by hand):
#   pm2 startup                        # so pm2 restores apps on reboot
#   sudo mkdir -p /var/log/blobrogue-gs /opt/blobrogue-gs
#   pm2 install pm2-logrotate          # cap log growth beside town
#   # put GS_AUTH_SECRET + CONVEX_URL in /opt/blobrogue-gs/.env (chmod 600)

echo "deploy.sh is a template — uncomment the option matching town's flow before use." >&2
exit 1
