#!/usr/bin/env bash
# build-release.sh — produce an IMMUTABLE, verified release artifact from a clean checkout.
#
# Interactive deploys should use `control/scripts/build-release.sh --skip-verify` (or
# `FAST_DEPLOY=1 control/scripts/build-release.sh`) to skip the known-flaky live-gs VERIFY only.
#
# Runs on CI / a build box (NEVER admin-triggered, NEVER a `git pull` on the live box). It runs
# the required gates, packages the EXACT tested server + client + control build outputs, computes
# a deterministic content checksum, and derives a releaseId that binds commit + version + content.
# The output is a tarball + manifest.json that the control plane can later verify byte-for-byte.
#
# releaseId = <commitShort>-<version>-<checksum12>
# checksum  = sha256( concat, sorted by path, of "<sha256hex(file)>  <relpath>\n" )   [sha256sum
#             format] — kept byte-identical to control/src/checksum.ts:treeChecksum so the
#             on-box ArtifactVerifier recomputes the same value.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${BRC_ARTIFACT_OUT:-$REPO_ROOT/artifacts}"
cd "$REPO_ROOT"

log() { printf '[build-release] %s\n' "$*" >&2; }

is_skip_verify=false
for arg in "$@"; do
  case "$arg" in
    --skip-verify) is_skip_verify=true ;;
    -h|--help)
      printf 'Usage: %s [--skip-verify]\n' "$0"
      printf '  --skip-verify  Skip the report-only control live-gs VERIFY integration.\n'
      printf '  FAST_DEPLOY=1  Equivalent environment setting for --skip-verify.\n'
      exit 0
      ;;
    *)
      log "unsupported argument: $arg"
      exit 2
      ;;
  esac
done
if [[ "${FAST_DEPLOY:-0}" == "1" ]]; then
  is_skip_verify=true
fi

COMMIT="$(git rev-parse --short=12 HEAD)"
VERIFY_LOG="$OUT_DIR/control-verify-${COMMIT}.log"
VERIFY_RESULT="SKIPPED"

# --- required gates (any failure aborts; no artifact is produced) ---
log "gate: typecheck (server + control)"
( cd server && npm run typecheck )
( cd control && npm run typecheck )

log "gate: server unit tests"
( cd server && npm test )

log "gate: control unit tests (live-gs integration excluded)"
( cd control && npm run test:unit )

log "gate: goldens (deterministic sim oracle)"
npm test

# --- known-flaky live-gs integration (report-only; never blocks packaging) ---
if [[ "$is_skip_verify" == "true" ]]; then
  log "report: control live-gs VERIFY skipped (fast deploy)"
else
  mkdir -p "$OUT_DIR"
  log "report: control live-gs VERIFY (non-blocking; log: $VERIFY_LOG)"
  if ( cd control && npm run test:integration ) >"$VERIFY_LOG" 2>&1; then
    VERIFY_RESULT="PASS"
  else
    VERIFY_RESULT="FAIL"
  fi
fi

# --- build exact artifacts ---
log "build: server, client, control"
( cd server && npm run build )   # -> server/dist (server + shared sim)
npm run build                    # -> dist (vite client bundle)
( cd control && npm run build )  # -> control/dist

VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"

# --- prune to production dependencies (ws is pure JS -> bundled = offline, immutable) ---
log "install: production dependencies"
( cd server && npm ci --omit=dev )
( cd control && npm ci --omit=dev )

# --- stage the packaged tree ---
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/server" "$STAGE/client" "$STAGE/control"
cp -R server/dist "$STAGE/server/dist"
cp -R server/node_modules "$STAGE/server/node_modules"
cp server/package.json server/package-lock.json server/ecosystem.config.cjs "$STAGE/server/"
cp -R dist "$STAGE/client/dist"
cp -R control/dist "$STAGE/control/dist"
cp -R control/node_modules "$STAGE/control/node_modules"
cp control/package.json control/package-lock.json "$STAGE/control/"

# --- deterministic content checksum (matches checksum.ts) ---
FILES="$(cd "$STAGE" && find . -type f -not -name manifest.json | sed 's|^\./||' | LC_ALL=C sort)"
LINES="$(mktemp)"
while IFS= read -r f; do
  [ -z "$f" ] && continue
  h="$(sha256sum "$STAGE/$f" | awk '{print $1}')"
  printf '%s  %s\n' "$h" "$f" >> "$LINES"
done <<< "$FILES"
CHECKSUM="$(sha256sum "$LINES" | awk '{print $1}')"
rm -f "$LINES"

RELEASE_ID="${COMMIT}-${VERSION}-${CHECKSUM:0:12}"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "releaseId=$RELEASE_ID"

# --- write manifest (excluded from the checksum it certifies) ---
node - "$STAGE" "$RELEASE_ID" "$VERSION" "$COMMIT" "$BUILT_AT" "$CHECKSUM" <<'NODE'
const fs = require("node:fs");
const [stage, releaseId, version, commit, builtAt, checksum] = process.argv.slice(2);
const files = [];
const walk = (dir, base) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = dir + "/" + e.name;
    const rel = base ? base + "/" + e.name : e.name;
    if (e.isDirectory()) walk(abs, rel);
    else if (rel !== "manifest.json") files.push(rel);
  }
};
walk(stage, "");
files.sort();
const manifest = {
  releaseId, version, commit, builtAt, checksum,
  gates: { typecheck: "pass", unitTests: "pass", goldens: "pass" },
  files,
};
fs.writeFileSync(stage + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
NODE

# --- emit the immutable tarball ---
mkdir -p "$OUT_DIR"
ARTIFACT="$OUT_DIR/${RELEASE_ID}.tar.gz"
tar -C "$STAGE" -czf "$ARTIFACT" .
sha256sum "$ARTIFACT" > "$ARTIFACT.sha256"
log "artifact: $ARTIFACT"
log "manifest checksum: $CHECKSUM"
if [[ "$VERIFY_RESULT" == "SKIPPED" ]]; then
  log "control live-gs VERIFY: SKIPPED (fast deploy)"
else
  log "control live-gs VERIFY: $VERIFY_RESULT (report-only; log: $VERIFY_LOG)"
fi
printf '%s\n' "$RELEASE_ID"
