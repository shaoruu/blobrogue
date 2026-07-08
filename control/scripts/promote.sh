#!/usr/bin/env bash
# promote.sh — place a verified immutable artifact into the on-box releases dir.
#
# This is the ONLY thing that writes a release directory. It consumes a pre-built, verified
# artifact (build-release.sh output) — it NEVER builds from a working tree and NEVER runs
# `git pull`. It unpacks into releases/<releaseId>, confirms the releaseId matches the manifest,
# and stops. It does NOT flip `current`: switching to a release is the control API's job
# (POST /v1/deploy), which runs the drain/switch/reload/verify/rollback state machine.
#
# Idempotent: re-promoting an already-present releaseId is a no-op.
set -euo pipefail

ARTIFACT="${1:?usage: promote.sh <artifact.tar.gz> [releasesRoot]}"
RELEASES_ROOT="${2:-${BRC_RELEASES_ROOT:-/opt/blobrogue-gs}}"
RELEASES_DIR="$RELEASES_ROOT/releases"

log() { printf '[promote] %s\n' "$*" >&2; }

[ -f "$ARTIFACT" ] || { log "artifact not found: $ARTIFACT"; exit 1; }
if [ -f "$ARTIFACT.sha256" ]; then
  log "verifying artifact checksum"
  ( cd "$(dirname "$ARTIFACT")" && sha256sum -c "$(basename "$ARTIFACT").sha256" )
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -C "$TMP" -xzf "$ARTIFACT"

[ -f "$TMP/manifest.json" ] || { log "artifact has no manifest.json"; exit 1; }
RELEASE_ID="$(node -p "require('$TMP/manifest.json').releaseId")"
case "$RELEASE_ID" in
  *[!a-z0-9.-]*|"" ) log "manifest releaseId is not a safe token: $RELEASE_ID"; exit 1;;
esac

DEST="$RELEASES_DIR/$RELEASE_ID"
if [ -d "$DEST" ]; then
  log "release already present (idempotent): $RELEASE_ID"
else
  mkdir -p "$RELEASES_DIR"
  STAGING="$RELEASES_DIR/.incoming-$RELEASE_ID.$$"
  mkdir -p "$STAGING"
  cp -R "$TMP"/. "$STAGING"/
  mv "$STAGING" "$DEST" # atomic within the same filesystem
  log "installed release: $DEST"
fi

log "next: POST /v1/deploy {\"releaseId\":\"$RELEASE_ID\"} to switch current (verified state machine)"
printf '%s\n' "$RELEASE_ID"
