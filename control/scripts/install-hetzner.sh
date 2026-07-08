#!/usr/bin/env bash
# install-hetzner.sh — ONE-TIME box setup for blobrogue-gs + blobrogue-control, BESIDE town.
#
# GUARDED: prints the exact actions and exits unless BRC_I_UNDERSTAND=1 is set, so it is never run
# by accident from CI/automation. It only creates directories, sets permissions, installs
# pm2-logrotate, and enables pm2 boot persistence. It NEVER touches town's app, config, or logs.
#
# Review every line before running. Secrets are written by you, by hand, into the .env files
# (chmod 600) — this script does not handle secret values.
set -euo pipefail

RELEASES_ROOT="${BRC_RELEASES_ROOT:-/opt/blobrogue-gs}"
CONTROL_ROOT="${BRC_CONTROL_ROOT:-/opt/blobrogue-control}"
STATE_DIR="${BRC_STATE_DIR:-$CONTROL_ROOT/state}"

steps=$(cat <<EOF
mkdir -p $RELEASES_ROOT/releases $CONTROL_ROOT $STATE_DIR
mkdir -p /var/log/blobrogue-gs /var/log/blobrogue-control
chmod 700 $STATE_DIR
touch $RELEASES_ROOT/.env $CONTROL_ROOT/.env
chmod 600 $RELEASES_ROOT/.env $CONTROL_ROOT/.env   # then edit in the required secrets by hand
pm2 install pm2-logrotate                           # cap log growth beside town
pm2 startup                                         # print the boot-persistence command to run once
# pm2 save is run AFTER the apps are first started from the ecosystem file
EOF
)

if [ "${BRC_I_UNDERSTAND:-0}" != "1" ]; then
  echo "install-hetzner.sh is a GUARDED template. It would run:" >&2
  echo "$steps" >&2
  echo >&2
  echo "Re-run with BRC_I_UNDERSTAND=1 to execute. Town is never touched." >&2
  exit 1
fi

set -x
mkdir -p "$RELEASES_ROOT/releases" "$CONTROL_ROOT" "$STATE_DIR"
mkdir -p /var/log/blobrogue-gs /var/log/blobrogue-control
chmod 700 "$STATE_DIR"
touch "$RELEASES_ROOT/.env" "$CONTROL_ROOT/.env"
chmod 600 "$RELEASES_ROOT/.env" "$CONTROL_ROOT/.env"
pm2 install pm2-logrotate
pm2 startup
set +x
echo "Base setup done. Next: promote an artifact, POST /v1/deploy to switch current, then 'pm2 save'." >&2
